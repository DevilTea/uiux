import {
	hasAsciiControlCharacter,
	isCanonicalLocaleTag,
	isFullUuid,
	isJsonObject,
	isRecord,
	jsonPointer,
	rejectUnknownKeys,
	validateDigest,
	validateUtcTimestamp,
	validateUuid,
	Validator,
	type JsonObject,
	type ValidationResult,
} from '../validation'
import {
	BASELINE_CHECKPOINT_NAME,
	CHECKPOINT_NAME_MAX_LENGTH,
	CHECKPOINT_NAME_MIN_LENGTH,
	CHECKPOINT_NOTE_MAX_LENGTH,
	HISTORY_ACTOR_TYPES,
	HISTORY_SCHEMA_VERSION,
	HISTORY_SOURCES,
	HISTORY_SYSTEM_ACTOR_IDS,
	HISTORY_WRITE_OPERATIONS,
	HOST_VERSION_TYPES,
	SINGLETON_HISTORY_RESOURCE_KINDS,
	type HistoryActorType,
	type HistorySource,
	type HistoryWriteOperation,
	type HostVersionType,
} from './constants'

/**
 * Version history records (Contract 01a11a5e-1db8-7f0b-b7fa-ee8836c0cfa7). The record shapes are
 * closed; the resource-kind set is open (seam 3), so a record naming a kind this build does not
 * know still validates. The validation codes below are implementation-defined, not normative.
 */

/** Clause 01a11a5e-21c4-79f7-b6f9-4128d842c278. */
export type HistoryActor = Readonly<{ type: HistoryActorType; id?: string; displayName?: string }>

export type HistoryResourceIdentity = Readonly<{ kind: string; key: string }>

/** Clause 01a11a5e-1fc4-7bf0-a402-61c345f454c2: `files` maps Workspace-relative paths to `sha256:<hex>`. */
export type HistoryResourceEntry = Readonly<{
	kind: string
	key: string
	revision: string
	files: Readonly<Record<string, string>>
}>

/** Clause 01a11a5e-1f6f-7263-a609-1d60c03d7c2a. `adapters` and `productKit` are carried as opaque JSON objects. */
type VersionRecordBase = Readonly<{
	historySchemaVersion: typeof HISTORY_SCHEMA_VERSION
	id: string
	actor: HistoryActor
	at: string
	workspaceSchemaVersion: number
	resources: readonly HistoryResourceEntry[]
	adapters?: readonly JsonObject[]
	productKit?: JsonObject
}>

/** Clause 01a11a5e-2070-7c38-a62e-daae1fd8ac43. */
export type CheckpointRecord = VersionRecordBase & Readonly<{
	type: 'checkpoint'
	name: string
	note?: string
	source: HistorySource
	parentCheckpoint?: string
}>

/**
 * Clause 01a11a5e-2119-7a5a-951d-58a34e03e8fe. A `null` revision means the resource did not exist
 * on that side of the write (implementation-defined: the Clause names no value for it).
 */
export type HistoryWriteEvent = Readonly<{
	at: string
	actor: HistoryActor
	source: HistorySource
	operation: HistoryWriteOperation
	resource: HistoryResourceIdentity
	beforeRevision: string | null
	afterRevision: string | null
}>

/** Clause 01a11a5e-20c6-7573-8530-e6fed6d8d4af. */
export type HostVersionRecord = VersionRecordBase & Readonly<{
	type: HostVersionType
	parent?: string
	startedAt: string
	netChange: boolean
	events: readonly HistoryWriteEvent[]
	restoredFrom?: string
	recordingGap?: true
}>

export type VersionRecord = CheckpointRecord | HostVersionRecord

const BASE_KEYS = ['historySchemaVersion', 'id', 'type', 'actor', 'at', 'workspaceSchemaVersion', 'resources', 'adapters', 'productKit'] as const
const CHECKPOINT_KEYS = [...BASE_KEYS, 'name', 'note', 'source', 'parentCheckpoint'] as const
const HOST_VERSION_KEYS = [...BASE_KEYS, 'parent', 'startedAt', 'netChange', 'events', 'restoredFrom', 'recordingGap'] as const
const MIGRATION_CHECKPOINT_NAME = /^Before migration to schemaVersion [1-9]\d*$/u

/** Dispatches on `type`: `checkpoint` records and host (`autosave`, `external`, `system`) versions. */
export function validateVersionRecord(input: unknown, path = ''): ValidationResult<VersionRecord> {
	if (isRecord(input) && input.type === 'checkpoint') return validateCheckpointRecord(input, path)
	if (isRecord(input) && isOneOf(HOST_VERSION_TYPES, input.type)) return validateHostVersionRecord(input, path)
	const v = new Validator()
	if (v.object(input, path))
		v.issue('history.invalid_version_type', `${path}/type`, 'Version type must be checkpoint, autosave, external or system.')
	return v.finish<VersionRecord>(input)
}

export function validateCheckpointRecord(input: unknown, path = ''): ValidationResult<CheckpointRecord> {
	const v = new Validator()
	const record = v.object(input, path)
	if (!record) return v.finish<CheckpointRecord>(input)
	rejectUnknownKeys(record, CHECKPOINT_KEYS, path, v)
	validateBase(record, path, v)
	if (record.type !== 'checkpoint')
		v.issue('history.invalid_version_type', `${path}/type`, 'A checkpoint record has type checkpoint.')
	if (typeof record.name !== 'string' || !isValidCheckpointName(record.name))
		v.issue('history.invalid_checkpoint_name', `${path}/name`, `A checkpoint name is ${CHECKPOINT_NAME_MIN_LENGTH} to ${CHECKPOINT_NAME_MAX_LENGTH} characters after trimming.`)
	if (Object.hasOwn(record, 'note') && (typeof record.note !== 'string' || !isValidCheckpointNote(record.note)))
		v.issue('history.invalid_checkpoint_note', `${path}/note`, `A checkpoint note is plain text of at most ${CHECKPOINT_NOTE_MAX_LENGTH} characters.`)
	validateSource(record.source, `${path}/source`, v)
	if (Object.hasOwn(record, 'parentCheckpoint')) validateUuid(record.parentCheckpoint, `${path}/parentCheckpoint`, v, 'Parent checkpoint id')
	validateSystemCheckpointName(record, path, v)
	return v.finish<CheckpointRecord>(input)
}

export function validateHostVersionRecord(input: unknown, path = ''): ValidationResult<HostVersionRecord> {
	const v = new Validator()
	const record = v.object(input, path)
	if (!record) return v.finish<HostVersionRecord>(input)
	rejectUnknownKeys(record, HOST_VERSION_KEYS, path, v)
	validateBase(record, path, v)
	if (!isOneOf(HOST_VERSION_TYPES, record.type))
		v.issue('history.invalid_version_type', `${path}/type`, 'A host version has type autosave, external or system.')
	if (Object.hasOwn(record, 'parent')) validateUuid(record.parent, `${path}/parent`, v, 'Parent version id')
	validateUtcTimestamp(record.startedAt, `${path}/startedAt`, v)
	if (typeof record.netChange !== 'boolean')
		v.issue('history.invalid_net_change', `${path}/netChange`, 'netChange must be a boolean.')
	const events = v.array(record.events, `${path}/events`)
	events?.forEach((event, index) => v.diagnostics.push(...validateWriteEvent(event, jsonPointer(`${path}/events`, index)).diagnostics))
	if (Object.hasOwn(record, 'restoredFrom')) validateUuid(record.restoredFrom, `${path}/restoredFrom`, v, 'Restored version id')
	if (Object.hasOwn(record, 'recordingGap') && record.recordingGap !== true)
		v.issue('history.invalid_recording_gap', `${path}/recordingGap`, 'recordingGap is present only as true.')
	return v.finish<HostVersionRecord>(input)
}

export function validateWriteEvent(input: unknown, path = ''): ValidationResult<HistoryWriteEvent> {
	const v = new Validator()
	const event = v.object(input, path)
	if (!event) return v.finish<HistoryWriteEvent>(input)
	rejectUnknownKeys(event, ['at', 'actor', 'source', 'operation', 'resource', 'beforeRevision', 'afterRevision'], path, v)
	validateUtcTimestamp(event.at, `${path}/at`, v)
	validateActor(event.actor, `${path}/actor`, v)
	validateSource(event.source, `${path}/source`, v)
	if (!isOneOf(HISTORY_WRITE_OPERATIONS, event.operation))
		v.issue('history.invalid_operation', `${path}/operation`, 'Write event operation must be one of the recorded design operations.')
	const resource = v.object(event.resource, `${path}/resource`)
	if (resource) {
		rejectUnknownKeys(resource, ['kind', 'key'], `${path}/resource`, v)
		validateResourceIdentity(resource.kind, resource.key, `${path}/resource`, v)
	}
	for (const field of ['beforeRevision', 'afterRevision'] as const) {
		if (!Object.hasOwn(event, field)) v.issue('schema.missing_field', `${path}/${field}`, `${field} is required.`)
		else if (event[field] !== null) v.string(event[field], `${path}/${field}`, true)
	}
	return v.finish<HistoryWriteEvent>(input)
}

export function validateHistoryActor(input: unknown, path = ''): ValidationResult<HistoryActor> {
	const v = new Validator()
	validateActor(input, path, v)
	return v.finish<HistoryActor>(input)
}

/** Clause 01a11a5e-2272-795d-8806-1dedf74f7e21, counted in Unicode code points. */
export function isValidCheckpointName(name: string): boolean {
	const length = codePointLength(name.trim())
	return length >= CHECKPOINT_NAME_MIN_LENGTH && length <= CHECKPOINT_NAME_MAX_LENGTH
}

export function isValidCheckpointNote(note: string): boolean {
	return codePointLength(note) <= CHECKPOINT_NOTE_MAX_LENGTH
}

/** The stored form of a requested checkpoint name: trimmed, or `undefined` when out of bounds. */
export function normalizeCheckpointName(name: string): string | undefined {
	return isValidCheckpointName(name) ? name.trim() : undefined
}

function validateBase(record: Record<string, unknown>, path: string, v: Validator): void {
	if (record.historySchemaVersion !== HISTORY_SCHEMA_VERSION)
		v.issue('history.unsupported_history_schema_version', `${path}/historySchemaVersion`, `historySchemaVersion must be ${HISTORY_SCHEMA_VERSION}.`)
	validateUuid(record.id, `${path}/id`, v, 'Version id')
	validateActor(record.actor, `${path}/actor`, v)
	validateUtcTimestamp(record.at, `${path}/at`, v)
	if (typeof record.workspaceSchemaVersion !== 'number' || !Number.isInteger(record.workspaceSchemaVersion) || record.workspaceSchemaVersion < 1)
		v.issue('schema.expected_positive_integer', `${path}/workspaceSchemaVersion`, 'Expected a positive integer.')
	validateResources(record.resources, `${path}/resources`, v)
	if (Object.hasOwn(record, 'adapters')) {
		const adapters = v.array(record.adapters, `${path}/adapters`)
		adapters?.forEach((adapter, index) => {
			if (!isJsonObject(adapter))
				v.issue('schema.invalid_json_object', jsonPointer(`${path}/adapters`, index), 'Expected a JSON-compatible object.')
		})
	}
	if (Object.hasOwn(record, 'productKit') && !isJsonObject(record.productKit))
		v.issue('schema.invalid_json_object', `${path}/productKit`, 'Expected a JSON-compatible object.')
}

function validateResources(input: unknown, path: string, v: Validator): void {
	const resources = v.array(input, path)
	if (!resources) return
	const identities = new Set<string>()
	const filePaths = new Set<string>()
	resources.forEach((value, index) => {
		const resourcePath = jsonPointer(path, index)
		const resource = v.object(value, resourcePath)
		if (!resource) return
		rejectUnknownKeys(resource, ['kind', 'key', 'revision', 'files'], resourcePath, v)
		if (validateResourceIdentity(resource.kind, resource.key, resourcePath, v)) {
			const identity = `${resource.kind}\0${resource.key}`
			if (identities.has(identity))
				v.issue('history.duplicate_resource', resourcePath, 'A version lists each resource once.')
			identities.add(identity)
		}
		v.string(resource.revision, `${resourcePath}/revision`, true)
		const files = v.object(resource.files, `${resourcePath}/files`)
		if (!files) return
		const entries = Object.entries(files)
		if (entries.length === 0)
			v.issue('history.empty_resource_files', `${resourcePath}/files`, 'A versioned resource has at least one file.')
		for (const [filePath, digest] of entries) {
			const pointer = jsonPointer(`${resourcePath}/files`, filePath)
			if (!isSafeRelativePath(filePath))
				v.issue('history.invalid_file_path', pointer, 'Expected a Workspace-relative path without traversal.')
			else if (filePaths.has(filePath))
				v.issue('history.duplicate_file', pointer, 'A file belongs to one resource only.')
			filePaths.add(filePath)
			validateDigest(digest, pointer, v)
		}
	})
}

/** Known kinds check their canonical key; any other non-empty kind is accepted with a non-empty key. */
function validateResourceIdentity(kind: unknown, key: unknown, path: string, v: Validator): boolean {
	if (typeof kind !== 'string' || kind.length === 0) {
		v.issue('history.invalid_resource_kind', `${path}/kind`, 'Resource kind must be a non-empty string.')
		return false
	}
	let valid: boolean
	if (isOneOf(SINGLETON_HISTORY_RESOURCE_KINDS, kind)) valid = key === kind
	else if (kind === 'view' || kind === 'flow' || kind === 'asset') valid = isFullUuid(key)
	else if (kind === 'locale') valid = isCanonicalLocaleTag(key)
	else valid = typeof key === 'string' && key.length > 0
	if (!valid)
		v.issue('history.invalid_resource_key', `${path}/key`, `Resource key is not the canonical key of a ${kind} resource.`)
	return valid
}

function validateActor(input: unknown, path: string, v: Validator): void {
	const actor = v.object(input, path)
	if (!actor) return
	rejectUnknownKeys(actor, ['type', 'id', 'displayName'], path, v)
	if (Object.hasOwn(actor, 'displayName')) v.string(actor.displayName, `${path}/displayName`)
	switch (actor.type) {
		case 'human':
		case 'agent':
			v.string(actor.id, `${path}/id`, true)
			if (!Object.hasOwn(actor, 'displayName')) v.issue('history.unstamped_actor', `${path}/displayName`, 'A human or Agent actor is a stamped actor with an id and a display name.')
			return
		case 'system':
			if (!isOneOf(HISTORY_SYSTEM_ACTOR_IDS, actor.id))
				v.issue('history.invalid_system_actor', `${path}/id`, `A system actor id is ${HISTORY_SYSTEM_ACTOR_IDS.join(' or ')}.`)
			return
		case 'external':
			if (Object.hasOwn(actor, 'id')) v.issue('history.external_actor_id', `${path}/id`, 'An external actor has no id.')
			return
		default:
			v.issue('history.invalid_actor_type', `${path}/type`, `Actor type must be ${HISTORY_ACTOR_TYPES.join(', ')}.`)
	}
}

function validateSource(value: unknown, path: string, v: Validator): void {
	if (!isOneOf(HISTORY_SOURCES, value))
		v.issue('history.invalid_source', path, `Source must be ${HISTORY_SOURCES.join(', ')}.`)
}

/** Clause 01a11a5e-22ca-756e-8128-8f730ca887c9: a system checkpoint carries its fixed name. */
function validateSystemCheckpointName(record: Record<string, unknown>, path: string, v: Validator): void {
	const actorId = isRecord(record.actor) && record.actor.type === 'system' ? record.actor.id : undefined
	if (actorId === 'system:baseline' && record.name !== BASELINE_CHECKPOINT_NAME)
		v.issue('history.invalid_system_checkpoint_name', `${path}/name`, `The first-start system checkpoint is named ${BASELINE_CHECKPOINT_NAME}.`)
	if (actorId === 'system:migrate' && (typeof record.name !== 'string' || !MIGRATION_CHECKPOINT_NAME.test(record.name)))
		v.issue('history.invalid_system_checkpoint_name', `${path}/name`, 'The migration system checkpoint is named Before migration to schemaVersion <N>.')
}

function isSafeRelativePath(path: string): boolean {
	return path.length > 0
		&& !path.includes('\\')
		&& !hasAsciiControlCharacter(path)
		&& path.split('/').every(segment => segment.length > 0 && segment !== '.' && segment !== '..')
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === 'string' && (values as readonly string[]).includes(value)
}

function codePointLength(value: string): number {
	return [...value].length
}
