import { randomUUID } from 'node:crypto'

import { HISTORY_SCHEMA_VERSION, HISTORY_VERSION_TYPES, type HistorySource, type HistoryVersionType } from '../../domain/history/constants'
import { projectResourceHistory } from '../../domain/history/projection'
import { isValidCheckpointNote, normalizeCheckpointName, type CheckpointRecord, type HistoryActor, type HistoryResourceIdentity, type VersionRecord } from '../../domain/history/schema'
import { summarizeResourceChanges, type ResourceChangeSummary } from '../../domain/history/summary'
import { isFullUuid, type Diagnostic } from '../../domain/validation'
import { PersistenceError } from '../../persistence/errors'
import type { FileNativePersistence } from '../../persistence/file-native'
import { HostHistoryError } from '../../persistence/history/host-store'
import { compareVersionOrder } from '../../persistence/history/order'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { mergeTimeline, pageTimeline, readMergedTimeline, TimelineCursorError, type MergedTimeline, type TimelineVersion } from '../../persistence/history/timeline'
import type { HistoryStoreSource } from './history-diff'
import type { HistoryRecorder } from './history-recorder'

/**
 * Named Checkpoints and the version listing (Features 01a11a5d-fcb9-72b3-a52d-52c0fbd74401 and
 * 01a11a5d-fc56-7e10-9d16-9d333aa2995c, issue #132 B4), shared by `/api/history/*` and `/mcp`.
 *
 * Authorization, actor stamping and the transport's `source` belong to the scoped session; this
 * service trusts the actor and source it is given. Every refusal code below is implementation-
 * defined except the schema diagnostics, which the Workspace persisted format Contract assigns.
 */

/** The recorder boundary a Checkpoint takes first (Rule 01a11a5e-00b9-7bf5-8005-9380a388afb8). */
export type CheckpointBoundary = Pick<HistoryRecorder, 'closeOpenAutosaveUnlocked' | 'nextVersionAt'>

export type CreateCheckpointCommand = Readonly<{
	name: string
	note?: string
	/** The server-stamped actor (Rule 01a11a5e-025f-71d7-8d08-63948220de57). */
	actor: HistoryActor
	/** The transport's source (Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f). */
	source: HistorySource
}>

/** Clause 01a11a5e-265d-7f71-80a3-5dae7f788ae1: `resources` is the number of resources the Checkpoint records. */
export type CheckpointCreated = Readonly<{ status: 'created'; versionId: string; at: string; resources: number }>

export type CheckpointDeleted = Readonly<{ status: 'deleted'; versionId: string }>

/**
 * One row of the version listing (Clause 01a11a5e-26b9-7dfd-b619-a7e4113809f5, as amended by the
 * owner ruling https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18828964 item 1):
 * `parent` is the version's predecessor on the merged timeline (Rule
 * 01a11e0d-d550-78e4-9787-f0023bbc1b93), `null` for the first version, whatever filter the listing
 * applies; `summary` lists the resources whose revision differs from that predecessor.
 */
export type VersionListItem = Readonly<{
	id: string
	type: HistoryVersionType
	name?: string
	note?: string
	actor: HistoryActor
	at: string
	parent: string | null
	workspaceSchemaVersion: number
	netChange?: boolean
	restoredFrom?: string
	recordingGap?: true
	summary: readonly Pick<ResourceChangeSummary, 'kind' | 'key' | 'status'>[]
}>

export type ListVersionsQuery = Readonly<{
	/** The per-resource projection (Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28). */
	resource?: HistoryResourceIdentity
	types?: readonly HistoryVersionType[]
	/** An actor `id` (`member:<id>`, `system:migrate`, `system:baseline`) or `external`. */
	actor?: string
	limit?: number
	cursor?: string
}>

export type VersionListing = Readonly<{
	status: 'listed'
	/** Newest first. */
	versions: readonly VersionListItem[]
	nextCursor?: string
	/** History files that are not valid records and are left out of the timeline. */
	invalid?: readonly Readonly<{ file: string; diagnostics: readonly Diagnostic[] }>[]
}>

/** Clause 01a11a5e-27c1-77d1-b60d-45a5ccfc1ee7: the record (its file map and, for host versions, its events). */
export type VersionRead = Readonly<{
	status: 'found'
	version: VersionRecord
	/** The predecessor on the merged timeline, as in the listing; the record's own `parent` is store integrity only. */
	parent: string | null
}>

export type HistoryRefusal = Readonly<{
	status: 'invalid' | 'not_found' | 'blocked' | 'failed'
	code: string
	message: string
	diagnostics: readonly Diagnostic[]
}>

/** A transient refusal (HTTP 503 with `Retry-After`): nothing was written; the same request may be retried. */
export type HistoryUnavailable = Readonly<{
	status: 'unavailable'
	code: string
	retryable: true
	retryAfterSeconds: number
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type CreateCheckpointOutcome = CheckpointCreated | HistoryRefusal | HistoryUnavailable
export type DeleteCheckpointOutcome = CheckpointDeleted | HistoryRefusal
export type ListVersionsOutcome = VersionListing | HistoryRefusal
export type ReadVersionOutcome = VersionRead | HistoryRefusal

export type HistoryService = Readonly<{
	createCheckpoint(command: CreateCheckpointCommand): Promise<CreateCheckpointOutcome>
	deleteCheckpoint(id: string): Promise<DeleteCheckpointOutcome>
	listVersions(query: ListVersionsQuery): Promise<ListVersionsOutcome>
	readVersion(id: string): Promise<ReadVersionOutcome>
}>

export const DEFAULT_VERSION_LIST_LIMIT = 50
export const MAX_VERSION_LIST_LIMIT = 200
const BOUNDARY_RETRY_AFTER_SECONDS = 1

export function createHistoryService(
	persistence: FileNativePersistence,
	history: HistoryStoreSource | undefined,
	options: Readonly<{ boundary?: () => CheckpointBoundary | undefined }> = {},
): HistoryService {
	async function openStores(): Promise<Awaited<ReturnType<HistoryStoreSource['open']>> | HistoryRefusal> {
		try {
			return await history?.open()
		}
		catch (error) {
			if (error instanceof HostHistoryError) return storeFailure(error)
			throw error
		}
	}

	/**
	 * Rules 01a11a5e-0919-…, 096a-…, 0a0c-…, 0a5e-…, 00b9-… and 0313-…, Clauses 01a11a5e-2070-… and
	 * 2272-…. Everything runs under one exclusive persistence lock: the schema check, the recorder
	 * boundary (the open autosave closes and changes made outside UIUX become an external version
	 * first), the snapshot and the record write, so the Checkpoint holds exactly the files that
	 * boundary saw. No edit lease is checked or taken; no canonical file is written.
	 */
	async function createCheckpoint(command: CreateCheckpointCommand): Promise<CreateCheckpointOutcome> {
		const name = typeof command.name === 'string' ? normalizeCheckpointName(command.name) : undefined
		const diagnostics: Diagnostic[] = []
		if (name === undefined)
			diagnostics.push({ code: 'history.invalid_checkpoint_name', path: '/name', message: 'A Checkpoint name is 1 to 120 characters after trimming.' })
		if (command.note !== undefined && (typeof command.note !== 'string' || !isValidCheckpointNote(command.note)))
			diagnostics.push({ code: 'history.invalid_checkpoint_note', path: '/note', message: 'A Checkpoint note is plain text of at most 2,000 characters.' })
		if (diagnostics.length > 0)
			return { status: 'invalid', code: diagnostics[0]!.code, message: 'The Checkpoint name or note is not valid.', diagnostics }
		const stores = await openStores()
		if (isRefusal(stores)) return stores
		if (!stores?.checkpoints) return unavailableHistory()
		const checkpoints = stores.checkpoints
		const boundary = options.boundary?.()

		return persistence.withLock(async (): Promise<CreateCheckpointOutcome> => {
			try {
				await persistence.assertWritableUnlocked()
			}
			catch (error) {
				if (error instanceof PersistenceError) return schemaRefusal(error)
				throw error
			}
			if (boundary) {
				// The recorder bounds this boundary in time. When it fails or is abandoned, a host version
				// it already started writing can still land after this point, so the Checkpoint is refused
				// rather than written before (or interleaved with) it; the next boundary records what the
				// abandoned one left, flagged as a recording gap.
				try {
					await boundary.closeOpenAutosaveUnlocked('checkpoint')
				}
				catch (error) {
					return boundaryUnavailable(error)
				}
			}
			const host = await stores.host?.listVersions()
			const existing = await checkpoints.listUnlocked()
			const timeline = mergeTimeline(host, existing)
			const snapshot = versionResourcesFromSnapshot(await persistence.scanVersionedSnapshotUnlocked())
			const at = laterThan(boundary?.nextVersionAt(), timeline.versions.at(-1)?.version.at)
			const parentCheckpoint = existing.records.at(-1)?.id
			const note = command.note === undefined || command.note === '' ? undefined : command.note
			const record: CheckpointRecord = {
				historySchemaVersion: HISTORY_SCHEMA_VERSION,
				id: randomUUID(),
				type: 'checkpoint',
				actor: command.actor,
				at,
				workspaceSchemaVersion: await persistence.readDecodeSchemaVersionUnlocked(),
				resources: snapshot.resources,
				name: name!,
				...(note === undefined ? {} : { note }),
				source: command.source,
				...(parentCheckpoint ? { parentCheckpoint } : {}),
			}
			await checkpoints.createUnlocked(record, snapshot.blobs)
			return { status: 'created', versionId: record.id, at: record.at, resources: record.resources.length }
		})
	}

	/** Rule 01a11a5e-0c1f-7b18-83a2-d9cd62b78ae9: only the record goes; its blobs are left to artifact cleanup. */
	async function deleteCheckpoint(id: string): Promise<DeleteCheckpointOutcome> {
		if (!isFullUuid(id)) return refusal('not_found', 'history.record_missing', '/id', `Checkpoint ${String(id)} does not exist.`)
		const stores = await openStores()
		if (isRefusal(stores)) return stores
		if (!stores?.checkpoints) return refusal('not_found', 'history.record_missing', '/id', `Checkpoint ${id} does not exist.`)
		const checkpoints = stores.checkpoints
		return persistence.withLock(async (): Promise<DeleteCheckpointOutcome> => {
			let record: CheckpointRecord | undefined
			try {
				record = await checkpoints.readUnlocked(id)
			}
			catch (error) {
				if (error instanceof PersistenceError && error.code === 'persistence.invalid_resource')
					return { status: 'invalid', code: 'history.record_invalid', message: `Checkpoint file ${id} is not a valid Checkpoint record, so UIUX does not delete it.`, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: 'history.record_invalid', path: '/id', message: error.message }] }
				throw error
			}
			if (!record) {
				const hosted = await stores.host?.readVersion(id).catch(() => undefined)
				if (hosted)
					return refusal('blocked', 'history.not_checkpoint', '/id', `Version ${id} is ${article(hosted.type)} ${hosted.type} version, not a Checkpoint; only Checkpoints can be deleted.`)
				return refusal('not_found', 'history.record_missing', '/id', `Checkpoint ${id} does not exist.`)
			}
			await checkpoints.deleteUnlocked(id)
			return { status: 'deleted', versionId: id }
		})
	}

	/**
	 * Rules 01a11a5e-07c1-… and 081c-…: versions are listed in every Workspace schema state and
	 * whatever schema they were recorded under. Every row's `parent` and `summary` come from the
	 * full merged timeline before any filter, so a filtered listing names the same parent the
	 * Workbench compares with.
	 */
	async function listVersions(query: ListVersionsQuery): Promise<ListVersionsOutcome> {
		const parsed = parseListQuery(query)
		if ('status' in parsed) return parsed
		const timeline = await readTimeline()
		if (isRefusal(timeline)) return timeline
		const projected = parsed.resource
			? new Set(projectResourceHistory(timeline.versions.map(entry => ({ ...entry, resources: entry.version.resources })), parsed.resource).map(entry => entry.version.version.id))
			: undefined
		const selected = timeline.versions.filter(entry =>
			(!parsed.types || parsed.types.has(entry.version.type))
			&& (parsed.actor === undefined || actorMatches(entry.version.actor, parsed.actor))
			&& (!projected || projected.has(entry.version.id)))
		let page: ReturnType<typeof pageTimeline>
		try {
			page = pageTimeline({ versions: selected, invalid: [] }, { limit: parsed.limit, ...(parsed.cursor === undefined ? {} : { cursor: parsed.cursor }) })
		}
		catch (error) {
			if (error instanceof TimelineCursorError) return refusal('invalid', error.code, '/cursor', error.message)
			throw error
		}
		const byId = new Map(timeline.versions.map(entry => [entry.version.id, entry.version]))
		return {
			status: 'listed',
			versions: page.items.map(entry => listItem(entry, entry.predecessor === undefined ? undefined : byId.get(entry.predecessor))),
			...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
			...(timeline.invalid.length > 0 ? { invalid: timeline.invalid } : {}),
		}
	}

	async function readVersion(id: string): Promise<ReadVersionOutcome> {
		if (!isFullUuid(id)) return refusal('not_found', 'history.record_missing', '/id', `Version ${String(id)} does not exist.`)
		const timeline = await readTimeline()
		if (isRefusal(timeline)) return timeline
		const entry = timeline.versions.find(item => item.version.id === id)
		if (!entry) return refusal('not_found', 'history.record_missing', '/id', `Version ${id} does not exist.`)
		return { status: 'found', version: entry.version, parent: entry.predecessor ?? null }
	}

	async function readTimeline(): Promise<MergedTimeline | HistoryRefusal> {
		const stores = await openStores()
		if (isRefusal(stores)) return stores
		if (!stores) return { versions: [], invalid: [] }
		try {
			return await readMergedTimeline(persistence, stores)
		}
		catch (error) {
			if (error instanceof HostHistoryError) return storeFailure(error)
			throw error
		}
	}

	return Object.freeze({ createCheckpoint, deleteCheckpoint, listVersions, readVersion })
}

type ParsedListQuery = Readonly<{
	resource?: HistoryResourceIdentity
	types?: ReadonlySet<string>
	actor?: string
	limit: number
	cursor?: string
}>

function parseListQuery(query: ListVersionsQuery): ParsedListQuery | HistoryRefusal {
	const raw = (query ?? {}) as Readonly<Record<string, unknown>>
	const diagnostics: Diagnostic[] = []
	const issue = (path: string, message: string) => diagnostics.push({ code: 'history.invalid_listing', path, message })
	let resource: HistoryResourceIdentity | undefined
	if (raw.resource !== undefined) {
		const value = raw.resource as Record<string, unknown> | null
		if (value === null || typeof value !== 'object' || typeof value.kind !== 'string' || value.kind.length === 0 || typeof value.key !== 'string' || value.key.length === 0)
			issue('/resource', 'resource is { kind, key } with non-empty strings.')
		else resource = { kind: value.kind, key: value.key }
	}
	let types: Set<string> | undefined
	if (raw.types !== undefined) {
		if (!Array.isArray(raw.types) || raw.types.length === 0) issue('/types', `types lists one or more of ${HISTORY_VERSION_TYPES.join(', ')}.`)
		else {
			types = new Set()
			raw.types.forEach((type: unknown, index) => {
				if ((HISTORY_VERSION_TYPES as readonly unknown[]).includes(type)) types!.add(type as string)
				else issue(`/types/${index}`, `A version type is one of ${HISTORY_VERSION_TYPES.join(', ')}.`)
			})
		}
	}
	if (raw.actor !== undefined && (typeof raw.actor !== 'string' || raw.actor.length === 0))
		issue('/actor', 'actor is an actor id or external.')
	const limit = raw.limit ?? DEFAULT_VERSION_LIST_LIMIT
	if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_VERSION_LIST_LIMIT)
		issue('/limit', `limit is an integer from 1 to ${MAX_VERSION_LIST_LIMIT}.`)
	if (raw.cursor !== undefined && (typeof raw.cursor !== 'string' || raw.cursor.length === 0))
		diagnostics.push({ code: 'history.invalid_cursor', path: '/cursor', message: 'The timeline cursor is not valid.' })
	if (diagnostics.length > 0)
		return { status: 'invalid', code: diagnostics[0]!.code, message: 'The version listing request is not valid.', diagnostics }
	return {
		...(resource ? { resource } : {}),
		...(types ? { types } : {}),
		...(raw.actor === undefined ? {} : { actor: raw.actor as string }),
		limit: limit as number,
		...(raw.cursor === undefined ? {} : { cursor: raw.cursor as string }),
	}
}

function listItem(entry: TimelineVersion, predecessor: VersionRecord | undefined): VersionListItem {
	const { version } = entry
	const summary = summarizeResourceChanges(predecessor?.resources, version.resources)
		.filter(row => row.status !== 'unchanged')
		.map(row => ({ kind: row.kind, key: row.key, status: row.status }))
	return {
		id: version.id,
		type: version.type,
		...(version.type === 'checkpoint' ? { name: version.name, ...(version.note === undefined ? {} : { note: version.note }) } : {}),
		actor: version.actor,
		at: version.at,
		parent: entry.predecessor ?? null,
		workspaceSchemaVersion: version.workspaceSchemaVersion,
		...(version.type === 'checkpoint'
			? {}
			: {
					netChange: version.netChange,
					...(version.restoredFrom ? { restoredFrom: version.restoredFrom } : {}),
					...(version.recordingGap ? { recordingGap: true as const } : {}),
				}),
		summary,
	}
}

function actorMatches(actor: HistoryActor, wanted: string): boolean {
	return actor.type === 'external' ? wanted === 'external' : actor.id === wanted
}

/** A version time after both the recorder's stamp and the newest recorded version, so the Checkpoint sorts last. */
function laterThan(stamp: string | undefined, latest: string | undefined): string {
	const candidate = stamp ?? new Date().toISOString()
	if (latest === undefined || compareVersionOrder({ at: candidate, id: '' }, { at: latest, id: '' }) > 0) return candidate
	return new Date(Date.parse(latest) + 1).toISOString()
}

function article(type: string): string {
	return /^[aeiou]/u.test(type) ? 'an' : 'a'
}

function isRefusal(value: unknown): value is HistoryRefusal {
	return typeof value === 'object' && value !== null && 'status' in value && 'code' in value
}

function refusal(status: HistoryRefusal['status'], code: string, path: string, message: string): HistoryRefusal {
	return { status, code, message, diagnostics: [{ code, path, message }] }
}

/** Rule 01a11a5e-0a5e-7562-91cd-8c48eac71529: the persisted format Contract's schema diagnostic. */
function schemaRefusal(error: PersistenceError): HistoryRefusal {
	const message = error.code === 'workspace.migration_required'
		? 'A Checkpoint cannot be created until the Workspace is migrated. Run: uiux migrate --workspace <dir>'
		: `A Checkpoint cannot be created for this Workspace schema state: ${error.message}`
	return { status: 'blocked', code: error.code, message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/schemaVersion', message: error.message }] }
}

function storeFailure(error: HostHistoryError): HistoryRefusal {
	return { status: 'failed', code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
}

function unavailableHistory(): HistoryRefusal {
	return refusal('failed', 'history.unavailable', '/', 'Version history is not available on this server, so no Checkpoint can be created.')
}

function boundaryUnavailable(error: unknown): HistoryUnavailable {
	const message = 'The open autosave could not be closed before the Checkpoint, so no Checkpoint was created. Nothing was changed; retry shortly.'
	return {
		status: 'unavailable',
		code: 'history.boundary_failed',
		retryable: true,
		retryAfterSeconds: BOUNDARY_RETRY_AFTER_SECONDS,
		message,
		diagnostics: [{ code: 'history.boundary_failed', path: '/', message: `${message} (${error instanceof Error ? error.message : String(error)})` }],
	}
}
