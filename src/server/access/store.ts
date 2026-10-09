import { createHash, randomBytes } from 'node:crypto'
import { constants, realpathSync, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import type { HostHistoryPaths } from '../../persistence/history/host-store'
import { generateHint } from './credentials'
import {
	AccessError,
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
 */
export const ACCESS_FILE_NAME = 'access.json'
export const ACCESS_LOCK_NAME = '.access.lock'
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

	/** An in-memory roster that is never written (the internal `uiux publish` server). */
	static memory(workspaceRoot: string): AccessStore {
		const realRoot = workspaceRealRoot(workspaceRoot)
		return new AccessStore(realRoot, undefined, createEmptyAccessFile(realRoot, generateHint()), undefined)
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

	/** Reads the roster recorded for `realRoot` under `home` without creating anything (`access copy --from`). */
	static async readRoster(home: string, realRoot: string): Promise<AccessFile | undefined> {
		const paths = accessStorePaths(home, realRoot)
		for (const path of [paths.home, paths.workspaces, paths.dir])
			if (!await ensureSafeDirectory(path, false)) return undefined
		const read = await AccessStore.readAt(paths, realRoot)
		return read?.file
	}

	private static async readAt(paths: AccessStorePaths, realRoot: string): Promise<{ file: AccessFile; fingerprint: Fingerprint } | undefined> {
		const stats = await checkSafeFile(paths.file)
		if (!stats) return undefined
		let parsed: unknown
		try {
			parsed = JSON.parse(await readFile(paths.file, 'utf8'))
		}
		catch (error) {
			if (isNotFound(error)) return undefined
			throw new AccessError('access.store_invalid', `The access store ${paths.file} is not valid JSON.`)
		}
		const file = validateAccessFile(parsed)
		if (file.workspaceRoot !== realRoot)
			throw new AccessError('access.store_root_mismatch', `The access store ${paths.file} records Workspace ${file.workspaceRoot}, not ${realRoot}; refusing to reuse it.`)
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
		this.file = read.file
		this.fingerprint = read.fingerprint
		return true
	}

	/** Applies a mutation to the latest on-disk roster under the store lock and writes it atomically. */
	async update<T>(mutate: (file: AccessFile) => Mutation<T>): Promise<T> {
		if (!this.paths) {
			const { file, result } = mutate(this.file)
			this.file = validateAccessFile(file)
			return result
		}
		const release = await acquireLock(this.paths.lock)
		try {
			const current = await AccessStore.readAt(this.paths, this.realRoot)
			if (!current) throw new AccessError('access.store_invalid', `The access store ${this.paths.file} disappeared.`)
			const { file, result } = mutate(current.file)
			const validated = validateAccessFile(file)
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

/**
 * Copies the source's host history directory into the target's once (Clause
 * 01a1144e-56bd-7988-8d2a-87b23954ca49), with the roster's permissions: directories 0700, files
 * 0600, each file fsynced. A symbolic link, a non-regular file or a group- or other-writable entry
 * anywhere in the source refuses the copy before the target changes. The copy is assembled beside
 * the target and renamed into place; with `replace` an existing target history is swapped out and
 * removed, otherwise it refuses the copy. Dot-files (a store's interrupted temporary writes) are
 * not copied. The caller holds the target Workspace's persistence lock, which every history writer
 * of the target holds too, and has created the target's `<wsid>` directory (the roster's).
 */
export async function copyHostHistory(plan: HostHistoryCopyPlan, options: Readonly<{ replace: boolean }>): Promise<Readonly<{ files: number }>> {
	const entries = await listHistoryTree(plan.source.dir)
	if (!await ensureSafeDirectory(plan.target.workspaceDir, false))
		throw unsafe(plan.target.workspaceDir, 'it does not exist')
	const existing = await lstatOrUndefined(plan.target.dir)
	if (existing) {
		if (existing.isSymbolicLink()) throw unsafe(plan.target.dir, 'it is a symbolic link')
		if (!options.replace)
			throw new AccessError('access.roster_exists', `Workspace ${plan.target.workspaceDir} already has host history (${plan.target.dir}). Pass --replace to discard it.`)
	}
	const staging = join(plan.target.workspaceDir, `.history-copy-${randomBytes(6).toString('hex')}.tmp`)
	let files = 0
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
		if (existing) {
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
		throw error
	}
	return { files }
}

async function readNoFollow(path: string): Promise<Buffer> {
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		return await handle.readFile()
	}
	finally {
		await handle.close()
	}
}

type HistoryTreeEntry =Readonly<{ relative: string; directory: boolean }>

/** Every directory and regular file under `root`, parents first; dot-files are left out. */
async function listHistoryTree(root: string): Promise<HistoryTreeEntry[]> {
	const entries: HistoryTreeEntry[] = []
	const visit = async (relativeDir: string): Promise<void> => {
		const names = (await readdir(join(root, relativeDir))).sort()
		for (const name of names) {
			if (name.startsWith('.')) continue
			const relativePath = relativeDir ? join(relativeDir, name) : name
			const path = join(root, relativePath)
			const stats = await lstat(path)
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
