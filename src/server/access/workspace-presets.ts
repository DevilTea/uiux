import { lstat, readFile } from 'node:fs/promises'

import type { LabelPreset } from '../../application/access/labels'
import { labelPresetsOf } from '../../domain/access-presets/schema'
import { resolveWorkspacePath, V5_LAYOUT, type WorkspaceLayout } from '../../persistence/paths'

/**
 * The Access presets that label members and that `--preset` and the Members page apply, read from
 * the Workspace at this moment (Rules 01a11c09-c724-7a1b-9505-3146b5b2b241 and
 * 01a11c09-ccc6-705c-96c6-9f4ba7a2ad58): the presets of `access-presets.json` in file order, as far
 * as they can be read. A file that breaks the rules on disk still labels by the first match in file
 * order (Rule 01a11c33-265e-71f6-939f-4d0d3754a16f), and a preset holding a key unknown to this
 * version labels nobody (`memberLabel`). A presets file that is missing, unreadable, not JSON or a
 * symbolic link gives no presets: every member is then Custom.
 *
 * Labels are computed whenever the server or the CLI answers and never stored (Rule
 * 01a11c09-c9be-736b-95a4-0b39d6f64cf0), so a presets edit changes labels only, never keys (Rule
 * 01a11c09-ca2d-7b0e-b428-e2d66f5252dd). The files are read without the persistence lock: each is
 * replaced atomically, so a read sees one whole version of it.
 */
export async function readWorkspaceAccessPresets(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<readonly LabelPreset[]> {
	const layout = givenLayout ?? V5_LAYOUT
	return labelPresetsOf(await readJson(workspaceRoot, layout.accessPresetsPath))
}

/**
 * {@link readWorkspaceAccessPresets} for a server, which labels every authenticated request: it
 * stats the presets file, and reads and parses it again only when it
 * changed (another inode, size, modification or change time, in nanoseconds), so a pulled commit
 * or a presets write still changes the next label.
 */
export function createWorkspaceAccessPresetsReader(workspaceRoot: string, layout: WorkspaceLayout): () => Promise<readonly LabelPreset[]> {
	let cached: Readonly<{ stamp: string; presets: Promise<readonly LabelPreset[]> }> | undefined
	return async () => {
		const stamp = await fileStamp(workspaceRoot, layout.accessPresetsPath)
		if (cached?.stamp !== stamp) {
			const presets = readWorkspaceAccessPresets(workspaceRoot, layout)
			cached = { stamp, presets }
			// A failed read is not kept.
			presets.catch(() => { if (cached?.presets === presets) cached = undefined })
		}
		return cached.presets
	}
}

/** What identifies a version of a Workspace file without reading it, or `-` when it cannot be examined. */
async function fileStamp(workspaceRoot: string, relativePath: string): Promise<string> {
	try {
		const stats = await lstat(resolveWorkspacePath(workspaceRoot, relativePath), { bigint: true })
		return `${stats.ino}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}:${stats.isFile() ? 'f' : 'o'}`
	}
	catch {
		return '-'
	}
}

/** A Workspace file's JSON, or `undefined` when it is missing, a symbolic link, unreadable or not JSON. */
async function readJson(workspaceRoot: string, relativePath: string): Promise<unknown> {
	try {
		const path = resolveWorkspacePath(workspaceRoot, relativePath)
		if (!(await lstat(path)).isFile()) return undefined
		return JSON.parse(await readFile(path, 'utf8')) as unknown
	}
	catch {
		return undefined
	}
}
