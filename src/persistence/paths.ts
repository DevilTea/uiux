import { resolve, sep } from 'node:path'

import { artifactStoreShardPath } from '../domain/artifacts/schema'
import { ACCESS_PRESETS_FILENAME, ACCESS_PRESETS_RESOURCE_KEY, ACCESS_PRESETS_RESOURCE_KIND } from '../domain/access-presets/schema'
import { PRODUCT_KIT_FILENAME, PRODUCT_KIT_RESOURCE_KEY, PRODUCT_KIT_RESOURCE_KIND } from '../domain/product-kit/schema'
import { isCanonicalLocaleFilename, isCanonicalLocaleTag, isFullUuid, isSafeRelativePath, isSha256Digest } from '../domain/validation'
import { PersistenceError } from './errors'

/**
 * The top-level directory names that hold authored, principal-writable canonical data. The data
 * directories of the layout below use them, and the Adapter resolver (`src/adapters/resolution.ts`)
 * refuses any Adapter specifier, `./`-relative or bare, that resolves inside one of them in any
 * Workspace-like directory on the module's path, so an Editor or Agent cannot select uploaded data
 * as executable Adapter code. Inside the selected root the resolver refuses everything outside
 * `kit/` instead. `.uiux` is the directory a Workspace root usually lives in.
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

/** A manifest inside a `.uiux/` directory, which the Adapter resolver's data guard recognizes on a module's path. */
export const WORKSPACE_MANIFEST_PATH = `${WORKSPACE_DATA_DIRECTORY.workspaceMeta}/workspace.json` as const

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
 * Callers ask the layout instead of building path literals. There is one layout, {@link V5_LAYOUT}.
 *
 * Every path is Workspace-relative and `/`-separated.
 *
 * - `metadataDir` is the directory that holds the manifest and the runtime files; a writer makes
 *   sure it exists before taking the lock. It is `''`, the Workspace root itself;
 *   {@link resolveLayoutDirectory} resolves it.
 * - `productKitPath` is the Product Kit file, `accessPresetsPath` the Access presets file, and
 *   `codeDir` the code directory authoring never writes in.
 * - `canonicalFiles` lists the canonical files directly under the Workspace root (the manifest, the
 *   Product Kit file and the Access presets file).
 * - `versionedRoots` lists the versioned files and the versioned directories (with a trailing
 *   `/`), per Clause 01a11a5e-1eba-78ae-a204-52e286a95ddb.
 * - `excluded` lists the directories next to them that are never versioned (`reviews/`, the
 *   runtime, artifact and history directories, and `kit/`).
 * - `isCanonicalPath` is true exactly for the paths canonical writes and transactions may touch:
 *   the `canonicalFiles` and the resource files of the data directories. Nothing under `codeDir`
 *   is canonical.
 * - `classifyVersionedPath` returns the resource a canonical versioned file belongs to, or
 *   `undefined` for every other path, including excluded and non-canonical ones.
 */
export type WorkspaceLayout = Readonly<{
	/** A stable name of the layout, recorded in pending transaction journals. */
	id: 'v5'
	metadataDir: string
	manifestPath: string
	productKitPath: string
	accessPresetsPath: string
	codeDir: string
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

/** Clause 01a1144e-531c-7d71-9bc5-f62340aea55a: the manifest directly under the root. */
export const V5_MANIFEST_PATH = 'workspace.json'
/** Clause 01a11bb1-8dcc-7d24-99de-52ca7778fd50: the only code directory. */
export const V5_CODE_DIRECTORY = 'kit'
const V5_ARTIFACTS_DIRECTORY = 'artifacts'
const V5_CHECKPOINTS_DIRECTORY = 'history/checkpoints'
const PRODUCT_KIT_RESOURCE: VersionedResourceIdentity = Object.freeze({ kind: PRODUCT_KIT_RESOURCE_KIND, key: PRODUCT_KIT_RESOURCE_KEY })
const ACCESS_PRESETS_RESOURCE: VersionedResourceIdentity = Object.freeze({ kind: ACCESS_PRESETS_RESOURCE_KIND, key: ACCESS_PRESETS_RESOURCE_KEY })

/**
 * The Workspace layout, the only one (Clauses 01a1144e-531c-…, 01a11bb1-8d67-…, 01a11bb1-8dcc-…,
 * 01a1144e-5508-…, 01a1144e-551f-…, 01a11a5e-1e0e-… and 01a11c09-a855-…); its name records the
 * `schemaVersion` that introduced it. The Workspace root, usually a `.uiux/` directory, holds the
 * manifest `workspace.json`, the Product Kit file, the Access presets file `access-presets.json`,
 * the data directories, `artifacts/`, `history/`, the code directory `kit/` and the runtime files,
 * all directly under the root.
 */
export const V5_LAYOUT: WorkspaceLayout = Object.freeze({
	id: 'v5',
	metadataDir: '',
	manifestPath: V5_MANIFEST_PATH,
	productKitPath: PRODUCT_KIT_FILENAME,
	accessPresetsPath: ACCESS_PRESETS_FILENAME,
	codeDir: V5_CODE_DIRECTORY,
	artifactsDir: V5_ARTIFACTS_DIRECTORY,
	checkpointsDir: V5_CHECKPOINTS_DIRECTORY,
	transactionsDir: '.transactions',
	lockPath: '.persistence.lock',
	serverHoldPath: '.server-hold.json',
	canonicalFiles: Object.freeze([V5_MANIFEST_PATH, PRODUCT_KIT_FILENAME, ACCESS_PRESETS_FILENAME]),
	versionedRoots: Object.freeze([
		V5_MANIFEST_PATH,
		PRODUCT_KIT_FILENAME,
		ACCESS_PRESETS_FILENAME,
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
	isCanonicalPath: path => path === V5_MANIFEST_PATH || path === PRODUCT_KIT_FILENAME || path === ACCESS_PRESETS_FILENAME || isCanonicalDataPath(path),
	classifyVersionedPath(path: string): VersionedResourceIdentity | undefined {
		if (path === V5_MANIFEST_PATH) return WORKSPACE_RESOURCE
		if (path === PRODUCT_KIT_FILENAME) return PRODUCT_KIT_RESOURCE
		if (path === ACCESS_PRESETS_FILENAME) return ACCESS_PRESETS_RESOURCE
		return classifyDataVersionedPath(path)
	},
})

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
	const first = path.split('/')[0] ?? ''
	return first.toLowerCase() === layout.codeDir.toLowerCase()
}

const WORKSPACE_RESOURCE: VersionedResourceIdentity = Object.freeze({ kind: 'workspace', key: 'workspace' })

/** The resource files of the data directories, (the former `assertTransactionalPath` rules). */
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

/**
 * The canonical resource a committed file belongs to: a versioned resource of the layout, or a
 * Review thread (`reviews/<uuid>.review.json`, which version history excludes). The change-event
 * stream (Clause 01a114ec-e839-7b11-957c-41c88b692e12) names resources by this identity.
 */
export function classifyCanonicalResourcePath(layout: WorkspaceLayout, path: string): VersionedResourceIdentity | undefined {
	const versioned = layout.classifyVersionedPath(path)
	if (versioned) return versioned
	if (!isSafeRelativePath(path)) return undefined
	const segments = path.split('/')
	return segments.length === 2 && segments[0] === WORKSPACE_DATA_DIRECTORY.reviews
		? uuidFileIdentity('review', segments[1]!, REVIEW_FILE_SUFFIX)
		: undefined
}

function uuidFileIdentity(kind: string, filename: string, suffix: string): VersionedResourceIdentity | undefined {
	if (!filename.endsWith(suffix)) return undefined
	const key = filename.slice(0, -suffix.length)
	return isFullUuid(key) ? { kind, key } : undefined
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

/** An artifact's place inside the artifact directory: `sha256/<first two hex>/<hex>`. */
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
