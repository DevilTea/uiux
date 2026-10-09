import {
	isCanonicalLocaleTag,
	jsonPointer,
	rejectUnknownKeys,
	validateDigest,
	validateJsonValue,
	validateUuid,
	validateUtcTimestamp,
	Validator,
	type JsonObject,
	type ValidationResult,
} from '../validation'

export type ReviewStatus = 'open' | 'ready-for-review' | 'resolved'
/**
 * How a thread entered `resolved` (Workspace schemaVersion >= 2). Only `verified` accepts an
 * evidence-gated ready-for-review submission; every other kind explicitly closes the thread
 * without a verified change. Closed vocabulary: adding a value needs an architecture decision.
 */
export type ReviewResolution = 'verified' | 'answered' | 'wont-fix' | 'duplicate' | 'obsolete'
export const REVIEW_RESOLUTIONS = ['verified', 'answered', 'wont-fix', 'duplicate', 'obsolete'] as const satisfies readonly ReviewResolution[]
/** Normalized point inside the anchored Widget's full rendered rect; 0..1 on each axis, physical coordinates. */
export type ReviewPinHint = Readonly<{ x: number; y: number }>
/** Non-authoritative, closed display-hint container (schemaVersion >= 2). Never part of anchor identity. */
export type ReviewDisplayHint = Readonly<{ pin: ReviewPinHint }>
/**
 * The render context a Widget-arm thread was raised in (schemaVersion >= 4): Workspace-local keys of
 * a Locale, a viewport and a theme. At least one member; an absent member, or an absent
 * `renderContext`, means unknown. A key that later stops existing never invalidates the thread.
 */
export type ReviewRenderContext = Readonly<{ locale?: string; viewportId?: string; themeId?: string }>
/** Decoding context: every Review file is decoded under the selected Workspace's manifest schemaVersion. */
export type ReviewDecodeContext = Readonly<{ schemaVersion: number; filename?: string }>
export type ReviewActor = Readonly<{ type: string; id?: string; displayName?: string }>
/** The Widget arm (untagged, unchanged since v1): a thread about one Widget of one View. */
export type ReviewWidgetAnchor = Readonly<{ viewId: string; widgetId: string }>
/** The Workspace arm (schemaVersion >= 3): a thread about the product as a whole. */
export type ReviewWorkspaceAnchor = Readonly<{ scope: 'workspace' }>
/** Closed anchor union. Readers tell the arms apart by the presence of `scope`. */
export type ReviewAnchor = ReviewWidgetAnchor | ReviewWorkspaceAnchor
export type ReviewEvidenceRef = Readonly<{ kind: string; evidence: string }>
export type ReviewResourceRevision = Readonly<{ identity: JsonObject; revision: string }>
/** One replaced version of a message (schemaVersion >= 3): who replaced it, when, and the text it had. */
export type ReviewMessageEdit = Readonly<{ id: string; actor: ReviewActor; at: string; previousBody: string }>
/**
 * `body` is always the current text. `edits[]` (schemaVersion >= 3) is append-only and omitted when
 * the message was never edited; "edited" and "edited at" are derived from it, never stored.
 */
export type ReviewMessage = Readonly<{ id: string; actor: ReviewActor; at: string; body: string; edits?: readonly ReviewMessageEdit[] }>
export type ReviewSubmission = Readonly<{
	id: string
	actor: ReviewActor
	at: string
	changeDomains: readonly string[]
	resources: readonly ReviewResourceRevision[]
	scope: JsonObject
	evidenceRefs: readonly ReviewEvidenceRef[]
}>
/** What a re-anchor event records on each side; `renderContext` only under schemaVersion >= 4. */
export type ReviewAnchorScope = Readonly<{ anchor: ReviewAnchor; variantNames: readonly string[]; renderContext?: ReviewRenderContext }>
export type ReviewHistoryEvent = Readonly<{
	id: string
	kind: 'lifecycle' | 'reanchor'
	actor: ReviewActor
	at: string
	from?: ReviewStatus
	to?: ReviewStatus
	submissionId?: string
	before?: ReviewAnchorScope
	after?: ReviewAnchorScope
	reason?: string
	/** Lifecycle events only; required exactly when `to === 'resolved'` (schemaVersion >= 2). */
	resolution?: ReviewResolution
}>
export type ReviewThread = Readonly<{
	id: string
	anchor: ReviewAnchor
	variantNames: readonly string[]
	/** Optional non-authoritative pin placement (schemaVersion >= 2); never anchor identity. */
	displayHint?: ReviewDisplayHint
	/** Optional render context (schemaVersion >= 4, Widget arm only); changed only by a re-anchor. */
	renderContext?: ReviewRenderContext
	status: ReviewStatus
	messages: readonly ReviewMessage[]
	history: readonly ReviewHistoryEvent[]
	submissions: readonly ReviewSubmission[]
}>

const REVIEW_STATUSES = new Set<ReviewStatus>(['open', 'ready-for-review', 'resolved'])
const REVIEW_RESOLUTION_SET = new Set<string>(REVIEW_RESOLUTIONS)

/** First Workspace schemaVersion that decodes `resolution` on lifecycle events and thread `displayHint`. */
export const REVIEW_SCHEMA_V2 = 2
/** First Workspace schemaVersion that decodes the Workspace anchor arm and message `edits[]`. */
export const REVIEW_SCHEMA_V3 = 3
/** First Workspace schemaVersion that decodes thread `renderContext` and re-anchor `before`/`after` `renderContext`. */
export const REVIEW_SCHEMA_V4 = 4

function decodesReviewV2(schemaVersion: number): boolean {
	return schemaVersion >= REVIEW_SCHEMA_V2
}

function decodesReviewV3(schemaVersion: number): boolean {
	return schemaVersion >= REVIEW_SCHEMA_V3
}

function decodesReviewV4(schemaVersion: number): boolean {
	return schemaVersion >= REVIEW_SCHEMA_V4
}

export function isWorkspaceAnchor(anchor: ReviewAnchor | undefined | null): anchor is ReviewWorkspaceAnchor {
	return typeof anchor === 'object' && anchor !== null && Object.hasOwn(anchor, 'scope') && (anchor as ReviewWorkspaceAnchor).scope === 'workspace'
}

export function isWidgetAnchor(anchor: ReviewAnchor | undefined | null): anchor is ReviewWidgetAnchor {
	return typeof anchor === 'object' && anchor !== null && !Object.hasOwn(anchor, 'scope') && typeof (anchor as ReviewWidgetAnchor).viewId === 'string'
}

/** The anchored View id, or undefined for a Workspace thread. */
export function anchorViewId(anchor: ReviewAnchor | undefined | null): string | undefined {
	return isWidgetAnchor(anchor) ? anchor.viewId : undefined
}

/** The anchored Widget id, or undefined for a Workspace thread. */
export function anchorWidgetId(anchor: ReviewAnchor | undefined | null): string | undefined {
	return isWidgetAnchor(anchor) ? anchor.widgetId : undefined
}

/** When the message was last edited, derived from `edits[]` (never stored). */
export function messageEditedAt(message: Pick<ReviewMessage, 'edits'>): string | undefined {
	return Array.isArray(message.edits) ? message.edits.at(-1)?.at : undefined
}

export type ReviewFormalAct = Readonly<{ by: 'submission' | 'resolution'; id: string; at: string }>
export type ReviewMessageFreeze = Readonly<{ frozen: false } | ({ frozen: true } & ReviewFormalAct)>

/**
 * The freeze rule (owner decision O2): a message is frozen permanently once any ready-for-review
 * submission, or any lifecycle event entering `resolved`, exists at or after the message's `at`.
 * Reopening never unfreezes it. Reports the earliest such formal act.
 */
export function isMessageFrozen(thread: Pick<ReviewThread, 'messages' | 'submissions' | 'history'>, messageId: string): ReviewMessageFreeze {
	const message = thread.messages?.find(candidate => candidate.id === messageId)
	if (!message) return { frozen: false }
	const act = earliestFormalActBetween(thread, Date.parse(message.at), Number.POSITIVE_INFINITY)
	return act ? { frozen: true, ...act } : { frozen: false }
}

function earliestFormalActBetween(
	thread: Readonly<{ submissions?: readonly unknown[]; history?: readonly unknown[] }>,
	fromMs: number,
	toMs: number,
): ReviewFormalAct | undefined {
	if (!Number.isFinite(fromMs)) return undefined
	let found: (ReviewFormalAct & { ms: number }) | undefined
	const consider = (by: 'submission' | 'resolution', id: unknown, at: unknown) => {
		if (typeof id !== 'string' || typeof at !== 'string') return
		const ms = Date.parse(at)
		if (!Number.isFinite(ms) || ms < fromMs || ms > toMs) return
		if (!found || ms < found.ms) found = { by, id, at, ms }
	}
	for (const submission of Array.isArray(thread.submissions) ? thread.submissions : [])
		if (isObject(submission)) consider('submission', submission.id, submission.at)
	for (const event of Array.isArray(thread.history) ? thread.history : [])
		if (isObject(event) && event.kind === 'lifecycle' && event.to === 'resolved') consider('resolution', event.id, event.at)
	return found && { by: found.by, id: found.id, at: found.at }
}

export function isReviewResolution(value: unknown): value is ReviewResolution {
	return typeof value === 'string' && REVIEW_RESOLUTION_SET.has(value)
}

/**
 * Current resolution, derived (never stored): the `resolution` of the final lifecycle event while
 * the thread is `resolved`. Returns undefined for unresolved threads and for legacy events without it.
 */
export function deriveReviewResolution(thread: Pick<ReviewThread, 'status' | 'history'>): ReviewResolution | undefined {
	if (thread.status !== 'resolved' || !Array.isArray(thread.history)) return undefined
	const finalLifecycle = [...thread.history].reverse().find(event => isObject(event) && event.kind === 'lifecycle')
	return finalLifecycle && isReviewResolution(finalLifecycle.resolution) ? finalLifecycle.resolution : undefined
}

export function validateReviewEvidenceRef(input: unknown, path = ''): ValidationResult<ReviewEvidenceRef> {
	const v = new Validator()
	const ref = v.object(input, path)
	if (!ref)
		return v.finish<ReviewEvidenceRef>(input)
	rejectUnknownKeys(ref, ['kind', 'evidence'], path, v)
	v.string(ref.kind, `${path}/kind`, true)
	validateDigest(ref.evidence, `${path}/evidence`, v)
	return v.finish<ReviewEvidenceRef>(input)
}

export function validateReviewThread(input: unknown, context: ReviewDecodeContext): ValidationResult<ReviewThread> {
	const v = new Validator()
	const thread = v.object(input, '')
	if (!thread)
		return v.finish<ReviewThread>(input)
	const { filename } = context
	const v2 = decodesReviewV2(context.schemaVersion)
	const v3 = decodesReviewV3(context.schemaVersion)
	const v4 = decodesReviewV4(context.schemaVersion)
	validateJsonValue(input, '', v)
	rejectUnknownKeys(thread, v4
		? ['id', 'anchor', 'variantNames', 'displayHint', 'renderContext', 'status', 'messages', 'history', 'submissions']
		: v2
			? ['id', 'anchor', 'variantNames', 'displayHint', 'status', 'messages', 'history', 'submissions']
			: ['id', 'anchor', 'variantNames', 'status', 'messages', 'history', 'submissions'], '', v)
	const idIsUuid = validateUuid(thread.id, '/id', v, 'Review thread id')
	if (filename !== undefined && idIsUuid) {
		const match = /^([0-9a-f-]+)\.review\.json$/iu.exec(filename)
		if (!match || match[1] !== thread.id)
			v.issue('identity.filename_id_mismatch', '/id', 'Review filename UUID must exactly match the immutable id.')
	}
	const workspaceArm = validateAnchor(thread.anchor, '/anchor', v, v3) === 'workspace'
	const variantNames = validateStringArray(thread.variantNames, '/variantNames', v)
	if (variantNames) validateUnique(variantNames, '/variantNames', v)
	if (workspaceArm && variantNames && variantNames.length > 0)
		v.issue('review.workspace_anchor_variants', '/variantNames', 'A Workspace-scoped thread has no Variant scope; variantNames must be [].')
	if (v2 && Object.hasOwn(thread, 'displayHint')) {
		if (workspaceArm)
			v.issue('review.display_hint_without_widget', '/displayHint', 'A Workspace-scoped thread has no Widget, so it carries no display hint.')
		else validateDisplayHint(thread.displayHint, '/displayHint', v)
	}
	if (v4 && Object.hasOwn(thread, 'renderContext'))
		validateRenderContextMember(thread.renderContext, '/renderContext', workspaceArm, v)
	const status = validateReviewStatus(thread.status, '/status', v)

	const messages = v.array(thread.messages, '/messages')
	const messageIds = new Set<string>()
	messages?.forEach((message, index) => {
		const path = jsonPointer('/messages', index)
		const parsed = validateReviewMessage(message, path, v3)
		v.diagnostics.push(...parsed.diagnostics)
		if (isObjectWithStringId(message)) {
			if (messageIds.has(message.id)) v.issue('identity.duplicate_uuid', `${path}/id`, 'Review message UUID is duplicated.')
			messageIds.add(message.id)
		}
	})

	const submissions = v.array(thread.submissions, '/submissions')
	const submissionIds = new Set<string>()
	submissions?.forEach((submission, index) => {
		const path = jsonPointer('/submissions', index)
		const parsed = validateReviewSubmission(submission, path)
		v.diagnostics.push(...parsed.diagnostics)
		if (isObjectWithStringId(submission)) {
			if (submissionIds.has(submission.id)) v.issue('identity.duplicate_uuid', `${path}/id`, 'Review submission UUID is duplicated.')
			submissionIds.add(submission.id)
		}
	})

	const history = v.array(thread.history, '/history')
	const historyIds = new Set<string>()
	const lifecycleEvents: { event: Record<string, unknown>; index: number }[] = []
	history?.forEach((entry, index) => {
		const path = jsonPointer('/history', index)
		const parsed = validateReviewHistoryEvent(entry, path, v2, v3, v4)
		v.diagnostics.push(...parsed.diagnostics)
		if (isObjectWithStringId(entry)) {
			if (historyIds.has(entry.id)) v.issue('identity.duplicate_uuid', `${path}/id`, 'Review history event UUID is duplicated.')
			historyIds.add(entry.id)
		}
		if (isObject(entry) && entry.kind === 'lifecycle') lifecycleEvents.push({ event: entry, index })
	})
	validateReviewLifecycle(status, lifecycleEvents, submissionIds, submissions, v2, v)
	const allIds = new Set<string>(typeof thread.id === 'string' ? [thread.id] : [])
	for (const [index, message] of (messages ?? []).entries()) {
		if (!isObjectWithStringId(message)) continue
		if (allIds.has(message.id)) v.issue('identity.duplicate_uuid', `/messages/${index}/id`, 'Review resource identities are globally unique within the thread.')
		allIds.add(message.id)
		if (!v3 || !Array.isArray(message.edits)) continue
		for (const [editIndex, edit] of message.edits.entries()) {
			if (!isObjectWithStringId(edit)) continue
			if (allIds.has(edit.id)) v.issue('identity.duplicate_uuid', `/messages/${index}/edits/${editIndex}/id`, 'Review resource identities are globally unique within the thread.')
			allIds.add(edit.id)
		}
	}
	for (const [index, submission] of (submissions ?? []).entries()) {
		if (!isObjectWithStringId(submission)) continue
		if (allIds.has(submission.id)) v.issue('identity.duplicate_uuid', `/submissions/${index}/id`, 'Review resource identities are globally unique within the thread.')
		allIds.add(submission.id)
	}
	for (const [index, event] of (history ?? []).entries()) {
		if (!isObjectWithStringId(event)) continue
		if (allIds.has(event.id)) v.issue('identity.duplicate_uuid', `/history/${index}/id`, 'Review resource identities are globally unique within the thread.')
		allIds.add(event.id)
	}
	validateCurrentAnchorAgainstHistory(thread.anchor, thread.variantNames, history, v)
	if (v4) validateCurrentRenderContextAgainstHistory(thread.renderContext, history, v)
	if (v3) messages?.forEach((message, index) => validateMessageEditRules(message, jsonPointer('/messages', index), submissions, history, v))

	return v.finish<ReviewThread>(input)
}

function validateReviewMessage(input: unknown, path: string, v3: boolean): ValidationResult<ReviewMessage> {
	const v = new Validator()
	const message = v.object(input, path)
	if (!message) return v.finish<ReviewMessage>(input)
	rejectUnknownKeys(message, v3 ? ['id', 'actor', 'at', 'body', 'edits'] : ['id', 'actor', 'at', 'body'], path, v)
	validateUuid(message.id, `${path}/id`, v, 'Review message id')
	validateActor(message.actor, `${path}/actor`, v)
	validateUtcTimestamp(message.at, `${path}/at`, v)
	v.string(message.body, `${path}/body`)
	if (v3 && Object.hasOwn(message, 'edits')) {
		const edits = v.array(message.edits, `${path}/edits`)
		if (edits && edits.length === 0)
			v.issue('review.message_edits_empty', `${path}/edits`, 'A message that was never edited omits edits instead of writing [].')
		edits?.forEach((entry, index) => {
			const editPath = jsonPointer(`${path}/edits`, index)
			const edit = v.object(entry, editPath)
			if (!edit) return
			rejectUnknownKeys(edit, ['id', 'actor', 'at', 'previousBody'], editPath, v)
			validateUuid(edit.id, `${editPath}/id`, v, 'Review message edit id')
			validateActor(edit.actor, `${editPath}/actor`, v)
			validateUtcTimestamp(edit.at, `${editPath}/at`, v)
			v.string(edit.previousBody, `${editPath}/previousBody`)
		})
	}
	return v.finish<ReviewMessage>(input)
}

/**
 * Message edit rules 13.3–13.6 (schemaVersion >= 3): the author invariant, edit order, the freeze
 * rule against later submissions and resolutions, and the content rules. They read only the
 * thread's own submissions and history, so no cross-resource read is needed.
 */
function validateMessageEditRules(
	input: unknown,
	path: string,
	submissions: readonly unknown[] | undefined,
	history: readonly unknown[] | undefined,
	v: Validator,
): void {
	if (!isObject(input) || !Array.isArray(input.edits) || input.edits.length === 0) return
	const edits = input.edits.filter(isObject)
	if (edits.length !== input.edits.length) return
	const author = isObject(input.actor) ? input.actor : undefined
	if (typeof author?.id !== 'string' || author.id.length === 0)
		v.issue('review.message_edit_not_author', `${path}/actor/id`, 'Only a message with an identified author can be edited.')
	else edits.forEach((edit, index) => {
		const actor = isObject(edit.actor) ? edit.actor : undefined
		if (actor?.id !== author.id || actor?.type !== author.type)
			v.issue('review.message_edit_not_author', `${path}/edits/${index}/actor`, 'Only the author of a message may edit it.')
	})
	const messageMs = Date.parse(typeof input.at === 'string' ? input.at : '')
	let previousMs = messageMs
	edits.forEach((edit, index) => {
		const ms = Date.parse(typeof edit.at === 'string' ? edit.at : '')
		if (!Number.isFinite(ms) || !Number.isFinite(previousMs)) return
		if (index === 0 ? ms <= previousMs : ms < previousMs)
			v.issue('review.message_edit_out_of_order', `${path}/edits/${index}/at`, 'Edits come after the message and after each other, in order.')
		previousMs = ms
	})
	edits.forEach((edit, index) => {
		const ms = Date.parse(typeof edit.at === 'string' ? edit.at : '')
		if (!Number.isFinite(ms)) return
		const act = earliestFormalActBetween({ submissions, history }, messageMs, ms)
		if (act)
			v.issue('review.message_edit_after_formal_act', `${path}/edits/${index}`,
				`A message cannot be edited after a later ${act.by === 'submission' ? 'ready-for-review submission' : 'resolution'} (${act.id}); reply instead.`)
	})
	if (typeof input.body === 'string' && input.body.trim().length === 0)
		v.issue('review.message_body_empty', `${path}/body`, 'An edited message keeps non-empty text; editing never deletes a message.')
	edits.forEach((edit, index) => {
		const replacement = index + 1 < edits.length ? edits[index + 1]!.previousBody : input.body
		if (typeof edit.previousBody === 'string' && edit.previousBody === replacement)
			v.issue('review.message_edit_noop', `${path}/edits/${index}/previousBody`, 'An edit must change the message text.')
	})
}

function validateReviewSubmission(input: unknown, path: string): ValidationResult<ReviewSubmission> {
	const v = new Validator()
	const submission = v.object(input, path)
	if (!submission) return v.finish<ReviewSubmission>(input)
	rejectUnknownKeys(submission, ['id', 'actor', 'at', 'changeDomains', 'resources', 'scope', 'evidenceRefs'], path, v)
	validateUuid(submission.id, `${path}/id`, v, 'Review submission id')
	validateActor(submission.actor, `${path}/actor`, v)
	validateUtcTimestamp(submission.at, `${path}/at`, v)
	const domains = validateStringArray(submission.changeDomains, `${path}/changeDomains`, v)
	if (domains && domains.length === 0)
		v.issue('review.missing_change_domains', `${path}/changeDomains`, 'A ready-for-review submission must state at least one structured change domain.')
	const resources = v.array(submission.resources, `${path}/resources`)
	if (resources && resources.length === 0)
		v.issue('review.missing_resource_scope', `${path}/resources`, 'Submission must identify the canonical resources and revisions in scope.')
	resources?.forEach((resourceValue, index) => {
		const resourcePath = jsonPointer(`${path}/resources`, index)
		const resource = v.object(resourceValue, resourcePath)
		if (!resource) return
		rejectUnknownKeys(resource, ['identity', 'revision'], resourcePath, v)
		const identity = v.object(resource.identity, `${resourcePath}/identity`)
		if (identity) {
			if (Object.keys(identity).length === 0) v.issue('review.empty_resource_identity', `${resourcePath}/identity`, 'Canonical resource revision references require an identity.')
			validateJsonValue(identity, `${resourcePath}/identity`, v)
		}
		v.string(resource.revision, `${resourcePath}/revision`, true)
	})
	const scope = v.object(submission.scope, `${path}/scope`)
	if (scope) validateJsonValue(scope, `${path}/scope`, v)
	const refs = v.array(submission.evidenceRefs, `${path}/evidenceRefs`)
	if (refs && refs.length === 0)
		v.issue('review.missing_evidence', `${path}/evidenceRefs`, 'A ready-for-review submission must reference its evidence records.')
	refs?.forEach((ref, index) => v.diagnostics.push(...validateReviewEvidenceRef(ref, jsonPointer(`${path}/evidenceRefs`, index)).diagnostics))
	return v.finish<ReviewSubmission>(input)
}

function validateReviewHistoryEvent(input: unknown, path: string, v2: boolean, v3: boolean, v4: boolean): ValidationResult<ReviewHistoryEvent> {
	const v = new Validator()
	const event = v.object(input, path)
	if (!event) return v.finish<ReviewHistoryEvent>(input)
	const lifecycleKeys = v2
		? ['id', 'kind', 'actor', 'at', 'from', 'to', 'submissionId', 'reason', 'resolution']
		: ['id', 'kind', 'actor', 'at', 'from', 'to', 'submissionId', 'reason']
	rejectUnknownKeys(event, [...new Set([...lifecycleKeys, 'before', 'after'])], path, v)
	validateUuid(event.id, `${path}/id`, v, 'Review history event id')
	validateActor(event.actor, `${path}/actor`, v)
	validateUtcTimestamp(event.at, `${path}/at`, v)
	if (Object.hasOwn(event, 'reason')) v.string(event.reason, `${path}/reason`)
	if (event.kind === 'lifecycle') {
		rejectUnknownKeys(event, lifecycleKeys, path, v)
		const from = validateReviewStatus(event.from, `${path}/from`, v)
		const to = validateReviewStatus(event.to, `${path}/to`, v)
		if (Object.hasOwn(event, 'submissionId')) validateUuid(event.submissionId, `${path}/submissionId`, v, 'submissionId')
		if (to === 'ready-for-review' && !Object.hasOwn(event, 'submissionId'))
			v.issue('review.ready_missing_submission', `${path}/submissionId`, 'Entering ready-for-review must reference its new immutable submission.')
		let resolution: ReviewResolution | undefined
		if (v2) {
			const hasResolution = Object.hasOwn(event, 'resolution')
			if (hasResolution && to !== 'resolved')
				v.issue('review.resolution_unexpected', `${path}/resolution`, 'Only a lifecycle event entering resolved records a resolution.')
			if (to === 'resolved') {
				if (!hasResolution)
					v.issue('review.resolution_required', `${path}/resolution`, 'Entering resolved must record how the thread was resolved.')
				else if (!isReviewResolution(event.resolution))
					v.issue('review.invalid_resolution', `${path}/resolution`, 'Resolution must be verified, answered, wont-fix, duplicate, or obsolete.')
				else resolution = event.resolution
			}
		}
		if (to === 'resolved') {
			if (!isObject(event.actor) || event.actor.type !== 'human')
				v.issue('review.resolve_requires_human', `${path}/actor/type`, 'Only a human actor may resolve a Review thread.')
			if (resolution === undefined || resolution === 'verified') {
				// v1, a missing/invalid v2 resolution, and `verified` all keep the evidence-gated rule.
				if (!Object.hasOwn(event, 'submissionId'))
					v.issue('review.resolve_missing_submission', `${path}/submissionId`, 'Resolution must identify the accepted ready-for-review submission.')
			}
			else {
				if (Object.hasOwn(event, 'submissionId'))
					v.issue('review.direct_resolve_submission_forbidden', `${path}/submissionId`, 'A non-verified resolution accepts no submission and must not carry submissionId.')
				if (resolution === 'duplicate' && (typeof event.reason !== 'string' || event.reason.trim().length === 0))
					v.issue('review.resolution_reason_required', `${path}/reason`, 'A duplicate resolution must name the thread it duplicates in a non-empty reason.')
			}
		}
		const invalidResolutionValue = v2 && to === 'resolved' && Object.hasOwn(event, 'resolution') && resolution === undefined
		if (from && to && !invalidResolutionValue && !isAllowedReviewTransition(from, to, resolution))
			v.issue('review.invalid_transition', path, `Review transition ${from} -> ${to}${resolution ? ` (${resolution})` : ''} is not allowed.`)
	}
	else if (event.kind === 'reanchor') {
		rejectUnknownKeys(event, ['id', 'kind', 'actor', 'at', 'before', 'after', 'reason'], path, v)
		validateAnchorScope(event.before, `${path}/before`, v, v3, v4)
		validateAnchorScope(event.after, `${path}/after`, v, v3, v4)
	}
	else {
		v.issue('review.invalid_history_kind', `${path}/kind`, 'History kind must identify a lifecycle or reanchor event.')
	}
	return v.finish<ReviewHistoryEvent>(input)
}

function validateReviewLifecycle(
	currentStatus: ReviewStatus | undefined,
	events: readonly { event: Record<string, unknown>; index: number }[],
	submissionIds: ReadonlySet<string>,
	submissions: readonly unknown[] | undefined,
	v2: boolean,
	v: Validator,
): void {
	if (events.length === 0) {
		if (currentStatus !== undefined && currentStatus !== 'open')
			v.issue('review.invalid_initial_status', '/status', 'A Review thread without lifecycle history starts in open status.')
		if ((submissions?.length ?? 0) > 0)
			v.issue('review.orphan_submission', '/submissions',
				'Each stored Review submission must be created by a transition into ready-for-review.')
		return
	}
	if (events[0]?.event.from !== 'open')
		v.issue('review.invalid_initial_status', `/history/${events[0]?.index ?? 0}/from`, 'The first lifecycle event starts from the thread’s initial open status.')
	let expected: ReviewStatus | undefined
	let activeReadySubmission: string | undefined
	const usedSubmissions = new Set<string>()
	const readySubmissionIds: string[] = []
	for (const { event, index } of events) {
		const path = jsonPointer('/history', index)
		const from = event.from as ReviewStatus
		const to = event.to as ReviewStatus
		if (expected !== undefined && from !== expected)
			v.issue('review.discontinuous_history', `${path}/from`, 'Lifecycle history must continue from the preceding current status.')
		const submissionId = event.submissionId
		if (to === 'ready-for-review') {
			if (typeof submissionId !== 'string' || !submissionIds.has(submissionId))
				v.issue('review.unknown_submission', `${path}/submissionId`, 'Lifecycle event must reference its stored submission.')
			else {
				readySubmissionIds.push(submissionId)
				if (usedSubmissions.has(submissionId))
					v.issue('review.submission_reused', `${path}/submissionId`, 'Each transition into ready-for-review creates a new submission.')
				usedSubmissions.add(submissionId)
				activeReadySubmission = submissionId
				const submission = submissions?.find(candidate => isObject(candidate) && candidate.id === submissionId)
				if (!isObject(submission) || submission.at !== event.at)
					v.issue('review.submission_time_mismatch', `${path}/submissionId`, 'Submission time identifies the transition into ready-for-review.')
			}
		}
		else if (to === 'resolved') {
			if (acceptsSubmission(event, v2)) {
				if (typeof submissionId !== 'string' || !submissionIds.has(submissionId))
					v.issue('review.unknown_submission', `${path}/submissionId`, 'Resolution must reference a stored ready-for-review submission.')
				if (submissionId !== activeReadySubmission)
					v.issue('review.resolve_stale_submission', `${path}/submissionId`, 'Resolution must accept the currently applicable ready-for-review submission.')
			}
			// A non-verified close clears any pending submission without accepting it.
			activeReadySubmission = undefined
		}
		else if (to === 'open') {
			activeReadySubmission = undefined
		}
		expected = to
	}
	if (currentStatus !== undefined && expected !== currentStatus)
		v.issue('review.history_status_mismatch', '/status', 'Current status must match the final lifecycle history event.')
	const storedSubmissionIds = (submissions ?? []).map(submission =>
		isObjectWithStringId(submission) ? submission.id : undefined)
	if (storedSubmissionIds.length !== readySubmissionIds.length
		|| storedSubmissionIds.some((id, index) => id !== readySubmissionIds[index]))
		v.issue('review.submission_history_mismatch', '/submissions',
			'Submissions must correspond one-to-one and in order with transitions into ready-for-review.')
	const finalEvent = events.at(-1)?.event
	const checksCurrentSubmission = currentStatus === 'ready-for-review'
		|| (currentStatus === 'resolved' && finalEvent !== undefined && acceptsSubmission(finalEvent, v2))
	if (checksCurrentSubmission && submissions?.length) {
		const currentSubmissionId = currentStatus === 'resolved' ? finalEvent?.submissionId : activeReadySubmission
		if (typeof currentSubmissionId !== 'string' || (submissions.at(-1) as Record<string, unknown> | undefined)?.id !== currentSubmissionId)
			v.issue('review.current_submission_mismatch', '/submissions', 'Current Review state refers to the latest applicable immutable submission.')
	}
}

function validateCurrentAnchorAgainstHistory(
	currentAnchorValue: unknown,
	currentVariantNamesValue: unknown,
	history: readonly unknown[] | undefined,
	v: Validator,
): void {
	const reanchors = history?.filter(isObject).filter(event => event.kind === 'reanchor') ?? []
	let previousAfter: Record<string, unknown> | undefined
	for (const [index, event] of reanchors.entries()) {
		if (!isObject(event.before) || !isObject(event.after)) continue
		if (previousAfter
			&& (!sameAnchor(previousAfter.anchor, event.before.anchor)
				|| !sameStringSet(previousAfter.variantNames, event.before.variantNames)))
			v.issue('review.discontinuous_reanchor_history', `/history/reanchor/${index}/before`,
				'Re-anchor history must continue from the preceding authoritative anchor and Variant scope.')
		previousAfter = event.after
	}
	if (!previousAfter) return
	if (!sameAnchor(previousAfter.anchor, currentAnchorValue)
		|| !sameStringSet(previousAfter.variantNames, currentVariantNamesValue))
		v.issue('review.anchor_history_mismatch', '/anchor',
			'Current anchor and Variant scope must match the latest append-only re-anchor event.')
}

/**
 * Render context continuity (schemaVersion >= 4): only a re-anchor changes `renderContext`, so each
 * re-anchor's `before` repeats the preceding `after`, and the thread's current value equals the
 * latest `after`. Absent is a value here: it means unknown on both sides. Without any re-anchor
 * the thread keeps whatever it was created with.
 */
function validateCurrentRenderContextAgainstHistory(
	currentValue: unknown,
	history: readonly unknown[] | undefined,
	v: Validator,
): void {
	let previousAfter: Record<string, unknown> | undefined
	for (const [index, event] of (history ?? []).entries()) {
		if (!isObject(event) || event.kind !== 'reanchor' || !isObject(event.before) || !isObject(event.after)) continue
		if (previousAfter && !sameRenderContext(previousAfter.renderContext, event.before.renderContext))
			v.issue('review.render_context_discontinuous_history', `/history/${index}/before/renderContext`,
				'A re-anchor must record the render context the preceding re-anchor left as its before value.')
		previousAfter = event.after
	}
	if (previousAfter && !sameRenderContext(previousAfter.renderContext, currentValue))
		v.issue('review.render_context_history_mismatch', '/renderContext',
			'The current render context must match the latest re-anchor event\'s after value.')
}

/**
 * Decodes the anchor union. Under schemaVersion >= 3 an object with `scope` is the Workspace arm
 * (closed `['scope']`, `scope === "workspace"`); anything else is the closed Widget arm. Under 1–2
 * only the Widget arm exists, so `scope` is an unknown field there.
 */
function validateAnchor(value: unknown, path: string, v: Validator, v3: boolean): 'widget' | 'workspace' | undefined {
	const anchor = v.object(value, path)
	if (!anchor) return undefined
	if (v3 && Object.hasOwn(anchor, 'scope')) {
		rejectUnknownKeys(anchor, ['scope'], path, v)
		if (anchor.scope !== 'workspace') {
			v.issue('review.invalid_anchor_scope', `${path}/scope`, 'Anchor scope must be "workspace"; a Widget anchor is { viewId, widgetId }.')
			return undefined
		}
		return 'workspace'
	}
	rejectUnknownKeys(anchor, ['viewId', 'widgetId'], path, v)
	validateUuid(anchor.viewId, `${path}/viewId`, v, 'anchor viewId')
	v.string(anchor.widgetId, `${path}/widgetId`, true)
	return 'widget'
}

function validateAnchorScope(value: unknown, path: string, v: Validator, v3: boolean, v4: boolean): void {
	const scope = v.object(value, path)
	if (!scope) return
	rejectUnknownKeys(scope, v4 ? ['anchor', 'variantNames', 'renderContext'] : ['anchor', 'variantNames'], path, v)
	const arm = validateAnchor(scope.anchor, `${path}/anchor`, v, v3)
	if (v4 && Object.hasOwn(scope, 'renderContext'))
		validateRenderContextMember(scope.renderContext, `${path}/renderContext`, arm === 'workspace', v)
	const names = validateStringArray(scope.variantNames, `${path}/variantNames`, v)
	if (names) validateUnique(names, `${path}/variantNames`, v)
	if (arm === 'workspace' && names && names.length > 0)
		v.issue('review.workspace_anchor_variants', `${path}/variantNames`, 'A Workspace-scoped anchor has no Variant scope; variantNames must be [].')
}

function validateActor(value: unknown, path: string, v: Validator): void {
	const actor = v.object(value, path)
	if (!actor) return
	rejectUnknownKeys(actor, ['type', 'id', 'displayName'], path, v)
	v.string(actor.type, `${path}/type`, true)
	if (Object.hasOwn(actor, 'id')) v.string(actor.id, `${path}/id`, true)
	if (Object.hasOwn(actor, 'displayName')) v.string(actor.displayName, `${path}/displayName`)
}

function validateReviewStatus(value: unknown, path: string, v: Validator): ReviewStatus | undefined {
	if (typeof value !== 'string' || !REVIEW_STATUSES.has(value as ReviewStatus)) {
		v.issue('review.invalid_status', path, 'Review status must be open, ready-for-review, or resolved.')
		return undefined
	}
	return value as ReviewStatus
}

/**
 * Lifecycle edges. Entering `resolved` is resolution-aware: `verified` (or a legacy event without a
 * resolution) is allowed only from ready-for-review; every other resolution is allowed from open or
 * ready-for-review. Invariant: resolution = verified <=> submissionId present <=> from = ready-for-review.
 */
export function isAllowedReviewTransition(from: ReviewStatus, to: ReviewStatus, resolution?: ReviewResolution): boolean {
	if (to === 'resolved') {
		if (resolution === undefined || resolution === 'verified') return from === 'ready-for-review'
		return isReviewResolution(resolution) && (from === 'open' || from === 'ready-for-review')
	}
	return (from === 'open' && to === 'ready-for-review')
		|| (from === 'ready-for-review' && to === 'open')
		|| (from === 'resolved' && to === 'open')
}

/** Resolve events that accept a submission: every v1 resolve, and v2 `verified` (or a missing resolution). */
function acceptsSubmission(event: Record<string, unknown>, v2: boolean): boolean {
	return !v2 || !Object.hasOwn(event, 'resolution') || event.resolution === 'verified'
}

/**
 * Closed `displayHint` container. Validators diagnose and never repair: they check shape and the
 * inclusive 0..1 range only (writers clamp and quantize to 1e-4; unquantized values stay valid).
 */
function validateDisplayHint(value: unknown, path: string, v: Validator): void {
	const hint = v.object(value, path)
	if (!hint) return
	rejectUnknownKeys(hint, ['pin'], path, v)
	if (Object.keys(hint).length === 0) {
		v.issue('review.display_hint_empty', path, 'A displayHint must contain at least one member; omit the field instead of writing {}.')
		return
	}
	if (!Object.hasOwn(hint, 'pin')) return
	const pinPath = `${path}/pin`
	const pin = v.object(hint.pin, pinPath)
	if (!pin) return
	rejectUnknownKeys(pin, ['x', 'y'], pinPath, v)
	for (const axis of ['x', 'y'] as const) {
		const axisPath = `${pinPath}/${axis}`
		// Both members are required; a missing or non-number value gets the existing type diagnostic.
		const number = v.finiteNumber(pin[axis], axisPath)
		if (number !== undefined && (number < 0 || number > 1))
			v.issue('review.display_hint_out_of_range', axisPath, `Pin hint ${axis} must be within 0..1 inclusive.`)
	}
}

/**
 * Closed `renderContext` container (schemaVersion >= 4). Shape only: `locale` is a canonical BCP 47
 * tag and the ids are non-empty Workspace-local keys. Whether a key still exists in the Workspace
 * is never checked here, since a stale key never invalidates the thread.
 */
function validateRenderContextMember(value: unknown, path: string, workspaceArm: boolean, v: Validator): void {
	if (workspaceArm) {
		v.issue('review.render_context_without_widget', path, 'A Workspace-scoped thread has no Widget, so it carries no render context.')
		return
	}
	const context = v.object(value, path)
	if (!context) return
	rejectUnknownKeys(context, ['locale', 'viewportId', 'themeId'], path, v)
	if (Object.keys(context).length === 0) {
		v.issue('review.render_context_empty', path, 'A renderContext must contain at least one member; omit the field instead of writing {}.')
		return
	}
	if (Object.hasOwn(context, 'locale') && !isCanonicalLocaleTag(context.locale))
		v.issue('review.render_context_invalid_locale', `${path}/locale`, 'Render context locale must be a canonical BCP 47 tag.')
	if (Object.hasOwn(context, 'viewportId')) v.string(context.viewportId, `${path}/viewportId`, true)
	if (Object.hasOwn(context, 'themeId')) v.string(context.themeId, `${path}/themeId`, true)
}

/** Writer normalization for pin hints: clamp to [0, 1] and quantize to 4 fractional digits. */
export function normalizeReviewPinCoordinate(value: number): number {
	const clamped = Math.min(1, Math.max(0, value))
	const quantized = Math.round(clamped * 10_000) / 10_000
	return quantized === 0 ? 0 : quantized
}

function validateStringArray(value: unknown, path: string, v: Validator): string[] | undefined {
	const items = v.array(value, path)
	if (!items) return undefined
	const strings: string[] = []
	items.forEach((item, index) => {
		const parsed = v.string(item, jsonPointer(path, index), true)
		if (parsed !== undefined) strings.push(parsed)
	})
	return strings
}

function validateUnique(values: readonly string[], path: string, v: Validator): void {
	const seen = new Set<string>()
	values.forEach((value, index) => {
		if (seen.has(value)) v.issue('identity.duplicate', jsonPointer(path, index), 'Identity is duplicated.')
		seen.add(value)
	})
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isObjectWithStringId(value: unknown): value is Record<string, unknown> & { id: string } {
	return isObject(value) && typeof value.id === 'string'
}

/** Arm-aware: two Workspace anchors are equal; a Workspace anchor never equals a Widget anchor. */
function sameAnchor(left: unknown, right: unknown): boolean {
	if (!isObject(left) || !isObject(right)) return false
	const leftScoped = Object.hasOwn(left, 'scope')
	const rightScoped = Object.hasOwn(right, 'scope')
	if (leftScoped || rightScoped) return leftScoped && rightScoped && left.scope === right.scope
	return left.viewId === right.viewId && left.widgetId === right.widgetId
}

/** Absent equals absent; otherwise the same members with the same values. */
function sameRenderContext(left: unknown, right: unknown): boolean {
	if (left === undefined || right === undefined) return left === right
	if (!isObject(left) || !isObject(right)) return false
	const keys = Object.keys(left)
	return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && left[key] === right[key])
}

function sameStringSet(left: unknown, right: unknown): boolean {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
	return left.every(item => typeof item === 'string' && right.includes(item))
}
