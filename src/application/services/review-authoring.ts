import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic, type JsonObject } from '../../domain/validation'
import {
	isAllowedReviewTransition,
	validateReviewThread,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewEvidenceRef,
	type ReviewHistoryEvent,
	type ReviewMessage,
	type ReviewResourceRevision,
	type ReviewSubmission,
	type ReviewThread,
} from '../../domain/reviews/schema'
import type { Decision, DecisionActor, DecisionHistoryEntry, DecisionOutcome, DecisionStatus } from '../../domain/spec/schema'
import type { ViewResource } from '../../domain/views/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateReviewThreadCommand = Readonly<{
	id?: string
	anchor: ReviewAnchor
	variantNames?: readonly string[]
}>

export type AppendReviewMessageCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	actor: ReviewActor
	body: string
	id?: string
	at?: string
}>

export type ReanchorReviewThreadCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	anchor: ReviewAnchor
	variantNames?: readonly string[]
	actor: ReviewActor
	reason?: string
	id?: string
	at?: string
}>

export type SubmitReadyForReviewCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	actor: ReviewActor
	changeDomains: readonly string[]
	resources: readonly ReviewResourceRevision[]
	scope?: JsonObject
	evidenceRefs: readonly ReviewEvidenceRef[]
	reason?: string
	id?: string
	at?: string
	submissionId?: string
}>

export type ResolveReviewThreadCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	actor: ReviewActor
	submissionId?: string
	reason?: string
	id?: string
	at?: string
}>

export type ReopenReviewThreadCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	actor: ReviewActor
	reason?: string
	id?: string
	at?: string
}>

export type PromoteReviewToDecisionCommand = Readonly<{
	reviewId: string
	expectedReviewRevision: string
	viewId: string
	expectedViewRevision: string
	question: string
	outcome?: DecisionOutcome
	actor?: DecisionActor
	decisionId?: string
}>

export type ReviewAuthoringResult =
	| Readonly<{
			status: 'created' | 'updated'
			key: string
			revision: ResourceRevision
			diagnostics: readonly Diagnostic[]
			view?: Readonly<{ key: string; revision: ResourceRevision; resourceUri: string }>
			targetView?: Readonly<{ key: string; revision: ResourceRevision; resourceUri: string }>
			decision?: import('../../domain/spec/schema').Decision
	  }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{
			status: 'conflict'
			key: string
			currentRevision?: ResourceRevision
			conflicts?: readonly Readonly<{
				resource: 'review' | 'view'
				key: string
				expectedRevision: ResourceRevision
				currentRevision: ResourceRevision
			}>[]
	  }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'blocked'; key: string; code?: string; message?: string; diagnostics?: readonly Diagnostic[] }>

export type ReviewAuthoringService = Readonly<{
	createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult>
	appendReviewMessage(command: AppendReviewMessageCommand): Promise<ReviewAuthoringResult>
	reanchorReviewThread(command: ReanchorReviewThreadCommand): Promise<ReviewAuthoringResult>
	submitReadyForReview(command: SubmitReadyForReviewCommand): Promise<ReviewAuthoringResult>
	resolveReviewThread(command: ResolveReviewThreadCommand): Promise<ReviewAuthoringResult>
	reopenReviewThread(command: ReopenReviewThreadCommand): Promise<ReviewAuthoringResult>
	promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult>
}>

export function createReviewAuthoringService(persistence: FileNativePersistence): ReviewAuthoringService {
	async function createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult> {
		const id = command.id ?? randomUUID()
		const resource: ReviewThread = {
			id,
			anchor: command.anchor,
			variantNames: Array.isArray(command.variantNames) ? [...command.variantNames] : [],
			status: 'open',
			messages: [],
			history: [],
			submissions: [],
		}
		const validation = validateReviewThread(resource)
		if (!validation.ok)
			return { status: 'invalid', key: id, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.reviews.create(id, resource)
			const inspected = await persistence.reviews.readInspected(id)
			return { status: 'created', key: id, revision, diagnostics: inspected?.diagnostics ?? [] }
		}
		catch (error) {
			if (!(error instanceof PersistenceError) || error.code !== 'persistence.resource_exists') throw error
			const currentRevision = await persistence.reviews.readRevision(id)
			return { status: 'already_exists', key: id, ...(currentRevision ? { currentRevision } : {}) }
		}
	}

	async function appendReviewMessage(command: AppendReviewMessageCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		const message: ReviewMessage = {
			id: command.id ?? randomUUID(),
			actor: command.actor,
			at: command.at ?? new Date().toISOString(),
			body: command.body,
		}

		const next: ReviewThread = {
			...current.resource,
			messages: [...current.resource.messages, message],
		}
		const validation = validateReviewThread(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await persistence.reviews.compareAndSwap({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function reanchorReviewThread(command: ReanchorReviewThreadCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		const id = command.id ?? randomUUID()
		const at = command.at ?? new Date().toISOString()
		const variantNames = Array.isArray(command.variantNames) ? [...command.variantNames] : []
		const event: ReviewHistoryEvent = {
			id,
			kind: 'reanchor',
			actor: command.actor,
			at,
			before: { anchor: current.resource.anchor, variantNames: current.resource.variantNames },
			after: { anchor: command.anchor, variantNames },
			...(command.reason ? { reason: command.reason } : {}),
		}

		const next: ReviewThread = {
			...current.resource,
			anchor: command.anchor,
			variantNames,
			history: [...current.resource.history, event],
		}
		const validation = validateReviewThread(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await persistence.reviews.compareAndSwap({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function submitReadyForReview(command: SubmitReadyForReviewCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		if (!isAllowedReviewTransition(current.resource.status, 'ready-for-review')) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_transition', path: '/status', message: `Review cannot transition from ${current.resource.status} to ready-for-review.` }],
			}
		}

		const submissionId = command.submissionId ?? randomUUID()
		const at = command.at ?? new Date().toISOString()
		const submission: ReviewSubmission = {
			id: submissionId,
			actor: command.actor,
			at,
			changeDomains: Array.isArray(command.changeDomains) ? [...command.changeDomains] : [],
			resources: Array.isArray(command.resources) ? [...command.resources] : [],
			scope: typeof command.scope === 'object' && command.scope !== null && !Array.isArray(command.scope) ? { ...command.scope } : {},
			evidenceRefs: Array.isArray(command.evidenceRefs) ? [...command.evidenceRefs] : [],
		}

		const event: ReviewHistoryEvent = {
			id: command.id ?? randomUUID(),
			kind: 'lifecycle',
			actor: command.actor,
			at,
			from: current.resource.status,
			to: 'ready-for-review',
			submissionId,
			...(command.reason ? { reason: command.reason } : {}),
		}

		const next: ReviewThread = {
			...current.resource,
			status: 'ready-for-review',
			submissions: [...current.resource.submissions, submission],
			history: [...current.resource.history, event],
		}
		const validation = validateReviewThread(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await persistence.reviews.compareAndSwap({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function resolveReviewThread(command: ResolveReviewThreadCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		if (command.actor?.type !== 'human') {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.resolve_requires_human', path: '/actor/type', message: 'Only a human actor may resolve a Review thread.' }],
			}
		}

		if (!isAllowedReviewTransition(current.resource.status, 'resolved')) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_transition', path: '/status', message: `Review cannot transition from ${current.resource.status} to resolved.` }],
			}
		}

		const activeSubmissionId = current.resource.submissions.at(-1)?.id
		const submissionId = command.submissionId ?? activeSubmissionId
		const at = command.at ?? new Date().toISOString()
		const event: ReviewHistoryEvent = {
			id: command.id ?? randomUUID(),
			kind: 'lifecycle',
			actor: command.actor,
			at,
			from: current.resource.status,
			to: 'resolved',
			...(submissionId ? { submissionId } : {}),
			...(command.reason ? { reason: command.reason } : {}),
		}

		const next: ReviewThread = {
			...current.resource,
			status: 'resolved',
			history: [...current.resource.history, event],
		}
		const validation = validateReviewThread(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await persistence.reviews.compareAndSwap({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function reopenReviewThread(command: ReopenReviewThreadCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		if (!isAllowedReviewTransition(current.resource.status, 'open')) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_transition', path: '/status', message: `Review cannot transition from ${current.resource.status} to open.` }],
			}
		}

		const at = command.at ?? new Date().toISOString()
		const event: ReviewHistoryEvent = {
			id: command.id ?? randomUUID(),
			kind: 'lifecycle',
			actor: command.actor,
			at,
			from: current.resource.status,
			to: 'open',
			...(command.reason ? { reason: command.reason } : {}),
		}

		const next: ReviewThread = {
			...current.resource,
			status: 'open',
			history: [...current.resource.history, event],
		}
		const validation = validateReviewThread(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await persistence.reviews.compareAndSwap({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}
		if (!isFullUuid(command.viewId))
			return {
				status: 'invalid',
				key: command.viewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/viewId', message: 'View id must be a full UUID.' }],
			}

		const expectedReviewRevision = validateResourceRevision(command.expectedReviewRevision, '/expectedReviewRevision')
		if (!expectedReviewRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedReviewRevision.diagnostics }

		const expectedViewRevision = validateResourceRevision(command.expectedViewRevision, '/expectedViewRevision')
		if (!expectedViewRevision.ok)
			return { status: 'invalid_expected_revision', key: command.viewId, diagnostics: expectedViewRevision.diagnostics }

		if (typeof command.question !== 'string' || command.question.trim().length === 0) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'decision.empty_question', path: '/question', message: 'Decision question must be a non-empty string.' }],
			}
		}
		if (command.decisionId && !isFullUuid(command.decisionId)) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/decisionId', message: 'Decision id must be a full UUID.' }],
			}
		}

		const review = await persistence.reviews.read(command.reviewId)
		if (!review) return { status: 'not_found', key: command.reviewId }

		const view = await persistence.views.read(command.viewId)
		if (!view) return { status: 'not_found', key: command.viewId }

		if (review.revision !== expectedReviewRevision.value && view.revision !== expectedViewRevision.value) {
			return {
				status: 'conflict',
				key: command.reviewId,
				currentRevision: review.revision,
				conflicts: [
					{ resource: 'review', key: command.reviewId, expectedRevision: expectedReviewRevision.value, currentRevision: review.revision },
					{ resource: 'view', key: command.viewId, expectedRevision: expectedViewRevision.value, currentRevision: view.revision },
				],
			}
		}
		if (review.revision !== expectedReviewRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: review.revision }
		if (view.revision !== expectedViewRevision.value)
			return { status: 'conflict', key: command.viewId, currentRevision: view.revision }

		// Idempotency: check if View already has a Decision with provenance for this reviewId
		const existingDecision = view.resource.spec.decisions?.find(d =>
			d.provenance?.reviewId === command.reviewId
			|| d.provenance?.sourceReviewThreadId === command.reviewId
			|| (command.decisionId && d.id === command.decisionId),
		)
		if (existingDecision) {
			const inspected = await persistence.views.readInspected(command.viewId)
			return {
				status: 'updated',
				key: command.reviewId,
				revision: review.revision,
				view: {
					key: command.viewId,
					revision: view.revision,
					resourceUri: `uiux://view/${command.viewId}`,
				},
				targetView: {
					key: command.viewId,
					revision: view.revision,
					resourceUri: `uiux://view/${command.viewId}`,
				},
				decision: existingDecision,
				diagnostics: inspected?.diagnostics ?? [],
			}
		}

		const decisionId = command.decisionId ?? randomUUID()
		const now = new Date().toISOString()
		const hasOutcome = command.outcome !== undefined
		const status: DecisionStatus = hasOutcome ? 'decided' : 'pending'
		const history: DecisionHistoryEntry[] = hasOutcome
			? [{
					at: now,
					...(command.actor ? { actor: command.actor } : {}),
					source: { reviewId: command.reviewId },
					before: { status: 'pending' },
					after: { status: 'decided', outcome: command.outcome },
			  }]
			: []

		const newDecision: Decision = {
			id: decisionId,
			question: command.question,
			status,
			...(hasOutcome && command.outcome ? { outcome: command.outcome } : {}),
			history,
			provenance: {
				reviewId: command.reviewId,
				sourceReviewThreadId: command.reviewId,
			},
		}

		const nextView: ViewResource = {
			...view.resource,
			spec: {
				...view.resource.spec,
				decisions: [...(view.resource.spec.decisions ?? []), newDecision],
			},
		}

		const nextReview: ReviewThread = {
			...review.resource,
		}

		const commit = await persistence.atomicReviewViewPromotionCas({
			reviewId: command.reviewId,
			expectedReviewRevision: expectedReviewRevision.value,
			reviewResource: nextReview,
			viewId: command.viewId,
			expectedViewRevision: expectedViewRevision.value,
			viewResource: nextView,
		})

		if (!commit.ok) {
			const firstConflict = commit.conflict.conflicts[0]!
			return {
				status: 'conflict',
				key: firstConflict.key,
				currentRevision: firstConflict.currentRevision,
				conflicts: commit.conflict.conflicts,
			}
		}

		const inspected = await persistence.views.readInspected(command.viewId)
		return {
			status: 'updated',
			key: command.reviewId,
			revision: commit.reviewRevision,
			view: {
				key: command.viewId,
				revision: commit.viewRevision,
				resourceUri: `uiux://view/${command.viewId}`,
			},
			targetView: {
				key: command.viewId,
				revision: commit.viewRevision,
				resourceUri: `uiux://view/${command.viewId}`,
			},
			decision: newDecision,
			diagnostics: inspected?.diagnostics ?? [],
		}
	}

	return {
		createReviewThread,
		appendReviewMessage,
		reanchorReviewThread,
		submitReadyForReview,
		resolveReviewThread,
		reopenReviewThread,
		promoteReviewToDecision,
	}
}
