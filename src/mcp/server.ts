import { randomUUID } from 'node:crypto'

import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type AuthInfo, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server'
import packageJson from '../../package.json' with { type: 'json' }
import { z } from 'zod'

import { DISCOVERABLE_RESOURCE_KINDS, MAX_RESOURCE_DISCOVERY_LIMIT } from '../application/dto/resource-discovery'
import type { PointResourceKind } from '../application/dto/point-resources'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import { LOCKABLE_KINDS, MAX_ACQUIRE_RESOURCES, type LeaseManager } from '../application/access/leases'
import { principalRole, type Principal } from '../application/access/principal'
import { roleLabel } from '../application/access/policy'
import { createScopedWorkspaceSession, type ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { ViewSpecContent } from '../application/services/view-authoring'
import type { ViewResource } from '../domain/views/schema'
import type { FlowStep } from '../domain/flows/schema'
import { REVIEW_RESOLUTIONS, type ReviewAnchor, type ReviewDisplayHint, type ReviewEvidenceRef, type ReviewResourceRevision } from '../domain/reviews/schema'
import type { WorkspaceAdapterSelection, ThemeEntry, ViewportPreset } from '../domain/workspace/schema'
import { isSha256Digest, type JsonObject } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { HandoffRoot } from '../domain/handoff/schema'
import { isPersistenceBusyError, persistenceBusyResult } from '../persistence/busy'
import { parsePointResourceUri, pointResourceUri } from './resource-uri'

const dynamicKinds = ['view', 'flow', 'locale', 'review', 'asset'] as const satisfies readonly PointResourceKind[]
const discoveryKindsSchema = z.array(z.enum(DISCOVERABLE_RESOURCE_KINDS)).optional()
const discoveryBaseShape = {
	kinds: discoveryKindsSchema,
	resolution: z.array(z.enum(REVIEW_RESOLUTIONS)).min(1).optional(),
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(MAX_RESOURCE_DISCOVERY_LIMIT),
}
const listResourcesSchema = z.object(discoveryBaseShape).strict()
const searchResourcesSchema = z.object({ ...discoveryBaseShape, query: z.string().min(1) }).strict()

const viewSpecContentSchema = z.object({
	intent: z.string(),
	entryConditions: z.array(z.string()),
	interactionRules: z.array(z.string()),
	constraints: z.array(z.string()),
	accessibility: z.array(z.string()),
	references: z.array(z.unknown()),
}).strict()

const createViewSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	feature: z.string().optional(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewSpecSchema = z.object({
	viewId: z.string(),
	expectedRevision: z.string(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewStructureSchema = z.object({
	viewId: z.string(),
	expectedRevision: z.string(),
	ir: z.record(z.string(), z.unknown()),
	variants: z.record(z.string(), z.unknown()),
}).strict()

const updateWorkspaceSettingsSchema = z.object({
	expectedRevision: z.string(),
	settings: z.object({
		i18n: z.object({
			defaultLocale: z.string(),
		}).catchall(z.unknown()),
		adapters: z.array(z.object({
			moduleSpecifier: z.string(),
			config: z.unknown().optional(),
		})),
		viewports: z.record(z.string(), z.object({
			dimensions: z.object({
				width: z.number(),
				height: z.number(),
			}).catchall(z.unknown()),
		}).catchall(z.unknown())),
		themes: z.record(z.string(), z.record(z.string(), z.unknown())),
	}).strict(),
}).strict()

const createLocaleSchema = z.object({
	locale: z.string(),
	messages: z.record(z.string(), z.string()),
}).strict()

const updateLocaleSchema = z.object({
	locale: z.string(),
	expectedRevision: z.string(),
	messages: z.record(z.string(), z.string()),
}).strict()

const flowStepSchema = z.object({
	target: z.object({
		viewId: z.string(),
		variantName: z.string().optional(),
	}).strict(),
	transitions: z.array(z.object({
		trigger: z.object({
			widgetId: z.string(),
			event: z.string(),
		}).strict(),
		targetStepId: z.string(),
	}).strict()),
}).strict()

const createFlowSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

const updateFlowSchema = z.object({
	flowId: z.string(),
	expectedRevision: z.string(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

const reviewAnchorSchema = z.object({
	viewId: z.string(),
	widgetId: z.string(),
}).strict()

const ACTOR_IGNORED_DESCRIPTION = 'Optional and ignored: the server stamps the actor from the authenticated member (a differing value yields the warning auth.actor_ignored).'

const reviewActorSchema = z.object({
	type: z.string(),
	id: z.string().optional(),
	displayName: z.string().optional(),
}).strict()

// Non-authoritative pin placement, beside (never inside) the strict anchor. Services clamp to 0..1
// and quantize to 1e-4 before persisting.
const reviewDisplayHintSchema = z.object({
	pin: z.object({ x: z.number(), y: z.number() }).strict(),
}).strict()

const reviewResolutionSchema = z.enum(REVIEW_RESOLUTIONS)

const createReviewThreadSchema = z.object({
	id: z.string().optional(),
	anchor: reviewAnchorSchema,
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.optional(),
}).strict()

const appendReviewMessageSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	body: z.string(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const reanchorReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	anchor: reviewAnchorSchema,
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.nullable().optional(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const setReviewDisplayHintSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	displayHint: reviewDisplayHintSchema.nullable(),
}).strict()

const submitReadyForReviewSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	changeDomains: z.array(z.string()),
	resources: z.array(z.object({
		identity: z.record(z.string(), z.unknown()),
		revision: z.string(),
	}).strict()),
	scope: z.record(z.string(), z.unknown()).optional(),
	evidenceRefs: z.array(z.object({
		kind: z.string(),
		evidence: z.string(),
	}).strict()),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
	submissionId: z.string().optional(),
}).strict()

const resolveReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	resolution: reviewResolutionSchema.optional(),
	submissionId: z.string().optional(),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const reopenReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const promoteReviewToDecisionSchema = z.object({
	reviewId: z.string(),
	expectedReviewRevision: z.string(),
	viewId: z.string(),
	expectedViewRevision: z.string(),
	question: z.string(),
	outcome: z.object({
		summary: z.string(),
		rationale: z.string(),
	}).strict().optional(),
	actor: reviewActorSchema.optional().describe(ACTOR_IGNORED_DESCRIPTION),
	decisionId: z.string().optional(),
}).strict()

const createAssetSchema = z.object({
	id: z.string().optional(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

const replaceAssetSchema = z.object({
	assetId: z.string(),
	expectedRevision: z.string(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

const captureFormalEvidenceSchema = z.object({
	contexts: z.array(z.object({
		viewId: z.string(),
		variantName: z.string().optional(),
		locale: z.string(),
		viewportId: z.string(),
		viewport: z.object({ width: z.number(), height: z.number() }),
		themeId: z.string(),
	})).min(1),
}).strict()

const handoffRootSchema = z.discriminatedUnion('type', [
	z.object({ type: z.literal('workspace') }).strict(),
	z.object({ type: z.literal('view'), viewId: z.string() }).strict(),
	z.object({ type: z.literal('flow'), flowId: z.string() }).strict(),
	z.object({ type: z.literal('asset'), assetId: z.string() }).strict(),
])

const assessHandoffReadinessSchema = z.object({
	roots: z.array(handoffRootSchema).min(1),
}).strict()

const exportHandoffSchema = z.object({
	roots: z.array(handoffRootSchema).min(1),
}).strict()

const leaseResourcesSchema = z.array(z.object({
	kind: z.enum(LOCKABLE_KINDS),
	key: z.string().min(1),
}).strict()).min(1).max(MAX_ACQUIRE_RESOURCES)

const acquireLockSchema = z.object({ resources: leaseResourcesSchema }).strict()
const releaseLockSchema = z.object({ resources: leaseResourcesSchema.optional() }).strict()

export const LEASE_RECIPE = 'Edit leases: your first successful write to a View, Flow, Locale, Asset or the Workspace settings takes a 5-minute lease on it, renewed by each of your writes; other writers get status "locked" (resource.locked) with your nickname and expiry. For a multi-step task, call acquire_lock up front for every resource you will write, call acquire_lock again as a heartbeat before a long pause (a build, a capture), and finish with release_lock and no arguments. Leases never replace expectedRevision: a conflict still means re-read. Review threads are never locked.'

/** Per-request server instructions: the agent learns its identity and role without a new tool (decision 10). */
export function uiuxMcpInstructions(principal: Principal): string {
	const identity = principal.type === 'member'
		? `Authenticated as ${principal.nickname} (${principal.kind}, ${roleLabel(principalRole(principal)).toLowerCase()}).`
		: `Authenticated as ${principal.id}.`
	return `${identity} Actors and times on Review records are stamped by the server from this identity; do not send actor or at. Tools your role cannot use refuse with auth.scope_denied naming the required role. Resolving Review threads is human-only, in the UIUX Workbench. ${LEASE_RECIPE}`
}

export function createUiuxMcpServer(app: ScopedWorkspaceSession): McpServer {
	const server = mapPersistenceBusy(new McpServer({ name: '@deviltea/uiux', version: packageJson.version }, { instructions: uiuxMcpInstructions(app.principal) }))
	server.registerResource(
		'workspace',
		pointResourceUri({ kind: 'workspace', key: 'workspace' }),
		{ title: 'Selected UIUX Workspace', mimeType: 'application/json' },
		async uri => resourceResult(app, uri),
	)
	for (const kind of dynamicKinds) {
		server.registerResource(
			kind,
			new ResourceTemplate(`uiux://${kind}/{key}`, { list: undefined }),
			{ title: `UIUX ${kind} point resource`, mimeType: 'application/json' },
			async uri => resourceResult(app, uri),
		)
	}

	server.registerResource(
		'artifact',
		new ResourceTemplate('uiux://artifact/{digest}', { list: undefined }),
		{ title: 'UIUX immutable content-addressed artifact', mimeType: 'application/octet-stream' },
		async (uri, { digest }) => {
			const digestStr = typeof digest === 'string' ? digest : String(digest)
			if (!isSha256Digest(digestStr)) {
				throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Invalid artifact digest: ${digestStr}`)
			}
			const bytes = await app.readArtifact(digestStr)
			if (!bytes) {
				throw new ResourceNotFoundError(uri.href, `Artifact not found: ${digestStr}`)
			}
			const isPng = bytes.byteLength >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50
			if (isPng) {
				return {
					contents: [{ uri: uri.href, mimeType: 'image/png', blob: Buffer.from(bytes).toString('base64') }],
				}
			}
			try {
				const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
				JSON.parse(text)
				return {
					contents: [{ uri: uri.href, mimeType: 'application/json', text }],
				}
			}
			catch {
				return {
					contents: [{ uri: uri.href, mimeType: 'application/octet-stream', blob: Buffer.from(bytes).toString('base64') }],
				}
			}
		},
	)

	server.registerTool(
		'list_resources',
		{
			title: 'List UIUX resources',
			description: 'List compact canonical resource summaries with stable point-resource URIs.',
			inputSchema: listResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'list', input),
	)

	server.registerTool(
		'search_resources',
		{
			title: 'Search UIUX resources',
			description: 'Search compact canonical resource summaries without returning full resource bodies.',
			inputSchema: searchResourcesSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => discoveryToolResult(app, 'search', input),
	)

	server.registerTool(
		'create_view',
		{
			title: 'Create UIUX View',
			description: 'Create a spec-first View with canonical empty RootShell IR, no Variants, and no Decisions. This is a domain-specific authoring operation, not a generic Resource write.',
			inputSchema: createViewSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.createView({
			id: input.id ?? randomUUID(),
			name: input.name,
			...(input.feature === undefined ? {} : { feature: input.feature }),
			spec: input.spec as ViewSpecContent,
		})),
	)

	server.registerTool(
		'update_view_spec',
		{
			title: 'Update UIUX View Spec',
			description: 'Replace the descriptive View Spec fields while preserving Decisions and every non-Spec View field. Requires the revision previously read by the caller.',
			inputSchema: updateViewSpecSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.updateViewSpec({
			key: input.viewId,
			expectedRevision: input.expectedRevision,
			spec: input.spec as ViewSpecContent,
		})),
	)

	server.registerTool(
		'update_view_structure',
		{
			title: 'Update UIUX View Structure',
			description: 'Replace the canonical View IR and Variants together while preserving View identity, name, feature, and View Spec. Requires the revision previously read by the caller.',
			inputSchema: updateViewStructureSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('view', await app.updateViewStructure({
			key: input.viewId,
			expectedRevision: input.expectedRevision,
			ir: input.ir as ViewResource['ir'],
			variants: input.variants as ViewResource['variants'],
		})),
	)

	server.registerTool(
		'update_workspace_settings',
		{
			title: 'Update UIUX Workspace Settings',
			description: 'Update manifest-owned Workspace settings (i18n.defaultLocale, adapters, viewports, themes) with revision CAS while preserving schemaVersion.',
			inputSchema: updateWorkspaceSettingsSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('workspace', await app.updateWorkspaceSettings({
			expectedRevision: input.expectedRevision,
			settings: {
				i18n: input.settings.i18n,
				adapters: input.settings.adapters as WorkspaceAdapterSelection[],
				viewports: input.settings.viewports as Record<string, ViewportPreset>,
				themes: input.settings.themes as Record<string, ThemeEntry>,
			},
		})),
	)

	server.registerTool(
		'create_locale',
		{
			title: 'Create UIUX Locale',
			description: 'Create a canonical flat locale translation file named by a canonical BCP 47 tag. Fails if the locale already exists.',
			inputSchema: createLocaleSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('locale', await app.createLocale({
			locale: input.locale,
			messages: input.messages,
		})),
	)

	server.registerTool(
		'update_locale',
		{
			title: 'Update UIUX Locale',
			description: 'Update a canonical flat locale translation file with revision CAS. Fails on revision conflict or missing locale.',
			inputSchema: updateLocaleSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('locale', await app.updateLocale({
			locale: input.locale,
			expectedRevision: input.expectedRevision,
			messages: input.messages,
		})),
	)

	server.registerTool(
		'create_flow',
		{
			title: 'Create UIUX Flow',
			description: 'Create a canonical UX Flow with UUID identity, entry step, and step transition graph. Fails if the flow already exists.',
			inputSchema: createFlowSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('flow', await app.createFlow({
			...(input.id ? { id: input.id } : {}),
			name: input.name,
			...(input.scenarioRef ? { scenarioRef: input.scenarioRef as JsonObject } : {}),
			entryStepId: input.entryStepId,
			steps: input.steps as Record<string, FlowStep>,
		})),
	)

	server.registerTool(
		'update_flow',
		{
			title: 'Update UIUX Flow',
			description: 'Update a canonical UX Flow with revision CAS while preserving its immutable identity.',
			inputSchema: updateFlowSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('flow', await app.updateFlow({
			flowId: input.flowId,
			expectedRevision: input.expectedRevision,
			name: input.name,
			...(input.scenarioRef ? { scenarioRef: input.scenarioRef as JsonObject } : {}),
			entryStepId: input.entryStepId,
			steps: input.steps as Record<string, FlowStep>,
		})),
	)

	server.registerTool(
		'create_review_thread',
		{
			title: 'Create UIUX Review Thread',
			description: 'Create an initial open Review thread anchored to a View and widget with optional variant scope. The optional displayHint.pin {x, y} is a non-authoritative pin position normalized (0..1) within the anchored Widget\'s rendered rect; agents have no pointer and should normally omit it.',
			inputSchema: createReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.createReviewThread({
			...(input.id ? { id: input.id } : {}),
			anchor: input.anchor as ReviewAnchor,
			...(input.variantNames ? { variantNames: input.variantNames } : {}),
			...(input.displayHint ? { displayHint: input.displayHint as ReviewDisplayHint } : {}),
		})),
	)

	server.registerTool(
		'append_review_message',
		{
			title: 'Append UIUX Review Message',
			description: 'Append a new message to an existing Review thread with revision CAS.',
			inputSchema: appendReviewMessageSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.appendReviewMessage({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			body: input.body,
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'reanchor_review_thread',
		{
			title: 'Re-anchor UIUX Review Thread',
			description: 'Re-anchor a Review thread to a new widget or variant scope, appending a re-anchor history event with revision CAS. displayHint: an object sets the pin hint for the new anchor, null clears it, and omitting it clears the hint when the Widget changes and keeps it when only Variants change.',
			inputSchema: reanchorReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.reanchorReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			anchor: input.anchor as ReviewAnchor,
			...(input.variantNames ? { variantNames: input.variantNames } : {}),
			...(input.displayHint !== undefined ? { displayHint: input.displayHint as ReviewDisplayHint | null } : {}),
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'set_review_display_hint',
		{
			title: 'Set UIUX Review Display Hint',
			description: 'Move or clear the non-authoritative pin hint of a Review thread within the same Widget (displayHint.pin {x, y} normalized 0..1 within the anchored Widget\'s rendered rect, or null to clear) with revision CAS. Appends no history event and records no actor. Moving a pin to another Widget is reanchor_review_thread.',
			inputSchema: setReviewDisplayHintSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.setReviewDisplayHint({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			displayHint: input.displayHint as ReviewDisplayHint | null,
		})),
	)

	server.registerTool(
		'submit_ready_for_review',
		{
			title: 'Submit UIUX Review Ready',
			description: 'Submit an immutable ready-for-review submission and lifecycle event with revision CAS.',
			inputSchema: submitReadyForReviewSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.submitReadyForReview({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			changeDomains: input.changeDomains,
			resources: input.resources as ReviewResourceRevision[],
			...(input.scope ? { scope: input.scope as JsonObject } : {}),
			evidenceRefs: input.evidenceRefs as ReviewEvidenceRef[],
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
			...(input.submissionId ? { submissionId: input.submissionId } : {}),
		})),
	)

	server.registerTool(
		'resolve_review_thread',
		{
			title: 'Resolve UIUX Review Thread',
			description: RESOLVE_REVIEW_THREAD_DESCRIPTION,
			inputSchema: resolveReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.resolveReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.resolution ? { resolution: input.resolution } : {}),
		})),
	)

	server.registerTool(
		'reopen_review_thread',
		{
			title: 'Reopen UIUX Review Thread',
			description: 'Reopen a resolved or ready Review thread back to open status with revision CAS.',
			inputSchema: reopenReviewThreadSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('review', await app.reopenReviewThread({
			reviewId: input.reviewId,
			expectedRevision: input.expectedRevision,
			...(input.actor !== undefined ? { actor: input.actor } : {}),
			...(input.reason ? { reason: input.reason } : {}),
			...(input.id ? { id: input.id } : {}),
			...(input.at ? { at: input.at } : {}),
		})),
	)

	server.registerTool(
		'promote_review_to_decision',
		{
			title: 'Promote UIUX Review to Decision',
			description: 'Promote a Review thread to a View Spec Decision with provenance keying and idempotency.',
			inputSchema: promoteReviewToDecisionSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.promoteReviewToDecision({
				reviewId: input.reviewId,
				expectedReviewRevision: input.expectedReviewRevision,
				viewId: input.viewId,
				expectedViewRevision: input.expectedViewRevision,
				question: input.question,
				...(input.outcome ? { outcome: input.outcome } : {}),
				...(input.actor !== undefined ? { actor: input.actor } : {}),
				...(input.decisionId ? { decisionId: input.decisionId } : {}),
			})
			if (outcome.status === 'created' || outcome.status === 'updated') {
				const output = {
					...outcome,
					resourceUri: pointResourceUri({ kind: 'review', key: outcome.key }),
					targetView: {
						key: input.viewId,
						revision: outcome.view?.revision ?? input.expectedViewRevision,
						resourceUri: pointResourceUri({ kind: 'view', key: input.viewId }),
					},
				}
				return {
					content: [{ type: 'text' as const, text: JSON.stringify(output) }],
					structuredContent: output,
				}
			}
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				isError: true,
			}
		},
	)

	server.registerTool(
		'create_asset',
		{
			title: 'Create UIUX Asset',
			description: 'Create an authored Asset with metadata and base64-encoded source content. Content is decoded and saved as native bytes.',
			inputSchema: createAssetSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('asset', await app.createAsset({
			...(input.id ? { id: input.id } : {}),
			name: input.name,
			contentFilename: input.contentFilename,
			mediaType: input.mediaType,
			contentBase64: input.contentBase64,
		})),
	)

	server.registerTool(
		'replace_asset',
		{
			title: 'Replace UIUX Asset',
			description: 'Replace an authored Asset with revision CAS while preserving its immutable identity. Content is decoded and saved as native bytes.',
			inputSchema: replaceAssetSchema,
			annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
		},
		async input => authoringToolResult('asset', await app.replaceAsset({
			assetId: input.assetId,
			expectedRevision: input.expectedRevision,
			name: input.name,
			contentFilename: input.contentFilename,
			mediaType: input.mediaType,
			contentBase64: input.contentBase64,
		})),
	)

	server.registerTool(
		'capture_formal_evidence',
		{
			title: 'Capture formal evidence',
			description: 'Capture deterministic formal evidence and PNG screenshot artifacts for an explicit list of resolved render contexts.',
			inputSchema: captureFormalEvidenceSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.captureFormalEvidence({
				contexts: input.contexts as ResolvedRenderContext[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'assess_handoff_readiness',
		{
			title: 'Assess Handoff Readiness',
			description: 'Assess dependency closure, validation, evidence, and review coverage for explicit Handoff roots without producing an exported bundle.',
			inputSchema: assessHandoffReadinessSchema,
			annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.assessHandoffReadiness({
				roots: input.roots as HandoffRoot[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'export_handoff',
		{
			title: 'Export Handoff Bundle',
			description: 'Export an immutable Handoff manifest and complete dependency closure from explicit roots.',
			inputSchema: exportHandoffSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async input => {
			const outcome = await app.exportHandoff({
				roots: input.roots as HandoffRoot[],
			})
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'failed' || outcome.status === 'blocked' ? { isError: true } : {}),
			}
		},
	)

	server.registerTool(
		'acquire_lock',
		{
			title: 'Acquire UIUX edit leases',
			description: `Take (or renew) 5-minute edit leases on 1-${MAX_ACQUIRE_RESOURCES} resources, all or nothing. Lockable kinds: view, flow, locale, asset, workspace (key "workspace"); Review threads are never locked. Returns { status: "acquired", leases } or { status: "locked", locks } naming each conflicting holder and expiry. ${LEASE_RECIPE}`,
			inputSchema: acquireLockSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = app.acquireLeases(input)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'acquired' ? {} : { isError: true }),
			}
		},
	)

	server.registerTool(
		'release_lock',
		{
			title: 'Release UIUX edit leases',
			description: 'Release your edit leases on the listed resources, or all of them when resources is omitted. Idempotent: releasing what you do not hold is a no-op. Returns the released list.',
			inputSchema: releaseLockSchema,
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
		},
		async (input) => {
			const outcome = app.releaseLeases(input)
			return {
				content: [{ type: 'text' as const, text: JSON.stringify(outcome) }],
				structuredContent: outcome,
				...(outcome.status === 'released' ? {} : { isError: true }),
			}
		},
	)

	return server
}

/**
 * Every tool and resource callback registered on `server` answers a persistence lock timeout with
 * the coded, retryable `persistence.busy` instead of an opaque failure: a tool returns it as an
 * error result (`structuredContent.code`), a resource read as a JSON-RPC internal error whose data
 * is the same result.
 */
function mapPersistenceBusy(server: McpServer): McpServer {
	type Callback = (...args: unknown[]) => unknown
	const registerTool = server.registerTool.bind(server) as (...args: unknown[]) => unknown
	const registerResource = server.registerResource.bind(server) as (...args: unknown[]) => unknown
	const guard = (callback: Callback, onBusy: () => unknown): Callback => async (...args) => {
		try {
			return await callback(...args)
		}
		catch (error) {
			if (!isPersistenceBusyError(error)) throw error
			return onBusy()
		}
	}
	server.registerTool = ((...args: unknown[]) => {
		const callback = args.pop() as Callback
		return registerTool(...args, guard(callback, () => {
			const busy = persistenceBusyResult()
			return { content: [{ type: 'text' as const, text: JSON.stringify(busy) }], structuredContent: busy, isError: true }
		}))
	}) as typeof server.registerTool
	server.registerResource = ((...args: unknown[]) => {
		const callback = args.pop() as Callback
		return registerResource(...args, guard(callback, () => {
			const busy = persistenceBusyResult()
			throw new ProtocolError(ProtocolErrorCode.InternalError, `${busy.code}: ${busy.message}`, busy)
		}))
	}) as typeof server.registerResource
	return server
}

export const RESOLVE_REVIEW_THREAD_DESCRIPTION = 'Resolution is human-only and happens in the UIUX Workbench. This tool always refuses. Reply on the thread, or submit it ready for review, and a human will resolve it.'

/** The `authInfo.extra` key carrying the verified principal from the route into the per-request factory. */
export const PRINCIPAL_AUTH_INFO_KEY = 'uiuxPrincipal'

export function principalFromAuthInfo(authInfo: AuthInfo | undefined): Principal | undefined {
	const candidate = authInfo?.extra?.[PRINCIPAL_AUTH_INFO_KEY] as Principal | undefined
	return candidate && (candidate.type === 'member' || candidate.type === 'system') ? candidate : undefined
}

/** `authInfo` for a verified principal: the plaintext token is never handed to the SDK (`token: "<redacted>"`). */
export function principalAuthInfo(principal: Principal): AuthInfo {
	return {
		token: '<redacted>',
		clientId: principal.type === 'member' ? principal.memberId : principal.id,
		scopes: [principalRole(principal)],
		extra: { [PRINCIPAL_AUTH_INFO_KEY]: principal },
	}
}

/**
 * Stateless per-request MCP handler. The caller verifies the bearer token first and passes the
 * principal through `fetch(request, { authInfo })`; a request without one is answered 401 here
 * too, so no code path can reach a tool unauthenticated.
 */
export function createUiuxMcpHttpHandler(app: WorkspaceApplicationSession, options: Readonly<{ leases: LeaseManager }>): McpHttpHandler {
	const inner = createMcpHandler((ctx) => {
		const principal = principalFromAuthInfo(ctx.authInfo)
		if (!principal || principal.type !== 'member') throw new Error('MCP request reached the server factory without an authenticated member.')
		return createUiuxMcpServer(createScopedWorkspaceSession(app, principal, { transport: 'mcp', leases: options.leases }))
	})
	return {
		...inner,
		fetch: async (request, requestOptions) => {
			const principal = principalFromAuthInfo(requestOptions?.authInfo)
			if (!principal || principal.type !== 'member') {
				const message = 'MCP requires a member bearer token. Create a token with `uiux token create --workspace <dir> --member <agent>` and send it as `Authorization: Bearer <token>`.'
				return new Response(JSON.stringify({ status: 'rejected', code: 'auth.required', message, diagnostics: [{ code: 'auth.required', path: '/headers/authorization', message }] }), {
					status: 401,
					headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer realm="uiux"', 'cache-control': 'no-store' },
				})
			}
			return inner.fetch(request, requestOptions)
		},
	}
}

async function resourceResult(app: ScopedWorkspaceSession, uri: URL): Promise<ReadResourceResult> {
	const address = parsePointResourceUri(uri)
	if (!address) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported UIUX resource URI: ${uri.href}`)
	const read = await app.readPointResource(address.kind, address.key)
	if (!read) throw new ResourceNotFoundError(uri.href, `UIUX resource not found: ${uri.href}`)
	return {
		contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(read) }],
	}
}

async function discoveryToolResult(app: ScopedWorkspaceSession, mode: 'list' | 'search', input: unknown) {
	const outcome = mode === 'list' ? await app.listPointResources(input) : await app.searchPointResources(input)
	if (outcome.status === 'invalid')
		throw new ProtocolError(ProtocolErrorCode.InvalidParams, outcome.diagnostics.map(item => `${item.path || '/'}: ${item.message}`).join('; '))
	const output = {
		items: outcome.page.items.map(item => ({ ...item, resourceUri: pointResourceUri({ kind: item.kind, key: item.key }) })),
		...(outcome.page.nextCursor ? { nextCursor: outcome.page.nextCursor } : {}),
	}
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
	}
}

function authoringToolResult(kind: PointResourceKind, result: { status: string; key: string; [key: string]: unknown }) {
	const output = result.status === 'created' || result.status === 'updated'
		? { ...result, resourceUri: pointResourceUri({ kind, key: result.key }) }
		: result
	return {
		content: [{ type: 'text' as const, text: JSON.stringify(output) }],
		structuredContent: output,
		...(result.status === 'created' || result.status === 'updated' ? {} : { isError: true }),
	}
}
