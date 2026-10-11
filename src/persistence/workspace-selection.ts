import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { isRecord } from '../domain/validation'
import { LEGACY_LAYOUT, layoutForSchemaVersion, V5_LAYOUT, WORKSPACE_DATA_DIRECTORY, type WorkspaceLayout } from './paths'
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

/** Why no Workspace directory could be selected at all, before the entry check. */
export type WorkspaceLocationRefusalReason = 'not_found' | 'not_a_directory' | 'not_discovered' | 'untrusted_candidate'

/** The directory entry facts discovery's trust check reads, from `lstat` (no symbolic link is followed). */
export type DiscoveryEntry = Readonly<{ uid: number; mode: number; isDirectory: () => boolean; isSymbolicLink: () => boolean }>

/**
 * What discovery reads from the host: the home directory where the upward walk ends, the current
 * user's id (`undefined` where the platform has none, such as Windows), and `lstat`. Tests replace
 * it to simulate entries owned by another user, which they cannot create.
 */
export type DiscoveryHost = Readonly<{
	homeDirectory: string
	userId: number | undefined
	lstat: (path: string) => DiscoveryEntry
}>

function defaultDiscoveryHost(): DiscoveryHost {
	return { homeDirectory: homedir(), userId: process.getuid?.(), lstat: path => lstatSync(path) }
}

export type SelectedWorkspace =
	| Readonly<{ ok: true; root: string; layout: WorkspaceLayout; discovered: boolean }>
	| Readonly<{ ok: false; reason: WorkspaceSelectionRefusalReason | WorkspaceLocationRefusalReason; message: string }>

/**
 * Selects the Workspace a command acts on, then runs the entry check on it.
 *
 * - With `--workspace <dir>` (Clause 01a1144e-5584-7101-98c0-dc3cbadbacdf), `<dir>` is the root, or
 *   the parent of a `schemaVersion` 5 root in its `.uiux/` child, which is then selected. An
 *   explicitly selected old-layout `.uiux/` directory is refused, naming its parent (Clause
 *   01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9).
 * - Without it, discovery (Clause 01a11bb1-9847-751f-a1ba-943ad111a02a) selects the `.uiux/` child of
 *   the nearest directory, from `cwd` upward to the home directory, that has a
 *   `.uiux/workspace.json`, after the trust check of `untrustedCandidate`; when that manifest's
 *   `schemaVersion` is below 5, the `.uiux/` directory is an old-layout metadata directory and its
 *   parent is selected (Clause 01a11bb1-98a9-7881-8fa0-ee1e355a3a9a). The mapping comes before the
 *   entry check (owner ruling
 *   https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18857361).
 *
 * Like the entry check, it reads only directory entries and manifests.
 */
export function selectWorkspace(input: Readonly<{ workspace?: string; cwd: string; discoveryHost?: DiscoveryHost }>, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion' | 'recognizedVersions'>): SelectedWorkspace {
	if (input.workspace === undefined) return discoverWorkspace(resolve(input.cwd), policy, input.discoveryHost ?? defaultDiscoveryHost())
	const directory = resolve(input.cwd, input.workspace)
	let isDirectory: boolean
	try { isDirectory = statSync(directory).isDirectory() }
	catch { return refuseLocation('not_found', `Workspace root does not exist: ${directory}`) }
	if (!isDirectory) return refuseLocation('not_a_directory', `Workspace root is not a directory: ${directory}`)
	const selection = checkWorkspaceSelection(directory, policy)
	if (!selection.ok && selection.reason === 'relocated_parent') {
		const child = join(directory, LEGACY_LAYOUT.metadataDir)
		return withSelection(child, checkWorkspaceSelection(child, policy), false)
	}
	return withSelection(directory, selection, false)
}

/**
 * The upward walk of discovery, bounded by the trust boundary of owner ruling 1 of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730 (Clauses
 * 01a11bb1-9847-751f-a1ba-943ad111a02a and the trust Clause it names):
 *
 * - The walk examines the home directory itself but nothing above it: a directory that is a proper
 *   ancestor of the home directory is never examined, so a walk that starts there or crosses the
 *   home directory ends without a Workspace. Both paths are compared as real paths.
 * - A `.uiux/workspace.json` that cannot be inspected (`EACCES`, `EPERM`, a link loop) makes its
 *   directory no candidate, and the walk goes on upward: an unreadable `.uiux/` is typically
 *   another user's, and every directory further up gets the same trust check.
 * - The first candidate found is selected or refused; a refused candidate never lets the walk go on.
 */
function discoverWorkspace(cwd: string, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion' | 'recognizedVersions'>, host: DiscoveryHost): SelectedWorkspace {
	const start = realOrResolved(cwd)
	const home = realOrResolved(host.homeDirectory)
	let stoppedAtHome = false
	for (let directory = start; ; directory = dirname(directory)) {
		if (isProperAncestor(directory, home)) {
			stoppedAtHome = true
			break
		}
		const metadata = join(directory, LEGACY_LAYOUT.metadataDir)
		const manifest = join(metadata, V5_LAYOUT.manifestPath)
		if (inspect(manifest) !== undefined) {
			const untrusted = untrustedCandidate(directory, host)
			if (untrusted !== undefined)
				return refuseLocation('untrusted_candidate', `Discovery found ${manifest} but does not select it: ${untrusted}. Pass --workspace <dir> to select a Workspace explicitly.`)
			const version = manifestVersion(manifest)
			const root = version !== undefined && layoutForSchemaVersion(version) === LEGACY_LAYOUT ? directory : metadata
			return withSelection(root, checkWorkspaceSelection(root, policy), true)
		}
		if (directory === home) {
			stoppedAtHome = true
			break
		}
		if (dirname(directory) === directory) break
	}
	const bound = stoppedAtHome ? ` (discovery does not search above the home directory ${home})` : ''
	return refuseLocation('not_discovered', `No UIUX Workspace found: no directory from ${start} upward has a ${LEGACY_LAYOUT.manifestPath}${bound}. Pass --workspace <dir>, or create one with uiux init.`)
}

/**
 * Why discovery refuses the candidate `.uiux/` in `directory`, or `undefined` when it may be used
 * (owner ruling 1 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730).
 * Every entry is read with `lstat`, so no symbolic link is followed:
 *
 * - `.uiux` must be a real directory, not a symbolic link, and its manifest not a symbolic link;
 * - `.uiux` and its `workspace.json` must be owned by the current user;
 * - `directory` must not be writable by others (`o+w`) unless the current user owns it, as with
 *   `/tmp`.
 *
 * Where the platform has no user id (`process.getuid` is absent, as on Windows), the ownership and
 * writability checks are skipped; the home-directory bound and the symbolic link checks remain.
 */
function untrustedCandidate(directory: string, host: DiscoveryHost): string | undefined {
	const metadata = join(directory, LEGACY_LAYOUT.metadataDir)
	const manifest = join(metadata, V5_LAYOUT.manifestPath)
	const metadataEntry = host.lstat(metadata)
	if (metadataEntry.isSymbolicLink() || !metadataEntry.isDirectory()) return `${metadata} is a symbolic link or not a directory`
	const manifestEntry = host.lstat(manifest)
	if (manifestEntry.isSymbolicLink()) return `${manifest} is a symbolic link`
	const uid = host.userId
	if (uid === undefined) return undefined
	if (metadataEntry.uid !== uid) return `${metadata} is not owned by the current user`
	if (manifestEntry.uid !== uid) return `${manifest} is not owned by the current user`
	const parent = host.lstat(directory)
	if ((parent.mode & 0o002) !== 0 && parent.uid !== uid) return `${directory} is writable by other users and not owned by the current user`
	return undefined
}

/** True when `directory` is a proper ancestor of `path`, both absolute and normalized. */
function isProperAncestor(directory: string, path: string): boolean {
	if (directory === path) return false
	const prefix = directory.endsWith(sep) ? directory : `${directory}${sep}`
	return path.startsWith(prefix)
}

function realOrResolved(path: string): string {
	try { return realpathSync.native(path) }
	catch { return resolve(path) }
}

/** The `lstat` of `path`, or `undefined` when it is missing or cannot be inspected. */
function inspect(path: string): ReturnType<typeof lstatSync> | undefined {
	try { return lstatSync(path) }
	catch (error) {
		const code = (error as NodeJS.ErrnoException | undefined)?.code
		if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES' || code === 'EPERM' || code === 'ELOOP' || code === 'ENAMETOOLONG') return undefined
		throw error
	}
}

function withSelection(root: string, selection: WorkspaceSelection, discovered: boolean): SelectedWorkspace {
	return selection.ok ? { ok: true, root, layout: selection.layout, discovered } : selection
}

function refuseLocation(reason: WorkspaceLocationRefusalReason, message: string): SelectedWorkspace {
	return { ok: false, reason, message }
}

/** The old layout's data directories, which `uiux.v4-to-v5` moves into `.uiux/`. */
const OLD_LAYOUT_DATA_DIRECTORIES = Object.freeze(Object.values(WORKSPACE_DATA_DIRECTORY).filter(directory => directory !== LEGACY_LAYOUT.metadataDir))

/**
 * The one exception to the entry check: `uiux access copy --from <old>` right after `uiux migrate`
 * relocated `<old>` into `<old>/.uiux/` (owner ruling 2 of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627, Rule
 * 01a12626-5a0c-7c1a-942f-666101981e29), where `--from` names the old root literally, as the key of
 * its roster and host history. True only when every one of these holds:
 *
 * - the entry check refuses `source` as `relocated_parent`, so `source/.uiux/workspace.json` has a
 *   `schemaVersion` of 5 or later that the policy recognizes;
 * - `source/.uiux` is a real directory (not a symbolic link) that passes the entry check as a
 *   `schemaVersion` 5 root;
 * - that directory is the copy's target root (`targetRealRoot`, a real path), by real path;
 * - no old-layout data directory is left in `source`, which a finished relocation never leaves.
 *
 * It reads only the manifests and directory entries, before any lock or store is touched.
 */
export function isRelocatedSourceOf(source: string, targetRealRoot: string, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion' | 'recognizedVersions'>): boolean {
	const directory = resolve(source)
	const selection = checkWorkspaceSelection(directory, policy)
	if (selection.ok || selection.reason !== 'relocated_parent') return false
	const relocated = join(directory, LEGACY_LAYOUT.metadataDir)
	// A relocation leaves a real directory there, never a symbolic link to some other root.
	try { if (!lstatSync(relocated).isDirectory()) return false }
	catch { return false }
	const relocatedSelection = checkWorkspaceSelection(relocated, policy)
	if (!relocatedSelection.ok || relocatedSelection.layout !== V5_LAYOUT) return false
	let realRelocated: string
	try { realRelocated = realpathSync.native(relocated) }
	catch { return false }
	if (realRelocated !== targetRealRoot) return false
	return OLD_LAYOUT_DATA_DIRECTORIES.every(name => !exists(join(directory, name)))
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
