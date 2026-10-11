import { lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { isRecord } from '../domain/validation'
import { LEGACY_LAYOUT, layoutForSchemaVersion, V5_LAYOUT, type WorkspaceLayout } from './paths'
import type { WorkspaceSchemaPolicy } from './schema-policy'

/**
 * Why a selected directory is refused, for callers that act on the case rather than the message:
 *
 * - `legacy_metadata_dir`: an old-layout Workspace's own `.uiux/` directory (its parent is the root);
 * - `relocated_parent`: the parent of a `schemaVersion` 5 root (the `.uiux/` child is the root);
 * - `foreign_manifest`: a `workspace.json` that is not a Workspace manifest;
 * - `version_layout_mismatch`: a manifest whose `schemaVersion` belongs to the other layout;
 * - `missing_product_kit`: a `schemaVersion` 5 root without `product-kit.json`;
 * - `unknown_schema`: a manifest in the old layout's place whose `schemaVersion` this build does not
 *   recognize.
 */
export type WorkspaceSelectionRefusalReason =
	| 'legacy_metadata_dir'
	| 'relocated_parent'
	| 'foreign_manifest'
	| 'version_layout_mismatch'
	| 'missing_product_kit'
	| 'unknown_schema'

export type WorkspaceSelection =
	| Readonly<{ ok: true; layout: WorkspaceLayout }>
	| Readonly<{ ok: false; reason: WorkspaceSelectionRefusalReason; message: string }>

/**
 * The entry check for an explicitly selected Workspace directory (`--workspace`, or the packaged
 * server's configured root): Clause 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9 and the owner rulings of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18853316 and
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18857361. It reads only the
 * manifest files, so a caller runs it before any lock, server hold, recovery, read or write.
 * Discovery, which maps a found old-layout `.uiux/` to its parent, runs before this check.
 *
 * The old-layout manifest decides when both files exist, as layout detection does. A directory with
 * neither manifest is not refused here: it gets the policy's current layout, and the command reports
 * the missing manifest as before. An old-layout manifest that cannot be read is left to the command
 * too. The parent or the `.uiux/` child is suggested only for a `schemaVersion` the policy recognizes.
 */
export function checkWorkspaceSelection(root: string, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion' | 'recognizedVersions'>): WorkspaceSelection {
	const directory = resolve(root)
	const recognized = (version: number) => policy.recognizedVersions.includes(version)
	const legacyManifest = join(directory, ...LEGACY_LAYOUT.manifestPath.split('/'))
	if (exists(legacyManifest)) {
		const version = manifestVersion(legacyManifest)
		if (version !== undefined && layoutForSchemaVersion(version) !== LEGACY_LAYOUT) {
			return recognized(version)
				? refuse('relocated_parent', `${legacyManifest} is a schemaVersion ${version} manifest, whose Workspace root is ${join(directory, LEGACY_LAYOUT.metadataDir)}; select that directory instead.`)
				: refuse('unknown_schema', `${legacyManifest} has schemaVersion ${version}, which this UIUX build does not support.`)
		}
		return { ok: true, layout: LEGACY_LAYOUT }
	}
	const manifest = join(directory, V5_LAYOUT.manifestPath)
	if (exists(manifest)) {
		const version = manifestVersion(manifest)
		if (version === undefined)
			return refuse('foreign_manifest', `${manifest} is not a UIUX Workspace manifest, so ${directory} is not a Workspace root.`)
		if (layoutForSchemaVersion(version) !== V5_LAYOUT) {
			if (!recognized(version))
				return refuse('unknown_schema', `${manifest} has schemaVersion ${version}, which this UIUX build does not support.`)
			return basename(directory) === LEGACY_LAYOUT.metadataDir
				? refuse('legacy_metadata_dir', `${directory} is the metadata directory of an old-layout Workspace (schemaVersion ${version}); select its parent ${dirname(directory)} instead.`)
				: refuse('version_layout_mismatch', `${manifest} is a schemaVersion ${version} manifest, which an old-layout Workspace keeps in ${LEGACY_LAYOUT.manifestPath}; ${directory} is not a Workspace root.`)
		}
		const productKit = join(directory, V5_LAYOUT.productKitPath!)
		if (!isRegularFile(productKit))
			return refuse('missing_product_kit', `${directory} has a schemaVersion ${version} manifest but no ${V5_LAYOUT.productKitPath}, which such a Workspace requires.`)
		return { ok: true, layout: V5_LAYOUT }
	}
	return { ok: true, layout: layoutForSchemaVersion(policy.currentVersion) }
}

function refuse(reason: WorkspaceSelectionRefusalReason, message: string): WorkspaceSelection {
	return { ok: false, reason, message }
}

/** The manifest's positive integer `schemaVersion`, or `undefined` when the file is not a manifest. */
function manifestVersion(path: string): number | undefined {
	let value: unknown
	try { value = JSON.parse(readFileSync(path, 'utf8')) as unknown }
	catch { return undefined }
	const version = isRecord(value) ? value.schemaVersion : undefined
	return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : undefined
}

function exists(path: string): boolean {
	try {
		lstatSync(path)
		return true
	}
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR') return false
		throw error
	}
}

function isRegularFile(path: string): boolean {
	try { return lstatSync(path).isFile() }
	catch { return false }
}
