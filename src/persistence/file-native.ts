import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'

import type { ResourceRevision, RevisionedResourceRead, RevisionConflict } from '../application/dto/revisions'
import type { MutableResourceRepository } from '../application/ports/resources'
import { sha256Identity } from '../domain/artifacts/schema'
import { validateAssetContentFiles, validateAssetContentMetadata, validateAssetMetadata, type AuthoredAsset, type AuthoredAssetResource } from '../domain/assets/schema'
import { validateFlowResource, type FlowResource } from '../domain/flows/schema'
import { validateI18nResource, type I18nResource } from '../domain/i18n/schema'
import { isCanonicalLocaleFilename, isFullUuid, isJsonValue, isRecord, type Diagnostic } from '../domain/validation'
import { validateReviewThread, type ReviewThread } from '../domain/reviews/schema'
import { validateViewResource, type ViewResource } from '../domain/views/schema'
import { validateWorkspaceManifest, type WorkspaceManifest } from '../domain/workspace/schema'
import { PersistenceError } from './errors'
import {
	artifactRelativePath,
	assetMetadataRelativePath,
	assetDirectoryRelativePath,
	flowRelativePath,
	localeRelativePath,
	reviewRelativePath,
	resolveWorkspacePath,
	viewRelativePath,
	workspaceRelativePath,
	isSafeAssetContentFilename,
} from './paths'
import {
	defineWorkspaceSchemaPolicy,
	inspectWorkspaceManifest,
	type WorkspaceInspection,
	type WorkspaceSchemaPolicy,
	type WorkspaceSnapshot,
} from './schema-policy'

export type PersistenceFaultPoint =
	| 'file.before_rename'
	| 'file.after_rename'
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
}>

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
type TransactionJournal = Readonly<{ changes: readonly Readonly<{ path: string; existed: boolean }>[] }>
type JsonValidator = (resource: unknown, filename: string) => readonly Diagnostic[]

const TRANSACTION_ROOT = '.uiux/.transactions'
const PERSISTENCE_LOCK = '.uiux/.persistence.lock'
const MAX_LOCK_WAIT_MS = 15_000

/** File-native persistence implementation. The schema policy is deliberately injected. */
export class FileNativePersistence {
	readonly root: string
	readonly schemaPolicy: WorkspaceSchemaPolicy
	readonly workspace: WorkspaceFileRepository
	readonly views: JsonResourceRepository<string, ViewResource>
	readonly flows: JsonResourceRepository<string, FlowResource>
	readonly reviews: JsonResourceRepository<string, ReviewThread>
	readonly locales: LocaleFileRepository
	readonly assets: AuthoredAssetFileRepository
	readonly artifacts: ImmutableArtifactStore
	private readonly fault?: PersistenceFaultHook
	private readonly lockWaitMilliseconds: number

	constructor(options: FileNativePersistenceOptions) {
		this.root = resolve(options.root)
		this.schemaPolicy = defineWorkspaceSchemaPolicy(options.schemaPolicy)
		this.fault = options.fault
		this.lockWaitMilliseconds = options.lockWaitMilliseconds ?? MAX_LOCK_WAIT_MS
		this.workspace = new WorkspaceFileRepository(this)
		this.views = new JsonResourceRepository(this, viewRelativePath, 'id', (resource, filename) => validateViewResource(resource, filename).diagnostics, { directory: 'views', suffix: '.view.json' })
		this.flows = new JsonResourceRepository(this, flowRelativePath, 'id', (resource, filename) => validateFlowResource(resource, filename).diagnostics, { directory: 'flows', suffix: '.flow.json' })
		this.reviews = new JsonResourceRepository(this, reviewRelativePath, 'id', (resource, filename) => validateReviewThread(resource, filename).diagnostics, { directory: 'reviews', suffix: '.review.json' })
		this.locales = new LocaleFileRepository(this)
		this.assets = new AuthoredAssetFileRepository(this)
		this.artifacts = new ImmutableArtifactStore(this)
	}

	/** Reports policy state without changing the Workspace or its authored files. */
	async inspectWorkspace(): Promise<WorkspaceReadInspection> {
		return this.withLock(async () => this.inspectWorkspaceUnlocked())
	}

	/** The only operation that applies injected Workspace schema migrations. */
	async migrateWorkspace(): Promise<Readonly<{ version: number; revision: ResourceRevision; changedFiles: readonly string[]; steps: readonly string[] }>> {
		return this.withLock(async () => {
			const read = await this.inspectWorkspaceUnlocked()
			if (!read.resource || !read.revision)
				throw new PersistenceError('workspace.manifest_missing', 'Cannot migrate a Workspace without .uiux/workspace.json.', { diagnostics: read.diagnostics })
			if (read.inspection.state === 'unsupported')
				throw new PersistenceError('workspace.schema_unsupported', 'Workspace schema is not supported by the injected policy.', { diagnostics: read.inspection.diagnostics })
			if (read.inspection.state === 'missing_manifest')
				throw new PersistenceError('workspace.manifest_missing', 'Cannot migrate a Workspace without .uiux/workspace.json.', { diagnostics: read.diagnostics })
			if (read.inspection.state === 'current')
				return { version: read.inspection.version, revision: read.revision, changedFiles: [], steps: [] }

			const initialSnapshot = await this.scanCanonicalSnapshotUnlocked()
			let snapshot = cloneSnapshot(initialSnapshot)
			const stepIds: string[] = []
			try {
				for (const step of read.inspection.migrationPlan) {
					const inputSnapshot = cloneSnapshot(snapshot)
					const next = await step.apply(inputSnapshot)
					if (!(next instanceof Map))
						throw new TypeError(`Migration step ${step.id} did not return a WorkspaceSnapshot Map.`)
					snapshot = cloneSnapshot(next)
					validateCanonicalSnapshot(snapshot, step.toVersion, this.schemaPolicy)
					stepIds.push(step.id)
				}
				validateCanonicalSnapshot(snapshot, this.schemaPolicy.currentVersion, this.schemaPolicy)
			}
			catch (cause) {
				if (cause instanceof PersistenceError)
					throw cause
				throw new PersistenceError('workspace.migration_failed', 'Workspace migration planning failed before canonical files were changed.', { cause })
			}

			const beforeApplySnapshot = await this.scanCanonicalSnapshotUnlocked()
			if (!snapshotsEqual(initialSnapshot, beforeApplySnapshot))
				throw new PersistenceError('workspace.migration_failed', 'Canonical Workspace files changed while migration was being planned; no migration writes were applied.')
			const changes = diffSnapshots(initialSnapshot, snapshot)
			const changedFiles = changes.map(change => change.path)
			await this.applyFileTransaction(changes, 'migration')
			const manifestBytes = await this.readBytesUnlocked(workspaceRelativePath())
			const finalManifest = parseJsonBytes(manifestBytes, workspaceRelativePath())
			const finalInspection = inspectWorkspaceManifest(finalManifest, this.schemaPolicy)
			if (finalInspection.state !== 'current')
				throw new PersistenceError('workspace.migration_failed', 'Workspace migration transaction completed without reaching the current policy version.', { diagnostics: finalInspection.diagnostics })
			return {
				version: finalInspection.version,
				revision: revisionForBytes(manifestBytes),
				changedFiles,
				steps: stepIds,
			}
		})
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

			const reviewValidation = validateReviewThread(input.reviewResource, `${input.reviewId}.review.json`)
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

			await this.applyFileTransaction([
				{ path: reviewPath, bytes: serializedReview },
				{ path: viewPath, bytes: serializedView },
			], 'decision-promotion')

			return {
				ok: true,
				reviewRevision: revisionForBytes(serializedReview),
				viewRevision: revisionForBytes(serializedView),
			}
		})
	}

	/** Used by repositories; locking also serializes CAS across repository instances. */
	async withLock<Result>(operation: () => Promise<Result>): Promise<Result> {
		const release = await this.acquireLock()
		try {
			await this.recoverPendingTransactionsUnlocked()
			return await operation()
		}
		finally {
			await release()
		}
	}

	async assertWritableUnlocked(): Promise<void> {
		const inspection = (await this.inspectWorkspaceUnlocked()).inspection
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

	async inspectWorkspaceUnlocked(): Promise<WorkspaceReadInspection> {
		const relativePath = workspaceRelativePath()
		let bytes: Buffer
		try {
			bytes = await this.readBytesUnlocked(relativePath)
		}
		catch (error) {
			if (isNotFound(error)) {
				const inspection: WorkspaceInspection = {
					state: 'missing_manifest',
					targetVersion: this.schemaPolicy.currentVersion,
					diagnostics: [{ code: 'workspace.manifest_missing', path: `/${relativePath}`, message: 'Workspace manifest .uiux/workspace.json does not exist.' }],
				}
				return { inspection, diagnostics: inspection.diagnostics }
			}
			throw error
		}
		const resource = parseJsonBytes(bytes, relativePath)
		const inspection = inspectWorkspaceManifest(resource, this.schemaPolicy)
		const validationDiagnostics = validateWorkspaceManifest(resource).diagnostics
		const extraDiagnostics = inspection.state === 'unsupported'
			? inspection.diagnostics.filter(item => !validationDiagnostics.some(existing => existing.code === item.code && existing.path === item.path))
			: []
		const diagnostics = [...validationDiagnostics, ...extraDiagnostics]
		return { resource: resource as WorkspaceManifest, revision: revisionForBytes(bytes), inspection, diagnostics }
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

	serializeJson(resource: unknown, relativePath: string): Buffer {
		if (!isJsonValue(resource))
			throw new PersistenceError('persistence.invalid_resource', `Resource for ${relativePath} is not a JSON-compatible value.`)
		return Buffer.from(`${stableStringify(resource)}\n`, 'utf8')
	}

	async atomicWriteUnlocked(relativePath: string, bytes: Uint8Array, oldBytes?: Uint8Array): Promise<void> {
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

	/** Content-addressed blobs use an atomic no-replace link so identities stay immutable. */
	async atomicCreateImmutableUnlocked(relativePath: string, bytes: Uint8Array): Promise<boolean> {
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
		for (const change of ordered)
			assertTransactionalPath(change.path)
		const transactionId = randomUUID()
		const transactionRelative = `${TRANSACTION_ROOT}/${transactionId}`
		const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
		await ensureSafeDirectory(this.root, TRANSACTION_ROOT)
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
			const journal: TransactionJournal = { changes: records }
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
		const manifestPath = workspaceRelativePath()
		const manifest = await this.readOptionalBytesUnlocked(manifestPath)
		if (manifest)
			snapshot.set(manifestPath, Uint8Array.from(manifest))
		for (const directory of ['views', 'flows', 'reviews', 'i18n'] as const)
			await this.scanFlatDirectoryUnlocked(directory, snapshot)
		await this.scanAssetsUnlocked(snapshot)
		return snapshot
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
			assertTransactionalPath(relativePath)
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
				assertTransactionalPath(relativePath)
				snapshot.set(relativePath, Uint8Array.from(await this.readBytesUnlocked(relativePath)))
			}
		}
	}

	private async recoverPendingTransactionsUnlocked(): Promise<void> {
		const transactionsPath = resolveWorkspacePath(this.root, TRANSACTION_ROOT)
		let entries: import('node:fs').Dirent[]
		await assertSafePath(this.root, `${TRANSACTION_ROOT}/.placeholder`, true)
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
				await fs.rm(resolveWorkspacePath(this.root, `${TRANSACTION_ROOT}/${entry.name}`), { recursive: true, force: true })
				continue
			}
			if (!entry.isDirectory() || !isFullUuid(entry.name))
				throw new PersistenceError('persistence.recovery_failed', `Unrecognized persistence transaction entry ${entry.name}.`)
			const transactionRelative = `${TRANSACTION_ROOT}/${entry.name}`
			const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
			const journalPath = resolveWorkspacePath(this.root, `${transactionRelative}/journal.json`)
			await assertSafePath(this.root, `${transactionRelative}/journal.json`, false).catch(error => {
				if (!isNotFound(error)) throw error
			})
			if (!await fileExists(journalPath)) {
				await fs.rm(transactionAbsolute, { recursive: true, force: true })
				continue
			}
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
				const journal = validateTransactionJournal(journalValue)
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
		const tombstoneRelative = `${TRANSACTION_ROOT}/.cleanup-${transactionId}`
		const transactionAbsolute = resolveWorkspacePath(this.root, transactionRelative)
		const tombstoneAbsolute = resolveWorkspacePath(this.root, tombstoneRelative)
		try { await fs.rename(transactionAbsolute, tombstoneAbsolute) }
		catch (error) {
			if (!isNotFound(error)) throw error
			return
		}
		await syncDirectory(resolveWorkspacePath(this.root, TRANSACTION_ROOT))
		await fs.rm(tombstoneAbsolute, { recursive: true, force: true })
	}

	private async acquireLock(): Promise<() => Promise<void>> {
		await ensureSafeDirectory(this.root, '.uiux')
		const lockAbsolute = resolveWorkspacePath(this.root, PERSISTENCE_LOCK)
		const lockParent = dirname(lockAbsolute)
		const token = randomUUID()
		const started = Date.now()
		while (true) {
			const candidateRelative = `.uiux/.persistence-lock-${token}-${randomUUID()}.tmp`
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
					if (Date.now() - started >= this.lockWaitMilliseconds)
						throw new PersistenceError('persistence.lock_busy', 'Timed out waiting for another UIUX persistence operation to finish.')
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

export class JsonResourceRepository<Key extends string, Resource> implements MutableResourceRepository<Key, Resource> {
	constructor(
		private readonly persistence: FileNativePersistence,
		private readonly pathFor: (key: Key) => string,
		private readonly identityField: string,
		private readonly validate: JsonValidator,
		private readonly discovery: Readonly<{ directory: string; suffix: string }>,
	) {}

	async discoverKeys(): Promise<readonly Key[]> {
		return this.persistence.withLock(async () => {
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
		return this.persistence.withLock(async () => {
			const bytes = await this.persistence.readOptionalBytesUnlocked(this.pathFor(key))
			return bytes ? revisionForBytes(bytes) : undefined
		})
	}


	async readInspected(key: Key): Promise<InspectedResource<Resource> | undefined> {
		return this.persistence.withLock(async () => {
			const path = this.pathFor(key)
			const bytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!bytes) return undefined
			const resource = parseJsonBytes(bytes, path)
			return { resource: resource as Resource, revision: revisionForBytes(bytes), diagnostics: this.validate(resource, basename(path)) }
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
			if (!await this.persistence.atomicCreateUnlocked(path, bytes))
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
			await this.persistence.atomicWriteUnlocked(path, bytes, currentBytes)
			return { ok: true, revision: revisionForBytes(bytes) }
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
			const path = workspaceRelativePath()
			if (await this.persistence.readOptionalBytesUnlocked(path))
				throw new PersistenceError('persistence.resource_exists', 'Workspace manifest already exists.')
			const bytes = this.persistence.serializeJson(resource, path)
			if (!await this.persistence.atomicCreateUnlocked(path, bytes))
				throw new PersistenceError('persistence.resource_exists', 'Workspace manifest already exists.')
			return revisionForBytes(bytes)
		})
	}

	async compareAndSwap(input: Readonly<{ key: 'workspace'; expectedRevision: ResourceRevision; resource: WorkspaceManifest }>): Promise<Readonly<{ ok: true; revision: ResourceRevision } | { ok: false; conflict: RevisionConflict }>> {
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			if (input.resource.schemaVersion !== this.persistence.schemaPolicy.currentVersion)
				throw new PersistenceError('workspace.schema_unsupported', 'Normal Workspace writes must keep the schemaVersion at the injected policy currentVersion.')
			const path = workspaceRelativePath()
			const currentBytes = await this.persistence.readOptionalBytesUnlocked(path)
			if (!currentBytes)
				throw new PersistenceError('workspace.manifest_missing', 'Workspace manifest does not exist.')
			const currentRevision = revisionForBytes(currentBytes)
			if (input.expectedRevision !== currentRevision)
				return { ok: false, conflict: { code: 'revision_conflict', currentRevision } }
			const bytes = this.persistence.serializeJson(input.resource, path)
			await this.persistence.atomicWriteUnlocked(path, bytes, currentBytes)
			return { ok: true, revision: revisionForBytes(bytes) }
		})
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
		return this.persistence.withLock(async () => {
			const bytes = await this.readExactBytesUnlocked(locale)
			return bytes ? revisionForBytes(bytes) : undefined
		})
	}


	async readInspected(locale: string): Promise<InspectedResource<I18nResource> | undefined> {
		return this.persistence.withLock(async () => {
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
		return this.persistence.withLock(async () => {
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
			if (!await this.persistence.atomicCreateUnlocked(path, bytes)) {
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
			await this.persistence.atomicWriteUnlocked(path, bytes, currentBytes)
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
		return this.persistence.withLock(async () => {
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
		return this.persistence.withLock(async () => {
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
		return this.persistence.withLock(async () => this.readAssetUnlocked(id))
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
			await this.persistence.applyFileTransaction([
				{ path: metadataPath, bytes: candidate.metadataBytes },
				{ path: `${directory}/${resource.metadata.contentFilename}`, bytes: resource.content },
			], 'asset')
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
			await this.persistence.applyFileTransaction(changes, 'asset')
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
		const identity = await sha256Identity(bytes) as `sha256:${string}`
		return this.persistence.withLock(async () => {
			await this.persistence.assertWritableUnlocked()
			const relativePath = artifactRelativePath(identity)
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
		})
	}

	async read(identity: string): Promise<Uint8Array | undefined> {
		return this.persistence.withLock(async () => {
			const relativePath = artifactRelativePath(identity)
			const bytes = await this.persistence.readOptionalBytesUnlocked(relativePath)
			if (!bytes) return undefined
			if (digestBytes(bytes) !== identity)
				throw new PersistenceError('persistence.artifact_corrupt', `Existing immutable artifact ${identity} does not match its content identity.`)
			return Uint8Array.from(bytes)
		})
	}

	async readCandidateJson<T = unknown>(identity: string, maxBytes = 512 * 1024): Promise<T | undefined> {
		return this.persistence.withLock(async () => {
			const relativePath = artifactRelativePath(identity)
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
		return this.persistence.withLock(async () => {
			const artifactsRelative = '.uiux/artifacts/sha256'
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

function assertEmbeddedIdentity(key: string, resource: unknown, identityField: string, filename: string): void {
	if (!isRecord(resource) || resource[identityField] !== key) {
		throw new PersistenceError('persistence.identity_mismatch', `Resource ${filename} must retain ${identityField} exactly equal to its canonical filename identity.`, {
			diagnostics: [{ code: 'identity.filename_id_mismatch', path: `/${identityField}`, message: `Resource identity must exactly match canonical filename ${filename}.` }],
		})
	}
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
	const manifestPath = workspaceRelativePath()
	const manifestBytes = snapshot.get(manifestPath)
	if (!manifestBytes)
		throw new PersistenceError('workspace.migration_failed', 'Migration result must contain .uiux/workspace.json.')
	const manifest = parseJsonBytes(manifestBytes, manifestPath)
	if (!isRecord(manifest) || manifest.schemaVersion !== expectedVersion)
		throw new PersistenceError('workspace.migration_failed', `Migration result manifest schemaVersion must equal its policy step target ${expectedVersion}.`)
	if (!policy.recognizedVersions.includes(expectedVersion) && expectedVersion !== policy.currentVersion)
		throw new PersistenceError('workspace.migration_failed', `Migration step target ${expectedVersion} is not recognized by the injected policy.`)
	const assetFiles = new Map<string, string[]>()
	for (const [relativePath, bytes] of snapshot) {
		assertTransactionalPath(relativePath)
		if (!(bytes instanceof Uint8Array))
			throw new PersistenceError('workspace.migration_failed', `Migration result ${relativePath} must contain bytes.`)
		if (relativePath === manifestPath) continue
		const segments = relativePath.split('/')
		const [directory, filename] = segments
		if (directory === 'assets') {
			if (segments.length !== 3 || !isFullUuid(segments[1]!))
				throw new PersistenceError('workspace.migration_failed', `Migration result contains non-canonical Asset path ${relativePath}.`)
			const files = assetFiles.get(segments[1]!) ?? []
			files.push(filename!)
			assetFiles.set(segments[1]!, files)
			if (filename === 'asset.json') {
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

function validateTransactionJournal(value: unknown): TransactionJournal {
	if (!isRecord(value) || !Array.isArray(value.changes))
		throw new TypeError('Persistence transaction journal has an invalid shape.')
	const changes: { path: string; existed: boolean }[] = []
	for (const change of value.changes) {
		if (!isRecord(change) || typeof change.path !== 'string' || typeof change.existed !== 'boolean')
			throw new TypeError('Persistence transaction journal contains an invalid entry.')
		assertTransactionalPath(change.path)
		changes.push({ path: change.path, existed: change.existed })
	}
	if (new Set(changes.map(change => change.path)).size !== changes.length)
		throw new TypeError('Persistence transaction journal repeats a path.')
	return { changes }
}

function assertTransactionalPath(relativePath: string): void {
	resolveWorkspacePath('/', relativePath)
	if (relativePath === workspaceRelativePath()) return
	const segments = relativePath.split('/')
	if (segments.length === 2 && segments[0] === 'views' && /^[0-9a-f-]+\.view\.json$/iu.test(segments[1]!) && isFullUuid(segments[1]!.slice(0, -'.view.json'.length))) return
	if (segments.length === 2 && segments[0] === 'flows' && /^[0-9a-f-]+\.flow\.json$/iu.test(segments[1]!) && isFullUuid(segments[1]!.slice(0, -'.flow.json'.length))) return
	if (segments.length === 2 && segments[0] === 'reviews' && /^[0-9a-f-]+\.review\.json$/iu.test(segments[1]!) && isFullUuid(segments[1]!.slice(0, -'.review.json'.length))) return
	if (segments.length === 2 && segments[0] === 'i18n' && isCanonicalLocaleFilename(segments[1])) return
	if (segments.length === 3 && segments[0] === 'assets' && isFullUuid(segments[1]!) && (segments[2] === 'asset.json' || isSafeAssetContentFilename(segments[2]))) return
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
