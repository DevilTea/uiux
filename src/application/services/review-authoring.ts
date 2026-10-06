import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic, type JsonObject } from '../../domain/validation'
import {
	isAllowedReviewTransition,
	isReviewResolution,
	normalizeReviewPinCoordinate,
	validateReviewEvidenceRef,
	validateReviewThread,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewDisplayHint,
	type ReviewEvidenceRef,
	type ReviewHistoryEvent,
	type ReviewMessage,
	type ReviewResolution,
	type ReviewResourceRevision,
	type ReviewSubmission,
	type ReviewThread,
} from '../../domain/reviews/schema'
import type { Decision, DecisionActor, DecisionHistoryEntry, DecisionOutcome, DecisionStatus } from '../../domain/spec/schema'
import type { ViewResource } from '../../domain/views/schema'
import { validateFormalEvidenceRecord } from '../../domain/evidence/schema'
import { isCompleteEvidenceForViewRevision } from '../../domain/evidence/staleness'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateReviewThreadCommand = Readonly<{
	id?: string
	anchor: ReviewAnchor
	variantNames?: readonly string[]
	/** Optional non-authoritative pin placement; omitted means no hint (default placement). */
	displayHint?: ReviewDisplayHint
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
	/**
	 * Tri-state: an object sets the hint for the new anchor, `null` clears it, and omitted clears it
	 * when Widget identity (viewId or widgetId) changes and keeps it when only Variants change.
	 */
	displayHint?: ReviewDisplayHint | null
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
	/**
	 * How the thread is resolved. Omitted means `verified` only from ready-for-review (backward
	 * compatible); from open it is required. Non-verified resolutions accept no submission.
	 */
	resolution?: ReviewResolution
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

export type SetReviewDisplayHintCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	/** The new hint, or `null` to clear it. Never appends history and records no actor. */
	displayHint: ReviewDisplayHint | null
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
	setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<ReviewAuthoringResult>
	promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult>
}>

export function createReviewAuthoringService(persistence: FileNativePersistence): ReviewAuthoringService {
	/** Writes only ever happen at the policy currentVersion, so candidates are validated under it. */
	function validateCandidate(resource: ReviewThread) {
		return validateReviewThread(resource, { schemaVersion: persistence.schemaPolicy.currentVersion })
	}

	/**
	 * Every Review mutation is rejected unless the Workspace is at the current schema version, before
	 * any candidate is built: a v1 file is never re-validated under v2 rules on the way to a write.
	 */
	async function blockedUnlessWritable(key: string): Promise<ReviewAuthoringResult | undefined> {
		const { inspection } = await persistence.inspectWorkspace()
		if (inspection.state === 'current') return undefined
		if (inspection.state === 'migration_required') {
			return {
				status: 'blocked',
				key,
				code: 'workspace.migration_required',
				message: `Workspace schemaVersion ${inspection.version} requires explicit migration to ${inspection.targetVersion}. Run: uiux migrate --workspace <dir>`,
				diagnostics: [{ code: 'workspace.migration_required', path: '/schemaVersion', message: `Workspace schema ${inspection.version} requires explicit migration to policy target ${inspection.targetVersion}.` }],
			}
		}
		const code = inspection.state === 'missing_manifest' ? 'workspace.manifest_missing' : 'workspace.schema_unsupported'
		return { status: 'blocked', key, code, message: 'Review mutations are blocked for this Workspace schema state.', diagnostics: inspection.diagnostics }
	}

	async function createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult> {
		const id = command.id ?? randomUUID()
		const blocked = await blockedUnlessWritable(id)
		if (blocked) return blocked
		const hint = normalizeDisplayHintInput(command.displayHint, '/displayHint')
		if (!hint.ok) return { status: 'invalid', key: id, diagnostics: hint.diagnostics }
		const resource: ReviewThread = {
			id,
			anchor: command.anchor,
			variantNames: Array.isArray(command.variantNames) ? [...command.variantNames] : [],
			...(hint.value ? { displayHint: hint.value } : {}),
			status: 'open',
			messages: [],
			history: [],
			submissions: [],
		}
		const validation = validateCandidate(resource)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
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
		const validation = validateCandidate(next)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
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

		const requestedHint = command.displayHint === null ? { ok: true as const, value: undefined } : normalizeDisplayHintInput(command.displayHint, '/displayHint')
		if (!requestedHint.ok) return { status: 'invalid', key: command.reviewId, diagnostics: requestedHint.diagnostics }
		const widgetIdentityChanged = current.resource.anchor.viewId !== command.anchor.viewId
			|| current.resource.anchor.widgetId !== command.anchor.widgetId
		// An explicit object or null always wins; omitted clears on a Widget change and keeps on a Variant-only change.
		const displayHint = command.displayHint !== undefined
			? requestedHint.value
			: widgetIdentityChanged ? undefined : current.resource.displayHint
		const next: ReviewThread = {
			...withoutDisplayHint(current.resource),
			anchor: command.anchor,
			variantNames,
			...(displayHint ? { displayHint } : {}),
			history: [...current.resource.history, event],
		}
		const validation = validateCandidate(next)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
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
		const targetViewId = current.resource.anchor.viewId
		const targetView = await persistence.views.readInspected(targetViewId)
		if (!targetView) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.target_view_missing', path: '/resources', message: `Review target View ${targetViewId} does not exist.` }],
			}
		}
		if (targetView.diagnostics.length > 0) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: targetView.diagnostics.map(diagnostic => ({
					...diagnostic,
					path: `/resources${diagnostic.path || ''}`,
				})),
			}
		}

		const hasCurrentTargetView = command.resources.some((resource) => {
			const identity = resource.identity as Record<string, unknown>
			const identifiesTarget = (identity.type === 'view' && identity.id === targetViewId)
				|| (identity.kind === 'view' && identity.key === targetViewId)
			return identifiesTarget && resource.revision === targetView.revision
		})
		if (!hasCurrentTargetView) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{
					code: 'review.target_view_revision_missing',
					path: '/resources',
					message: `Ready-for-review submission must include current target View ${targetViewId} revision ${targetView.revision}.`,
				}],
			}
		}

		const evidenceDiagnostics: Diagnostic[] = []
		for (const [index, ref] of command.evidenceRefs.entries()) {
			const path = `/evidenceRefs/${index}`
			const validation = validateReviewEvidenceRef(ref, path)
			if (!validation.ok) {
				evidenceDiagnostics.push(...validation.diagnostics)
				continue
			}
			try {
				const artifact = await persistence.artifacts.read(validation.value.evidence)
				if (!artifact) {
					evidenceDiagnostics.push({
						code: 'review.evidence_not_found',
						path: `${path}/evidence`,
						message: `Referenced Review evidence artifact ${validation.value.evidence} does not exist in the selected Workspace.`,
					})
					continue
				}
				if (validation.value.kind === 'formal_capture') {
					const candidate = await persistence.artifacts.readCandidateJson(validation.value.evidence)
					const formal = validateFormalEvidenceRecord(candidate)
					if (!formal.ok || formal.value.kind !== 'formal_capture' || !isCompleteEvidenceForViewRevision(formal.value, targetViewId, targetView.revision)) {
						evidenceDiagnostics.push({
							code: 'review.formal_evidence_not_current',
							path: `${path}/evidence`,
							message: `Formal evidence ${validation.value.evidence} must be complete and match current target View ${targetViewId} revision ${targetView.revision}.`,
						})
					}
				}
			}
			catch (cause) {
				evidenceDiagnostics.push({
					code: 'review.evidence_unreadable',
					path: `${path}/evidence`,
					message: cause instanceof Error ? cause.message : 'Referenced Review evidence artifact could not be read.',
				})
			}
		}
		if (evidenceDiagnostics.length > 0)
			return { status: 'invalid', key: command.reviewId, diagnostics: evidenceDiagnostics }

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
		const validation = validateCandidate(next)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
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

		if (command.resolution !== undefined && !isReviewResolution(command.resolution)) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_resolution', path: '/resolution', message: 'Resolution must be verified, answered, wont-fix, duplicate, or obsolete.' }],
			}
		}
		const status = current.resource.status
		if (status === 'resolved') {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_transition', path: '/status', message: 'Review cannot transition from resolved to resolved.' }],
			}
		}
		// Backward compatible: an omitted resolution means `verified` only from ready-for-review.
		// The API never defaults an open thread to a direct close.
		const resolution: ReviewResolution | undefined = command.resolution ?? (status === 'ready-for-review' ? 'verified' : undefined)
		if (resolution === undefined) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.resolution_required', path: '/resolution', message: 'Resolving an open thread requires an explicit non-verified resolution (answered, wont-fix, duplicate, or obsolete).' }],
			}
		}
		if (!isAllowedReviewTransition(status, 'resolved', resolution)) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.invalid_transition', path: '/resolution', message: `Review cannot transition from ${status} to resolved as ${resolution}; a verified resolution requires a ready-for-review submission.` }],
			}
		}
		if (resolution !== 'verified' && command.submissionId !== undefined) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.direct_resolve_submission_forbidden', path: '/submissionId', message: 'A non-verified resolution accepts no submission; omit submissionId.' }],
			}
		}
		if (resolution === 'duplicate' && (typeof command.reason !== 'string' || command.reason.trim().length === 0)) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.resolution_reason_required', path: '/reason', message: 'A duplicate resolution requires a reason naming the thread it duplicates.' }],
			}
		}

		// Only `verified` accepts a submission (defaulting to the latest); other kinds never fall back to it,
		// and a pending ready-for-review submission they close stays in submissions[] as not accepted.
		const submissionId = resolution === 'verified' ? command.submissionId ?? current.resource.submissions.at(-1)?.id : undefined
		const at = command.at ?? new Date().toISOString()
		const event: ReviewHistoryEvent = {
			id: command.id ?? randomUUID(),
			kind: 'lifecycle',
			actor: command.actor,
			at,
			from: status,
			to: 'resolved',
			...(submissionId ? { submissionId } : {}),
			...(command.reason ? { reason: command.reason } : {}),
			resolution,
		}

		const next: ReviewThread = {
			...current.resource,
			status: 'resolved',
			history: [...current.resource.history, event],
		}
		const validation = validateCandidate(next)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
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
		const validation = validateCandidate(next)
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

	async function setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		if (command.displayHint === undefined)
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.display_hint_required', path: '/displayHint', message: 'Provide a displayHint object to set the hint, or null to clear it.' }],
			}
		const hint = command.displayHint === null ? { ok: true as const, value: undefined } : normalizeDisplayHintInput(command.displayHint, '/displayHint')
		if (!hint.ok) return { status: 'invalid', key: command.reviewId, diagnostics: hint.diagnostics }

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		// Display data only: no history event, no actor, no timeline entry.
		const next: ReviewThread = { ...withoutDisplayHint(current.resource), ...(hint.value ? { displayHint: hint.value } : {}) }
		const validation = validateCandidate(next)
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

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
		const review = await persistence.reviews.read(command.reviewId)
		if (!review) return { status: 'not_found', key: command.reviewId }

		const view = await persistence.views.read(command.viewId)
		if (!view) return { status: 'not_found', key: command.viewId }
		if (review.resource.anchor.viewId !== command.viewId) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{
					code: 'review.decision_target_mismatch',
					path: '/viewId',
					message: `Review ${command.reviewId} is anchored to View ${review.resource.anchor.viewId} and cannot be promoted into View ${command.viewId}.`,
				}],
			}
		}

		// Idempotency precedes revision conflicts: retrying an already-committed promotion
		// with the original expected revisions returns the existing Decision instead of 409.
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
				view: { key: command.viewId, revision: view.revision, resourceUri: `uiux://view/${command.viewId}` },
				targetView: { key: command.viewId, revision: view.revision, resourceUri: `uiux://view/${command.viewId}` },
				decision: existingDecision,
				diagnostics: inspected?.diagnostics ?? [],
			}
		}

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
		setReviewDisplayHint,
		promoteReviewToDecision,
	}
}

function withoutDisplayHint(thread: ReviewThread): ReviewThread {
	const copy: { -readonly [Key in keyof ReviewThread]?: ReviewThread[Key] } = { ...thread }
	delete copy.displayHint
	return copy as ReviewThread
}

/**
 * Writer normalization for an incoming hint: the closed `{ pin: { x, y } }` shape is required, and
 * finite coordinates are clamped to [0, 1] and quantized to 1e-4 before persisting. Shape errors are
 * reported, never repaired.
 */
function normalizeDisplayHintInput(input: unknown, path: string):
	| Readonly<{ ok: true; value: ReviewDisplayHint | undefined }>
	| Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }> {
	if (input === undefined) return { ok: true, value: undefined }
	const diagnostics: Diagnostic[] = []
	if (!isPlainObject(input)) {
		diagnostics.push({ code: 'schema.expected_object', path, message: 'Expected a displayHint object.' })
		return { ok: false, diagnostics }
	}
	for (const key of Object.keys(input))
		if (key !== 'pin') diagnostics.push({ code: 'schema.unknown_field', path: `${path}/${key}`, message: 'Field is outside this canonical object shape.' })
	if (!Object.hasOwn(input, 'pin')) {
		diagnostics.push({ code: 'review.display_hint_empty', path, message: 'A displayHint must contain at least one member; omit the field instead of sending {}.' })
		return { ok: false, diagnostics }
	}
	const pin = input.pin
	if (!isPlainObject(pin)) {
		diagnostics.push({ code: 'schema.expected_object', path: `${path}/pin`, message: 'Expected a pin object.' })
		return { ok: false, diagnostics }
	}
	for (const key of Object.keys(pin))
		if (key !== 'x' && key !== 'y') diagnostics.push({ code: 'schema.unknown_field', path: `${path}/pin/${key}`, message: 'Field is outside this canonical object shape.' })
	for (const axis of ['x', 'y'] as const) {
		const value = pin[axis]
		if (typeof value !== 'number' || !Number.isFinite(value))
			diagnostics.push({ code: 'schema.expected_finite_number', path: `${path}/pin/${axis}`, message: 'Expected a finite number.' })
	}
	if (diagnostics.length > 0) return { ok: false, diagnostics }
	return {
		ok: true,
		value: { pin: { x: normalizeReviewPinCoordinate(pin.x as number), y: normalizeReviewPinCoordinate(pin.y as number) } },
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
