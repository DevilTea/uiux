import { sha256Identity } from '../../domain/artifacts/schema'
import type { AuthoredAsset } from '../../domain/assets/schema'
import { flowReferenceDiagnostics } from '../../domain/flows/references'
import type { FlowResource } from '../../domain/flows/schema'
import type { I18nResource } from '../../domain/i18n/schema'
import { reviewAnchorState, type ReviewAnchorState, type ReviewAnchorTarget } from '../../domain/reviews/anchor-state'
import type { ChangeDomain } from '../../domain/reviews/change-domains'
import { markRemovedActors } from '../../domain/reviews/removed-actors'
import { deriveReviewResolution, isWidgetAnchor, isWorkspaceAnchor, type ReviewActor, type ReviewEvidenceRef, type ReviewResolution, type ReviewSubmission, type ReviewThread } from '../../domain/reviews/schema'
import type { DecisionStatus } from '../../domain/spec/schema'
import type { Diagnostic } from '../../domain/validation'
import type { ViewResource } from '../../domain/views/schema'
import type { WorkspaceManifest } from '../../domain/workspace/schema'
import type { FileNativePersistence, WorkspaceInspection } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import {
	DISCOVERABLE_RESOURCE_KINDS,
	DISCOVERY_DETAIL_EXCERPT_GRAPHEMES,
	REVIEW_DISMISSAL_RESOLUTIONS,
	REVIEW_MESSAGE_EXCERPT_GRAPHEMES,
	REVIEW_VIEW_WIDE_VARIANT,
	REVIEW_WORKSPACE_VIEW_TOKEN,
	validateResourceDiscoveryRequest,
	type DiscoverableResourceKind,
	type ResourceDiscoveryItem,
	type ReviewAnchorScope,
	type ResourceDiscoveryOutcome,
	type ResourceDiscoveryRequest,
	type ReviewDiscoveryStatus,
	type ReviewDiscoveryDetail,
	type ReviewDiscoverySummary,
	type ViewDiscoveryDetail,
} from '../dto/resource-discovery'
import type { ResourceRevision } from '../dto/revisions'
import { isValidPointResourceAddress, type PointResourceKind } from '../dto/point-resources'
import {
	createViewAuthoringService,
	type CreateViewCommand,
	type DecideDecisionCommand,
	type DecisionLifecycleCommand,
	type DeleteViewCommand,
	type UpdateViewMetadataCommand,
	type UpdateViewSpecCommand,
	type UpdateViewStructureCommand,
	type ViewAuthoringResult,
} from './view-authoring'
import {
	createWorkspaceAuthoringService,
	type UpdateWorkspaceSettingsCommand,
	type WorkspaceAuthoringResult,
	type WorkspaceSettingsGuard,
} from './workspace-authoring'
import {
	createLocaleAuthoringService,
	type CreateLocaleCommand,
	type LocaleAuthoringResult,
	type UpdateLocaleCommand,
} from './locale-authoring'
import {
	createFlowAuthoringService,
	type CreateFlowCommand,
	type DeleteFlowCommand,
	type FlowAuthoringResult,
	type UpdateFlowCommand,
} from './flow-authoring'
import {
	createReviewAuthoringService,
	type AppendReviewMessageCommand,
	type CreateReviewThreadCommand,
	type EditReviewMessageCommand,
	type CreateDecisionFromReviewCommand,
	type PromoteReviewToDecisionCommand,
	type ReanchorReviewThreadCommand,
	type ReopenReviewThreadCommand,
	type ResolveReviewThreadCommand,
	type RetractReviewThreadCommand,
	type ReviewAuthoringResult,
	type SetReviewDisplayHintCommand,
	type SubmitReadyForReviewCommand,
} from './review-authoring'
import {
	createAssetAuthoringService,
	type AssetAuthoringResult,
	type CreateAssetCommand,
	type DeleteAssetCommand,
	type ReplaceAssetCommand,
} from './asset-authoring'
import {
	createFormalCaptureService,
	type AdapterThemeSupportSource,
	type CaptureFormalEvidenceCommand,
	type CaptureFormalEvidenceResult,
	type FormalEvidenceItem,
	type ViewRenderInput,
} from './formal-capture'
import { createProductKitChecksService, type ProductKitChecksResult } from './product-kit-checks'
import { readCurrentProductKitProvenance } from './product-kit-provenance'
import type { CurrentProductKitProvenance } from '../../domain/product-kit/provenance'
import { readCurrentAdapterProvenance, type AdapterProvenanceSource } from './adapter-provenance'
import type { CurrentAdapterProvenance } from '../../domain/evidence/adapter-provenance'
import {
	createHandoffExportService,
	type AdapterSetRuntimeCheck,
	type AssessHandoffReadinessCommand,
	type AssessHandoffReadinessResult,
	type ExportHandoffCommand,
	type ExportHandoffResult,
} from './handoff-export'
import {
	createHistoryDiffService,
	type DiffVersionsCommand,
	type HistoryStoreSource,
	type VersionDiffOutcome,
} from './history-diff'
import { createHistoryRestoreService, type RestoreGuard, type RestoreResourceVersionCommand, type RestoreResourceVersionOutcome } from './history-restore'
import { readViewReferenceTarget } from './flow-references'
import { createChecksRunEvidenceService, type RecordChecksRunResult } from './checks-run-evidence'
import { createFlowEvidenceService, type CaptureFlowEvidenceCommand, type CaptureFlowEvidenceResult } from './flow-evidence'
import { createInteractionEvidenceService, type CaptureInteractionEvidenceCommand, type CaptureInteractionEvidenceResult } from './interaction-evidence'
import { createViewAssetBindingCheck, type AssetCatalog } from './asset-bindings'
import { createHistoryPreviewService, type ReadVersionBlobOutcome, type ReadVersionResourceOutcome, type ResolveVersionAssetsOutcome } from './history-preview'
import {
	createHistoryService,
	type CheckpointBoundary,
	type CreateCheckpointCommand,
	type CreateCheckpointOutcome,
	type DeleteCheckpointOutcome,
	type ListVersionsOutcome,
	type ListVersionsQuery,
	type ReadVersionOutcome,
} from './history-service'
import {
	createProductKitAuthoringService,
	type ComposeProductKitCommand,
	type ProductKitAuthoringResult,
	type ProductKitGuard,
	type ProductKitRead,
	type UpdateComponentRegistryCommand,
	type UpdateProductKitCommand,
} from './product-kit-authoring'
import {
	createAccessPresetsAuthoringService,
	type AccessPresetsAuthoringResult,
	type AccessPresetsRead,
	type UpdateAccessPresetsCommand,
} from './access-presets-authoring'
import { createKitBuildService, type KitBuildLogRead, type KitBuildRead, type RestartKitBuildResult } from './kit-build'
import type { KitBuildControl } from '../ports/kit-build'
import { createKitSourceService, type KitSourceService } from './kit-source'

export type AssetContentDescriptor = Readonly<{
	mediaType: string
	size: number
	digest: string
	contentUrl: string
}>

export type AssetPointResourceRead = Readonly<{
	kind: 'asset'
	key: string
	resource: Readonly<{ metadata: AuthoredAsset; content: AssetContentDescriptor }>
	metadata: AuthoredAsset
	content: AssetContentDescriptor
	revision: ResourceRevision
	diagnostics: readonly Diagnostic[]
}>

export type PointResourceRead =
	| Readonly<{ kind: 'workspace'; key: 'workspace'; resource: WorkspaceManifest; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; inspection: WorkspaceInspection }>
	| Readonly<{ kind: 'view'; key: string; resource: ViewResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'flow'; key: string; resource: FlowResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'locale'; key: string; resource: I18nResource; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ kind: 'review'; key: string; resource: ReviewThread; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| AssetPointResourceRead

export type ValidateFlowResult =
	| Readonly<{ flowId: string; revision: ResourceRevision; valid: boolean; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'not_found'; flowId: string }>

export interface WorkspaceApplicationSession {
	readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined>
	listPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	searchPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	createView(command: CreateViewCommand): Promise<ViewAuthoringResult>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult>
	deleteView(command: DeleteViewCommand): Promise<ViewAuthoringResult>
	updateViewMetadata(command: UpdateViewMetadataCommand): Promise<ViewAuthoringResult>
	deferDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
	decideDecision(command: DecideDecisionCommand): Promise<ViewAuthoringResult>
	reopenDecision(command: DecisionLifecycleCommand): Promise<ViewAuthoringResult>
	updateWorkspaceSettings<R = never>(command: UpdateWorkspaceSettingsCommand, guard?: WorkspaceSettingsGuard<R>): Promise<WorkspaceAuthoringResult | R>
	readProductKit(): Promise<ProductKitRead | undefined>
	composeProductKit<R = never>(command: ComposeProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	updateProductKit<R = never>(command: UpdateProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	updateComponentRegistry<R = never>(command: UpdateComponentRegistryCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	readAccessPresets(): Promise<AccessPresetsRead>
	updateAccessPresets(command: UpdateAccessPresetsCommand): Promise<AccessPresetsAuthoringResult>
	readKitBuild(): KitBuildRead
	readKitBuildLog(): KitBuildLogRead
	restartKitBuild(): Promise<RestartKitBuildResult>
	listKitFiles: KitSourceService['listKitFiles']
	readKitFile: KitSourceService['readKitFile']
	getComponentSource: KitSourceService['getComponentSource']
	compareComponentCopies: KitSourceService['compareComponentCopies']
	createLocale(command: CreateLocaleCommand): Promise<LocaleAuthoringResult>
	updateLocale(command: UpdateLocaleCommand): Promise<LocaleAuthoringResult>
	createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult>
	updateFlow(command: UpdateFlowCommand): Promise<FlowAuthoringResult>
	deleteFlow(command: DeleteFlowCommand): Promise<FlowAuthoringResult>
	createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult>
	appendReviewMessage(command: AppendReviewMessageCommand): Promise<ReviewAuthoringResult>
	reanchorReviewThread(command: ReanchorReviewThreadCommand): Promise<ReviewAuthoringResult>
	submitReadyForReview(command: SubmitReadyForReviewCommand): Promise<ReviewAuthoringResult>
	resolveReviewThread(command: ResolveReviewThreadCommand): Promise<ReviewAuthoringResult>
	reopenReviewThread(command: ReopenReviewThreadCommand): Promise<ReviewAuthoringResult>
	setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<ReviewAuthoringResult>
	promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult>
	createDecisionFromReview(command: CreateDecisionFromReviewCommand): Promise<ReviewAuthoringResult>
	editReviewMessage(command: EditReviewMessageCommand): Promise<ReviewAuthoringResult>
	retractReviewThread(command: RetractReviewThreadCommand): Promise<ReviewAuthoringResult>
	createAsset(command: CreateAssetCommand): Promise<AssetAuthoringResult>
	replaceAsset(command: ReplaceAssetCommand): Promise<AssetAuthoringResult>
	deleteAsset(command: DeleteAssetCommand): Promise<AssetAuthoringResult>
	captureFormalEvidence(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
	/** Clause 01a172cc-de18-79ea-a611-c8ea5a34e250: a Flow's structural and reference diagnostics, read-only. */
	validateFlow(flowId: string): Promise<ValidateFlowResult>
	/** Clause 01a172cc-e195-711b-bfa9-5de6c1c8ff87: formal UX Flow Evidence. */
	captureFlowEvidence(command: CaptureFlowEvidenceCommand): Promise<CaptureFlowEvidenceResult>
	/** Clause 01a17762-b85b-77d6-a399-e26843475501: replayable interaction Evidence. */
	captureInteractionEvidence(command: CaptureInteractionEvidenceCommand): Promise<CaptureInteractionEvidenceResult>
	/** Clauses 01a17670-d442-7068-8a08-c6e4ab9c09ae and 01a17671-11bf-7711-887b-121a02602cf4: the Workbench's Run Checks result as Evidence. */
	recordChecksRun(input: unknown): Promise<RecordChecksRunResult>
	listEvidence(viewId?: string, kinds?: readonly string[]): Promise<readonly FormalEvidenceItem[]>
	/** Every readable View's current render-input digest (Rule 01a115cd-c5a5-…). */
	viewRenderInputs(): Promise<readonly ViewRenderInput[]>
	/** The Product Kit Checks (issue #141 Part 14 decision 7), run on request and non-blocking. */
	runProductKitChecks(command?: Readonly<{ readSource?: boolean }>): Promise<ProductKitChecksResult>
	/** The current Product Kit provenance, against which Evidence freshness is judged (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…). */
	productKitProvenance(): Promise<CurrentProductKitProvenance>
	/** The current Adapter provenance, against which Evidence freshness is judged (Rules 01a115cd-c6de-… and 01a1161b-ff68-…). */
	adapterProvenance(): Promise<CurrentAdapterProvenance>
	assessHandoffReadiness(command: AssessHandoffReadinessCommand): Promise<AssessHandoffReadinessResult>
	exportHandoff(command: ExportHandoffCommand): Promise<ExportHandoffResult>
	readArtifact(identity: string): Promise<Uint8Array | undefined>
	diffVersions(command: DiffVersionsCommand): Promise<VersionDiffOutcome>
	createCheckpoint(command: CreateCheckpointCommand): Promise<CreateCheckpointOutcome>
	deleteCheckpoint(id: string): Promise<DeleteCheckpointOutcome>
	listVersions(query: ListVersionsQuery): Promise<ListVersionsOutcome>
	readVersion(id: string): Promise<ReadVersionOutcome>
	readVersionResource(id: string, kind: string, key: string): Promise<ReadVersionResourceOutcome>
	readVersionBlob(digest: string): Promise<ReadVersionBlobOutcome>
	resolveVersionAssets(id: string, assetIds: readonly string[]): Promise<ResolveVersionAssetsOutcome>
	restoreResourceVersion<R = never>(command: RestoreResourceVersionCommand, guard?: RestoreGuard<R>): Promise<RestoreResourceVersionOutcome | R>
}

/**
 * Application-facing selected-Workspace facade shared by HTTP/MCP/Workbench.
 * Transports never reach into FileNativePersistence directly.
 */
export function createWorkspaceApplicationSession(
	persistence: FileNativePersistence,
	options?: {
		serverOrigin?: string
		captureCookie?: () => Readonly<{ name: string; value: string }> | undefined
		/** The Workspace's history stores; without them no version exists to compare. */
		history?: HistoryStoreSource
		/**
		 * The history recorder's boundary, taken before every Checkpoint (Rule
		 * 01a11a5e-00b9-7bf5-8005-9380a388afb8); absent where no recorder runs.
		 */
		historyBoundary?: () => CheckpointBoundary | undefined
		/** The kit build runner under `uiux dev`; without it no kit build runs and its state is `none`. */
		kitBuild?: KitBuildControl
		/** The server-side Adapter check Handoff applies to the Adapters it materializes (Clause 01a116f0-cae2-7c64-9c76-d472f252789a). */
		checkAdapterSet?: AdapterSetRuntimeCheck
		/** The theme support of the current Adapter resolution, which formal capture applies (Rule 01a11add-f46d-7e92-8f5a-9d10dba6473d). */
		adapterThemeSupport?: AdapterThemeSupportSource
		/**
		 * The server's Adapter resolution, the one the Preview renders with, with the content digests
		 * and the identity of its pinned output generation, which formal capture, Evidence freshness and
		 * Handoff export follow (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42); without it the Adapters
		 * resolve from disk.
		 */
		adapterResolution?: Omit<AdapterProvenanceSource, 'kitBuild'>
		/**
		 * The member IDs on this host's roster now. Review reads mark an actor of kind member that is
		 * not in it with `removed: true` (Rule 01a11485-f185-7c23-8f2a-e045a279cd27); without it nothing is marked.
		 */
		memberIds?: () => Promise<ReadonlySet<string>>
	},
): WorkspaceApplicationSession {
	const viewAuthoring = createViewAuthoringService(persistence)
	const workspaceAuthoring = createWorkspaceAuthoringService(persistence)
	const localeAuthoring = createLocaleAuthoringService(persistence)
	const flowAuthoring = createFlowAuthoringService(persistence)
	// Where Adapter provenance comes from (Rules 01a167bf-1f93-… and 01a167d8-acd9-…).
	const adapterProvenanceSource: AdapterProvenanceSource = {
		...options?.adapterResolution,
		...(options?.kitBuild ? { kitBuild: () => options.kitBuild!.status() } : {}),
	}
	const reviewAuthoring = createReviewAuthoringService(persistence, { adapterProvenance: adapterProvenanceSource })
	// A View's diagnostics include those of its `$asset` bindings (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c).
	const viewAssetBindings = createViewAssetBindingCheck(persistence, adapterProvenanceSource)
	const assetAuthoring = createAssetAuthoringService(persistence)
	const formalCapture = createFormalCaptureService(persistence, {
		serverOrigin: options?.serverOrigin,
		captureCookie: options?.captureCookie,
		...(options?.kitBuild ? { kitBuild: () => options.kitBuild!.status() } : {}),
		...(options?.adapterThemeSupport ? { themeSupport: options.adapterThemeSupport } : {}),
		adapterProvenance: adapterProvenanceSource,
	})
	const flowEvidence = createFlowEvidenceService(persistence, {
		readFlow: async (flowId) => {
			const read = await readPointResource('flow', flowId)
			return read?.kind === 'flow' ? read : undefined
		},
		captureFormal: command => formalCapture.capture(command),
		replay: command => formalCapture.replay(command),
	})
	const interactionEvidence = createInteractionEvidenceService(persistence, {
		captureFormal: command => formalCapture.capture(command),
		replay: command => formalCapture.replay(command),
	})
	const checksRunEvidence = createChecksRunEvidenceService(persistence)
	const handoffExport = createHandoffExportService(persistence, {
		...(options?.checkAdapterSet ? { checkAdapterSet: options.checkAdapterSet } : {}),
		adapterProvenance: adapterProvenanceSource,
	})
	const historyDiff = createHistoryDiffService(persistence, options?.history)
	const historyService = createHistoryService(persistence, options?.history, { ...(options?.historyBoundary ? { boundary: options.historyBoundary } : {}), adapterProvenance: adapterProvenanceSource })
	const historyRestore = createHistoryRestoreService(persistence, options?.history, { adapterProvenance: adapterProvenanceSource })
	const historyPreview = createHistoryPreviewService(persistence, options?.history)
	const productKitAuthoring = createProductKitAuthoringService(persistence, options?.kitBuild ? { buildStatus: () => options.kitBuild!.status() } : {})
	const accessPresetsAuthoring = createAccessPresetsAuthoringService(persistence)
	const kitBuild = createKitBuildService(options?.kitBuild)
	const kitSource = createKitSourceService(persistence)
	const productKitChecks = createProductKitChecksService(persistence, {
		readProductKit: productKitAuthoring.readProductKit,
		serverOrigin: options?.serverOrigin,
		captureCookie: options?.captureCookie,
		...(options?.kitBuild ? { kitBuild: () => options.kitBuild!.status() } : {}),
		...(options?.adapterThemeSupport ? { themeSupport: options.adapterThemeSupport } : {}),
	})

	// Best effort: an unreadable roster leaves the actors unflagged; it never fails a Review read.
	const rosterOnce = async (): Promise<ReadonlySet<string> | undefined> => {
		try { return await options?.memberIds?.() }
		catch { return undefined }
	}

	async function readPointResource(kind: PointResourceKind, key: string, roster?: () => Promise<ReadonlySet<string> | undefined>, assetCatalog?: () => Promise<AssetCatalog>, viewTarget?: (viewId: string) => Promise<ReviewAnchorTarget>): Promise<PointResourceRead | undefined> {
		if (!isValidPointResourceAddress({ kind, key })) return undefined
		switch (kind) {
			case 'workspace': {
				if (key !== 'workspace') return undefined
				const read = await persistence.workspace.readInspected()
				if (!read.resource || !read.revision) return undefined
				return { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics, inspection: read.inspection }
			}
			case 'view': {
				const read = await persistence.views.readInspected(key)
				if (!read) return undefined
				const bindingDiagnostics = await viewAssetBindings.check(read.resource?.ir, assetCatalog)
				return { kind, key, resource: read.resource, revision: read.revision, diagnostics: bindingDiagnostics.length > 0 ? [...read.diagnostics, ...bindingDiagnostics] : read.diagnostics }
			}
			case 'flow': {
				const read = await persistence.flows.readInspected(key)
				if (!read) return undefined
				// Rule 01a11544-629c-7dbf-8e41-36c8e37537b3: invalid View, Variant and Widget references, kept as authored.
				const referenceDiagnostics = await flowReferenceDiagnostics(read.resource, viewTarget ?? readAnchorTarget)
				return { kind, key, resource: read.resource, revision: read.revision, diagnostics: referenceDiagnostics.length > 0 ? [...read.diagnostics, ...referenceDiagnostics] : read.diagnostics }
			}
			case 'locale': {
				const read = await persistence.locales.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'review': {
				const read = await persistence.reviews.readInspected(key)
				const ids = read && await (roster ?? rosterOnce)()
				return read && { kind, key, resource: ids ? markRemovedActors(read.resource, ids) : read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'asset': {
				const read = await persistence.assets.readInspected(key)
				if (!read) return undefined
				const digest = await sha256Identity(read.resource.content)
				const descriptor: AssetContentDescriptor = {
					mediaType: read.resource.metadata?.mediaType ?? 'application/octet-stream',
					size: read.resource.content.byteLength,
					digest,
					contentUrl: `/api/assets/${encodeURIComponent(key)}/content`,
				}
				return {
					kind,
					key,
					resource: {
						metadata: read.resource.metadata,
						content: descriptor,
					},
					metadata: read.resource.metadata,
					content: descriptor,
					revision: read.revision,
					diagnostics: read.diagnostics,
				}
			}
		}
	}

	/**
	 * Clause 01a172cc-de18-79ea-a611-c8ea5a34e250. A Flow file that is not valid JSON is reported with its
	 * parse diagnostics, as the discovery listing reports it, rather than thrown.
	 */
	async function validateFlow(flowId: string): Promise<ValidateFlowResult> {
		let read: Awaited<ReturnType<typeof readPointResource>>
		try { read = await readPointResource('flow', flowId) }
		catch (error) {
			if (!(error instanceof PersistenceError) || error.code !== 'persistence.invalid_json') throw error
			const revision = await persistence.flows.readRevision(flowId)
			if (!revision) return { status: 'not_found', flowId }
			return { flowId, revision, valid: false, diagnostics: error.diagnostics.length > 0 ? error.diagnostics : [{ code: error.code, path: '', message: error.message }] }
		}
		if (read?.kind !== 'flow') return { status: 'not_found', flowId }
		return { flowId, revision: read.revision, valid: read.diagnostics.length === 0, diagnostics: read.diagnostics }
	}

	async function discover(input: unknown, mode: 'list' | 'search'): Promise<ResourceDiscoveryOutcome> {
		const validation = validateResourceDiscoveryRequest(input, mode)
		if (validation.status === 'invalid') return validation
		const request = normalizeDiscoveryRequest(validation.request, mode)
		const scope = discoveryScope(request)
		const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, scope)
		if (request.cursor !== undefined && after === undefined)
			return { status: 'invalid', diagnostics: [{ code: 'discovery.invalid_cursor', path: '/cursor', message: 'Discovery cursor is invalid or belongs to a different query scope.' }] }

		// One roster read per request.
		let roster: Promise<ReadonlySet<string> | undefined> | undefined
		const requestRoster = () => roster ??= rosterOnce()
		const items: ResourceDiscoveryItem[] = []
		// Clause 01a166bd-ef89-7bdc-96a9-6eb86451932a: only `expanded` adds `detail`; the default result is unchanged.
		const expanded = request.detail === 'expanded'
		let defaultLocale: Promise<string | undefined> | undefined
		const requestDefaultLocale = () => defaultLocale ??= readDefaultLocale()
		// One Catalog read serves every View the listing checks (Rule 01a167f4-472f-7ae9-8ebb-3075216ad94c).
		let assetCatalog: Promise<AssetCatalog> | undefined
		const requestAssetCatalog = () => assetCatalog ??= viewAssetBindings.catalog()
		const anchorTargets = new Map<string, Promise<ReviewAnchorTarget>>()
		const anchorTarget = (viewId: string): Promise<ReviewAnchorTarget> => {
			let target = anchorTargets.get(viewId)
			if (!target) anchorTargets.set(viewId, target = readAnchorTarget(viewId))
			return target
		}
		for (const kind of request.kinds ?? DISCOVERABLE_RESOURCE_KINDS) {
			for (const key of await discoverKeys(kind)) {
				let item: ResourceDiscoveryItem | undefined
				let thread: ReviewThread | undefined
				let read: Exclude<PointResourceRead, { kind: 'workspace' }> | undefined
				try {
					const pointRead = await readPointResource(kind, key, requestRoster, requestAssetCatalog, anchorTarget)
					if (!pointRead || pointRead.kind === 'workspace') continue
					item = summarize(pointRead)
					read = pointRead
					if (pointRead.kind === 'review') thread = pointRead.resource
				}
				catch (error) {
					read = undefined
					item = await summarizeUnreadable(kind, key, error)
					if (!item) continue
				}
				// Expansion never costs an item its summary: it fails on its own, to an empty `detail`.
				if (expanded) item = { ...item, detail: read ? await expandedDetail(read, requestDefaultLocale).catch(() => ({})) : {} } as ResourceDiscoveryItem
				if (request.query !== undefined && !matchesQuery(item, request.query)) continue
				if (!await matchesReviewFilters(item, thread, request, anchorTarget)) continue
				items.push(item)
			}
		}
		items.sort((left, right) => compareAscii(sortKey(left), sortKey(right)))
		const start = after === undefined ? 0 : firstAfter(items, after)
		const pageItems = items.slice(start, start + request.limit)
		const end = start + pageItems.length
		return {
			status: 'ok',
			page: {
				items: pageItems,
				...(end < items.length && pageItems.length > 0 ? { nextCursor: encodeCursor(sortKey(pageItems.at(-1)!), scope) } : {}),
			},
		}
	}

	/**
	 * The Workspace's default Locale for the expanded Locale `isDefault`. Best effort, like the roster:
	 * unknown, so `isDefault` is left out, whenever the manifest cannot be read.
	 */
	async function readDefaultLocale(): Promise<string | undefined> {
		try {
			const read = await persistence.workspace.readInspected()
			const locale = read.resource?.i18n?.defaultLocale
			return typeof locale === 'string' ? locale : undefined
		}
		catch { return undefined }
	}

	/** The anchored View as the `anchor` filter sees it: `null` when it does not exist. */
	const readAnchorTarget = (viewId: string): Promise<ReviewAnchorTarget> => readViewReferenceTarget(persistence, viewId)

	async function discoverKeys(kind: DiscoverableResourceKind): Promise<readonly string[]> {
		switch (kind) {
			case 'view': return persistence.views.discoverKeys()
			case 'flow': return persistence.flows.discoverKeys()
			case 'locale': return persistence.locales.discover()
			case 'review': return persistence.reviews.discoverKeys()
			case 'asset': return persistence.assets.discoverKeys()
		}
	}

	async function summarizeUnreadable(kind: DiscoverableResourceKind, key: string, error: unknown): Promise<ResourceDiscoveryItem | undefined> {
		if (!(error instanceof PersistenceError) || error.code !== 'persistence.invalid_json') throw error
		const revision = kind === 'view' ? await persistence.views.readRevision(key)
			: kind === 'flow' ? await persistence.flows.readRevision(key)
				: kind === 'locale' ? await persistence.locales.readRevision(key)
					: kind === 'review' ? await persistence.reviews.readRevision(key)
						: await persistence.assets.readRevision(key)
		if (!revision) return undefined
		const diagnosticCount = Math.max(1, error.diagnostics.length)
		if (kind === 'view') return { kind, key, revision, diagnosticCount, summary: {} }
		if (kind === 'flow') return { kind, key, revision, diagnosticCount, summary: {} }
		if (kind === 'locale') return { kind, key, revision, diagnosticCount, summary: {} }
		if (kind === 'review') return { kind, key, revision, diagnosticCount, summary: {} }
		return { kind, key, revision, diagnosticCount, summary: {} }
	}

	return {
		readPointResource,
		listPointResources: input => discover(input, 'list'),
		searchPointResources: input => discover(input, 'search'),
		createView: viewAuthoring.createView,
		updateViewSpec: viewAuthoring.updateViewSpec,
		updateViewStructure: viewAuthoring.updateViewStructure,
		deleteView: viewAuthoring.deleteView,
		updateViewMetadata: viewAuthoring.updateViewMetadata,
		deferDecision: viewAuthoring.deferDecision,
		decideDecision: viewAuthoring.decideDecision,
		reopenDecision: viewAuthoring.reopenDecision,
		updateWorkspaceSettings: workspaceAuthoring.updateWorkspaceSettings,
		readProductKit: productKitAuthoring.readProductKit,
		composeProductKit: productKitAuthoring.composeProductKit,
		updateProductKit: productKitAuthoring.updateProductKit,
		updateComponentRegistry: productKitAuthoring.updateComponentRegistry,
		readAccessPresets: accessPresetsAuthoring.readAccessPresets,
		updateAccessPresets: accessPresetsAuthoring.updateAccessPresets,
		readKitBuild: kitBuild.readKitBuild,
		readKitBuildLog: kitBuild.readKitBuildLog,
		restartKitBuild: kitBuild.restartKitBuild,
		listKitFiles: kitSource.listKitFiles,
		readKitFile: kitSource.readKitFile,
		getComponentSource: kitSource.getComponentSource,
		compareComponentCopies: kitSource.compareComponentCopies,
		createLocale: localeAuthoring.createLocale,
		updateLocale: localeAuthoring.updateLocale,
		createFlow: flowAuthoring.createFlow,
		updateFlow: flowAuthoring.updateFlow,
		deleteFlow: flowAuthoring.deleteFlow,
		createReviewThread: reviewAuthoring.createReviewThread,
		appendReviewMessage: reviewAuthoring.appendReviewMessage,
		reanchorReviewThread: reviewAuthoring.reanchorReviewThread,
		submitReadyForReview: reviewAuthoring.submitReadyForReview,
		resolveReviewThread: reviewAuthoring.resolveReviewThread,
		reopenReviewThread: reviewAuthoring.reopenReviewThread,
		setReviewDisplayHint: reviewAuthoring.setReviewDisplayHint,
		promoteReviewToDecision: reviewAuthoring.promoteReviewToDecision,
		createDecisionFromReview: reviewAuthoring.createDecisionFromReview,
		editReviewMessage: reviewAuthoring.editReviewMessage,
		retractReviewThread: reviewAuthoring.retractReviewThread,
		createAsset: assetAuthoring.createAsset,
		replaceAsset: assetAuthoring.replaceAsset,
		deleteAsset: assetAuthoring.deleteAsset,
		captureFormalEvidence: formalCapture.capture,
		validateFlow,
		captureFlowEvidence: flowEvidence.capture,
		captureInteractionEvidence: interactionEvidence.capture,
		recordChecksRun: checksRunEvidence.record,
		listEvidence: formalCapture.listEvidence,
		viewRenderInputs: formalCapture.viewRenderInputs,
		runProductKitChecks: command => productKitChecks.run({ ...(command?.readSource === false ? { readSource: false } : {}) }),
		productKitProvenance: () => readCurrentProductKitProvenance(persistence),
		adapterProvenance: () => readCurrentAdapterProvenance(persistence, adapterProvenanceSource),
		assessHandoffReadiness: handoffExport.assessReadiness,
		exportHandoff: handoffExport.exportHandoff,
		readArtifact: identity => persistence.artifacts.read(identity),
		diffVersions: historyDiff.diffVersions,
		createCheckpoint: historyService.createCheckpoint,
		deleteCheckpoint: historyService.deleteCheckpoint,
		listVersions: historyService.listVersions,
		readVersion: historyService.readVersion,
		readVersionResource: historyPreview.readVersionResource,
		readVersionBlob: historyPreview.readVersionBlob,
		resolveVersionAssets: historyPreview.resolveVersionAssets,
		restoreResourceVersion: historyRestore.restoreResourceVersion,
	}
}

type NormalizedDiscoveryRequest = Readonly<{
	kinds: readonly DiscoverableResourceKind[]
	query?: string
	resolution?: readonly ReviewResolution[]
	anchorScope?: readonly ReviewAnchorScope[]
	status?: readonly ReviewDiscoveryStatus[]
	viewId?: readonly string[]
	variant?: readonly string[]
	anchor?: readonly ReviewAnchorState[]
	changeDomain?: readonly ChangeDomain[]
	detail?: ResourceDiscoveryRequest['detail']
	cursor?: string
	limit: number
}>

function normalizeDiscoveryRequest(request: ResourceDiscoveryRequest, mode: 'list' | 'search'): NormalizedDiscoveryRequest {
	const selected = request.kinds ?? DISCOVERABLE_RESOURCE_KINDS
	const kinds = DISCOVERABLE_RESOURCE_KINDS.filter(kind => selected.includes(kind))
	return {
		kinds,
		...(mode === 'search' ? { query: request.query!.trim().toLowerCase() } : {}),
		...(request.resolution !== undefined ? { resolution: [...request.resolution].sort() } : {}),
		...(request.anchorScope !== undefined ? { anchorScope: [...request.anchorScope].sort() } : {}),
		...(request.status !== undefined ? { status: [...request.status].sort() } : {}),
		...(request.viewId !== undefined ? { viewId: [...request.viewId].sort() } : {}),
		...(request.variant !== undefined ? { variant: [...request.variant].sort() } : {}),
		...(request.anchor !== undefined ? { anchor: [...request.anchor].sort() } : {}),
		...(request.changeDomain !== undefined ? { changeDomain: [...request.changeDomain].sort() } : {}),
		// Not part of the cursor scope: expansion never changes which items match or their order.
		...(request.detail !== undefined ? { detail: request.detail } : {}),
		...(request.cursor !== undefined ? { cursor: request.cursor } : {}),
		limit: request.limit,
	}
}

function summarize(read: Exclude<PointResourceRead, { kind: 'workspace' }>): ResourceDiscoveryItem {
	switch (read.kind) {
		case 'view':
			return { kind: 'view', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { name: read.resource.name, ...(read.resource.feature ? { feature: read.resource.feature } : {}) } }
		case 'flow':
			return { kind: 'flow', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { name: read.resource.name } }
		case 'locale':
			return { kind: 'locale', key: read.key, revision: read.revision, diagnosticCount: read.diagnostics.length, summary: { messageCount: Object.keys(read.resource).length } }
		case 'review':
			return {
				kind: 'review',
				key: read.key,
				revision: read.revision,
				diagnosticCount: read.diagnostics.length,
				summary: reviewSummary(read.resource),
			}
		case 'asset':
			return {
				kind: 'asset',
				key: read.key,
				revision: read.revision,
				diagnosticCount: read.diagnostics.length,
				summary: {
					name: read.metadata?.name,
					mediaType: read.metadata?.mediaType,
					contentFilename: read.metadata?.contentFilename,
				},
			}
	}
}

/**
 * Compact Review summary. `displayHint` and `renderContext` sit beside `anchor`, never inside it;
 * `variantNames` is the accepted anchor/Variant scope; `resolution` is derived from the final
 * lifecycle event while resolved.
 */
function reviewSummary(thread: ReviewThread): ReviewDiscoverySummary {
	const resolution = deriveReviewResolution(thread)
	return {
		anchor: thread.anchor,
		...(Array.isArray(thread.variantNames) ? { variantNames: thread.variantNames } : {}),
		...(thread.displayHint ? { displayHint: thread.displayHint } : {}),
		...(thread.renderContext ? { renderContext: thread.renderContext } : {}),
		status: thread.status,
		...(resolution ? { resolution } : {}),
		messageCount: Array.isArray(thread.messages) ? thread.messages.length : 0,
		...latestActivity(thread),
		...latestMessageSummary(thread),
		...currentSubmissionSummary(thread),
	}
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/**
 * Clause 01a163a5-719e-789d-a0fb-fc08646ed1d8: the last message, with only the first 200 grapheme clusters of its body.
 * A thread read with diagnostics may hold a last message that is not a record or whose `body` is not a string: the
 * item then goes without `latestMessage` and keeps the rest of its summary (issue #311).
 */
function latestMessageSummary(thread: ReviewThread): Pick<ReviewDiscoverySummary, 'latestMessage'> {
	const message = Array.isArray(thread.messages) ? thread.messages.at(-1) : undefined
	if (typeof message !== 'object' || message === null || typeof message.body !== 'string') return {}
	return { latestMessage: { id: message.id, actor: message.actor, at: message.at, excerpt: graphemeExcerpt(message.body, REVIEW_MESSAGE_EXCERPT_GRAPHEMES), edited: Array.isArray(message.edits) && message.edits.length > 0 } }
}

function graphemeExcerpt(text: string, limit: number): string {
	let end = 0
	let count = 0
	for (const { segment } of graphemes.segment(text)) {
		if (count === limit) break
		end += segment.length
		count += 1
	}
	return text.slice(0, end)
}

/**
 * Clause 01a163a5-719e-789d-a0fb-fc08646ed1d8: the latest submission while the thread is ready for
 * review or resolved, unless a lifecycle event entering `open` appears later in `history` (a reopen).
 */
function currentSubmissionSummary(thread: ReviewThread): Pick<ReviewDiscoverySummary, 'currentSubmission'> {
	const submission = currentSubmission(thread)
	return submission ? { currentSubmission: { id: submission.id, at: submission.at, changeDomains: submission.changeDomains } } : {}
}

function currentSubmission(thread: ReviewThread): ReviewSubmission | undefined {
	if (thread.status !== 'ready-for-review' && thread.status !== 'resolved') return undefined
	const submission = Array.isArray(thread.submissions) ? thread.submissions.at(-1) : undefined
	if (typeof submission !== 'object' || submission === null) return undefined
	// Position, not time: a reopen recorded later in `history` than the submission's lifecycle entry
	// supersedes it even with an equal `at`. Without that entry, any reopen counts.
	const history = Array.isArray(thread.history) ? thread.history : []
	const entry = history.findIndex(event => isRecord(event) && event.kind === 'lifecycle' && event.to === 'ready-for-review' && event.submissionId === submission.id)
	const reopened = history.some((event, index) => index > entry && isRecord(event) && event.kind === 'lifecycle' && event.to === 'open')
	return reopened ? undefined : submission
}

/**
 * The expanded `detail` of a readable item (Clauses 01a166bd-f310-7e84-b1da-892a8b3c3873,
 * 01a166bd-f4d9-7427-9b9a-881b61fe8b18 and 01a166bd-f6ac-71d8-86c1-3494875a3e14): bounded
 * projections only. A resource read with diagnostics may be malformed, so every member is read
 * defensively and left out when its source is not of the expected shape.
 */
async function expandedDetail(read: Exclude<PointResourceRead, { kind: 'workspace' }>, defaultLocale: () => Promise<string | undefined>): Promise<NonNullable<ResourceDiscoveryItem['detail']>> {
	switch (read.kind) {
		case 'view': return viewDetail(read.resource)
		case 'flow': return flowDetail(read.resource)
		case 'locale': {
			const locale = await defaultLocale()
			return locale === undefined ? {} : { isDefault: read.key === locale }
		}
		case 'review': return reviewDetail(read.resource)
		case 'asset': return { byteSize: read.content.size, digest: read.content.digest }
	}
}

const SPEC_LISTS = ['entryConditions', 'interactionRules', 'constraints', 'accessibility', 'references'] as const
/** Every Decision status; the `Record` makes adding a status to `DecisionStatus` a type error here. */
const DECISION_STATUSES = Object.keys({ pending: true, deferred: true, decided: true } satisfies Record<DecisionStatus, true>) as DecisionStatus[]

function viewDetail(view: ViewResource): ViewDiscoveryDetail {
	const variants = view.variants
	const spec = isRecord(view.spec) ? view.spec : undefined
	const decisions = Array.isArray(spec?.decisions) ? spec.decisions : undefined
	return {
		...(isRecord(variants) ? { variantNames: Object.keys(variants) } : {}),
		...(typeof spec?.intent === 'string' ? { intentExcerpt: graphemeExcerpt(spec.intent, DISCOVERY_DETAIL_EXCERPT_GRAPHEMES) } : {}),
		...(spec && SPEC_LISTS.every(list => Array.isArray(spec[list]))
			? { specCounts: Object.fromEntries(SPEC_LISTS.map(list => [list, (spec[list] as readonly unknown[]).length])) as NonNullable<ViewDiscoveryDetail['specCounts']> }
			: {}),
		...(decisions
			? { decisionCounts: Object.fromEntries(DECISION_STATUSES.map(status => [status, decisions.filter(decision => decision?.status === status).length])) as NonNullable<ViewDiscoveryDetail['decisionCounts']> }
			: {}),
	}
}

function flowDetail(flow: FlowResource): NonNullable<Extract<ResourceDiscoveryItem, { kind: 'flow' }>['detail']> {
	const steps = isRecord(flow.steps) ? Object.values(flow.steps) : undefined
	const viewIds: string[] = []
	let transitionCount = 0
	for (const step of steps ?? []) {
		const viewId = isRecord(step) && isRecord(step.target) ? step.target.viewId : undefined
		if (typeof viewId === 'string' && !viewIds.includes(viewId)) viewIds.push(viewId)
		if (isRecord(step) && Array.isArray(step.transitions)) transitionCount += step.transitions.length
	}
	return {
		...(typeof flow.entryStepId === 'string' ? { entryStepId: flow.entryStepId } : {}),
		...(steps ? { stepCount: steps.length, transitionCount, viewIds } : {}),
	}
}

function reviewDetail(thread: ReviewThread): ReviewDiscoveryDetail {
	const messages = Array.isArray(thread.messages) ? thread.messages : []
	const submissions = Array.isArray(thread.submissions) ? thread.submissions : []
	const history = Array.isArray(thread.history) ? thread.history : []
	const first = messages[0]
	const evidenceRefs = evidenceRefsOf(currentSubmission(thread))
	return {
		submissionCount: submissions.length,
		historyCount: history.length,
		participants: distinctActors([...messages, ...submissions, ...history].map(entry => entry?.actor)),
		...(typeof first?.body === 'string' ? { firstMessageExcerpt: graphemeExcerpt(first.body, DISCOVERY_DETAIL_EXCERPT_GRAPHEMES) } : {}),
		...(evidenceRefs ? { evidenceRefs } : {}),
	}
}

/** The submission's evidence refs as `{ kind, evidence }` only, without any entry of another shape. */
function evidenceRefsOf(submission: ReviewSubmission | undefined): ReviewEvidenceRef[] | undefined {
	if (!Array.isArray(submission?.evidenceRefs)) return undefined
	return submission.evidenceRefs.flatMap((ref: unknown) => isRecord(ref) && typeof ref.kind === 'string' && typeof ref.evidence === 'string'
		? [{ kind: ref.kind, evidence: ref.evidence }]
		: [])
}

/**
 * Distinct actors in the order messages, submissions and history list them. An actor is the same
 * when its `type` and `id` match, or, without an `id`, its `type` and `displayName`.
 */
function distinctActors(actors: readonly (ReviewActor | undefined)[]): ReviewActor[] {
	const seen = new Set<string>()
	const distinct: ReviewActor[] = []
	for (const actor of actors) {
		if (!isRecord(actor) || typeof actor.type !== 'string') continue
		const identity = JSON.stringify(actor.id === undefined ? [actor.type, null, actor.displayName ?? null] : [actor.type, actor.id])
		if (seen.has(identity)) continue
		seen.add(identity)
		distinct.push(actor)
	}
	return distinct
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Latest canonical activity (Part 7 9b): the newest message, message edit, submission or history
 * timestamp. An edit is activity (R12): it can change meaning, so it moves the thread up.
 */
function latestActivity(thread: ReviewThread): { latestActivityAt?: string } {
	let latest: string | undefined
	let latestMs = Number.NEGATIVE_INFINITY
	const messages = Array.isArray(thread.messages) ? thread.messages : []
	const edits = messages.flatMap(message => Array.isArray(message?.edits) ? message.edits : [])
	const submissions = Array.isArray(thread.submissions) ? thread.submissions : []
	const history = Array.isArray(thread.history) ? thread.history : []
	for (const entry of [...messages, ...edits, ...submissions, ...history]) {
		if (!isRecord(entry) || typeof entry.at !== 'string') continue
		const ms = Date.parse(entry.at)
		if (Number.isFinite(ms) && ms > latestMs) {
			latestMs = ms
			latest = entry.at
		}
	}
	return latest ? { latestActivityAt: latest } : {}
}

/**
 * The Review filters (Clauses 01a11544-6d38-7c63-958a-e0133b131fd3 and 01a163a5-7110-79e8-94ac-887c8eddde6a):
 * each matches one listed value, every given filter must match, and any of them excludes other kinds
 * and unreadable threads.
 */
async function matchesReviewFilters(
	item: ResourceDiscoveryItem,
	thread: ReviewThread | undefined,
	request: NormalizedDiscoveryRequest,
	anchorTarget: (viewId: string) => Promise<ReviewAnchorTarget>,
): Promise<boolean> {
	if (request.resolution !== undefined && !matchesResolution(item, request.resolution)) return false
	if (request.anchorScope !== undefined && !matchesAnchorScope(item, request.anchorScope)) return false
	const filtered = request.status ?? request.viewId ?? request.variant ?? request.anchor ?? request.changeDomain
	if (filtered === undefined) return true
	if (item.kind !== 'review' || !thread || !item.summary.anchor || !item.summary.status) return false
	const { anchor, status, resolution } = item.summary
	const variantNames = item.summary.variantNames ?? []
	if (request.status !== undefined) {
		const listed: ReviewDiscoveryStatus = status === 'resolved' && resolution && REVIEW_DISMISSAL_RESOLUTIONS.includes(resolution) ? 'dismissed' : status
		if (!request.status.includes(listed)) return false
	}
	if (request.viewId !== undefined && !request.viewId.includes(isWorkspaceAnchor(anchor) ? REVIEW_WORKSPACE_VIEW_TOKEN : anchor.viewId)) return false
	if (request.variant !== undefined) {
		// A Workspace thread has no Variant scope, so a variant filter never matches it.
		if (isWorkspaceAnchor(anchor)) return false
		const scopes = variantNames.length ? variantNames : [REVIEW_VIEW_WIDE_VARIANT]
		if (!scopes.some(scope => request.variant!.includes(scope))) return false
	}
	if (request.changeDomain !== undefined) {
		const domains = (Array.isArray(thread.submissions) ? thread.submissions : []).flatMap(submission => isRecord(submission) && Array.isArray(submission.changeDomains) ? submission.changeDomains : [])
		if (!domains.some(domain => (request.changeDomain as readonly string[]).includes(domain))) return false
	}
	if (request.anchor !== undefined) {
		const state = reviewAnchorState(anchor, variantNames, isWidgetAnchor(anchor) ? await anchorTarget(anchor.viewId) : {})
		if (!request.anchor.includes(state)) return false
	}
	return true
}

/** An anchorScope filter selects Review threads by anchor arm: `workspace` or `view` (any Widget anchor). */
function matchesAnchorScope(item: ResourceDiscoveryItem, scopes: readonly ReviewAnchorScope[]): boolean {
	if (item.kind !== 'review' || !item.summary.anchor) return false
	return scopes.includes(isWorkspaceAnchor(item.summary.anchor) ? 'workspace' : 'view')
}

/** A resolution filter selects only resolved Review threads whose derived resolution is listed. */
function matchesResolution(item: ResourceDiscoveryItem, resolutions: readonly ReviewResolution[]): boolean {
	return item.kind === 'review' && item.summary.resolution !== undefined && resolutions.includes(item.summary.resolution)
}

function matchesQuery(item: ResourceDiscoveryItem, query: string): boolean {
	const fields = item.kind === 'view'
		? [item.key, item.summary.name, item.summary.feature]
		: item.kind === 'flow'
			? [item.key, item.summary.name]
			: item.kind === 'locale'
				? [item.key]
				: item.kind === 'review'
					? [item.key, ...reviewAnchorTerms(item.summary.anchor), item.summary.status]
					: [item.key, item.summary.name, item.summary.mediaType, item.summary.contentFilename]
	return fields.some(value => typeof value === 'string' && value.toLowerCase().includes(query))
}

/** Searchable anchor terms: the View and Widget ids, or `workspace` for a Workspace thread. */
function reviewAnchorTerms(anchor: Extract<ResourceDiscoveryItem, { kind: 'review' }>['summary']['anchor']): (string | undefined)[] {
	if (!isRecord(anchor)) return []
	return isWorkspaceAnchor(anchor) ? ['workspace'] : [anchor.viewId, anchor.widgetId]
}

function sortKey(item: ResourceDiscoveryItem): string {
	return `${String(DISCOVERABLE_RESOURCE_KINDS.indexOf(item.kind)).padStart(2, '0')}:${item.key}`
}

function discoveryScope(request: NormalizedDiscoveryRequest): string {
	return JSON.stringify({
		kinds: request.kinds,
		query: request.query ?? null,
		...(request.resolution ? { resolution: request.resolution } : {}),
		...(request.anchorScope ? { anchorScope: request.anchorScope } : {}),
		...(request.status ? { status: request.status } : {}),
		...(request.viewId ? { viewId: request.viewId } : {}),
		...(request.variant ? { variant: request.variant } : {}),
		...(request.anchor ? { anchor: request.anchor } : {}),
		...(request.changeDomain ? { changeDomain: request.changeDomain } : {}),
	})
}

function encodeCursor(after: string, scope: string): string {
	return Buffer.from(JSON.stringify({ v: 1, after, scope }), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string, scope: string): string | undefined {
	if (!/^[A-Za-z0-9_-]+$/u.test(cursor)) return undefined
	try {
		const decoded = Buffer.from(cursor, 'base64url')
		if (decoded.toString('base64url') !== cursor) return undefined
		const value = JSON.parse(decoded.toString('utf8')) as unknown
		if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
		const record = value as Record<string, unknown>
		if (record.v !== 1 || typeof record.after !== 'string' || record.scope !== scope || Object.keys(record).sort().join(',') !== 'after,scope,v') return undefined
		return record.after
	}
	catch { return undefined }
}

function firstAfter(items: readonly ResourceDiscoveryItem[], after: string): number {
	const index = items.findIndex(item => compareAscii(sortKey(item), after) > 0)
	return index < 0 ? items.length : index
}

function compareAscii(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
