import { randomUUID } from 'node:crypto'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isFullUuid, type Diagnostic, type JsonObject } from '../../domain/validation'
import {
	isAllowedReviewTransition,
	isMessageFrozen,
	isReviewResolution,
	isWidgetAnchor,
	isWorkspaceAnchor,
	normalizeReviewPinCoordinate,
	validateReviewEvidenceRef,
	validateReviewRenderContextInput,
	validateReviewThread,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewDisplayHint,
	type ReviewEvidenceRef,
	type ReviewHistoryEvent,
	type ReviewMessage,
	type ReviewMessageEdit,
	type ReviewRenderContext,
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
import { viewRelativePath } from '../../persistence/paths'

export type CreateReviewThreadCommand = Readonly<{
	id?: string
	anchor: ReviewAnchor
	variantNames?: readonly string[]
	/** Optional non-authoritative pin placement; omitted means no hint (default placement). */
	displayHint?: ReviewDisplayHint
	/**
	 * Optional render context the feedback was raised in (Widget anchors only). Each member must name
	 * a key that exists in the Workspace at write time; omitted means unknown.
	 */
	renderContext?: ReviewRenderContext
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
	/**
	 * Tri-state (owner ruling, Discussion #7, 2026-10-09): an object sets the render context, `null`
	 * clears it, and omitted keeps the recorded one. A re-anchor to the Workspace arm always clears an
	 * omitted one and refuses an object. A new object is checked against the Workspace keys at write
	 * time; a kept one is never re-checked, since a stale key never invalidates the thread.
	 */
	renderContext?: ReviewRenderContext | null
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

/** Replace the text of the caller's own message (author only; the stamped actor is compared). */
export type EditReviewMessageCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	messageId: string
	body: string
	actor: ReviewActor
	editId?: string
	at?: string
}>

/**
 * Author quick retract: hard-delete a brand-new thread nobody engaged with. `actor` is the stamped
 * requester, used only for the author check (skipped for an empty thread); nothing is recorded.
 */
export type RetractReviewThreadCommand = Readonly<{
	reviewId: string
	expectedRevision: string
	actor: ReviewActor
}>

/** Why a retract was refused as engaged (decision 2, E1–E6). */
export type RetractEngagedReason = 'status' | 'messages' | 'history' | 'submissions' | 'promoted'

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
	/** Retract only: the thread file was removed; no revision exists any more. */
	| Readonly<{ status: 'deleted'; key: string }>
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
	| Readonly<{ status: 'blocked'; key: string; code?: string; message?: string; reason?: RetractEngagedReason; diagnostics?: readonly Diagnostic[] }>

export type ReviewAuthoringService = Readonly<{
	createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult>
	appendReviewMessage(command: AppendReviewMessageCommand): Promise<ReviewAuthoringResult>
	reanchorReviewThread(command: ReanchorReviewThreadCommand): Promise<ReviewAuthoringResult>
	submitReadyForReview(command: SubmitReadyForReviewCommand): Promise<ReviewAuthoringResult>
	resolveReviewThread(command: ResolveReviewThreadCommand): Promise<ReviewAuthoringResult>
	reopenReviewThread(command: ReopenReviewThreadCommand): Promise<ReviewAuthoringResult>
	setReviewDisplayHint(command: SetReviewDisplayHintCommand): Promise<ReviewAuthoringResult>
	promoteReviewToDecision(command: PromoteReviewToDecisionCommand): Promise<ReviewAuthoringResult>
	editReviewMessage(command: EditReviewMessageCommand): Promise<ReviewAuthoringResult>
	retractReviewThread(command: RetractReviewThreadCommand): Promise<ReviewAuthoringResult>
}>

/** Messages written by a stamped member principal; older and self-asserted actors can never match one (R19, T15). */
export function isMemberActorId(id: unknown): id is string {
	return typeof id === 'string' && /^member:[0-9a-f-]{36}$/iu.test(id)
}

function sameStampedActor(left: ReviewActor | undefined, right: ReviewActor | undefined): boolean {
	return !!left && !!right && isMemberActorId(left.id) && left.id === right.id && left.type === right.type
}

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

	/**
	 * An incoming render context. Omitted stays unknown; anything else must have the decoder's shape
	 * and name only keys the Workspace has at write time (owner ruling, Discussion #7, 2026-10-09):
	 * viewport and theme ids authored in the manifest (a built-in fallback such as `default` or
	 * `light` is not a key unless authored) and a Locale that has an i18n file or is the default
	 * Locale. Every unknown key is reported, and nothing is written.
	 *
	 * The check reads the manifest and the i18n directory outside the Review write lock. If a key is
	 * removed between this check and the write, the thread records a stale key, which the spec allows
	 * (a key that stops existing never invalidates the thread).
	 */
	async function checkRenderContextInput(input: unknown, anchor: ReviewAnchor): Promise<
		| Readonly<{ ok: true; value: ReviewRenderContext | undefined }>
		| Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }>
	> {
		if (input === undefined) return { ok: true, value: undefined }
		const shape = validateReviewRenderContextInput(input, '/renderContext', anchor)
		if (!shape.ok) return shape
		const { locale, viewportId, themeId } = shape.value
		const manifest = (await persistence.workspace.readInspected()).resource
		const locales = new Set(await persistence.locales.discover())
		if (typeof manifest?.i18n?.defaultLocale === 'string') locales.add(manifest.i18n.defaultLocale)
		const diagnostics: Diagnostic[] = []
		if (locale !== undefined && !locales.has(locale))
			diagnostics.push({ code: 'review.render_context_unknown_key', path: '/renderContext/locale', message: `Locale ${locale} is not in this Workspace: it has no i18n file and is not the default Locale.` })
		if (viewportId !== undefined && !Object.hasOwn(manifest?.viewports ?? {}, viewportId))
			diagnostics.push({ code: 'review.render_context_unknown_key', path: '/renderContext/viewportId', message: `Viewport ${viewportId} is not authored in this Workspace's viewports.` })
		if (themeId !== undefined && !Object.hasOwn(manifest?.themes ?? {}, themeId))
			diagnostics.push({ code: 'review.render_context_unknown_key', path: '/renderContext/themeId', message: `Theme ${themeId} is not authored in this Workspace's themes.` })
		if (diagnostics.length > 0) return { ok: false, diagnostics }
		return {
			ok: true,
			value: { ...(locale !== undefined ? { locale } : {}), ...(viewportId !== undefined ? { viewportId } : {}), ...(themeId !== undefined ? { themeId } : {}) },
		}
	}

	/**
	 * Review CAS that reports a thread deleted between the read and the write (an author retract, or
	 * an out-of-band delete) as `not_found` instead of throwing.
	 */
	async function casReview(input: Parameters<typeof persistence.reviews.compareAndSwap>[0]) {
		try {
			return await persistence.reviews.compareAndSwap(input)
		}
		catch (error) {
			if (error instanceof PersistenceError && error.code === 'persistence.resource_not_found') return { ok: false as const, gone: true as const }
			throw error
		}
	}

	async function createReviewThread(command: CreateReviewThreadCommand): Promise<ReviewAuthoringResult> {
		const id = command.id ?? randomUUID()
		const blocked = await blockedUnlessWritable(id)
		if (blocked) return blocked
		const hint = normalizeDisplayHintInput(command.displayHint, '/displayHint')
		if (!hint.ok) return { status: 'invalid', key: id, diagnostics: hint.diagnostics }
		const context = await checkRenderContextInput(command.renderContext, command.anchor)
		if (!context.ok) return { status: 'invalid', key: id, diagnostics: context.diagnostics }
		const resource: ReviewThread = {
			id,
			anchor: command.anchor,
			variantNames: Array.isArray(command.variantNames) ? [...command.variantNames] : [],
			...(hint.value ? { displayHint: hint.value } : {}),
			...(context.value ? { renderContext: context.value } : {}),
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

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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
		// Owner ruling (Discussion #7, 2026-10-09): an object sets the render context, null clears it,
		// and omitted keeps the recorded one; a re-anchor to the Workspace arm clears an omitted one and
		// refuses an object. A kept context is never re-checked: a stale key never invalidates the thread.
		// Both sides of the event record it.
		const currentRenderContext = current.resource.renderContext
		const requestedContext = await checkRenderContextInput(command.renderContext ?? undefined, command.anchor)
		if (!requestedContext.ok) return { status: 'invalid', key: command.reviewId, diagnostics: requestedContext.diagnostics }
		const renderContext = command.renderContext !== undefined
			? requestedContext.value
			: isWorkspaceAnchor(command.anchor) ? undefined : currentRenderContext
		const event: ReviewHistoryEvent = {
			id,
			kind: 'reanchor',
			actor: command.actor,
			at,
			before: { anchor: current.resource.anchor, variantNames: current.resource.variantNames, ...(currentRenderContext ? { renderContext: currentRenderContext } : {}) },
			after: { anchor: command.anchor, variantNames, ...(renderContext ? { renderContext } : {}) },
			...(command.reason ? { reason: command.reason } : {}),
		}

		const requestedHint = command.displayHint === null ? { ok: true as const, value: undefined } : normalizeDisplayHintInput(command.displayHint, '/displayHint')
		if (!requestedHint.ok) return { status: 'invalid', key: command.reviewId, diagnostics: requestedHint.diagnostics }
		const widgetIdentityChanged = !sameWidgetIdentity(current.resource.anchor, command.anchor)
		// An explicit object or null always wins; omitted clears on a Widget change and keeps on a Variant-only change.
		const displayHint = command.displayHint !== undefined
			? requestedHint.value
			: widgetIdentityChanged ? undefined : current.resource.displayHint
		const next: ReviewThread = {
			...withoutRenderContext(withoutDisplayHint(current.resource)),
			anchor: command.anchor,
			variantNames,
			...(displayHint ? { displayHint } : {}),
			...(renderContext ? { renderContext } : {}),
			history: [...current.resource.history, event],
		}
		const validation = validateCandidate(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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
		// The target set (decision 4): a Widget thread's anchor View; a Workspace thread's manifest plus
		// every View the submission names, each existing, valid and named at its current revision.
		const targets = await submissionTargets(current.resource.anchor, command.resources)
		if (!targets.ok) return { status: 'invalid', key: command.reviewId, diagnostics: targets.diagnostics }
		const currentViewRevisions = targets.views

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
					const capturedViewId = formal.ok ? (formal.value.executionContext as Record<string, unknown>).viewId : undefined
					const capturedRevision = typeof capturedViewId === 'string' ? currentViewRevisions.get(capturedViewId) : undefined
					if (!formal.ok || formal.value.kind !== 'formal_capture' || typeof capturedViewId !== 'string' || capturedRevision === undefined
						|| !isCompleteEvidenceForViewRevision(formal.value, capturedViewId, capturedRevision)) {
						evidenceDiagnostics.push({
							code: 'review.formal_evidence_not_current',
							path: `${path}/evidence`,
							message: targets.workspace
								? `Formal evidence ${validation.value.evidence} must be complete for the current revision of the View it captured, and that View must be named in resources.`
								: `Formal evidence ${validation.value.evidence} must be complete and match current target View ${[...currentViewRevisions.keys()][0]} revision ${[...currentViewRevisions.values()][0]}.`,
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

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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

		if (isWorkspaceAnchor(current.resource.anchor))
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{ code: 'review.display_hint_without_widget', path: '/displayHint', message: 'A Workspace-scoped thread has no Widget, so it has no pin and no display hint.' }],
			}

		// Display data only: no history event, no actor, no timeline entry.
		const next: ReviewThread = { ...withoutDisplayHint(current.resource), ...(hint.value ? { displayHint: hint.value } : {}) }
		const validation = validateCandidate(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await casReview({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			resource: next,
		})
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
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

		const reviewAnchor = review.resource.anchor
		if (!isWidgetAnchor(reviewAnchor)) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{
					code: 'review.decision_target_unavailable',
					path: '/reviewId',
					message: 'Workspace-scoped threads have no Decision home. Re-anchor the thread to a View\'s root to promote it there, or record the Decision with update_view_spec.',
				}],
			}
		}
		const view = await persistence.views.read(command.viewId)
		if (!view) return { status: 'not_found', key: command.viewId }
		if (reviewAnchor.viewId !== command.viewId) {
			return {
				status: 'invalid',
				key: command.reviewId,
				diagnostics: [{
					code: 'review.decision_target_mismatch',
					path: '/viewId',
					message: `Review ${command.reviewId} is anchored to View ${reviewAnchor.viewId} and cannot be promoted into View ${command.viewId}.`,
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

	type SubmissionTargets =
		| Readonly<{ ok: true; workspace: boolean; views: ReadonlyMap<string, ResourceRevision> }>
		| Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }>

	async function submissionTargets(anchor: ReviewAnchor, resources: readonly ReviewResourceRevision[]): Promise<SubmissionTargets> {
		const named = Array.isArray(resources) ? resources : []
		if (isWidgetAnchor(anchor)) {
			const targetViewId = anchor.viewId
			const targetView = await persistence.views.readInspected(targetViewId)
			if (!targetView)
				return { ok: false, diagnostics: [{ code: 'review.target_view_missing', path: '/resources', message: `Review target View ${targetViewId} does not exist.` }] }
			if (targetView.diagnostics.length > 0)
				return { ok: false, diagnostics: targetView.diagnostics.map(diagnostic => ({ ...diagnostic, path: `/resources${diagnostic.path || ''}` })) }
			const hasCurrentTargetView = named.some(resource => namedViewId(resource) === targetViewId && resource.revision === targetView.revision)
			if (!hasCurrentTargetView) {
				return {
					ok: false,
					diagnostics: [{
						code: 'review.target_view_revision_missing',
						path: '/resources',
						message: `Ready-for-review submission must include current target View ${targetViewId} revision ${targetView.revision}.`,
					}],
				}
			}
			return { ok: true, workspace: false, views: new Map([[targetViewId, targetView.revision]]) }
		}

		const manifest = await persistence.workspace.readInspected()
		const hasCurrentManifest = manifest.revision !== undefined && named.some((resource) => {
			const identity = resource.identity as Record<string, unknown>
			const identifiesWorkspace = (identity.type === 'workspace' && Object.keys(identity).length === 1)
				|| (identity.kind === 'workspace' && identity.key === 'workspace')
			return identifiesWorkspace && resource.revision === manifest.revision
		})
		if (!hasCurrentManifest) {
			return {
				ok: false,
				diagnostics: [{
					code: 'review.target_workspace_revision_missing',
					path: '/resources',
					message: `A Workspace-scoped submission must include the current Workspace manifest revision ${manifest.revision ?? '(missing)'} as { type: "workspace" }.`,
				}],
			}
		}
		const diagnostics: Diagnostic[] = []
		const views = new Map<string, ResourceRevision>()
		for (const [index, resource] of named.entries()) {
			const viewId = namedViewId(resource)
			if (viewId === undefined) continue
			const path = `/resources/${index}`
			const view = isFullUuid(viewId) ? await persistence.views.readInspected(viewId) : undefined
			if (!view) {
				diagnostics.push({ code: 'review.target_view_missing', path, message: `View ${viewId} named in the submission does not exist.` })
				continue
			}
			if (view.diagnostics.length > 0) {
				diagnostics.push(...view.diagnostics.map(diagnostic => ({ ...diagnostic, path: `${path}${diagnostic.path || ''}` })))
				continue
			}
			if (resource.revision !== view.revision) {
				diagnostics.push({ code: 'review.resource_revision_not_current', path: `${path}/revision`, message: `View ${viewId} is named at revision ${resource.revision}; its current revision is ${view.revision}.` })
				continue
			}
			views.set(viewId, view.revision)
		}
		if (diagnostics.length > 0) return { ok: false, diagnostics }
		return { ok: true, workspace: true, views }
	}

	async function editReviewMessage(command: EditReviewMessageCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }] }
		if (!isFullUuid(command.messageId))
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'identity.invalid_uuid', path: '/messageId', message: 'Message id must be a full UUID.' }] }
		if (command.editId !== undefined && !isFullUuid(command.editId))
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'identity.invalid_uuid', path: '/editId', message: 'Edit id must be a full UUID.' }] }
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }

		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked
		const current = await persistence.reviews.read(command.reviewId)
		if (!current) return { status: 'not_found', key: command.reviewId }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.reviewId, currentRevision: current.revision }

		const index = current.resource.messages.findIndex(message => message.id === command.messageId)
		const message = current.resource.messages[index]
		if (!message)
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'review.unknown_message', path: '/messageId', message: `Review ${command.reviewId} has no message ${command.messageId}.` }] }
		if (!sameStampedActor(message.actor, command.actor)) {
			const text = isMemberActorId(message.actor?.id)
				? 'Only the author of a message may edit it. Reply instead.'
				: 'This message was written before authors were identified, so no one can prove authorship and it cannot be edited. Reply instead.'
			return { status: 'blocked', key: command.reviewId, code: 'review.message_edit_not_author', message: text, diagnostics: [{ code: 'review.message_edit_not_author', path: '/messageId', message: text }] }
		}
		const freeze = isMessageFrozen(current.resource, message.id)
		if (freeze.frozen) {
			const text = `This message can't be edited: a later ${freeze.by === 'submission' ? `ready-for-review submission (${freeze.id})` : `resolution (${freeze.id})`} answered the conversation as it stood. Reply instead.`
			return { status: 'blocked', key: command.reviewId, code: 'review.message_edit_after_formal_act', message: text, diagnostics: [{ code: 'review.message_edit_after_formal_act', path: '/messageId', message: text }] }
		}
		if (typeof command.body !== 'string' || command.body.trim().length === 0)
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'review.message_body_empty', path: '/body', message: 'An edit must leave non-empty text; editing never deletes a message.' }] }
		if (command.body === message.body)
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'review.message_edit_noop', path: '/body', message: 'The new text is the same as the current text.' }] }

		const edit: ReviewMessageEdit = {
			id: command.editId ?? randomUUID(),
			actor: command.actor,
			at: command.at ?? new Date().toISOString(),
			previousBody: message.body,
		}
		const edited: ReviewMessage = { ...message, body: command.body, edits: [...(message.edits ?? []), edit] }
		const next: ReviewThread = {
			...current.resource,
			messages: current.resource.messages.map((candidate, position) => position === index ? edited : candidate),
		}
		const validation = validateCandidate(next)
		if (!validation.ok)
			return { status: 'invalid', key: command.reviewId, diagnostics: validation.diagnostics }

		const commit = await casReview({ key: command.reviewId, expectedRevision: expectedRevision.value, resource: next })
		if (!commit.ok)
			return 'gone' in commit ? { status: 'not_found', key: command.reviewId } : { status: 'conflict', key: command.reviewId, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.reviews.readInspected(command.reviewId)
		return { status: 'updated', key: command.reviewId, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	async function retractReviewThread(command: RetractReviewThreadCommand): Promise<ReviewAuthoringResult> {
		if (!isFullUuid(command.reviewId))
			return { status: 'invalid', key: command.reviewId, diagnostics: [{ code: 'identity.invalid_uuid', path: '/reviewId', message: 'Review id must be a full UUID.' }] }
		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.reviewId, diagnostics: expectedRevision.diagnostics }
		const blocked = await blockedUnlessWritable(command.reviewId)
		if (blocked) return blocked

		type Refusal = Readonly<{ code: 'review.retract_not_author' } | { code: 'review.retract_engaged'; reason: RetractEngagedReason }>
		const outcome = await persistence.reviews.deleteIfRevision<Refusal>({
			key: command.reviewId,
			expectedRevision: expectedRevision.value,
			// Every check runs on exactly the bytes being deleted, inside the delete's exclusive lock.
			guard: async (thread, context) => {
				const messages = Array.isArray(thread.messages) ? thread.messages : []
				if (messages.length > 0 && !sameStampedActor(messages[0]!.actor, command.actor))
					return { code: 'review.retract_not_author' }
				if (thread.status !== 'open') return { code: 'review.retract_engaged', reason: 'status' }
				if (messages.length > 1) return { code: 'review.retract_engaged', reason: 'messages' }
				if (!Array.isArray(thread.history) || thread.history.length > 0) return { code: 'review.retract_engaged', reason: 'history' }
				if (!Array.isArray(thread.submissions) || thread.submissions.length > 0) return { code: 'review.retract_engaged', reason: 'submissions' }
				// E6: promotion leaves no trace in the Review file, so read the anchor View (E4 guarantees
				// the anchor never changed). Workspace threads cannot be promoted.
				if (isWidgetAnchor(thread.anchor) && isFullUuid(thread.anchor.viewId)) {
					const view = await context.readJsonUnlocked(viewRelativePath(thread.anchor.viewId)) as ViewResource | undefined
					if (view && decisionNamesThread(view, command.reviewId)) return { code: 'review.retract_engaged', reason: 'promoted' }
				}
				return undefined
			},
		})
		switch (outcome.status) {
			case 'deleted': return { status: 'deleted', key: command.reviewId }
			case 'not_found': return { status: 'not_found', key: command.reviewId }
			case 'conflict': return { status: 'conflict', key: command.reviewId, currentRevision: outcome.currentRevision }
			case 'refused': {
				if (outcome.refusal.code === 'review.retract_not_author') {
					const text = 'Only the author of this thread can delete it. Dismiss it instead.'
					return { status: 'blocked', key: command.reviewId, code: 'review.retract_not_author', message: text, diagnostics: [{ code: 'review.retract_not_author', path: '/reviewId', message: text }] }
				}
				const text = 'Someone has already engaged with this thread. Dismiss it instead.'
				return {
					status: 'blocked',
					key: command.reviewId,
					code: 'review.retract_engaged',
					reason: outcome.refusal.reason,
					message: text,
					diagnostics: [{ code: 'review.retract_engaged', path: `/${outcome.refusal.reason}`, message: `${text} (${outcome.refusal.reason})` }],
				}
			}
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
		editReviewMessage,
		retractReviewThread,
	}
}

/** A View named by a submission resource: `{ type: "view", id }` or `{ kind: "view", key }`. */
function namedViewId(resource: ReviewResourceRevision): string | undefined {
	const identity = resource?.identity as Record<string, unknown> | undefined
	if (!identity) return undefined
	if (identity.type === 'view' && typeof identity.id === 'string') return identity.id
	if (identity.kind === 'view' && typeof identity.key === 'string') return identity.key
	return undefined
}

/** Same Widget identity: both Widget anchors on the same View and Widget, or both the Workspace. */
function sameWidgetIdentity(left: ReviewAnchor, right: ReviewAnchor): boolean {
	if (isWorkspaceAnchor(left) || isWorkspaceAnchor(right)) return isWorkspaceAnchor(left) && isWorkspaceAnchor(right)
	return left.viewId === right.viewId && left.widgetId === right.widgetId
}

/**
 * Whether any Decision in the View names the thread as its source, with the same matching the
 * Workbench's "from Review" link uses: provenance ids or a history entry's `source.reviewId`.
 */
function decisionNamesThread(view: ViewResource, reviewId: string): boolean {
	const decisions = (view as { spec?: { decisions?: unknown } })?.spec?.decisions
	if (!Array.isArray(decisions)) return false
	return decisions.some((decision) => {
		if (typeof decision !== 'object' || decision === null) return false
		const record = decision as { provenance?: { reviewId?: unknown; sourceReviewThreadId?: unknown }; history?: unknown }
		if (record.provenance?.reviewId === reviewId || record.provenance?.sourceReviewThreadId === reviewId) return true
		return Array.isArray(record.history) && record.history.some(entry =>
			typeof entry === 'object' && entry !== null && (entry as { source?: { reviewId?: unknown } }).source?.reviewId === reviewId)
	})
}

function withoutDisplayHint(thread: ReviewThread): ReviewThread {
	const copy: { -readonly [Key in keyof ReviewThread]?: ReviewThread[Key] } = { ...thread }
	delete copy.displayHint
	return copy as ReviewThread
}

function withoutRenderContext(thread: ReviewThread): ReviewThread {
	const copy: { -readonly [Key in keyof ReviewThread]?: ReviewThread[Key] } = { ...thread }
	delete copy.renderContext
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
