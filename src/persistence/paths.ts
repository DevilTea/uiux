import { resolve, sep } from 'node:path'

import { isCanonicalLocaleTag, isFullUuid, isSha256Digest } from '../domain/validation'
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

export function workspaceRelativePath(): typeof WORKSPACE_MANIFEST_PATH {
	return WORKSPACE_MANIFEST_PATH
}

export function viewRelativePath(id: string): string {
	assertUuidIdentity(id, 'View')
	return `${WORKSPACE_DATA_DIRECTORY.views}/${id}.view.json`
}

export function flowRelativePath(id: string): string {
	assertUuidIdentity(id, 'Flow')
	return `${WORKSPACE_DATA_DIRECTORY.flows}/${id}.flow.json`
}

export function reviewRelativePath(id: string): string {
	assertUuidIdentity(id, 'Review')
	return `${WORKSPACE_DATA_DIRECTORY.reviews}/${id}.review.json`
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
	return `${assetDirectoryRelativePath(id)}/asset.json`
}

export function artifactRelativePath(identity: string): string {
	if (!isSha256Digest(identity))
		throw invalidIdentity('Artifact identity must be sha256:<64 lowercase hexadecimal characters>.')
	const hex = identity.slice('sha256:'.length)
	return `${WORKSPACE_DATA_DIRECTORY.workspaceMeta}/artifacts/sha256/${hex.slice(0, 2)}/${hex}`
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
		&& filename !== 'asset.json'
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
