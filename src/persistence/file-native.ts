import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import type { ResourceRevision, RevisionedResourceRead, RevisionConflict } from '../application/dto/revisions'
import type { MutableResourceRepository } from '../application/ports/resources'
import { validateAssetContentFiles, validateAssetContentMetadata, validateAssetMetadata, type AuthoredAsset, type AuthoredAssetResource } from '../domain/assets/schema'
import { validateFlowResource, type FlowResource } from '../domain/flows/schema'
import { validateI18nResource, type I18nResource } from '../domain/i18n/schema'
import { PRODUCT_KIT_RESOURCE_KEY, PRODUCT_KIT_RESOURCE_KIND, PRODUCT_KIT_SCHEMA_VERSION, validateProductKit, type ProductKit } from '../domain/product-kit/schema'
import { isCanonicalLocaleFilename, isFullUuid, isJsonValue, isRecord, type Diagnostic } from '../domain/validation'
import { validateReviewThread, type ReviewThread } from '../domain/reviews/schema'
import { validateViewResource, type ViewResource } from '../domain/views/schema'
import { validateWorkspaceManifest, type WorkspaceManifest } from '../domain/workspace/schema'
import { PersistenceError } from './errors'
import { currentDesignWriteContext, type DesignWriteContext } from './history/write-context'
import {
	assetMetadataRelativePath,
	assetDirectoryRelativePath,
	flowRelativePath,
	localeRelativePath,
	reviewRelativePath,
	resolveWorkspacePath,
	viewRelativePath,
	isSafeAssetContentFilename,
	detectWorkspaceLayoutSync,
	isInCodeDirectory,
	layoutForSchemaVersion,
	type VersionedResourceIdentity,
	type WorkspaceLayout,
} from './paths'
import {
	defineWorkspaceSchemaPolicy,
	findMigrationPlan,
	inspectWorkspaceManifest,
	type WorkspaceInspection,
	type WorkspaceMigrationStep,
	type WorkspaceSchemaPolicy,
	type WorkspaceSnapshot,
} from './schema-policy'

export type PersistenceFaultPoint =
	| 'file.before_rename'
	| 'file.after_rename'
	| 'file.before_remove'
	| 'file.after_remove'
	| 'artifact.before_publish'
	| 'artifact.after_publish'
	| 'transaction.before_apply'
	| 'transaction.after_apply'
	| 'asset.before_apply'
	| 'migration.before_apply'
	| 'migration.after_apply'

export type TransactionOperation = 'asset' | 'migration' | 'decision-promotion'

export type PersistenceFaultHook = (point: PersistenceFaultPoint, details: Readonly<{ path?: string; index?: number; operation?: TransactionOperation }>) => void | Promise<void>

export type FileNativePersistenceOptions = Readonly<{
	root: string
	schemaPolicy: WorkspaceSchemaPolicy
	fault?: PersistenceFaultHook
	lockWaitMilliseconds?: number
	/** The history observer (recorder seam 6); it can also be attached later with `setWriteObserver`. */
	writeObserver?: CanonicalWriteObserver
	/** How long one observer hook may hold the lock before it is abandoned; defaults to {@link OBSERVER_HOOK_TIMEOUT_MS}. */
	observerTimeoutMilliseconds?: number
	/**
	 * The Workspace layout. Omitted, it is detected from where the manifest is
	 * (`detectWorkspaceLayoutSync`); a directory without a manifest gets the layout of the policy's
	 * current version.
	 */
	layout?: WorkspaceLayout
}>

/** The revision of one versioned resource a design write is about to change (`null` when it does not exist yet). */
export type CanonicalResourceBefore = Readonly<{ resource: VersionedResourceIdentity; revision: ResourceRevision | null }>

/** One committed versioned file: `bytes` are exactly the bytes written, or `null` when the file was removed. */
export type CanonicalFileChange = Readonly<{ path: string; bytes: Uint8Array | null }>

/**
 * One versioned resource a committed design write changed. The revisions are the ones persistence
 * reports for the resource's files before and after the write (`null` when the resource did not
 * exist on that side); `files` lists only the files the write changed.
 */
export type CanonicalResourceChange = Readonly<{
	resource: VersionedResourceIdentity
	beforeRevision: ResourceRevision | null
	afterRevision: ResourceRevision | null
	files: readonly CanonicalFileChange[]
}>

/**
 * Observer hooks the history recorder attaches to persistence. Both are called only while a
 * design-write context is set and only for writes that change versioned files (Review files are
 * not versioned, so Review writes never call them), always under the exclusive persistence lock:
 *
 * - `beforeCanonicalWrite` runs after every check of the write passed, before any byte changes,
 *   with the current revision of each versioned resource the write changes.
 * - `afterCanonicalCommit` runs once the write has committed (for multi-file writes, once the
 *   transaction journal is committed), with exactly the committed bytes. It runs only when
 *   `beforeCanonicalWrite` succeeded for the same write: a boundary the `before` hook failed to
 *   close must not receive the write's event, so the write stays unrecorded and flagged instead.
 *
 * A hook must not call this instance's `withLock` or `withReadLock` (that is refused); use the
 * `*Unlocked` helpers instead. Do not start a lock acquisition fire-and-forget inside a hook
 * either: it is refused too, and nothing observes the rejection. Defer such work until the hook
 * has returned (a timer), when the lock can be taken again. A hook failure never fails the write:
 * it is logged and sets `recordingGap`.
 *
 * `beforeCanonicalWrite` can run without a following `afterCanonicalCommit` when the write itself
 * then fails or decides not to write. Each hook may hold the lock for at most the observer timeout
 * ({@link OBSERVER_HOOK_TIMEOUT_MS} unless configured): a hook still running then is abandoned
 * (the write goes on and `recordingGap` is set) and keeps running without the lock: its `signal` is
 * aborted then, after which it must not read the Workspace or consume the gap, and an observer must
 * refuse to start new work until its abandoned work settles.
 */
export type CanonicalWriteObserver = Readonly<{
	beforeCanonicalWrite?(context: DesignWriteContext, resources: readonly CanonicalResourceBefore[], signal: AbortSignal): void | Promise<void>
	afterCanonicalCommit?(context: DesignWriteContext, changes: readonly CanonicalResourceChange[], signal: AbortSignal): void | Promise<void>
}>

/**
 * The longest one observer hook may hold the exclusive lock (issue #132 B3, review finding L4).
 * A write runs at most two hooks, so a stalled history store adds at most 10 s to a write: two
 * thirds of the 15 s lock wait budget (`MAX_LOCK_WAIT_MS`), which leaves a writer queued behind it
 * time to get the lock instead of failing with `persistence.lock_busy`. A healthy hook (a journal
 * append, or a version write plus a rescan of the versioned files) takes milliseconds to a few
 * hundred milliseconds, far below the bound.
 */
export const OBSERVER_HOOK_TIMEOUT_MS = 5_000

export type InspectedResource<Resource> = Readonly<{
	resource: Resource
	revision: ResourceRevision
	diagnostics: readonly Diagnostic[]
}>

export type WorkspaceReadInspection = Readonly<{
	resource?: WorkspaceManifest
	revision?: ResourceRevision
	inspection: WorkspaceInspection
	diagnostics: readonly Diagnostic[]
}>

export type AuthoredAssetInspection = Readonly<{
	resource: AuthoredAssetResource
	revision: ResourceRevision
	actualContentFilenames: readonly string[]
	diagnostics: readonly Diagnostic[]
}>

export type ArtifactWriteResult = Readonly<{ identity: `sha256:${string}`; created: boolean }>

export type WorkspaceMigrationPlanResult = Readonly<{
	/** The opened manifest version. */
	fromVersion: number
	/** The version the Workspace would have after applying the plan (the current one when no steps run). */
	version: number
	/** Current manifest revision; a real run reports the new manifest revision instead. */
	revision: ResourceRevision
	changedFiles: readonly string[]
	steps: readonly string[]
}>

export type WorkspaceMigrationResult = Readonly<{ fromVersion: number; version: number; revision: ResourceRevision; changedFiles: readonly string[]; steps: readonly string[] }>

/**
 * Work a caller (`uiux migrate`) runs under the migration's exclusive lock, outside every step:
 *
 * - `beforeSteps` runs once the Workspace is known to need migration, before any step runs (in
 *   memory or on disk). Whatever it writes is not part of the migration, so a migration that fails
 *   later leaves it in place; when it throws, no step runs and the migration is refused.
 * - `afterCommit` runs once the migration committed and the manifest reached the current version.
 *   The migration is committed by then, so it must not throw: an error it lets escape is reported
 *   as the migration's own failure.
 *
 * Neither runs when there is nothing to migrate.
 */
export type WorkspaceMigrationHooks = Readonly<{
	beforeSteps?(plan: Readonly<{ fromVersion: number; toVersion: number }>): Promise<void>
	afterCommit?(result: WorkspaceMigrationResult): Promise<void>
}>

export type AtomicReviewViewPromotionCasInput = Readonly<{
	reviewId: string
	expectedReviewRevision: ResourceRevision
	reviewResource: ReviewThread
	viewId: string
	expectedViewRevision: ResourceRevision
	viewResource: ViewResource
}>

export type AtomicReviewViewConflictDetail = Readonly<{
	resource: 'review' | 'view'
	key: string
	expectedRevision: ResourceRevision
	currentRevision: ResourceRevision
}>

export type AtomicReviewViewPromotionConflict = Readonly<{
	code: 'revision_conflict'
	resource: 'review' | 'view' | 'both'
	conflicts: readonly AtomicReviewViewConflictDetail[]
}>

export type AtomicReviewViewPromotionResult =
	| Readonly<{
			ok: true
			reviewRevision: ResourceRevision
			viewRevision: ResourceRevision
	  }>
	| Readonly<{
			ok: false
			conflict: AtomicReviewViewPromotionConflict
	  }>

type FileChange = Readonly<{ path: string; bytes?: Uint8Array }>

/** Reads available to a delete guard while the exclusive persistence lock is held. */
export type DeleteGuardContext = Readonly<{
	/** Parsed JSON of another canonical file, or undefined when it does not exist. */
	readJsonUnlocked(relativePath: string): Promise<unknown>
}>

export type DeleteIfRevisionResult<Refusal> =
	| Readonly<{ status: 'deleted' }>
	| Readonly<{ status: 'not_found' }>
	| Readonly<{ status: 'conflict'; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'refused'; refusal: Refusal }>
/** A pending multi-file write: its changes and, outside the legacy layout, the layout it was written for (`layout` absent means legacy). */
type TransactionJournal = Readonly<{ layout?: WorkspaceLayout['id']; changes: readonly Readonly<{ path: string; existed: boolean }>[] }>
/** `schemaVersion` is the selected Workspace manifest version every canonical file is decoded under. */
type JsonValidator = (resource: unknown, filename: string, schemaVersion: number) => readonly Diagnostic[]

const MAX_LOCK_WAIT_MS = 15_000
/**
 * Upper bound on how long one shared read batch keeps admitting new readers in this process. After
 * it, new readers queue until the batch drains, so the cross-process persistence lock is released
 * now and then and another UIUX process waiting on it gets a turn.
 */
const MAX_SHARED_BATCH_MS = 1_000
/** The deepest versioned file of the legacy layout is `assets/<uuid>/<file>`: three path segments. */
const VERSIONED_SCAN_MAX_SEGMENTS = 3

/** File-native persistence implementation. The schema policy is deliberately injected. */
export class FileNativePersistence {
	readonly root: string
	/** Where this Workspace keeps its manifest, runtime files and versioned files. */
	readonly layout: WorkspaceLayout
	readonly schemaPolicy: WorkspaceSchemaPolicy
	readonly workspace: WorkspaceFileRepository
	/** The Product Kit file (from `schemaVersion` 5; the old layout has none). */
	readonly productKit: ProductKitFileRepository
	readonly views: JsonResourceRepository<string, ViewResource>
	readonly flows: JsonResourceRepository<string, FlowResource>
	readonly reviews: JsonResourceRepository<string, ReviewThread>
	readonly locales: LocaleFileRepository
	readonly assets: AuthoredAssetFileRepository
	readonly artifacts: ImmutableArtifactStore
	private readonly fault?: PersistenceFaultHook
	private readonly lockWaitMilliseconds: number
	/** In-process admission: readers share one hold of the cross-process lock; writers are exclusive. */
	private readonly gate = new ProcessLockGate()
	/** The current shared read hold of the cross-process lock, if any reader is inside it. */
	private sharedHold?: SharedLockHold
	/** Settles once the previous shared hold has released the cross-process lock. */
	private sharedReleasing: Promise<void> = Promise.resolve()

	constructor(options: FileNativePersistenceOptions) {
		this.root = resolve(options.root)
		this.schemaPolicy = defineWorkspaceSchemaPolicy(options.schemaPolicy)
		this.layout = options.layout ?? detectWorkspaceLayoutSync(this.root, this.schemaPolicy.currentVersion)
		this.fault = options.fault
		this.lockWaitMilliseconds = options.lockWaitMilliseconds ?? MAX_LOCK_WAIT_MS
		this.workspace = new WorkspaceFileRepository(this)
		this.productKit = new ProductKitFileRepository(this)
		this.views = new JsonResourceRepository(this, viewRelativePath, 'id', (resource, filename) => validateViewResource(resource, filename).diagnostics, { directory: 'views', suffix: '.view.json' })
		this.flows = new JsonResourceRepository(this, flowRelativePath, 'id', (resource, filename) => validateFlowResource(resource, filename).diagnostics, { directory: 'flows', suffix: '.flow.json' })
		this.reviews = new JsonResourceRepository(this, reviewRelativePath, 'id', (resource, filename, schemaVersion) => validateReviewThread(resource, { filename, schemaVersion }).diagnostics, { directory: 'reviews', suffix: '.review.json' })
		this.locales = new LocaleFileRepository(this)
		this.assets = new AuthoredAssetFileRepository(this)
		this.artifacts = new ImmutableArtifactStore(this)
		observerStates.set(this, { observer: options.writeObserver, recordingGap: false, timeoutMilliseconds: options.observerTimeoutMilliseconds ?? OBSERVER_HOOK_TIMEOUT_MS })
	}

	/** Attaches (or with `undefined`, detaches) the history observer. */
	setWriteObserver(observer: CanonicalWriteObserver | undefined): void {
		observerState(this).observer = observer
	}

	/** True once an observer hook failed (or could not be prepared) since the flag was last consumed. */
	get recordingGap(): boolean {
		return observerState(this).recordingGap
	}

	/** Returns the recording-gap flag and clears it, so the next history boundary can record the gap once. */
	consumeRecordingGap(): boolean {
		const state = observerState(this)
		const gap = state.recordingGap
		state.recordingGap = false
		return gap
	}

	/** Reports policy state without changing the Workspace or its authored files. */
	async inspectWorkspace(): Promise<WorkspaceReadInspection> {
		return this.withReadLock(async () => this.inspectWorkspaceUnlocked())
	}

	/**
	 * Plans the injected Workspace schema migration entirely in memory, without writing anything.
	 * Returns the step ids that would run and the canonical files whose bytes would change.
	 */
	async planWorkspaceMigration(): Promise<WorkspaceMigrationPlanResult> {
		return this.withLock(async () => {
			const planned = await this.planWorkspaceMigrationUnlocked()
			return {
				fromVersion: planned.fromVersion,
				version: planned.toVersion,
				revision: planned.revision,
				changedFiles: planned.changes.map(change => change.path),
				steps: planned.steps,
			}
		})
	}

	/** The only operation that applies injected Workspace schema migrations. */
	async migrateWorkspace(hooks: WorkspaceMigrationHooks = {}): Promise<WorkspaceMigrationResult> {
		return this.withLock(async () => {
			const planned = await this.planWorkspaceMigrationUnlocked(hooks.beforeSteps)
			if (planned.steps.length === 0)
				return { fromVersion: planned.fromVersion, version: planned.toVersion, revision: planned.revision, changedFiles: [], steps: [] }

			const beforeApplySnapshot = await this.scanCanonicalSnapshotUnlocked()
			if (!snapshotsEqual(planned.initialSnapshot, beforeApplySnapshot))
				throw new PersistenceError('workspace.migration_failed', 'Canonical Workspace files changed while migration was being planned; no migration writes were applied.')
			const changedFiles = planned.changes.map(change => change.path)
			await this.applyFileTransaction(planned.changes, 'migration')
			const manifestBytes = await this.readBytesUnlocked(this.layout.manifestPath)
			const finalManifest = parseJsonBytes(manifestBytes, this.layout.manifestPath)
			const finalInspection = inspectWorkspaceManifest(finalManifest, this.schemaPolicy)
			if (finalInspection.state !== 'current')
				throw new PersistenceError('workspace.migration_failed', 'Workspace migration transaction completed without reaching the current policy version.', { diagnostics: finalInspection.diagnostics })
			const result: WorkspaceMigrationResult = {
				fromVersion: planned.fromVersion,
				version: finalInspection.version,
				revision: revisionForBytes(manifestBytes),
				changedFiles,
				steps: planned.steps,
			}
			await hooks.afterCommit?.(result)
			return result
		})
	}

	private async planWorkspaceMigrationUnlocked(beforeSteps?: WorkspaceMigrationHooks['beforeSteps']): Promise<Readonly<{
		fromVersion: number
		toVersion: number
		revision: ResourceRevision
		steps: readonly string[]
		changes: readonly FileChange[]
		initialSnapshot: WorkspaceSnapshot
	}>> {
		const read = await this.inspectWorkspaceUnlocked()
		if (!read.resource || !read.revision)
			throw new PersistenceError('workspace.manifest_missing', `Cannot migrate a Workspace without ${this.layout.manifestPath}.`, { diagnostics: read.diagnostics })
		if (read.inspection.state === 'unsupported')
			throw new PersistenceError('workspace.schema_unsupported', 'Workspace schema is not supported by the injected policy.', { diagnostics: read.inspection.diagnostics })
		if (read.inspection.state === 'missing_manifest')
			throw new PersistenceError('workspace.manifest_missing', `Cannot migrate a Workspace without ${this.layout.manifestPath}.`, { diagnostics: read.diagnostics })
		if (read.inspection.state === 'current')
			return { fromVersion: read.inspection.version, toVersion: read.inspection.version, revision: read.revision, steps: [], changes: [], initialSnapshot: new Map() }
		// A plan that ends in another layout relocates the Workspace (`uiux.v4-to-v5`), which a file
		// transaction under this root cannot apply; refuse before anything, the pre-migration
		// Checkpoint included, is written.
		if (layoutForSchemaVersion(this.schemaPolicy.currentVersion) !== this.layout)
			throw new PersistenceError('workspace.migration_failed', `Migrating schemaVersion ${read.inspection.version} to ${this.schemaPolicy.currentVersion} moves the Workspace to another layout, which this build cannot apply; nothing was changed.`)
		await beforeSteps?.({ fromVersion: read.inspection.version, toVersion: this.schemaPolicy.currentVersion })
		const initialSnapshot = await this.scanCanonicalSnapshotUnlocked()
		const { snapshot, steps: stepIds } = await applyMigrationPlan(initialSnapshot, read.inspection.migrationPlan, this.schemaPolicy)
		return {
			fromVersion: read.inspection.version,
			toVersion: this.schemaPolicy.currentVersion,
			revision: read.revision,
			steps: stepIds,
			changes: diffSnapshots(initialSnapshot, snapshot),
			initialSnapshot,
		}
	}

	/**
	 * Domain primitive for atomic CAS across Review and View resources.
	 * Executes under one persistence lock, validates both revisions and complete resources,
	 * and commits changes atomically via applyFileTransaction journal.
	 */
	async atomicReviewViewPromotionCas(input: AtomicReviewViewPromotionCasInput): Promise<AtomicReviewViewPromotionResult> {
		return this.withLock(async () => {
			await this.assertWritableUnlocked()
			const reviewPath = reviewRelativePath(input.reviewId)
			const viewPath = viewRelativePath(input.viewId)

			const reviewBytes = await this.readOptionalBytesUnlocked(reviewPath)
			if (!reviewBytes)
				throw new PersistenceError('persistence.resource_not_found', `Review resource ${reviewPath} does not exist.`)
			const currentReviewRevision = revisionForBytes(reviewBytes)

			const viewBytes = await this.readOptionalBytesUnlocked(viewPath)
			if (!viewBytes)
				throw new PersistenceError('persistence.resource_not_found', `View resource ${viewPath} does not exist.`)
			const currentViewRevision = revisionForBytes(viewBytes)

			const conflicts: AtomicReviewViewConflictDetail[] = []
			if (input.expectedReviewRevision !== currentReviewRevision) {
				conflicts.push({
					resource: 'review',
					key: input.reviewId,
					expectedRevision: input.expectedReviewRevision,
					currentRevision: currentReviewRevision,
				})
			}
			if (input.expectedViewRevision !== currentViewRevision) {
				conflicts.push({
					resource: 'view',
					key: input.viewId,
					expectedRevision: input.expectedViewRevision,
					currentRevision: currentViewRevision,
				})
			}
			if (conflicts.length > 0) {
				return {
					ok: false,
					conflict: {
						code: 'revision_conflict',
						resource: conflicts.length === 2 ? 'both' : conflicts[0]!.resource,
						conflicts,
					},
				}
			}

			const reviewValidation = validateReviewThread(input.reviewResource, { filename: `${input.reviewId}.review.json`, schemaVersion: this.schemaPolicy.currentVersion })
			if (!reviewValidation.ok) {
				throw new PersistenceError('persistence.invalid_resource', 'ReviewThread resource failed schema validation before atomic promotion write.', { diagnostics: reviewValidation.diagnostics })
			}

			const viewValidation = validateViewResource(input.viewResource, `${input.viewId}.view.json`)
			if (!viewValidation.ok) {
				throw new PersistenceError('persistence.invalid_resource', 'ViewResource resource failed schema validation before atomic promotion write.', { diagnostics: viewValidation.diagnostics })
			}

			assertEmbeddedIdentity(input.reviewId, input.reviewResource, 'id', `${input.reviewId}.review.json`)
			assertEmbeddedIdentity(input.viewId, input.viewResource, 'id', `${input.viewId}.view.json`)

			const serializedReview = this.serializeJson(input.reviewResource, reviewPath)
			const serializedView = this.serializeJson(input.viewResource, viewPath)

			const changes: FileChange[] = [
				{ path: reviewPath, bytes: serializedReview },
				{ path: viewPath, bytes: serializedView },
			]
			// Only the View part is versioned; the observer never sees the Review file.
			await commitCanonicalWrite(this, changes, () => this.applyFileTransaction(changes, 'decision-promotion'))

			return {
				ok: true,
				reviewRevision: revisionForBytes(serializedReview),
				viewRevision: revisionForBytes(serializedView),
			}
		})
	}

	/**
	 * Exclusive access for mutations: locking serializes CAS across repository instances and
	 * processes. Waiting longer than the lock wait budget throws `persistence.lock_busy`.
	 */
	async withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
		assertOutsideObserver(this)
		const deadline = Date.now() + this.lockWaitMilliseconds
		const leave = await this.gate.enter('exclusive', deadline)
		try {
			const release = await this.acquireLock(deadline)
			try {
				await this.recoverPendingTransactionsUnlocked()
				return await operation()
			}
			finally {
				await release()
			}
		}
		finally {
			leave()
		}
	}

	/**
	 * Shared access for read-only operations. Reads still hold the cross-process lock, so they never
	 * observe a multi-file transaction (Asset replace, Decision promotion, migration) half applied and
	 * pending transactions are recovered before anything is read. Concurrent readers in this process
	 * share one acquisition of that lock instead of queueing on it one by one; a waiting writer stops
	 * new readers from joining, so writes are not starved. The operation must not write.
	 */
	async withReadLock<Result>(operation: () => Promise<Result>): Promise<Result> {
		assertOutsideObserver(this)
		const deadline = Date.now() + this.lockWaitMilliseconds
		const leave = await this.gate.enter('shared', deadline)
		let hold: SharedLockHold | undefined
		try {
			hold = await this.joinSharedHold(deadline)
			return await operation()
		}
		finally {
			try {
				if (hold) await this.leaveSharedHold(hold)
			}
			finally {
				leave()
			}
		}
	}

	private async joinSharedHold(deadline: number): Promise<SharedLockHold> {
		let hold = this.sharedHold
		if (!hold) {
			const previousRelease = this.sharedReleasing
			const created: SharedLockHold = {
				holders: 0,
				ready: (async () => {
					await previousRelease
					const release = await this.acquireLock(deadline)
					try {
						await this.recoverPendingTransactionsUnlocked()
					}
					catch (error) {
						await release()
						throw error
					}
					return release
				})(),
			}
			// A failed acquisition is reported to every joined reader, never left unhandled.
			created.ready.catch(() => undefined)
			this.sharedHold = created
			hold = created
		}
		hold.holders += 1
		try {
			await hold.ready
			return hold
		}
		catch (error) {
			hold.holders -= 1
			if (this.sharedHold === hold) this.sharedHold = undefined
			throw error
		}
	}

	private async leaveSharedHold(hold: SharedLockHold): Promise<void> {
		hold.holders -= 1
		if (hold.holders > 0) return
		if (this.sharedHold === hold) this.sharedHold = undefined
		const releasing = (async () => {
			const release = await hold.ready
			await release()
		})()
		this.sharedReleasing = releasing.catch(() => undefined)
		await releasing
	}

	/**
	 * Refuses a mutation unless the Workspace is at the current schema. `productKitMayBeMissing` is
	 * for creating the Product Kit file itself, the one write a `schemaVersion` 5 root may make
	 * before that file exists.
	 */
	async assertWritableUnlocked(options: Readonly<{ productKitMayBeMissing?: boolean }> = {}): Promise<void> {
		const inspection = (await this.inspectWorkspaceUnlocked(options)).inspection
		if (inspection.state === 'current')
			return
		if (inspection.state === 'migration_required')
			throw new PersistenceError('workspace.migration_required', 'Normal canonical mutations are blocked until explicit Workspace migration completes.', {
				diagnostics: [{ code: 'workspace.migration_required', path: '/schemaVersion', message: `Workspace schema ${inspection.version} requires explicit migration to policy target ${inspection.targetVersion}.` }],
			})
		if (inspection.state === 'missing_manifest')
			throw new PersistenceError('workspace.manifest_missing', 'Create a current-policy Workspace manifest before mutating Workspace resources.', { diagnostics: inspection.diagnostics })
		throw new PersistenceError('workspace.schema_unsupported', 'Normal canonical mutations are blocked for an unsupported Workspace schema.', { diagnostics: inspection.diagnostics })
	}

	async inspectWorkspaceUnlocked(options: Readonly<{ productKitMayBeMissing?: boolean }> = {}): Promise<WorkspaceReadInspection> {
		const relativePath = this.layout.manifestPath
		let bytes: Buffer
		try {
			bytes = await this.readBytesUnlocked(relativePath)
		}
		catch (error) {
			if (isNotFound(error)) {
				const inspection: WorkspaceInspection = {
					state: 'missing_manifest',
					targetVersion: this.schemaPolicy.currentVersion,
					diagnostics: [{ code: 'workspace.manifest_missing', path: `/${relativePath}`, message: `Workspace manifest ${relativePath} does not exist.` }],
				}
				return { inspection, diagnostics: inspection.diagnostics }
			}
			throw error
		}
		const resource = parseJsonBytes(bytes, relativePath)
		let inspection = this.inspectLayout(inspectWorkspaceManifest(resource, this.schemaPolicy))
		// Clause 01a11bb1-8d67-71c5-929f-138afd0c66ec: a schemaVersion 5 root holds product-kit.json.
		if (this.layout.productKitPath && !options.productKitMayBeMissing && (inspection.state === 'current' || inspection.state === 'migration_required')
			&& !await this.readOptionalBytesUnlocked(this.layout.productKitPath)) {
			inspection = {
				state: 'unsupported',
				version: inspection.version,
				targetVersion: inspection.targetVersion,
				diagnostics: [...inspection.diagnostics, { code: 'workspace.schema_unsupported', path: `/${this.layout.productKitPath}`, message: `A schemaVersion ${inspection.version} Workspace requires ${this.layout.productKitPath}, which does not exist.` }],
			}
		}
		const validationDiagnostics = validateWorkspaceManifest(resource).diagnostics
		const extraDiagnostics = inspection.state === 'unsupported'
			? inspection.diagnostics.filter(item => !validationDiagnostics.some(existing => existing.code === item.code && existing.path === item.path))
			: []
		const diagnostics = [...validationDiagnostics, ...extraDiagnostics]
		return { resource: resource as WorkspaceManifest, revision: revisionForBytes(bytes), inspection, diagnostics }
	}

	/**
	 * A manifest whose `schemaVersion` belongs to another layout than the one this root was opened
	 * with is `unsupported`: an old-layout `.uiux/` directory selected as a root (its `workspace.json`
	 * is below version 5), or an old-layout parent of a relocated Workspace (its `.uiux/workspace.json`
	 * is version 5 or later). Reads and writes would otherwise look for files in the wrong places.
	 */
	private inspectLayout(inspection: WorkspaceInspection): WorkspaceInspection {
		if (inspection.state !== 'current' && inspection.state !== 'migration_required') return inspection
		if (layoutForSchemaVersion(inspection.version) === this.layout) return inspection
		const message = this.layout.codeDir
			? `${this.layout.manifestPath} holds a schemaVersion ${inspection.version} manifest, but only a schemaVersion ${PRODUCT_KIT_SCHEMA_VERSION} or later Workspace keeps it there; this directory is the metadata directory of an old-layout Workspace, so select its parent.`
			: `${this.layout.manifestPath} holds a schemaVersion ${inspection.version} manifest, whose Workspace root is that .uiux/ directory itself; select it.`
		return {
			state: 'unsupported',
			version: inspection.version,
			targetVersion: inspection.targetVersion,
			diagnostics: [...inspection.diagnostics, { code: 'workspace.schema_unsupported', path: '/schemaVersion', message }],
		}
	}

	/**
	 * The `workspaceSchemaVersion` of a history record taken from this Workspace now. History reads
	 * each record by the layout of that version, so a record must never pair one layout's paths with
	 * another layout's version: when the manifest's version belongs to another layout than this
	 * persistence's (a stale persistence after a relocation), this throws instead of recording.
	 */
	async readRecordSchemaVersionUnlocked(): Promise<number> {
		const version = await this.readDecodeSchemaVersionUnlocked()
		if (layoutForSchemaVersion(version) !== this.layout)
			throw new PersistenceError('workspace.schema_unsupported', `A history record cannot be taken: the manifest is schemaVersion ${version}, whose layout differs from the layout this Workspace was opened with (manifest ${this.layout.manifestPath}).`)
		return version
	}

	/**
	 * The schemaVersion canonical files are decoded under: the selected manifest's integer version,
	 * or the policy currentVersion when the manifest is missing or has no usable version.
	 */
	async readDecodeSchemaVersionUnlocked(): Promise<number> {
		const bytes = await this.readOptionalBytesUnlocked(this.layout.manifestPath)
		if (!bytes) return this.schemaPolicy.currentVersion
		try {
			const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown
			const version = isRecord(manifest) ? manifest.schemaVersion : undefined
			return typeof version === 'number' && Number.isInteger(version) && version >= 1 ? version : this.schemaPolicy.currentVersion
		}
		catch {
			return this.schemaPolicy.currentVersion
		}
	}

	async readBytesUnlocked(relativePath: string): Promise<Buffer> {
		const absolutePath = resolveWorkspacePath(this.root, relativePath)
		await assertSafePath(this.root, relativePath, false)
		return await fs.readFile(absolutePath)
	}

	async readOptionalBytesUnlocked(relativePath: string): Promise<Buffer | undefined> {
		try {
			return await this.readBytesUnlocked(relativePath)
		}
		catch (error) {
			if (isNotFound(error))
				return undefined
			throw error
		}
	}

	/**
	 * The entries of a Workspace directory, or `undefined` when it does not exist. The directory
	 * and every ancestor must be real directories, never symbolic links.
	 */
	async listDirectoryUnlocked(relativeDirectory: string): Promise<import('node:fs').Dirent[] | undefined> {
		const absolute = resolveWorkspacePath(this.root, relativeDirectory)
		await assertSafePath(this.root, `${relativeDirectory}/.placeholder`, true)
		try {
			return await fs.readdir(absolute, { withFileTypes: true })
		}
		catch (error) {
			if (isNotFound(error)) return undefined
			throw error
		}
	}

	serializeJson(resource: unknown, relativePath: string): Buffer {
		if (!isJsonValue(resource))
			throw new PersistenceError('persistence.invalid_resource', `Resource for ${relativePath} is not a JSON-compatible value.`)
		return Buffer.from(`${stableStringify(resource)}\n`, 'utf8')
	}

	/**
	 * Rule 01a11bb1-9585-7239-b371-0ac4032f2d5d: no persistence write creates, changes or deletes
	 * anything in the Workspace's code directory (`kit/`), whatever path a caller derives.
	 */
	assertOutsideCodeDirectory(relativePath: string): void {
		if (isInCodeDirectory(this.layout, relativePath))
			throw new PersistenceError('persistence.path_rejected', `Path ${relativePath} lies in the Workspace code directory ${this.layout.codeDir}/, which authoring never writes.`)
	}

	async atomicWriteUnlocked(relativePath: string, bytes: Uint8Array, oldBytes?: Uint8Array): Promise<void> {
		this.assertOutsideCodeDirectory(relativePath)
		const absolutePath = resolveWorkspacePath(this.root, relativePath)
		const parentRelative = dirname(relativePath).split('\\').join('/')
		await ensureSafeDirectory(this.root, parentRelative)
		const temporaryPath = resolveWorkspacePath(this.root, `${parentRelative === '.' ? '' : `${parentRelative}/`}.${basename(relativePath)}.uiux-${randomUUID()}.tmp`)
		let renamed = false
		try {
			await writeSyncedFile(temporaryPath, bytes, true)
			await this.hitFault('file.before_rename', { path: relativePath })
			await fs.rename(temporaryPath, absolutePath)
			renamed = true
			await this.hitFault('file.after_rename', { path: relativePath })
			await syncDirectory(dirname(absolutePath))
		}
		catch (cause) {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
			if (renamed) {
				try {
					if (oldBytes)
						await atomicWriteWithoutFault(this.root, relativePath, oldBytes)
					else
						await fs.rm(absolutePath, { force: true })
				}
				catch (rollbackCause) {
					throw new PersistenceError('persistence.recovery_failed', `Failed to restore ${relativePath} after an interrupted atomic write.`, { cause: new AggregateError([cause, rollbackCause]) })
				}
			}
			throw new PersistenceError('persistence.write_failed', `Atomic write failed for ${relativePath}; prior canonical bytes were restored.`, { cause })
		}
	}

	/** Stages, flushes, and renames a new canonical single-file resource into place. */
	async atomicCreateUnlocked(relativePath: string, bytes: Uint8Array): Promise<boolean> {
		this.assertOutsideCodeDirectory(relativePath)
		const absolutePath = resolveWorkspacePath(this.root, relativePath)
		const parentRelative = dirname(relativePath).split('\\').join('/')
		await ensureSafeDirectory(this.root, parentRelative)
		if (await fileExists(absolutePath)) return false
		const temporaryPath = resolveWorkspacePath(this.root, `${parentRelative === '.' ? '' : `${parentRelative}/`}.${basename(relativePath)}.uiux-${randomUUID()}.tmp`)
		let linked = false
		try {
			await writeSyncedFile(temporaryPath, bytes, true)
			await this.hitFault('file.before_rename', { path: relativePath })
			try { await fs.link(temporaryPath, absolutePath) }
			catch (error) {
				if (isAlreadyExists(error)) return false
				throw error
			}
			linked = true
			await this.hitFault('file.after_rename', { path: relativePath })
			await syncDirectory(dirname(absolutePath))
			return true
		}
		catch (cause) {
			if (linked) {
				try {
					await fs.rm(absolutePath, { force: true })
					await syncDirectory(dirname(absolutePath))
				}
				catch (rollbackCause) {
					throw new PersistenceError('persistence.recovery_failed', `Failed to remove ${relativePath} after an interrupted atomic create.`, { cause: new AggregateError([cause, rollbackCause]) })
				}
			}
			throw new PersistenceError('persistence.write_failed', `Atomic create failed for ${relativePath}; no partial canonical file was retained.`, { cause })
		}
		finally {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
		}
	}

	/** Removes one canonical file with a single atomic unlink, then fsyncs its directory. */
	async removeUnlocked(relativePath: string): Promise<void> {
		this.assertOutsideCodeDirectory(relativePath)
		const absolutePath = resolveWorkspacePath(this.root, relativePath)
		await assertSafePath(this.root, relativePath, false)
		await this.hitFault('file.before_remove', { path: relativePath })
		try {
			await fs.unlink(absolutePath)
		}
		catch (cause) {
			throw new PersistenceError('persistence.write_failed', `Removing ${relativePath} failed; the canonical file was left in place.`, { cause })
		}
		await this.hitFault('file.after_remove', { path: relativePath })
		await syncDirectory(dirname(absolutePath))
	}

	/** Content-addressed blobs use an atomic no-replace link so identities stay immutable. */
	async atomicCreateImmutableUnlocked(relativePath: string, bytes: Uint8Array): Promise<boolean> {
		this.assertOutsideCodeDirectory(relativePath)
		const absolutePath = resolveWorkspacePath(this.root, relativePath)
		const parentRelative = dirname(relativePath).split('\\').join('/')
		await ensureSafeDirectory(this.root, parentRelative)
		const temporaryPath = resolveWorkspacePath(this.root, `${parentRelative === '.' ? '' : `${parentRelative}/`}.${basename(relativePath)}.uiux-${randomUUID()}.tmp`)
		let linked = false
		try {
			await writeSyncedFile(temporaryPath, bytes, true)
			await this.hitFault('artifact.before_publish', { path: relativePath })
			try { await fs.link(temporaryPath, absolutePath) }
			catch (error) {
				if (isAlreadyExists(error)) return false
				throw error
			}
			linked = true
			await this.hitFault('artifact.after_publish', { path: relativePath })
			await syncDirectory(dirname(absolutePath))
			return true
		}
		catch (cause) {
			if (linked) {
				try { await fs.rm(absolutePath, { force: true }) }
				catch (rollbackCause) {
					throw new PersistenceError('persistence.recovery_failed', `Failed to remove ${relativePath} after an interrupted immutable artifact create.`, { cause: new AggregateError([cause, rollbackCause]) })
				}
			}
			throw new PersistenceError('persistence.write_failed', `Atomic artifact create failed for ${relativePath}; no partial canonical file was retained.`, { cause })
		}
		finally {
			await fs.rm(temporaryPath, { force: true }).catch(() => undefined)
		}
	}

	async applyFileTransaction(changes: readonly FileChange[], operation: TransactionOperation): Promise<void> {
		const ordered = [...changes].sort((left, right) => left.path.localeCompare(right.path))
		if (new Set(ordered.map(change => change.path)).size !== ordered.length)
			throw new PersistenceError('persistence.path_rejected', 'A file transaction contains duplicate paths.')
		for (const change of ordered) {
			this.assertOutsideCodeDirectory(change.path)
			assertTransactionalPath(this.layout, change.path)
		}
		const transactionId = randomUUID()
		const transactionRelative = `${this.layout.transactionsDir}/${transactionId}`
		const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
		await ensureSafeDirectory(this.root, this.layout.transactionsDir)
		await fs.mkdir(transactionAbsolute)
		const records: { path: string; existed: boolean }[] = []
		let journalWritten = false
		let applied = false
		try {
			for (const change of ordered) {
				const prior = await this.readOptionalBytesUnlocked(change.path)
				records.push({ path: change.path, existed: prior !== undefined })
				if (change.bytes !== undefined) {
					const staged = resolveWorkspacePath(this.root, `${transactionRelative}/staged/${change.path}`)
					await writeSyncedFile(staged, change.bytes, true)
				}
				if (prior !== undefined) {
					const backup = resolveWorkspacePath(this.root, `${transactionRelative}/backup/${change.path}`)
					await writeSyncedFile(backup, prior, true)
				}
			}
			const journal: TransactionJournal = { ...(this.layout.id === 'legacy' ? {} : { layout: this.layout.id }), changes: records }
			await writeSyncedFile(resolveWorkspacePath(this.root, `${transactionRelative}/journal.json`), Buffer.from(JSON.stringify(journal), 'utf8'), true)
			journalWritten = true
			await syncDirectory(transactionAbsolute)
			for (let index = 0; index < ordered.length; index++) {
				const change = ordered[index]!
				await this.hitFault('transaction.before_apply', { path: change.path, index, operation })
				if (operation === 'asset')
					await this.hitFault('asset.before_apply', { path: change.path, index, operation })
				if (operation === 'migration')
					await this.hitFault('migration.before_apply', { path: change.path, index, operation })
				const target = resolveWorkspacePath(this.root, change.path)
				if (change.bytes === undefined)
					await fs.rm(target, { force: true })
				else {
					const staged = resolveWorkspacePath(this.root, `${transactionRelative}/staged/${change.path}`)
					await ensureSafeDirectory(this.root, dirname(change.path).split('\\').join('/'))
					await fs.rename(staged, target)
				}
				await syncDirectory(dirname(target))
				applied = true
				await this.hitFault('transaction.after_apply', { path: change.path, index, operation })
				if (operation === 'migration')
					await this.hitFault('migration.after_apply', { path: change.path, index, operation })
			}
			await writeSyncedFile(resolveWorkspacePath(this.root, `${transactionRelative}/COMMITTED`), Buffer.from('committed', 'utf8'), true)
			await syncDirectory(transactionAbsolute)
		}
		catch (cause) {
			if (journalWritten) {
				try {
					if (await fileExists(resolveWorkspacePath(this.root, `${transactionRelative}/COMMITTED`))) {
						await this.cleanupTransaction(transactionRelative)
						return
					}
					await this.rollbackTransaction(transactionRelative, { changes: records })
					await this.cleanupTransaction(transactionRelative)
				}
				catch (rollbackCause) {
					throw new PersistenceError('persistence.recovery_failed', 'A canonical multi-file write failed and rollback remains pending for recovery.', { cause: new AggregateError([cause, rollbackCause]) })
				}
			}
			else {
				await fs.rm(transactionAbsolute, { recursive: true, force: true }).catch(() => undefined)
			}
			if (cause instanceof PersistenceError)
				throw cause
			const label = applied ? 'failed during apply and the original canonical files were restored' : 'failed before canonical apply began'
			throw new PersistenceError(operation === 'migration' ? 'workspace.migration_failed' : 'persistence.write_failed', `Atomic ${operation} transaction ${label}.`, { cause })
		}
		await this.cleanupTransaction(transactionRelative).catch(() => undefined)
	}

	async hitFault(point: PersistenceFaultPoint, details: Readonly<{ path?: string; index?: number; operation?: TransactionOperation }>): Promise<void> {
		await this.fault?.(point, details)
	}

	async scanCanonicalSnapshotUnlocked(): Promise<Map<string, Uint8Array>> {
		const snapshot = new Map<string, Uint8Array>()
		// The manifest and, from schemaVersion 5, the Product Kit file; `kit/` is never part of it.
		for (const path of this.layout.canonicalFiles) {
			const bytes = await this.readOptionalBytesUnlocked(path)
			if (bytes)
				snapshot.set(path, Uint8Array.from(bytes))
		}
		for (const directory of ['views', 'flows', 'reviews', 'i18n'] as const)
			await this.scanFlatDirectoryUnlocked(directory, snapshot)
		await this.scanAssetsUnlocked(snapshot)
		return snapshot
	}

	/**
	 * The versioned files (Clause 01a11a5e-1eba-78ae-a204-52e286a95ddb) and their current bytes, keyed
	 * by Workspace-relative path in code unit order. Unlike the canonical scan it tolerates files the
	 * layout does not classify (such as `views/notes.txt`): they are not versioned, so they are left
	 * out instead of refused. Symbolic links are never followed: a linked versioned directory is
	 * refused, and a linked entry inside one is skipped. The caller holds the persistence lock.
	 */
	async scanVersionedSnapshotUnlocked(): Promise<Map<string, Uint8Array>> {
		const snapshot = new Map<string, Uint8Array>()
		for (const root of this.layout.versionedRoots) {
			if (root.endsWith('/')) {
				await this.scanVersionedDirectoryUnlocked(root.slice(0, -1), snapshot)
				continue
			}
			const bytes = await this.readOptionalBytesUnlocked(root)
			if (bytes && this.layout.classifyVersionedPath(root)) snapshot.set(root, Uint8Array.from(bytes))
		}
		return new Map([...snapshot].sort(([left], [right]) => compareCodeUnits(left, right)))
	}

	private async scanVersionedDirectoryUnlocked(directory: string, snapshot: Map<string, Uint8Array>): Promise<void> {
		const absoluteDirectory = resolveWorkspacePath(this.root, directory)
		await assertSafePath(this.root, `${directory}/.placeholder`, true)
		let entries: import('node:fs').Dirent[]
		try {
			entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })
		}
		catch (error) {
			if (isNotFound(error)) return
			throw error
		}
		if (await isSymlink(absoluteDirectory))
			throw pathRejected(`Versioned directory ${directory} is a symbolic link.`)
		for (const entry of entries) {
			const relativePath = `${directory}/${entry.name}`
			if (entry.isDirectory()) {
				if (relativePath.split('/').length < VERSIONED_SCAN_MAX_SEGMENTS)
					await this.scanVersionedDirectoryUnlocked(relativePath, snapshot)
				continue
			}
			if (!entry.isFile() || !this.layout.classifyVersionedPath(relativePath)) continue
			snapshot.set(relativePath, Uint8Array.from(await this.readBytesUnlocked(relativePath)))
		}
	}

	private async scanFlatDirectoryUnlocked(directory: string, snapshot: Map<string, Uint8Array>): Promise<void> {
		const absoluteDirectory = resolveWorkspacePath(this.root, directory)
		let entries: import('node:fs').Dirent[]
		await assertSafePath(this.root, `${directory}/.placeholder`, true)
		try {
			entries = await fs.readdir(absoluteDirectory, { withFileTypes: true })
		}
		catch (error) {
			if (isNotFound(error)) return
			throw error
		}
		if (await isSymlink(absoluteDirectory))
			throw pathRejected(`Canonical directory ${directory} is a symbolic link.`)
		for (const entry of entries) {
			if (!entry.isFile())
				throw pathRejected(`Canonical directory ${directory} contains a non-file entry ${entry.name}.`)
			const relativePath = `${directory}/${entry.name}`
			assertTransactionalPath(this.layout, relativePath)
			snapshot.set(relativePath, Uint8Array.from(await this.readBytesUnlocked(relativePath)))
		}
	}

	private async scanAssetsUnlocked(snapshot: Map<string, Uint8Array>): Promise<void> {
		const assetsPath = resolveWorkspacePath(this.root, 'assets')
		let directories: import('node:fs').Dirent[]
		await assertSafePath(this.root, 'assets/.placeholder', true)
		try {
			directories = await fs.readdir(assetsPath, { withFileTypes: true })
		}
		catch (error) {
			if (isNotFound(error)) return
			throw error
		}
		if (await isSymlink(assetsPath))
			throw pathRejected('Canonical assets directory is a symbolic link.')
		for (const directory of directories) {
			if (!directory.isDirectory())
				throw pathRejected(`Canonical assets directory contains non-directory entry ${directory.name}.`)
			if (!isFullUuid(directory.name))
				throw pathRejected(`Authored Asset directory ${directory.name} is not a full UUID.`)
			const relativeDirectory = `assets/${directory.name}`
			const absoluteDirectory = resolveWorkspacePath(this.root, relativeDirectory)
			const files = await fs.readdir(absoluteDirectory, { withFileTypes: true })
			for (const file of files) {
				if (!file.isFile())
					throw pathRejected(`Authored Asset ${directory.name} contains a non-file entry ${file.name}.`)
				const relativePath = `${relativeDirectory}/${file.name}`
				assertTransactionalPath(this.layout, relativePath)
				snapshot.set(relativePath, Uint8Array.from(await this.readBytesUnlocked(relativePath)))
			}
		}
	}

	private async recoverPendingTransactionsUnlocked(): Promise<void> {
		const transactionsPath = resolveWorkspacePath(this.root, this.layout.transactionsDir)
		let entries: import('node:fs').Dirent[]
		await assertSafePath(this.root, `${this.layout.transactionsDir}/.placeholder`, true)
		try {
			entries = await fs.readdir(transactionsPath, { withFileTypes: true })
		}
		catch (error) {
			if (isNotFound(error)) return
			throw error
		}
		if (await isSymlink(transactionsPath))
			throw new PersistenceError('persistence.recovery_failed', 'Persistence transaction directory is a symbolic link.')
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.startsWith('.cleanup-') && isFullUuid(entry.name.slice('.cleanup-'.length))) {
				await fs.rm(resolveWorkspacePath(this.root, `${this.layout.transactionsDir}/${entry.name}`), { recursive: true, force: true })
				continue
			}
			if (!entry.isDirectory() || !isFullUuid(entry.name))
				throw new PersistenceError('persistence.recovery_failed', `Unrecognized persistence transaction entry ${entry.name}.`)
			const transactionRelative = `${this.layout.transactionsDir}/${entry.name}`
			const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
			const journalPath = resolveWorkspacePath(this.root, `${transactionRelative}/journal.json`)
			await assertSafePath(this.root, `${transactionRelative}/journal.json`, false).catch(error => {
				if (!isNotFound(error)) throw error
			})
			if (!await fileExists(journalPath)) {
				await fs.rm(transactionAbsolute, { recursive: true, force: true })
				continue
			}
			// A journal written for another layout belongs to another root's files: keep it and stop.
			const recordedLayout = await readJournalLayout(journalPath)
			if (recordedLayout !== undefined && recordedLayout !== this.layout.id)
				throw new PersistenceError('persistence.recovery_failed', `Pending transaction ${entry.name} was written for the ${recordedLayout} Workspace layout, not the ${this.layout.id} layout this root was opened with; it was kept, and canonical reads and writes are blocked.`)
			const committedPath = resolveWorkspacePath(this.root, `${transactionRelative}/COMMITTED`)
			await assertSafePath(this.root, `${transactionRelative}/COMMITTED`, false).catch(error => {
				if (!isNotFound(error)) throw error
			})
			if (await fileExists(committedPath)) {
				await fs.rm(transactionAbsolute, { recursive: true, force: true })
				continue
			}
			try {
				const journalValue = JSON.parse(await fs.readFile(journalPath, 'utf8')) as unknown
				const journal = validateTransactionJournal(journalValue, this.layout)
				await this.rollbackTransaction(transactionRelative, journal)
				await fs.rm(transactionAbsolute, { recursive: true, force: true })
			}
			catch (cause) {
				throw new PersistenceError('persistence.recovery_failed', `Could not safely recover pending transaction ${entry.name}; canonical reads and writes are blocked.`, { cause })
			}
		}
	}

	private async rollbackTransaction(transactionRelative: string, journal: TransactionJournal): Promise<void> {
		for (const change of [...journal.changes].reverse()) {
			const target = resolveWorkspacePath(this.root, change.path)
			if (!change.existed) {
				await fs.rm(target, { force: true })
				await syncDirectory(dirname(target))
				continue
			}
			const backup = resolveWorkspacePath(this.root, `${transactionRelative}/backup/${change.path}`)
			let backupBytes: Buffer
			try {
				backupBytes = await fs.readFile(backup)
			}
			catch (cause) {
				throw new Error(`Transaction backup for ${change.path} is missing or unreadable.`, { cause })
			}
			await atomicWriteWithoutFault(this.root, change.path, backupBytes)
		}
	}

	private async cleanupTransaction(transactionRelative: string): Promise<void> {
		const transactionId = transactionRelative.split('/').at(-1)
		if (!transactionId || !isFullUuid(transactionId))
			throw new PersistenceError('persistence.path_rejected', 'Cannot clean a transaction without its internal UUID identity.')
		const tombstoneRelative = `${this.layout.transactionsDir}/.cleanup-${transactionId}`
		const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
		const tombstoneAbsolute = resolveWorkspacePath(this.root, tombstoneRelative)
		try { await fs.rename(transactionAbsolute, tombstoneAbsolute) }
		catch (error) {
			if (!isNotFound(error)) throw error
			return
		}
		await syncDirectory(resolveWorkspacePath(this.root, this.layout.transactionsDir))
		await fs.rm(tombstoneAbsolute, { recursive: true, force: true })
	}

	private async acquireLock(deadline: number): Promise<() => Promise<void>> {
		await ensureSafeDirectory(this.root, this.layout.metadataDir)
		const lockAbsolute = resolveWorkspacePath(this.root, this.layout.lockPath)
		const lockParent = dirname(lockAbsolute)
		const token = randomUUID()
		while (true) {
			const candidateRelative = this.layout.metadataFilePath(`.persistence-lock-${token}-${randomUUID()}.tmp`)
			const candidateAbsolute = resolveWorkspacePath(this.root, candidateRelative)
			let published = false
			try {
				await writeSyncedFile(candidateAbsolute, Buffer.from(JSON.stringify({ pid: process.pid, token }), 'utf8'), true)
				try {
					await fs.link(candidateAbsolute, lockAbsolute)
					published = true
				}
				catch (error) {
					if (!isAlreadyExists(error)) throw error
					await fs.rm(candidateAbsolute, { force: true }).catch(() => undefined)
					if (await this.removeStaleLock(lockAbsolute))
						continue
					if (Date.now() >= deadline)
						throw lockBusyError()
					await delay(10)
					continue
				}
				await syncDirectory(lockParent)
				await fs.rm(candidateAbsolute, { force: true }).catch(() => undefined)
				return async () => {
					let owner: { token?: unknown }
					try {
						const stat = await fs.lstat(lockAbsolute)
						if (!stat.isFile() || stat.isSymbolicLink()) return
						owner = JSON.parse(await fs.readFile(lockAbsolute, 'utf8')) as { token?: unknown }
					}
					catch (error) {
						if (isNotFound(error)) return
						throw error
					}
					if (owner.token !== token) return
					await fs.rm(lockAbsolute, { force: true })
					await syncDirectory(lockParent)
				}
			}
			catch (error) {
				await fs.rm(candidateAbsolute, { force: true }).catch(() => undefined)
				if (published) {
					try {
						const owner = JSON.parse(await fs.readFile(lockAbsolute, 'utf8')) as { token?: unknown }
						if (owner.token === token) {
							await fs.rm(lockAbsolute, { force: true })
							await syncDirectory(lockParent)
						}
					}
					catch { /* preserve the original acquisition failure */ }
				}
				throw error
			}
		}
	}

	private async removeStaleLock(lockAbsolute: string): Promise<boolean> {
		let stat: import('node:fs').Stats
		try { stat = await fs.lstat(lockAbsolute) }
		catch (error) {
			if (isNotFound(error)) return true
			throw error
		}
		if (!stat.isFile() || stat.isSymbolicLink())
			throw pathRejected('Persistence lock must be a regular file and must not be a symbolic link.')
		let owner: { pid?: unknown; token?: unknown }
		try { owner = JSON.parse(await fs.readFile(lockAbsolute, 'utf8')) as { pid?: unknown; token?: unknown } }
		catch (cause) {
			if (isNotFound(cause)) return true
			throw new PersistenceError('persistence.lock_busy', 'Persistence lock owner record is unreadable; refusing to remove it automatically.', { cause })
		}
		if (typeof owner.pid !== 'number' || !Number.isInteger(owner.pid) || typeof owner.token !== 'string' || !isFullUuid(owner.token))
			throw new PersistenceError('persistence.lock_busy', 'Persistence lock owner record is invalid; refusing to remove it automatically.')
		try {
			process.kill(owner.pid, 0)
			return false
		}
		catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false
			await fs.rm(lockAbsolute, { force: true })
			await syncDirectory(dirname(lockAbsolute))
			return true
		}
	}

}

type SharedLockHold = {
	holders: number
	/** Resolves to the release of the cross-process lock once it is held and recovery has run. */
	ready: Promise<() => Promise<void>>
}

function lockBusyError(): PersistenceError {
	return new PersistenceError('persistence.lock_busy', 'Timed out waiting for another UIUX persistence operation to finish.')
}

type GateWaiter = { mode: 'shared' | 'exclusive'; grant: () => void }

/**
 * In-process admission to the persistence lock, first come first served: any number of shared
 * holders at once, or one exclusive holder. A shared request queues behind a waiting exclusive one
 * (no writer starvation) and once the running shared batch is older than MAX_SHARED_BATCH_MS.
 */
class ProcessLockGate {
	private shared = 0
	private exclusive = false
	private batchStartedAt = 0
	private readonly queue: GateWaiter[] = []

	async enter(mode: 'shared' | 'exclusive', deadline: number): Promise<() => void> {
		if (this.queue.length === 0 && this.admits(mode)) {
			this.admit(mode)
			return this.leaver(mode)
		}
		await new Promise<void>((resolve, reject) => {
			const waiter: GateWaiter = { mode, grant: () => { clearTimeout(timer); resolve() } }
			const timer = setTimeout(() => {
				const index = this.queue.indexOf(waiter)
				if (index < 0) return
				this.queue.splice(index, 1)
				reject(lockBusyError())
				this.drain()
			}, Math.max(0, deadline - Date.now()))
			this.queue.push(waiter)
		})
		return this.leaver(mode)
	}

	private admits(mode: 'shared' | 'exclusive'): boolean {
		if (this.exclusive) return false
		if (mode === 'exclusive') return this.shared === 0
		return this.shared === 0 || Date.now() - this.batchStartedAt < MAX_SHARED_BATCH_MS
	}

	private admit(mode: 'shared' | 'exclusive'): void {
		if (mode === 'exclusive') {
			this.exclusive = true
			return
		}
		if (this.shared === 0) this.batchStartedAt = Date.now()
		this.shared += 1
	}

	private leaver(mode: 'shared' | 'exclusive'): () => void {
		let left = false
		return () => {
			if (left) return
			left = true
			if (mode === 'exclusive') this.exclusive = false
			else this.shared -= 1
			this.drain()
		}
	}

	private drain(): void {
		while (this.queue.length > 0) {
			const head = this.queue[0]!
			if (!this.admits(head.mode)) return
			this.queue.shift()
			this.admit(head.mode)
			head.grant()
		}
	}
}

export class JsonResourceRepository<Key extends string, Resource> implements MutableResourceRepository<Key, Resource> {
	constructor(
		private readonly persistence: FileNativePersistence,
		private readonly pathFor: (key: Key) => string,
		private readonly identityField: string,
		private readonly validate: JsonValidator,
		private readonly discovery: Readonly<{ directory: string; suffix: string }>,
	) {}

	async discoverKeys(): Promise<readonly Key[]> {
		return this.persistence.withReadLock(async () => {
			const absolute = resolveWorkspacePath(this.persistence.root, this.discovery.directory)
			await assertSafePath(this.persistence.root, `${this.discovery.directory}/.placeholder`, true)
			let entries: import('node:fs').Dirent[]
			try { entries = await fs.readdir(absolute, { withFileTypes: true }) }
			catch (error) { if (isNotFound(error)) return []; throw error }
			return entries
				.filter(entry => entry.isFile() && entry.name.endsWith(this.discovery.suffix))
				.map(entry => entry.name.slice(0, -this.discovery.suffix.length))
				.filter(isFullUuid)
				.sort() as Key[]
		})
	}

	async read(key: Key): Promise<RevisionedResourceRead<Resource> | undefined> {
		const inspected = await this.readInspected(key)
		return inspected && { resource: inspected.resource, revision: inspected.revision }
	}

	async readRevision(key: Key): Promise<ResourceRevision | undefined> {
		return this.persistence.withReadLock(async () => {
			const bytes = await this.persistence.readOptionalBytesUnlocked(this.pathFor(key))
			return bytes ? revisionForBytes(bytes) : undefined
		})
	}


	async readInspected(key: Key): Promise<InspectedResource<Resource> | undefined> {
		return this.persistence.withReadLock(async () => {
			const path = this.pathFor(key)
			const bytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!bytes) return undefined
			const resource = parseJsonBytes(bytes, path)
			const schemaVersion = await this.persistence.readDecodeSchemaVersionUnlocked()
			return { resource: resource as Resource, revision: revisionForBytes(bytes), diagnostics: this.validate(resource, basename(path), schemaVersion) }
		})
	}

	async create(key: Key, resource: Resource): Promise<ResourceRevision> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = this.pathFor(key)
			assertEmbeddedIdentity(key, resource, this.identityField, basename(path))
			if (await this.persistence.readOptionalBytesUnlocked(path))
				throw new PersistenceError('persistence.resource_exists', `Canonical resource ${path} already exists.`)
			const bytes = this.persistence.serializeJson(resource, path)
			if (!await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicCreateUnlocked(path, bytes)))
				throw new PersistenceError('persistence.resource_exists', `Canonical resource ${path} already exists.`)
			return revisionForBytes(bytes)
		})
	}

	async compareAndSwap(input: Readonly<{ key: Key; expectedRevision: ResourceRevision; resource: Resource }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = this.pathFor(input.key)
			const currentBytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!currentBytes)
				throw new PersistenceError('persistence.resource_not_found', `Canonical resource ${path} does not exist.`)
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision } }
			const current = parseJsonBytes(currentBytes, path)
			assertEmbeddedIdentity(input.key, current, this.identityField, basename(path))
			assertEmbeddedIdentity(input.key, input.resource, this.identityField, basename(path))
			const bytes = this.persistence.serializeJson(input.resource, path)
			await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicWriteUnlocked(path, bytes, currentBytes))
			return { ok: true, revision: revisionForBytes(bytes) }
		})
	}

	/**
	 * The store's only whole-resource delete (accepted Review retract decision 7, used for Reviews).
	 * Under the cross-process exclusive lock it checks writability, compares the content-derived
	 * revision, checks embedded identity and runs the domain `guard` on exactly those bytes, then
	 * unlinks the file and fsyncs its directory. One unlink is atomic: a crash leaves the old file or
	 * no file, so there is no journal and no backup copy of the withdrawn content.
	 */
	async deleteIfRevision<Refusal>(input: Readonly<{
		key: Key
		expectedRevision: ResourceRevision
		guard?: (resource: Resource, context: DeleteGuardContext) => Refusal | undefined | Promise<Refusal | undefined>
	}>): Promise<DeleteIfRevisionResult<Refusal>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = this.pathFor(input.key)
			const currentBytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!currentBytes) return { status: 'not_found' }
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision) return { status: 'conflict', currentRevision }
			const current = parseJsonBytes(currentBytes, path)
			assertEmbeddedIdentity(input.key, current, this.identityField, basename(path))
			const refusal = await input.guard?.(current as Resource, {
				readJsonUnlocked: async (relativePath) => {
					const bytes = await this.persistence.readOptionalBytesUnlocked(relativePath)
					return bytes ? parseJsonBytes(bytes, relativePath) : undefined
				},
			})
			if (refusal !== undefined) return { status: 'refused', refusal }
			await commitCanonicalWrite(this.persistence, [{ path }], () => this.persistence.removeUnlocked(path))
			return { status: 'deleted' }
		})
	}
}

export class WorkspaceFileRepository implements MutableResourceRepository<'workspace', WorkspaceManifest> {
	constructor(private readonly persistence: FileNativePersistence) {}

	async read(_key: 'workspace'): Promise<RevisionedResourceRead<WorkspaceManifest> | undefined> {
		void _key
		const result = await this.persistence.inspectWorkspace()
		if (!result.resource || !result.revision) return undefined
		return { resource: result.resource, revision: result.revision }
	}

	async readInspected(): Promise<WorkspaceReadInspection> {
		return this.persistence.inspectWorkspace()
	}

	async create(resource: WorkspaceManifest): Promise<ResourceRevision> {
		return this.persistence.withLock(async () => {
			if (resource.schemaVersion !== this.persistence.schemaPolicy.currentVersion)
				throw new PersistenceError('workspace.schema_unsupported', 'A new Workspace must use the injected policy currentVersion.')
			const path = this.persistence.layout.manifestPath
			if (await this.persistence.readOptionalBytesUnlocked(path))
				throw new PersistenceError('persistence.resource_exists', 'Workspace manifest already exists.')
			const bytes = this.persistence.serializeJson(resource, path)
			if (!await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicCreateUnlocked(path, bytes)))
				throw new PersistenceError('persistence.resource_exists', 'Workspace manifest already exists.')
			return revisionForBytes(bytes)
		})
	}

	async compareAndSwap(input: Readonly<{ key: 'workspace'; expectedRevision: ResourceRevision; resource: WorkspaceManifest }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			if (input.resource.schemaVersion !== this.persistence.schemaPolicy.currentVersion)
				throw new PersistenceError('workspace.schema_unsupported', 'Normal Workspace writes must keep the schemaVersion at the injected policy currentVersion.')
			const path = this.persistence.layout.manifestPath
			const currentBytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!currentBytes)
				throw new PersistenceError('workspace.manifest_missing', 'Workspace manifest does not exist.')
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision } }
			const bytes = this.persistence.serializeJson(input.resource, path)
			await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicWriteUnlocked(path, bytes, currentBytes))
			return { ok: true, revision: revisionForBytes(bytes) }
		})
	}
}

/**
 * The Product Kit file `product-kit.json` (Clause 01a11bb1-8e31-7b25-b6b8-da667b201670), one
 * single-file resource of kind and key `product-kit`, from `schemaVersion` 5. In the old layout
 * the Workspace has none: reads find nothing and writes are refused. Writes are canonical design
 * writes like the manifest's (versioned, observed by history); validating the content is the
 * authoring operation's job, as for the other repositories.
 */
export class ProductKitFileRepository implements MutableResourceRepository<'product-kit', ProductKit> {
	constructor(private readonly persistence: FileNativePersistence) {}

	async read(_key: 'product-kit' = PRODUCT_KIT_RESOURCE_KEY): Promise<RevisionedResourceRead<ProductKit> | undefined> {
		void _key
		const inspected = await this.readInspected()
		return inspected && { resource: inspected.resource, revision: inspected.revision }
	}

	async readRevision(): Promise<ResourceRevision | undefined> {
		return this.persistence.withReadLock(async () => {
			const path = this.persistence.layout.productKitPath
			const bytes = path ? await this.persistence.readOptionalBytesUnlocked(path) : undefined
			return bytes ? revisionForBytes(bytes) : undefined
		})
	}

	async readInspected(): Promise<InspectedResource<ProductKit> | undefined> {
		return this.persistence.withReadLock(async () => {
			const path = this.persistence.layout.productKitPath
			if (!path) return undefined
			const bytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!bytes) return undefined
			const resource = parseJsonBytes(bytes, path)
			return { resource: resource as ProductKit, revision: revisionForBytes(bytes), diagnostics: validateProductKit(resource).diagnostics }
		})
	}

	async create(resource: ProductKit): Promise<ResourceRevision> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked({ productKitMayBeMissing: true })
			const path = this.pathUnlocked()
			if (await this.persistence.readOptionalBytesUnlocked(path))
				throw new PersistenceError('persistence.resource_exists', 'The Product Kit file already exists.')
			const bytes = this.persistence.serializeJson(resource, path)
			if (!await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicCreateUnlocked(path, bytes)))
				throw new PersistenceError('persistence.resource_exists', 'The Product Kit file already exists.')
			return revisionForBytes(bytes)
		})
	}

	async compareAndSwap(input: Readonly<{ key: 'product-kit'; expectedRevision: ResourceRevision; resource: ProductKit }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = this.pathUnlocked()
			const currentBytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!currentBytes)
				throw new PersistenceError('persistence.resource_not_found', 'The Product Kit file does not exist.')
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision } }
			const bytes = this.persistence.serializeJson(input.resource, path)
			await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicWriteUnlocked(path, bytes, currentBytes))
			return { ok: true, revision: revisionForBytes(bytes) }
		})
	}

	private pathUnlocked(): string {
		const path = this.persistence.layout.productKitPath
		if (!path)
			throw new PersistenceError('persistence.path_rejected', `A Workspace below schemaVersion ${PRODUCT_KIT_SCHEMA_VERSION} has no Product Kit file; its Adapter list is in the manifest.`)
		return path
	}
}

/**
 * How the `i18n/` directory holds one canonical locale filename. Locale identity is the exact,
 * case-sensitive canonical tag (discovery accepts only exactly cased canonical filenames), but a
 * case-insensitive volume resolves `i18n/zh-TW.json` to a case variant such as `zh-tw.json`.
 * Every locale read and write therefore checks the directory entry, not just the path.
 */
type LocaleEntryState =
	| Readonly<{ kind: 'exact' }>
	| Readonly<{ kind: 'absent' }>
	/** Only a case variant exists and the volume aliases the canonical path to it. */
	| Readonly<{ kind: 'aliased_variant'; entryName: string }>

export class LocaleFileRepository implements MutableResourceRepository<string, I18nResource> {
	constructor(private readonly persistence: FileNativePersistence) {}

	async read(locale: string): Promise<RevisionedResourceRead<I18nResource> | undefined> {
		const result = await this.readInspected(locale)
		return result && { resource: result.resource, revision: result.revision }
	}

	async readRevision(locale: string): Promise<ResourceRevision | undefined> {
		return this.persistence.withReadLock(async () => {
			const bytes = await this.readExactBytesUnlocked(locale)
			return bytes ? revisionForBytes(bytes) : undefined
		})
	}


	async readInspected(locale: string): Promise<InspectedResource<I18nResource> | undefined> {
		return this.persistence.withReadLock(async () => {
			const path = localeRelativePath(locale)
			const bytes = await this.readExactBytesUnlocked(locale)
			if (!bytes) return undefined
			const resource = parseJsonBytes(bytes, path)
			return { resource: resource as I18nResource, revision: revisionForBytes(bytes), diagnostics: validateI18nResource(resource, basename(path)).diagnostics }
		})
	}

	async discover(): Promise<readonly string[]> {
		return (await this.discoverInspected()).locales
	}

	async discoverInspected(): Promise<Readonly<{ locales: readonly string[]; diagnostics: readonly Diagnostic[] }>> {
		return this.persistence.withReadLock(async () => {
			const entries = await this.readLocaleDirectoryUnlocked()
			const locales: string[] = []
			const diagnostics: Diagnostic[] = []
			for (const entry of entries) {
				if (entry.isFile() && isCanonicalLocaleFilename(entry.name)) {
					locales.push(entry.name.slice(0, -'.json'.length))
					continue
				}
				diagnostics.push({ code: 'i18n.invalid_locale_filename', path: `/i18n/${entry.name}`, message: 'Locale discovery accepts only flat files named by canonical BCP 47 tags.' })
			}
			return { locales: locales.sort(), diagnostics }
		})
	}

	async create(locale: string, resource: I18nResource): Promise<ResourceRevision> {
		return this.writeNew(locale, resource)
	}

	private async writeNew(locale: string, resource: I18nResource): Promise<ResourceRevision> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = localeRelativePath(locale)
			const entry = await this.localeEntryUnlocked(locale)
			if (entry.kind === 'exact')
				throw new PersistenceError('persistence.resource_exists', `Locale resource ${path} already exists.`)
			if (entry.kind === 'aliased_variant')
				throw caseVariantCollision(locale, entry.entryName)
			const bytes = this.persistence.serializeJson(resource, path)
			if (!await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicCreateUnlocked(path, bytes))) {
				// Lost a race to a writer outside this process; re-check which name now holds the slot.
				const after = await this.localeEntryUnlocked(locale)
				if (after.kind === 'aliased_variant') throw caseVariantCollision(locale, after.entryName)
				throw new PersistenceError('persistence.resource_exists', `Locale resource ${path} already exists.`)
			}
			return revisionForBytes(bytes)
		})
	}

	async compareAndSwap(input: Readonly<{ key: string; expectedRevision: ResourceRevision; resource: I18nResource }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const path = localeRelativePath(input.key)
			const currentBytes = await this.readExactBytesUnlocked(input.key)
			if (!currentBytes)
				throw new PersistenceError('persistence.resource_not_found', `Locale resource ${path} does not exist.`)
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision } }
			const bytes = this.persistence.serializeJson(input.resource, path)
			await commitCanonicalWrite(this.persistence, [{ path, bytes }], () => this.persistence.atomicWriteUnlocked(path, bytes, currentBytes))
			return { ok: true, revision: revisionForBytes(bytes) }
		})
	}

	private async readLocaleDirectoryUnlocked(): Promise<import('node:fs').Dirent[]> {
		const absolute = resolveWorkspacePath(this.persistence.root, 'i18n')
		await assertSafePath(this.persistence.root, 'i18n/.placeholder', true)
		try { return await fs.readdir(absolute, { withFileTypes: true }) }
		catch (error) {
			if (isNotFound(error)) return []
			throw error
		}
	}

	private async localeEntryUnlocked(locale: string): Promise<LocaleEntryState> {
		const expected = basename(localeRelativePath(locale))
		const entries = await this.readLocaleDirectoryUnlocked()
		if (entries.some(entry => entry.name === expected)) return { kind: 'exact' }
		const folded = expected.toLowerCase()
		const variant = entries.find(entry => entry.name.toLowerCase() === folded)
		// On a case-sensitive volume a variant is just another (invalid) file and does not occupy the slot.
		if (variant && await fileExists(resolveWorkspacePath(this.persistence.root, localeRelativePath(locale))))
			return { kind: 'aliased_variant', entryName: variant.name }
		return { kind: 'absent' }
	}

	/** Reads the canonical locale file only when the directory entry carries the exact canonical casing. */
	private async readExactBytesUnlocked(locale: string): Promise<Buffer | undefined> {
		const path = localeRelativePath(locale)
		if ((await this.localeEntryUnlocked(locale)).kind !== 'exact') return undefined
		return this.persistence.readOptionalBytesUnlocked(path)
	}
}

function caseVariantCollision(locale: string, entryName: string): PersistenceError {
	return new PersistenceError(
		'persistence.path_rejected',
		`Locale ${locale} cannot be created: this volume is case-insensitive and i18n/${entryName} already occupies i18n/${locale}.json.`,
		{
			diagnostics: [{
				code: 'i18n.invalid_locale_filename',
				path: `/i18n/${entryName}`,
				message: `This noncanonically cased file occupies the path of locale ${locale} on a case-insensitive volume. Rename it to ${locale}.json or remove it before creating ${locale}.`,
			}],
		},
	)
}

export class AuthoredAssetFileRepository implements MutableResourceRepository<string, AuthoredAssetResource> {
	constructor(private readonly persistence: FileNativePersistence) {}

	async discoverKeys(): Promise<readonly string[]> {
		return this.persistence.withReadLock(async () => {
			const absolute = resolveWorkspacePath(this.persistence.root, 'assets')
			await assertSafePath(this.persistence.root, 'assets/.placeholder', true)
			let entries: import('node:fs').Dirent[]
			try { entries = await fs.readdir(absolute, { withFileTypes: true }) }
			catch (error) { if (isNotFound(error)) return []; throw error }
			const keys: string[] = []
			for (const entry of entries) {
				if (!isFullUuid(entry.name)) continue
				if (entry.isSymbolicLink()) continue
				const entryAbsolute = resolve(absolute, entry.name)
				try {
					const stat = await fs.lstat(entryAbsolute)
					if (!stat.isDirectory() || stat.isSymbolicLink()) continue
					keys.push(entry.name)
				}
				catch {
					continue
				}
			}
			return keys.sort()
		})
	}

	async readRevision(id: string): Promise<ResourceRevision | undefined> {
		return this.persistence.withReadLock(async () => {
			const metadataPath = assetMetadataRelativePath(id)
			const metadataBytes = await this.persistence.readOptionalBytesUnlocked(metadataPath)
			if (!metadataBytes) return undefined
			try {
				const inspected = await this.readAssetUnlocked(id)
				return inspected?.revision
			}
			catch {
				return revisionForBytes(metadataBytes)
			}
		})
	}

	async read(id: string): Promise<RevisionedResourceRead<AuthoredAssetResource> | undefined> {
		const inspected = await this.readInspected(id)
		return inspected && { resource: inspected.resource, revision: inspected.revision }
	}

	async readInspected(id: string): Promise<AuthoredAssetInspection | undefined> {
		return this.persistence.withReadLock(async () => this.readAssetUnlocked(id))
	}

	async create(id: string, resource: AuthoredAssetResource): Promise<ResourceRevision> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const directory = assetDirectoryRelativePath(id)
			const metadataPath = assetMetadataRelativePath(id)
			if (await this.persistence.readOptionalBytesUnlocked(metadataPath))
				throw new PersistenceError('persistence.resource_exists', `Authored Asset ${id} already exists.`)
			const directoryAbsolute = resolveWorkspacePath(this.persistence.root, directory)
			let existingEntries: import('node:fs').Dirent[]
			try {
				await assertSafePath(this.persistence.root, `${directory}/.placeholder`, true)
				existingEntries = await fs.readdir(directoryAbsolute, { withFileTypes: true })
			}
			catch (error) {
				if (!isNotFound(error)) throw error
				existingEntries = []
			}
			if (existingEntries.length > 0)
				throw new PersistenceError('persistence.asset_shape_invalid', `Cannot create Authored Asset ${id} over existing unowned files.`)
			const candidate = this.prepareCandidate(id, resource)
			const changes: FileChange[] = [
				{ path: metadataPath, bytes: candidate.metadataBytes },
				{ path: `${directory}/${resource.metadata.contentFilename}`, bytes: resource.content },
			]
			// applyFileTransaction returns only once its journal is committed, so the observer sees a committed Asset.
			await commitCanonicalWrite(this.persistence, changes, () => this.persistence.applyFileTransaction(changes, 'asset'))
			return assetRevision(candidate.metadataBytes, [{ filename: resource.metadata.contentFilename, bytes: resource.content }])
		})
	}

	async compareAndSwap(input: Readonly<{ key: string; expectedRevision: ResourceRevision; resource: AuthoredAssetResource }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const current = await this.readAssetUnlocked(input.key)
			if (!current)
				throw new PersistenceError('persistence.resource_not_found', `Authored Asset ${input.key} does not exist.`)
			if (input.expectedRevision !== current.revision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision: current.revision } }
			if (current.diagnostics.some(item => [
				'identity.directory_id_mismatch',
				'identity.invalid_uuid',
				'asset.invalid_content_file_count',
				'asset.content_filename_mismatch',
				'asset.invalid_content_entry',
				'asset.invalid_content_filename',
				'schema.expected_object',
			].includes(item.code)))
				throw new PersistenceError('persistence.identity_mismatch', 'Cannot authoritatively update an Asset whose on-disk identity or source-file set is mismatched.', { diagnostics: current.diagnostics })
			const candidate = this.prepareCandidate(input.key, input.resource)
			const directory = assetDirectoryRelativePath(input.key)
			const metadataPath = assetMetadataRelativePath(input.key)
			const changes: FileChange[] = [{ path: metadataPath, bytes: candidate.metadataBytes }]
			for (const filename of current.actualContentFilenames) {
				if (filename !== input.resource.metadata.contentFilename)
					changes.push({ path: `${directory}/${filename}` })
			}
			changes.push({ path: `${directory}/${input.resource.metadata.contentFilename}`, bytes: input.resource.content })
			await commitCanonicalWrite(this.persistence, changes, () => this.persistence.applyFileTransaction(changes, 'asset'))
			return {
				ok: true,
				revision: assetRevision(candidate.metadataBytes, [{ filename: input.resource.metadata.contentFilename, bytes: input.resource.content }]),
			}
		})
	}

	private prepareCandidate(id: string, resource: AuthoredAssetResource): Readonly<{ metadataBytes: Buffer }> {
		assetDirectoryRelativePath(id)
		if (!isRecord(resource) || !isRecord(resource.metadata) || resource.metadata.id !== id)
			throw new PersistenceError('persistence.identity_mismatch', 'Authored Asset metadata.id must exactly match the immutable directory UUID.')
		if (!isSafeAssetContentFilename(resource.metadata.contentFilename))
			throw new PersistenceError('persistence.path_rejected', 'Authored Asset contentFilename must be a safe single filename.')
		if (!(resource.content instanceof Uint8Array))
			throw new PersistenceError('persistence.invalid_resource', 'Authored Asset source content must be supplied as bytes.')
		const metadataBytes = this.persistence.serializeJson(resource.metadata, assetMetadataRelativePath(id))
		return { metadataBytes }
	}

	private async readAssetUnlocked(id: string): Promise<AuthoredAssetInspection | undefined> {
		const directory = assetDirectoryRelativePath(id)
		const metadataPath = assetMetadataRelativePath(id)
		const metadataBytes = await this.persistence.readOptionalBytesUnlocked(metadataPath)
		if (!metadataBytes) return undefined
		const metadataValue = parseJsonBytes(metadataBytes, metadataPath)
		const metadata = metadataValue as AuthoredAsset
		const diagnostics: Diagnostic[] = [...validateAssetMetadata(metadataValue, id).diagnostics]
		const directoryAbsolute = resolveWorkspacePath(this.persistence.root, directory)
		let entries: import('node:fs').Dirent[]
		await assertSafePath(this.persistence.root, `${directory}/.placeholder`, true)
		try { entries = await fs.readdir(directoryAbsolute, { withFileTypes: true }) }
		catch (error) {
			if (isNotFound(error))
				return undefined
			throw error
		}
		const contentEntries: import('node:fs').Dirent[] = []
		for (const entry of entries) {
			if (entry.name === 'asset.json') continue
			if (!entry.isFile()) {
				diagnostics.push({ code: 'asset.invalid_content_entry', path: `/assets/${id}/${entry.name}`, message: 'Authored Asset source content must be a regular file.' })
				continue
			}
			contentEntries.push(entry)
		}
		const contentFilenames = contentEntries.map(entry => entry.name).sort()
		if (isRecord(metadataValue))
			diagnostics.push(...validateAssetContentFiles(metadata, contentFilenames).diagnostics)
		const contentFiles: { filename: string; bytes: Buffer }[] = []
		for (const entry of contentEntries) {
			if (!isSafeAssetContentFilename(entry.name)) {
				diagnostics.push({ code: 'asset.invalid_content_filename', path: `/assets/${id}/${entry.name}`, message: 'Asset content filename is not a safe basename.' })
				continue
			}
			contentFiles.push({ filename: entry.name, bytes: await this.persistence.readBytesUnlocked(`${directory}/${entry.name}`) })
		}
		const matchingFile = contentFiles.find(file => file.filename === metadata?.contentFilename)
		if (isRecord(metadataValue) && contentFiles.length === 1 && isSafeAssetContentFilename(metadata.contentFilename) && matchingFile)
			diagnostics.push(...validateAssetContentMetadata(metadata, metadata.contentFilename, matchingFile.bytes).diagnostics)
		const selected = matchingFile?.bytes ?? Buffer.alloc(0)
		const revision = assetRevision(metadataBytes, contentFiles)
		return {
			resource: { metadata, content: Uint8Array.from(selected) },
			revision,
			actualContentFilenames: contentFiles.map(file => file.filename),
			diagnostics,
		}
	}
}

export class ImmutableArtifactStore {
	constructor(private readonly persistence: FileNativePersistence) {}

	async put(bytes: Uint8Array): Promise<ArtifactWriteResult> {
		if (!(bytes instanceof Uint8Array))
			throw new PersistenceError('persistence.invalid_resource', 'Artifact content must be supplied as bytes.')
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			return this.putUnlocked(bytes)
		})
	}

	/**
	 * `put` for a producer that already holds the exclusive persistence lock and has decided whether
	 * the Workspace state allows it (a checkpoint writer, which may also run before a migration).
	 */
	async putUnlocked(bytes: Uint8Array): Promise<ArtifactWriteResult> {
		if (!(bytes instanceof Uint8Array))
			throw new PersistenceError('persistence.invalid_resource', 'Artifact content must be supplied as bytes.')
		const identity = digestBytes(bytes)
		const relativePath = this.persistence.layout.artifactRelativePath(identity)
		const existing = await this.persistence.readOptionalBytesUnlocked(relativePath)
		if (existing) {
			if (digestBytes(existing) !== identity)
				throw new PersistenceError('persistence.artifact_corrupt', `Existing immutable artifact ${identity} does not match its content identity.`)
			return { identity, created: false }
		}
		const created = await this.persistence.atomicCreateImmutableUnlocked(relativePath, bytes)
		if (!created) {
			const racedExisting = await this.persistence.readBytesUnlocked(relativePath)
			if (digestBytes(racedExisting) !== identity)
				throw new PersistenceError('persistence.artifact_corrupt', `Existing immutable artifact ${identity} does not match its content identity.`)
			return { identity, created: false }
		}
		return { identity, created }
	}

	async read(identity: string): Promise<Uint8Array | undefined> {
		return this.persistence.withReadLock(async () => {
			const relativePath = this.persistence.layout.artifactRelativePath(identity)
			const bytes = await this.persistence.readOptionalBytesUnlocked(relativePath)
			if (!bytes) return undefined
			if (digestBytes(bytes) !== identity)
				throw new PersistenceError('persistence.artifact_corrupt', `Existing immutable artifact ${identity} does not match its content identity.`)
			return Uint8Array.from(bytes)
		})
	}

	async readCandidateJson<T = unknown>(identity: string, maxBytes = 512 * 1024): Promise<T | undefined> {
		return this.persistence.withReadLock(async () => {
			const relativePath = this.persistence.layout.artifactRelativePath(identity)
			const absolutePath = resolveWorkspacePath(this.persistence.root, relativePath)
			let stats: import('node:fs').Stats
			try {
				stats = await fs.stat(absolutePath)
			}
			catch (error) {
				if (isNotFound(error)) return undefined
				throw error
			}
			if (stats.size === 0 || stats.size > maxBytes) {
				return undefined
			}
			const bytes = await this.persistence.readOptionalBytesUnlocked(relativePath)
			if (!bytes) return undefined
			if (digestBytes(bytes) !== identity)
				throw new PersistenceError('persistence.artifact_corrupt', `Existing immutable artifact ${identity} does not match its content identity.`)

			// Quick binary magic / prefix check: JSON object/array must begin with whitespace or { / [
			let firstNonWhitespace = -1
			for (let i = 0; i < Math.min(bytes.length, 64); i++) {
				const b = bytes[i]!
				if (b !== 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D) {
					firstNonWhitespace = b
					break
				}
			}
			if (firstNonWhitespace !== 0x7B && firstNonWhitespace !== 0x5B) {
				return undefined
			}

			let text: string
			try {
				const decoder = new TextDecoder('utf8', { fatal: true })
				text = decoder.decode(bytes)
			}
			catch {
				return undefined
			}

			try {
				return JSON.parse(text) as T
			}
			catch {
				return undefined
			}
		})
	}

	async listIdentities(): Promise<readonly string[]> {
		return this.persistence.withReadLock(async () => {
			const artifactsRelative = `${this.persistence.layout.artifactsDir}/sha256`
			const artifactsAbsolute = resolveWorkspacePath(this.persistence.root, artifactsRelative)
			let shards: import('node:fs').Dirent[]
			try {
				await assertSafePath(this.persistence.root, `${artifactsRelative}/.placeholder`, true)
				shards = await fs.readdir(artifactsAbsolute, { withFileTypes: true })
			}
			catch (error) {
				if (isNotFound(error)) return []
				throw error
			}
			const identities: string[] = []
			for (const shard of shards) {
				if (!shard.isDirectory() || shard.isSymbolicLink() || shard.name.length !== 2) continue
				const shardRelative = `${artifactsRelative}/${shard.name}`
				const shardAbsolute = resolveWorkspacePath(this.persistence.root, shardRelative)
				let entries: import('node:fs').Dirent[]
				try {
					entries = await fs.readdir(shardAbsolute, { withFileTypes: true })
				}
				catch (error) {
					if (isNotFound(error)) continue
					throw error
				}
				for (const entry of entries) {
					if (!entry.isFile() || entry.isSymbolicLink() || entry.name.length !== 64) continue
					identities.push(`sha256:${entry.name}`)
				}
			}
			return identities.sort()
		})
	}
}

type ObserverState = { observer?: CanonicalWriteObserver; recordingGap: boolean; readonly timeoutMilliseconds: number }

/** Per-instance observer state, private to this module so only `commitCanonicalWrite` calls the hooks. */
const observerStates = new WeakMap<FileNativePersistence, ObserverState>()
/**
 * Marks the asynchronous call chain of a running observer hook, which must not re-enter the lock.
 * The mark is cleared when the hook settles, so work the hook schedules for later (a timer that
 * closes an idle autosave) inherits a cleared mark and may take the lock then.
 */
const observerScope = new AsyncLocalStorage<{ running: boolean; persistence: FileNativePersistence }>()

function observerState(persistence: FileNativePersistence): ObserverState {
	const state = observerStates.get(persistence)
	if (!state) throw new TypeError('FileNativePersistence observer state is missing.')
	return state
}

/** Refuses only re-entry into the instance whose hook is running; other instances lock as usual. */
function assertOutsideObserver(persistence: FileNativePersistence): void {
	const mark = observerScope.getStore()
	if (mark?.running && mark.persistence === persistence)
		throw new PersistenceError('persistence.lock_busy', 'A history observer hook runs under the exclusive persistence lock and cannot take it again; use the *Unlocked helpers.')
}

type ResourceFilesBefore = Readonly<{ resource: VersionedResourceIdentity; files: Map<string, Uint8Array>; changes: FileChange[] }>

/**
 * The one funnel every canonical design write commits through (Clause and Rule references in
 * `CanonicalWriteObserver`). `changes` are the files `write` changes; `write` resolves `false`
 * when it decided not to write after all (a lost create race). Only versioned files count: with
 * no design-write context, no observer, or no versioned file among `changes`, this is exactly
 * `write()`. Otherwise the resources' files are read first, `beforeCanonicalWrite` runs, then the
 * write, then (when the `before` hook succeeded) `afterCanonicalCommit` with the committed bytes.
 * Observer failures never fail the write; they set `recordingGap`. Called with the exclusive
 * persistence lock held.
 *
 * When the resources cannot be read first, neither hook runs and the gap is flagged only once the
 * write is done: a `before` hook that closed an autosave at that point would consume the flag
 * before the change it stands for exists, attributing the missed write to the previous boundary
 * instead of the next one (Rule 01a11a5e-03c9-745e-b23a-bb06b600377d).
 */
async function commitCanonicalWrite<Written extends boolean | void>(
	persistence: FileNativePersistence,
	changes: readonly FileChange[],
	write: () => Promise<Written>,
): Promise<Written> {
	const state = observerState(persistence)
	const observer = state.observer
	const context = observer ? currentDesignWriteContext() : undefined
	const versioned = observer && context ? changes.filter(change => persistence.layout.classifyVersionedPath(change.path)) : []
	if (!observer || !context || versioned.length === 0) return write()
	let before: readonly ResourceFilesBefore[]
	try {
		before = await readResourceFilesBeforeWrite(persistence, versioned)
	}
	catch (error) {
		try {
			return await write()
		}
		finally {
			reportObserverFailure(state, 'could not read the resources before a design write', error)
		}
	}
	const ready = await invokeObserver(persistence, state, 'beforeCanonicalWrite', async signal => observer.beforeCanonicalWrite?.(context, before.map(resourceBeforeWrite), signal))
	const written = await write()
	if (written === false || !ready) return written
	await invokeObserver(persistence, state, 'afterCanonicalCommit', async signal => observer.afterCanonicalCommit?.(context, before.map(resourceChangeAfterCommit), signal))
	return written
}

function resourceBeforeWrite(entry: ResourceFilesBefore): CanonicalResourceBefore {
	return { resource: entry.resource, revision: revisionForResourceFiles(entry.resource.kind, entry.files) ?? null }
}

async function readResourceFilesBeforeWrite(persistence: FileNativePersistence, changes: readonly FileChange[]): Promise<readonly ResourceFilesBefore[]> {
	const byResource = new Map<string, ResourceFilesBefore>()
	for (const change of changes) {
		const resource = persistence.layout.classifyVersionedPath(change.path)!
		const identity = `${resource.kind}\0${resource.key}`
		let entry = byResource.get(identity)
		if (!entry) {
			entry = { resource, files: await readVersionedResourceFilesUnlocked(persistence, resource, change.path), changes: [] }
			byResource.set(identity, entry)
		}
		entry.changes.push(change)
	}
	return [...byResource.values()].sort((left, right) => compareCodeUnits(left.resource.kind, right.resource.kind) || compareCodeUnits(left.resource.key, right.resource.key))
}

/** Every current file of one versioned resource: an Asset's whole directory, otherwise its one file. */
async function readVersionedResourceFilesUnlocked(persistence: FileNativePersistence, resource: VersionedResourceIdentity, path: string): Promise<Map<string, Uint8Array>> {
	const files = new Map<string, Uint8Array>()
	if (resource.kind !== 'asset') {
		const bytes = await persistence.readOptionalBytesUnlocked(path)
		if (bytes) files.set(path, Uint8Array.from(bytes))
		return files
	}
	const directory = assetDirectoryRelativePath(resource.key)
	await assertSafePath(persistence.root, `${directory}/.placeholder`, true)
	let entries: import('node:fs').Dirent[]
	try { entries = await fs.readdir(resolveWorkspacePath(persistence.root, directory), { withFileTypes: true }) }
	catch (error) {
		if (isNotFound(error)) return files
		throw error
	}
	for (const entry of entries) {
		const relativePath = `${directory}/${entry.name}`
		if (entry.isFile() && persistence.layout.classifyVersionedPath(relativePath))
			files.set(relativePath, Uint8Array.from(await persistence.readBytesUnlocked(relativePath)))
	}
	return files
}

function resourceChangeAfterCommit(entry: ResourceFilesBefore): CanonicalResourceChange {
	const after = new Map(entry.files)
	const files: CanonicalFileChange[] = []
	for (const change of [...entry.changes].sort((left, right) => compareCodeUnits(left.path, right.path))) {
		if (change.bytes === undefined) after.delete(change.path)
		else after.set(change.path, change.bytes)
		files.push({ path: change.path, bytes: change.bytes === undefined ? null : Uint8Array.from(change.bytes) })
	}
	return {
		resource: entry.resource,
		beforeRevision: revisionForResourceFiles(entry.resource.kind, entry.files) ?? null,
		afterRevision: revisionForResourceFiles(entry.resource.kind, after) ?? null,
		files,
	}
}

/**
 * Runs one hook under the observer mark and the observer timeout; true when it settled in time
 * without throwing. A hook still running at the timeout is abandoned: its signal is aborted (it no
 * longer holds the lock, so it must not read the Workspace or consume the gap), the write goes on,
 * the gap is flagged, and a later rejection of the abandoned hook is only logged.
 */
async function invokeObserver(persistence: FileNativePersistence, state: ObserverState, hook: keyof CanonicalWriteObserver, call: (signal: AbortSignal) => Promise<unknown>): Promise<boolean> {
	const mark = { running: true, persistence }
	const abandon = new AbortController()
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		const pending = observerScope.run(mark, () => call(abandon.signal))
		const timedOut = new Promise<'timeout'>((resolve) => {
			timer = setTimeout(resolve, state.timeoutMilliseconds, 'timeout')
			timer.unref?.()
		})
		if (await Promise.race([pending.then(() => 'settled' as const), timedOut]) === 'timeout') {
			abandon.abort()
			pending.catch((error: unknown) => console.error(`uiux: abandoned history ${hook} failed later: ${error instanceof Error ? error.message : String(error)}`))
			reportObserverFailure(state, `${hook} did not finish within ${state.timeoutMilliseconds} ms and was abandoned`, undefined)
			return false
		}
		return true
	}
	catch (error) {
		reportObserverFailure(state, `${hook} failed`, error)
		return false
	}
	finally {
		clearTimeout(timer)
		mark.running = false
	}
}

/** Rule 01a11a5e-036d-7955-aa27-4ec036b55938: the write stands, the failure is logged and flagged. */
function reportObserverFailure(state: ObserverState, what: string, error: unknown): void {
	state.recordingGap = true
	const detail = error === undefined ? '' : `: ${error instanceof Error ? error.message : String(error)}`
	console.error(`uiux: history ${what}; the write was kept and the gap is recorded at the next history boundary${detail}`)
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

function assertEmbeddedIdentity(key: string, resource: unknown, identityField: string, filename: string): void {
	if (!isRecord(resource) || resource[identityField] !== key) {
		throw new PersistenceError('persistence.identity_mismatch', `Resource ${filename} must retain ${identityField} exactly equal to its canonical filename identity.`, {
			diagnostics: [{ code: 'identity.filename_id_mismatch', path: `/${identityField}`, message: `Resource identity must exactly match canonical filename ${filename}.` }],
		})
	}
}

/**
 * The revision persistence reports for one versioned resource, computed from that resource's files
 * alone (`files` maps each Workspace-relative path of the resource to its bytes). It is the value
 * `readRevision` returns for the same bytes: the manifest, a View, a Flow and a Locale hash their
 * single file; an Asset hashes its metadata and every content file, and falls back to the metadata
 * bytes alone when `asset.json` is not UTF-8 JSON. Returns `undefined` when the files hold no
 * resource (no file, or an Asset without `asset.json`) or when this build has no revision rule for
 * `kind` (seam 3: the resource-kind set is open).
 */
export function revisionForResourceFiles(kind: string, files: ReadonlyMap<string, Uint8Array>): ResourceRevision | undefined {
	if (kind === 'asset') {
		let metadataBytes: Uint8Array | undefined
		const contentFiles: { filename: string; bytes: Uint8Array }[] = []
		for (const [path, bytes] of files) {
			const filename = path.slice(path.lastIndexOf('/') + 1)
			if (filename === 'asset.json') metadataBytes = bytes
			else if (isSafeAssetContentFilename(filename)) contentFiles.push({ filename, bytes })
		}
		if (!metadataBytes) return undefined
		try { parseJsonBytes(metadataBytes, 'asset.json') }
		catch { return revisionForBytes(metadataBytes) }
		return assetRevision(metadataBytes, contentFiles)
	}
	if (kind !== 'workspace' && kind !== PRODUCT_KIT_RESOURCE_KIND && kind !== 'view' && kind !== 'flow' && kind !== 'locale') return undefined
	if (files.size === 0) return undefined
	if (files.size > 1)
		throw new TypeError(`A ${kind} resource is exactly one file; received ${files.size}.`)
	return revisionForBytes([...files.values()][0]!)
}

/**
 * Upgrades a recorded snapshot of the versioned files from `fromVersion` to the policy's current
 * schema entirely in memory, with the same policy steps and checks `uiux migrate` uses; nothing is
 * read or written. A version not recognized by the policy, or without a migration plan, is refused
 * with `workspace.schema_unsupported` (Clause 01a11a5e-2434-7342-a3c1-6d63aa74334c).
 */
export async function upgradeSnapshotInMemory(snapshot: WorkspaceSnapshot, fromVersion: number, policy: WorkspaceSchemaPolicy): Promise<Readonly<{ snapshot: WorkspaceSnapshot; steps: readonly string[] }>> {
	if (!policy.recognizedVersions.includes(fromVersion))
		throw new PersistenceError('workspace.schema_unsupported', `Workspace schemaVersion ${fromVersion} is not recognized by the injected policy.`)
	const plan = findMigrationPlan(policy, fromVersion)
	if (!plan)
		throw new PersistenceError('workspace.schema_unsupported', `Workspace schemaVersion ${fromVersion} has no migration plan to the current version.`)
	if (plan.length === 0) return { snapshot: cloneSnapshot(snapshot), steps: [] }
	return applyMigrationPlan(snapshot, plan, policy)
}

async function applyMigrationPlan(initialSnapshot: WorkspaceSnapshot, plan: readonly WorkspaceMigrationStep[], policy: WorkspaceSchemaPolicy): Promise<Readonly<{ snapshot: Map<string, Uint8Array>; steps: readonly string[] }>> {
	let snapshot = cloneSnapshot(initialSnapshot)
	const steps: string[] = []
	try {
		for (const step of plan) {
			const inputSnapshot = cloneSnapshot(snapshot)
			const next = await step.apply(inputSnapshot)
			if (!(next instanceof Map))
				throw new TypeError(`Migration step ${step.id} did not return a WorkspaceSnapshot Map.`)
			snapshot = cloneSnapshot(next)
			validateCanonicalSnapshot(snapshot, step.toVersion, policy)
			steps.push(step.id)
		}
		validateCanonicalSnapshot(snapshot, policy.currentVersion, policy)
	}
	catch (cause) {
		if (cause instanceof PersistenceError)
			throw cause
		throw new PersistenceError('workspace.migration_failed', 'Workspace migration planning failed before canonical files were changed.', { cause })
	}
	return { snapshot, steps }
}

function revisionForBytes(bytes: Uint8Array): ResourceRevision {
	return `r_${createHash('sha256').update('uiux-resource-revision\0').update(bytes).digest('base64url')}` as ResourceRevision
}

function assetRevision(metadataBytes: Uint8Array, contentFiles: readonly Readonly<{ filename: string; bytes: Uint8Array }>[]): ResourceRevision {
	const hash = createHash('sha256').update('uiux-authored-asset-revision\0')
	updateLengthFramed(hash, metadataBytes)
	for (const file of [...contentFiles].sort((left, right) => left.filename.localeCompare(right.filename))) {
		updateLengthFramed(hash, Buffer.from(file.filename, 'utf8'))
		updateLengthFramed(hash, file.bytes)
	}
	return `r_${hash.digest('base64url')}` as ResourceRevision
}

function updateLengthFramed(hash: ReturnType<typeof createHash>, bytes: Uint8Array): void {
	const length = Buffer.alloc(8)
	length.writeBigUInt64BE(BigInt(bytes.byteLength))
	hash.update(length).update(bytes)
}

function digestBytes(bytes: Uint8Array): `sha256:${string}` {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** The canonical JSON bytes persistence writes: object members sorted by key, no whitespace, one trailing newline. */
export function canonicalJsonBytes(value: unknown, label = 'value'): Buffer {
	if (!isJsonValue(value))
		throw new PersistenceError('persistence.invalid_resource', `The ${label} is not a JSON-compatible value.`)
	return Buffer.from(`${stableStringify(value)}\n`, 'utf8')
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value))
		return `[${value.map(item => stableStringify(item)).join(',')}]`
	if (isRecord(value)) {
		const members = Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
		return `{${members.join(',')}}`
	}
	return JSON.stringify(value)
}

function parseJsonBytes(bytes: Uint8Array, relativePath: string): unknown {
	let text: string
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
	}
	catch (cause) {
		throw new PersistenceError('persistence.invalid_json', `Canonical JSON file ${relativePath} is not valid UTF-8.`, {
			diagnostics: [{ code: 'persistence.invalid_utf8', path: `/${relativePath}`, message: 'Canonical JSON must be encoded as valid UTF-8.' }],
			cause,
		})
	}
	try {
		return JSON.parse(text) as unknown
	}
	catch (cause) {
		throw new PersistenceError('persistence.invalid_json', `Canonical file ${relativePath} contains syntactically invalid JSON.`, {
			diagnostics: [{ code: 'persistence.invalid_json', path: `/${relativePath}`, message: 'JSON syntax is invalid; persistence did not guess or repair the authored value.' }],
			cause,
		})
	}
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): Map<string, Uint8Array> {
	return new Map([...snapshot].map(([path, bytes]) => [path, Uint8Array.from(bytes)]))
}

function snapshotsEqual(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
	if (left.size !== right.size) return false
	for (const [path, bytes] of left) {
		const other = right.get(path)
		if (!other || !bytesEqual(bytes, other)) return false
	}
	return true
}

function diffSnapshots(previous: WorkspaceSnapshot, next: WorkspaceSnapshot): FileChange[] {
	const paths = new Set([...previous.keys(), ...next.keys()])
	const changes: FileChange[] = []
	for (const path of paths) {
		const before = previous.get(path)
		const after = next.get(path)
		if (before && after && bytesEqual(before, after)) continue
		changes.push(after ? { path, bytes: Uint8Array.from(after) } : { path })
	}
	return changes
}

function validateCanonicalSnapshot(snapshot: WorkspaceSnapshot, expectedVersion: number, policy: WorkspaceSchemaPolicy): void {
	const layout = layoutForSchemaVersion(expectedVersion)
	const manifestPath = layout.manifestPath
	const manifestBytes = snapshot.get(manifestPath)
	if (!manifestBytes)
		throw new PersistenceError('workspace.migration_failed', `Migration result must contain ${manifestPath}.`)
	const manifest = parseJsonBytes(manifestBytes, manifestPath)
	if (!isRecord(manifest) || manifest.schemaVersion !== expectedVersion)
		throw new PersistenceError('workspace.migration_failed', `Migration result manifest schemaVersion must equal its policy step target ${expectedVersion}.`)
	if (!policy.recognizedVersions.includes(expectedVersion) && expectedVersion !== policy.currentVersion)
		throw new PersistenceError('workspace.migration_failed', `Migration step target ${expectedVersion} is not recognized by the injected policy.`)
	// Clause 01a11bb1-8e31-7b25-b6b8-da667b201670: from schemaVersion 5 the Product Kit file is required.
	if (layout.productKitPath && !snapshot.has(layout.productKitPath))
		throw new PersistenceError('workspace.migration_failed', `Migration result must contain ${layout.productKitPath}.`)
	const assetFiles = new Map<string, string[]>()
	for (const [relativePath, bytes] of snapshot) {
		assertTransactionalPath(layout, relativePath)
		if (!(bytes instanceof Uint8Array))
			throw new PersistenceError('workspace.migration_failed', `Migration result ${relativePath} must contain bytes.`)
		if (relativePath === manifestPath) continue
		if (relativePath === layout.productKitPath) {
			parseJsonBytes(bytes, relativePath)
			continue
		}
		const segments = relativePath.split('/')
		const [directory, filename] = segments
		if (directory === 'assets') {
			if (segments.length !== 3 || !isFullUuid(segments[1]!))
				throw new PersistenceError('workspace.migration_failed', `Migration result contains non-canonical Asset path ${relativePath}.`)
			const assetFilename = segments[2]!
			const files = assetFiles.get(segments[1]!) ?? []
			files.push(assetFilename)
			assetFiles.set(segments[1]!, files)
			if (assetFilename === 'asset.json') {
				const metadata = parseJsonBytes(bytes, relativePath)
				if (!isRecord(metadata) || metadata.id !== segments[1] || !isSafeAssetContentFilename(metadata.contentFilename))
					throw new PersistenceError('workspace.migration_failed', `Migrated Asset metadata at ${relativePath} must retain its directory UUID and safe contentFilename.`)
			}
			continue
		}
		if (directory === 'i18n') {
			if (segments.length !== 2 || !isCanonicalLocaleFilename(filename))
				throw new PersistenceError('workspace.migration_failed', `Migration result contains non-canonical locale path ${relativePath}.`)
			parseJsonBytes(bytes, relativePath)
			continue
		}
		if (directory === 'views' || directory === 'flows' || directory === 'reviews') {
			const suffix = directory === 'views' ? '.view.json' : directory === 'flows' ? '.flow.json' : '.review.json'
			const id = filename!.endsWith(suffix) ? filename!.slice(0, -suffix.length) : ''
			if (segments.length !== 2 || !isFullUuid(id))
				throw new PersistenceError('workspace.migration_failed', `Migration result contains non-canonical resource path ${relativePath}.`)
			const resource = parseJsonBytes(bytes, relativePath)
			if (!isRecord(resource) || resource.id !== id)
				throw new PersistenceError('workspace.migration_failed', `Migrated resource identity must match canonical filename ${filename}.`)
			continue
		}
		throw new PersistenceError('workspace.migration_failed', `Migration result contains a path outside the canonical authored layout: ${relativePath}.`)
	}
	for (const [id, filenames] of assetFiles) {
		const metadataNames = filenames.filter(filename => filename === 'asset.json')
		const sourceNames = filenames.filter(filename => filename !== 'asset.json')
		if (metadataNames.length !== 1 || sourceNames.length !== 1)
			throw new PersistenceError('workspace.migration_failed', `Migrated Asset ${id} must contain asset.json and exactly one source-content file.`)
		const metadata = parseJsonBytes(snapshot.get(`assets/${id}/asset.json`)!, `assets/${id}/asset.json`)
		if (!isRecord(metadata) || metadata.contentFilename !== sourceNames[0])
			throw new PersistenceError('workspace.migration_failed', `Migrated Asset ${id} source filename must exactly match asset.json.`)
	}
}

/**
 * The layout a journal was written for: `legacy` when it names none, `undefined` when the journal
 * cannot be read as a JSON object (recovery then handles it as before).
 */
async function readJournalLayout(journalPath: string): Promise<string | undefined> {
	let value: unknown
	try { value = JSON.parse(await fs.readFile(journalPath, 'utf8')) as unknown }
	catch { return undefined }
	if (!isRecord(value)) return undefined
	return value.layout === undefined ? 'legacy' : String(value.layout)
}

function validateTransactionJournal(value: unknown, layout: WorkspaceLayout): TransactionJournal {
	if (!isRecord(value) || !Array.isArray(value.changes))
		throw new TypeError('Persistence transaction journal has an invalid shape.')
	if ((value.layout ?? 'legacy') !== layout.id)
		throw new TypeError(`Persistence transaction journal was written for the ${String(value.layout ?? 'legacy')} layout, not ${layout.id}.`)
	const changes: { path: string; existed: boolean }[] = []
	for (const change of value.changes) {
		if (!isRecord(change) || typeof change.path !== 'string' || typeof change.existed !== 'boolean')
			throw new TypeError('Persistence transaction journal contains an invalid entry.')
		assertTransactionalPath(layout, change.path)
		changes.push({ path: change.path, existed: change.existed })
	}
	if (new Set(changes.map(change => change.path)).size !== changes.length)
		throw new TypeError('Persistence transaction journal repeats a path.')
	return { changes }
}

function assertTransactionalPath(layout: WorkspaceLayout, relativePath: string): void {
	resolveWorkspacePath('/', relativePath)
	if (!isInCodeDirectory(layout, relativePath) && layout.isCanonicalPath(relativePath)) return
	throw new PersistenceError('persistence.path_rejected', `Path ${relativePath} is outside the allowed canonical Workspace layout.`)
}

async function ensureSafeDirectory(root: string, relativeDirectory: string): Promise<void> {
	if (relativeDirectory === '.' || relativeDirectory.length === 0) return
	const absolute = resolveWorkspacePath(root, relativeDirectory)
	await assertSafePath(root, `${relativeDirectory}/.placeholder`, true)
	await fs.mkdir(absolute, { recursive: true })
	await assertSafePath(root, `${relativeDirectory}/.placeholder`, true)
}

async function assertSafePath(root: string, relativePath: string, allowMissingFinal: boolean): Promise<void> {
	const segments = relativePath.split('/')
	for (let index = 0; index < segments.length; index++) {
		const partial = segments.slice(0, index + 1).join('/')
		const absolute = resolveWorkspacePath(root, partial)
		let stat: import('node:fs').Stats
		try { stat = await fs.lstat(absolute) }
		catch (error) {
			if (isNotFound(error)) return
			throw error
		}
		if (stat.isSymbolicLink())
			throw pathRejected(`Workspace path ${partial} crosses a symbolic link.`)
		if (index < segments.length - 1 && !stat.isDirectory())
			throw pathRejected(`Workspace path ancestor ${partial} is not a directory.`)
		if (index === segments.length - 1 && !allowMissingFinal && !stat.isFile())
			throw pathRejected(`Canonical resource path ${partial} is not a regular file.`)
	}
}

async function writeSyncedFile(absolutePath: string, bytes: Uint8Array, createParents: boolean): Promise<void> {
	if (createParents) await fs.mkdir(dirname(absolutePath), { recursive: true })
	const handle = await fs.open(absolutePath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
	try {
		await handle.writeFile(bytes)
		await handle.sync()
	}
	finally {
		await handle.close()
	}
	await syncDirectory(dirname(absolutePath))
}

async function atomicWriteWithoutFault(root: string, relativePath: string, bytes: Uint8Array): Promise<void> {
	const target = resolveWorkspacePath(root, relativePath)
	const parentRelative = dirname(relativePath).split('\\').join('/')
	await ensureSafeDirectory(root, parentRelative)
	const temp = resolveWorkspacePath(root, `${parentRelative === '.' ? '' : `${parentRelative}/`}.${basename(relativePath)}.rollback-${randomUUID()}.tmp`)
	try {
		await writeSyncedFile(temp, bytes, true)
		await fs.rename(temp, target)
		await syncDirectory(dirname(target))
	}
	finally {
		await fs.rm(temp, { force: true }).catch(() => undefined)
	}
}

async function syncDirectory(absoluteDirectory: string): Promise<void> {
	const handle = await fs.open(absoluteDirectory, 'r')
	try { await handle.sync() }
	finally { await handle.close() }
}

async function fileExists(absolutePath: string): Promise<boolean> {
	try {
		const stat = await fs.lstat(absolutePath)
		if (stat.isSymbolicLink() || !stat.isFile())
			throw pathRejected(`Expected regular file at ${absolutePath}.`)
		return true
	}
	catch (error) {
		if (isNotFound(error)) return false
		throw error
	}
}

async function isSymlink(absolutePath: string): Promise<boolean> {
	try { return (await fs.lstat(absolutePath)).isSymbolicLink() }
	catch (error) { if (isNotFound(error)) return false; throw error }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
	return left.byteLength === right.byteLength && Buffer.from(left).equals(Buffer.from(right))
}

function isNotFound(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function isAlreadyExists(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === 'EEXIST'
}

function delay(milliseconds: number): Promise<void> {
	return new Promise(resolveDelay => setTimeout(resolveDelay, milliseconds))
}

function pathRejected(message: string): PersistenceError {
	return new PersistenceError('persistence.path_rejected', message)
}
