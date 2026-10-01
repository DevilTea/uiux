import {
	jsonPointer,
	isRecord,
	rejectUnknownKeys,
	validateAbsoluteUri,
	validateJsonValue,
	validateUuid,
	validateUtcTimestamp,
	Validator,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'

export type ViewReference = Readonly<{
	type: 'view'
	viewId: string
	variantName?: string
	relation?: string
}>

export type ExternalReference = Readonly<{
	type: 'external'
	uri: string
	label?: string
	relation?: string
}>

export type Reference = ViewReference | ExternalReference
export type DecisionStatus = 'pending' | 'deferred' | 'decided'
export type DecisionOutcome = Readonly<{ summary: string; rationale: string }>
export type DecisionSnapshot = Readonly<{ status: DecisionStatus; outcome?: DecisionOutcome }>
export type DecisionActor = Readonly<{ type: string; id?: string; displayName?: string }>
export type DecisionHistoryEntry = Readonly<{
	at: string
	actor?: DecisionActor
	source?: JsonValue
	before: DecisionSnapshot
	after: DecisionSnapshot
}>

export type Decision = Readonly<{
	id: string
	question: string
	status: DecisionStatus
	outcome?: DecisionOutcome
	history: readonly DecisionHistoryEntry[]
	provenance?: JsonObject
}>

export type ViewSpec = Readonly<{
	intent: string
	entryConditions: readonly string[]
	interactionRules: readonly string[]
	constraints: readonly string[]
	accessibility: readonly string[]
	references: readonly Reference[]
	decisions: readonly Decision[]
}>

export function validateReference(input: unknown, path = ''): ValidationResult<Reference> {
	const v = new Validator()
	const ref = v.object(input, path)
	if (!ref)
		return v.finish<Reference>(input)

	if (ref.type === 'view') {
		rejectUnknownKeys(ref, ['type', 'viewId', 'variantName', 'relation'], path, v)
		validateUuid(ref.viewId, `${path}/viewId`, v, 'viewId')
		if (Object.hasOwn(ref, 'variantName'))
			v.string(ref.variantName, `${path}/variantName`, true)
		validateOptionalNonEmpty(ref, 'relation', path, v)
	}
	else if (ref.type === 'external') {
		rejectUnknownKeys(ref, ['type', 'uri', 'label', 'relation'], path, v)
		validateAbsoluteUri(ref.uri, `${path}/uri`, v)
		if (Object.hasOwn(ref, 'label'))
			v.string(ref.label, `${path}/label`)
		validateOptionalNonEmpty(ref, 'relation', path, v)
	}
	else {
		v.issue('reference.unknown_type', `${path}/type`, 'Reference type is not part of the first-version View Reference union.')
	}
	return v.finish<Reference>(input)
}

export function validateViewSpec(input: unknown, path = ''): ValidationResult<ViewSpec> {
	const v = new Validator()
	const spec = v.object(input, path)
	if (!spec)
		return v.finish<ViewSpec>(input)
	validateJsonValue(input, path, v)
	rejectUnknownKeys(spec, ['intent', 'entryConditions', 'interactionRules', 'constraints', 'accessibility', 'references', 'decisions'], path, v)
	v.string(spec.intent, `${path}/intent`)
	for (const key of ['entryConditions', 'interactionRules', 'constraints', 'accessibility'] as const)
		validateStringList(spec[key], `${path}/${key}`, v)

	const references = v.array(spec.references, `${path}/references`)
	references?.forEach((reference, index) => {
		const result = validateReference(reference, jsonPointer(`${path}/references`, index))
		v.diagnostics.push(...result.diagnostics)
	})

	const decisions = v.array(spec.decisions, `${path}/decisions`)
	if (decisions) {
		const ids = new Set<string>()
		decisions.forEach((decision, index) => {
			const decisionPath = jsonPointer(`${path}/decisions`, index)
			const result = validateDecision(decision, decisionPath)
			v.diagnostics.push(...result.diagnostics)
			if (isRecord(decision) && typeof decision.id === 'string') {
				if (ids.has(decision.id))
					v.issue('identity.duplicate_uuid', `${decisionPath}/id`, 'Decision UUID is duplicated within the View Spec.')
				ids.add(decision.id)
			}
		})
	}
	return v.finish<ViewSpec>(input)
}

export function validateDecision(input: unknown, path = ''): ValidationResult<Decision> {
	const v = new Validator()
	const decision = v.object(input, path)
	if (!decision)
		return v.finish<Decision>(input)
	rejectUnknownKeys(decision, ['id', 'question', 'status', 'outcome', 'history', 'provenance'], path, v)
	validateUuid(decision.id, `${path}/id`, v, 'Decision id')
	v.string(decision.question, `${path}/question`)
	const status = validateDecisionStatus(decision.status, `${path}/status`, v)
	if (Object.hasOwn(decision, 'provenance')) {
		const provenance = v.object(decision.provenance, `${path}/provenance`)
		if (provenance) {
			validateJsonValue(provenance, `${path}/provenance`, v)
			if (Object.hasOwn(provenance, 'sourceReviewThreadId'))
				validateUuid(provenance.sourceReviewThreadId, `${path}/provenance/sourceReviewThreadId`, v, 'source Review thread id')
		}
	}

	const outcome = validateDecisionOutcome(decision.outcome, `${path}/outcome`, v, Object.hasOwn(decision, 'outcome'))
	if (status === 'decided' && !outcome)
		v.issue('decision.missing_outcome', `${path}/outcome`, 'A decided Decision requires its current outcome.')
	if ((status === 'pending' || status === 'deferred') && Object.hasOwn(decision, 'outcome'))
		v.issue('decision.outcome_not_current', `${path}/outcome`, 'Pending and deferred Decisions must not carry a current outcome.')

	const history = v.array(decision.history, `${path}/history`)
	let previousAfter: DecisionSnapshot | undefined
	history?.forEach((event, index) => {
		const eventPath = jsonPointer(`${path}/history`, index)
		const result = validateDecisionHistoryEntry(event, eventPath)
		v.diagnostics.push(...result.diagnostics)
		if (!result.ok) return
		if (previousAfter && !sameDecisionSnapshot(previousAfter, result.value.before))
			v.issue('decision.discontinuous_history', `${eventPath}/before`,
				'Decision history before/after snapshots must form one continuous lifecycle.')
		previousAfter = result.value.after
	})
	if (previousAfter && status) {
		const current: DecisionSnapshot = {
			status,
			...(status === 'decided' && outcome ? { outcome } : {}),
		}
		if (!sameDecisionSnapshot(previousAfter, current))
			v.issue('decision.history_state_mismatch', `${path}/history`,
				'The final Decision history snapshot must equal the current status and outcome.')
	}
	return v.finish<Decision>(input)
}

function validateDecisionStatus(value: unknown, path: string, v: Validator): DecisionStatus | undefined {
	if (value !== 'pending' && value !== 'deferred' && value !== 'decided') {
		v.issue('decision.invalid_status', path, 'Decision status must be pending, deferred, or decided.')
		return undefined
	}
	return value
}

function validateDecisionOutcome(value: unknown, path: string, v: Validator, present: boolean): DecisionOutcome | undefined {
	if (!present)
		return undefined
	const outcome = v.object(value, path)
	if (!outcome)
		return undefined
	rejectUnknownKeys(outcome, ['summary', 'rationale'], path, v)
	const summary = v.string(outcome.summary, `${path}/summary`, true)
	if (summary !== undefined && summary.trim().length === 0)
		v.issue('decision.empty_outcome_summary', `${path}/summary`, 'A decided outcome summary cannot contain only whitespace.')
	v.string(outcome.rationale, `${path}/rationale`)
	return outcome as DecisionOutcome
}

function validateDecisionSnapshot(value: unknown, path: string, v: Validator): DecisionSnapshot | undefined {
	const snapshot = v.object(value, path)
	if (!snapshot)
		return undefined
	rejectUnknownKeys(snapshot, ['status', 'outcome'], path, v)
	const status = validateDecisionStatus(snapshot.status, `${path}/status`, v)
	const hasOutcome = Object.hasOwn(snapshot, 'outcome')
	const outcome = validateDecisionOutcome(snapshot.outcome, `${path}/outcome`, v, hasOutcome)
	if (status === 'decided' && !outcome)
		v.issue('decision.history_missing_outcome', `${path}/outcome`, 'A decided history snapshot requires an outcome.')
	if ((status === 'pending' || status === 'deferred') && hasOutcome)
		v.issue('decision.history_stale_outcome', `${path}/outcome`, 'A pending or deferred history snapshot must not contain a current outcome.')
	return status ? (snapshot as DecisionSnapshot) : undefined
}

function sameDecisionSnapshot(left: DecisionSnapshot, right: DecisionSnapshot): boolean {
	if (left.status !== right.status) return false
	const leftOutcome = left.outcome
	const rightOutcome = right.outcome
	if (!leftOutcome || !rightOutcome) return leftOutcome === rightOutcome
	return leftOutcome.summary === rightOutcome.summary
		&& leftOutcome.rationale === rightOutcome.rationale
}

function validateDecisionHistoryEntry(input: unknown, path: string): ValidationResult<DecisionHistoryEntry> {
	const v = new Validator()
	const event = v.object(input, path)
	if (!event)
		return v.finish<DecisionHistoryEntry>(input)
	rejectUnknownKeys(event, ['at', 'actor', 'source', 'before', 'after'], path, v)
	validateUtcTimestamp(event.at, `${path}/at`, v)
	if (Object.hasOwn(event, 'actor')) {
		const actor = v.object(event.actor, `${path}/actor`)
		if (actor) {
			v.string(actor.type, `${path}/actor/type`, true)
			if (Object.hasOwn(actor, 'id')) v.string(actor.id, `${path}/actor/id`, true)
			if (Object.hasOwn(actor, 'displayName')) v.string(actor.displayName, `${path}/actor/displayName`)
		}
	}
	if (Object.hasOwn(event, 'source'))
		validateJsonValue(event.source, `${path}/source`, v)
	if (!Object.hasOwn(event, 'actor') && !Object.hasOwn(event, 'source'))
		v.issue('decision.history_missing_provenance', path, 'Decision history records its actor or source provenance.')
	const before = validateDecisionSnapshot(event.before, `${path}/before`, v)
	const after = validateDecisionSnapshot(event.after, `${path}/after`, v)
	if (before && after && before.status !== after.status && !isAllowedDecisionTransition(before.status, after.status))
		v.issue('decision.invalid_history_transition', path, `History transition ${before.status} -> ${after.status} is not allowed.`)
	if (before && after && before.status === after.status && before.status !== 'decided'
		&& (Object.hasOwn(before, 'outcome') || Object.hasOwn(after, 'outcome')))
		v.issue('decision.invalid_history_outcome', path, 'Only a decided Decision can record a current-outcome revision without a status transition.')
	if (before?.status === 'decided' && after?.status === 'pending'
		&& (!Object.hasOwn(before, 'outcome') || Object.hasOwn(after, 'outcome')))
		v.issue('decision.invalid_reopen_history', path, 'A decided-to-pending history event must retain the prior outcome only in before and clear it from after.')
	return v.finish<DecisionHistoryEntry>(input)
}

function validateStringList(value: unknown, path: string, v: Validator): void {
	const items = v.array(value, path)
	items?.forEach((item, index) => v.string(item, jsonPointer(path, index)))
}

function validateOptionalNonEmpty(object: Record<string, unknown>, key: string, path: string, v: Validator): void {
	if (Object.hasOwn(object, key))
		v.string(object[key], `${path}/${key}`, true)
}

export type DecisionTransitionInput = Readonly<{
	nextStatus: DecisionStatus
	at: string
	actor: DecisionActor
	source?: JsonValue
	outcome?: DecisionOutcome
}>

/** Explicit lifecycle action; reopen always clears the current outcome. */
export function transitionDecision(decision: Decision, input: DecisionTransitionInput): ValidationResult<Decision> {
	const v = new Validator()
	v.diagnostics.push(...validateDecision(decision).diagnostics)
	if (!isAllowedDecisionTransition(decision.status, input.nextStatus))
		v.issue('decision.invalid_transition', '/status', `Transition ${decision.status} -> ${input.nextStatus} is not allowed.`)
	validateUtcTimestamp(input.at, '/at', v)
	if (typeof input.actor !== 'object' || input.actor === null || typeof input.actor.type !== 'string' || input.actor.type.length === 0)
		v.issue('decision.invalid_actor', '/actor', 'Decision lifecycle action requires actor provenance.')
	if (input.source !== undefined)
		validateJsonValue(input.source, '/source', v)
	if (input.nextStatus === 'decided') {
		if (!input.outcome || input.outcome.summary.length === 0)
			v.issue('decision.missing_outcome', '/outcome', 'Deciding requires a non-empty summary and a rationale string.')
		else if (typeof input.outcome.rationale !== 'string')
			v.issue('decision.invalid_outcome', '/outcome/rationale', 'Decision rationale must be a string.')
	}
	if (v.diagnostics.length)
		return v.finish<Decision>(decision)

	const before: DecisionSnapshot = {
		status: decision.status,
		...(decision.outcome ? { outcome: decision.outcome } : {}),
	}
	const after: DecisionSnapshot = {
		status: input.nextStatus,
		...(input.nextStatus === 'decided' ? { outcome: input.outcome } : {}),
	}
	const event: DecisionHistoryEntry = {
		at: input.at,
		actor: input.actor,
		...(input.source === undefined ? {} : { source: input.source }),
		before,
		after,
	}
	const updated: Decision = {
		...decision,
		status: input.nextStatus,
		...(input.nextStatus === 'decided' ? { outcome: input.outcome } : { outcome: undefined }),
		history: [...decision.history, event],
	}
	if (input.nextStatus !== 'decided')
		delete (updated as { outcome?: DecisionOutcome }).outcome
	return v.finish<Decision>(updated)
}

export function isAllowedDecisionTransition(from: DecisionStatus, to: DecisionStatus): boolean {
	return (from === 'pending' && (to === 'deferred' || to === 'decided'))
		|| (from === 'deferred' && (to === 'pending' || to === 'decided'))
		|| (from === 'decided' && to === 'pending')
}
