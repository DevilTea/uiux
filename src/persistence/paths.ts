import { resolve, sep } from 'node:path'

import { isCanonicalLocaleTag, isFullUuid, isSha256Digest } from '../domain/validation'
import { PersistenceError } from './errors'

export const WORKSPACE_MANIFEST_PATH = '.uiux/workspace.json'

export function workspaceRelativePath(): typeof WORKSPACE_MANIFEST_PATH {
	return WORKSPACE_MANIFEST_PATH
}

export function viewRelativePath(id: string): string {
	assertUuidIdentity(id, 'View')
	return `views/${id}.view.json`
}

export function flowRelativePath(id: string): string {
	assertUuidIdentity(id, 'Flow')
	return `flows/${id}.flow.json`
}

export function reviewRelativePath(id: string): string {
	assertUuidIdentity(id, 'Review')
	return `reviews/${id}.review.json`
}

export function localeRelativePath(locale: string): string {
	if (!isCanonicalLocaleTag(locale))
		throw invalidIdentity('Locale identity must already be a canonical BCP 47 tag.')
	return `i18n/${locale}.json`
}

export function assetDirectoryRelativePath(id: string): string {
	assertUuidIdentity(id, 'Asset')
	return `assets/${id}`
}

export function assetMetadataRelativePath(id: string): string {
	return `${assetDirectoryRelativePath(id)}/asset.json`
}

export function artifactRelativePath(identity: string): string {
	if (!isSha256Digest(identity))
		throw invalidIdentity('Artifact identity must be sha256:<64 lowercase hexadecimal characters>.')
	const hex = identity.slice('sha256:'.length)
	return `.uiux/artifacts/sha256/${hex.slice(0, 2)}/${hex}`
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
