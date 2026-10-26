import { validateI18nWarning, type I18nWarning } from '../../domain/i18n/schema'
import {
	jsonPointer,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../../domain/validation'
import { MAX_REASON_LENGTH, RUNTIME_REASON_PATTERN } from './failure-report'
import { containsProtocolControl, FAILURE_DETAIL_MAX_LENGTH } from './schema'

/**
 * `checks.report`, the runtime's report of what Checks can show about the live Preview (owner
 * ruling 1 of 2026-10-26, Discussion #241; issue #347; Clauses 01a17619-89fc-7a94-b690-2e65c6a99f39,
 * 01a17619-ab3f-797d-ae93-4038a48ee31f and 01a1161c-4246-708c-9ab9-60e079b9d475). Runtime to
 * Workbench only, and only for a generation that declared the optional feature `checks.reports`;
 * `protocolVersion` stays 1.
 *
 * A report is the complete report of its generation, never a delta: a higher `sequence` replaces the
 * previous one. The warning shape is the `I18nWarning` of the Adapter authoring entry, and `reason`
 * and `detail` follow the bounds of `failure.report`.
 */

/** Optional capability feature; `protocolVersion` stays 1. */
export const CHECKS_REPORTS_FEATURE = 'checks.reports'

/** At most this many `translationWarnings` in one report (Clause 01a17619-ab3f-797d-ae93-4038a48ee31f). */
export const MAX_CHECKS_TRANSLATION_WARNINGS = 500
/** At most this many `runtimeErrors` in one report (Clause 01a17619-ab3f-797d-ae93-4038a48ee31f). */
export const MAX_CHECKS_RUNTIME_ERRORS = 100
/** Longest text member (a Widget identity, a Property name, a key or a parameter name) a decoder accepts. */
export const MAX_CHECKS_TEXT_LENGTH = FAILURE_DETAIL_MAX_LENGTH

/**
 * The reasons the runtime reports as `runtimeErrors` (Clause 01a17619-ab3f-797d-ae93-4038a48ee31f).
 * The decoder admits any `runtime.` reason code, as `failure.report` does, so a later reason needs
 * no new decoder.
 */
export const CHECKS_RUNTIME_ERROR_REASONS = Object.freeze([
	'runtime.view_load_failed',
	'runtime.adapter_invalid',
	'runtime.adapter_unavailable',
	'runtime.preview_blocked',
	'runtime.property_failed',
	'runtime.report_truncated',
] as const)

export type ChecksReportContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	/** The Variant name, present exactly while a Variant is selected. */
	variantId?: string
	runtimeContextVersion: number
}>

/** One evaluated translation-result Property's warning, attributed to its Widget and Property. */
export type ChecksTranslationWarning = Readonly<{
	widgetId: string
	resultProperty: string
	warning: I18nWarning
}>

export type ChecksRuntimeError = Readonly<{
	reason: string
	detail?: string
	widgetId?: string
}>

export type ChecksReportPayload = Readonly<{
	sequence: number
	translationWarnings: readonly ChecksTranslationWarning[]
	runtimeErrors: readonly ChecksRuntimeError[]
}>

export type ChecksReportMessage = Readonly<{
	type: 'checks.report'
	context: ChecksReportContext
	payload: ChecksReportPayload
}>

/** Identities that sit in a payload, never in shared context. */
const PAYLOAD_ONLY_IDENTITIES = ['sequence', 'translationWarnings', 'runtimeErrors'] as const
/** Context identities of other work, which this message never carries. */
const INAPPLICABLE_CONTEXT_KEYS = ['navigationRequestId', 'widgetId', 'geometryRevision'] as const

export function isChecksReportMessageType(type: unknown): type is ChecksReportMessage['type'] {
	return type === 'checks.report'
}

/**
 * Validates one `checks.report` and returns a normalized copy that carries the known members only;
 * unknown additive members are ignored. Every text member is bounded and free of control
 * characters, so it can be shown as text, and the two lists are capped.
 */
export function validateChecksReportMessage(input: unknown): ValidationResult<ChecksReportMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<ChecksReportMessage>(input)
	const type = v.string(envelope.type, '/type', true)
	const context = v.object(envelope.context, '/context')
	const payload = v.object(envelope.payload, '/payload')
	if (type !== undefined && type !== 'checks.report')
		v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only checks.report.')
	if (!context || !payload) return v.finish<ChecksReportMessage>(input)

	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId', 'runtimeContextVersion'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `checks.report requires context.${key}.`)
	}
	for (const key of ['previewSessionId', 'runtimeGenerationId'] as const) {
		if (Object.hasOwn(context, key)) v.string(context[key], `/context/${key}`, true)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, '/context/viewId', v, 'View identity')
	if (Object.hasOwn(context, 'variantId')) v.string(context.variantId, '/context/variantId', true)
	if (Object.hasOwn(context, 'runtimeContextVersion')) validateCount(context.runtimeContextVersion, '/context/runtimeContextVersion', v)
	for (const key of INAPPLICABLE_CONTEXT_KEYS) {
		if (Object.hasOwn(context, key)) v.issue('protocol.inapplicable_context_identity', `/context/${key}`, `checks.report carries no ${key}.`)
	}
	for (const key of PAYLOAD_ONLY_IDENTITIES) {
		if (Object.hasOwn(context, key)) v.issue('protocol.identity_in_wrong_envelope', `/context/${key}`, `${key} belongs in the message payload, not in shared context.`)
	}
	for (const [key, value] of Object.entries(context)) {
		if (value === null) v.issue('protocol.null_optional_field', `/context/${key}`, 'Optional protocol fields are omitted instead of encoded as null.')
	}

	if (!Object.hasOwn(payload, 'sequence')) v.issue('protocol.invalid_sequence', '/payload/sequence', 'checks.report carries payload.sequence.')
	else validateCount(payload.sequence, '/payload/sequence', v)

	const warnings: ChecksTranslationWarning[] = []
	const warningList = v.array(payload.translationWarnings, '/payload/translationWarnings')
	if (warningList && warningList.length > MAX_CHECKS_TRANSLATION_WARNINGS)
		v.issue('protocol.too_many_translation_warnings', '/payload/translationWarnings', `A checks.report holds at most ${MAX_CHECKS_TRANSLATION_WARNINGS} translation warnings.`)
	else {
		warningList?.forEach((item, index) => {
			const entry = decodeTranslationWarning(item, jsonPointer('/payload/translationWarnings', index), v)
			if (entry) warnings.push(entry)
		})
	}

	const errors: ChecksRuntimeError[] = []
	const errorList = v.array(payload.runtimeErrors, '/payload/runtimeErrors')
	if (errorList && errorList.length > MAX_CHECKS_RUNTIME_ERRORS)
		v.issue('protocol.too_many_runtime_errors', '/payload/runtimeErrors', `A checks.report holds at most ${MAX_CHECKS_RUNTIME_ERRORS} runtime errors.`)
	else {
		errorList?.forEach((item, index) => {
			const entry = decodeRuntimeError(item, jsonPointer('/payload/runtimeErrors', index), v)
			if (entry) errors.push(entry)
		})
	}
	if (v.diagnostics.length) return v.finish<ChecksReportMessage>(input)

	return v.finish<ChecksReportMessage>(Object.freeze({
		type: 'checks.report',
		context: Object.freeze({
			previewSessionId: context.previewSessionId as string,
			runtimeGenerationId: context.runtimeGenerationId as string,
			viewId: context.viewId as string,
			...(typeof context.variantId === 'string' ? { variantId: context.variantId } : {}),
			runtimeContextVersion: context.runtimeContextVersion as number,
		}),
		payload: Object.freeze({
			sequence: payload.sequence as number,
			translationWarnings: Object.freeze(warnings),
			runtimeErrors: Object.freeze(errors),
		}),
	}))
}

function decodeTranslationWarning(item: unknown, path: string, v: Validator): ChecksTranslationWarning | undefined {
	const entry = v.object(item, path)
	if (!entry) return undefined
	const before = v.diagnostics.length
	const widgetId = boundedText(entry.widgetId, `${path}/widgetId`, v, true)
	const resultProperty = boundedText(entry.resultProperty, `${path}/resultProperty`, v, true)
	const warning = validateI18nWarning(entry.warning, `${path}/warning`)
	v.diagnostics.push(...warning.diagnostics)
	if (warning.ok) {
		// The key and parameter are author text; they are bounded and display-safe like every other member.
		boundedText(warning.value.key, `${path}/warning/key`, v, true)
		if (warning.value.code === 'missing-parameter') boundedText(warning.value.parameter, `${path}/warning/parameter`, v, true)
	}
	if (v.diagnostics.length > before || !warning.ok || widgetId === undefined || resultProperty === undefined) return undefined
	return Object.freeze({ widgetId, resultProperty, warning: Object.freeze({ ...warning.value }) })
}

function decodeRuntimeError(item: unknown, path: string, v: Validator): ChecksRuntimeError | undefined {
	const entry = v.object(item, path)
	if (!entry) return undefined
	const before = v.diagnostics.length
	const reason = v.string(entry.reason, `${path}/reason`, true)
	if (reason !== undefined && (reason.length > MAX_REASON_LENGTH || !RUNTIME_REASON_PATTERN.test(reason)))
		v.issue('protocol.failure_reason_not_reportable', `${path}/reason`, 'A runtime error carries a runtime reason code.')
	let detail: string | undefined
	if (Object.hasOwn(entry, 'detail')) {
		detail = v.string(entry.detail, `${path}/detail`)
		if (detail !== undefined && (detail.length > FAILURE_DETAIL_MAX_LENGTH || containsProtocolControl(detail)))
			v.issue('protocol.unsafe_failure_detail', `${path}/detail`, 'Runtime error detail must be bounded and display-safe.')
	}
	const widgetId = Object.hasOwn(entry, 'widgetId') ? boundedText(entry.widgetId, `${path}/widgetId`, v, true) : undefined
	if (v.diagnostics.length > before || reason === undefined) return undefined
	return Object.freeze({ reason, ...(detail ? { detail } : {}), ...(widgetId !== undefined ? { widgetId } : {}) })
}

function boundedText(value: unknown, path: string, v: Validator, nonEmpty: boolean): string | undefined {
	const text = v.string(value, path, nonEmpty)
	if (text !== undefined && (text.length > MAX_CHECKS_TEXT_LENGTH || containsProtocolControl(text)))
		v.issue('protocol.unsafe_text', path, 'Report text must be bounded and display-safe.')
	return text
}

function validateCount(value: unknown, path: string, v: Validator): void {
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
		v.issue('protocol.invalid_sequence', path, 'Protocol sequence and revision values are non-negative JSON safe integers.')
}
