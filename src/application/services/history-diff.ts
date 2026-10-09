import type { HistoryVersionType } from '../../domain/history/constants'
import { diffResource, isDiffableResourceKind, jsonEqual, omit, type ResourceDiff, type ResourceFile, type ResourceFiles } from '../../domain/history/diff'
import type { HistoryResourceEntry, HistoryResourceIdentity, VersionRecord } from '../../domain/history/schema'
import { resourceIdentityKey, summarizeResourceChanges, type ResourceChangeSummary } from '../../domain/history/summary'
import { isFullUuid, type Diagnostic, type JsonValue } from '../../domain/validation'
import { PersistenceError } from '../../persistence/errors'
import { upgradeSnapshotInMemory, type FileNativePersistence } from '../../persistence/file-native'
import type { CheckpointStore } from '../../persistence/history/checkpoint-store'
import { blobDigest, HostHistoryError, type HostHistoryStore } from '../../persistence/history/host-store'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { mergeTimeline, type TimelineVersion } from '../../persistence/history/timeline'
import { artifactRelativePath, LEGACY_LAYOUT } from '../../persistence/paths'

/** The selected Workspace's history stores, or `undefined` where history is off (`uiux publish`). */
export type HistoryStoreSource = Readonly<{
	open(): Promise<Readonly<{ host?: HostHistoryStore; checkpoints?: CheckpointStore }> | undefined>
}>

export const VERSION_DIFF_DETAILS = Object.freeze(['summary', 'semantic'] as const)
export type VersionDiffDetail = typeof VERSION_DIFF_DETAILS[number]

/** The `to` value that names the Workspace's current files. */
export const CURRENT_VERSION_SELECTOR = 'current'

/**
 * A comparison request (Clause 01a11a5e-2710-70b7-b63b-82f27236b1cd for MCP). `from` is a version
 * ID, or `{ parentOf }` for that version's parent: its predecessor on the merged timeline (Rule
 * 01a11e0d-d550-78e4-9787-f0023bbc1b93); `to` then defaults to that version. `to` is otherwise a
 * version ID or `current` (the default).
 */
export type DiffVersionsCommand = Readonly<{
	from: string | Readonly<{ parentOf: string }>
	to?: string
	resources?: readonly HistoryResourceIdentity[]
	detail?: VersionDiffDetail
}>

export type ComparedVersion = Readonly<{
	id: string
	type: HistoryVersionType
	at: string
	name?: string
	/** The schema version the side was recorded under; it is upgraded in memory before comparing. */
	workspaceSchemaVersion: number
}>

export type ComparedCurrent = Readonly<{ id: typeof CURRENT_VERSION_SELECTOR; workspaceSchemaVersion: number }>

export type ResourceSemanticChange = Readonly<{
	kind: string
	key: string
	status: Exclude<ResourceChangeSummary['status'], 'unchanged'>
	diff: ResourceDiff
}>

export type VersionDiffResult = Readonly<{
	status: 'compared'
	/** `null` when the compared version has no parent: every resource it holds is `added`. */
	from: ComparedVersion | null
	to: ComparedVersion | ComparedCurrent
	/** Every compared resource with its status (Clause 01a11a5e-23cd-718c-b4db-807f823238ed), by kind then key. */
	summary: readonly ResourceChangeSummary[]
	/** With `detail: "semantic"`: the diff of every resource that is not `unchanged`, in summary order. */
	changes?: readonly ResourceSemanticChange[]
}>

export type VersionDiffRefusal = Readonly<{
	status: 'invalid' | 'not_found' | 'blocked' | 'failed'
	code: string
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type VersionDiffOutcome = VersionDiffResult | VersionDiffRefusal

export type HistoryDiffService = Readonly<{
	diffVersions(command: DiffVersionsCommand): Promise<VersionDiffOutcome>
}>

type Request = Readonly<{
	from: Readonly<{ version: string } | { parentOf: string }>
	to: string
	resources?: ReadonlySet<string>
	detail: VersionDiffDetail
}>

/** One side of a comparison as read under the lock. */
type LoadedSide = Readonly<{
	ref: ComparedVersion | ComparedCurrent
	schemaVersion: number
	/** The recorded resources (for `current`, the ones computed from its files). */
	resources: readonly HistoryResourceEntry[]
	/** The bytes read for this side, by Workspace-relative path. */
	bytes: ReadonlyMap<string, Uint8Array>
	/** True when every file of every resource this build can diff was read, so the side can be upgraded. */
	complete: boolean
}>

/** A side ready to compare: decoded under one schema version, the policy's current one when upgraded. */
type PreparedSide = Readonly<{
	/** Revisions by identity after any in-memory upgrade. */
	revisions: ReadonlyMap<string, string>
	files: ReadonlyMap<string, ResourceFiles>
}>

/**
 * Version comparison (Feature 01a11a5d-fd13-7f52-918c-af3a73e5bb6e), computed on the server so the
 * Workbench and Agents get the same answer (Rule 01a11a5e-0ddc-7d9d-83b9-5366d0ac44dd).
 *
 * The timeline, the version files and the current files are read under one persistence read lock,
 * so the comparison sees one consistent state; the diff itself is computed after the lock is
 * released. A side recorded under an older schema version is upgraded in memory with the migration
 * steps first (Rule 01a11a5e-118c-733d-92d7-27262bfbcd33), and a side whose schema version this build
 * does not recognize is refused with `workspace.schema_unsupported` (Clause
 * 01a11a5e-2434-7342-a3c1-6d63aa74334c). Comparing works in every Workspace schema state (Rule
 * 01a11a5e-07c1-70d6-b4fb-69c99be791e3); only a `current` side needs the live schema recognized.
 */
export function createHistoryDiffService(persistence: FileNativePersistence, history: HistoryStoreSource | undefined): HistoryDiffService {
	const policy = persistence.schemaPolicy

	async function diffVersions(command: DiffVersionsCommand): Promise<VersionDiffOutcome> {
		const request = parseRequest(command)
		if ('status' in request) return request
		let stores: Awaited<ReturnType<HistoryStoreSource['open']>>
		try {
			stores = await history?.open()
		}
		catch (error) {
			if (error instanceof HostHistoryError) return failed(error)
			throw error
		}
		const loaded = await persistence.withReadLock(async (): Promise<Readonly<{ from?: LoadedSide; to: LoadedSide }> | VersionDiffRefusal> => {
			try {
				return await loadSides(request, stores)
			}
			catch (error) {
				if (error instanceof HostHistoryError) return failed(error)
				throw error
			}
		})
		if ('status' in loaded) return loaded
		return compare(request, loaded.from, loaded.to)
	}

	/** Resolves both sides on the merged timeline and reads the files the comparison needs. Runs under the read lock. */
	async function loadSides(request: Request, stores: Awaited<ReturnType<HistoryStoreSource['open']>>): Promise<Readonly<{ from?: LoadedSide; to: LoadedSide }> | VersionDiffRefusal> {
		const timeline = mergeTimeline(await stores?.host?.listVersions(), await stores?.checkpoints?.listUnlocked())
		const byId = new Map(timeline.versions.map(entry => [entry.version.id, entry]))
		const find = (id: string, path: string): TimelineVersion | VersionDiffRefusal =>
			byId.get(id) ?? refusal('not_found', 'history.record_missing', path, `Version ${id} does not exist.`)

		let fromVersion: VersionRecord | undefined
		let toVersion: VersionRecord | undefined
		if ('parentOf' in request.from) {
			const entry = find(request.from.parentOf, '/from/parentOf')
			if ('status' in entry) return entry
			toVersion = entry.version
			fromVersion = entry.predecessor === undefined ? undefined : byId.get(entry.predecessor)?.version
		}
		else {
			const entry = find(request.from.version, '/from')
			if ('status' in entry) return entry
			fromVersion = entry.version
			if (request.to !== CURRENT_VERSION_SELECTOR) {
				const target = find(request.to, '/to')
				if ('status' in target) return target
				toVersion = target.version
			}
		}

		for (const [version, path] of [[fromVersion, '/from'], [toVersion, '/to']] as const) {
			if (version && !policy.recognizedVersions.includes(version.workspaceSchemaVersion))
				return refusal('blocked', 'workspace.schema_unsupported', path, `Version ${version.id} was recorded under Workspace schemaVersion ${version.workspaceSchemaVersion}, which this UIUX build does not recognize.`)
		}
		let current: Readonly<{ schemaVersion: number; snapshot: Map<string, Uint8Array> }> | undefined
		if (!toVersion) {
			const schemaVersion = await persistence.readDecodeSchemaVersionUnlocked()
			if (!policy.recognizedVersions.includes(schemaVersion))
				return refusal('blocked', 'workspace.schema_unsupported', '/to', `The current Workspace uses schemaVersion ${schemaVersion}, which this UIUX build does not recognize.`)
			current = { schemaVersion, snapshot: await persistence.scanVersionedSnapshotUnlocked() }
		}

		const toResources = toVersion ? toVersion.resources : versionResourcesFromSnapshot(current!.snapshot, LEGACY_LAYOUT).resources
		const toSchemaVersion = toVersion ? toVersion.workspaceSchemaVersion : current!.schemaVersion
		const crossSchema = fromVersion !== undefined && fromVersion.workspaceSchemaVersion !== toSchemaVersion
		const candidates = changedCandidates(fromVersion?.resources ?? [], toResources, request.resources)
		const plan = (schemaVersion: number) => ({
			all: crossSchema || (request.detail === 'semantic' && schemaVersion !== policy.currentVersion),
			some: request.detail === 'semantic' ? candidates : new Set<string>(),
		})

		const readSide = async (version: VersionRecord): Promise<LoadedSide | VersionDiffRefusal> => {
			const { all, some } = plan(version.workspaceSchemaVersion)
			const bytes = new Map<string, Uint8Array>()
			for (const resource of version.resources) {
				if (!isDiffableResourceKind(resource.kind) || !(all || some.has(resourceIdentityKey(resource)))) continue
				for (const [path, digest] of Object.entries(resource.files)) {
					const blob = await readBlobUnlocked(stores, digest)
					if (!blob) return refusal('failed', 'history.blob_missing', '/', `Version ${version.id} names file ${path} (${digest}), whose content is no longer stored.`)
					bytes.set(path, blob)
				}
			}
			return { ref: versionRef(version), schemaVersion: version.workspaceSchemaVersion, resources: version.resources, bytes, complete: all }
		}

		const from = fromVersion ? await readSide(fromVersion) : undefined
		if (from && 'status' in from) return from
		if (toVersion) {
			const to = await readSide(toVersion)
			return 'status' in to ? to : { ...(from ? { from } : {}), to }
		}
		return {
			...(from ? { from } : {}),
			to: { ref: { id: CURRENT_VERSION_SELECTOR, workspaceSchemaVersion: current!.schemaVersion }, schemaVersion: current!.schemaVersion, resources: toResources, bytes: current!.snapshot, complete: true },
		}
	}

	/** Reads a version blob from the host store or the artifact store, checking its digest. */
	async function readBlobUnlocked(stores: Awaited<ReturnType<HistoryStoreSource['open']>>, digest: string): Promise<Uint8Array | undefined> {
		const hosted = await stores?.host?.readBlob(digest)
		if (hosted) return hosted
		let path: string
		try { path = artifactRelativePath(digest) }
		catch { return undefined }
		const bytes = await persistence.readOptionalBytesUnlocked(path)
		if (!bytes) return undefined
		if (blobDigest(bytes) !== digest)
			throw new HostHistoryError('history.blob_corrupt', `Stored blob ${digest} does not match its content digest.`)
		return Uint8Array.from(bytes)
	}

	async function compare(request: Request, from: LoadedSide | undefined, to: LoadedSide): Promise<VersionDiffOutcome> {
		let before: PreparedSide | undefined
		let after: PreparedSide
		try {
			before = from ? await prepare(from) : undefined
			after = await prepare(to)
		}
		catch (error) {
			if (error instanceof PersistenceError)
				return { status: 'blocked', code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
			throw error
		}
		const crossSchema = from !== undefined && from.schemaVersion !== to.schemaVersion
		const summary = summarizeResourceChanges(from?.resources, to.resources)
			.filter(row => !request.resources || request.resources.has(resourceIdentityKey(row)))
			.map((row): ResourceChangeSummary => {
				// Within one schema version the recorded revisions decide, whatever the detail: only a
				// comparison across a migration can show differences the migration alone made.
				if (row.status !== 'modified' || !before || !crossSchema) return row
				const identity = resourceIdentityKey(row)
				const upgradedBefore = before.revisions.get(identity)
				if (upgradedBefore !== undefined && upgradedBefore === after.revisions.get(identity)) return { ...row, status: 'unchanged' }
				if (row.kind === 'workspace' && sameSettings(before.files.get(identity), after.files.get(identity))) return { ...row, status: 'unchanged' }
				return row
			})
		if (request.detail !== 'semantic') return { status: 'compared', from: from ? from.ref as ComparedVersion : null, to: to.ref, summary }
		const changes: ResourceSemanticChange[] = []
		for (const row of summary) {
			if (row.status === 'unchanged') continue
			const identity = resourceIdentityKey(row)
			changes.push({ kind: row.kind, key: row.key, status: row.status, diff: diffResource(row.kind, before?.files.get(identity), after.files.get(identity)) })
		}
		return { status: 'compared', from: from ? from.ref as ComparedVersion : null, to: to.ref, summary, changes }
	}

	/**
	 * Groups a side's files by resource. A complete side recorded under an older schema version is
	 * first upgraded in memory with the policy's migration steps; resources of kinds the layout does
	 * not place in the Workspace snapshot keep their recorded files.
	 */
	async function prepare(side: LoadedSide): Promise<PreparedSide> {
		const files = new Map<string, ResourceFiles>()
		const revisions = new Map<string, string>()
		const fromRecord = (resource: HistoryResourceEntry, bytes: ReadonlyMap<string, Uint8Array>) => {
			const identity = resourceIdentityKey(resource)
			revisions.set(identity, resource.revision)
			const resourceFiles = new Map<string, ResourceFile>()
			for (const [path, digest] of Object.entries(resource.files)) {
				const content = bytes.get(path)
				resourceFiles.set(path, content ? { digest, bytes: content } : { digest })
			}
			files.set(identity, resourceFiles)
		}
		if (!side.complete || side.schemaVersion === policy.currentVersion) {
			for (const resource of side.resources) fromRecord(resource, side.bytes)
			return { revisions, files }
		}
		const snapshot = new Map<string, Uint8Array>()
		const placed = new Set<string>()
		for (const resource of side.resources) {
			for (const path of Object.keys(resource.files)) {
				const bytes = side.bytes.get(path)
				if (!bytes || !LEGACY_LAYOUT.classifyVersionedPath(path)) continue
				snapshot.set(path, bytes)
				placed.add(resourceIdentityKey(resource))
			}
		}
		const upgraded = await upgradeSnapshotInMemory(snapshot, side.schemaVersion, policy)
		const regrouped = versionResourcesFromSnapshot(upgraded.snapshot, LEGACY_LAYOUT)
		for (const resource of regrouped.resources) fromRecord(resource, upgraded.snapshot)
		for (const resource of side.resources) if (!placed.has(resourceIdentityKey(resource))) fromRecord(resource, side.bytes)
		return { revisions, files }
	}

	return Object.freeze({ diffVersions })
}

/** Resources whose presence or recorded revision differs between the sides, within the requested set. */
function changedCandidates(from: readonly HistoryResourceEntry[], to: readonly HistoryResourceEntry[], requested: ReadonlySet<string> | undefined): Set<string> {
	const candidates = new Set<string>()
	for (const row of summarizeResourceChanges(from, to)) {
		const identity = resourceIdentityKey(row)
		if (row.status !== 'unchanged' && (!requested || requested.has(identity))) candidates.add(identity)
	}
	return candidates
}

/** The two manifests' settings are equal once `schemaVersion` is left out (Rule 01a11a5e-1085-71ec-ac82-d60263ae8173). */
function sameSettings(before: ResourceFiles | undefined, after: ResourceFiles | undefined): boolean {
	const left = singleJson(before)
	const right = singleJson(after)
	return left !== undefined && right !== undefined && jsonEqual(omit(left, ['schemaVersion']), omit(right, ['schemaVersion']))
}

function singleJson(files: ResourceFiles | undefined): JsonValue | undefined {
	const bytes = files && files.size === 1 ? [...files.values()][0]!.bytes : undefined
	if (!bytes) return undefined
	try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as JsonValue }
	catch { return undefined }
}

function versionRef(version: VersionRecord): ComparedVersion {
	return {
		id: version.id,
		type: version.type,
		at: version.at,
		...(version.type === 'checkpoint' ? { name: version.name } : {}),
		workspaceSchemaVersion: version.workspaceSchemaVersion,
	}
}

function parseRequest(command: DiffVersionsCommand): Request | VersionDiffRefusal {
	const diagnostics: Diagnostic[] = []
	const issue = (path: string, message: string) => diagnostics.push({ code: 'history.invalid_comparison', path, message })
	let from: Request['from'] | undefined
	const raw = command as Readonly<Record<string, unknown>>
	if (typeof raw.from === 'string') {
		if (isFullUuid(raw.from)) from = { version: raw.from }
		else issue('/from', 'from must be a version ID.')
	}
	else if (raw.from !== null && typeof raw.from === 'object' && isFullUuid((raw.from as Record<string, unknown>).parentOf)) {
		from = { parentOf: (raw.from as { parentOf: string }).parentOf }
	}
	else {
		issue('/from', 'from must be a version ID.')
	}
	let to: string = CURRENT_VERSION_SELECTOR
	if (from && 'parentOf' in from) {
		if (raw.to !== undefined && raw.to !== from.parentOf) issue('/to', 'Comparing a version with its parent compares to that version.')
		to = from.parentOf
	}
	else if (raw.to !== undefined) {
		if (raw.to === CURRENT_VERSION_SELECTOR || isFullUuid(raw.to)) to = raw.to as string
		else issue('/to', 'to must be a version ID or current.')
	}
	let resources: Set<string> | undefined
	if (raw.resources !== undefined) {
		if (!Array.isArray(raw.resources)) issue('/resources', 'resources must be a list of { kind, key }.')
		else {
			resources = new Set()
			raw.resources.forEach((resource: unknown, index) => {
				const value = resource as Record<string, unknown> | null
				if (value === null || typeof value !== 'object' || typeof value.kind !== 'string' || value.kind.length === 0 || typeof value.key !== 'string' || value.key.length === 0)
					issue(`/resources/${index}`, 'Each resource is { kind, key } with non-empty strings.')
				else resources!.add(resourceIdentityKey({ kind: value.kind, key: value.key }))
			})
		}
	}
	const detail = raw.detail ?? 'summary'
	if (!(VERSION_DIFF_DETAILS as readonly unknown[]).includes(detail)) issue('/detail', 'detail must be summary or semantic.')
	if (diagnostics.length > 0 || !from)
		return { status: 'invalid', code: 'history.invalid_comparison', message: 'The comparison request is not valid.', diagnostics }
	return { from, to, ...(resources ? { resources } : {}), detail: detail as VersionDiffDetail }
}

function refusal(status: VersionDiffRefusal['status'], code: string, path: string, message: string): VersionDiffRefusal {
	return { status, code, message, diagnostics: [{ code, path, message }] }
}

function failed(error: HostHistoryError): VersionDiffRefusal {
	return { status: 'failed', code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
}
