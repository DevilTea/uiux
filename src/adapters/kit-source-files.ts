import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { isSafeRelativePath } from '../domain/validation'
import type { KitProject } from './kit-registry'

/** The kit's source directory, relative to `kit/` (Clause 01a11bb1-8a44-793a-8306-21fea501acad). */
const KIT_SOURCE_DIRECTORY = 'src'

/**
 * The bytes of the kit file `file` (relative to `kit/`, under `kit/src/`) for copying a component
 * out, or `undefined` when it is not a regular file reached without a symbolic link: missing, a
 * directory, a link, below a linked directory, or outside `kit/src/` are one answer, so nothing
 * about what lies elsewhere is read or told. `kit/` and `kit/src/` themselves must be real
 * directories (`locateKitProject`). The CLI copy-out and the MCP kit source Tools share it.
 */
export async function readKitSourceFile(kit: KitProject, file: string): Promise<Uint8Array | undefined> {
	if (!kit.directory || !kit.sourceDirectory || !isSafeRelativePath(file)) return undefined
	const segments = file.split('/')
	if (segments[0] !== KIT_SOURCE_DIRECTORY || segments.length < 2) return undefined
	let path = kit.sourceDirectory
	for (const [index, segment] of segments.slice(1).entries()) {
		path = join(path, segment)
		const info = await lstat(path).catch(() => undefined)
		const last = index === segments.length - 2
		if (!info || info.isSymbolicLink() || (last ? !info.isFile() : !info.isDirectory())) return undefined
	}
	return readFile(path).catch(() => undefined)
}
