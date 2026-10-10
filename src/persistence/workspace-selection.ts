import { lstatSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

import { isRecord } from '../domain/validation'
import { LEGACY_LAYOUT, layoutForSchemaVersion, V5_LAYOUT, type WorkspaceLayout } from './paths'

export type WorkspaceSelection =
	| Readonly<{ ok: true; layout: WorkspaceLayout }>
	| Readonly<{ ok: false; message: string }>

/**
 * The entry check of `uiux dev`, `uiux migrate`, `uiux access` and the packaged server (owner
 * ruling of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18853316): it reads
 * only the manifest files, so a caller runs it before any lock, server hold, recovery, read or
 * write. A selected directory is refused when
 *
 * - it is an old-layout Workspace's own `.uiux/` directory (the message names the parent);
 * - its `workspace.json` is not a Workspace manifest;
 * - its manifest's `schemaVersion` belongs to the other layout;
 * - it is a `schemaVersion` 5 root without `product-kit.json` (Clause 01a11bb1-8d67-71c5-929f-138afd0c66ec).
 *
 * The old-layout manifest decides when both files exist, as layout detection does. A directory with
 * neither manifest is not refused here: it gets `fallbackVersion`'s layout, and the command reports
 * the missing manifest as before. An old-layout manifest that cannot be read is left to the command
 * too.
 */
export function checkWorkspaceSelection(root: string, fallbackVersion: number): WorkspaceSelection {
	const directory = resolve(root)
	const legacyManifest = join(directory, ...LEGACY_LAYOUT.manifestPath.split('/'))
	if (exists(legacyManifest)) {
		const version = manifestVersion(legacyManifest)
		if (version !== undefined && layoutForSchemaVersion(version) !== LEGACY_LAYOUT)
			return refuse(`${legacyManifest} is a schemaVersion ${version} manifest, whose Workspace root is ${join(directory, LEGACY_LAYOUT.metadataDir)}; select that directory instead.`)
		return { ok: true, layout: LEGACY_LAYOUT }
	}
	const manifest = join(directory, V5_LAYOUT.manifestPath)
	if (exists(manifest)) {
		const version = manifestVersion(manifest)
		if (version === undefined)
			return refuse(`${manifest} is not a UIUX Workspace manifest, so ${directory} is not a Workspace root.`)
		if (layoutForSchemaVersion(version) !== V5_LAYOUT) {
			return refuse(basename(directory) === LEGACY_LAYOUT.metadataDir
				? `${directory} is the metadata directory of an old-layout Workspace (schemaVersion ${version}); select its parent ${dirname(directory)} instead.`
				: `${manifest} is a schemaVersion ${version} manifest, which an old-layout Workspace keeps in ${LEGACY_LAYOUT.manifestPath}; ${directory} is not a Workspace root.`)
		}
		const productKit = join(directory, V5_LAYOUT.productKitPath!)
		if (!isRegularFile(productKit))
			return refuse(`${directory} has a schemaVersion ${version} manifest but no ${V5_LAYOUT.productKitPath}, which such a Workspace requires.`)
		return { ok: true, layout: V5_LAYOUT }
	}
	return { ok: true, layout: layoutForSchemaVersion(fallbackVersion) }
}

function refuse(message: string): WorkspaceSelection {
	return { ok: false, message }
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
