import type { HistoryResourceEntry, VersionRecord } from '../../domain/history/schema'
import { isFullUuid, isSha256Digest, type Diagnostic, type JsonValue } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence/file-native'
import { HostHistoryError } from '../../persistence/history/host-store'
import { mergeTimeline } from '../../persistence/history/timeline'
import { readVersionBlobUnlocked } from '../../persistence/history/version-blobs'
import type { HistoryStoreSource } from './history-diff'

/**
 * The version reads for Preview (Rule 01a11a5e-1232-777c-a76d-26a6d5cbcfc0; Clause
 * 01a11485-fa00-72da-bc46-98302a3c106e, `history.read`): a historical View is rendered with that
 * version's manifest, View and Locales, while the Widget runtime and Adapters stay the current ones.
 * Since that runtime decodes the current schema, a version recorded under another schema version is
 * refused with `workspace.schema_unsupported` (Clause 01a11a5e-2434-7342-a3c1-6d63aa74334c). The same reads serve a version's blob by content digest,
 * from the host history store first and then the artifact store (Rule 01a11a5e-10df-795e-8fbc-a99de09694a5).
 *
 * There is no HTTP Contract, so the shapes and refusal codes here are implementation-defined.
 */

/** The resource kinds Preview reads from a version: the manifest, the View and its Locales. */
export const VERSION_PREVIEW_KINDS = Object.freeze(['workspace', 'view', 'locale'] as const)
export type VersionPreviewKind = typeof VERSION_PREVIEW_KINDS[number]

export type VersionResourceRead = Readonly<{
	status: 'found'
	versionId: string
	kind: VersionPreviewKind
	key: string
	/** The revision the version records for the resource. */
	revision: string
	/** The schema version the version was recorded under, always the current one. */
	workspaceSchemaVersion: number
	resource: JsonValue
}>

export type VersionBlobRead = Readonly<{ status: 'found'; digest: string; bytes: Uint8Array }>

export type VersionPreviewRefusal = Readonly<{
	status: 'invalid' | 'not_found' | 'blocked' | 'failed'
	code: string
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type ReadVersionResourceOutcome = VersionResourceRead | VersionPreviewRefusal
export type ReadVersionBlobOutcome = VersionBlobRead | VersionPreviewRefusal

export type HistoryPreviewService = Readonly<{
	readVersionResource(id: string, kind: string, key: string): Promise<ReadVersionResourceOutcome>
	readVersionBlob(digest: string): Promise<ReadVersionBlobOutcome>
}>

export function createHistoryPreviewService(persistence: FileNativePersistence, history: HistoryStoreSource | undefined): HistoryPreviewService {
	const policy = persistence.schemaPolicy

	async function openStores(): Promise<Awaited<ReturnType<HistoryStoreSource['open']>> | VersionPreviewRefusal> {
		try {
			return await history?.open()
		}
		catch (error) {
			if (error instanceof HostHistoryError) return failed(error)
			throw error
		}
	}

	async function readVersionResource(id: string, kind: string, key: string): Promise<ReadVersionResourceOutcome> {
		if (!(VERSION_PREVIEW_KINDS as readonly string[]).includes(kind))
			return refusal('invalid', 'history.invalid_resource', '/kind', `Preview reads only ${VERSION_PREVIEW_KINDS.join(', ')} resources from a version.`)
		if (typeof key !== 'string' || key.length === 0)
			return refusal('invalid', 'history.invalid_resource', '/key', 'The resource key is empty.')
		if (!isFullUuid(id)) return refusal('not_found', 'history.record_missing', '/id', `Version ${String(id)} does not exist.`)
		const stores = await openStores()
		if (stores && 'status' in stores) return stores
		const loaded = await persistence.withReadLock(async (): Promise<Readonly<{ version: VersionRecord; entry: HistoryResourceEntry; bytes: ReadonlyMap<string, Uint8Array> }> | VersionPreviewRefusal> => {
			try {
				const timeline = mergeTimeline(await stores?.host?.listVersions(), await stores?.checkpoints?.listUnlocked())
				const version = timeline.versions.find(item => item.version.id === id)?.version
				if (!version) return refusal('not_found', 'history.record_missing', '/id', `Version ${id} does not exist.`)
				if (version.workspaceSchemaVersion !== policy.currentVersion)
					return refusal('blocked', 'workspace.schema_unsupported', '/id', `Version ${id} was recorded under Workspace schemaVersion ${version.workspaceSchemaVersion} and cannot be previewed: this UIUX reads only schemaVersion ${policy.currentVersion}.`)
				const entry = version.resources.find(resource => resource.kind === kind && resource.key === key)
				if (!entry) return refusal('not_found', 'history.resource_missing', '/key', `Version ${id} holds no ${kind} ${key}.`)
				const bytes = new Map<string, Uint8Array>()
				for (const [path, digest] of Object.entries(entry.files)) {
					const blob = await readVersionBlobUnlocked(persistence, stores?.host, digest)
					if (!blob) return refusal('failed', 'history.blob_missing', '/', `Version ${id} names file ${path} (${digest}), whose content is no longer stored.`)
					bytes.set(path, blob)
				}
				return { version, entry, bytes }
			}
			catch (error) {
				if (error instanceof HostHistoryError) return failed(error)
				throw error
			}
		})
		if ('status' in loaded) return loaded

		const files = loaded.bytes
		if (files.size !== 1) return refusal('not_found', 'history.resource_missing', '/key', `Version ${id} holds no ${kind} ${key} as one file.`)
		let resource: JsonValue
		try {
			resource = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode([...files.values()][0]!)) as JsonValue
		}
		catch {
			return refusal('blocked', 'history.resource_invalid', '/', `The ${kind} ${key} that version ${id} records is not valid JSON.`)
		}
		return {
			status: 'found',
			versionId: id,
			kind: kind as VersionPreviewKind,
			key,
			revision: loaded.entry.revision,
			workspaceSchemaVersion: loaded.version.workspaceSchemaVersion,
			resource,
		}
	}

	async function readVersionBlob(digest: string): Promise<ReadVersionBlobOutcome> {
		if (!isSha256Digest(digest))
			return refusal('invalid', 'history.invalid_digest', '/digest', 'A blob digest is sha256:<64 lowercase hex characters>.')
		const stores = await openStores()
		if (stores && 'status' in stores) return stores
		return persistence.withReadLock(async (): Promise<ReadVersionBlobOutcome> => {
			try {
				const bytes = await readVersionBlobUnlocked(persistence, stores?.host, digest)
				return bytes ? { status: 'found', digest, bytes } : refusal('not_found', 'history.blob_missing', '/digest', `No stored blob has digest ${digest}.`)
			}
			catch (error) {
				if (error instanceof HostHistoryError) return failed(error)
				throw error
			}
		})
	}

	return Object.freeze({ readVersionResource, readVersionBlob })
}

function refusal(status: VersionPreviewRefusal['status'], code: string, path: string, message: string): VersionPreviewRefusal {
	return { status, code, message, diagnostics: [{ code, path, message }] }
}

function failed(error: HostHistoryError): VersionPreviewRefusal {
	return { status: 'failed', code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
}
