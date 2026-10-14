import { lstat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isSafeRelativePath } from '../domain/validation'
import type { KitProject } from './kit-registry'

/** The kit's source directory, relative to `kit/` (Clause 01a11bb1-8a44-793a-8306-21fea501acad). */
const KIT_SOURCE_DIRECTORY = 'src'

/**
 * The kit's installed dependencies, relative to `kit/`, which are not kit project files (Clauses
 * 01a11bb1-8e98-7270-9662-682c048f9929 and 01a115cd-d109-76d3-9622-85d0080c60b6). Compared without
 * letter case, since a case-insensitive file system (the macOS default) reaches it by any spelling.
 */
const KIT_DEPENDENCY_DIRECTORY = 'node_modules'

function isDependencyDirectory(segment: string): boolean {
	return segment.toLowerCase() === KIT_DEPENDENCY_DIRECTORY
}

/**
 * True when `file` can name a kit project file: a plain relative path (no empty, `.` or `..`
 * segment, no backslash or control character, so never absolute) outside `kit/node_modules/`.
 */
export function isKitFilePath(file: unknown): file is string {
	return isSafeRelativePath(file) && !isDependencyDirectory(file.split('/')[0]!)
}

/**
 * The bytes of the kit project file `file` (relative to `kit/`), or `undefined` when it is not a
 * regular file reached without a symbolic link: missing, a directory, a link, below a linked
 * directory, inside `kit/node_modules/`, or not a kit path at all (`isKitFilePath`) are one answer,
 * so nothing about what lies elsewhere is read or told. `kit/` itself must be a real directory
 * (`locateKitProject`). The kit file Resources and the MCP kit source Tools use it.
 */
export async function readKitFile(kit: KitProject, file: string): Promise<Uint8Array | undefined> {
	if (!kit.directory || !isKitFilePath(file)) return undefined
	const segments = file.split('/')
	let path = kit.directory
	for (const [index, segment] of segments.entries()) {
		path = join(path, segment)
		const info = await lstat(path).catch(() => undefined)
		const last = index === segments.length - 1
		if (!info || info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return undefined
	}
	return readFile(path).catch(() => undefined)
}

/**
 * The bytes of the kit file `file` (relative to `kit/`, under `kit/src/`) for copying a component
 * out, read as {@link readKitFile} reads, or `undefined` outside `kit/src/`. `kit/src/` itself must
 * be a real directory (`locateKitProject`). The CLI copy-out and the MCP kit source Tools share it,
 * so both compute the same digests.
 */
export async function readKitSourceFile(kit: KitProject, file: string): Promise<Uint8Array | undefined> {
	if (!kit.sourceDirectory || !isSafeRelativePath(file)) return undefined
	const segments = file.split('/')
	if (segments[0] !== KIT_SOURCE_DIRECTORY || segments.length < 2) return undefined
	return readKitFile(kit, file)
}

export type KitFileEntry = Readonly<{ path: string; size: number }>

/**
 * The kit project's files (Clause 01a11bb1-b1c2-716f-b611-f8d7b2a934d9): every regular file below
 * `kit/`, by its path relative to `kit/`, sorted by path. `kit/node_modules/` is left out, and so is
 * every symbolic link and whatever lies below a linked directory, the files `readKitFile` refuses;
 * no kit (`kit/` missing or a link) has none.
 */
export async function listKitFiles(kit: KitProject): Promise<KitFileEntry[]> {
	if (!kit.directory) return []
	const files: KitFileEntry[] = []
	const visit = async (directory: string, prefix: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`
			if (!isKitFilePath(path)) continue
			const absolute = join(directory, entry.name)
			if (entry.isDirectory()) await visit(absolute, path)
			else if (entry.isFile()) {
				const info = await lstat(absolute).catch(() => undefined)
				if (info?.isFile()) files.push({ path, size: info.size })
			}
		}
	}
	await visit(kit.directory, '')
	return files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
}
