import { sha256Identity } from '../../domain/artifacts/schema'
import type { AuthoredAsset } from '../../domain/assets/schema'
import type { FlowResource } from '../../domain/flows/schema'
import type { I18nResource } from '../../domain/i18n/schema'
import { deriveReviewResolution, type ReviewResolution, type ReviewThread } from '../../domain/reviews/schema'
import type { Diagnostic } from '../../domain/validation'
import type { ViewResource } from '../../domain/views/schema'
import type { WorkspaceManifest } from '../../domain/workspace/schema'
import type { FileNativePersistence, WorkspaceInspection } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import {
	DISCOVERABLE_RESOURCE_KINDS,
	validateResourceDiscoveryRequest,
	type DiscoverableResourceKind,
	type ResourceDiscoveryItem,
	type ResourceDiscoveryOutcome,
	type ResourceDiscoveryRequest,
} from '../dto/resource-discovery'
import type { ResourceRevision } from '../dto/revisions'
import { isValidPointResourceAddress, type PointResourceKind } from '../dto/point-resources'
import {
	createViewAuthoringService,
	type CreateViewCommand,
	type UpdateViewSpecCommand,
	type UpdateViewStructureCommand,
	type ViewAuthoringResult,
} from './view-authoring'
import {
	createWorkspaceAuthoringService,
	type UpdateWorkspaceSettingsCommand,
	type WorkspaceAuthoringResult,
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
	type FlowAuthoringResult,
	type UpdateFlowCommand,
} from './flow-authoring'
import {
	createReviewAuthoringService,
	type AppendReviewMessageCommand,
	type CreateReviewThreadCommand,
	type PromoteReviewToDecisionCommand,
	type ReanchorReviewThreadCommand,
	type ReopenReviewThreadCommand,
	type ResolveReviewThreadCommand,
	type ReviewAuthoringResult,
	type SetReviewDisplayHintCommand,
	type SubmitReadyForReviewCommand,
} from './review-authoring'
import {
	createAssetAuthoringService,
	type AssetAuthoringResult,
	type CreateAssetCommand,
	type ReplaceAssetCommand,
} from './asset-authoring'
import {
	createFormalCaptureService,
	type CaptureFormalEvidenceCommand,
	type CaptureFormalEvidenceResult,
	type FormalEvidenceItem,
} from './formal-capture'
import {
	createHandoffExportService,
	type AssessHandoffReadinessCommand,
	type AssessHandoffReadinessResult,
	type ExportHandoffCommand,
	type ExportHandoffResult,
} from './handoff-export'

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

export interface WorkspaceApplicationSession {
	readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined>
	listPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	searchPointResources(input: unknown): Promise<ResourceDiscoveryOutcome>
	createView(command: CreateViewCommand): Promise<ViewAuthoringResult>
	updateViewSpec(command: UpdateViewSpecCommand): Promise<ViewAuthoringResult>
	updateViewStructure(command: UpdateViewStructureCommand): Promise<ViewAuthoringResult>
	updateWorkspaceSettings(command: UpdateWorkspaceSettingsCommand): Promise<WorkspaceAuthoringResult>
	createLocale(command: CreateLocaleCommand): Promise<LocaleAuthoringResult>
	updateLocale(command: UpdateLocaleCommand): Promise<LocaleAuthoringResult>
	createFlow(command: CreateFlowCommand): Promise<FlowAuthoringResult>
	updateFlow(command: UpdateFlowCommand): Promise<FlowAuthoringResult>
	createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult>
	appendReviewMessage(command: AppendReviewMessageCommand): Promise<ReviewAuthoringResult>
	reanchorReviewThread(command: ReanchorReviewThreadCommand): Promise<ReviewAuthoringResult>
	submitReadyForReview(command: SubmitReadyForReviewCommand): Promise<ReviewAuthoringResult>
	resolveReviewThread(command: ResolveReviewThreadCommand): Promise<ReviewAuthoringResult>
	reopenReviewThread(command: ReopenReviewThreadCommand): Promise<ReviewAuthoringResult>
	setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<ReviewAuthoringResult>
	promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult>
	createAsset(command: CreateAssetCommand): Promise<AssetAuthoringResult>
	replaceAsset(command: ReplaceAssetCommand): Promise<AssetAuthoringResult>
	captureFormalEvidence(command: CaptureFormalEvidenceCommand): Promise<CaptureFormalEvidenceResult>
	listEvidence(viewId?: string): Promise<readonly FormalEvidenceItem[]>
	assessHandoffReadiness(command: AssessHandoffReadinessCommand): Promise<AssessHandoffReadinessResult>
	exportHandoff(command: ExportHandoffCommand): Promise<ExportHandoffResult>
	readArtifact(identity: string): Promise<Uint8Array | undefined>
}

/**
 * Application-facing selected-Workspace facade shared by HTTP/MCP/Workbench.
 * Transports never reach into FileNativePersistence directly.
 */
export function createWorkspaceApplicationSession(
	persistence: FileNativePersistence,
	options?: { serverOrigin?: string; captureCookie?: () => Readonly<{ name: string; value: string }> | undefined },
): WorkspaceApplicationSession {
	const viewAuthoring = createViewAuthoringService(persistence)
	const workspaceAuthoring = createWorkspaceAuthoringService(persistence)
	const localeAuthoring = createLocaleAuthoringService(persistence)
	const flowAuthoring = createFlowAuthoringService(persistence)
	const reviewAuthoring = createReviewAuthoringService(persistence)
	const assetAuthoring = createAssetAuthoringService(persistence)
	const formalCapture = createFormalCaptureService(persistence, { serverOrigin: options?.serverOrigin, captureCookie: options?.captureCookie })
	const handoffExport = createHandoffExportService(persistence)

	async function readPointResource(kind: PointResourceKind, key: string): Promise<PointResourceRead | undefined> {
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
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'flow': {
				const read = await persistence.flows.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'locale': {
				const read = await persistence.locales.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
			}
			case 'review': {
				const read = await persistence.reviews.readInspected(key)
				return read && { kind, key, resource: read.resource, revision: read.revision, diagnostics: read.diagnostics }
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

	async function discover(input: unknown, mode: 'list' | 'search'): Promise<ResourceDiscoveryOutcome> {
		const validation = validateResourceDiscoveryRequest(input, mode)
		if (validation.status === 'invalid') return validation
		const request = normalizeDiscoveryRequest(validation.request, mode)
		const scope = discoveryScope(request)
		const after = request.cursor === undefined ? undefined : decodeCursor(request.cursor, scope)
		if (request.cursor !== undefined && after === undefined)
			return { status: 'invalid', diagnostics: [{ code: 'discovery.invalid_cursor', path: '/cursor', message: 'Discovery cursor is invalid or belongs to a different query scope.' }] }

		const items: ResourceDiscoveryItem[] = []
		for (const kind of request.kinds ?? DISCOVERABLE_RESOURCE_KINDS) {
			for (const key of await discoverKeys(kind)) {
				let item: ResourceDiscoveryItem | undefined
				try {
					const read = await readPointResource(kind, key)
					if (!read || read.kind === 'workspace') continue
					item = summarize(read)
				}
				catch (error) {
					item = await summarizeUnreadable(kind, key, error)
					if (!item) continue
				}
				if (request.query !== undefined && !matchesQuery(item, request.query)) continue
				if (request.resolution !== undefined && !matchesResolution(item, request.resolution)) continue
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
		updateWorkspaceSettings: workspaceAuthoring.updateWorkspaceSettings,
		createLocale: localeAuthoring.createLocale,
		updateLocale: localeAuthoring.updateLocale,
		createFlow: flowAuthoring.createFlow,
		updateFlow: flowAuthoring.updateFlow,
		createReviewThread: reviewAuthoring.createReviewThread,
		appendReviewMessage: reviewAuthoring.appendReviewMessage,
		reanchorReviewThread: reviewAuthoring.reanchorReviewThread,
		submitReadyForReview: reviewAuthoring.submitReadyForReview,
		resolveReviewThread: reviewAuthoring.resolveReviewThread,
		reopenReviewThread: reviewAuthoring.reopenReviewThread,
		setReviewDisplayHint: reviewAuthoring.setReviewDisplayHint,
		promoteReviewToDecision: reviewAuthoring.promoteReviewToDecision,
		createAsset: assetAuthoring.createAsset,
		replaceAsset: assetAuthoring.replaceAsset,
		captureFormalEvidence: formalCapture.capture,
		listEvidence: formalCapture.listEvidence,
		assessHandoffReadiness: handoffExport.assessReadiness,
		exportHandoff: handoffExport.exportHandoff,
		readArtifact: identity => persistence.artifacts.read(identity),
	}
}

type NormalizedDiscoveryRequest = Readonly<{
	kinds: readonly DiscoverableResourceKind[]
	query?: string
	resolution?: readonly ReviewResolution[]
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
 * Compact Review summary. `displayHint` sits beside `anchor`, never inside it; `variantNames` is the
 * accepted anchor/Variant scope; `resolution` is derived from the final lifecycle event while resolved.
 */
function reviewSummary(thread: ReviewThread): Extract<ResourceDiscoveryItem, { kind: 'review' }>['summary'] {
	const resolution = deriveReviewResolution(thread)
	return {
		anchor: thread.anchor,
		...(Array.isArray(thread.variantNames) ? { variantNames: thread.variantNames } : {}),
		...(thread.displayHint ? { displayHint: thread.displayHint } : {}),
		status: thread.status,
		...(resolution ? { resolution } : {}),
		messageCount: thread.messages?.length ?? 0,
	}
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
					? [item.key, item.summary.anchor?.viewId, item.summary.anchor?.widgetId, item.summary.status]
					: [item.key, item.summary.name, item.summary.mediaType, item.summary.contentFilename]
	return fields.some(value => value?.toLowerCase().includes(query))
}

function sortKey(item: ResourceDiscoveryItem): string {
	return `${String(DISCOVERABLE_RESOURCE_KINDS.indexOf(item.kind)).padStart(2, '0')}:${item.key}`
}

function discoveryScope(request: NormalizedDiscoveryRequest): string {
	return JSON.stringify({ kinds: request.kinds, query: request.query ?? null, ...(request.resolution ? { resolution: request.resolution } : {}) })
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
