import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readdir, realpath, type FileHandle } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'

import { isSafeRelativePath, segmentNamesInAnyCase } from '../domain/validation'
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
	/** Test seams for the race the path checks alone leave open: run after those checks, and after the open before the open file is judged. */
	beforeOpen?: () => Promise<void>
	afterOpen?: () => Promise<void>
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
 * True when the entry with identity `identity`, named `path`, lies now inside `kit/` and outside
 * `kit/node_modules/`: its real path is strictly below `kit/`'s, its first segment there is not
 * `node_modules` (by name in any case, or by identity), and the entry at that real path is the one
 * `identity` names. What a symbolic link swapped in after an earlier check reaches fails this.
 */
async function liesInsideKit(anchor: KitAnchor, path: string, identity: Identity): Promise<boolean> {
	const real = await realpath(path).catch(() => undefined)
	if (real === undefined) return false
	const segments = insideSegments(relative(anchor.real, real))
	if (!segments || isDependencyDirectory(segments[0]!)) return false
	if (anchor.dependencies && sameIdentity(anchor.dependencies, await lstatOrUndefined(join(anchor.real, segments[0]!)))) return false
	return sameIdentity(identity, await lstatOrUndefined(real))
}

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
 * Reads the kit project file `file` (relative to `kit/`; Rule 01a13d3e-e253-76b7-84e5-5f3fb167b635).
 * The path is checked segment by segment (no symbolic link, each parent a directory, the last a
 * regular file), then opened without
 * following a final link and without blocking (a FIFO swapped in never stalls the open), and the
 * open file itself decides: it must be a regular file, lie inside `kit/` outside `kit/node_modules/`
 * by its real path and identity (`liesInsideKit`), and fit `maxBytes`, read from the open file and
 * refused when more arrives. A directory swapped for a link between the checks and the open is
 * therefore refused, never read. The kit file Resources, the MCP kit source Tools and
 * `uiux components` use it.
 */
export async function readKitFile(kit: KitProject, file: string, options: KitFileReadOptions = {}): Promise<KitFileReadOutcome> {
	const maxBytes = options.maxBytes ?? MAX_KIT_FILE_BYTES
	if (!kit.directory || !isKitFilePath(file)) return NOT_FOUND
	const anchor = await anchorKit(kit)
	if (!anchor) return NOT_FOUND
	const segments = file.split('/')
	let path = anchor.real
	for (const [index, segment] of segments.entries()) {
		path = join(path, segment)
		const info = await lstatOrUndefined(path)
		const last = index === segments.length - 1
		if (!info || info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return NOT_FOUND
	}
	await options.beforeOpen?.()
	let handle: FileHandle
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
	}
	catch {
		return NOT_FOUND
	}
	try {
		await options.afterOpen?.()
		const info = await handle.stat({ bigint: true })
		if (!info.isFile() || !await liesInsideKit(anchor, path, info)) return NOT_FOUND
		if (info.size > BigInt(Number.isFinite(maxBytes) ? maxBytes : Number.MAX_SAFE_INTEGER)) return { status: 'too_large', limit: maxBytes }
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
 * regular file below `kit/`, by its path relative to `kit/`, sorted by path, at most `maxEntries`.
 * `kit/node_modules/` is left out, and so is every symbolic link and whatever lies below a linked
 * directory, the files `readKitFile` refuses; no kit (`kit/` missing or a link) has none.
 *
 * Directories are walked in name order. Each one counts only when, after its entries were read, it
 * is still the directory first seen there and lies inside `kit/` by its real path, so a directory
 * swapped for a link while it is listed adds nothing. Past `maxEntries` files the walk stops and
 * `truncated` is set; the files returned are the first found, sorted.
 */
export async function listKitFiles(kit: KitProject, maxEntries = MAX_KIT_FILE_ENTRIES): Promise<KitFileListing> {
	const anchor = await anchorKit(kit)
	if (!anchor) return { files: [], truncated: false }
	const files: KitFileEntry[] = []
	const full = () => files.length > maxEntries
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const before = await lstatOrUndefined(directory)
		if (!before?.isDirectory() || before.isSymbolicLink()) return
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
		entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
		const found: KitFileEntry[] = []
		const directories: Array<readonly [string, string]> = []
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (!isKitFilePath(path)) continue
			const absolute = join(directory, entry.name)
			if (entry.isDirectory()) {
				directories.push([absolute, path])
			}
			else if (entry.isFile()) {
				const info = await lstatOrUndefined(absolute)
				if (info?.isFile()) found.push({ path, size: Number(info.size) })
			}
		}
		const after = await lstatOrUndefined(directory)
		const stillHere = sameIdentity(before, after) && (prefix === '' ? sameIdentity(before, anchor.identity) : await liesInsideKit(anchor, directory, before))
		if (!stillHere) return
		for (const entry of found) {
			files.push(entry)
			if (full()) return
		}
		for (const [absolute, path] of directories) {
			// The identity check of kit/node_modules/ catches a spelling the name check misses.
			if (prefix === '' && anchor.dependencies && sameIdentity(anchor.dependencies, await lstatOrUndefined(absolute))) continue
			await visit(absolute, path)
			if (full()) return
		}
	}
	await visit(anchor.real, '')
	const truncated = full()
	const sorted = files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
	return { files: truncated ? sorted.slice(0, maxEntries) : sorted, truncated }
}
