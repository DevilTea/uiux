import { validateAssetContentFiles, validateAssetContentMetadata, validateAssetMetadata, type AuthoredAsset, type AuthoredAssetResource } from '../../domain/assets/schema'
import { validateFormalEvidenceRecord } from '../../domain/evidence/schema'
import { validateFlowResource, type FlowResource } from '../../domain/flows/schema'
import { isRestorableResourceKind, RESTORABLE_RESOURCE_KINDS, type RestorableResourceKind } from '../../domain/history/constants'
import { isDiffableResourceKind } from '../../domain/history/diff'
import type { HistoryResourceIdentity, VersionRecord } from '../../domain/history/schema'
import { resourceIdentityKey } from '../../domain/history/summary'
import { validateI18nResource, type I18nResource } from '../../domain/i18n/schema'
import { analyzeImpact, withResource, type ImpactEvidence, type ImpactItem, type ImpactWorkspace } from '../../domain/impact'
import { isCanonicalLocaleTag, isFullUuid, isRecord, type Diagnostic, type ValidationResult } from '../../domain/validation'
import { validateViewResource, type ViewResource } from '../../domain/views/schema'
import { validateWorkspaceManifest, type WorkspaceManifest } from '../../domain/workspace/schema'
import { validateProductKit, type ProductKit } from '../../domain/product-kit/schema'
import type { AccessPresetsFile } from '../../domain/access-presets/schema'
import { accessPresetsWriteDiagnostics } from './access-presets-authoring'
import { checkProductKitAgainstKit } from '../../adapters/kit-registry'
import { PersistenceError } from '../../persistence/errors'
import { canonicalJsonBytes, revisionForResourceFiles, type FileNativePersistence } from '../../persistence/file-native'
import { HostHistoryError } from '../../persistence/history/host-store'
import { versionResourcesFromSnapshot } from '../../persistence/history/snapshot'
import { mergeTimeline } from '../../persistence/history/timeline'
import { readVersionBlobUnlocked } from '../../persistence/history/version-blobs'
import { assetMetadataRelativePath, REVIEW_FILE_SUFFIX, WORKSPACE_DATA_DIRECTORY, type WorkspaceLayout } from '../../persistence/paths'
import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import type { HistoryStoreSource } from './history-diff'

/**
 * Single-resource restore (Feature 01a11a5d-fd6b-7f9d-be15-2bc2bc3adc13, issue #132 B6), shared by
 * `POST /api/history/versions/:id/restore` and the MCP tool `restore_resource_version` (Clause
 * 01a11a5e-2768-76ad-b02a-e15f50f91268).
 *
 * A restore copies one design resource's content from a version into a new current revision
 * (Rules 01a11a5e-1428-… and 147c-…); history itself is never rewritten. It is a write of its target
 * like any authoring write (Rule 01a11a5e-1520-…): the caller names the target's *current* revision,
 * or `null` when the target must not exist (owner ruling 3 of
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18825439), and the write is a
 * compare-and-swap through the same repository the authoring operations use. Access, the edit
 * lease, actor stamping and the design-write context (operation `restoreResourceVersion` with
 * `restoredFrom`, which makes the recorder close the open autosave before and after the write, Rule
 * 01a11e0d-d911-7030-9565-7473aa0995e1) belong to the scoped session.
 *
 * - The version must be recorded under the current schema (Clause 01a11a5e-2434-…); its content is
 *   validated like an authoring write; invalid content is refused with diagnostics (Rule 01a11a5e-1580-…).
 * - A View restore keeps the View's current Decisions (Rule 01a11a5e-1645-…); a settings restore
 *   keeps the manifest's current `schemaVersion` (Rule 01a11a5e-15e9-…); a resource that no longer
 *   exists is re-created with its identity (Rule 01a11a5e-16a2-…).
 * - Before writing, the impact is analyzed (`src/domain/impact`); a non-empty impact list writes
 *   only with `acknowledgeImpact: true` (Rules 01a11a5e-16f7-…, 174b-… and 17a0-…).
 * - Reviews are never written (Rules 01a11a5e-184c-… and 189f-…); Evidence freshness and Handoff
 *   readiness are computed on read, so they follow the new revision like after any write (Rule
 *   01a11a5e-17f7-…).
 *
 * Kinds this build cannot restore (the kind set is open, seam 3) are refused. Refusal codes other
 * than the schema diagnostics are implementation-defined.
 */
// The kind set lives in the domain constants so the Workbench offers Restore for the same kinds;
// every one is a kind the impact analysis follows (`withResource` takes the target's kind).
export { isRestorableResourceKind, RESTORABLE_RESOURCE_KINDS, type RestorableResourceKind }

export type RestoreResourceVersionCommand = Readonly<{
	versionId: string
	resource: HistoryResourceIdentity
	/** The target's current revision, or `null` when the target must not exist. */
	expectedRevision: string | null
	acknowledgeImpact?: boolean
}>

export type RestoreWritten = Readonly<{
	status: 'created' | 'updated'
	kind: RestorableResourceKind
	key: string
	revision: ResourceRevision
	restoredFrom: string
	/** The impact the caller acknowledged; empty when there was none. */
	impacts: readonly ImpactItem[]
	diagnostics: readonly Diagnostic[]
	/** What the restore changed in the resource (Clause 01a11485-f578-79a7-9d01-4bc233f2c1cb); a restore writes no other canonical resource. */
	changeSummary: ChangeSummary
}>

export type RestoreConflict = Readonly<{ status: 'conflict'; kind: string; key: string; currentRevision: ResourceRevision | null }>

export type RestoreImpactRefusal = Readonly<{ status: 'impact_acknowledgement_required'; kind: string; key: string; impacts: readonly ImpactItem[] }>

export type RestoreRefusal = Readonly<{
	status: 'invalid' | 'not_found' | 'blocked' | 'failed'
	kind?: string
	key: string
	code: string
	message: string
	diagnostics: readonly Diagnostic[]
}>

export type RestoreResourceVersionOutcome = RestoreWritten | RestoreConflict | RestoreImpactRefusal | RestoreRefusal

/**
 * A caller's check of a restore against the resource it replaces, such as an authorization that
 * depends on what the restore changes. It runs after the revision check, on the current content at
 * `expectedRevision` (`undefined` when the resource does not exist), which the compare-and-swap
 * then requires, so the change it allows is exactly the change written. A returned refusal is
 * answered as is and nothing is written.
 */
export type RestoreGuard<R> = (change: Readonly<{ kind: RestorableResourceKind; key: string; current: unknown; next: unknown }>) => R | undefined

export type HistoryRestoreService = Readonly<{
	restoreResourceVersion<R = never>(command: RestoreResourceVersionCommand, guard?: RestoreGuard<R>): Promise<RestoreResourceVersionOutcome | R>
}>

type Target = Readonly<{ kind: RestorableResourceKind; key: string }>

type ParsedCommand = Readonly<{ versionId: string; target: Target; expectedRevision: string | null; acknowledgeImpact: boolean }>

/** What the restore reads under one shared persistence lock. */
type Loaded = Readonly<{
	version: VersionRecord
	/** The version's files for the target. */
	restoredFiles: ReadonlyMap<string, Uint8Array>
	/** The current versioned files of the Workspace. */
	current: ReadonlyMap<string, Uint8Array>
	reviews: readonly unknown[]
}>

export function createHistoryRestoreService(persistence: FileNativePersistence, history: HistoryStoreSource | undefined): HistoryRestoreService {
	const policy = persistence.schemaPolicy

	async function restoreResourceVersion<R = never>(command: RestoreResourceVersionCommand, guard?: RestoreGuard<R>): Promise<RestoreResourceVersionOutcome | R> {
		const parsed = parseCommand(command)
		if ('status' in parsed) return parsed
		const { target } = parsed
		let stores: Awaited<ReturnType<HistoryStoreSource['open']>>
		try {
			stores = await history?.open()
		}
		catch (error) {
			if (error instanceof HostHistoryError) return storeFailure(target, error)
			throw error
		}
		if (!stores) return refusal('not_found', target, 'history.record_missing', '/versionId', `Version ${parsed.versionId} does not exist.`)

		let loaded: Loaded | RestoreRefusal
		try {
			loaded = await persistence.withReadLock(() => load(parsed, stores))
		}
		catch (error) {
			if (error instanceof HostHistoryError) return storeFailure(target, error)
			throw error
		}
		if ('status' in loaded) return loaded

		const restored = decodeRestored(target, loaded.restoredFiles)
		if ('status' in restored) return restored
		const currentFiles = filesOf(loaded.current, persistence.layout, target)
		const currentRevision = currentFiles.size > 0 ? (revisionForResourceFiles(target.kind, currentFiles) as ResourceRevision | undefined) : undefined

		// Rule 01a11a5e-1520-…: the revision check is against the target's current revision.
		if (parsed.expectedRevision === null) {
			if (currentRevision !== undefined) return { status: 'conflict', kind: target.kind, key: target.key, currentRevision }
		}
		else if (currentRevision !== parsed.expectedRevision) {
			return { status: 'conflict', kind: target.kind, key: target.key, currentRevision: currentRevision ?? null }
		}

		const next = compose(target, restored.value, currentFiles)
		const diagnostics = validateNext(target, next, currentFiles)
		if (diagnostics.length > 0)
			return { status: 'invalid', kind: target.kind, key: target.key, code: 'history.restore_invalid_content', message: `The ${target.kind} content of version ${parsed.versionId} is not valid for this UIUX build, so it cannot be restored.`, diagnostics }

		const current = target.kind === 'asset' || currentFiles.size !== 1 ? undefined : parseJson([...currentFiles.values()][0]!)
		// The key check runs before the checks against the kit project, so a caller without the keys
		// causes no kit project I/O.
		const refused = guard?.({ kind: target.kind, key: target.key, current, next })
		if (refused !== undefined) return refused
		if (target.kind === 'product-kit') {
			// The checks against the kit project the Product Kit operations make (Rule 01a11a5e-1580-…),
			// for the members the restore changes.
			const kitRefusal = await checkRestoredProductKit(target, next as ProductKit, current)
			if (kitRefusal) return kitRefusal
		}

		const before = impactWorkspace(loaded.current, persistence.layout, loaded.reviews, target.kind === 'workspace' ? await readEvidence() : undefined)
		const after = withResource(before, target, target.kind === 'asset' ? (next as AuthoredAssetResource).metadata : next, nextRevision(target, next))
		const impacts = analyzeImpact(before, after)
		if (impacts.length > 0 && !parsed.acknowledgeImpact)
			return { status: 'impact_acknowledgement_required', kind: target.kind, key: target.key, impacts }

		return write(parsed, next, impacts, contentBefore(target, currentFiles))
	}

	async function checkRestoredProductKit(target: Target, next: ProductKit, current: unknown): Promise<RestoreRefusal | undefined> {
		const codeDirectoryName = persistence.layout.codeDir
		if (!codeDirectoryName) return undefined
		const currentKit = validateProductKit(current)
		const checked = await checkProductKitAgainstKit({
			root: persistence.root,
			codeDirectoryName,
			next,
			...(currentKit.ok ? { current: currentKit.value } : {}),
		})
		if (checked.refusals.length === 0) return undefined
		return { status: 'invalid', kind: target.kind, key: target.key, code: 'history.restore_invalid_content', message: `The Product Kit of this version does not match the kit project, so it cannot be restored.`, diagnostics: checked.refusals }
	}

	/** Under the shared lock: the schema state, the version, its blobs, the current files and the Reviews. */
	async function load(command: ParsedCommand, stores: NonNullable<Awaited<ReturnType<HistoryStoreSource['open']>>>): Promise<Loaded | RestoreRefusal> {
		const { target } = command
		// Rule 01a1144e-4fcf-7b8a-8978-73b1a0cc31f4: a restore is a mutation.
		try {
			await persistence.assertWritableUnlocked()
		}
		catch (error) {
			if (!(error instanceof PersistenceError)) throw error
			const message = `A restore cannot run for this Workspace schema state: ${error.message}`
			return { status: 'blocked', kind: target.kind, key: target.key, code: error.code, message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/schemaVersion', message: error.message }] }
		}

		const timeline = mergeTimeline(await stores.host?.listVersions(), await stores.checkpoints?.listUnlocked())
		const version = timeline.versions.find(entry => entry.version.id === command.versionId)?.version
		if (!version) return refusal('not_found', target, 'history.record_missing', '/versionId', `Version ${command.versionId} does not exist.`)
		// Rule 01a11a5e-081c-7149-9345-836ce2267c0a and Clause 01a11a5e-2434-7342-a3c1-6d63aa74334c.
		if (version.workspaceSchemaVersion !== policy.currentVersion)
			return refusal('blocked', target, 'workspace.schema_unsupported', '/versionId', `Version ${version.id} was recorded under Workspace schemaVersion ${version.workspaceSchemaVersion} and cannot be restored: this UIUX reads only schemaVersion ${policy.currentVersion}.`)
		const identity = resourceIdentityKey(target)
		const entry = version.resources.find(resource => resourceIdentityKey(resource) === identity)
		if (!entry) return refusal('not_found', target, 'history.resource_not_in_version', '/resource', `Version ${version.id} does not hold ${target.kind} ${target.key}.`)

		const snapshot = new Map<string, Uint8Array>()
		if (isDiffableResourceKind(entry.kind)) {
			for (const [path, digest] of Object.entries(entry.files)) {
				if (!persistence.layout.classifyVersionedPath(path)) continue
				const bytes = await readVersionBlobUnlocked(persistence, stores.host, digest)
				if (!bytes) return refusal('failed', target, 'history.blob_missing', '/versionId', `Version ${version.id} names file ${path} (${digest}), whose content is no longer stored.`)
				snapshot.set(path, bytes)
			}
		}
		const restoredFiles = filesOf(snapshot, persistence.layout, target)
		return { version, restoredFiles, current: await persistence.scanVersionedSnapshotUnlocked(), reviews: await readReviewsUnlocked() }
	}

	/** Every Review thread file, decoded leniently: the analysis only follows what it can read. */
	async function readReviewsUnlocked(): Promise<readonly unknown[]> {
		const entries = await persistence.listDirectoryUnlocked(WORKSPACE_DATA_DIRECTORY.reviews)
		const reviews: unknown[] = []
		for (const entry of entries ?? []) {
			if (!entry.isFile() || !entry.name.endsWith(REVIEW_FILE_SUFFIX)) continue
			const bytes = await persistence.readOptionalBytesUnlocked(`${WORKSPACE_DATA_DIRECTORY.reviews}/${entry.name}`)
			const value = bytes ? parseJson(bytes) : undefined
			if (value !== undefined) reviews.push(value)
		}
		return reviews
	}

	/** The formal Evidence records, read as `listEvidence` reads them (all artifacts under one shared lock). */
	async function readEvidence(): Promise<readonly ImpactEvidence[]> {
		const evidence: ImpactEvidence[] = []
		for (const { identity: digest, value: candidate } of await persistence.artifacts.readAllCandidateJson({ tolerateErrors: true })) {
			const validation = validateFormalEvidenceRecord(candidate)
			if (validation.ok && validation.value.kind === 'formal_capture') evidence.push({ digest, record: validation.value })
		}
		return evidence
	}

	/** The compare-and-swap (or, for `expectedRevision: null`, the create) through the authoring repositories. */
	async function write(command: ParsedCommand, next: RestoredResource, impacts: readonly ImpactItem[], before: unknown): Promise<RestoreResourceVersionOutcome> {
		const { target, expectedRevision } = command
		const conflict = async (): Promise<RestoreConflict> => ({ status: 'conflict', kind: target.kind, key: target.key, currentRevision: (await currentRevisionOf(target)) ?? null })
		try {
			let revision: ResourceRevision
			if (expectedRevision === null) {
				switch (target.kind) {
					case 'view': revision = await persistence.views.create(target.key, next as ViewResource); break
					case 'flow': revision = await persistence.flows.create(target.key, next as FlowResource); break
					case 'locale': revision = await persistence.locales.create(target.key, next as I18nResource); break
					case 'asset': revision = await persistence.assets.create(target.key, next as AuthoredAssetResource); break
					// The manifest, the Product Kit file and the Access presets file exist while the Workspace is
					// writable; `null` already conflicted. A missing presets file is not re-created by a restore.
					case 'workspace':
					case 'product-kit':
					case 'access-presets': return await conflict()
				}
			}
			else {
				const swap = { key: target.key, expectedRevision: expectedRevision as ResourceRevision }
				const commit = target.kind === 'view' ? await persistence.views.compareAndSwap({ ...swap, resource: next as ViewResource })
					: target.kind === 'flow' ? await persistence.flows.compareAndSwap({ ...swap, resource: next as FlowResource })
						: target.kind === 'locale' ? await persistence.locales.compareAndSwap({ ...swap, resource: next as I18nResource })
							: target.kind === 'asset' ? await persistence.assets.compareAndSwap({ ...swap, resource: next as AuthoredAssetResource })
								: target.kind === 'product-kit' ? await persistence.productKit.compareAndSwap({ ...swap, key: 'product-kit', resource: next as ProductKit })
									: target.kind === 'access-presets' ? await persistence.accessPresets.compareAndSwap({ ...swap, key: 'access-presets', resource: next as AccessPresetsFile })
										: await persistence.workspace.compareAndSwap({ ...swap, key: 'workspace', resource: next as WorkspaceManifest })
				if (!commit.ok) return { status: 'conflict', kind: target.kind, key: target.key, currentRevision: commit.conflict.currentRevision }
				revision = commit.revision
			}
			return {
				status: expectedRevision === null ? 'created' : 'updated',
				kind: target.kind,
				key: target.key,
				revision,
				restoredFrom: command.versionId,
				impacts,
				diagnostics: await diagnosticsAfter(target),
				changeSummary: summarizeChange(before, next),
			}
		}
		catch (error) {
			if (!(error instanceof PersistenceError)) throw error
			switch (error.code) {
				case 'persistence.resource_exists':
				case 'persistence.asset_shape_invalid':
				case 'persistence.resource_not_found':
				case 'workspace.manifest_missing':
					return conflict()
				case 'workspace.schema_unsupported':
					return { status: 'blocked', kind: target.kind, key: target.key, code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/schemaVersion', message: error.message }] }
				// The target's current file is not readable JSON, so its identity cannot be checked before
				// it is replaced, as for an authoring write; nothing was written.
				case 'persistence.invalid_json':
					return { status: 'blocked', kind: target.kind, key: target.key, code: error.code, message: `The current ${target.kind} ${target.key} is not readable JSON, so it cannot be replaced by a restore. ${error.message}`, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/resource', message: error.message }] }
				case 'persistence.path_rejected':
				case 'persistence.identity_mismatch':
					if (error.diagnostics.length > 0 || error.code === 'persistence.identity_mismatch')
						return { status: 'invalid', kind: target.kind, key: target.key, code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/resource', message: error.message }] }
					throw error
				default:
					throw error
			}
		}
	}

	async function currentRevisionOf(target: Target): Promise<ResourceRevision | undefined> {
		switch (target.kind) {
			case 'view': return persistence.views.readRevision(target.key)
			case 'flow': return persistence.flows.readRevision(target.key)
			case 'locale': return persistence.locales.readRevision(target.key)
			case 'asset': return persistence.assets.readRevision(target.key)
			case 'workspace': return (await persistence.workspace.readInspected()).revision
			case 'product-kit': return persistence.productKit.readRevision()
			case 'access-presets': return persistence.accessPresets.readRevision()
		}
	}

	/** The diagnostics an authoring write reports after committing: the inspected read of the result. */
	async function diagnosticsAfter(target: Target): Promise<readonly Diagnostic[]> {
		switch (target.kind) {
			case 'view': return (await persistence.views.readInspected(target.key))?.diagnostics ?? []
			case 'flow': return (await persistence.flows.readInspected(target.key))?.diagnostics ?? []
			case 'locale': return (await persistence.locales.readInspected(target.key))?.diagnostics ?? []
			case 'asset': return (await persistence.assets.readInspected(target.key))?.diagnostics ?? []
			case 'workspace': return (await persistence.workspace.readInspected()).diagnostics
			case 'product-kit': return (await persistence.productKit.readInspected())?.diagnostics ?? []
			case 'access-presets': return (await persistence.accessPresets.readInspected())?.diagnostics ?? []
		}
	}

	return Object.freeze({ restoreResourceVersion })
}

type RestoredResource = ViewResource | FlowResource | I18nResource | WorkspaceManifest | ProductKit | AccessPresetsFile | AuthoredAssetResource

function parseCommand(command: RestoreResourceVersionCommand): ParsedCommand | RestoreRefusal {
	const raw = (command ?? {}) as Readonly<Record<string, unknown>>
	const resource = isRecord(raw.resource) ? raw.resource : undefined
	const kind = typeof resource?.kind === 'string' ? resource.kind : undefined
	const key = typeof resource?.key === 'string' ? resource.key : ''
	const reference: Readonly<{ kind?: string; key: string }> = { ...(kind === undefined ? {} : { kind }), key }
	const invalid = (path: string, message: string, code = 'history.invalid_restore'): RestoreRefusal =>
		({ status: 'invalid', ...reference, code, message, diagnostics: [{ code, path, message }] })
	if (kind === undefined || key.length === 0) return invalid('/resource', 'resource is { kind, key } with non-empty strings.')
	// Seam 3: the kind set is open; a kind this build does not know how to write is refused.
	if (!isRestorableResourceKind(kind))
		return invalid('/resource/kind', `Restoring a ${kind} resource is not supported by this UIUX build; restorable kinds are ${RESTORABLE_RESOURCE_KINDS.join(', ')}.`, 'history.restore_unsupported_kind')
	if (!validKey(kind, key)) return invalid('/resource/key', `${key} is not a valid ${kind} key.`)
	if (raw.expectedRevision !== null && (typeof raw.expectedRevision !== 'string' || raw.expectedRevision.length === 0))
		return invalid('/expectedRevision', 'expectedRevision is the target\'s current revision, or null when the resource must not exist.')
	if (raw.acknowledgeImpact !== undefined && typeof raw.acknowledgeImpact !== 'boolean')
		return invalid('/acknowledgeImpact', 'acknowledgeImpact is a boolean.')
	if (!isFullUuid(raw.versionId))
		return { status: 'not_found', kind, key, code: 'history.record_missing', message: `Version ${String(raw.versionId)} does not exist.`, diagnostics: [{ code: 'history.record_missing', path: '/versionId', message: `Version ${String(raw.versionId)} does not exist.` }] }
	return { versionId: raw.versionId, target: { kind, key }, expectedRevision: raw.expectedRevision as string | null, acknowledgeImpact: raw.acknowledgeImpact === true }
}

function validKey(kind: RestorableResourceKind, key: string): boolean {
	switch (kind) {
		case 'workspace': return key === 'workspace'
		case 'product-kit': return key === 'product-kit'
		case 'access-presets': return key === 'access-presets'
		case 'locale': return isCanonicalLocaleTag(key)
		default: return isFullUuid(key)
	}
}

/** The files of one resource in a snapshot, by the layout's classification (seam 2: identity, not paths). */
function filesOf(snapshot: ReadonlyMap<string, Uint8Array>, layout: WorkspaceLayout, target: Target): Map<string, Uint8Array> {
	const files = new Map<string, Uint8Array>()
	for (const [path, bytes] of snapshot) {
		const identity = layout.classifyVersionedPath(path)
		if (identity && identity.kind === target.kind && identity.key === target.key) files.set(path, bytes)
	}
	return files
}

type Decoded = Readonly<{ value: unknown }>

/**
 * The target's current content in the repository's resource shape, for the change summary:
 * `undefined` when it does not exist, and `null` when its files cannot be decoded, so the whole
 * resource reads as replaced.
 */
function contentBefore(target: Target, currentFiles: ReadonlyMap<string, Uint8Array>): unknown {
	if (currentFiles.size === 0) return undefined
	const decoded = decodeRestored(target, currentFiles)
	return 'status' in decoded ? null : decoded.value
}

/** The restored content as the repository's resource shape: parsed JSON, or an Asset's metadata and bytes. */
function decodeRestored(target: Target, files: ReadonlyMap<string, Uint8Array>): Decoded | RestoreRefusal {
	const unreadable = (message: string, path = '/resource'): RestoreRefusal =>
		({ status: 'invalid', kind: target.kind, key: target.key, code: 'history.restore_invalid_content', message, diagnostics: [{ code: 'history.restore_invalid_content', path, message }] })
	if (target.kind === 'asset') {
		const metadataPath = assetMetadataRelativePath(target.key)
		const metadataBytes = files.get(metadataPath)
		const metadata = metadataBytes ? parseJson(metadataBytes) : undefined
		if (metadata === undefined) return unreadable(`The recorded asset.json of Asset ${target.key} is not readable JSON.`)
		const content = [...files].filter(([path]) => path !== metadataPath)
		const contentFilenames = content.map(([path]) => path.slice(path.lastIndexOf('/') + 1))
		const shape = isRecord(metadata) ? validateAssetContentFiles(metadata as AuthoredAsset, contentFilenames) : { ok: true, diagnostics: [] }
		if (!shape.ok || content.length !== 1) return { status: 'invalid', kind: target.kind, key: target.key, code: 'history.restore_invalid_content', message: `The recorded Asset ${target.key} does not hold exactly its one content file.`, diagnostics: shape.diagnostics }
		return { value: { metadata, content: Uint8Array.from(content[0]![1]) } }
	}
	const bytes = files.size === 1 ? [...files.values()][0] : undefined
	const value = bytes ? parseJson(bytes) : undefined
	if (value === undefined) return unreadable(`The recorded ${target.kind} ${target.key} is not readable JSON.`)
	return { value }
}

/** Rules 01a11a5e-1645-… and 01a11a5e-15e9-…: what a View and a settings restore keep from the current resource. */
function compose(target: Target, restored: unknown, currentFiles: ReadonlyMap<string, Uint8Array>): RestoredResource {
	const exists = currentFiles.size > 0
	const current = target.kind === 'asset' || currentFiles.size !== 1 ? undefined : parseJson([...currentFiles.values()][0]!)
	if (target.kind === 'view' && isRecord(restored) && isRecord(restored.spec) && exists) {
		// An existing View keeps its current Decisions, none when its file has none or cannot be
		// read. Only a re-created View (owner ruling 1 of
		// https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18837266) keeps the version's.
		const currentSpec = isRecord(current) && isRecord(current.spec) ? current.spec : undefined
		const decisions = currentSpec && Array.isArray(currentSpec.decisions) ? currentSpec.decisions : []
		return { ...restored, spec: { ...restored.spec, decisions } } as unknown as ViewResource
	}
	if (target.kind === 'workspace' && isRecord(restored) && isRecord(current) && Object.hasOwn(current, 'schemaVersion'))
		return { ...restored, schemaVersion: current.schemaVersion } as unknown as WorkspaceManifest
	return restored as RestoredResource
}

/** Rule 01a11a5e-1580-…: the same checks the authoring write of that kind makes before writing. */
function validateNext(target: Target, next: RestoredResource, currentFiles: ReadonlyMap<string, Uint8Array>): readonly Diagnostic[] {
	const failed = (result: ValidationResult<unknown>) => result.ok ? [] : result.diagnostics
	switch (target.kind) {
		case 'view': return failed(validateViewResource(next, `${target.key}.view.json`))
		case 'flow': return failed(validateFlowResource(next, `${target.key}.flow.json`))
		case 'locale': return failed(validateI18nResource(next, `${target.key}.json`))
		case 'workspace': return failed(validateWorkspaceManifest(next))
		case 'product-kit': return failed(validateProductKit(next))
		// `update_access_presets`'s checks: a key outside the catalog is kept only when the current file holds it.
		case 'access-presets': return accessPresetsWriteDiagnostics(next, currentFiles.size === 1 ? parseJson([...currentFiles.values()][0]!) : undefined)
		case 'asset': {
			const { metadata, content } = next as AuthoredAssetResource
			const metadataValidation = validateAssetMetadata(metadata, target.key)
			if (!metadataValidation.ok) return metadataValidation.diagnostics
			return validateAssetContentMetadata(metadata, metadata.contentFilename, content).diagnostics
		}
	}
}

/** The revision persistence will report for the written resource (the same canonical bytes). */
function nextRevision(target: Target, next: RestoredResource): string | undefined {
	if (target.kind === 'asset') {
		const { metadata, content } = next as AuthoredAssetResource
		const path = assetMetadataRelativePath(target.key)
		return revisionForResourceFiles('asset', new Map([[path, canonicalJsonBytes(metadata)], [`${path.slice(0, path.lastIndexOf('/'))}/${metadata.contentFilename}`, content]]))
	}
	return revisionForResourceFiles(target.kind, new Map([[target.kind, canonicalJsonBytes(next)]]))
}

/** The analysis picture of the current Workspace: the versioned files, the Reviews and, when asked, the formal Evidence. */
function impactWorkspace(snapshot: ReadonlyMap<string, Uint8Array>, layout: WorkspaceLayout, reviews: readonly unknown[], evidence: readonly ImpactEvidence[] | undefined): ImpactWorkspace {
	const revisions = new Map<string, string>()
	for (const resource of versionResourcesFromSnapshot(snapshot, layout).resources) revisions.set(resourceIdentityKey(resource), resource.revision)
	const views = new Map<string, unknown>()
	const flows = new Map<string, unknown>()
	const locales = new Map<string, unknown>()
	const assets = new Set<string>()
	let manifest: unknown
	for (const [path, bytes] of snapshot) {
		const identity = layout.classifyVersionedPath(path)
		if (!identity) continue
		if (identity.kind === 'asset') {
			if (revisions.has(resourceIdentityKey(identity))) assets.add(identity.key)
			continue
		}
		const value = parseJson(bytes)
		if (value === undefined) continue
		if (identity.kind === 'workspace') manifest = value
		else if (identity.kind === 'view') views.set(identity.key, value)
		else if (identity.kind === 'flow') flows.set(identity.key, value)
		else if (identity.kind === 'locale') locales.set(identity.key, value)
	}
	return { manifest, views, flows, locales, assets, reviews, revisions, ...(evidence ? { evidence } : {}) }
}

function parseJson(bytes: Uint8Array): unknown {
	try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown }
	catch { return undefined }
}

function refusal(status: RestoreRefusal['status'], target: Target, code: string, path: string, message: string): RestoreRefusal {
	return { status, kind: target.kind, key: target.key, code, message, diagnostics: [{ code, path, message }] }
}

function storeFailure(target: Target, error: HostHistoryError): RestoreRefusal {
	return { status: 'failed', kind: target.kind, key: target.key, code: error.code, message: error.message, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '/', message: error.message }] }
}
