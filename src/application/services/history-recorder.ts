import { randomUUID } from 'node:crypto'

import {
	AUTOSAVE_IDLE_MS,
	AUTOSAVE_MAX_EVENTS,
	AUTOSAVE_MAX_SPAN_MS,
	BASELINE_CHECKPOINT_NAME,
	HISTORY_SCHEMA_VERSION,
	HOST_PRUNE_INTERVAL_MS,
	migrationCheckpointName,
} from '../../domain/history/constants'
import type { HistoryActor, HistoryResourceEntry, HistoryWriteEvent, HostVersionRecord } from '../../domain/history/schema'
import { resourceIdentityKey } from '../../domain/history/summary'
import type { CanonicalResourceBefore, CanonicalResourceChange, CanonicalWriteObserver, FileNativePersistence } from '../../persistence/file-native'
import type { CheckpointStore } from '../../persistence/history/checkpoint-store'
import { HostHistoryError, type HostHistoryStore, type HostVersionListing, type OpenAutosaveJournal } from '../../persistence/history/host-store'
import { compareCodeUnits } from '../../persistence/history/order'
import { pruneHostHistory, type HostPruneResult } from '../../persistence/history/retention'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { writeSnapshotCheckpointUnlocked } from '../../persistence/history/snapshot-checkpoint'
import { mergeTimeline } from '../../persistence/history/timeline'
import { outsideDesignWriteContext, type DesignWriteContext } from '../../persistence/history/write-context'

/**
 * The autosave recorder of the Workspace version timeline (Feature 01a11a5d-fc56-7e10-9d16-9d333aa2995c).
 *
 * It observes every committed design write (persistence's `CanonicalWriteObserver`, called under
 * the exclusive lock only while a design-write context is set) and groups the write events into
 * autosaves, one actor each, kept in the host `open.json` journal while open. A boundary closes
 * the open autosave:
 *
 * - a design write by a different actor (Rule 01a11a5d-ff72-7fbb-886f-d1f56f321e98);
 * - the idle period, the span cap or the event cap (Rules 01a11a5d-ffc6-…, 01a11a5e-0018-…, Clause 01a11a5e-2320-…);
 * - the writing Agent's `release_lock` with no arguments ({@link HistoryRecorder.agentReleased}, Rule 01a11a5e-0068-…);
 * - the start of a Checkpoint or a restore ({@link HistoryRecorder.closeOpenAutosave}; a write whose
 *   context names `restoredFrom` is closed before and after, so the restore stands alone, Rule 01a11a5e-00b9-…);
 * - server shutdown (best-effort) or else the next server start (Rule 01a11a5e-010b-…).
 *
 * Every boundary then rescans the versioned files under the lock and records what the events do
 * not explain as a separate external version (Rules 01a11a5e-01b5-… and 01a11a5e-0313-…), flagged
 * `recordingGap` when a recording failure was reported since the last boundary (Rule 01a11a5e-03c9-…).
 * A write whose resource no longer has the revision the recorder last saw is such an unexplained
 * change too: the boundary runs before that write, so the change is never folded into an event.
 *
 * Recording never fails a write (Rule 01a11a5e-036d-…): persistence catches hook failures, bounds
 * each hook in time and flags the gap. A hook abandoned at that bound keeps running without the
 * lock, so the recorder refuses new work (the hook fails fast, flagging a gap) until it settles.
 *
 * Timers are created outside any design-write context, so the work they do later is never
 * attributed to the write that armed them. The boundaries are the fixed Contract values (Rule
 * 01a11a5e-015f-…); only the clock is injectable, for tests.
 */
export type HistoryRecorderStores = Readonly<{ host: HostHistoryStore; checkpoints: CheckpointStore }>

export type HistoryRecorderClock = Readonly<{
	now(): number
	setTimeout(callback: () => void, milliseconds: number): unknown
	clearTimeout(handle: unknown): void
}>

export type AutosaveCloseReason =
	| 'actor_change'
	| 'idle'
	| 'max_span'
	| 'max_events'
	| 'agent_release'
	| 'checkpoint'
	| 'restore'
	| 'shutdown'
	| 'leftover'
	| 'start'
	| 'drift'
	| 'recording_gap'
	| 'migration'

/** What one boundary recorded: the closed autosave and the external version, when either was written. */
export type HistoryBoundaryReport = Readonly<{ reason: AutosaveCloseReason; autosave?: string; external?: string }>

export type HistoryStartReport = Readonly<{
	/** False when history is disabled (the internal `uiux publish` server) or could not start. */
	enabled: boolean
	/** The Baseline Checkpoint written because this host had no history for the Workspace. */
	baseline?: string
	/** The file name a corrupt `open.json` was moved to. */
	quarantined?: string
	/** The start boundary: the leftover autosave it closed and the external version it recorded. */
	boundary?: HistoryBoundaryReport
	pruned?: HostPruneResult
}>

export interface HistoryRecorder {
	/** The hooks persistence calls; attached by {@link start} and detached by {@link stop}. */
	readonly observer: CanonicalWriteObserver
	/** Closes a leftover autosave, detects drift, writes the Baseline when needed, prunes, then records. */
	start(): Promise<HistoryStartReport>
	/** Best-effort shutdown boundary; stops timers and recording. */
	stop(): Promise<void>
	/** `release_lock` with no arguments: closes the open autosave when this Agent wrote it. Never throws. */
	agentReleased(actor: HistoryActor): Promise<void>
	/** A boundary taken under the persistence lock (Checkpoint creation, restore). Resolves `undefined` while not recording. */
	closeOpenAutosave(reason: AutosaveCloseReason): Promise<HistoryBoundaryReport | undefined>
	/** The same boundary for a caller that already holds the exclusive persistence lock. */
	closeOpenAutosaveUnlocked(reason: AutosaveCloseReason): Promise<HistoryBoundaryReport | undefined>
	/**
	 * A version timestamp strictly after every version the recorder knows, for a caller (Checkpoint
	 * creation) that records a version right after a boundary, under the same lock.
	 */
	nextVersionAt(after?: string): string
	/**
	 * True while {@link start} has not finished its start boundary. A Checkpoint taken then would
	 * skip drift detection (Rule 01a11a5e-0313-7d86-af79-8eafa1753853), so the caller refuses it
	 * instead of waiting for start while it holds the lock.
	 */
	readonly starting: boolean
	/** Prunes host history now (also run at start and once a day). */
	prune(): Promise<HostPruneResult | undefined>
	/** The id of the open autosave, if any. */
	readonly openAutosaveId: string | undefined
}

export type HistoryRecorderOptions = Readonly<{
	persistence: FileNativePersistence
	/** Opens the history stores; resolves `undefined` when history is disabled. */
	stores: () => Promise<HistoryRecorderStores | undefined>
	clock?: HistoryRecorderClock
	/** Bound on the lock-holding work the recorder starts itself (timers, release, shutdown). */
	operationTimeoutMilliseconds?: number
	log?: (message: string) => void
}>

/** What `uiux migrate` recorded before its first step. */
export type MigrationCheckpointReport = Readonly<{
	/** The id of the pre-migration system Checkpoint. */
	checkpoint: string
	/** The boundary taken first: the leftover autosave it closed and the external version it recorded. */
	boundary: HistoryBoundaryReport
	/** The file name a corrupt `open.json` was moved to. */
	quarantined?: string
}>

/**
 * History for `uiux migrate` (Rules 01a11a5e-0b23-7d4f-954a-26fcde4a8014 and
 * 01a11a5e-0422-78fe-b28b-d877417932e9, Clauses 01a1144e-5605-722c-a662-2b483ddaad73 and
 * 01a11a5e-22ca-756e-8128-8f730ca887c9). Both methods run under the migration's exclusive
 * persistence lock and outside every step; no server is involved and no observer is attached.
 */
export interface MigrationHistoryRecorder {
	/**
	 * Before any step: closes a leftover autosave the host journal holds (a server that crashed or
	 * lost its shutdown), records changes made outside UIUX as an external version, then writes the
	 * Checkpoint `Before migration to schemaVersion <targetSchemaVersion>` with the actor
	 * `system:migrate` and the source `cli`. It works while the Workspace needs migration.
	 */
	beforeMigrationUnlocked(targetSchemaVersion: number): Promise<MigrationCheckpointReport>
	/** After the migration committed: records its changes as one `system:migrate` system version and returns its id. */
	afterMigrationUnlocked(): Promise<string>
}

export type MigrationHistoryRecorderOptions = Readonly<{
	persistence: FileNativePersistence
	/** Opens the history stores; resolves `undefined` when history is disabled, which refuses the migration's history. */
	stores: () => Promise<HistoryRecorderStores | undefined>
	clock?: HistoryRecorderClock
	log?: (message: string) => void
}>

export function createMigrationHistoryRecorder(options: MigrationHistoryRecorderOptions): MigrationHistoryRecorder {
	return new AutosaveRecorder(options)
}

/** Clause 01a11a5e-21c4-79f7-b6f9-4128d842c278: the actor of everything `uiux migrate` records. */
const MIGRATE_ACTOR: HistoryActor = Object.freeze({ type: 'system', id: 'system:migrate' })

/** How long a timer close that could not take the lock waits before it tries again. */
const CLOSE_RETRY_MS = 15_000
const DEFAULT_OPERATION_TIMEOUT_MS = 5_000
/** The signal of work that holds the lock for its whole run (start): it is never abandoned. */
const LOCK_HELD: AbortSignal = new AbortController().signal

type ResourceMap = Map<string, HistoryResourceEntry>

type OpenAutosave = {
	readonly id: string
	readonly actor: HistoryActor
	readonly startedAt: string
	readonly startedAtMs: number
	lastEventAtMs: number
	readonly events: HistoryWriteEvent[]
	/** The recorded state when the autosave opened, for `netChange`. */
	readonly base: ResourceMap
	restoredFrom?: string
}

const SYSTEM_CLOCK: HistoryRecorderClock = Object.freeze({
	now: () => Date.now(),
	setTimeout(callback: () => void, milliseconds: number) {
		const handle = setTimeout(callback, milliseconds)
		handle.unref?.()
		return handle
	},
	clearTimeout(handle: unknown) {
		clearTimeout(handle as ReturnType<typeof setTimeout>)
	},
})

export function createHistoryRecorder(options: HistoryRecorderOptions): HistoryRecorder {
	return new AutosaveRecorder(options)
}

/** Thrown where abandoned work notices it no longer holds the lock; everything it read is discarded. */
class RecorderAbandonedError extends Error {
	constructor() {
		super('the history recorder operation was abandoned and no longer holds the persistence lock')
		this.name = 'RecorderAbandonedError'
	}
}

function assertHeld(signal: AbortSignal): void {
	if (signal.aborted) throw new RecorderAbandonedError()
}

class RecorderBusyError extends Error {
	constructor() {
		super('the history recorder is still finishing an abandoned operation')
		this.name = 'RecorderBusyError'
	}
}

class AutosaveRecorder implements HistoryRecorder, MigrationHistoryRecorder {
	readonly observer: CanonicalWriteObserver
	private readonly persistence: FileNativePersistence
	private readonly openStores: HistoryRecorderOptions['stores']
	private readonly clock: HistoryRecorderClock
	private readonly operationTimeout: number
	private readonly log: (message: string) => void

	private phase: 'idle' | 'starting' | 'recording' | 'disabled' | 'stopped' | 'migrating' = 'idle'
	private stopping = false
	private stores?: HistoryRecorderStores
	/** The state the timeline explains: the latest version plus the open autosave's events. */
	private expected?: ResourceMap
	private open?: OpenAutosave
	private lastHostVersionId?: string
	/** The instant of the newest known version, in milliseconds. */
	private lastAtMs = 0
	/** A recording failure (or a quarantined journal) not yet recorded at a boundary. */
	private gap = false
	/** Recorder work in progress, possibly abandoned by a timeout and still running without the lock. */
	private inFlight?: symbol
	private journalQueue: Promise<void> = Promise.resolve()
	/** The pre-migration Checkpoint's time, the earliest a migration's changes can have happened. */
	private migrationStartedAt?: string
	private autosaveTimer?: unknown
	private pruneTimer?: unknown

	constructor(options: HistoryRecorderOptions) {
		this.persistence = options.persistence
		this.openStores = options.stores
		this.clock = options.clock ?? SYSTEM_CLOCK
		this.operationTimeout = options.operationTimeoutMilliseconds ?? DEFAULT_OPERATION_TIMEOUT_MS
		this.log = options.log ?? (message => console.error(message))
		this.observer = Object.freeze({
			beforeCanonicalWrite: (context: DesignWriteContext, resources: readonly CanonicalResourceBefore[], signal?: AbortSignal) => this.hook(signal, abandoned => this.beforeWrite(context, resources, abandoned)),
			afterCanonicalCommit: (context: DesignWriteContext, changes: readonly CanonicalResourceChange[], signal?: AbortSignal) => this.hook(signal, abandoned => this.afterCommit(context, changes, abandoned)),
		})
	}

	get openAutosaveId(): string | undefined {
		return this.open?.id
	}

	// ── Lifecycle ───────────────────────────────────────────────────────────────

	async start(): Promise<HistoryStartReport> {
		if (this.phase !== 'idle' || this.stopping) return { enabled: this.phase === 'recording' }
		this.phase = 'starting'
		let attached = false
		try {
			const stores = await this.openStores()
			if (!stores) {
				this.phase = 'disabled'
				return { enabled: false }
			}
			this.stores = stores
			const report = await this.persistence.withLock(async () => {
				const started = await this.startUnlocked(stores)
				if (!started.enabled) return started
				// Attached inside the lock, so no write slips in between the start boundary and recording.
				this.persistence.setWriteObserver(this.observer)
				attached = true
				this.phase = 'recording'
				return started
			})
			if (!report.enabled) {
				this.phase = 'disabled'
				return report
			}
			// A shutdown that arrived while starting found nothing to stop yet.
			if (this.stopping) await this.stop()
			else this.armPruneTimer()
			return report
		}
		catch (error) {
			if (attached) this.persistence.setWriteObserver(undefined)
			this.phase = 'disabled'
			this.log(`uiux: history recording did not start; design writes are not recorded until the next server start: ${message(error)}`)
			return { enabled: false }
		}
	}

	async stop(): Promise<void> {
		this.stopping = true
		this.clearAutosaveTimer()
		if (this.pruneTimer !== undefined) this.clock.clearTimeout(this.pruneTimer)
		this.pruneTimer = undefined
		if (this.phase !== 'recording') {
			if (this.phase === 'idle') this.phase = 'stopped'
			return
		}
		const detach = () => {
			this.persistence.setWriteObserver(undefined)
			this.phase = 'stopped'
		}
		// Nothing to close: stop without taking the lock, so shutdown touches the Workspace only when it records.
		if (!this.open && !this.inFlight) {
			detach()
			return
		}
		try {
			// Rule 01a11a5e-010b-75ae-bfd7-7e80d48e8eca: best effort; a failure leaves open.json for the next start.
			await this.persistence.withLock(async () => {
				try {
					if (this.open) await this.exclusive(signal => this.boundaryUnlocked('shutdown', signal))
				}
				finally {
					detach()
				}
			})
		}
		catch (error) {
			detach()
			this.log(`uiux: history could not close the open autosave at shutdown; the next server start closes it: ${message(error)}`)
		}
	}

	async agentReleased(actor: HistoryActor): Promise<void> {
		if (this.phase !== 'recording' || actor.type !== 'agent' || !this.open || !sameActor(this.open.actor, actor)) return
		try {
			await this.persistence.withLock(() => this.exclusive(async (signal) => {
				if (this.open && sameActor(this.open.actor, actor)) await this.boundaryUnlocked('agent_release', signal)
			}))
		}
		catch (error) {
			this.log(`uiux: history could not close the autosave on release_lock; a later boundary closes it: ${message(error)}`)
		}
	}

	async closeOpenAutosave(reason: AutosaveCloseReason): Promise<HistoryBoundaryReport | undefined> {
		if (this.phase !== 'recording') return undefined
		return this.persistence.withLock(() => this.closeOpenAutosaveUnlocked(reason))
	}

	/**
	 * For B4 and B6: this boundary is bounded by the operation timeout. When it times out it is
	 * abandoned and rejects, but a host version write already in flight (the autosave, or an external
	 * version from a rescan finished under the lock) can still land later, after the caller has gone
	 * on (for example after the caller's Checkpoint write). Nothing it reads after the abandonment is
	 * used and it never consumes the gap; the next boundary under the lock records what it left as an
	 * external version with `recordingGap`. Callers must tolerate that ordering, or refuse their own
	 * write on rejection.
	 */
	async closeOpenAutosaveUnlocked(reason: AutosaveCloseReason): Promise<HistoryBoundaryReport | undefined> {
		if (this.phase !== 'recording') return undefined
		return this.exclusive(signal => this.boundaryUnlocked(reason, signal))
	}

	/** `after` is the newest version time the caller knows of; the stamp is later than it and than every version the recorder knows. */
	nextVersionAt(after?: string): string {
		const afterMs = after === undefined ? Number.NaN : Date.parse(after)
		if (Number.isFinite(afterMs)) this.lastAtMs = Math.max(this.lastAtMs, afterMs)
		return this.stamp()
	}

	get starting(): boolean {
		return this.phase === 'starting'
	}

	async prune(): Promise<HostPruneResult | undefined> {
		const stores = this.stores
		if (!stores || this.phase !== 'recording') return undefined
		// Pruning changes no recorded state, so an abandoned prune marks no gap.
		return this.persistence.withLock(() => this.exclusive(() => this.pruneUnlocked(stores), undefined, false))
	}

	// ── Start ───────────────────────────────────────────────────────────────────

	/**
	 * Known risk (review finding L4, not addressed): this runs once per start under the exclusive
	 * lock with no time bound; the Baseline copy and the full rescan of a large Workspace can make
	 * writes that arrive meanwhile wait, up to `persistence.lock_busy`.
	 */
	private async startUnlocked(stores: HistoryRecorderStores): Promise<HistoryStartReport> {
		const { host } = stores
		// Owner ruling (https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18832873,
		// item 2): while the Workspace is not writable (migration required, unsupported schema), skip
		// the Baseline and write nothing to the host store. No design write can happen meanwhile. The
		// Baseline then follows on a later start only when the host still has no history at all, which
		// owner ruling https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18834723
		// item 2 limits to exactly that case: a real `uiux migrate` records its pre-migration Checkpoint
		// and a host system version, so after it no Baseline is written.
		try {
			await this.persistence.assertWritableUnlocked()
		}
		catch (error) {
			this.log(`uiux: history is not recorded while the Workspace is not writable: ${message(error)}`)
			return { enabled: false }
		}
		const { journal, quarantined, hostListing } = await this.loadUnlocked(stores)

		const noHostHistory = hostListing.records.length === 0 && hostListing.invalid.length === 0 && !journal && !quarantined
			&& (await host.listBlobDigests()).length === 0
		let baseline: string | undefined
		if (noHostHistory) baseline = await this.writeBaselineUnlocked(stores)

		// Without a leftover autosave the journal (gap entries, a lone begin, a cut line) is kept
		// until the start boundary below has recorded its gap; that boundary then clears it.
		let boundary = journal ? await this.closeLeftoverUnlocked(journal, hostListing) : undefined
		// Rule 01a11a5e-0313-7d86-af79-8eafa1753853: drift detection at server start.
		if (!boundary && !baseline) boundary = await this.boundaryUnlocked('start', LOCK_HELD)

		let pruned: HostPruneResult | undefined
		try {
			pruned = await this.pruneUnlocked(stores)
		}
		catch (error) {
			this.log(`uiux: history pruning failed at start; it runs again in a day: ${message(error)}`)
		}
		return {
			enabled: true,
			...(baseline ? { baseline } : {}),
			...(quarantined ? { quarantined } : {}),
			...(boundary ? { boundary } : {}),
			...(pruned ? { pruned } : {}),
		}
	}

	/**
	 * Reads the host journal (moving a corrupt one aside) and both stores, and sets the recorded state
	 * the next boundary compares with: the latest version on the merged timeline.
	 */
	private async loadUnlocked(stores: HistoryRecorderStores): Promise<Readonly<{ journal?: OpenAutosaveJournal; quarantined?: string; hostListing: HostVersionListing }>> {
		const { host, checkpoints } = stores
		let journal: OpenAutosaveJournal | undefined
		let quarantined: string | undefined
		try {
			journal = await host.readOpenJournal()
			// The append that a crash cut short may have been a gap entry (review finding L1).
			if (journal?.droppedPartialLine) this.gap = true
		}
		catch (error) {
			if (!(error instanceof HostHistoryError) || error.code !== 'history.journal_invalid') throw error
			quarantined = await host.quarantineOpenJournal(new Date(this.clock.now()))
			// The quarantined events were never closed into a version: their changes surface as an
			// external version at the next boundary, flagged as a recording gap.
			this.gap = true
			this.log(`uiux: history moved a corrupt open autosave journal aside as ${quarantined}; its changes are recorded as an external version: ${error.message}`)
		}
		const hostListing = await host.listVersions()
		const timeline = mergeTimeline(hostListing, await checkpoints.listUnlocked())
		const latest = timeline.versions.at(-1)?.version
		this.lastAtMs = latest ? Date.parse(latest.at) : 0
		this.lastHostVersionId = hostListing.records.at(-1)?.id
		this.expected = latest ? resourceMap(latest.resources) : undefined
		return { ...(journal ? { journal } : {}), ...(quarantined ? { quarantined } : {}), hostListing }
	}

	/** Closes the autosave a leftover journal holds; `undefined` when it holds none (the journal is then kept for the next boundary). */
	private async closeLeftoverUnlocked(journal: OpenAutosaveJournal, hostListing: HostVersionListing): Promise<HistoryBoundaryReport | undefined> {
		const leftover = this.reopenLeftover(journal, hostListing.records.map(record => record.id))
		if (!leftover) return undefined
		this.open = leftover
		return this.boundaryUnlocked('leftover', LOCK_HELD)
	}

	/**
	 * Rule 01a11a5e-0b79-7920-953b-288cede75df8 and Clause 01a11a5e-22ca-756e-8128-8f730ca887c9: the
	 * first start on a host with no history for this Workspace records the Baseline Checkpoint. Its
	 * blobs also go to the host store, which is what marks the host as having history from then on.
	 * The caller has checked that the Workspace is writable.
	 */
	private async writeBaselineUnlocked(stores: HistoryRecorderStores): Promise<string> {
		const record = await writeSnapshotCheckpointUnlocked({
			persistence: this.persistence,
			checkpoints: stores.checkpoints,
			host: stores.host,
			at: this.stamp(),
			actor: { type: 'system', id: 'system:baseline' },
			name: BASELINE_CHECKPOINT_NAME,
			source: 'cli',
		})
		this.expected = resourceMap(record.resources)
		return record.id
	}

	// ── Migration (`uiux migrate`, under the migration's lock) ─────────────────

	async beforeMigrationUnlocked(targetSchemaVersion: number): Promise<MigrationCheckpointReport> {
		if (this.phase !== 'idle') throw new Error('The migration history recorder runs once, on a recorder that was never started.')
		this.phase = 'migrating'
		const stores = await this.openStores()
		if (!stores) throw new Error('History is disabled, so the pre-migration Checkpoint cannot be written.')
		this.stores = stores
		const { journal, quarantined, hostListing } = await this.loadUnlocked(stores)
		// The journal's leftover autosave first, then changes made outside UIUX, so the Checkpoint
		// below follows a timeline that explains the state it records.
		const boundary = (journal ? await this.closeLeftoverUnlocked(journal, hostListing) : undefined)
			?? await this.boundaryUnlocked('migration', LOCK_HELD)
		// Clause 01a11a5e-22ca-756e-8128-8f730ca887c9; Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f: a CLI command records `cli`.
		const checkpoint = await writeSnapshotCheckpointUnlocked({
			persistence: this.persistence,
			checkpoints: stores.checkpoints,
			host: stores.host,
			at: this.stamp(),
			actor: MIGRATE_ACTOR,
			name: migrationCheckpointName(targetSchemaVersion),
			source: 'cli',
		})
		this.expected = resourceMap(checkpoint.resources)
		this.migrationStartedAt = checkpoint.at
		return { checkpoint: checkpoint.id, boundary, ...(quarantined ? { quarantined } : {}) }
	}

	async afterMigrationUnlocked(): Promise<string> {
		const stores = this.stores
		const startedAt = this.migrationStartedAt
		if (this.phase !== 'migrating' || !stores || !startedAt) throw new Error('The migration system version follows the pre-migration Checkpoint.')
		const actual = versionResourcesFromSnapshot(await this.persistence.scanVersionedSnapshotUnlocked())
		for (const [digest, bytes] of actual.blobs) {
			if (!await stores.host.hasBlob(digest)) await stores.host.putBlob(bytes)
		}
		const actualMap = resourceMap(actual.resources)
		// Rule 01a11a5e-0422-78fe-b28b-d877417932e9: the migration's changes are their own system
		// version. Migration is not a design operation, so the version carries no write event.
		const record: HostVersionRecord = {
			historySchemaVersion: HISTORY_SCHEMA_VERSION,
			id: randomUUID(),
			type: 'system',
			actor: MIGRATE_ACTOR,
			at: this.stamp(),
			workspaceSchemaVersion: await this.persistence.readDecodeSchemaVersionUnlocked(),
			resources: actual.resources,
			startedAt,
			netChange: !sameResources(this.expected ?? new Map(), actualMap),
			events: [],
			...(this.lastHostVersionId ? { parent: this.lastHostVersionId } : {}),
		}
		await stores.host.writeVersion(record)
		this.lastHostVersionId = record.id
		this.expected = actualMap
		this.phase = 'stopped'
		return record.id
	}

	/** Rebuilds the autosave a crash or a lost shutdown left open, or `undefined` when there is nothing to close. */
	private reopenLeftover(journal: OpenAutosaveJournal, existingIds: readonly string[]): OpenAutosave | undefined {
		if (journal.entries.some(entry => entry.type === 'gap')) this.gap = true
		const begin = journal.entries.find(entry => entry.type === 'begin')
		const events = journal.entries.flatMap(entry => entry.type === 'event' ? [entry] : [])
		// Already written as a version (the journal was not cleared), empty, or without a recorded
		// state to build on: the rescan at the start boundary accounts for whatever it changed.
		if (!begin || events.length === 0 || existingIds.includes(begin.id) || !this.expected) return undefined
		const base = new Map(this.expected)
		const startedAtMs = Date.parse(begin.startedAt)
		const open: OpenAutosave = {
			id: begin.id,
			actor: events[0]!.event.actor,
			startedAt: begin.startedAt,
			startedAtMs,
			lastEventAtMs: startedAtMs,
			events: [],
			base,
		}
		for (const entry of events) {
			applyEvent(this.expected, entry.event, entry.files)
			open.events.push(entry.event)
			open.lastEventAtMs = Math.max(open.lastEventAtMs, Date.parse(entry.event.at))
		}
		return open
	}

	// ── Hooks (under the exclusive lock, bounded by persistence) ───────────────

	private async beforeWrite(context: DesignWriteContext, resources: readonly CanonicalResourceBefore[], signal: AbortSignal): Promise<void> {
		if (this.phase !== 'recording') return
		const reason = this.boundaryBeforeWrite(context, resources)
		if (reason) await this.boundaryUnlocked(reason, signal)
	}

	private boundaryBeforeWrite(context: DesignWriteContext, resources: readonly CanonicalResourceBefore[]): AutosaveCloseReason | undefined {
		const now = this.clock.now()
		const open = this.open
		if (open) {
			if (!sameActor(open.actor, context.actor)) return 'actor_change'
			if (context.restoredFrom !== undefined) return 'restore'
			if (now - open.startedAtMs >= AUTOSAVE_MAX_SPAN_MS) return 'max_span'
			// The idle timer may not have fired yet (a busy lock, a late timer).
			if (now - open.lastEventAtMs >= AUTOSAVE_IDLE_MS) return 'idle'
		}
		// A reported failure means an earlier write may be unrecorded: record it now, before this write.
		if (this.gap || this.persistence.recordingGap) return 'recording_gap'
		const expected = this.expected
		if (expected && resources.some(({ resource, revision }) => (expected.get(resourceIdentityKey(resource))?.revision ?? null) !== revision)) return 'drift'
		return undefined
	}

	private async afterCommit(context: DesignWriteContext, changes: readonly CanonicalResourceChange[], signal: AbortSignal): Promise<void> {
		// While stopping, a write that was already past its before hook is still journaled, so the
		// next start closes it as the leftover autosave of its actor instead of an external change
		// (review finding L2).
		if ((this.phase !== 'recording' && !this.stopping) || changes.length === 0) return
		const { host } = this.stores!
		const now = this.clock.now()
		// Rule 01a11a5d-fec6-7394-8d38-fd10279bd752: the event stores exactly the committed bytes.
		const entries: { event: HistoryWriteEvent; files: Record<string, string | null> }[] = []
		for (const change of changes) {
			const files: Record<string, string | null> = {}
			for (const file of change.files) files[file.path] = file.bytes === null ? null : await host.putBlob(file.bytes)
			entries.push({
				event: {
					at: new Date(now).toISOString(),
					actor: context.actor,
					source: context.source,
					operation: context.operation,
					resource: { kind: change.resource.kind, key: change.resource.key },
					beforeRevision: change.beforeRevision,
					afterRevision: change.afterRevision,
				},
				files,
			})
		}
		let open = this.open
		if (!open) {
			// A journal without an open autosave in memory is the remnant of a failed earlier attempt; a
			// gap not yet recorded is carried into the new journal.
			const startedAt = new Date(now).toISOString()
			const begin = { type: 'begin' as const, id: randomUUID(), startedAt }
			const carryGap = this.gap || this.persistence.recordingGap
			await this.journal(async () => {
				await host.clearOpenJournal()
				await host.appendOpenEntry(begin)
				if (carryGap) await host.appendOpenEntry({ type: 'gap', at: startedAt })
			})
			open = { id: begin.id, actor: context.actor, startedAt, startedAtMs: now, lastEventAtMs: now, events: [], base: new Map(this.expected ?? []) }
			this.open = open
		}
		this.expected ??= new Map()
		for (const entry of entries) {
			await this.journal(() => host.appendOpenEntry({ type: 'event', event: entry.event, files: entry.files }))
			applyEvent(this.expected, entry.event, entry.files)
			open.events.push(entry.event)
		}
		open.lastEventAtMs = now
		if (context.restoredFrom !== undefined) open.restoredFrom = context.restoredFrom
		if (this.stopping) return
		if (context.restoredFrom !== undefined) {
			await this.boundaryUnlocked('restore', signal)
		}
		else if (open.events.length >= AUTOSAVE_MAX_EVENTS) {
			await this.boundaryUnlocked('max_events', signal)
		}
		else {
			this.armAutosaveTimer()
		}
	}

	// ── Boundary ────────────────────────────────────────────────────────────────

	/**
	 * Closes the open autosave (if any) with the state its events explain, then rescans the
	 * versioned files and records any unexplained difference as an external version after it.
	 * The caller holds the exclusive persistence lock while `signal` is not aborted.
	 *
	 * Owner ruling (https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18832873, item
	 * 3): once `signal` is aborted the work was abandoned and no longer holds the lock. The signal is
	 * checked after every step that waits; an abandoned boundary stops there (throwing), so it never
	 * uses a Workspace read made without the lock, never writes the external version from it and
	 * never consumes the gap. Only a host write already in flight may still land. `exclusive` then
	 * marks and journals the gap, and the next boundary under the lock records the unexplained
	 * changes as an external version (Rules 01a11a5e-01b5-7c2d-8114-15b500d543f5 and
	 * 01a11a5e-03c9-745e-b23a-bb06b600377d).
	 */
	private async boundaryUnlocked(reason: AutosaveCloseReason, signal: AbortSignal): Promise<HistoryBoundaryReport> {
		const { host } = this.stores!
		let autosave: string | undefined
		const open = this.open
		assertHeld(signal)
		if (open && open.events.length === 0) {
			// No event was ever journaled (the first append failed): there is nothing to record (review finding L3).
			this.open = undefined
			this.clearAutosaveTimer()
		}
		else if (open) {
			const resources = sortedResources(this.expected ?? new Map())
			const workspaceSchemaVersion = await this.persistence.readDecodeSchemaVersionUnlocked()
			assertHeld(signal)
			const record: HostVersionRecord = {
				historySchemaVersion: HISTORY_SCHEMA_VERSION,
				id: open.id,
				type: 'autosave',
				actor: open.actor,
				at: this.stamp(),
				workspaceSchemaVersion,
				resources,
				startedAt: open.startedAt,
				// Rule 01a11a5e-020b-7716-aa2b-a6e403c59c85: recorded even when nothing changed on net.
				netChange: !sameResources(open.base, this.expected ?? new Map()),
				events: open.events,
				...(this.lastHostVersionId ? { parent: this.lastHostVersionId } : {}),
				...(open.restoredFrom ? { restoredFrom: open.restoredFrom } : {}),
			}
			// A host write that outlives an abandonment still lands, so the state follows it either way.
			await host.writeVersion(record)
			this.open = undefined
			this.clearAutosaveTimer()
			this.lastHostVersionId = record.id
			autosave = record.id
		}
		assertHeld(signal)
		// The gap is read here and consumed only once the external version (if any) is recorded, so
		// a failure or an abandonment below leaves it for the next boundary.
		const external = await this.recordExternalUnlocked(signal, this.gap || this.persistence.recordingGap)
		if (signal.aborted) return { reason, ...(autosave ? { autosave } : {}), ...(external ? { external } : {}) }
		this.persistence.consumeRecordingGap()
		this.gap = false
		// No autosave is open after a boundary: drop the closed autosave's journal, or one holding only
		// gap entries. A failure is harmless: the next start finds the closed id already written.
		await this.journal(() => host.clearOpenJournal()).catch((error: unknown) => this.log(`uiux: history could not clear open.json after a boundary: ${message(error)}`))
		return { reason, ...(autosave ? { autosave } : {}), ...(external ? { external } : {}) }
	}

	/**
	 * Rules 01a11a5e-01b5-…, 01a11a5e-0313-… and 01a11a5e-03c9-…: the rescan after a boundary. The
	 * signal is checked after every step that waits: once it is aborted the work no longer holds the
	 * lock, so whatever it read is discarded and no state changes (owner ruling 3).
	 */
	private async recordExternalUnlocked(signal: AbortSignal, gap: boolean): Promise<string | undefined> {
		const { host } = this.stores!
		const snapshot = await this.persistence.scanVersionedSnapshotUnlocked()
		assertHeld(signal)
		const actual = versionResourcesFromSnapshot(snapshot)
		const actualMap = resourceMap(actual.resources)
		const expected = this.expected
		if (!expected) {
			// Nothing recorded to compare with (no version yet and no Baseline): start from here.
			this.expected = actualMap
			return undefined
		}
		if (sameResources(expected, actualMap)) return undefined
		for (const resource of actual.resources) {
			const known = expected.get(resourceIdentityKey(resource))
			if (known && sameResource(known, resource)) continue
			for (const digest of Object.values(resource.files)) {
				const bytes = actual.blobs.get(digest)
				if (bytes && !await host.hasBlob(digest)) await host.putBlob(bytes)
			}
			assertHeld(signal)
		}
		const workspaceSchemaVersion = await this.persistence.readDecodeSchemaVersionUnlocked()
		assertHeld(signal)
		const windowStart = this.lastAtMs > 0 ? new Date(this.lastAtMs).toISOString() : undefined
		const at = this.stamp()
		const record: HostVersionRecord = {
			historySchemaVersion: HISTORY_SCHEMA_VERSION,
			id: randomUUID(),
			type: 'external',
			actor: { type: 'external' },
			at,
			workspaceSchemaVersion,
			resources: actual.resources,
			// The earliest the change can have happened: the previous version.
			startedAt: windowStart ?? at,
			netChange: true,
			events: [],
			...(this.lastHostVersionId ? { parent: this.lastHostVersionId } : {}),
			...(gap ? { recordingGap: true as const } : {}),
		}
		assertHeld(signal)
		// The snapshot was taken under the lock; a write that outlives an abandonment still lands.
		await host.writeVersion(record)
		this.lastHostVersionId = record.id
		this.expected = actualMap
		return record.id
	}

	private async pruneUnlocked(stores: HistoryRecorderStores): Promise<HostPruneResult> {
		const result = await pruneHostHistory({ host: stores.host, checkpoints: await stores.checkpoints.listUnlocked(), now: new Date(this.clock.now()) })
		if (this.lastHostVersionId && result.pruned.includes(this.lastHostVersionId)) this.lastHostVersionId = undefined
		return result
	}

	// ── Timers (created outside any design-write context) ──────────────────────

	private armAutosaveTimer(delay?: number): void {
		const open = this.open
		if (!open) return
		this.clearAutosaveTimer()
		const due = delay ?? Math.max(0, Math.min(open.lastEventAtMs + AUTOSAVE_IDLE_MS, open.startedAtMs + AUTOSAVE_MAX_SPAN_MS) - this.clock.now())
		const id = open.id
		// Review finding L1: a timer created inside the write's context would carry it into its callback.
		this.autosaveTimer = outsideDesignWriteContext(() => this.clock.setTimeout(() => outsideDesignWriteContext(() => this.onAutosaveTimer(id)), due))
	}

	private clearAutosaveTimer(): void {
		if (this.autosaveTimer !== undefined) this.clock.clearTimeout(this.autosaveTimer)
		this.autosaveTimer = undefined
	}

	private onAutosaveTimer(id: string): void {
		this.autosaveTimer = undefined
		if (this.phase !== 'recording' || this.open?.id !== id) return
		void this.persistence.withLock(() => this.exclusive(async (signal) => {
			const open = this.open
			if (!open || open.id !== id) return
			const now = this.clock.now()
			if (now - open.lastEventAtMs >= AUTOSAVE_IDLE_MS) await this.boundaryUnlocked('idle', signal)
			else if (now - open.startedAtMs >= AUTOSAVE_MAX_SPAN_MS) await this.boundaryUnlocked('max_span', signal)
			else this.armAutosaveTimer()
		})).catch((error: unknown) => {
			this.log(`uiux: history could not close the idle autosave; retrying: ${message(error)}`)
			if (this.phase === 'recording' && this.open?.id === id) this.armAutosaveTimer(CLOSE_RETRY_MS)
		})
	}

	private armPruneTimer(): void {
		this.pruneTimer = outsideDesignWriteContext(() => this.clock.setTimeout(() => outsideDesignWriteContext(() => {
			this.pruneTimer = undefined
			if (this.phase !== 'recording') return
			void this.prune()
				.catch((error: unknown) => this.log(`uiux: history pruning failed; it runs again in a day: ${message(error)}`))
				.finally(() => {
					if (this.phase === 'recording' && !this.stopping) this.armPruneTimer()
				})
		}), HOST_PRUNE_INTERVAL_MS))
	}

	// ── Helpers ─────────────────────────────────────────────────────────────────

	/**
	 * An observer hook: the work runs under persistence's bound and abandonment signal. A failure
	 * that left the recorder idle is also written to `open.json` as a gap entry (best effort), so a
	 * crash before the next boundary still flags the next start's external version (review finding L1).
	 */
	private async hook(signal: AbortSignal | undefined, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
		try {
			await this.exclusive(operation, signal ?? new AbortController().signal)
		}
		catch (error) {
			// Abandoned work journals its own gap when it settles. A hook refused as busy queues one now,
			// so the gap survives a crash before the abandoned work settles (journal writes are
			// serialized, so this cannot interleave with the abandoned work's own). It is not awaited:
			// the abandoned work may be stuck in the journal itself, and this hook holds the lock.
			if (error instanceof RecorderBusyError) {
				this.gap = true
				void this.persistGap()
			}
			else if (!signal?.aborted) {
				this.gap = true
				await this.persistGap()
			}
			throw error
		}
	}

	/**
	 * Runs recorder work one at a time. With no `signal` the work is bounded by the operation timeout
	 * and the signal is aborted when it expires; a hook passes persistence's signal instead. Work
	 * abandoned that way keeps running without the lock, so new work is refused until it settles;
	 * when it settles the gap is marked (and journaled), and the next boundary under the lock records
	 * what it left unexplained.
	 */
	private exclusive<Result>(operation: (signal: AbortSignal) => Promise<Result>, signal?: AbortSignal, records = true): Promise<Result> {
		if (this.inFlight) return Promise.reject(new RecorderBusyError())
		const token = Symbol('history-recorder-operation')
		this.inFlight = token
		const bound = signal ? undefined : new AbortController()
		const abandoned = signal ?? bound!.signal
		const running = (async () => {
			try {
				return await operation(abandoned)
			}
			finally {
				if (abandoned.aborted && records) {
					this.gap = true
					await this.persistGap()
				}
				if (this.inFlight === token) this.inFlight = undefined
			}
		})()
		return bound ? withTimeout(running, this.operationTimeout, bound) : running
	}

	/** Appends a gap entry to `open.json`; best effort, a failure is only logged. */
	private async persistGap(): Promise<void> {
		const host = this.stores?.host
		if (!host) return
		try {
			await this.journal(() => host.appendOpenEntry({ type: 'gap', at: new Date(this.clock.now()).toISOString() }))
		}
		catch (error) {
			this.log(`uiux: history could not journal a recording gap: ${message(error)}`)
		}
	}

	/**
	 * Serializes every change to `open.json`. Appends position themselves at the file's current end,
	 * so two concurrent appends (a hook refused as busy and the abandoned work it waits on) could
	 * otherwise overwrite each other.
	 */
	private journal<Result>(operation: () => Promise<Result>): Promise<Result> {
		const run = this.journalQueue.then(operation, operation)
		this.journalQueue = run.then(() => undefined, () => undefined)
		return run
	}

	/** A version time strictly after every version the recorder knows, so the timeline order follows recording order. */
	private stamp(): string {
		this.lastAtMs = Math.max(this.clock.now(), this.lastAtMs + 1)
		return new Date(this.lastAtMs).toISOString()
	}
}

function sameActor(left: HistoryActor, right: HistoryActor): boolean {
	return left.type === right.type && left.id === right.id
}

function resourceMap(resources: readonly HistoryResourceEntry[]): ResourceMap {
	return new Map(resources.map(resource => [resourceIdentityKey(resource), resource]))
}

function sortedResources(resources: ResourceMap): HistoryResourceEntry[] {
	return [...resources.values()].sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key))
}

/** Applies one write event (its changed files' digests, `null` when removed) to a resource state. */
function applyEvent(state: ResourceMap, event: HistoryWriteEvent, files: Readonly<Record<string, string | null>>): void {
	const key = resourceIdentityKey(event.resource)
	if (event.afterRevision === null) {
		state.delete(key)
		return
	}
	const next: Record<string, string> = { ...(state.get(key)?.files ?? {}) }
	for (const [path, digest] of Object.entries(files)) {
		if (digest === null) delete next[path]
		else next[path] = digest
	}
	const sortedFiles: Record<string, string> = {}
	for (const path of Object.keys(next).sort(compareCodeUnits)) sortedFiles[path] = next[path]!
	state.set(key, { kind: event.resource.kind, key: event.resource.key, revision: event.afterRevision, files: sortedFiles })
}

function sameResource(left: HistoryResourceEntry, right: HistoryResourceEntry): boolean {
	if (left.revision !== right.revision) return false
	const leftFiles = Object.entries(left.files)
	return leftFiles.length === Object.keys(right.files).length && leftFiles.every(([path, digest]) => right.files[path] === digest)
}

function sameResources(left: ResourceMap, right: ResourceMap): boolean {
	if (left.size !== right.size) return false
	for (const [key, resource] of left) {
		const other = right.get(key)
		if (!other || !sameResource(resource, other)) return false
	}
	return true
}

function withTimeout<Result>(running: Promise<Result>, milliseconds: number, abandon: AbortController): Promise<Result> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			abandon.abort()
			reject(new Error(`a history recorder operation did not finish within ${milliseconds} ms and was abandoned`))
		}, milliseconds)
		timer.unref?.()
	})
	running.catch(() => undefined)
	return Promise.race([running, timeout]).finally(() => clearTimeout(timer))
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
