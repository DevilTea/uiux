import { lstatSync } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { resolve, sep } from 'node:path'

import { artifactStoreShardPath } from '../domain/artifacts/schema'
import { PRODUCT_KIT_FILENAME, PRODUCT_KIT_RESOURCE_KEY, PRODUCT_KIT_RESOURCE_KIND, PRODUCT_KIT_SCHEMA_VERSION } from '../domain/product-kit/schema'
import { isCanonicalLocaleFilename, isCanonicalLocaleTag, isFullUuid, isSafeRelativePath, isSha256Digest } from '../domain/validation'
import { PersistenceError } from './errors'

/**
 * The top-level Workspace directories that hold authored, principal-writable canonical data.
 * This single source of truth is shared by the persistence path helpers below and by the Adapter
 * resolver (`src/adapters/resolution.ts`), which refuses any Adapter specifier — `./`-relative or
 * bare — that resolves inside one of them, so an Editor or Agent cannot select uploaded data as
 * executable Adapter code. `adapters/` is intentionally absent: it is code, not authored data, and
 * hosts legitimate `./adapters/*` local Adapters. These are the old layout's data directories
 * (below `schemaVersion` 5); in a `schemaVersion` 5 root the resolver refuses everything outside
 * `kit/` instead.
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
 *   sure it exists before taking the lock. It is `''` when that directory is the Workspace root
 *   itself (from `schemaVersion` 5); {@link resolveLayoutDirectory} resolves it.
 * - `productKitPath` is the Product Kit file, and `codeDir` the code directory authoring never
 *   writes in; both are absent below `schemaVersion` 5.
 * - `canonicalFiles` lists the canonical files directly under the Workspace root (the manifest and,
 *   from 5, the Product Kit file); the canonical data directories are the same in every layout.
 * - `versionedRoots` lists the versioned files and the versioned directories (with a trailing
 *   `/`), per Clause 01a11a5e-1eba-78ae-a204-52e286a95ddb.
 * - `excluded` lists the directories next to them that are never versioned (`reviews/`, the
 *   runtime, artifact and history directories, and `kit/`); an exact `versionedRoots` file inside
 *   one of them, the legacy manifest, stays versioned.
 * - `isCanonicalPath` is true exactly for the paths canonical writes, transactions and migrations
 *   may touch: the `canonicalFiles` and the resource files of the data directories. Nothing under
 *   `codeDir` is canonical.
 * - `classifyVersionedPath` returns the resource a canonical versioned file belongs to, or
 *   `undefined` for every other path, including excluded and non-canonical ones.
 */
export type WorkspaceLayout = Readonly<{
	/** A stable name of the layout, recorded in pending transaction journals (`legacy` is never written). */
	id: 'legacy' | 'v5'
	metadataDir: string
	manifestPath: string
	productKitPath?: string
	codeDir?: string
	artifactsDir: string
	checkpointsDir: string
	transactionsDir: string
	lockPath: string
	serverHoldPath: string
	canonicalFiles: readonly string[]
	versionedRoots: readonly string[]
	excluded: readonly string[]
	/** A runtime file directly inside `metadataDir` (lock candidates, the server hold's temporary file). */
	metadataFilePath(filename: string): string
	checkpointRelativePath(id: string): string
	artifactRelativePath(identity: string): string
	isCanonicalPath(path: string): boolean
	classifyVersionedPath(path: string): VersionedResourceIdentity | undefined
}>

const LEGACY_METADATA_DIRECTORY = WORKSPACE_DATA_DIRECTORY.workspaceMeta

/** The `schemaVersion` 1–4 layout: authored directories at the Workspace root, the manifest and runtime files under `.uiux/`. */
export const LEGACY_LAYOUT: WorkspaceLayout = Object.freeze({
	id: 'legacy',
	metadataDir: LEGACY_METADATA_DIRECTORY,
	manifestPath: WORKSPACE_MANIFEST_PATH,
	artifactsDir: WORKSPACE_ARTIFACTS_DIRECTORY,
	checkpointsDir: WORKSPACE_CHECKPOINTS_DIRECTORY,
	transactionsDir: `${LEGACY_METADATA_DIRECTORY}/.transactions`,
	lockPath: `${LEGACY_METADATA_DIRECTORY}/.persistence.lock`,
	serverHoldPath: `${LEGACY_METADATA_DIRECTORY}/.server-hold.json`,
	canonicalFiles: Object.freeze([WORKSPACE_MANIFEST_PATH]),
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
	isCanonicalPath: path => path === WORKSPACE_MANIFEST_PATH || isCanonicalDataPath(path),
	classifyVersionedPath: path => path === WORKSPACE_MANIFEST_PATH ? WORKSPACE_RESOURCE : classifyDataVersionedPath(path),
})

/** Clause 01a1144e-531c-7d71-9bc5-f62340aea55a: the manifest directly under the root from `schemaVersion` 5. */
export const V5_MANIFEST_PATH = 'workspace.json'
/** Clause 01a11bb1-8dcc-7d24-99de-52ca7778fd50: the only code directory. */
export const V5_CODE_DIRECTORY = 'kit'
const V5_ARTIFACTS_DIRECTORY = 'artifacts'
const V5_CHECKPOINTS_DIRECTORY = 'history/checkpoints'
const PRODUCT_KIT_RESOURCE: VersionedResourceIdentity = Object.freeze({ kind: PRODUCT_KIT_RESOURCE_KIND, key: PRODUCT_KIT_RESOURCE_KEY })

/**
 * The `schemaVersion` 5 layout (Clauses 01a1144e-531c-…, 01a11bb1-8d67-…, 01a11bb1-8dcc-…,
 * 01a1144e-5508-…, 01a1144e-551f-… and 01a11a5e-1e0e-…): the former `.uiux/` directory is the
 * Workspace root. It holds the manifest `workspace.json`, the Product Kit file, the data
 * directories, `artifacts/`, `history/`, the code directory `kit/` and the runtime files, all
 * directly under the root. The data directories keep their names and inner layout.
 */
export const V5_LAYOUT: WorkspaceLayout = Object.freeze({
	id: 'v5',
	metadataDir: '',
	manifestPath: V5_MANIFEST_PATH,
	productKitPath: PRODUCT_KIT_FILENAME,
	codeDir: V5_CODE_DIRECTORY,
	artifactsDir: V5_ARTIFACTS_DIRECTORY,
	checkpointsDir: V5_CHECKPOINTS_DIRECTORY,
	transactionsDir: '.transactions',
	lockPath: '.persistence.lock',
	serverHoldPath: '.server-hold.json',
	canonicalFiles: Object.freeze([V5_MANIFEST_PATH, PRODUCT_KIT_FILENAME]),
	versionedRoots: Object.freeze([
		V5_MANIFEST_PATH,
		PRODUCT_KIT_FILENAME,
		`${WORKSPACE_DATA_DIRECTORY.views}/`,
		`${WORKSPACE_DATA_DIRECTORY.flows}/`,
		`${WORKSPACE_DATA_DIRECTORY.locales}/`,
		`${WORKSPACE_DATA_DIRECTORY.assets}/`,
	]),
	excluded: Object.freeze([
		`${WORKSPACE_DATA_DIRECTORY.reviews}/`,
		`${V5_ARTIFACTS_DIRECTORY}/`,
		'history/',
		'.transactions/',
		`${V5_CODE_DIRECTORY}/`,
	]),
	metadataFilePath(filename: string): string {
		return filename
	},
	checkpointRelativePath(id: string): string {
		assertUuidIdentity(id, 'Checkpoint')
		return `${V5_CHECKPOINTS_DIRECTORY}/${id}.json`
	},
	artifactRelativePath(identity: string): string {
		return `${V5_ARTIFACTS_DIRECTORY}/${artifactShardRelativePath(identity)}`
	},
	isCanonicalPath: path => path === V5_MANIFEST_PATH || path === PRODUCT_KIT_FILENAME || isCanonicalDataPath(path),
	classifyVersionedPath(path: string): VersionedResourceIdentity | undefined {
		if (path === V5_MANIFEST_PATH) return WORKSPACE_RESOURCE
		if (path === PRODUCT_KIT_FILENAME) return PRODUCT_KIT_RESOURCE
		return classifyDataVersionedPath(path)
	},
})

/**
 * Each layout with the first Workspace `schemaVersion` that uses it, oldest first. A layout holds
 * until the next entry's version.
 */
const LAYOUTS_BY_SCHEMA_VERSION: readonly Readonly<{ fromVersion: number; layout: WorkspaceLayout }>[] = Object.freeze([
	Object.freeze({ fromVersion: 1, layout: LEGACY_LAYOUT }),
	Object.freeze({ fromVersion: PRODUCT_KIT_SCHEMA_VERSION, layout: V5_LAYOUT }),
])

/**
 * The layout of files recorded under Workspace `schemaVersion` `version` (a history record's
 * `workspaceSchemaVersion`, or a migration step's version). A version below the first entry, or
 * one that is not a number, falls back to the legacy layout; whether such a version is usable at
 * all is the schema policy's decision, not the layout's. History interprets each record by the
 * layout of its own `workspaceSchemaVersion` (owner ruling of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627, adopted defaults).
 */
export function layoutForSchemaVersion(version: number): WorkspaceLayout {
	let selected = LEGACY_LAYOUT
	for (const entry of LAYOUTS_BY_SCHEMA_VERSION)
		if (version >= entry.fromVersion) selected = entry.layout
	return selected
}

/**
 * Which layout the directory `root` uses, read from where its manifest is: an old-layout
 * Workspace keeps it in `.uiux/workspace.json`, a `schemaVersion` 5 Workspace in `workspace.json`
 * directly under the root. The old-layout manifest wins when both exist. A directory with neither
 * (a Workspace still to be initialized) gets `fallbackVersion`'s layout, normally the current
 * schema's. Whether the manifest's own `schemaVersion` matches the layout is persistence's check
 * (`FileNativePersistence.inspectWorkspace`), not this one's.
 */
export async function detectWorkspaceLayout(root: string, fallbackVersion: number): Promise<WorkspaceLayout> {
	if (await pathExists(resolveWorkspacePath(root, LEGACY_LAYOUT.manifestPath))) return LEGACY_LAYOUT
	if (await pathExists(resolveWorkspacePath(root, V5_LAYOUT.manifestPath))) return V5_LAYOUT
	return layoutForSchemaVersion(fallbackVersion)
}

/** {@link detectWorkspaceLayout} for synchronous callers (a persistence constructor). */
export function detectWorkspaceLayoutSync(root: string, fallbackVersion: number): WorkspaceLayout {
	if (pathExistsSync(resolveWorkspacePath(root, LEGACY_LAYOUT.manifestPath))) return LEGACY_LAYOUT
	if (pathExistsSync(resolveWorkspacePath(root, V5_LAYOUT.manifestPath))) return V5_LAYOUT
	return layoutForSchemaVersion(fallbackVersion)
}

/** The absolute path of a layout directory (`metadataDir` is `''` when it is the root itself). */
export function resolveLayoutDirectory(root: string, relativeDirectory: string): string {
	return relativeDirectory === '' ? resolve(root) : resolveWorkspacePath(root, relativeDirectory)
}

/**
 * True when `path` lies in the layout's code directory (`kit/`), which authoring operations never
 * write in (Rule 01a11bb1-9585-7239-b371-0ac4032f2d5d). The first segment is compared without case,
 * so a case-insensitive volume cannot alias a differently cased spelling into it.
 */
export function isInCodeDirectory(layout: WorkspaceLayout, path: string): boolean {
	if (!layout.codeDir) return false
	const first = path.split('/')[0] ?? ''
	return first.toLowerCase() === layout.codeDir.toLowerCase()
}

const WORKSPACE_RESOURCE: VersionedResourceIdentity = Object.freeze({ kind: 'workspace', key: 'workspace' })

/** The resource files of the data directories, the same in every layout (the former `assertTransactionalPath` rules). */
function isCanonicalDataPath(path: string): boolean {
	if (typeof path !== 'string') return false
	const segments = path.split('/')
	const [directory, name] = segments
	if (segments.length === 2 && name !== undefined) {
		if (directory === WORKSPACE_DATA_DIRECTORY.views) return isUuidFile(name, VIEW_FILE_SUFFIX)
		if (directory === WORKSPACE_DATA_DIRECTORY.flows) return isUuidFile(name, FLOW_FILE_SUFFIX)
		if (directory === WORKSPACE_DATA_DIRECTORY.reviews) return isUuidFile(name, REVIEW_FILE_SUFFIX)
		if (directory === WORKSPACE_DATA_DIRECTORY.locales) return isCanonicalLocaleFilename(name)
	}
	return segments.length === 3 && directory === WORKSPACE_DATA_DIRECTORY.assets && isFullUuid(name)
		&& (segments[2] === ASSET_METADATA_FILENAME || isSafeAssetContentFilename(segments[2]))
}

/** The suffix compares without case, as the transactional path rules always did. */
function isUuidFile(filename: string, suffix: string): boolean {
	return filename.toLowerCase().endsWith(suffix) && isFullUuid(filename.slice(0, -suffix.length))
}

function pathExistsSync(path: string): boolean {
	try {
		lstatSync(path)
		return true
	}
	catch (error) {
		if (isAbsent(error)) return false
		throw error
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path)
		return true
	}
	catch (error) {
		if (isAbsent(error)) return false
		throw error
	}
}

function isAbsent(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return code === 'ENOENT' || code === 'ENOTDIR'
}

function classifyDataVersionedPath(path: string): VersionedResourceIdentity | undefined {
	if (!isSafeRelativePath(path)) return undefined
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
