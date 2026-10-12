import { lstat, readFile } from 'node:fs/promises'

import { BUILT_IN_ACCESS_PRESETS } from '../../application/access/keys'
import type { LabelPreset } from '../../application/access/labels'
import { ACCESS_PRESETS_SCHEMA_VERSION, labelPresetsOf } from '../../domain/access-presets/schema'
import { isRecord } from '../../domain/validation'
import { detectWorkspaceLayout, resolveWorkspacePath, type WorkspaceLayout } from '../../persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../../product/workspace-schema'

/**
 * The Access presets that label members and that `--preset` and the Members page apply, read from
 * the Workspace at this moment (Rules 01a11c09-c724-7a1b-9505-3146b5b2b241 and
 * 01a11c09-ccc6-705c-96c6-9f4ba7a2ad58):
 *
 * - below `schemaVersion` 6, where the Workspace has no presets file, the built-in presets (Rule
 *   01a11c09-cb79-744e-bbf6-ec38d6f159ba);
 * - from 6, the presets of `access-presets.json` in file order, as far as they can be read: a file
 *   that breaks the rules on disk still labels by the first match in file order (Rule
 *   01a11c33-265e-71f6-939f-4d0d3754a16f), and a preset holding a key unknown to this version
 *   labels nobody (`memberLabel`). A presets file that is missing, unreadable, not JSON or a symbolic
 *   link gives no presets: every member is then Custom.
 *
 * Labels are computed whenever the server or the CLI answers and never stored (Rule
 * 01a11c09-c9be-736b-95a4-0b39d6f64cf0), so a presets edit changes labels only, never keys (Rule
 * 01a11c09-ca2d-7b0e-b428-e2d66f5252dd). The files are read without the persistence lock: each is
 * replaced atomically, so a read sees one whole version of it.
 */
export async function readWorkspaceAccessPresets(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<readonly LabelPreset[]> {
	const layout = givenLayout ?? await detectWorkspaceLayout(workspaceRoot, CURRENT_WORKSPACE_SCHEMA_VERSION)
	if (!layout.accessPresetsPath) return BUILT_IN_ACCESS_PRESETS
	const manifest = await readJson(workspaceRoot, layout.manifestPath)
	const version = isRecord(manifest) && Number.isInteger(manifest.schemaVersion) ? manifest.schemaVersion as number : undefined
	if (version === undefined || version < ACCESS_PRESETS_SCHEMA_VERSION) return BUILT_IN_ACCESS_PRESETS
	return labelPresetsOf(await readJson(workspaceRoot, layout.accessPresetsPath))
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
