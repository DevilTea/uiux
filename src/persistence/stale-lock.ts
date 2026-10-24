import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { isFromEarlierBoot, recordedOnAnotherHost } from './boot-staleness'

/*
 * Removal of a stale host lock (issue #325), shared by the persistence lock and the roster lock.
 *
 * A lock is judged stale from one read of its file, and only that file may then be removed. POSIX
 * has no "unlink this name only while it still names this inode", so removing by path after the
 * judgment can delete a lock that another process published in between: two removers judge the same
 * stale lock S, one removes S and its next attempt publishes L2, and the other's removal then
 * deletes L2, leaving two holders. Renaming the lock away first does not help: the rename takes
 * whatever the lock path names, and when that is L2, putting L2 back leaves the path empty for a
 * moment in which a third process can publish L3, so L2's and L3's owners both hold the lock.
 *
 * Instead the removers of one judged file are serialized by a claim: an exclusive-create file whose
 * name is derived from the judged file's bytes, size and modification time, which every process sees
 * alike (a device number can differ between views of one file system). Only the claim's owner
 * re-reads the lock path and, if it still names the judged file (the same device, inode, size, times
 * and bytes), unlinks it. While
 * the judged file is at the lock path, nothing else changes that path: an acquirer's exclusive
 * create or `link` fails because the path exists, the judged file's owner is gone (that is what
 * stale means), and every other remover of the same file finds the claim taken. A remover that
 * judged a different file sees, on its re-read, that the path no longer names it.
 *
 * A claim is never removed while its file could still be at the lock path, because removing a stale
 * claim by path would bring back the same race one level up. A claim whose owner is gone (a remover
 * killed mid-removal) is skipped instead: the next remover takes the claim at the next level. Levels
 * are not capped, since only a remover killed mid-removal adds one. Claims of a file are removed only
 * once that file is no longer at the lock path, by the remover that unlinked it or that found it gone.
 *
 * Claims are published with a hard link, as the locks are, so the directory must support them; a
 * claim that cannot be linked throws `HardLinkUnsupportedError`.
 */

/** A lock file as one open file read it, never following a link: the record and its identity agree. */
export type JudgedLock = Readonly<{
	stats: BigIntStats
	bytes: Buffer
	/** The modification time in milliseconds, for `isFromEarlierBoot`. */
	mtimeMs: number
}>

export type StaleLockRemoval = Readonly<{
	/** The host's boot session identifier as the checking process read it, for judging claims. */
	bootId: string | undefined
	/**
	 * The path of a claim or claim candidate file beside the lock, given a unique file-name suffix.
	 * The persistence lock's claims must match its `.gitignore` rule `.persistence-lock-*`.
	 */
	claimPath: (suffix: string) => string
}>

type StaleLockStage = 'judged' | 'claimed' | 'settled'
let hook: ((stage: StaleLockStage, lockPath: string) => void | Promise<void>) | undefined

/**
 * Test-only: called with `judged` after a lock was judged stale and before anything is removed, with
 * `claimed` once this process holds the claim on it, and with `settled` when that removal attempt
 * ends; without an argument it removes the hook.
 */
export function setStaleLockHookForTests(replacement?: (stage: StaleLockStage, lockPath: string) => void | Promise<void>): void {
	hook = replacement
}

/**
 * Reads a lock file for judgment through one open file that never follows a symbolic link. Throws
 * what the open or the read throws (`ENOENT` when the lock is gone).
 */
export async function readJudgedLock(lockPath: string): Promise<JudgedLock> {
	const handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | nonBlocking())
	try {
		const stats = await handle.stat({ bigint: true })
		const bytes = await handle.readFile()
		return { stats, bytes, mtimeMs: Number(stats.mtimeMs) }
	}
	finally { await handle.close() }
}

/**
 * Removes the judged stale lock if the lock path still names it. Returns true when the judged lock
 * is no longer at the lock path (this call removed it, or it was already gone or replaced), so the
 * caller tries to take the lock again, and false while another live process is removing it.
 */
export async function removeJudgedLock(lockPath: string, judged: JudgedLock, removal: StaleLockRemoval): Promise<boolean> {
	await hook?.('judged', lockPath)
	try { return await removeWhileClaimed(lockPath, judged, removal) }
	finally { await hook?.('settled', lockPath) }
}

async function removeWhileClaimed(lockPath: string, judged: JudgedLock, removal: StaleLockRemoval): Promise<boolean> {
	const digest = identityDigest(judged)
	const claims: string[] = []
	for (let level = 0; ; level += 1) {
		const claim = removal.claimPath(`${digest}-${level}`)
		claims.push(claim)
		if (!await publishClaim(claim, removal)) {
			const holder = await claimHolder(claim, removal.bootId)
			// Its remover is done with it: judge the lock path again.
			if (holder === 'gone') return true
			if (holder === 'live') return false
			continue
		}
		let left = false
		try {
			await hook?.('claimed', lockPath)
			if (await stillNames(lockPath, judged)) await fs.rm(lockPath, { force: true })
			left = true
		}
		finally {
			// Once the judged file left the lock path every claim of it is spent; until then only this
			// remover's own claim goes, and the dead removers' claims stay so no one retakes their level.
			for (const path of left ? claims : [claim]) await fs.rm(path, { force: true }).catch(() => undefined)
		}
		return true
	}
}

/**
 * Publishes this process's claim with a `link` of a complete candidate, so a claim is never read half
 * written. Unlike the locks, the candidate is fsynced: a claim is rare, and one left empty by a power
 * loss could not be judged until its modification time fell before the boot.
 */
async function publishClaim(claim: string, removal: StaleLockRemoval): Promise<boolean> {
	const candidate = removal.claimPath(`${randomUUID()}.tmp`)
	const record = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), ...(removal.bootId ? { bootId: removal.bootId } : {}) })
	try {
		const handle = await fs.open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
		try {
			await handle.writeFile(record, 'utf8')
			await handle.sync()
		}
		finally { await handle.close() }
		try { await fs.link(candidate, claim) }
		catch (error) {
			if (isLinkUnsupported(error)) throw new HardLinkUnsupportedError(claim, error)
			throw error
		}
		return true
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
		throw error
	}
	finally { await fs.rm(candidate, { force: true }).catch(() => undefined) }
}

/**
 * Whether the remover that holds `claim` is still running. A claim of another host, or one whose
 * record cannot be judged, counts as live; one of an earlier boot or of an exited process does not.
 */
async function claimHolder(claim: string, bootId: string | undefined): Promise<'live' | 'dead' | 'gone'> {
	let read: JudgedLock
	try { read = await readJudgedLock(claim) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'gone'
		throw error
	}
	if (!read.stats.isFile()) return 'live'
	let record: { pid?: unknown } | undefined
	try { record = JSON.parse(read.bytes.toString('utf8')) as { pid?: unknown } }
	catch { record = undefined }
	if (recordedOnAnotherHost(record)) return 'live'
	if (isFromEarlierBoot(record, read, bootId)) return 'dead'
	if (typeof record !== 'object' || record === null || typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid < 1) return 'live'
	try {
		process.kill(record.pid, 0)
		return 'live'
	}
	catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'live'
	}
}

/** Whether `lockPath` still names the judged file: the same inode on the same device, unchanged. */
async function stillNames(lockPath: string, judged: JudgedLock): Promise<boolean> {
	let handle: fs.FileHandle
	try { handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW | nonBlocking()) }
	catch (error) {
		const code = (error as NodeJS.ErrnoException).code
		// Gone, or replaced by a symbolic link (which a judgment never accepts).
		if (code === 'ENOENT' || code === 'ELOOP') return false
		throw error
	}
	try {
		const stats = await handle.stat({ bigint: true })
		if (!sameIdentity(stats, judged.stats)) return false
		return (await handle.readFile()).equals(judged.bytes)
	}
	finally { await handle.close() }
}

/*
 * The identity leaves out the change time, which a `link` or `unlink` of another name of the same
 * inode moves; an inode number reused by a newer lock differs in its bytes (a fresh token) or times.
 */
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
	return a.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.birthtimeNs === b.birthtimeNs
}

/** The claim name's part for a judged file: only what every view of the file reports alike. */
export function identityDigest(judged: JudgedLock): string {
	const { size, mtimeNs } = judged.stats
	return createHash('sha256').update(`${size}:${mtimeNs}:`).update(judged.bytes).digest('hex').slice(0, 32)
}

const LINK_UNSUPPORTED = new Set(['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'])

/** A claim could not be published because the file system of its directory has no hard links. */
export class HardLinkUnsupportedError extends Error {
	readonly path: string
	constructor(path: string, cause: unknown) {
		super(`Cannot create a hard link at ${path}: the file system does not support them (${(cause as NodeJS.ErrnoException).code}).`, { cause })
		this.name = 'HardLinkUnsupportedError'
		this.path = path
	}
}

/**
 * Whether an error of a `link` within one directory means the file system cannot make hard links
 * (FAT, exFAT and some network or FUSE file systems), which the host locks and their claims need.
 */
export function isLinkUnsupported(error: unknown): boolean {
	return LINK_UNSUPPORTED.has((error as NodeJS.ErrnoException | undefined)?.code ?? '')
}

/** `O_NONBLOCK`, so opening a FIFO put at the path never blocks; Windows has none. */
function nonBlocking(): number {
	return constants.O_NONBLOCK ?? 0
}

/*
 * Leftovers of killed processes (issue #328). A process killed while taking a lock leaves its
 * candidate (`<prefix><token>-<x>.tmp`), one killed while removing a stale lock leaves its claim
 * candidate (`<prefix>break-<uuid>.tmp`) or its claim (`<prefix>break-<digest>-<level>`). They are
 * never judged as the lock, so they only accumulate; the holder of the lock sweeps them.
 *
 * Every candidate and claim holds its creator's record `{ pid, hostname, token, bootId? }`, so a
 * leftover is swept only when its creator is gone: a record of another host is kept, one of an
 * earlier boot goes, and one of this boot goes when its pid has exited. A file whose record cannot
 * be read is kept until it is older than `UNREADABLE_LEFTOVER_MS`, which no live writer takes.
 *
 * A claim is also swept only while its judged file cannot be at the lock path. The sweeper holds the
 * lock, so the lock path names its own file, and a claim of any other digest belongs to a file that
 * is gone for good (a lock's bytes carry a unique token); the claim of the file now at the path is
 * kept, as are all claims when that file cannot be read.
 */

/** How old a leftover with an unreadable record must be before it is swept. */
export const UNREADABLE_LEFTOVER_MS = 10 * 60_000
/** At most this many leftovers are removed by one sweep, so a lock holder never spends long on it. */
export const SWEEP_LIMIT = 32
/** How often one lock's directory is swept by one process. */
export const SWEEP_INTERVAL_MS = 60_000

export type LockLeftoverSweep = Readonly<{
	/** The directory of the lock. */
	directory: string
	/** The lock's file name, such as `.access.lock`. */
	lockName: string
	/** The shared start of candidate and claim names, such as `.access-lock-`. */
	prefix: string
	bootId: string | undefined
	/** Defaults to `SWEEP_LIMIT`. */
	limit?: number
}>

const CLAIM_NAME = /^break-([\da-f]{32})-\d+$/u

/**
 * Removes leftover lock candidates and claims whose creator is gone, at most `limit` of them. The
 * caller must hold the lock. Returns the names removed. It never throws: a failed sweep is retried.
 */
export async function sweepLockLeftovers(sweep: LockLeftoverSweep): Promise<string[]> {
	const removed: string[] = []
	try {
		const names = (await fs.readdir(sweep.directory)).filter(name => name.startsWith(sweep.prefix))
		if (names.length === 0) return removed
		// The digest of the file at the lock path, whose claims are never swept.
		let held: string | undefined
		try { held = identityDigest(await readJudgedLock(join(sweep.directory, sweep.lockName))) }
		catch { held = undefined }
		const limit = sweep.limit ?? SWEEP_LIMIT
		for (const name of names) {
			if (removed.length >= limit) break
			const claim = CLAIM_NAME.exec(name.slice(sweep.prefix.length))
			if (claim) { if (held === undefined || claim[1] === held) continue }
			else if (!name.endsWith('.tmp')) continue
			const path = join(sweep.directory, name)
			try {
				if (await creatorGone(path, sweep.bootId)) {
					await fs.rm(path, { force: true })
					removed.push(name)
				}
			}
			catch { /* kept; the next sweep judges it again */ }
		}
	}
	catch { /* best effort */ }
	return removed
}

const lastSweep = new Map<string, number>()

/** `sweepLockLeftovers` at most once per `SWEEP_INTERVAL_MS` for one lock of this process. */
export async function sweepLockLeftoversOccasionally(sweep: LockLeftoverSweep): Promise<void> {
	const key = join(sweep.directory, sweep.lockName)
	const now = performance.now()
	const last = lastSweep.get(key)
	if (last !== undefined && now - last < SWEEP_INTERVAL_MS) return
	lastSweep.set(key, now)
	await sweepLockLeftovers(sweep)
}

/** Test-only: forgets when each lock was last swept. */
export function resetLockSweepThrottleForTests(): void {
	lastSweep.clear()
}

async function creatorGone(path: string, bootId: string | undefined): Promise<boolean> {
	let read: JudgedLock
	try { read = await readJudgedLock(path) }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
		throw error
	}
	if (!read.stats.isFile()) return false
	let record: { pid?: unknown } | undefined
	try { record = JSON.parse(read.bytes.toString('utf8')) as { pid?: unknown } }
	catch { record = undefined }
	if (recordedOnAnotherHost(record)) return false
	if (isFromEarlierBoot(record, read, bootId)) return true
	if (typeof record !== 'object' || record === null || typeof record.pid !== 'number' || !Number.isInteger(record.pid) || record.pid < 1)
		return Date.now() - read.mtimeMs > UNREADABLE_LEFTOVER_MS
	try {
		process.kill(record.pid, 0)
		return false
	}
	catch (error) {
		return (error as NodeJS.ErrnoException).code === 'ESRCH'
	}
}
