import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { isSafeRelativePath, segmentNamesInAnyCase } from '../domain/validation'
import { NO_FOLLOW, openedFilePath, PATH_BINDING } from './bound-open'
import type { KitProject } from './kit-registry'

/** The kit's source directory, relative to `kit/` (Clause 01a11bb1-8a44-793a-8306-21fea501acad). */
const KIT_SOURCE_DIRECTORY = 'src'

/**
 * The kit's installed dependencies, relative to `kit/`, which are not kit project files (Clauses
 * 01a11bb1-8e98-7270-9662-682c048f9929 and 01a115cd-d109-76d3-9622-85d0080c60b6). Compared in any
 * letter case (`segmentNamesInAnyCase`), since a case-insensitive file system (the macOS default)
 * reaches it by any spelling, and by its identity on disk as well.
 */
const KIT_DEPENDENCY_DIRECTORY = 'node_modules'

/** The largest kit file one read of the kit source operations returns (Clause 01a13d3e-c4b5-…). */
export const MAX_KIT_FILE_BYTES = 8 * 1024 * 1024

/** The most files `list_kit_files` returns (Clause 01a13d3e-c4b5-…). */
export const MAX_KIT_FILE_ENTRIES = 10_000

/** The chunk a bounded read takes from the file at a time. */
const READ_CHUNK_BYTES = 64 * 1024

function isDependencyDirectory(segment: string): boolean {
	return segmentNamesInAnyCase(segment, KIT_DEPENDENCY_DIRECTORY)
}

/**
 * True when `file` can name a kit project file: a plain relative path (no empty, `.` or `..`
 * segment, no backslash or control character, so never absolute) outside `kit/node_modules/`.
 */
export function isKitFilePath(file: unknown): file is string {
	return isSafeRelativePath(file) && !isDependencyDirectory(file.split('/')[0]!)
}

/**
 * The answer of one kit file read: its bytes; `not_found` when it is not a regular file inside
 * `kit/` reached without a symbolic link (missing, a directory, a FIFO or device, a link, below a
 * linked directory, inside `kit/node_modules/`, not a kit path, or moved out of `kit/` while it was
 * read), one answer so nothing about what lies elsewhere is told; or `too_large` for a kit file
 * above the read's byte limit, which is never read.
 */
export type KitFileReadOutcome =
	| Readonly<{ status: 'found'; bytes: Uint8Array }>
	| Readonly<{ status: 'not_found' }>
	| Readonly<{ status: 'too_large'; limit: number }>

export type KitFileReadOptions = Readonly<{
	/** The largest file to read, in bytes; `Infinity` reads any size (`uiux components`). Defaults to {@link MAX_KIT_FILE_BYTES}. */
	maxBytes?: number
	/**
	 * Test seams for the races the path checks alone leave open: run after those checks, after the
	 * open before the open file is judged, and after it was judged before it is read.
	 */
	beforeOpen?: () => Promise<void>
	afterOpen?: () => Promise<void>
	beforeRead?: () => Promise<void>
}>

const NOT_FOUND: KitFileReadOutcome = Object.freeze({ status: 'not_found' })

type Identity = Readonly<{ dev: bigint; ino: bigint }>

function sameIdentity(a: Identity | undefined, b: Identity | undefined): boolean {
	return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino
}

async function lstatOrUndefined(path: string): Promise<BigIntStats | undefined> {
	return lstat(path, { bigint: true }).catch(() => undefined)
}

/** `rel` (a `relative()` result) as segments when it lies strictly inside its base, else `undefined`. */
function insideSegments(rel: string): string[] | undefined {
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)) return undefined
	return rel.split(sep)
}

/**
 * Where `kit/` lies now: its real path and identity, only while it is a real directory (not a link)
 * strictly inside the Workspace root's real path, and the identity of `kit/node_modules/`, if any.
 */
type KitAnchor = Readonly<{ real: string; identity: Identity; dependencies?: Identity }>

async function anchorKit(kit: KitProject): Promise<KitAnchor | undefined> {
	if (!kit.directory) return undefined
	const info = await lstatOrUndefined(kit.directory)
	if (!info?.isDirectory() || info.isSymbolicLink()) return undefined
	const real = await realpath(kit.directory).catch(() => undefined)
	if (real === undefined || !insideSegments(relative(kit.realRoot, real))) return undefined
	if (!sameIdentity(info, await lstatOrUndefined(real))) return undefined
	const dependencies = await lstatOrUndefined(join(real, KIT_DEPENDENCY_DIRECTORY))
	return { real, identity: info, ...(dependencies?.isDirectory() ? { dependencies } : {}) }
}

/**
 * True when the open entry with identity `identity`, whose real path is `real`, lies inside `kit/`
 * and outside `kit/node_modules/`: `real` is strictly below `kit/`'s real path (or is it, for
 * `kit/` itself when `root`), its first segment there is not `node_modules` (by name in any case,
 * or by identity), and the entry at `real` is the one `identity` names.
 */
async function liesInsideKit(anchor: KitAnchor, real: string, identity: Identity, root = false): Promise<boolean> {
	if (root) return real === anchor.real && sameIdentity(identity, anchor.identity) && sameIdentity(identity, await lstatOrUndefined(real))
	const segments = insideSegments(relative(anchor.real, real))
	if (!segments || isDependencyDirectory(segments[0]!)) return false
	if (anchor.dependencies && sameIdentity(anchor.dependencies, await lstatOrUndefined(join(anchor.real, segments[0]!)))) return false
	return sameIdentity(identity, await lstatOrUndefined(real))
}

/**
 * The real path of the open file `handle`, opened by `path` (`kit/`'s real path and segments below
 * it), as the platform can tell it ({@link PATH_BINDING}): on darwin `path` itself, since the open
 * refused any symbolic link along it; on linux where `/proc/self/fd` says the open file lies now.
 *
 * Residual risk on other platforms (win32 and the rest): `path` is resolved again after the open,
 * which a local user who can write inside `kit/` and swaps a directory for a link around this
 * resolution and the identity check can mislead into accepting a file opened outside `kit/`.
 */
async function openedRealPath(handle: FileHandle, path: string): Promise<string | undefined> {
	switch (PATH_BINDING) {
		case 'open': return path
		case 'fd': return openedFilePath(handle)
		default: return realpath(path).catch(() => undefined)
	}
}

type OpenedKitEntry = Readonly<{ handle: FileHandle; info: BigIntStats }>

/**
 * Opens `path` (`kit/`'s real path and segments below it) with `flags`, never through a final
 * symbolic link and, on darwin, through none at all, and returns the open entry only when it lies
 * inside `kit/` outside `kit/node_modules/` by its real path ({@link openedRealPath}) and identity
 * (`liesInsideKit`); otherwise it is closed and `undefined` returned. `afterOpen` is a test seam.
 */
async function openInsideKit(anchor: KitAnchor, path: string, flags: number, options: Readonly<{ root?: boolean; afterOpen?: () => Promise<void> }> = {}): Promise<OpenedKitEntry | undefined> {
	let handle: FileHandle
	try {
		handle = await open(path, flags | NO_FOLLOW)
	}
	catch {
		// ELOOP (a link along the path on darwin, or a final link) and every other failure alike.
		return undefined
	}
	try {
		await options.afterOpen?.()
		const info = await handle.stat({ bigint: true })
		const real = await openedRealPath(handle, path)
		if (real !== undefined && await liesInsideKit(anchor, real, info, options.root)) return { handle, info }
	}
	catch {
		// A failed check refuses the entry, as a failed open does.
	}
	await handle.close().catch(() => {})
	return undefined
}

/** The flags a kit file is opened with: read-only, and without blocking, so a FIFO swapped in never stalls the open. */
const FILE_OPEN_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK

/** The flags a kit directory is opened with, to judge it by its open entry (`O_DIRECTORY` is undefined on win32). */
const DIRECTORY_OPEN_FLAGS = constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)

/** At most `limit` bytes from `handle`, or `undefined` when more arrive. */
async function readBounded(handle: FileHandle, limit: number): Promise<Uint8Array | undefined> {
	if (!Number.isFinite(limit)) {
		try {
			return await handle.readFile()
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException | undefined)?.code === 'ERR_FS_FILE_TOO_LARGE') return undefined
			throw error
		}
	}
	const chunks: Buffer[] = []
	let total = 0
	for (;;) {
		const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, limit + 1 - total))
		const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
		if (bytesRead === 0) break
		chunks.push(chunk.subarray(0, bytesRead))
		total += bytesRead
		if (total > limit) return undefined
	}
	return Buffer.concat(chunks, total)
}

/**
 * Opens the kit project file `file` (relative to `kit/`) as {@link readKitFile} describes: the path
 * checked segment by segment, then opened ({@link openInsideKit}) and judged by the open file,
 * which must be a regular file inside `kit/` outside `kit/node_modules/`. `undefined` otherwise.
 * The caller reads from the returned handle and closes it.
 */
async function openKitFile(kit: KitProject, file: string, options: Pick<KitFileReadOptions, 'beforeOpen' | 'afterOpen'>): Promise<OpenedKitEntry | undefined> {
	if (!kit.directory || !isKitFilePath(file)) return undefined
	const anchor = await anchorKit(kit)
	if (!anchor) return undefined
	const segments = file.split('/')
	let path = anchor.real
	for (const [index, segment] of segments.entries()) {
		path = join(path, segment)
		const info = await lstatOrUndefined(path)
		const last = index === segments.length - 1
		if (!info || info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return undefined
	}
	await options.beforeOpen?.()
	const opened = await openInsideKit(anchor, path, FILE_OPEN_FLAGS, { afterOpen: options.afterOpen })
	if (opened && opened.info.isFile()) return opened
	await opened?.handle.close().catch(() => {})
	return undefined
}

/**
 * Reads the kit project file `file` (relative to `kit/`; Rule 01a13d3e-e253-76b7-84e5-5f3fb167b635).
 * The path is checked segment by segment (no symbolic link, each parent a directory, the last a
 * regular file), then opened ({@link openInsideKit}) without blocking, and the open file itself
 * decides: it must be a regular file inside `kit/` outside `kit/node_modules/` and fit `maxBytes`,
 * read from the open file and refused when more arrives. On darwin and linux a directory swapped
 * for a link at any moment is therefore refused, never read; elsewhere `openedRealPath` notes the
 * residual risk. The kit file Resources, the MCP kit source Tools and `uiux components` use it.
 */
export async function readKitFile(kit: KitProject, file: string, options: KitFileReadOptions = {}): Promise<KitFileReadOutcome> {
	const maxBytes = options.maxBytes ?? MAX_KIT_FILE_BYTES
	const opened = await openKitFile(kit, file, options)
	if (!opened) return NOT_FOUND
	const { handle, info } = opened
	try {
		if (info.size > BigInt(Number.isFinite(maxBytes) ? maxBytes : Number.MAX_SAFE_INTEGER)) return { status: 'too_large', limit: maxBytes }
		await options.beforeRead?.()
		const bytes = await readBounded(handle, maxBytes)
		return bytes === undefined ? { status: 'too_large', limit: maxBytes } : { status: 'found', bytes }
	}
	catch {
		return NOT_FOUND
	}
	finally {
		await handle.close().catch(() => {})
	}
}

/**
 * The stat fields of a kit entry that a cached file digest is keyed by: its identity (`dev`,
 * `ino`), `size`, and its modification and change times in nanoseconds.
 */
export type KitEntryStamp = Readonly<{ dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }>

function stampOf(info: BigIntStats): KitEntryStamp {
	return { dev: info.dev, ino: info.ino, size: info.size, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs }
}

export function sameStamp(a: KitEntryStamp | undefined, b: KitEntryStamp | undefined): boolean {
	return a !== undefined && b !== undefined && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
}

/** The chunk a streamed digest reads from the file at a time. */
const DIGEST_CHUNK_BYTES = 1024 * 1024

const DIGEST_NOT_FOUND = Object.freeze({ status: 'not_found' as const })

/**
 * The file digest of a kit file: `sha256:` and the lowercase hex SHA-256 of its bytes (Clause
 * 01a11bb1-8b0c-7590-9478-0348530b1ea7), with the stamp of the open file taken before it was read;
 * or `not_found`, also when a read fails.
 */
export type KitFileDigestOutcome =
	| Readonly<{ status: 'found'; digest: string; stamp: KitEntryStamp }>
	| Readonly<{ status: 'not_found' }>

/**
 * The file digest of the kit project file `file`, opened as {@link readKitFile} opens it and hashed
 * in chunks from the open file, so a file of any size is digested and none is held in memory whole.
 */
export async function digestKitFile(kit: KitProject, file: string, options: Omit<KitFileReadOptions, 'maxBytes'> = {}): Promise<KitFileDigestOutcome> {
	const opened = await openKitFile(kit, file, options)
	if (!opened) return DIGEST_NOT_FOUND
	const { handle, info } = opened
	try {
		await options.beforeRead?.()
		const hash = createHash('sha256')
		const chunk = Buffer.allocUnsafe(DIGEST_CHUNK_BYTES)
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, null)
			if (bytesRead === 0) break
			hash.update(chunk.subarray(0, bytesRead))
		}
		return { status: 'found', digest: `sha256:${hash.digest('hex')}`, stamp: stampOf(info) }
	}
	catch {
		return DIGEST_NOT_FOUND
	}
	finally {
		await handle.close().catch(() => {})
	}
}

/**
 * The kit file `file` (relative to `kit/`, under `kit/src/`) for copying a component out, read as
 * {@link readKitFile} reads, or `not_found` outside `kit/src/`. `kit/src/` itself must be a real
 * directory (`locateKitProject`). The CLI copy-out and the MCP kit source Tools share it, so both
 * compute the same digests.
 */
export async function readKitSourceFile(kit: KitProject, file: string, options: KitFileReadOptions = {}): Promise<KitFileReadOutcome> {
	if (!kit.sourceDirectory || !isSafeRelativePath(file)) return NOT_FOUND
	const segments = file.split('/')
	if (segments[0] !== KIT_SOURCE_DIRECTORY || segments.length < 2) return NOT_FOUND
	return readKitFile(kit, file, options)
}

export type KitFileEntry = Readonly<{ path: string; size: number }>

/** The kit project's files, and whether the listing stopped at its entry limit. */
export type KitFileListing = Readonly<{ files: readonly KitFileEntry[]; truncated: boolean }>

/**
 * The kit project's files (Clauses 01a11bb1-b1c2-716f-b611-f8d7b2a934d9 and 01a13d3e-c4b5-…): every
 * regular file below `kit/` that `readKitFile` can open, by its path relative to `kit/`, sorted by
 * path, at most `maxEntries`. `kit/node_modules/` is left out, and so is every symbolic link,
 * whatever lies below a linked directory, and a file the host user cannot open; no kit (`kit/`
 * missing or a link) has none.
 *
 * Node cannot list a directory through an open handle, so each directory is opened as
 * {@link openInsideKit} opens a file, before and after its names are read by path, and counts only
 * when both opens reach the same directory inside `kit/`. Each file it names is then opened the same
 * way and listed, with the size of the open file, only when that is a regular file inside `kit/`.
 * On darwin and linux a directory swapped for a link while its names are read therefore adds no
 * file from outside `kit/`: a name read through the link is listed only when `kit/` holds a file of
 * that name. Elsewhere every open here carries the residual risk `openedRealPath` notes, so such a
 * swap can list the names and sizes of files outside `kit/`.
 *
 * Directories are walked in name order. Past `maxEntries` files the walk stops and `truncated` is
 * set; the files returned are the first found, sorted. `include`, when given, prunes the walk: a
 * directory or file whose kit-relative path it refuses is neither entered nor listed nor counted.
 */
export async function listKitFiles(kit: KitProject, maxEntries = MAX_KIT_FILE_ENTRIES, include?: (path: string, directory: boolean) => boolean): Promise<KitFileListing> {
	const anchor = await anchorKit(kit)
	if (!anchor) return { files: [], truncated: false }
	const files: KitFileEntry[] = []
	const full = () => files.length > maxEntries
	const opened = async <T>(path: string, flags: number, root: boolean, judge: (info: BigIntStats) => T | undefined): Promise<T | undefined> => {
		const entry = await openInsideKit(anchor, path, flags, { root })
		if (!entry) return undefined
		await entry.handle.close().catch(() => {})
		return judge(entry.info)
	}
	const directoryIdentity = (directory: string, root: boolean) => opened(directory, DIRECTORY_OPEN_FLAGS, root, info => info.isDirectory() ? info : undefined)
	const fileSize = (file: string) => opened(file, FILE_OPEN_FLAGS, false, info => info.isFile() ? Number(info.size) : undefined)
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const root = prefix === ''
		const before = await directoryIdentity(directory, root)
		if (!before) return
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
		if (!sameIdentity(before, await directoryIdentity(directory, root))) return
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		const directories: Array<readonly [string, string]> = []
		for (const entry of entries) {
			const path = root ? entry.name : `${prefix}/${entry.name}`
			if (!isKitFilePath(path)) continue
			if (include && !include(path, entry.isDirectory())) continue
			const absolute = join(directory, entry.name)
			if (entry.isDirectory()) {
				directories.push([absolute, path])
			}
			else if (entry.isFile()) {
				const size = await fileSize(absolute)
				if (size === undefined) continue
				files.push({ path, size })
				if (full()) return
			}
		}
		for (const [absolute, path] of directories) {
			await visit(absolute, path)
			if (full()) return
		}
	}
	await visit(anchor.real, '')
	const truncated = full()
	const sorted = files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	return { files: truncated ? sorted.slice(0, maxEntries) : sorted, truncated }
}

/** How many kit files one walk or stamp check opens or stats at a time. */
const STAT_CONCURRENCY = 32

/**
 * A walk of the kit project ({@link scanKitTree}): `kit/`'s real path, each directory walked by its
 * path relative to `kit/` (`''` for `kit/` itself) with the stamp of the open directory taken before
 * its names were read, each file listed with the stamp of the open file, and whether the walk
 * stopped early because its caller's limit was reached.
 */
export type KitTreeScan = Readonly<{
	real: string
	directories: ReadonlyMap<string, KitEntryStamp>
	files: ReadonlyMap<string, KitEntryStamp>
	truncated: boolean
}>

/**
 * The outcome of a kit walk: the walk; `no_kit` when there is no kit (`kit/` missing or a link);
 * or `unreadable` when a directory or a regular file the walk met could not be opened and judged
 * inside `kit/` (a permission refused, or an entry swapped or removed while it was walked), so no
 * file is ever left out of the walk silently.
 */
export type KitTreeScanOutcome =
	| Readonly<{ status: 'scanned'; scan: KitTreeScan }>
	| Readonly<{ status: 'no_kit' }>
	| Readonly<{ status: 'unreadable' }>

/**
 * Walks the kit project as {@link listKitFiles} does (every open judged inside `kit/` outside
 * `kit/node_modules/`, no symbolic link followed, `include` pruning the walk), recording the stamp of
 * each directory and file, for Product Kit provenance. `full` is asked after each file is listed and
 * stops the walk (`truncated`) when it answers true. Unlike the listing, a directory or file that
 * cannot be opened makes the walk `unreadable` instead of being left out.
 */
export async function scanKitTree(kit: KitProject, include: (path: string, directory: boolean) => boolean, full: (path: string) => boolean): Promise<KitTreeScanOutcome> {
	const anchor = await anchorKit(kit)
	if (!anchor) return { status: 'no_kit' }
	const directories = new Map<string, KitEntryStamp>()
	const files = new Map<string, KitEntryStamp>()
	let truncated = false
	let unreadable = false
	const opened = async (path: string, flags: number, root: boolean, kind: (info: BigIntStats) => boolean): Promise<BigIntStats | undefined> => {
		const entry = await openInsideKit(anchor, path, flags, { root })
		if (!entry) return undefined
		await entry.handle.close().catch(() => {})
		return kind(entry.info) ? entry.info : undefined
	}
	const directoryInfo = (directory: string, root: boolean) => opened(directory, DIRECTORY_OPEN_FLAGS, root, info => info.isDirectory())
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const root = prefix === ''
		const before = await directoryInfo(directory, root)
		const entries = before ? await readdir(directory, { withFileTypes: true }).catch(() => undefined) : undefined
		if (!before || !entries || !sameIdentity(before, await directoryInfo(directory, root))) {
			unreadable = true
			return
		}
		directories.set(prefix, stampOf(before))
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		const subdirectories: Array<readonly [string, string]> = []
		const regularFiles: Array<readonly [string, string]> = []
		for (const entry of entries) {
			const path = root ? entry.name : `${prefix}/${entry.name}`
			if (!isKitFilePath(path) || !include(path, entry.isDirectory())) continue
			if (entry.isDirectory()) subdirectories.push([join(directory, entry.name), path])
			else if (entry.isFile()) regularFiles.push([join(directory, entry.name), path])
		}
		for (let start = 0; start < regularFiles.length; start += STAT_CONCURRENCY) {
			const batch = regularFiles.slice(start, start + STAT_CONCURRENCY)
			const infos = await Promise.all(batch.map(([absolute]) => opened(absolute, FILE_OPEN_FLAGS, false, info => info.isFile())))
			for (const [index, info] of infos.entries()) {
				if (!info) {
					unreadable = true
					return
				}
				const path = batch[index]![1]
				files.set(path, stampOf(info))
				if (full(path)) {
					truncated = true
					return
				}
			}
		}
		for (const [absolute, path] of subdirectories) {
			await visit(absolute, path)
			if (truncated || unreadable) return
		}
	}
	await visit(anchor.real, '')
	return unreadable ? { status: 'unreadable' } : { status: 'scanned', scan: { real: anchor.real, directories, files, truncated } }
}

/**
 * True when every directory and file of the walk `scan` still has the stamp it was walked with, by
 * `lstat` alone: no file is opened or read. A directory whose names change (an entry added,
 * removed, renamed or swapped for a link) changes its modification and change times, so an
 * unchanged directory still names the entries the walk met; an unchanged file keeps its identity,
 * size and times. `kit/` must still be the real directory it was.
 */
export async function kitTreeUnchanged(kit: KitProject, scan: KitTreeScan): Promise<boolean> {
	const anchor = await anchorKit(kit)
	if (!anchor || anchor.real !== scan.real) return false
	const entries: Array<readonly [string, KitEntryStamp, boolean]> = []
	for (const [path, stamp] of scan.directories) entries.push([path, stamp, true])
	for (const [path, stamp] of scan.files) entries.push([path, stamp, false])
	let next = 0
	let unchanged = true
	const worker = async (): Promise<void> => {
		while (unchanged && next < entries.length) {
			const [path, stamp, directory] = entries[next++]!
			const info = await lstatOrUndefined(path === '' ? anchor.real : join(anchor.real, ...path.split('/')))
			if (!info || (directory ? !info.isDirectory() : !info.isFile()) || !sameStamp(stampOf(info), stamp)) unchanged = false
		}
	}
	await Promise.all(Array.from({ length: STAT_CONCURRENCY }, worker))
	return unchanged
}
