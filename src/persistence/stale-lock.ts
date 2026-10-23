import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import * as fs from 'node:fs/promises'
import { hostname } from 'node:os'

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
 * name is derived from the judged file's identity (device, inode, size, times and bytes). Only the
 * claim's owner re-reads the lock path and, if it still names the judged file, unlinks it. While
 * the judged file is at the lock path, nothing else changes that path: an acquirer's exclusive
 * create or `link` fails because the path exists, the judged file's owner is gone (that is what
 * stale means), and every other remover of the same file finds the claim taken. A remover that
 * judged a different file sees, on its re-read, that the path no longer names it.
 *
 * A claim is never removed while its file could still be at the lock path, because removing a stale
 * claim by path would bring back the same race one level up. A claim whose owner is gone (a remover
 * killed mid-removal) is skipped instead: the next remover takes the claim at the next level. Claims
 * of a file are removed only once that file is no longer at the lock path, by the remover that
 * unlinked it or that found it gone.
 */

/** How many claims of removers that died mid-removal one stale lock may collect before it is left held. */
const MAX_CLAIM_LEVELS = 8

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
	for (let level = 0; level < MAX_CLAIM_LEVELS; level += 1) {
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
	return false
}

/** Publishes this process's claim with a `link` of a complete candidate, so a claim is never read half written. */
async function publishClaim(claim: string, removal: StaleLockRemoval): Promise<boolean> {
	const candidate = removal.claimPath(`${randomUUID()}.tmp`)
	const record = JSON.stringify({ pid: process.pid, hostname: hostname(), token: randomUUID(), ...(removal.bootId ? { bootId: removal.bootId } : {}) })
	try {
		const handle = await fs.open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
		try { await handle.writeFile(record, 'utf8') }
		finally { await handle.close() }
		await fs.link(candidate, claim)
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

function identityDigest(judged: JudgedLock): string {
	const { dev, ino, size, mtimeNs, birthtimeNs } = judged.stats
	return createHash('sha256').update(`${dev}:${ino}:${size}:${mtimeNs}:${birthtimeNs}:`).update(judged.bytes).digest('hex').slice(0, 32)
}

/** `O_NONBLOCK`, so opening a FIFO put at the path never blocks; Windows has none. */
function nonBlocking(): number {
	return constants.O_NONBLOCK ?? 0
}
