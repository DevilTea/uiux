import type { HistoryResourceEntry, VersionRecord } from '../../domain/history/schema'
import { isFullUuid, isSha256Digest, type Diagnostic, type JsonValue } from '../../domain/validation'
import { PersistenceError } from '../../persistence/errors'
import { upgradeSnapshotInMemory, type FileNativePersistence } from '../../persistence/file-native'
import { HostHistoryError } from '../../persistence/history/host-store'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { mergeTimeline } from '../../persistence/history/timeline'
import { readVersionBlobUnlocked } from '../../persistence/history/version-blobs'
import { LEGACY_LAYOUT } from '../../persistence/paths'
import type { HistoryStoreSource } from './history-diff'

/**
 * The version reads for Preview (Rule 01a11a5e-1232-777c-a76d-26a6d5cbcfc0; Clause
 * 01a11485-fa00-72da-bc46-98302a3c106e, `history.read`): a historical View is rendered with that
 * version's manifest, View and Locales, while the Widget runtime and Adapters stay the current ones.
 * Since that runtime decodes the current schema, a version recorded under an older schema version is
 * first upgraded in memory with the migration steps, exactly as a comparison upgrades it (Rule
 * 01a11a5e-118c-733d-92d7-27262bfbcd33). The same reads serve a version's blob by content digest,
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
	/** The revision the version records for the resource (before any in-memory upgrade). */
	revision: string
	/** The schema version the version was recorded under; `resource` is in the current schema. */
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
				if (!policy.recognizedVersions.includes(version.workspaceSchemaVersion))
					return refusal('blocked', 'workspace.schema_unsupported', '/id', `Version ${id} was recorded under Workspace schemaVersion ${version.workspaceSchemaVersion}, which this UIUX build does not recognize.`)
				const entry = version.resources.find(resource => resource.kind === kind && resource.key === key)
				if (!entry) return refusal('not_found', 'history.resource_missing', '/key', `Version ${id} holds no ${kind} ${key}.`)
				// An older version is upgraded as a whole Workspace snapshot, so every placed file is read.
				// Only the resource's own files, and the manifest every migration step reads, are required:
				// another resource whose content is no longer stored is left out of the snapshot whole (a
				// partial Asset would fail the upgrade), so it cannot block reading this one.
				const wanted = version.workspaceSchemaVersion === policy.currentVersion
					? [entry]
					: version.resources.filter(resource => Object.keys(resource.files).some(path => LEGACY_LAYOUT.classifyVersionedPath(path)))
				const bytes = new Map<string, Uint8Array>()
				for (const resource of wanted) {
					const required = resource === entry || resource.kind === 'workspace'
					const files = new Map<string, Uint8Array>()
					let complete = true
					for (const [path, digest] of Object.entries(resource.files)) {
						const blob = await readVersionBlobUnlocked(persistence, stores?.host, digest)
						if (blob) files.set(path, blob)
						else if (required) return refusal('failed', 'history.blob_missing', '/', `Version ${id} names file ${path} (${digest}), whose content is no longer stored.`)
						else complete = false
					}
					if (complete) for (const [path, blob] of files) bytes.set(path, blob)
				}
				return { version, entry, bytes }
			}
			catch (error) {
				if (error instanceof HostHistoryError) return failed(error)
				throw error
			}
		})
		if ('status' in loaded) return loaded

		let files: ReadonlyMap<string, Uint8Array>
		try {
			files = await currentSchemaFiles(loaded.version, loaded.entry, loaded.bytes)
		}
		catch (error) {
			if (error instanceof PersistenceError)
				return { status: 'blocked', code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
			throw error
		}
		if (files.size !== 1) return refusal('not_found', 'history.resource_missing', '/key', `Version ${id} holds no ${kind} ${key} in the current schema.`)
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

	/** The resource's files in the current schema: as recorded, or from the upgraded snapshot. */
	async function currentSchemaFiles(version: VersionRecord, entry: HistoryResourceEntry, bytes: ReadonlyMap<string, Uint8Array>): Promise<ReadonlyMap<string, Uint8Array>> {
		if (version.workspaceSchemaVersion === policy.currentVersion) {
			const files = new Map<string, Uint8Array>()
			for (const path of Object.keys(entry.files)) files.set(path, bytes.get(path)!)
			return files
		}
		const snapshot = new Map<string, Uint8Array>()
		for (const [path, content] of bytes) if (LEGACY_LAYOUT.classifyVersionedPath(path)) snapshot.set(path, content)
		const upgraded = await upgradeSnapshotInMemory(snapshot, version.workspaceSchemaVersion, policy)
		const resource = versionResourcesFromSnapshot(upgraded.snapshot, LEGACY_LAYOUT).resources.find(item => item.kind === entry.kind && item.key === entry.key)
		const files = new Map<string, Uint8Array>()
		for (const path of Object.keys(resource?.files ?? {})) files.set(path, upgraded.snapshot.get(path)!)
		return files
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
