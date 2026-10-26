import {
	validateUuid,
	Validator,
	type ValidationResult,
} from '../../domain/validation'
import { containsProtocolControl, FAILURE_DETAIL_MAX_LENGTH, type PreviewFailureDiagnostic } from './schema'

/**
 * `failure.report`, the carrier of a failure the runtime detects (Discussion #131, decision 8;
 * Clauses 01a11a59-dd69-78ed-9181-d8beb5f4cb7b, 01a11a59-def9-797a-8d08-5e4b02ecd900 and
 * 01a11a70-4261-7155-8aed-28bed7a89064). Runtime to Workbench only, and only for a generation that
 * declared the optional feature `failure.reports`; `protocolVersion` stays 1.
 *
 * The envelope is the report's correlation: `context` always names the session and the generation,
 * and names contour work only for a work-scoped report. The payload holds the diagnostic's
 * `category`, `reason` and optional `detail`, plus `sequence` and `baseSnapshotVersion` when they
 * apply. The payload shape is authoritative here (owner ruling Q1); the decoder codes are not.
 */

/** Optional capability feature; `protocolVersion` stays 1. */
export const FAILURE_REPORTS_FEATURE = 'failure.reports'

/** A runtime reports only these categories: a failure of its own, or a violation in Workbench traffic. */
export type FailureReportCategory = 'runtime' | 'protocol'
/** The only `protocol` reasons a runtime may report (Clause 01a11a70-4261-7155-8aed-28bed7a89064). */
export const REPORTABLE_PROTOCOL_REASONS: ReadonlySet<string> = new Set(['protocol.invalid_message', 'protocol.invalid_state'])

export type FailureReportContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId?: string
	variantId?: string
	runtimeContextVersion?: number
	navigationRequestId?: string
	widgetId?: string
	geometryRevision?: number
}>

export type FailureReportPayload = Readonly<{
	category: FailureReportCategory
	reason: string
	detail?: string
	sequence?: number
	baseSnapshotVersion?: number
}>

export type FailureReportMessage = Readonly<{
	type: 'failure.report'
	context: FailureReportContext
	payload: FailureReportPayload
}>

/** `generation`: ends and retires its generation. `work`: ends one contour work, the generation continues. */
export type FailureReportScope = 'generation' | 'work'

const WORK_CONTEXT_KEYS = ['viewId', 'variantId', 'runtimeContextVersion', 'navigationRequestId', 'widgetId', 'geometryRevision'] as const
/** Identities that sit in a payload, never in shared context. */
const PAYLOAD_ONLY_IDENTITIES = ['sequence', 'baseSnapshotVersion', 'snapshotVersion', 'regionId', 'regionIds', 'regions', 'category', 'reason', 'detail'] as const
/** Longest `reason` a decoder accepts, so a report stays bounded and display-safe. */
export const MAX_REASON_LENGTH = 100
export const RUNTIME_REASON_PATTERN = /^runtime\.[a-z0-9_]+(?:\.[a-z0-9_]+)*$/u

export function isFailureReportMessageType(type: unknown): type is FailureReportMessage['type'] {
	return type === 'failure.report'
}

/**
 * Validates one `failure.report` and returns a normalized copy that carries the known members
 * only; unknown additive members are ignored. The detail is bounded and free of control
 * characters, so it can be shown as text. A context that names some but not all of a contour
 * work's identities is neither scope and is invalid.
 */
export function validateFailureReportMessage(input: unknown): ValidationResult<FailureReportMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<FailureReportMessage>(input)
	const type = v.string(envelope.type, '/type', true)
	const context = v.object(envelope.context, '/context')
	const payload = v.object(envelope.payload, '/payload')
	if (type !== undefined && type !== 'failure.report')
		v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only failure.report.')
	if (!context || !payload) return v.finish<FailureReportMessage>(input)

	for (const key of ['previewSessionId', 'runtimeGenerationId'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `failure.report requires context.${key}.`)
		else v.string(context[key], `/context/${key}`, true)
	}
	for (const key of ['variantId', 'navigationRequestId', 'widgetId'] as const) {
		if (Object.hasOwn(context, key)) v.string(context[key], `/context/${key}`, true)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, '/context/viewId', v, 'View identity')
	for (const key of ['runtimeContextVersion', 'geometryRevision'] as const) {
		if (Object.hasOwn(context, key)) validateSequence(context[key], `/context/${key}`, v)
	}
	for (const key of PAYLOAD_ONLY_IDENTITIES) {
		if (Object.hasOwn(context, key))
			v.issue('protocol.identity_in_wrong_envelope', `/context/${key}`, `${key} belongs in the message payload, not in shared context.`)
	}
	for (const [key, value] of Object.entries(context)) {
		if (value === null) v.issue('protocol.null_optional_field', `/context/${key}`, 'Optional protocol fields are omitted instead of encoded as null.')
	}

	const category = payload.category
	if (category !== 'runtime' && category !== 'protocol')
		v.issue('protocol.invalid_failure_category', '/payload/category', 'A runtime reports only the runtime and protocol categories.')
	const reason = v.string(payload.reason, '/payload/reason', true)
	if (reason !== undefined && (category === 'runtime' || category === 'protocol')) {
		const reportable = category === 'runtime'
			? reason.length <= MAX_REASON_LENGTH && RUNTIME_REASON_PATTERN.test(reason)
			: REPORTABLE_PROTOCOL_REASONS.has(reason)
		if (!reportable) v.issue('protocol.failure_reason_not_reportable', '/payload/reason', 'A runtime reports runtime reasons, protocol.invalid_message and protocol.invalid_state only.')
	}
	if (Object.hasOwn(payload, 'detail')) {
		const detail = v.string(payload.detail, '/payload/detail')
		if (detail !== undefined && (detail.length > FAILURE_DETAIL_MAX_LENGTH || containsProtocolControl(detail)))
			v.issue('protocol.unsafe_failure_detail', '/payload/detail', 'Failure detail must be bounded and display-safe.')
	}
	for (const key of ['sequence', 'baseSnapshotVersion'] as const) {
		if (Object.hasOwn(payload, key)) validateSequence(payload[key], `/payload/${key}`, v)
	}

	// Scope: only the session and the generation, or complete contour-work identity.
	const workContext = WORK_CONTEXT_KEYS.filter(key => Object.hasOwn(context, key))
	const workPayload = (['sequence', 'baseSnapshotVersion'] as const).filter(key => Object.hasOwn(payload, key))
	if (workContext.length > 0 || workPayload.length > 0) {
		for (const required of ['viewId', 'widgetId', 'geometryRevision'] as const) {
			if (!Object.hasOwn(context, required)) v.issue('protocol.incomplete_failure_scope', `/context/${required}`, `A work-scoped failure.report names its contour work: context.${required} is missing.`)
		}
		if (!Object.hasOwn(payload, 'sequence')) v.issue('protocol.incomplete_failure_scope', '/payload/sequence', 'A work-scoped failure.report names its contour work: payload.sequence is missing.')
	}
	if (v.diagnostics.length) return v.finish<FailureReportMessage>(input)

	const normalizedContext: FailureReportContext = Object.freeze({
		previewSessionId: context.previewSessionId as string,
		runtimeGenerationId: context.runtimeGenerationId as string,
		...pick(context, WORK_CONTEXT_KEYS),
	})
	const normalizedPayload: FailureReportPayload = Object.freeze({
		category: category as FailureReportCategory,
		reason: reason as string,
		...(typeof payload.detail === 'string' ? { detail: payload.detail } : {}),
		...pick(payload, ['sequence', 'baseSnapshotVersion'] as const),
	})
	return v.finish<FailureReportMessage>(Object.freeze({ type: 'failure.report', context: normalizedContext, payload: normalizedPayload }))
}

/** The scope a decoded report has, which its context decides alone (Clause 01a11a59-def9-797a-8d08-5e4b02ecd900). */
export function failureReportScope(message: FailureReportMessage): FailureReportScope {
	return WORK_CONTEXT_KEYS.some(key => message.context[key] !== undefined) ? 'work' : 'generation'
}

/**
 * The diagnostic a report carries, as the Workbench shows it: category, reason, an optional
 * detail, and the correlation identities of the report's scope, which are its envelope's.
 */
export function failureReportDiagnostic(message: FailureReportMessage): PreviewFailureDiagnostic {
	const { context, payload } = message
	const correlation: Record<string, string | number> = {
		previewSessionId: context.previewSessionId,
		runtimeGenerationId: context.runtimeGenerationId,
	}
	for (const key of WORK_CONTEXT_KEYS) {
		const value = context[key]
		if (value !== undefined) correlation[key] = value
	}
	for (const key of ['sequence', 'baseSnapshotVersion'] as const) {
		const value = payload[key]
		if (value !== undefined) correlation[key] = value
	}
	return Object.freeze({
		category: payload.category,
		reason: payload.reason,
		...(payload.detail ? { detail: payload.detail } : {}),
		correlation: Object.freeze(correlation),
	})
}

function validateSequence(value: unknown, path: string, v: Validator): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		v.issue('protocol.invalid_sequence', path, 'Protocol sequence and revision values are non-negative JSON safe integers.')
}

/** Copies the named members that are present; typed so a spread satisfies their declared types (already validated). */
function pick<K extends string>(source: Record<string, unknown>, keys: readonly K[]): Partial<Record<K, never>> {
	const out: Record<string, unknown> = {}
	for (const key of keys) {
		if (Object.hasOwn(source, key)) out[key] = source[key]
	}
	return out as Partial<Record<K, never>>
}
