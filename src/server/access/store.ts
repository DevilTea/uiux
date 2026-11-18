import { createHash, randomBytes } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { chmod, link, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { currentBootId, isFromEarlierBoot, recordedOnAnotherHost } from '../../persistence/boot-staleness'
import { HardLinkUnsupportedError, isLinkUnsupported, readJudgedLock, removeJudgedLock, sweepLockLeftoversOccasionally, type JudgedLock } from '../../persistence/stale-lock'
import { generateHint } from './credentials'
import {
	ACCESS_FILE_VERSION,
	AccessError,
	assertManagerKept,
	assertRosterWrite,
	createEmptyAccessFile,
	validateAccessFile,
	type AccessFile,
	type Mutation,
} from './roster'

/**
 * Host-local access store, one roster per Workspace (accepted identity decision 2, owner's Q1):
 * `$UIUX_HOME/workspaces/<sha256(realpath)>/access.json`. `UIUX_HOME` defaults to `~/.uiux`.
 * Directories are 0700 and the file 0600; symlinked or group/other-writable paths are refused.
 * Writes are atomic (temporary file, fsync, rename) under `<wsid>/.access.lock`, and readers
 * re-read the file when its size, mtime or inode changes.
 *
 * Only a `version: 2` roster is read. A roster at any other version, or one that carries a field
 * this version does not have, is refused with `access.store_invalid` naming the file, and is never
 * rewritten (Clause 01a14917-7898-72fa-a8ad-ed737e4a9eae).
 */
export const ACCESS_FILE_NAME = 'access.json'
export const ACCESS_LOCK_NAME = '.access.lock'
/** Where a refused roster's message points for recovery (README, "Recovering a roster"). */
const RECOVERY_HINT = 'See "Recovering a roster" in the UIUX README.'
/** A temporary file of `writeAtomically` for the roster. */
const ROSTER_TEMPORARY = /^access\.json\.[0-9a-f]{12}\.tmp$/u
const RELOAD_INTERVAL_MS = 1000
const LOCK_WAIT_MS = 5000

export function resolveUiuxHome(env: Readonly<Record<string, string | undefined>> = process.env): string {
	const configured = env.UIUX_HOME?.trim()
	return resolve(configured ? configured : join(homedir(), '.uiux'))
}

/** The Workspace root's real path: a symlink and its target share one roster. */
export function workspaceRealRoot(root: string): string {
	try {
		return realpathSync.native(resolve(root))
	}
	catch {
		throw new AccessError('access.workspace_invalid', `Workspace root does not exist: ${resolve(root)}`)
	}
}

export function workspaceStoreId(realRoot: string): string {
	return createHash('sha256').update(realRoot, 'utf8').digest('hex')
}

export type AccessStorePaths = Readonly<{ home: string; workspaces: string; dir: string; file: string; lock: string }>

export function accessStorePaths(home: string, realRoot: string): AccessStorePaths {
	const workspaces = join(home, 'workspaces')
	const dir = join(workspaces, workspaceStoreId(realRoot))
	return { home, workspaces, dir, file: join(dir, ACCESS_FILE_NAME), lock: join(dir, ACCESS_LOCK_NAME) }
}

/** Real path of `path`, or of its nearest existing ancestor joined with the missing remainder. */
export function realFuturePath(path: string): string {
	try {
		return realpathSync.native(path)
	}
	catch {
		const parent = dirname(path)
		if (parent === path) return path
		return join(realFuturePath(parent), path.slice(parent.length).replace(/^[\\/]+/u, ''))
	}
}

/** True when `candidate` is `parent` or lies inside it, both absolute paths. */
export function isSameOrInside(parent: string, candidate: string): boolean {
	const rel = relative(parent, candidate)
	return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Collision guard: the store must never live inside the Workspace, or it would travel with copies. */
export function assertHomeOutsideWorkspace(home: string, realRoot: string): void {
	if (isSameOrInside(realRoot, realFuturePath(home)))
		throw new AccessError('access.home_inside_workspace', `UIUX_HOME (${home}) resolves inside the Workspace ${realRoot}; the access store would travel with copies of the Workspace. Set UIUX_HOME to a directory outside it.`)
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

async function lstatOrUndefined(path: string): Promise<Stats | undefined> {
	try {
		return await lstat(path)
	}
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
}

const unsafe = (path: string, detail: string) => new AccessError('access.store_unsafe', `Refusing the access store at ${path}: ${detail}.`)

async function ensureSafeDirectory(path: string, create: boolean): Promise<boolean> {
	let stats = await lstatOrUndefined(path)
	if (!stats) {
		if (!create) return false
		try {
			await mkdir(path, { mode: 0o700 })
			await chmod(path, 0o700)
		}
		catch (error) {
			// Another UIUX process (or a concurrent open in this one) created it first: fall through
			// to the same safety checks instead of failing; never chmod a directory this call did not make.
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		stats = await lstat(path)
	}
	if (stats.isSymbolicLink()) throw unsafe(path, 'it is a symbolic link')
	if (!stats.isDirectory()) throw unsafe(path, 'it is not a directory')
	if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw unsafe(path, 'it is writable by group or others (expected 0700)')
	return true
}

async function checkSafeFile(path: string): Promise<Stats | undefined> {
	const stats = await lstatOrUndefined(path)
	if (!stats) return undefined
	if (stats.isSymbolicLink()) throw unsafe(path, 'it is a symbolic link')
	if (!stats.isFile()) throw unsafe(path, 'it is not a regular file')
	if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw unsafe(path, 'it is writable by group or others (expected 0600)')
	return stats
}

async function syncDirectory(path: string): Promise<void> {
	let handle
	try {
		handle = await open(path, constants.O_RDONLY)
		await handle.sync()
	}
	catch { /* directory fsync is best effort on some platforms */ }
	finally { await handle?.close() }
}

async function writeAtomically(path: string, contents: string): Promise<void> {
	const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`
	const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
	try {
		await handle.writeFile(contents, 'utf8')
		await handle.sync()
	}
	finally {
		await handle.close()
	}
	try {
		await rename(temporary, path)
	}
	catch (error) {
		await rm(temporary, { force: true })
		throw error
	}
	await syncDirectory(dirname(path))
}

/**
 * Takes the roster lock at `lockPath` and returns its release; exported for the lock tests. The owner
 * record `{ pid, hostname, token, bootId? }` is written to a unique candidate file beside the lock and
 * published with an atomic `link`, which fails while another owner holds it, so the lock is never
 * seen empty or partial and an owner killed while taking it leaves at most a candidate. Like the
 * persistence lock it is not fsynced (issue #321), and it needs a file system with hard links.
 */
export async function acquireLock(lockPath: string, waitMs: number = LOCK_WAIT_MS): Promise<() => Promise<void>> {
	// Read before the wait budget starts: the first read of a process may take a moment.
	const bootId = await currentBootId()
	const started = Date.now()
	const token = randomBytes(8).toString('hex')
	const record = JSON.stringify({ pid: process.pid, hostname: hostname(), token, ...(bootId ? { bootId } : {}) })
	let retriedPastDeadline = false
	for (;;) {
		if (await publishLock(lockPath, token, record)) {
			await sweepLockLeftoversOccasionally({ directory: dirname(lockPath), lockName: basename(lockPath), prefix: '.access-lock-', bootId })
			return async () => {
				try {
					const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown }
					if (owner.token === token) await rm(lockPath, { force: true })
				}
				catch { /* already gone */ }
			}
		}
		if (await removeStaleLock(lockPath, bootId)) {
			// Try again at once after a stale lock went, but past the wait only once, so a lock that
			// keeps being replaced or re-judged cannot hold this loop forever.
			if (Date.now() - started <= waitMs) continue
			if (!retriedPastDeadline) {
				retriedPastDeadline = true
				continue
			}
		}
		if (Date.now() - started > waitMs)
			throw new AccessError('access.lock_busy', `Timed out waiting for another UIUX process holding ${lockPath}.`)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 15))
	}
}

/** Publishes the roster lock from a complete candidate; false while another owner holds it. */
async function publishLock(lockPath: string, token: string, record: string): Promise<boolean> {
	const candidate = join(dirname(lockPath), `.access-lock-${token}-${randomBytes(6).toString('hex')}.tmp`)
	try {
		const handle = await open(candidate, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
		try { await handle.writeFile(record, 'utf8') }
		finally { await handle.close() }
		try { await link(candidate, lockPath) }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false
			if (isLinkUnsupported(error)) throw hardLinksUnsupported(lockPath, error)
			throw error
		}
		return true
	}
	finally { await rm(candidate, { force: true }).catch(() => undefined) }
}

/** The refusal of a roster directory whose file system cannot make the hard links the roster lock needs. */
function hardLinksUnsupported(lockPath: string, error: unknown): AccessError {
	const code = (error instanceof HardLinkUnsupportedError ? error.cause : error) as NodeJS.ErrnoException
	return unsafe(dirname(lockPath), `its file system does not support hard links, which the roster lock needs (${code.code})`)
}

/**
 * Whether the roster lock is stale, removing it if so. A lock of another host stays held. A lock of
 * an earlier boot is stale (see `boot-staleness.ts`). A lock of this boot without a readable record
 * (only a power loss leaves one, since the lock is published complete) stays held until its
 * modification time falls before the computed boot (a clock that lagged at boot delays that) or
 * someone removes it. A lock of this boot whose pid has exited is stale.
 */
async function removeStaleLock(lockPath: string, bootId: string | undefined): Promise<boolean> {
	let judged: JudgedLock
	try {
		const stats = await lstat(lockPath)
		if (stats.isSymbolicLink() || !stats.isFile()) throw unsafe(lockPath, 'the lock is not a regular file')
		// The record, the modification time and the identity of the removed file come from one open file.
		judged = await readJudgedLock(lockPath)
	}
	catch (error) {
		if (isNotFound(error)) return true
		if (error instanceof AccessError) throw error
		return false
	}
	let owner: { pid?: unknown } | undefined
	try { owner = JSON.parse(judged.bytes.toString('utf8')) as { pid?: unknown } }
	catch { owner = undefined }
	// Neither the boot nor the pid of another host can be checked here: its lock stays held.
	if (recordedOnAnotherHost(owner)) return false
	// No process from an earlier boot still runs, so its lock is stale whatever pid or bytes it records.
	if (!isFromEarlierBoot(owner, judged, bootId)) {
		if (typeof owner !== 'object' || owner === null) return false
		if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) return false
		try {
			process.kill(owner.pid, 0)
			return false
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
		}
	}
	try {
		return await removeJudgedLock(lockPath, judged, {
			bootId,
			claimPath: suffix => join(dirname(lockPath), `.access-lock-break-${suffix}`),
		})
	}
	catch (error) {
		if (error instanceof HardLinkUnsupportedError) throw hardLinksUnsupported(lockPath, error)
		throw error
	}
}

type Fingerprint = Readonly<{ size: number; mtimeMs: number; ino: number }>

/** A validated roster as read. */
type StoreRead = Readonly<{ file: AccessFile; fingerprint: Fingerprint }>

export type OpenAccessStoreOptions = Readonly<{
	/** The Workspace root; it is resolved to its real path. */
	workspaceRoot: string
	home?: string
	/** Create the roster (and directories) when none exists. */
	create?: boolean
}>

export class AccessStore {
	readonly realRoot: string
	readonly paths: AccessStorePaths | undefined
	private file: AccessFile
	private fingerprint: Fingerprint | undefined
	private lastCheck = 0

	private constructor(realRoot: string, paths: AccessStorePaths | undefined, file: AccessFile, fingerprint: Fingerprint | undefined) {
		this.realRoot = realRoot
		this.paths = paths
		this.file = file
		this.fingerprint = fingerprint
		this.lastCheck = Date.now()
	}

	/** Opens the Workspace's roster. Returns `undefined` when none exists and `create` is false. */
	static async open(options: OpenAccessStoreOptions): Promise<AccessStore | undefined> {
		const realRoot = workspaceRealRoot(options.workspaceRoot)
		const home = options.home ?? resolveUiuxHome()
		assertHomeOutsideWorkspace(home, realRoot)
		const paths = accessStorePaths(home, realRoot)
		const create = options.create === true
		if (!await ensureSafeDirectory(paths.home, create)) return undefined
		if (!await ensureSafeDirectory(paths.workspaces, create)) return undefined
		if (!await ensureSafeDirectory(paths.dir, create)) return undefined
		await removeStaleTemporaries(paths)
		const existing = await AccessStore.readAt(paths, realRoot)
		if (existing) return new AccessStore(realRoot, paths, existing.file, existing.fingerprint)
		if (!create) return undefined
		const release = await acquireLock(paths.lock)
		try {
			const raced = await AccessStore.readAt(paths, realRoot)
			if (raced) return new AccessStore(realRoot, paths, raced.file, raced.fingerprint)
			const file = createEmptyAccessFile(realRoot, generateHint())
			await writeAtomically(paths.file, serialize(file))
			const stats = await lstat(paths.file)
			return new AccessStore(realRoot, paths, file, fingerprintOf(stats))
		}
		finally {
			await release()
		}
	}

	/**
	 * Reads the roster recorded for `realRoot` under `home` without creating or writing anything
	 * (`access copy --from`).
	 */
	static async readRoster(home: string, realRoot: string): Promise<AccessFile | undefined> {
		const paths = accessStorePaths(home, realRoot)
		for (const path of [paths.home, paths.workspaces, paths.dir])
			if (!await ensureSafeDirectory(path, false)) return undefined
		const read = await AccessStore.readAt(paths, realRoot)
		return read?.file
	}

	/** Reads and validates the roster, refusing any other roster version (`validateAccessFile`). */
	private static async readAt(paths: AccessStorePaths, realRoot: string): Promise<StoreRead | undefined> {
		const stats = await checkSafeFile(paths.file)
		if (!stats) return undefined
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFile(paths.file, 'utf8'))
		}
		catch (error) {
			if (isNotFound(error)) return undefined
			throw new AccessError('access.store_invalid', `The access store ${paths.file} is not valid JSON. ${RECOVERY_HINT}`)
		}
		let file: AccessFile
		try {
			file = validateAccessFile(parsed)
		}
		catch (error) {
			throw withStorePath(paths, error)
		}
		if (file.workspaceRoot !== realRoot)
			throw new AccessError('access.store_root_mismatch', `The access store ${paths.file} records Workspace ${file.workspaceRoot}, not ${realRoot}; refusing to reuse it. ${RECOVERY_HINT}`)
		return { file, fingerprint: fingerprintOf(stats) }
	}

	get data(): AccessFile {
		return this.file
	}

	get persistent(): boolean {
		return this.paths !== undefined
	}

	/**
	 * Re-reads the store when its size, mtime or inode changed (checked at most once per second
	 * unless forced), so CLI revokes and key changes apply on the next request. Returns true
	 * when the in-memory roster changed.
	 */
	async refresh(options: Readonly<{ force?: boolean }> = {}): Promise<boolean> {
		if (!this.paths) return false
		const now = Date.now()
		if (!options.force && now - this.lastCheck < RELOAD_INTERVAL_MS) return false
		this.lastCheck = now
		const stats = await checkSafeFile(this.paths.file)
		if (!stats) throw new AccessError('access.store_invalid', `The access store ${this.paths.file} disappeared.`)
		const next = fingerprintOf(stats)
		if (this.fingerprint && sameFingerprint(this.fingerprint, next)) return false
		const read = await AccessStore.readAt(this.paths, this.realRoot)
		if (!read) throw new AccessError('access.store_invalid', `The access store ${this.paths.file} disappeared.`)
		this.file = read.file
		this.fingerprint = read.fingerprint
		return true
	}

	/**
	 * Applies a mutation to the latest on-disk roster under the store lock and writes it
	 * atomically, after checking the write's invariants against that roster (`assertRosterWrite`).
	 */
	async update<T>(mutate: (file: AccessFile) => Mutation<T>): Promise<T> {
		if (!this.paths) {
			const { file, result } = mutate(this.file)
			const validated = validateAccessFile(file)
			assertRosterWrite(this.file, validated)
			this.file = validated
			return result
		}
		const release = await acquireLock(this.paths.lock)
		try {
			const current = await AccessStore.readAt(this.paths, this.realRoot)
			if (!current) throw new AccessError('access.store_invalid', `The access store ${this.paths.file} disappeared.`)
			const { file, result } = mutate(current.file)
			const validated = validateAccessFile(file)
			assertRosterWrite(current.file, validated)
			if (validated !== current.file) await writeAtomically(this.paths.file, serialize(validated))
			const stats = await lstat(this.paths.file)
			this.file = validated
			this.fingerprint = fingerprintOf(stats)
			this.lastCheck = Date.now()
			return result
		}
		finally {
			await release()
		}
	}

	/** Replaces the whole roster (`access copy --replace`). */
	async replace(file: AccessFile): Promise<void> {
		await this.update(() => ({ file, result: undefined }))
	}
}

/** Creates (or with `replace`, overwrites) a target roster from a ready-made file (`access copy`). */
export async function writeNewRoster(
	options: Readonly<{
		workspaceRoot: string
		home: string
		file: (realRoot: string) => AccessFile
		replace: boolean
		/** Told when the replaced roster is damaged, so the last-manager check is skipped. */
		onManagerCheckSkipped?: (message: string) => void
	}>,
): Promise<{ paths: AccessStorePaths; file: AccessFile }> {
	const realRoot = workspaceRealRoot(options.workspaceRoot)
	assertHomeOutsideWorkspace(options.home, realRoot)
	const paths = accessStorePaths(options.home, realRoot)
	for (const path of [paths.home, paths.workspaces, paths.dir]) await ensureSafeDirectory(path, true)
	const release = await acquireLock(paths.lock)
	try {
		const existing = await checkSafeFile(paths.file)
		if (existing && !options.replace)
			throw new AccessError('access.roster_exists', `Workspace ${realRoot} already has a roster (${paths.file}). Pass --replace to discard it.`)
		const file = validateAccessFile(options.file(realRoot))
		// A replacement keeps the last human manager like any other write (owner ruling 2 of 2026-10-11).
		if (existing) {
			const replaced = await readReplacedRoster(paths, realRoot)
			if (replaced.damaged) options.onManagerCheckSkipped?.(replaced.damaged)
			assertManagerKept(replaced.file, file)
		}
		await writeAtomically(paths.file, serialize(file))
		return { paths, file }
	}
	finally {
		await release()
	}
}

/** True when `realRoot` already has a roster under `home` (checked like the roster itself, without creating anything). */
export async function rosterExists(home: string, realRoot: string): Promise<boolean> {
	const paths = accessStorePaths(home, realRoot)
	for (const path of [paths.home, paths.workspaces, paths.dir])
		if (!await ensureSafeDirectory(path, false)) return false
	return await checkSafeFile(paths.file) !== undefined
}

/**
 * A refused roster's message, naming the file: `$UIUX_HOME/workspaces/<sha256>/access.json`.
 * Errors other than an invalid store pass through unchanged.
 */
function withStorePath(paths: AccessStorePaths, error: unknown): unknown {
	if (!(error instanceof AccessError) || error.code !== 'access.store_invalid') return error
	return new AccessError(error.code, `${error.message.replace(/^The access store /u, `The access store ${paths.file} `)} ${RECOVERY_HINT}`)
}

/**
 * The roster `access copy --replace` is about to replace, for the last-manager check (Clause
 * 01a12928-61ba-7191-b94d-cf3e0f0ffdda; owner ruling of 2026-10-11,
 * https://github.com/DevilTea/uiux/discussions/140#discussioncomment-18858540):
 * - a roster written by a newer UIUX (a roster version above this one's) is refused, so its data
 *   is never discarded by an older UIUX;
 * - a roster at any other version, or whose Token or session record carries `lan` or `listener`,
 *   is refused as well: UIUX never rewrites a refused roster file (Clause
 *   01a14917-7898-72fa-a8ad-ed737e4a9eae), so `--replace` does not either;
 * - any other damaged roster may be replaced, which is how it is repaired: `damaged` says why the
 *   last-manager check is skipped.
 */
async function readReplacedRoster(paths: AccessStorePaths, realRoot: string): Promise<Readonly<{ file?: AccessFile; damaged?: string }>> {
	let parsed: unknown
	try {
		parsed = JSON.parse(await readFile(paths.file, 'utf8'))
	}
	catch (error) {
		if (isNotFound(error)) return {}
		if (error instanceof SyntaxError) return { damaged: `${paths.file} is not valid JSON` }
		throw error
	}
	const version = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>).version : undefined
	if (Number.isInteger(version) && (version as number) > ACCESS_FILE_VERSION)
		throw new AccessError('access.store_invalid', `The roster ${paths.file} is roster version ${String(version)}, written by a newer UIUX; this UIUX will not replace it. Run uiux access copy with that newer UIUX.`)
	try {
		const file = validateAccessFile(parsed)
		return file.workspaceRoot === realRoot ? { file } : { damaged: `${paths.file} records Workspace ${file.workspaceRoot}` }
	}
	catch (error) {
		if (!(error instanceof AccessError)) throw error
		// A file that is not a JSON object is damaged rather than a roster at another version.
		const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
		if (isObject && (version !== ACCESS_FILE_VERSION || carriesRetiredField(parsed))) {
			const detail = error.message.replace(/^The access store is invalid: /u, '').replace(/\.$/u, '')
			throw new AccessError('access.store_invalid', `The roster ${paths.file} is refused: ${detail}; uiux access copy --replace never rewrites a refused roster. ${RECOVERY_HINT}`)
		}
		return { damaged: `${paths.file}: ${error.message}` }
	}
}

/** Whether a roster's Token or session record carries `lan` or `listener` (Clause 01a14917-7898-72fa-a8ad-ed737e4a9eae). */
function carriesRetiredField(parsed: unknown): boolean {
	const entries = (name: string): unknown[] => {
		const value = typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>)[name] : undefined
		return Array.isArray(value) ? value : []
	}
	const has = (entry: unknown, field: string) => typeof entry === 'object' && entry !== null && Object.hasOwn(entry, field)
	return entries('tokens').some(token => has(token, 'lan')) || entries('sessions').some(session => has(session, 'listener'))
}

/**
 * Refuses, before `access copy --replace` changes anything, a replacement of the target's roster
 * that would drop its last human manager (`assertManagerKept`); `writeNewRoster` checks again
 * under the lock.
 */
export async function assertReplacementKeepsManager(home: string, workspaceRoot: string, replacement: AccessFile): Promise<void> {
	const realRoot = workspaceRealRoot(workspaceRoot)
	if (!await rosterExists(home, realRoot)) return
	assertManagerKept((await readReplacedRoster(accessStorePaths(home, realRoot), realRoot)).file, replacement)
}

/**
 * Removes temporary files that a killed writer left beside the roster. Every roster write holds
 * the store lock while its temporary file exists, so under the lock any such file is stale. It
 * is best effort: when another process holds the lock, the files stay for a later open, and
 * opening never waits for the lock or fails on it.
 */
async function removeStaleTemporaries(paths: AccessStorePaths): Promise<void> {
	const stale = async () => (await readdir(paths.dir)).filter(name => ROSTER_TEMPORARY.test(name))
	if ((await stale()).length === 0) return
	let release: () => Promise<void>
	try {
		release = await acquireLock(paths.lock, 0)
	}
	catch (error) {
		if (error instanceof AccessError && error.code === 'access.lock_busy') return
		throw error
	}
	try {
		for (const name of await stale()) await rm(join(paths.dir, name), { force: true })
	}
	finally {
		await release()
	}
}

function serialize(file: AccessFile): string {
	return `${JSON.stringify(file, null, 2)}\n`
}

function fingerprintOf(stats: Stats): Fingerprint {
	return { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino }
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.size === right.size && left.mtimeMs === right.mtimeMs && left.ino === right.ino
}
