import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'

import { isRecord } from '../domain/validation'
import { V5_LAYOUT, WORKSPACE_DATA_DIRECTORY, type WorkspaceLayout } from './paths'
import { unsupportedSchemaVersionMessage, type WorkspaceSchemaPolicy } from './schema-policy'

/** The directory a Workspace root usually is, and the one discovery looks for. */
const WORKSPACE_DIRECTORY = WORKSPACE_DATA_DIRECTORY.workspaceMeta

/**
 * Why a selected directory is refused, for callers that act on the case rather than the message:
 *
 * - `relocated_parent`: the parent of a Workspace root in its `.uiux/` child (the `.uiux/` child is
 *   the root, and `selectWorkspace` selects it);
 * - `foreign_manifest`: a `workspace.json` that is not a Workspace manifest;
 * - `missing_product_kit`: a root without `product-kit.json`;
 * - `unsupported_schema`: a manifest whose `schemaVersion` is not the current one, older or newer.
 */
export type WorkspaceSelectionRefusalReason =
	| 'relocated_parent'
	| 'foreign_manifest'
	| 'missing_product_kit'
	| 'unsupported_schema'

export type WorkspaceSelection =
	| Readonly<{ ok: true; layout: WorkspaceLayout }>
	| Readonly<{ ok: false; reason: WorkspaceSelectionRefusalReason; message: string }>

/**
 * The entry check for a selected Workspace directory (`--workspace`, a discovered one, or the
 * packaged server's configured root): Clause 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9. It reads only the
 * manifest files, so a caller runs it before any lock, server hold, recovery, read or write.
 *
 * A directory whose `.uiux/workspace.json` exists is the parent of a root, whatever that manifest
 * holds. Otherwise its own `workspace.json` decides: a manifest whose `schemaVersion` is not the
 * policy's current version is refused with the message of Clause
 * 01a14928-275b-74d5-ad43-c82932e39cb3, which also names `workspace.schema_unsupported`. A directory
 * with neither manifest is not refused here, and the command reports the missing manifest.
 */
export function checkWorkspaceSelection(root: string, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion'>): WorkspaceSelection {
	const directory = resolve(root)
	const childManifest = join(directory, WORKSPACE_DIRECTORY, V5_LAYOUT.manifestPath)
	if (exists(childManifest))
		return refuse('relocated_parent', `${directory} is not a Workspace root: its Workspace root is ${join(directory, WORKSPACE_DIRECTORY)}; select that directory instead.`)
	const manifest = join(directory, V5_LAYOUT.manifestPath)
	if (exists(manifest)) {
		const version = manifestVersion(manifest)
		if (version === undefined)
			return refuse('foreign_manifest', `${manifest} is not a UIUX Workspace manifest, so ${directory} is not a Workspace root.`)
		if (version !== policy.currentVersion)
			return refuse('unsupported_schema', `${manifest} is refused (workspace.schema_unsupported): ${unsupportedSchemaVersionMessage(version, policy.currentVersion)}`)
		const productKit = join(directory, V5_LAYOUT.productKitPath)
		if (!isRegularFile(productKit))
			return refuse('missing_product_kit', `${directory} has a schemaVersion ${version} manifest but no ${V5_LAYOUT.productKitPath}, which a Workspace requires.`)
		return { ok: true, layout: V5_LAYOUT }
	}
	return { ok: true, layout: V5_LAYOUT }
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
 *   the parent of a root in its `.uiux/` child, which is then selected.
 * - Without it, discovery (Clause 01a11bb1-9847-751f-a1ba-943ad111a02a) selects the `.uiux/` child of
 *   the nearest directory, from `cwd` upward to the home directory (only `cwd` itself when it is
 *   outside the home directory), that has a `.uiux/workspace.json`, after the trust check of
 *   `untrustedCandidate`.
 *
 * Either way the selected root then gets the entry check (Clause
 * 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9), which refuses a manifest at any `schemaVersion` but the
 * current one. Like the entry check, it reads only directory entries and manifests.
 */
export function selectWorkspace(input: Readonly<{ workspace?: string; cwd: string; discoveryHost?: DiscoveryHost }>, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion'>): SelectedWorkspace {
	if (input.workspace === undefined) return discoverWorkspace(resolve(input.cwd), policy, input.discoveryHost ?? defaultDiscoveryHost())
	const directory = resolve(input.cwd, input.workspace)
	let isDirectory: boolean
	try { isDirectory = statSync(directory).isDirectory() }
	catch { return refuseLocation('not_found', `Workspace root does not exist: ${directory}`) }
	if (!isDirectory) return refuseLocation('not_a_directory', `Workspace root is not a directory: ${directory}`)
	const selection = checkWorkspaceSelection(directory, policy)
	if (!selection.ok && selection.reason === 'relocated_parent') {
		const child = join(directory, WORKSPACE_DIRECTORY)
		return withSelection(child, checkWorkspaceSelection(child, policy), false)
	}
	return withSelection(directory, selection, false)
}

/**
 * The walk of discovery, bounded by the trust boundary of owner ruling 1 of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730 and the owner ruling
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18871377 (Clauses
 * 01a11bb1-9847-751f-a1ba-943ad111a02a and 01a12d48-2ba3-79f2-884f-9d90abec0ac2), on every platform:
 *
 * - From a current directory inside the home directory (or the home directory itself), the walk
 *   goes upward and examines the home directory but nothing above it.
 * - From a current directory outside the home directory, only that directory is examined.
 * - Both paths are compared as real paths.
 * - A `.uiux/workspace.json` that cannot be inspected (`EACCES`, `EPERM`, a link loop) makes its
 *   directory no candidate, and the walk goes on upward: an unreadable `.uiux/` is typically
 *   another user's, and every directory further up gets the same trust check.
 * - The first candidate found is selected or refused; a refused candidate never lets the walk go on.
 */
function discoverWorkspace(cwd: string, policy: Pick<WorkspaceSchemaPolicy, 'currentVersion'>, host: DiscoveryHost): SelectedWorkspace {
	const start = realOrResolved(cwd)
	const home = realOrResolved(host.homeDirectory)
	const insideHome = start === home || isProperAncestor(home, start)
	const last = insideHome ? home : start
	const candidateManifest = `${WORKSPACE_DIRECTORY}/${V5_LAYOUT.manifestPath}`
	for (let directory = start; ; directory = dirname(directory)) {
		const root = join(directory, WORKSPACE_DIRECTORY)
		const manifest = join(root, V5_LAYOUT.manifestPath)
		if (inspect(manifest) !== undefined) {
			const untrusted = untrustedCandidate(directory, host)
			if (untrusted !== undefined)
				return refuseLocation('untrusted_candidate', `Discovery found ${manifest} but does not select it: ${untrusted}. Pass --workspace <dir> to select a Workspace explicitly.`)
			return withSelection(root, checkWorkspaceSelection(root, policy), true)
		}
		if (directory === last || dirname(directory) === directory) break
	}
	const searched = insideHome
		? `no directory from ${start} upward has a ${candidateManifest} (discovery does not search above the home directory ${home})`
		: `${start} has no ${candidateManifest}, and discovery outside the home directory ${home} examines only the current directory`
	return refuseLocation('not_discovered', `No UIUX Workspace found: ${searched}. Pass --workspace <dir>, or create one with uiux init.`)
}

/**
 * Why discovery refuses the candidate `.uiux/` in `directory`, or `undefined` when it may be used
 * (owner ruling 1 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730).
 * Every entry is read with `lstat`, so no symbolic link is followed:
 *
 * - `.uiux` must be a real directory, not a symbolic link, and its manifest not a symbolic link;
 * - `.uiux` and its `workspace.json` must be owned by the current user, and `.uiux` must not be
 *   writable by others (`o+w`);
 * - `directory` must not be writable by others (`o+w`) unless the current user owns it, as with
 *   `/tmp`.
 *
 * Where the platform has no user id (`process.getuid` is absent, as on Windows), the ownership and
 * writability checks are skipped; the home-directory bound and the symbolic link checks remain.
 *
 * The checks read paths, not open directory handles (Node has no `openat`), so someone who can
 * write an ancestor directory could swap the directory after the check; that residual risk is
 * accepted, as with Git's `safe.directory`.
 */
function untrustedCandidate(directory: string, host: DiscoveryHost): string | undefined {
	const metadata = join(directory, WORKSPACE_DIRECTORY)
	const manifest = join(metadata, V5_LAYOUT.manifestPath)
	const metadataEntry = host.lstat(metadata)
	if (metadataEntry.isSymbolicLink() || !metadataEntry.isDirectory()) return `${metadata} is a symbolic link or not a directory`
	const manifestEntry = host.lstat(manifest)
	if (manifestEntry.isSymbolicLink()) return `${manifest} is a symbolic link`
	const uid = host.userId
	if (uid === undefined) return undefined
	if (metadataEntry.uid !== uid) return `${metadata} is not owned by the current user`
	if ((metadataEntry.mode & 0o002) !== 0) return `${metadata} is writable by other users`
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
