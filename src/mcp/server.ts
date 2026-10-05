import { randomUUID } from 'node:crypto'

import { McpServer, ProtocolError, ProtocolErrorCode, ResourceNotFoundError, ResourceTemplate, createMcpHandler, type McpHttpHandler, type ReadResourceResult } from '@modelcontextprotocol/server'
import packageJson from '../../package.json' with { type: 'json' }
import { z } from 'zod'

import { DISCOVERABLE_RESOURCE_KINDS, MAX_RESOURCE_DISCOVERY_LIMIT } from '../application/dto/resource-discovery'
import type { PointResourceKind } from '../application/dto/point-resources'
import type { WorkspaceApplicationSession } from '../application/services/workspace-session'
import type { ViewSpecContent } from '../application/services/view-authoring'
import type { ViewResource } from '../domain/views/schema'
import type { FlowStep } from '../domain/flows/schema'
import { REVIEW_RESOLUTIONS, type ReviewActor, type ReviewAnchor, type ReviewDisplayHint, type ReviewEvidenceRef, type ReviewResolution, type ReviewResourceRevision } from '../domain/reviews/schema'
import type { WorkspaceAdapterSelection, ThemeEntry, ViewportPreset } from '../domain/workspace/schema'
import { isSha256Digest, type JsonObject } from '../domain/validation'
import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { HandoffRoot } from '../domain/handoff/schema'
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
	actor: reviewActorSchema,
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
	actor: reviewActorSchema,
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
	actor: reviewActorSchema,
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
	actor: reviewActorSchema,
	resolution: reviewResolutionSchema.optional(),
	submissionId: z.string().optional(),
	reason: z.string().optional(),
	id: z.string().optional(),
	at: z.string().optional(),
}).strict()

const reopenReviewThreadSchema = z.object({
	reviewId: z.string(),
	expectedRevision: z.string(),
	actor: reviewActorSchema,
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
	actor: reviewActorSchema.optional(),
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

export function createUiuxMcpServer(app: WorkspaceApplicationSession): McpServer {
	const server = new McpServer({ name: '@deviltea/uiux', version: packageJson.version })
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
			actor: input.actor as ReviewActor,
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
			actor: input.actor as ReviewActor,
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
			actor: input.actor as ReviewActor,
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
		async input => authoringToolResult('review', refuseMcpResolution(input.reviewId, input.actor as ReviewActor, input.resolution)),
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
			actor: input.actor as ReviewActor,
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
				...(input.actor ? { actor: input.actor } : {}),
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
				...(outcome.status === 'failed' ? { isError: true } : {}),
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
				...(outcome.status === 'failed' ? { isError: true } : {}),
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
				...(outcome.status === 'failed' ? { isError: true } : {}),
			}
		},
	)

	return server
}

export const RESOLVE_REVIEW_THREAD_DESCRIPTION = 'Resolution is human-only and happens in the UIUX Workbench. This tool always refuses. Reply on the thread, or submit it ready for review, and a human will resolve it.'

/**
 * Resolution is Workbench-only (accepted direct-resolve decision 9): `/mcp` keeps the tool registered
 * so agents get an actionable refusal, and refuses before calling the domain service, in this order.
 */
export function refuseMcpResolution(reviewId: string, actor: ReviewActor, resolution: ReviewResolution | undefined) {
	if (actor?.type === 'human') {
		const message = 'Resolution is performed by a human in the UIUX Workbench, not through MCP.'
		return { status: 'blocked' as const, key: reviewId, code: 'review.resolve_requires_workbench', message, diagnostics: [{ code: 'review.resolve_requires_workbench', path: '/actor/type', message }] }
	}
	if (resolution !== undefined && resolution !== 'verified') {
		const message = 'Closing a thread without a verified change is a human decision made in the UIUX Workbench. Reply on the thread instead.'
		return { status: 'blocked' as const, key: reviewId, code: 'review.direct_resolve_requires_workbench', message, diagnostics: [{ code: 'review.direct_resolve_requires_workbench', path: '/resolution', message }] }
	}
	const message = 'Only a human actor may resolve a Review thread, in the UIUX Workbench. Submit the thread ready for review and a human will resolve it.'
	return { status: 'blocked' as const, key: reviewId, code: 'review.resolve_requires_human', message, diagnostics: [{ code: 'review.resolve_requires_human', path: '/actor/type', message }] }
}

export function createUiuxMcpHttpHandler(app: WorkspaceApplicationSession): McpHttpHandler {
	return createMcpHandler(() => createUiuxMcpServer(app))
}

async function resourceResult(app: WorkspaceApplicationSession, uri: URL): Promise<ReadResourceResult> {
	const address = parsePointResourceUri(uri)
	if (!address) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unsupported UIUX resource URI: ${uri.href}`)
	const read = await app.readPointResource(address.kind, address.key)
	if (!read) throw new ResourceNotFoundError(uri.href, `UIUX resource not found: ${uri.href}`)
	return {
		contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(read) }],
	}
}

async function discoveryToolResult(app: WorkspaceApplicationSession, mode: 'list' | 'search', input: unknown) {
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
