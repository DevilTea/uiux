import { canonicalJsonBytes } from '../../domain/canonical-json'
import { sha256Identity } from '../../domain/artifacts/schema'
import type { Diagnostic, JsonValue } from '../../domain/validation'
import {
	DISCOVERABLE_RESOURCE_KINDS,
	type DiscoverableResourceKind,
	type ResourceDiscoveryItem,
} from '../dto/resource-discovery'
import type {
	PointResourceRead,
	WorkspaceApplicationSession,
} from './workspace-session'
import type { FormalEvidenceItem } from './formal-capture'
import type { AssessHandoffReadinessResult } from './handoff-export'

export const PUBLICATION_SCHEMA_VERSION = 1 as const

type WorkspacePublicationRead = Readonly<{
	kind: 'workspace'
	key: 'workspace'
	resource: Extract<PointResourceRead, { kind: 'workspace' }>['resource']
	revision: string
	diagnostics: readonly Diagnostic[]
}>

type PublishedPointResource = Exclude<PointResourceRead, { kind: 'workspace' }>

export type PublicationPreview = Readonly<
	| { state: 'valid'; hash: string; runtimeFile: string }
	| { state: 'invalid'; diagnostics: readonly Diagnostic[] }
>

export type PublicationAssetFile = Readonly<{
	file: string
	filename: string
	mediaType: string
	digest: string
	size: number
}>

export type PublicationArtifactFile = Readonly<{
	file: string
	mediaType: string
}>

export type PublicationFiles = Readonly<{
	assets: Readonly<Record<string, PublicationAssetFile>>
	artifacts: Readonly<Record<string, PublicationArtifactFile>>
}>

export type PublicationSnapshot = Readonly<{
	schemaVersion: typeof PUBLICATION_SCHEMA_VERSION
	publicationIdentity: string
	generatedAt: string
	sourceRevision?: string
	workspace: WorkspacePublicationRead
	discovery: Readonly<Record<DiscoverableResourceKind, readonly ResourceDiscoveryItem[]>>
	resources: Readonly<Record<DiscoverableResourceKind, readonly PublishedPointResource[]>>
	evidence: readonly FormalEvidenceItem[]
	handoff: AssessHandoffReadinessResult
	preview: PublicationPreview
	files: PublicationFiles
}>

export type PublicationPreviewInput =
	| Readonly<{ state: 'valid'; hash: string }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

export function sanitizePublicationAdapterDiagnostic(value: unknown): Diagnostic {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return {
			code: 'adapter.invalid',
			path: '/adapters',
			message: 'Workspace adapter validation failed. Inspect the selected Workspace locally for details.',
		}
	}
	const item = value as Record<string, unknown>
	const code = typeof item.code === 'string' && /^[a-z0-9_.-]+$/iu.test(item.code)
		? item.code
		: 'adapter.invalid'
	const path = typeof item.path === 'string' && /^\/adapters(?:\/|$)/u.test(item.path)
		? item.path
		: '/adapters'
	return {
		code,
		path,
		message: 'Workspace adapter validation failed. Inspect the selected Workspace locally for details.',
	}
}

export async function createPublicationSnapshot(
	app: WorkspaceApplicationSession,
	preview: PublicationPreviewInput,
	options: Readonly<{ generatedAt?: string; sourceRevision?: string }> = {},
): Promise<PublicationSnapshot> {
	const workspaceRead = await app.readPointResource('workspace', 'workspace')
	if (!workspaceRead || workspaceRead.kind !== 'workspace')
		throw new Error('Cannot publish a Workspace whose manifest is missing or unreadable.')

	const workspace: WorkspacePublicationRead = {
		kind: 'workspace',
		key: 'workspace',
		resource: workspaceRead.resource,
		revision: workspaceRead.revision,
		diagnostics: workspaceRead.diagnostics,
	}

	const discovery = {} as Record<DiscoverableResourceKind, readonly ResourceDiscoveryItem[]>
	const resources = {} as Record<DiscoverableResourceKind, readonly PublishedPointResource[]>

	for (const kind of DISCOVERABLE_RESOURCE_KINDS) {
		const items = await listAll(app, kind)
		discovery[kind] = items
		const reads: PublishedPointResource[] = []
		for (const item of items) {
			const read = await app.readPointResource(kind, item.key)
			if (read && read.kind !== 'workspace') reads.push(read)
		}
		resources[kind] = reads
	}

	const evidence = await app.listEvidence()
	const handoff = await app.assessHandoffReadiness({ roots: [{ type: 'workspace' }] })
	const files = await publicationFiles(app, resources.asset, evidence)
	const publishedPreview: PublicationPreview = preview.state === 'valid'
		? {
				state: 'valid',
				hash: preview.hash,
				runtimeFile: `_uiux/preview-runtime-${preview.hash}.mjs`,
			}
		: preview

	const deterministicPayload = {
		schemaVersion: PUBLICATION_SCHEMA_VERSION,
		workspace,
		discovery,
		resources,
		evidence,
		handoff,
		preview: publishedPreview,
		files,
	}
	const publicationIdentity = await sha256Identity(canonicalJsonBytes(deterministicPayload))

	return {
		...deterministicPayload,
		publicationIdentity,
		generatedAt: options.generatedAt ?? new Date().toISOString(),
		...(options.sourceRevision ? { sourceRevision: options.sourceRevision } : {}),
	}
}

async function listAll(
	app: WorkspaceApplicationSession,
	kind: DiscoverableResourceKind,
): Promise<readonly ResourceDiscoveryItem[]> {
	const items: ResourceDiscoveryItem[] = []
	let cursor: string | undefined
	do {
		const outcome = await app.listPointResources({
			kinds: [kind],
			limit: 100,
			...(cursor ? { cursor } : {}),
		})
		if (outcome.status !== 'ok')
			throw new Error(`Could not discover ${kind} resources for publication.`)
		items.push(...outcome.page.items)
		cursor = outcome.page.nextCursor
	} while (cursor)
	return items
}

async function publicationFiles(
	app: WorkspaceApplicationSession,
	assets: readonly PublishedPointResource[],
	evidence: readonly FormalEvidenceItem[],
): Promise<PublicationFiles> {
	const assetFiles: Record<string, PublicationAssetFile> = {}
	for (const read of assets) {
		if (read.kind !== 'asset') continue
		const metadata = read.metadata
		const filename = safeFilename(metadata.contentFilename || 'content.bin')
		assetFiles[read.key] = {
			file: `_uiux/assets/${read.key}/${filename}`,
			filename,
			mediaType: read.content.mediaType,
			digest: read.content.digest,
			size: read.content.size,
		}
	}

	const artifactDigests = new Set<string>()
	for (const item of evidence) {
		artifactDigests.add(item.digest)
		for (const digest of item.record.artifactRefs) artifactDigests.add(digest)
		for (const ref of item.record.evidenceRefs ?? []) artifactDigests.add(ref.evidence)
	}

	const artifactFiles: Record<string, PublicationArtifactFile> = {}
	for (const digest of [...artifactDigests].sort()) {
		const bytes = await app.readArtifact(digest)
		if (!bytes) continue
		const { extension, mediaType } = classifyArtifact(bytes)
		artifactFiles[digest] = {
			file: `_uiux/artifacts/${digest.slice('sha256:'.length)}.${extension}`,
			mediaType,
		}
	}

	return {
		assets: sortRecord(assetFiles),
		artifacts: sortRecord(artifactFiles),
	}
}

function classifyArtifact(bytes: Uint8Array): { extension: string; mediaType: string } {
	if (
		bytes.byteLength >= 8
		&& bytes[0] === 0x89
		&& bytes[1] === 0x50
		&& bytes[2] === 0x4e
		&& bytes[3] === 0x47
		&& bytes[4] === 0x0d
		&& bytes[5] === 0x0a
		&& bytes[6] === 0x1a
		&& bytes[7] === 0x0a
	) return { extension: 'png', mediaType: 'image/png' }

	try {
		const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
		JSON.parse(text)
		return { extension: 'json', mediaType: 'application/json' }
	}
	catch {
		return { extension: 'bin', mediaType: 'application/octet-stream' }
	}
}

function safeFilename(value: string): string {
	const normalized = value.replace(/[\\/\r\n\0]/gu, '_').trim()
	return normalized && normalized !== '.' && normalized !== '..' ? normalized : 'content.bin'
}

function sortRecord<T>(input: Record<string, T>): Readonly<Record<string, T>> {
	return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)))
}

/** Narrow runtime check for data loaded by the static viewer. */
export function isPublicationSnapshot(value: unknown): value is PublicationSnapshot {
	if (!isRecord(value)) return false
	return value.schemaVersion === PUBLICATION_SCHEMA_VERSION
		&& typeof value.publicationIdentity === 'string'
		&& /^sha256:[0-9a-f]{64}$/u.test(value.publicationIdentity)
		&& typeof value.generatedAt === 'string'
		&& isRecord(value.workspace)
		&& isRecord(value.discovery)
		&& isRecord(value.resources)
		&& Array.isArray(value.evidence)
		&& isRecord(value.handoff)
		&& isRecord(value.preview)
		&& isRecord(value.files)
}

function isRecord(value: unknown): value is Record<string, JsonValue | unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
