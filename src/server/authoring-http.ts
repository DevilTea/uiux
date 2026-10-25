import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { FileNativePersistence } from '../persistence'
import { isFullUuid, isSha256Digest, type JsonObject, type JsonValue } from '../domain/validation'
import { sha256Identity } from '../domain/artifacts/schema'
import type { ViewSpecContent } from '../application/services/view-authoring'
import type { VariantEntry } from '../domain/views/schema'
import type { WorkspaceSettingsUpdate } from '../application/services/workspace-authoring'
import type { I18nResource } from '../domain/i18n/schema'
import type { ProductKitComponent, ProductKitWidgetMapping } from '../domain/product-kit/schema'
import type { FlowStep } from '../domain/flows/schema'
import {
	REVIEW_RESOLUTIONS,
	type ReviewAnchor,
	type ReviewDisplayHint,
	type ReviewEvidenceRef,
	type ReviewRenderContext,
	type ReviewResourceRevision,
} from '../domain/reviews/schema'
import type { DecisionOutcome } from '../domain/spec/schema'
import { storedContentSecurityHeaders } from './stored-content-headers'

export type AuthoringHttpResult<T = unknown> = Readonly<{
	status: number
	body: T
	headers?: Readonly<Record<string, string>>
}>

/**
 * Maps a mutation result to HTTP. Access refusals: `auth.scope_denied` is 403 and the lease
 * refusal `locked` (`resource.locked`) is 423 (accepted identity decisions 5 and 11).
 */
export function mapAuthoringResultToHttpStatus(status: string, code?: string): number {
	if (code === 'auth.scope_denied') return 403
	switch (status) {
		case 'locked': return 423
		case 'created': return 201
		case 'updated': return 200
		case 'deleted': return 200
		case 'not_found': return 404
		case 'conflict': return 409
		// Clause 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34: the caller must review the impact and resend with `acknowledgeImpact: true`.
		case 'impact_acknowledgement_required': return 409
		case 'already_exists': return 409
		case 'invalid':
		case 'invalid_expected_revision': return 400
		case 'blocked': return 422
		default: return 500
	}
}

function resultCode(result: { status: string }): string | undefined {
	const code = (result as { code?: unknown }).code
	return typeof code === 'string' ? code : undefined
}

const viewSpecContentSchema = z.object({
	intent: z.string(),
	entryConditions: z.array(z.string()),
	interactionRules: z.array(z.string()),
	constraints: z.array(z.string()),
	accessibility: z.array(z.string()),
	references: z.array(z.unknown()),
}).strict()

const createViewHttpSchema = z.object({
	id: z.string().min(1).optional(),
	name: z.string(),
	feature: z.string().optional(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewSpecHttpSchema = z.object({
	expectedRevision: z.string(),
	spec: viewSpecContentSchema,
}).strict()

const updateViewStructureHttpSchema = z.object({
	expectedRevision: z.string(),
	ir: z.record(z.string(), z.unknown()),
	variants: z.record(z.string(), z.unknown()),
	acknowledgeImpact: z.boolean().optional(),
}).strict()

/** The members of `DELETE /api/views|flows|assets/:id` (Clause 01a172ce-ebcc-7a79-8103-ff5339409948). */
const deleteResourceHttpSchema = z.object({
	expectedRevision: z.string(),
	acknowledgeImpact: z.boolean().optional(),
}).strict()

const updateViewMetadataHttpSchema = z.object({
	expectedRevision: z.string(),
	name: z.string().optional(),
	feature: z.string().nullable().optional(),
}).strict()

const decisionLifecycleHttpSchema = z.object({
	expectedRevision: z.string(),
}).strict()

const decideDecisionHttpSchema = z.object({
	expectedRevision: z.string(),
	outcome: z.object({
		summary: z.string(),
		rationale: z.string(),
	}).strict(),
}).strict()

const updateWorkspaceSettingsHttpSchema = z.object({
	expectedRevision: z.string(),
	settings: z.object({
		i18n: z.object({
			defaultLocale: z.string(),
		}).catchall(z.unknown()),
		viewports: z.record(z.string(), z.object({
			dimensions: z.object({
				width: z.number(),
				height: z.number(),
			}).catchall(z.unknown()),
		}).catchall(z.unknown())),
		themes: z.record(z.string(), z.record(z.string(), z.unknown())),
	}).strict(),
	acknowledgeImpact: z.boolean().optional(),
}).strict()

// The Product Kit operations (Clause 01a11bb1-b15c-734e-8968-c378db1444ca); the domain validator reports member shapes.
const composeProductKitHttpSchema = z.object({
	expectedRevision: z.string(),
	designSystems: z.array(z.string()),
	adapters: z.array(z.string()),
}).strict()

const updateProductKitHttpSchema = z.object({
	expectedRevision: z.string(),
	adapters: z.array(z.object({
		moduleSpecifier: z.string(),
		config: z.unknown().optional(),
	}).strict()),
	styles: z.array(z.string()),
	themes: z.record(z.string(), z.record(z.string(), z.unknown())),
}).strict()

const updateComponentRegistryHttpSchema = z.object({
	expectedRevision: z.string(),
	components: z.record(z.string(), z.unknown()),
	widgets: z.record(z.string(), z.unknown()),
}).strict()

const createLocaleHttpSchema = z.object({
	locale: z.string(),
	messages: z.record(z.string(), z.string()),
}).strict()

const updateLocaleHttpSchema = z.object({
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

const createFlowHttpSchema = z.object({
	id: z.string().min(1).optional(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

const updateFlowHttpSchema = z.object({
	expectedRevision: z.string(),
	name: z.string(),
	scenarioRef: z.record(z.string(), z.unknown()).optional(),
	entryStepId: z.string(),
	steps: z.record(z.string(), flowStepSchema),
}).strict()

// The closed anchor union: the Widget arm { viewId, widgetId } or the Workspace arm { scope: "workspace" }.
const reviewAnchorSchema = z.union([
	z.object({ viewId: z.string(), widgetId: z.string() }).strict(),
	z.object({ scope: z.literal('workspace') }).strict(),
])

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

// The render context a Widget thread was raised in. Shape details and key existence in the
// Workspace are the service's diagnostics.
const reviewRenderContextSchema = z.object({
	locale: z.string().optional(),
	viewportId: z.string().optional(),
	themeId: z.string().optional(),
}).strict()

const createReviewThreadHttpSchema = z.object({
	id: z.string().min(1).optional(),
	anchor: reviewAnchorSchema,
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.optional(),
	renderContext: reviewRenderContextSchema.optional(),
}).strict()

const appendReviewMessageHttpSchema = z.object({
	expectedRevision: z.string(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
	body: z.string(),
	id: z.string().min(1).optional(),
	at: z.string().optional(),
}).strict()

const reanchorReviewThreadHttpSchema = z.object({
	expectedRevision: z.string(),
	anchor: reviewAnchorSchema,
	variantNames: z.array(z.string()).optional(),
	displayHint: reviewDisplayHintSchema.nullable().optional(),
	/** An object sets the render context, null clears it, omitted keeps it. */
	renderContext: reviewRenderContextSchema.nullable().optional(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
	reason: z.string().optional(),
	id: z.string().min(1).optional(),
	at: z.string().optional(),
}).strict()

const setReviewDisplayHintHttpSchema = z.object({
	expectedRevision: z.string(),
	displayHint: reviewDisplayHintSchema.nullable(),
}).strict()

const submitReadyForReviewHttpSchema = z.object({
	expectedRevision: z.string(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
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
	id: z.string().min(1).optional(),
	at: z.string().optional(),
	submissionId: z.string().min(1).optional(),
}).strict()

const resolveReviewThreadHttpSchema = z.object({
	expectedRevision: z.string(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
	resolution: z.enum(REVIEW_RESOLUTIONS).optional(),
	submissionId: z.string().min(1).optional(),
	reason: z.string().optional(),
	id: z.string().min(1).optional(),
	at: z.string().optional(),
}).strict()

const reopenReviewThreadHttpSchema = z.object({
	expectedRevision: z.string(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
	reason: z.string().optional(),
	id: z.string().min(1).optional(),
	at: z.string().optional(),
}).strict()

const editReviewMessageHttpSchema = z.object({
	expectedRevision: z.string(),
	body: z.string(),
	editId: z.string().min(1).optional(),
	/** Optional and ignored: the server stamps the actor (warning `auth.actor_ignored`). */
	actor: reviewActorSchema.optional(),
	at: z.string().optional(),
}).strict()

const retractReviewThreadHttpSchema = z.object({
	expectedRevision: z.string(),
}).strict()

const promoteReviewToDecisionHttpSchema = z.object({
	expectedReviewRevision: z.string(),
	viewId: z.string(),
	expectedViewRevision: z.string(),
	question: z.string(),
	outcome: z.object({
		summary: z.string(),
		rationale: z.string(),
	}).strict().optional(),
	actor: reviewActorSchema.optional(),
	decisionId: z.string().min(1).optional(),
}).strict()

const createDecisionFromReviewHttpSchema = z.object({
	expectedReviewRevision: z.string(),
	viewId: z.string(),
	expectedViewRevision: z.string(),
	decisionId: z.string(),
	question: z.string(),
	outcome: z.object({
		summary: z.string(),
		rationale: z.string(),
	}).strict().optional(),
	actor: reviewActorSchema.optional(),
}).strict()

const createAssetHttpSchema = z.object({
	id: z.string().min(1).optional(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

const replaceAssetHttpSchema = z.object({
	expectedRevision: z.string(),
	name: z.string(),
	contentFilename: z.string(),
	mediaType: z.string(),
	contentBase64: z.string(),
}).strict()

export function parseHttpPayload<T>(
	schema: z.ZodType<T>,
	body: unknown,
): { ok: true; data: T } | { ok: false; result: AuthoringHttpResult } {
	if (typeof body !== 'object' || body === null || Array.isArray(body)) {
		return {
			ok: false,
			result: {
				status: 400,
				body: {
					status: 'invalid',
					code: 'malformed_payload',
					message: 'Expected a JSON object request body.',
					diagnostics: [
						{
							code: 'transport.malformed_payload',
							path: '/',
							message: 'Expected a JSON object request body.',
						},
					],
				},
			},
		}
	}

	const parsed = schema.safeParse(body)
	if (parsed.success) {
		return { ok: true, data: parsed.data }
	}

	const diagnostics = parsed.error.issues.map(issue => ({
		code: 'transport.malformed_payload',
		path: issue.path.length > 0 ? `/${issue.path.join('/')}` : '/',
		message: issue.message,
	}))

	return {
		ok: false,
		result: {
			status: 400,
			body: {
				status: 'invalid',
				code: 'malformed_payload',
				message: 'Request payload failed structural validation.',
				diagnostics,
			},
		},
	}
}

export async function createViewForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createViewHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createView({
		id: data.id ?? randomUUID(),
		name: data.name,
		...(data.feature ? { feature: data.feature } : {}),
		spec: data.spec as ViewSpecContent,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateViewSpecForHttp(app: ScopedWorkspaceSession, viewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateViewSpecHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateViewSpec({
		key: viewId,
		expectedRevision: data.expectedRevision,
		spec: data.spec as ViewSpecContent,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateViewStructureForHttp(app: ScopedWorkspaceSession, viewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateViewStructureHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateViewStructure({
		key: viewId,
		expectedRevision: data.expectedRevision,
		ir: data.ir as JsonValue,
		variants: data.variants as Record<string, VariantEntry>,
		...(data.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: data.acknowledgeImpact }),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `DELETE /api/views/:id` with a JSON body `{ expectedRevision, acknowledgeImpact? }` (Clause 01a172ce-ebcc-7a79-8103-ff5339409948). */
export async function deleteViewForHttp(app: ScopedWorkspaceSession, viewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(deleteResourceHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.deleteView({ key: viewId, expectedRevision: parsed.data.expectedRevision, ...(parsed.data.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: parsed.data.acknowledgeImpact }) })
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `DELETE /api/flows/:id`, as `deleteViewForHttp`. */
export async function deleteFlowForHttp(app: ScopedWorkspaceSession, flowId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(deleteResourceHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.deleteFlow({ flowId, expectedRevision: parsed.data.expectedRevision, ...(parsed.data.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: parsed.data.acknowledgeImpact }) })
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `DELETE /api/assets/:id`, as `deleteViewForHttp`. */
export async function deleteAssetForHttp(app: ScopedWorkspaceSession, assetId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(deleteResourceHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.deleteAsset({ assetId, expectedRevision: parsed.data.expectedRevision, ...(parsed.data.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: parsed.data.acknowledgeImpact }) })
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `PUT /api/views/:id/metadata` (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85): `update_view_metadata` over HTTP. */
export async function updateViewMetadataForHttp(app: ScopedWorkspaceSession, viewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateViewMetadataHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateViewMetadata({
		key: viewId,
		expectedRevision: data.expectedRevision,
		...(data.name === undefined ? {} : { name: data.name }),
		...(data.feature === undefined ? {} : { feature: data.feature }),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `POST /api/views/:id/decisions/:decisionId/defer` and `/reopen` (Clause 01a17226-fafc-7691-99ff-aa3b20f5836f). */
export async function transitionDecisionForHttp(app: ScopedWorkspaceSession, action: 'defer' | 'reopen', viewId: string, decisionId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(decisionLifecycleHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const command = { key: viewId, decisionId, expectedRevision: parsed.data.expectedRevision }
	const result = action === 'defer' ? await app.deferDecision(command) : await app.reopenDecision(command)
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `POST /api/views/:id/decisions/:decisionId/decide`: needs the `humanOnly` `decisions.decide`. */
export async function decideDecisionForHttp(app: ScopedWorkspaceSession, viewId: string, decisionId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(decideDecisionHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.decideDecision({ key: viewId, decisionId, expectedRevision: parsed.data.expectedRevision, outcome: parsed.data.outcome })
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateWorkspaceSettingsForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateWorkspaceSettingsHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateWorkspaceSettings({
		expectedRevision: data.expectedRevision,
		settings: data.settings as WorkspaceSettingsUpdate,
		...(data.acknowledgeImpact === undefined ? {} : { acknowledgeImpact: data.acknowledgeImpact }),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `GET /api/product-kit`: the Product Kit Resource, `workspace.read` only; 404 without a readable Product Kit file. */
export async function readProductKitForHttp(app: ScopedWorkspaceSession): Promise<AuthoringHttpResult> {
	const denied = app.authorize('readProductKit')
	if (denied) return { status: 403, body: { status: 'blocked', key: 'product-kit', code: denied.code, requiredKeys: denied.requiredKeys, message: denied.message, diagnostics: [{ code: denied.code, path: '/', message: denied.message }] } }
	const read = await app.readProductKit()
	if (!read) return { status: 404, body: { status: 'not_found', key: 'product-kit' } }
	return { status: 200, body: read }
}

/**
 * `POST /api/product-kit/checks`: Run Checks' Product Kit part (issue #141 Part 14 decision 7), a
 * Workbench session with `evidence.capture`. A run already in progress answers 409.
 */
export async function runProductKitChecksForHttp(app: ScopedWorkspaceSession): Promise<AuthoringHttpResult> {
	const result = await app.runProductKitChecks()
	if (result.status === 'blocked') return { status: 403, body: result }
	if (result.status === 'busy') return { status: 409, body: result }
	return { status: 200, body: result }
}

function productKitRefusalBody(denied: Readonly<{ code: string; requiredKeys: readonly string[]; message: string }>) {
	return { status: 'blocked', key: 'product-kit', code: denied.code, requiredKeys: denied.requiredKeys, message: denied.message, diagnostics: [{ code: denied.code, path: '/', message: denied.message }] }
}

/** `GET /api/product-kit/build`: the kit build state, `workspace.read` only. */
export function readKitBuildForHttp(app: ScopedWorkspaceSession): AuthoringHttpResult {
	const read = app.readKitBuild()
	if (read && 'status' in read) return { status: 403, body: read }
	if (!read) return { status: 404, body: { status: 'not_found', key: 'product-kit' } }
	return { status: 200, body: read }
}

/** `GET /api/product-kit/build/log`: the kit build log, host paths masked; `product-kit.source.read`. */
export function readKitBuildLogForHttp(app: ScopedWorkspaceSession): AuthoringHttpResult {
	const read = app.readKitBuildLog()
	if (read && 'status' in read) return { status: 403, body: read }
	if (!read) return { status: 404, body: { status: 'not_found', key: 'product-kit' } }
	return { status: 200, body: read }
}

/** `POST /api/product-kit/build/restart` (`restart_kit_build`): takes no body; `product-kit.write`. */
export async function restartKitBuildForHttp(app: ScopedWorkspaceSession): Promise<AuthoringHttpResult> {
	const denied = app.authorize('restartKitBuild')
	if (denied) return { status: 403, body: productKitRefusalBody(denied) }
	const result = await app.restartKitBuild()
	if (result.status === 'blocked') return { status: result.code === 'auth.scope_denied' ? 403 : result.code === 'kit.build_restart_throttled' ? 429 : 409, body: result }
	return { status: 200, body: result }
}

export async function composeProductKitForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(composeProductKitHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.composeProductKit(parsed.data)
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateProductKitForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateProductKitHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateProductKit({
		expectedRevision: data.expectedRevision,
		adapters: data.adapters.map(entry => ({ moduleSpecifier: entry.moduleSpecifier, ...(entry.config === undefined ? {} : { config: entry.config as JsonValue }) })),
		styles: data.styles,
		themes: data.themes as Record<string, Record<string, string>>,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateComponentRegistryForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateComponentRegistryHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateComponentRegistry({
		expectedRevision: data.expectedRevision,
		components: data.components as Record<string, ProductKitComponent>,
		widgets: data.widgets as Record<string, ProductKitWidgetMapping>,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function createLocaleForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createLocaleHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createLocale({
		locale: data.locale,
		messages: data.messages as I18nResource,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateLocaleForHttp(app: ScopedWorkspaceSession, locale: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateLocaleHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateLocale({
		locale,
		expectedRevision: data.expectedRevision,
		messages: data.messages as I18nResource,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function createFlowForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createFlowHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createFlow({
		...(data.id ? { id: data.id } : {}),
		name: data.name,
		...(data.scenarioRef ? { scenarioRef: data.scenarioRef as JsonObject } : {}),
		entryStepId: data.entryStepId,
		steps: data.steps as Record<string, FlowStep>,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateFlowForHttp(app: ScopedWorkspaceSession, flowId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateFlowHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateFlow({
		flowId,
		expectedRevision: data.expectedRevision,
		name: data.name,
		...(data.scenarioRef ? { scenarioRef: data.scenarioRef as JsonObject } : {}),
		entryStepId: data.entryStepId,
		steps: data.steps as Record<string, FlowStep>,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function createReviewThreadForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createReviewThreadHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createReviewThread({
		...(data.id ? { id: data.id } : {}),
		anchor: data.anchor as ReviewAnchor,
		...(data.variantNames ? { variantNames: data.variantNames } : {}),
		...(data.displayHint ? { displayHint: data.displayHint as ReviewDisplayHint } : {}),
		...(data.renderContext ? { renderContext: data.renderContext as ReviewRenderContext } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function appendReviewMessageForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(appendReviewMessageHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.appendReviewMessage({
		reviewId,
		expectedRevision: data.expectedRevision,
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		body: data.body,
		...(data.id ? { id: data.id } : {}),
		...(data.at ? { at: data.at } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function reanchorReviewThreadForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(reanchorReviewThreadHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.reanchorReviewThread({
		reviewId,
		expectedRevision: data.expectedRevision,
		anchor: data.anchor as ReviewAnchor,
		...(data.variantNames ? { variantNames: data.variantNames } : {}),
		...(data.displayHint !== undefined ? { displayHint: data.displayHint as ReviewDisplayHint | null } : {}),
		...(data.renderContext !== undefined ? { renderContext: data.renderContext as ReviewRenderContext | null } : {}),
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		...(data.reason ? { reason: data.reason } : {}),
		...(data.id ? { id: data.id } : {}),
		...(data.at ? { at: data.at } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function submitReadyForReviewForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(submitReadyForReviewHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.submitReadyForReview({
		reviewId,
		expectedRevision: data.expectedRevision,
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		changeDomains: data.changeDomains,
		resources: data.resources as ReviewResourceRevision[],
		...(data.scope ? { scope: data.scope as JsonObject } : {}),
		evidenceRefs: data.evidenceRefs as ReviewEvidenceRef[],
		...(data.reason ? { reason: data.reason } : {}),
		...(data.id ? { id: data.id } : {}),
		...(data.at ? { at: data.at } : {}),
		...(data.submissionId ? { submissionId: data.submissionId } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function resolveReviewThreadForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(resolveReviewThreadHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.resolveReviewThread({
		reviewId,
		expectedRevision: data.expectedRevision,
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		...(data.resolution ? { resolution: data.resolution } : {}),
		...(data.submissionId ? { submissionId: data.submissionId } : {}),
		...(data.reason ? { reason: data.reason } : {}),
		...(data.id ? { id: data.id } : {}),
		...(data.at ? { at: data.at } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function setReviewDisplayHintForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(setReviewDisplayHintHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.setReviewDisplayHint({
		reviewId,
		expectedRevision: data.expectedRevision,
		displayHint: data.displayHint as ReviewDisplayHint | null,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function reopenReviewThreadForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(reopenReviewThreadHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.reopenReviewThread({
		reviewId,
		expectedRevision: data.expectedRevision,
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		...(data.reason ? { reason: data.reason } : {}),
		...(data.id ? { id: data.id } : {}),
		...(data.at ? { at: data.at } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function editReviewMessageForHttp(app: ScopedWorkspaceSession, reviewId: string, messageId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(editReviewMessageHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.editReviewMessage({
		reviewId,
		expectedRevision: data.expectedRevision,
		messageId,
		body: data.body,
		...(data.editId ? { editId: data.editId } : {}),
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		...(data.at ? { at: data.at } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `DELETE /api/reviews/:id` with a JSON body `{ expectedRevision }`; success is 200 `{ status: "deleted", key }`. */
export async function retractReviewThreadForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(retractReviewThreadHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.retractReviewThread({ reviewId, expectedRevision: parsed.data.expectedRevision })
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function promoteReviewToDecisionForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(promoteReviewToDecisionHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.promoteReviewToDecision({
		reviewId,
		expectedReviewRevision: data.expectedReviewRevision,
		viewId: data.viewId,
		expectedViewRevision: data.expectedViewRevision,
		question: data.question,
		...(data.outcome ? { outcome: data.outcome as DecisionOutcome } : {}),
		...(data.actor !== undefined ? { actor: data.actor } : {}),
		...(data.decisionId ? { decisionId: data.decisionId } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

/** `POST /api/reviews/:id/decisions` (Clause 01a17226-fca4-7a13-b38e-c51ffeb47c44): another Decision from the thread. */
export async function createDecisionFromReviewForHttp(app: ScopedWorkspaceSession, reviewId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createDecisionFromReviewHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createDecisionFromReview({
		reviewId,
		expectedReviewRevision: data.expectedReviewRevision,
		viewId: data.viewId,
		expectedViewRevision: data.expectedViewRevision,
		decisionId: data.decisionId,
		question: data.question,
		...(data.outcome ? { outcome: data.outcome as DecisionOutcome } : {}),
		...(data.actor !== undefined ? { actor: data.actor } : {}),
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function createAssetForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(createAssetHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.createAsset({
		...(data.id ? { id: data.id } : {}),
		name: data.name,
		contentFilename: data.contentFilename,
		mediaType: data.mediaType,
		contentBase64: data.contentBase64,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function replaceAssetForHttp(app: ScopedWorkspaceSession, assetId: string, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(replaceAssetHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.replaceAsset({
		assetId,
		expectedRevision: data.expectedRevision,
		name: data.name,
		contentFilename: data.contentFilename,
		mediaType: data.mediaType,
		contentBase64: data.contentBase64,
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export function formatContentDisposition(filename: string): string {
	const sanitized = filename.replace(/[\r\n\0]/g, '').trim() || 'content.bin'
	const asciiFallback = sanitized.replace(/[^A-Za-z0-9._-]/g, '_') || 'content.bin'
	const utf8Encoded = encodeURIComponent(sanitized).replace(/['()]/g, escape)
	return `inline; filename="${asciiFallback}"; filename*=UTF-8''${utf8Encoded}`
}

/** RFC 9110 §13.1.2 `If-None-Match`: `*`, or any listed entity tag equal to `etag` under weak comparison (a `W/` prefix is ignored). */
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
	if (header === undefined) return false
	const strip = (tag: string) => tag.trim().replace(/^W\//, '')
	return header.split(',').some(candidate => strip(candidate) === '*' || strip(candidate) === etag)
}

/**
 * `GET /api/assets/:id/content[?digest=<digest>]`. With `digest`, the content is served only while the
 * Asset's current source content has that digest: other content answers 409, so a Preview never shows
 * content other than what its binding was resolved and checked with (Clause 01a167f4-41f2-70a1-a200-a005d47b12b5).
 * `Content-Type` and `Content-Disposition` come from the Asset's metadata, which the digest does not cover, so a
 * response is revalidated (`no-cache`) against the strong ETag, the Asset revision over metadata and content;
 * `ifNoneMatch` matching it answers 304 after the digest check.
 */
export async function readAssetContentForHttp(persistence: FileNativePersistence, assetId: string, digest?: string, ifNoneMatch?: string): Promise<AuthoringHttpResult> {
	if (!isFullUuid(assetId))
		return { status: 400, body: { code: 'invalid_resource_address', message: 'Asset id must be a valid UUID.' } }
	if (digest !== undefined && !isSha256Digest(digest))
		return { status: 400, body: { code: 'invalid_asset_digest', message: 'An Asset content digest is sha256:<64 lowercase hex characters>.' } }

	const read = await persistence.assets.readInspected(assetId)
	if (!read)
		return { status: 404, body: { code: 'resource_not_found', kind: 'asset', key: assetId } }

	const declaredFilename = read.resource.metadata?.contentFilename
	if (!declaredFilename || !read.actualContentFilenames.includes(declaredFilename)) {
		return {
			status: 404,
			body: {
				code: 'asset_content_missing',
				message: `Declared source-content file "${declaredFilename}" does not exist in the asset directory.`,
				diagnostics: read.diagnostics,
			},
		}
	}

	if (read.actualContentFilenames.length > 1) {
		return {
			status: 409,
			body: {
				code: 'asset_content_ambiguous',
				message: 'Asset directory contains multiple or unexpected content files.',
				diagnostics: read.diagnostics,
			},
		}
	}

	const contentBytes = read.resource.content
	const mediaType = read.resource.metadata?.mediaType ?? 'application/octet-stream'
	if (digest !== undefined && await sha256Identity(contentBytes) !== digest) {
		return {
			status: 409,
			body: { code: 'asset_content_digest_mismatch', message: `Asset ${assetId} no longer has the content digest ${digest}.` },
		}
	}

	const etag = `"${read.revision}"`
	const cacheControl = digest === undefined ? 'no-store' : 'private, no-cache'
	if (ifNoneMatchMatches(ifNoneMatch, etag))
		return { status: 304, body: new Uint8Array(), headers: { 'ETag': etag, 'Cache-Control': cacheControl } }

	return {
		status: 200,
		body: contentBytes,
		headers: {
			'Content-Type': mediaType,
			'Content-Length': String(contentBytes.byteLength),
			'ETag': etag,
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': formatContentDisposition(declaredFilename),
			// The bytes at a digest never change (a change answers 409) but the headers come from metadata that can,
			// so the digest URL is revalidated by ETag rather than cached as immutable; the plain URL follows
			// replacements, so it is not stored.
			'Cache-Control': cacheControl,
			...storedContentSecurityHeaders(mediaType, contentBytes),
		},
	}
}

export async function readArtifactForHttp(persistence: FileNativePersistence, digest: string): Promise<AuthoringHttpResult> {
	if (!isSha256Digest(digest)) {
		return {
			status: 400,
			body: { code: 'invalid_artifact_identity', message: 'Artifact identity must be sha256:<64 lowercase hex characters>.' },
		}
	}

	const bytes = await persistence.artifacts.read(digest)
	if (!bytes) {
		return {
			status: 404,
			body: { code: 'artifact_not_found', identity: digest },
		}
	}

	let contentType = 'application/octet-stream'
	let extension = 'bin'
	if (
		bytes.byteLength >= 8
		&& bytes[0] === 0x89
		&& bytes[1] === 0x50
		&& bytes[2] === 0x4e
		&& bytes[3] === 0x47
		&& bytes[4] === 0x0d
		&& bytes[5] === 0x0a
		&& bytes[6] === 0x1a
		&& bytes[7] === 0x0a
	) {
		contentType = 'image/png'
		extension = 'png'
	}
	else if (
		bytes.byteLength >= 2
		&& (bytes[0] === 0x7b || bytes[0] === 0x5b) // '{' or '['
	) {
		try {
			JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
			contentType = 'application/json; charset=utf-8'
			extension = 'json'
		}
		catch {
			// fallback to octet-stream
		}
	}

	const hex = digest.slice('sha256:'.length)
	const filename = `${hex}.${extension}`

	return {
		status: 200,
		body: bytes,
		headers: {
			'Content-Type': contentType,
			'Content-Length': String(bytes.byteLength),
			'ETag': `"${digest}"`,
			'X-Content-Type-Options': 'nosniff',
			'Cache-Control': 'public, max-age=31536000, immutable',
			'Content-Disposition': `inline; filename="${filename}"`,
			...storedContentSecurityHeaders(contentType, bytes),
		},
	}
}
