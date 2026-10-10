import { createHash, randomBytes } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { HostHistoryPaths } from '../../persistence/history/host-store'
import { generateHint } from './credentials'
import {
	AccessError,
	assertRosterWrite,
	createEmptyAccessFile,
	readAccessFile,
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
 * The first process that opens a `version: 1` roster upgrades it to `version: 2` under the lock
 * (Rule 01a11c09-b623-7824-8745-9c10510d0d53), after keeping the version 1 file beside it as
 * `access.v1.json` (Clause 01a11c09-a195-768b-ba6e-a64eb7f05eca). Both writes are atomic and the
 * backup comes first, so a crash between them leaves the version 1 roster in place and the next
 * opener upgrades it again; no reader ever sees a half-written roster or loses the version 1 file.
 */
export const ACCESS_FILE_NAME = 'access.json'
export const ACCESS_LOCK_NAME = '.access.lock'
export const ACCESS_V1_BACKUP_NAME = 'access.v1.json'
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

export type AccessStorePaths = Readonly<{ home: string; workspaces: string; dir: string; file: string; lock: string; v1Backup: string }>

export function accessStorePaths(home: string, realRoot: string): AccessStorePaths {
	const workspaces = join(home, 'workspaces')
	const dir = join(workspaces, workspaceStoreId(realRoot))
	return { home, workspaces, dir, file: join(dir, ACCESS_FILE_NAME), lock: join(dir, ACCESS_LOCK_NAME), v1Backup: join(dir, ACCESS_V1_BACKUP_NAME) }
}

/**
 * Host history of one Workspace (Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0):
 * `$UIUX_HOME/workspaces/<wsid>/history/`, beside the roster and under the same `<wsid>`.
 */
export function hostHistoryPaths(home: string, realRoot: string): HostHistoryPaths {
	const { workspaces, dir: workspaceDir } = accessStorePaths(home, realRoot)
	const dir = join(workspaceDir, 'history')
	return Object.freeze({
		home,
		workspaces,
		workspaceDir,
		dir,
		versions: join(dir, 'versions'),
		open: join(dir, 'open.json'),
		objects: join(dir, 'objects', 'sha256'),
	})
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

function isSameOrInside(parent: string, candidate: string): boolean {
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

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
	const started = Date.now()
	const token = randomBytes(8).toString('hex')
	for (;;) {
		try {
			const handle = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
			try { await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8') }
			finally { await handle.close() }
			return async () => {
				try {
					const owner = JSON.parse(await readFile(lockPath, 'utf8')) as { token?: unknown }
					if (owner.token === token) await rm(lockPath, { force: true })
				}
				catch { /* already gone */ }
			}
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
		}
		if (await removeStaleLock(lockPath)) continue
		if (Date.now() - started > LOCK_WAIT_MS)
			throw new AccessError('access.lock_busy', `Timed out waiting for another UIUX process holding ${lockPath}.`)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 15))
	}
}

async function removeStaleLock(lockPath: string): Promise<boolean> {
	let owner: { pid?: unknown }
	try {
		const stats = await lstat(lockPath)
		if (stats.isSymbolicLink() || !stats.isFile()) throw unsafe(lockPath, 'the lock is not a regular file')
		owner = JSON.parse(await readFile(lockPath, 'utf8')) as { pid?: unknown }
	}
	catch (error) {
		if (isNotFound(error)) return true
		if (error instanceof AccessError) throw error
		// A lock being written right now has no content yet; treat it as held.
		return false
	}
	if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid)) return false
	try {
		process.kill(owner.pid, 0)
		return false
	}
	catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
		await rm(lockPath, { force: true })
		return true
	}
}

type Fingerprint = Readonly<{ size: number; mtimeMs: number; ino: number }>

/** A validated roster as read: `legacy` when the file is `version: 1` (`file` is then its upgrade) and `text` as read. */
type StoreRead = Readonly<{ file: AccessFile; fingerprint: Fingerprint; legacy: boolean; text: string }>

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
		const existing = await AccessStore.readAt(paths, realRoot)
		if (existing && !existing.legacy) return new AccessStore(realRoot, paths, existing.file, existing.fingerprint)
		if (existing) {
			const upgraded = await AccessStore.upgradeAt(paths, realRoot)
			return new AccessStore(realRoot, paths, upgraded.file, upgraded.fingerprint)
		}
		if (!create) return undefined
		const release = await acquireLock(paths.lock)
		try {
			const raced = await AccessStore.readAt(paths, realRoot)
			if (raced && !raced.legacy) return new AccessStore(realRoot, paths, raced.file, raced.fingerprint)
			if (raced) {
				await AccessStore.writeUpgradeUnlocked(paths, raced)
				return new AccessStore(realRoot, paths, raced.file, fingerprintOf(await lstat(paths.file)))
			}
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
	 * (`access copy --from`). A `version: 1` roster is returned as its upgrade, without upgrading
	 * the file itself.
	 */
	static async readRoster(home: string, realRoot: string): Promise<AccessFile | undefined> {
		const paths = accessStorePaths(home, realRoot)
		for (const path of [paths.home, paths.workspaces, paths.dir])
			if (!await ensureSafeDirectory(path, false)) return undefined
		const read = await AccessStore.readAt(paths, realRoot)
		return read?.file
	}

	/**
	 * Reads and validates the roster. A `version: 1` roster comes back upgraded in memory with
	 * `legacy` set and its text, which `writeUpgradeUnlocked` keeps as the backup.
	 */
	private static async readAt(paths: AccessStorePaths, realRoot: string): Promise<StoreRead | undefined> {
		const stats = await checkSafeFile(paths.file)
		if (!stats) return undefined
		let text: string
		let parsed: unknown
		try {
			text = await readFile(paths.file, 'utf8')
			parsed = JSON.parse(text)
		}
		catch (error) {
			if (isNotFound(error)) return undefined
			throw new AccessError('access.store_invalid', `The access store ${paths.file} is not valid JSON.`)
		}
		const { file, legacy } = readAccessFile(parsed)
		if (file.workspaceRoot !== realRoot)
			throw new AccessError('access.store_root_mismatch', `The access store ${paths.file} records Workspace ${file.workspaceRoot}, not ${realRoot}; refusing to reuse it.`)
		return { file, fingerprint: fingerprintOf(stats), legacy, text }
	}

	/** Upgrades a `version: 1` roster on disk under the store lock, unless another process already has. */
	private static async upgradeAt(paths: AccessStorePaths, realRoot: string): Promise<{ file: AccessFile; fingerprint: Fingerprint }> {
		const release = await acquireLock(paths.lock)
		try {
			const current = await AccessStore.readAt(paths, realRoot)
			if (!current) throw new AccessError('access.store_invalid', `The access store ${paths.file} disappeared.`)
			if (!current.legacy) return current
			await AccessStore.writeUpgradeUnlocked(paths, current)
			return { file: current.file, fingerprint: fingerprintOf(await lstat(paths.file)) }
		}
		finally {
			await release()
		}
	}

	/**
	 * Clause 01a11c09-a195-768b-ba6e-a64eb7f05eca, with the lock held: first keeps the `version: 1`
	 * text as `access.v1.json` (mode 0600), then replaces the roster with its upgrade. Each write is
	 * atomic, and the backup is complete before the roster changes.
	 */
	private static async writeUpgradeUnlocked(paths: AccessStorePaths, read: StoreRead): Promise<void> {
		await writeAtomically(paths.v1Backup, read.text)
		await writeAtomically(paths.file, serialize(read.file))
	}

	get data(): AccessFile {
		return this.file
	}

	get persistent(): boolean {
		return this.paths !== undefined
	}

	/**
	 * Re-reads the store when its size, mtime or inode changed (checked at most once per second
	 * unless forced), so CLI revokes and role changes apply on the next request. Returns true
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
		// A `version: 1` roster written while this process runs (a backup put back by hand, say) is
		// upgraded like on first open.
		const current = read.legacy ? await AccessStore.upgradeAt(this.paths, this.realRoot) : read
		this.file = current.file
		this.fingerprint = current.fingerprint
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
			// A `version: 1` roster on disk is upgraded by this write: its backup comes first.
			if (current.legacy) await writeAtomically(this.paths.v1Backup, current.text)
			if (validated !== current.file || current.legacy) await writeAtomically(this.paths.file, serialize(validated))
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
	options: Readonly<{ workspaceRoot: string; home: string; file: (realRoot: string) => AccessFile; replace: boolean }>,
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

export type HostHistoryCopyPlan = Readonly<{
	source: HostHistoryPaths
	target: HostHistoryPaths
	/** The source Workspace has a host history directory to copy. */
	sourceExists: boolean
	/** The target Workspace already has a host history directory. */
	targetExists: boolean
}>

/**
 * Looks at both host history directories for `uiux access copy` without writing anything
 * (Clause 01a1144e-56bd-7988-8d2a-87b23954ca49). Each directory down to a history directory, and
 * every entry inside the source's, must pass the roster's checks: no symbolic link, a real
 * directory or regular file, not writable by group or others.
 */
export async function planHostHistoryCopy(home: string, sourceRealRoot: string, targetRealRoot: string): Promise<HostHistoryCopyPlan> {
	const source = hostHistoryPaths(home, sourceRealRoot)
	const target = hostHistoryPaths(home, targetRealRoot)
	const exists = async (paths: HostHistoryPaths) => {
		for (const directory of [paths.home, paths.workspaces, paths.workspaceDir, paths.dir])
			if (!await ensureSafeDirectory(directory, false)) return false
		return true
	}
	const sourceExists = await exists(source)
	// Preflight: an unsafe entry anywhere in the source refuses the command before anything is written.
	if (sourceExists) await listHistoryTree(source.dir)
	return { source, target, sourceExists, targetExists: await exists(target) }
}

export type HostHistoryCopyOptions = Readonly<{
	replace: boolean
	/** Runs right before the target's history changes; throwing refuses the copy, leaving the target unchanged. */
	beforeSwap?: () => Promise<void>
	/**
	 * Whether a blob the copied versions name, but the copy lacks, is stored outside host history
	 * for the target (a Checkpoint blob in the target Workspace's artifact store).
	 */
	blobAvailableElsewhere?: (digest: string) => Promise<boolean>
}>

export type HostHistoryCopyResult = Readonly<{
	/** Files copied. */
	files: number
	/** Versions of the target's own history that `replace` discarded. */
	discardedVersions: number
	/** Blobs the copied versions or open-autosave events name that the source did not have either. */
	missingBlobs: readonly string[]
}>

/**
 * Copies the source's host history directory into the target's once (Clause
 * 01a1144e-56bd-7988-8d2a-87b23954ca49), with the roster's permissions: directories 0700, files
 * 0600, each file fsynced. A symbolic link, a non-regular file or a group- or other-writable entry
 * anywhere in the source refuses the copy. Dot-files (a store's interrupted temporary writes) are
 * not copied, and a file removed between listing and reading (pruned) is skipped.
 *
 * The copy is assembled beside the target and checked before it replaces anything: every blob a
 * copied version or open-autosave event names must be in the copy (or available elsewhere for the
 * target). A blob the
 * copy lacks while the source has it means the copy raced a writer of the source: the copy is
 * refused and removed, so the target is unchanged and a rerun copies a consistent state. A blob the
 * source lacks too is reported in `missingBlobs` and does not refuse the copy: the source history
 * was already incomplete, the copy is faithful to it, and refusing would make it uncopyable.
 *
 * Then the copy is renamed into place; with `replace` an existing target history is swapped out and
 * removed, otherwise it refuses the copy. The caller holds the target Workspace's persistence lock,
 * which every history writer of the target holds too, and, where it can, the source's.
 */
export async function copyHostHistory(plan: HostHistoryCopyPlan, options: HostHistoryCopyOptions): Promise<HostHistoryCopyResult> {
	const entries = await listHistoryTree(plan.source.dir)
	const createdWorkspaceDir = !await ensureSafeDirectory(plan.target.workspaceDir, false)
	for (const directory of [plan.target.home, plan.target.workspaces, plan.target.workspaceDir]) await ensureSafeDirectory(directory, true)
	const existing = await lstatOrUndefined(plan.target.dir)
	if (existing) {
		if (existing.isSymbolicLink()) throw unsafe(plan.target.dir, 'it is a symbolic link')
		if (!options.replace)
			throw new AccessError('access.roster_exists', `Workspace ${plan.target.workspaceDir} already has host history (${plan.target.dir}). Pass --replace to discard it.`)
	}
	const staging = join(plan.target.workspaceDir, `.history-copy-${randomBytes(6).toString('hex')}.tmp`)
	let files = 0
	let discardedVersions = 0
	let missingBlobs: string[] = []
	try {
		await mkdir(staging, { mode: 0o700 })
		await chmod(staging, 0o700)
		for (const entry of entries) {
			const destination = join(staging, entry.relative)
			if (entry.directory) {
				await mkdir(destination, { mode: 0o700 })
				await chmod(destination, 0o700)
				continue
			}
			const bytes = await readNoFollow(join(plan.source.dir, entry.relative))
			if (!bytes) continue
			const handle = await open(destination, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
			try {
				await handle.writeFile(bytes)
				await handle.sync()
			}
			finally {
				await handle.close()
			}
			files += 1
		}
		for (const entry of entries.filter(item => item.directory).reverse()) await syncDirectory(join(staging, entry.relative))
		await syncDirectory(staging)

		const raced: string[] = []
		for (const digest of await referencedBlobDigests(staging)) {
			if (await lstatOrUndefined(join(staging, blobRelativePath(digest)))) continue
			if (await options.blobAvailableElsewhere?.(digest)) continue
			if (await lstatOrUndefined(join(plan.source.dir, blobRelativePath(digest)))) raced.push(digest)
			else missingBlobs.push(digest)
		}
		if (raced.length > 0)
			throw new AccessError('access.store_invalid', `The host history of ${plan.source.workspaceDir} changed while it was copied (${raced.length} blob(s) its versions or open autosave name were not copied); nothing was changed. Run uiux access copy again.`)
		missingBlobs = missingBlobs.sort()

		await options.beforeSwap?.()
		if (existing) {
			discardedVersions = await countVersionFiles(join(plan.target.dir, 'versions'))
			const discarded = join(plan.target.workspaceDir, `.history-replaced-${randomBytes(6).toString('hex')}.tmp`)
			await rename(plan.target.dir, discarded)
			try {
				await rename(staging, plan.target.dir)
			}
			catch (error) {
				// Put the target's own history back; the staged copy is removed below.
				await rename(discarded, plan.target.dir)
				throw error
			}
			await rm(discarded, { recursive: true, force: true })
		}
		else {
			await rename(staging, plan.target.dir)
		}
		await syncDirectory(plan.target.workspaceDir)
	}
	catch (error) {
		await rm(staging, { recursive: true, force: true })
		// Leave no trace of a target this copy started: its `<wsid>` directory goes when still empty.
		if (createdWorkspaceDir) await rmdir(plan.target.workspaceDir).catch(() => undefined)
		throw error
	}
	return { files, discardedVersions, missingBlobs }
}

/** A blob's path under a host history directory (Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0). */
function blobRelativePath(digest: string): string {
	const hex = digest.slice('sha256:'.length)
	return join('objects', 'sha256', hex.slice(0, 2), hex)
}

const DIGEST = /^sha256:[0-9a-f]{64}$/u

/**
 * Every blob digest named by the version files under `historyDir/versions` and by the open
 * autosave's events in `historyDir/open.json`; unreadable records and journal lines are left to the
 * store's own checks.
 */
async function referencedBlobDigests(historyDir: string): Promise<Set<string>> {
	const digests = new Set<string>()
	const addDigests = (files: unknown) => {
		if (!files || typeof files !== 'object') return
		for (const digest of Object.values(files)) if (typeof digest === 'string' && DIGEST.test(digest)) digests.add(digest)
	}
	let journal: string | undefined
	try { journal = await readFile(join(historyDir, 'open.json'), 'utf8') }
	catch (error) {
		if (!isNotFound(error)) throw error
	}
	for (const line of journal?.split('\n') ?? []) {
		let entry: unknown
		try { entry = JSON.parse(line) }
		catch { continue }
		if ((entry as { type?: unknown } | null)?.type === 'event') addDigests((entry as { files?: unknown }).files)
	}
	const versions = join(historyDir, 'versions')
	let names: string[]
	try { names = await readdir(versions) }
	catch (error) {
		if (isNotFound(error)) return digests
		throw error
	}
	for (const name of names) {
		if (!VERSION_FILE.test(name)) continue
		let record: unknown
		try { record = JSON.parse(await readFile(join(versions, name), 'utf8')) }
		catch { continue }
		const resources = (record as { resources?: unknown })?.resources
		if (!Array.isArray(resources)) continue
		for (const resource of resources) addDigests((resource as { files?: unknown })?.files)
	}
	return digests
}

const VERSION_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/iu

async function countVersionFiles(directory: string): Promise<number> {
	try {
		return (await readdir(directory)).filter(name => VERSION_FILE.test(name)).length
	}
	catch (error) {
		if (isNotFound(error)) return 0
		throw error
	}
}

/** The file's bytes, or `undefined` when it is gone (pruned since it was listed); a symbolic link is refused. */
async function readNoFollow(path: string): Promise<Buffer | undefined> {
	let handle
	try {
		handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	}
	catch (error) {
		if (isNotFound(error)) return undefined
		throw error
	}
	try {
		return await handle.readFile()
	}
	finally {
		await handle.close()
	}
}

type HistoryTreeEntry = Readonly<{ relative: string; directory: boolean }>

/** Every directory and regular file under `root`, parents first; dot-files are left out. */
async function listHistoryTree(root: string): Promise<HistoryTreeEntry[]> {
	const entries: HistoryTreeEntry[] = []
	const visit = async (relativeDir: string): Promise<void> => {
		const names = (await readdir(join(root, relativeDir))).sort()
		for (const name of names) {
			if (name.startsWith('.')) continue
			const relativePath = relativeDir ? join(relativeDir, name) : name
			const path = join(root, relativePath)
			const stats = await lstatOrUndefined(path)
			// Removed since the directory was read (pruned): nothing to copy.
			if (!stats) continue
			if (stats.isSymbolicLink()) throw unsafe(path, 'it is a symbolic link')
			if (process.platform !== 'win32' && (stats.mode & 0o022) !== 0) throw unsafe(path, 'it is writable by group or others')
			if (stats.isDirectory()) {
				entries.push({ relative: relativePath, directory: true })
				await visit(relativePath)
			}
			else if (stats.isFile()) {
				entries.push({ relative: relativePath, directory: false })
			}
			else {
				throw unsafe(path, 'it is neither a regular file nor a directory')
			}
		}
	}
	await visit('')
	return entries
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
