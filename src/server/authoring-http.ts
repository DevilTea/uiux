import { randomUUID } from 'node:crypto'
import { z } from 'zod'

import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import type { FileNativePersistence } from '../persistence'
import { isFullUuid, isSha256Digest, type JsonObject, type JsonValue } from '../domain/validation'
import type { ViewSpecContent } from '../application/services/view-authoring'
import type { VariantEntry } from '../domain/views/schema'
import type { WorkspaceSettingsUpdate } from '../application/services/workspace-authoring'
import type { I18nResource } from '../domain/i18n/schema'
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
}).strict()

const updateWorkspaceSettingsHttpSchema = z.object({
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
	})
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}

export async function updateWorkspaceSettingsForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const parsed = parseHttpPayload(updateWorkspaceSettingsHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const data = parsed.data
	const result = await app.updateWorkspaceSettings({
		expectedRevision: data.expectedRevision,
		settings: data.settings as WorkspaceSettingsUpdate,
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

export async function readAssetContentForHttp(persistence: FileNativePersistence, assetId: string): Promise<AuthoringHttpResult> {
	if (!isFullUuid(assetId))
		return { status: 400, body: { code: 'invalid_resource_address', message: 'Asset id must be a valid UUID.' } }

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

	return {
		status: 200,
		body: contentBytes,
		headers: {
			'Content-Type': mediaType,
			'Content-Length': String(contentBytes.byteLength),
			'ETag': `"${read.revision}"`,
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': formatContentDisposition(declaredFilename),
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
		},
	}
}
