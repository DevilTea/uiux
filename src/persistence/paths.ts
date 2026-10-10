import { resolve, sep } from 'node:path'

import { artifactStoreShardPath } from '../domain/artifacts/schema'
import { isCanonicalLocaleFilename, isCanonicalLocaleTag, isFullUuid, isSafeRelativePath, isSha256Digest } from '../domain/validation'
import { PersistenceError } from './errors'

/**
 * The top-level Workspace directories that hold authored, principal-writable canonical data.
 * This single source of truth is shared by the persistence path helpers below and by the Adapter
 * resolver (`src/adapters/resolution.ts`), which refuses any Adapter specifier — `./`-relative or
 * bare — that resolves inside one of them, so an Editor or Agent cannot select uploaded data as
 * executable Adapter code. `adapters/` is intentionally absent: it is code, not authored data, and
 * hosts legitimate `./adapters/*` local Adapters.
 */
export const WORKSPACE_DATA_DIRECTORY = Object.freeze({
	workspaceMeta: '.uiux',
	assets: 'assets',
	views: 'views',
	flows: 'flows',
	reviews: 'reviews',
	locales: 'i18n',
} as const)

export const CANONICAL_WORKSPACE_DATA_DIRECTORIES: readonly string[] = Object.freeze(
	Object.values(WORKSPACE_DATA_DIRECTORY),
)

export const WORKSPACE_MANIFEST_PATH = `${WORKSPACE_DATA_DIRECTORY.workspaceMeta}/workspace.json` as const

export const WORKSPACE_ARTIFACTS_DIRECTORY = `${WORKSPACE_DATA_DIRECTORY.workspaceMeta}/artifacts` as const

export const WORKSPACE_CHECKPOINTS_DIRECTORY = `${WORKSPACE_DATA_DIRECTORY.workspaceMeta}/history/checkpoints` as const

const VIEW_FILE_SUFFIX = '.view.json'
const FLOW_FILE_SUFFIX = '.flow.json'
/** The suffix of a Review thread file in `reviews/`. */
export const REVIEW_FILE_SUFFIX = '.review.json'
const ASSET_METADATA_FILENAME = 'asset.json'

/** The identity of one versioned resource: Version history records Contract 01a11a5e-1fc4-7bf0-a402-61c345f454c2. */
export type VersionedResourceIdentity = Readonly<{ kind: string; key: string }>

/**
 * Where a Workspace keeps its files: the one seam every path that depends on the Workspace layout
 * goes through (the manifest, the derived-artifact store, Checkpoints, the transaction journal,
 * the persistence lock, the server hold, and the versioned files history reads and writes).
 * Callers ask the layout instead of building path literals, so a later layout (Part 14,
 * `schemaVersion` 5) can be added beside this one: persistence picks the current Workspace's
 * layout, and history reads each record with `layoutForSchemaVersion` of the schema it was
 * recorded under.
 *
 * Every path is Workspace-relative and `/`-separated.
 *
 * - `metadataDir` is the directory that holds the manifest and the runtime files; a writer makes
 *   sure it exists before taking the lock.
 * - `versionedRoots` lists the versioned manifest file and the versioned directories (with a
 *   trailing `/`), per Clause 01a11a5e-1eba-78ae-a204-52e286a95ddb.
 * - `excluded` lists the directories next to them that are never versioned (`reviews/` and the
 *   reserved `.uiux/` runtime directory); an exact `versionedRoots` file inside one of them, the
 *   manifest, stays versioned.
 * - `classifyVersionedPath` returns the resource a canonical versioned file belongs to, or
 *   `undefined` for every other path, including excluded and non-canonical ones.
 */
export type WorkspaceLayout = Readonly<{
	metadataDir: string
	manifestPath: string
	artifactsDir: string
	checkpointsDir: string
	transactionsDir: string
	lockPath: string
	serverHoldPath: string
	versionedRoots: readonly string[]
	excluded: readonly string[]
	/** A runtime file directly inside `metadataDir` (lock candidates, the server hold's temporary file). */
	metadataFilePath(filename: string): string
	checkpointRelativePath(id: string): string
	artifactRelativePath(identity: string): string
	classifyVersionedPath(path: string): VersionedResourceIdentity | undefined
}>

const LEGACY_METADATA_DIRECTORY = WORKSPACE_DATA_DIRECTORY.workspaceMeta

/** The `schemaVersion` 1–4 layout: authored directories at the Workspace root, the manifest and runtime files under `.uiux/`. */
export const LEGACY_LAYOUT: WorkspaceLayout = Object.freeze({
	metadataDir: LEGACY_METADATA_DIRECTORY,
	manifestPath: WORKSPACE_MANIFEST_PATH,
	artifactsDir: WORKSPACE_ARTIFACTS_DIRECTORY,
	checkpointsDir: WORKSPACE_CHECKPOINTS_DIRECTORY,
	transactionsDir: `${LEGACY_METADATA_DIRECTORY}/.transactions`,
	lockPath: `${LEGACY_METADATA_DIRECTORY}/.persistence.lock`,
	serverHoldPath: `${LEGACY_METADATA_DIRECTORY}/.server-hold.json`,
	versionedRoots: Object.freeze([
		WORKSPACE_MANIFEST_PATH,
		`${WORKSPACE_DATA_DIRECTORY.views}/`,
		`${WORKSPACE_DATA_DIRECTORY.flows}/`,
		`${WORKSPACE_DATA_DIRECTORY.locales}/`,
		`${WORKSPACE_DATA_DIRECTORY.assets}/`,
	]),
	excluded: Object.freeze([
		`${WORKSPACE_DATA_DIRECTORY.reviews}/`,
		`${LEGACY_METADATA_DIRECTORY}/`,
	]),
	metadataFilePath(filename: string): string {
		return `${LEGACY_METADATA_DIRECTORY}/${filename}`
	},
	checkpointRelativePath(id: string): string {
		assertUuidIdentity(id, 'Checkpoint')
		return `${WORKSPACE_CHECKPOINTS_DIRECTORY}/${id}.json`
	},
	artifactRelativePath(identity: string): string {
		return `${WORKSPACE_ARTIFACTS_DIRECTORY}/${artifactShardRelativePath(identity)}`
	},
	classifyVersionedPath: classifyLegacyVersionedPath,
})

/**
 * Each layout with the first Workspace `schemaVersion` that uses it, oldest first. A layout holds
 * until the next entry's version; the `schemaVersion` 5 layout (Part 14) is appended here.
 */
const LAYOUTS_BY_SCHEMA_VERSION: readonly Readonly<{ fromVersion: number; layout: WorkspaceLayout }>[] = Object.freeze([
	Object.freeze({ fromVersion: 1, layout: LEGACY_LAYOUT }),
])

/**
 * The layout of files recorded under Workspace `schemaVersion` `version` (a history record's
 * `workspaceSchemaVersion`, or a migration step's version). A version below the first entry, or
 * one that is not a number, falls back to the legacy layout; whether such a version is usable at
 * all is the schema policy's decision, not the layout's.
 */
export function layoutForSchemaVersion(version: number): WorkspaceLayout {
	let selected = LEGACY_LAYOUT
	for (const entry of LAYOUTS_BY_SCHEMA_VERSION)
		if (version >= entry.fromVersion) selected = entry.layout
	return selected
}

function classifyLegacyVersionedPath(path: string): VersionedResourceIdentity | undefined {
	if (!isSafeRelativePath(path)) return undefined
	if (path === WORKSPACE_MANIFEST_PATH) return { kind: 'workspace', key: 'workspace' }
	const segments = path.split('/')
	const [directory, name] = segments
	if (segments.length === 2 && directory === WORKSPACE_DATA_DIRECTORY.views)
		return uuidFileIdentity('view', name!, VIEW_FILE_SUFFIX)
	if (segments.length === 2 && directory === WORKSPACE_DATA_DIRECTORY.flows)
		return uuidFileIdentity('flow', name!, FLOW_FILE_SUFFIX)
	if (segments.length === 2 && directory === WORKSPACE_DATA_DIRECTORY.locales && isCanonicalLocaleFilename(name))
		return { kind: 'locale', key: name.slice(0, -'.json'.length) }
	if (segments.length === 3 && directory === WORKSPACE_DATA_DIRECTORY.assets && isFullUuid(name)
		&& (segments[2] === ASSET_METADATA_FILENAME || isSafeAssetContentFilename(segments[2])))
		return { kind: 'asset', key: name }
	return undefined
}

function uuidFileIdentity(kind: string, filename: string, suffix: string): VersionedResourceIdentity | undefined {
	if (!filename.endsWith(suffix)) return undefined
	const key = filename.slice(0, -suffix.length)
	return isFullUuid(key) ? { kind, key } : undefined
}

/** The legacy layout's manifest path; code that holds a layout reads `layout.manifestPath` instead. */
export function workspaceRelativePath(): typeof WORKSPACE_MANIFEST_PATH {
	return WORKSPACE_MANIFEST_PATH
}

export function viewRelativePath(id: string): string {
	assertUuidIdentity(id, 'View')
	return `${WORKSPACE_DATA_DIRECTORY.views}/${id}${VIEW_FILE_SUFFIX}`
}

export function flowRelativePath(id: string): string {
	assertUuidIdentity(id, 'Flow')
	return `${WORKSPACE_DATA_DIRECTORY.flows}/${id}${FLOW_FILE_SUFFIX}`
}

export function reviewRelativePath(id: string): string {
	assertUuidIdentity(id, 'Review')
	return `${WORKSPACE_DATA_DIRECTORY.reviews}/${id}${REVIEW_FILE_SUFFIX}`
}

export function localeRelativePath(locale: string): string {
	if (!isCanonicalLocaleTag(locale))
		throw invalidIdentity('Locale identity must already be a canonical BCP 47 tag.')
	return `${WORKSPACE_DATA_DIRECTORY.locales}/${locale}.json`
}

export function assetDirectoryRelativePath(id: string): string {
	assertUuidIdentity(id, 'Asset')
	return `${WORKSPACE_DATA_DIRECTORY.assets}/${id}`
}

export function assetMetadataRelativePath(id: string): string {
	return `${assetDirectoryRelativePath(id)}/${ASSET_METADATA_FILENAME}`
}

/** The legacy layout's artifact path; code that holds a layout calls `layout.artifactRelativePath` instead. */
export function artifactRelativePath(identity: string): string {
	return LEGACY_LAYOUT.artifactRelativePath(identity)
}

/** An artifact's place inside the artifact directory: `sha256/<first two hex>/<hex>`, the same in every layout. */
function artifactShardRelativePath(identity: string): string {
	if (!isSha256Digest(identity))
		throw invalidIdentity('Artifact identity must be sha256:<64 lowercase hexadecimal characters>.')
	return artifactStoreShardPath(identity)
}

/** Resolve only already-derived relative paths, rejecting traversal before touching the filesystem. */
export function resolveWorkspacePath(root: string, relativePath: string): string {
	if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.includes('\\') || relativePath.includes('\0'))
		throw new PersistenceError('persistence.path_rejected', 'Workspace path is not a safe relative path.')
	const segments = relativePath.split('/')
	if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'))
		throw new PersistenceError('persistence.path_rejected', 'Workspace path contains an empty or traversal segment.')
	const absoluteRoot = resolve(root)
	const absolutePath = resolve(absoluteRoot, ...segments)
	const rootPrefix = absoluteRoot.endsWith(sep) ? absoluteRoot : `${absoluteRoot}${sep}`
	if (absolutePath !== absoluteRoot && !absolutePath.startsWith(rootPrefix))
		throw new PersistenceError('persistence.path_rejected', 'Workspace path resolves outside the selected root.')
	return absolutePath
}

export function isSafeAssetContentFilename(filename: unknown): filename is string {
	return typeof filename === 'string'
		&& filename.length > 0
		&& filename !== '.'
		&& filename !== '..'
		&& filename !== ASSET_METADATA_FILENAME
		&& !filename.includes('/')
		&& !filename.includes('\\')
		&& !filename.includes('\0')
}

export function assertUuidIdentity(value: string, label: string): void {
	if (!isFullUuid(value))
		throw invalidIdentity(`${label} identity must be a full UUID.`)
}

function invalidIdentity(message: string): PersistenceError {
	return new PersistenceError('persistence.invalid_identity', message)
}
