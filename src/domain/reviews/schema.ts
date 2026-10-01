import {
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
export type ReviewActor = Readonly<{ type: string; id?: string; displayName?: string }>
export type ReviewAnchor = Readonly<{ viewId: string; widgetId: string }>
export type ReviewEvidenceRef = Readonly<{ kind: string; evidence: string }>
export type ReviewResourceRevision = Readonly<{ identity: JsonObject; revision: string }>
export type ReviewMessage = Readonly<{ id: string; actor: ReviewActor; at: string; body: string }>
export type ReviewSubmission = Readonly<{
	id: string
	actor: ReviewActor
	at: string
	changeDomains: readonly string[]
	resources: readonly ReviewResourceRevision[]
	scope: JsonObject
	evidenceRefs: readonly ReviewEvidenceRef[]
}>
export type ReviewHistoryEvent = Readonly<{
	id: string
	kind: 'lifecycle' | 'reanchor'
	actor: ReviewActor
	at: string
	from?: ReviewStatus
	to?: ReviewStatus
	submissionId?: string
	before?: Readonly<{ anchor: ReviewAnchor; variantNames: readonly string[] }>
	after?: Readonly<{ anchor: ReviewAnchor; variantNames: readonly string[] }>
	reason?: string
}>
export type ReviewThread = Readonly<{
	id: string
	anchor: ReviewAnchor
	variantNames: readonly string[]
	status: ReviewStatus
	messages: readonly ReviewMessage[]
	history: readonly ReviewHistoryEvent[]
	submissions: readonly ReviewSubmission[]
}>

const REVIEW_STATUSES = new Set<ReviewStatus>(['open', 'ready-for-review', 'resolved'])

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

export function validateReviewThread(input: unknown, filename?: string): ValidationResult<ReviewThread> {
	const v = new Validator()
	const thread = v.object(input, '')
	if (!thread)
		return v.finish<ReviewThread>(input)
	validateJsonValue(input, '', v)
	rejectUnknownKeys(thread, ['id', 'anchor', 'variantNames', 'status', 'messages', 'history', 'submissions'], '', v)
	const idIsUuid = validateUuid(thread.id, '/id', v, 'Review thread id')
	if (filename !== undefined && idIsUuid) {
		const match = /^([0-9a-f-]+)\.review\.json$/iu.exec(filename)
		if (!match || match[1] !== thread.id)
			v.issue('identity.filename_id_mismatch', '/id', 'Review filename UUID must exactly match the immutable id.')
	}
	validateAnchor(thread.anchor, '/anchor', v)
	const variantNames = validateStringArray(thread.variantNames, '/variantNames', v)
	if (variantNames) validateUnique(variantNames, '/variantNames', v)
	const status = validateReviewStatus(thread.status, '/status', v)

	const messages = v.array(thread.messages, '/messages')
	const messageIds = new Set<string>()
	messages?.forEach((message, index) => {
		const path = jsonPointer('/messages', index)
		const parsed = validateReviewMessage(message, path)
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
		const parsed = validateReviewHistoryEvent(entry, path)
		v.diagnostics.push(...parsed.diagnostics)
		if (isObjectWithStringId(entry)) {
			if (historyIds.has(entry.id)) v.issue('identity.duplicate_uuid', `${path}/id`, 'Review history event UUID is duplicated.')
			historyIds.add(entry.id)
		}
		if (isObject(entry) && entry.kind === 'lifecycle') lifecycleEvents.push({ event: entry, index })
	})
	validateReviewLifecycle(status, lifecycleEvents, submissionIds, submissions, v)
	const allIds = new Set<string>(typeof thread.id === 'string' ? [thread.id] : [])
	for (const [index, message] of (messages ?? []).entries()) {
		if (!isObjectWithStringId(message)) continue
		if (allIds.has(message.id)) v.issue('identity.duplicate_uuid', `/messages/${index}/id`, 'Review resource identities are globally unique within the thread.')
		allIds.add(message.id)
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

	return v.finish<ReviewThread>(input)
}

function validateReviewMessage(input: unknown, path: string): ValidationResult<ReviewMessage> {
	const v = new Validator()
	const message = v.object(input, path)
	if (!message) return v.finish<ReviewMessage>(input)
	rejectUnknownKeys(message, ['id', 'actor', 'at', 'body'], path, v)
	validateUuid(message.id, `${path}/id`, v, 'Review message id')
	validateActor(message.actor, `${path}/actor`, v)
	validateUtcTimestamp(message.at, `${path}/at`, v)
	v.string(message.body, `${path}/body`)
	return v.finish<ReviewMessage>(input)
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

function validateReviewHistoryEvent(input: unknown, path: string): ValidationResult<ReviewHistoryEvent> {
	const v = new Validator()
	const event = v.object(input, path)
	if (!event) return v.finish<ReviewHistoryEvent>(input)
	rejectUnknownKeys(event, ['id', 'kind', 'actor', 'at', 'from', 'to', 'submissionId', 'before', 'after', 'reason'], path, v)
	validateUuid(event.id, `${path}/id`, v, 'Review history event id')
	validateActor(event.actor, `${path}/actor`, v)
	validateUtcTimestamp(event.at, `${path}/at`, v)
	if (Object.hasOwn(event, 'reason')) v.string(event.reason, `${path}/reason`)
	if (event.kind === 'lifecycle') {
		rejectUnknownKeys(event, ['id', 'kind', 'actor', 'at', 'from', 'to', 'submissionId', 'reason'], path, v)
		const from = validateReviewStatus(event.from, `${path}/from`, v)
		const to = validateReviewStatus(event.to, `${path}/to`, v)
		if (Object.hasOwn(event, 'submissionId')) validateUuid(event.submissionId, `${path}/submissionId`, v, 'submissionId')
		if (to === 'ready-for-review' && !Object.hasOwn(event, 'submissionId'))
			v.issue('review.ready_missing_submission', `${path}/submissionId`, 'Entering ready-for-review must reference its new immutable submission.')
		if (to === 'resolved') {
			if (!isObject(event.actor) || event.actor.type !== 'human')
				v.issue('review.resolve_requires_human', `${path}/actor/type`, 'Only a human actor may resolve a Review thread.')
			if (!Object.hasOwn(event, 'submissionId'))
				v.issue('review.resolve_missing_submission', `${path}/submissionId`, 'Resolution must identify the accepted ready-for-review submission.')
		}
		if (from && to && !isAllowedReviewTransition(from, to))
			v.issue('review.invalid_transition', path, `Review transition ${from} -> ${to} is not allowed.`)
	}
	else if (event.kind === 'reanchor') {
		rejectUnknownKeys(event, ['id', 'kind', 'actor', 'at', 'before', 'after', 'reason'], path, v)
		validateAnchorScope(event.before, `${path}/before`, v)
		validateAnchorScope(event.after, `${path}/after`, v)
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
			if (typeof submissionId !== 'string' || !submissionIds.has(submissionId))
				v.issue('review.unknown_submission', `${path}/submissionId`, 'Resolution must reference a stored ready-for-review submission.')
			if (submissionId !== activeReadySubmission)
				v.issue('review.resolve_stale_submission', `${path}/submissionId`, 'Resolution must accept the currently applicable ready-for-review submission.')
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
	if ((currentStatus === 'ready-for-review' || currentStatus === 'resolved') && submissions?.length) {
		const finalEvent = events.at(-1)?.event
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

function validateAnchor(value: unknown, path: string, v: Validator): void {
	const anchor = v.object(value, path)
	if (!anchor) return
	rejectUnknownKeys(anchor, ['viewId', 'widgetId'], path, v)
	validateUuid(anchor.viewId, `${path}/viewId`, v, 'anchor viewId')
	v.string(anchor.widgetId, `${path}/widgetId`, true)
}

function validateAnchorScope(value: unknown, path: string, v: Validator): void {
	const scope = v.object(value, path)
	if (!scope) return
	rejectUnknownKeys(scope, ['anchor', 'variantNames'], path, v)
	validateAnchor(scope.anchor, `${path}/anchor`, v)
	const names = validateStringArray(scope.variantNames, `${path}/variantNames`, v)
	if (names) validateUnique(names, `${path}/variantNames`, v)
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

export function isAllowedReviewTransition(from: ReviewStatus, to: ReviewStatus): boolean {
	return (from === 'open' && to === 'ready-for-review')
		|| (from === 'ready-for-review' && (to === 'resolved' || to === 'open'))
		|| (from === 'resolved' && to === 'open')
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

function sameAnchor(left: unknown, right: unknown): boolean {
	if (!isObject(left) || !isObject(right)) return false
	return left.viewId === right.viewId && left.widgetId === right.widgetId
}

function sameStringSet(left: unknown, right: unknown): boolean {
	if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
	return left.every(item => typeof item === 'string' && right.includes(item))
}
