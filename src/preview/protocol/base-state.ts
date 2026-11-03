import {
	isCanonicalLocaleTag,
	jsonPointer,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../../domain/validation'
import { jsonLength, MAX_CHECKS_REPORT_LENGTH } from './checks-report'
import { containsProtocolControl, FAILURE_DETAIL_MAX_LENGTH } from './schema'

/**
 * `inspection.base-state`, the Workbench's read of a Widget's base-state values (owner ruling of
 * 2026-11-02, Discussion #241, with its follow-up; issue #52; Clauses
 * 01a19a9b-308e-7377-ac04-54b81a96e5ed, 01a19a9b-347f-782c-bd9a-22dc52096603,
 * 01a19a9b-386b-7598-a0b9-6865cb9fd6e0, 01a19ab9-cc7c-749c-98fc-ebf18dd27743 and
 * 01a1161c-4246-708c-9ab9-60e079b9d475). The Workbench sends `inspection.base-state.request` and the
 * runtime answers with `inspection.base-state.response`. The runtime also reports the View revision
 * it mounted with `inspection.base-state.mounted` (Discussion #241, owner ruling 2026-11-03; issue
 * #484; Clause 01a19ab9-d028-7bb9-a370-4736992852f5). Only a generation that declared the optional
 * feature takes part, and only a Workbench Preview declares it; `protocolVersion` stays 1.
 *
 * `requestId` is the Workbench's, compared by equality only. A response's `values` has exactly one
 * own member per requested key, either `{ value }` or `{ unavailable: true }`, and is read through
 * own members only, so a State member named `__proto__` or `constructor` is an ordinary key.
 */

/** Optional capability feature; `protocolVersion` stays 1. */
export const BASE_STATE_FEATURE = 'inspection.base-state'

/** A request holds 1 to this many distinct keys (Clause 01a19a9b-347f-782c-bd9a-22dc52096603). */
export const MAX_BASE_STATE_KEYS = 64
/** Longest `requestId`, `widgetId`, key or `renderContext` text member: the text bound of `failure.report`. */
export const MAX_BASE_STATE_TEXT_LENGTH = FAILURE_DETAIL_MAX_LENGTH
/** At most this many characters of JSON in a whole response envelope: the bound of `checks.report`. */
export const MAX_BASE_STATE_RESPONSE_LENGTH = MAX_CHECKS_REPORT_LENGTH

export const BASE_STATE_MESSAGE_TYPES = ['inspection.base-state.request', 'inspection.base-state.response', 'inspection.base-state.mounted'] as const

/** A value a runtime may report: `null`, a boolean, a finite number, a string, or an array or plain object of these. */
export type BaseStateValue =
	| null
	| boolean
	| number
	| string
	| readonly BaseStateValue[]
	| Readonly<{ [key: string]: BaseStateValue }>

/** One key's answer: its value, or that it cannot be read. `{ unavailable: true }` carries no reason. */
export type BaseStateMember =
	| Readonly<{ value: BaseStateValue }>
	| Readonly<{ unavailable: true }>

export type BaseStateContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	/** The open Variant's name, present exactly while a Variant is open. */
	variantId?: string
}>

/**
 * The render context a response's values were computed for (Clause 01a19ab9-cc7c-749c-98fc-ebf18dd27743):
 * the revision of the View read the runtime mounted, an opaque string, and the Locale, viewport and
 * theme as a resolved render context defines them. The Workbench compares the five members by equality.
 */
export type BaseStateRenderContext = Readonly<{
	viewRevision: string
	locale: string
	viewportId: string
	viewport: Readonly<{ width: number; height: number }>
	themeId: string
}>

/** Workbench to runtime: the State members `keys` of the Widget `widgetId`. */
export type BaseStateRequestMessage = Readonly<{
	type: 'inspection.base-state.request'
	context: BaseStateContext
	payload: Readonly<{ requestId: string; widgetId: string; keys: readonly string[] }>
}>

/** Runtime to Workbench: one member per requested key, in an object read through its own members. */
export type BaseStateResponseMessage = Readonly<{
	type: 'inspection.base-state.response'
	context: BaseStateContext
	payload: Readonly<{
		requestId: string
		widgetId: string
		renderContext: BaseStateRenderContext
		values: Readonly<Record<string, BaseStateMember>>
	}>
}>

/**
 * Runtime to Workbench, sent after every mount completes: the revision of the View read the Runtime
 * that just mounted was built from (display-safe text of at most 500 characters). Its context names
 * the session and the generation only: a mount belongs to the generation, not to a View or Variant.
 */
export type BaseStateMountedMessage = Readonly<{
	type: 'inspection.base-state.mounted'
	context: Readonly<{ previewSessionId: string; runtimeGenerationId: string }>
	payload: Readonly<{ viewRevision: string }>
}>

export type BaseStateMessage = BaseStateRequestMessage | BaseStateResponseMessage | BaseStateMountedMessage

export function isBaseStateMessageType(type: unknown): type is BaseStateMessage['type'] {
	return typeof type === 'string' && (BASE_STATE_MESSAGE_TYPES as readonly string[]).includes(type)
}

export function isBaseStateRequestMessage(message: BaseStateMessage): message is BaseStateRequestMessage {
	return message.type === 'inspection.base-state.request'
}

export function isBaseStateMountedMessage(message: BaseStateMessage): message is BaseStateMountedMessage {
	return message.type === 'inspection.base-state.mounted'
}

/**
 * The `inspection.base-state.mounted` message for a Runtime that mounted: `undefined` when the mount
 * carries no View revision (without one, nothing is reported and no base state is answered).
 */
export function baseStateMountedMessage(
	identity: Readonly<{ previewSessionId: string; runtimeGenerationId: string }>,
	mounted: Readonly<{ viewRevision?: string }>,
): BaseStateMountedMessage | undefined {
	if (mounted.viewRevision === undefined) return undefined
	return {
		type: 'inspection.base-state.mounted',
		context: { previewSessionId: identity.previewSessionId, runtimeGenerationId: identity.runtimeGenerationId },
		payload: { viewRevision: mounted.viewRevision },
	}
}

/** Identities that sit in a payload, never in shared context. */
const PAYLOAD_ONLY_IDENTITIES = ['requestId', 'widgetId', 'keys', 'values', 'renderContext'] as const
/** Context identities of other work, which these messages never carry. */
const INAPPLICABLE_CONTEXT_KEYS = ['navigationRequestId', 'geometryRevision', 'runtimeContextVersion'] as const

/**
 * Validates one `inspection.base-state` message and returns a normalized copy that carries the known
 * members only; unknown additive members are ignored. A response's `values` of the copy is a frozen
 * object without a prototype, so every key, `__proto__` included, is an own member.
 */
export function validateBaseStateMessage(input: unknown): ValidationResult<BaseStateMessage> {
	const v = new Validator()
	const envelope = v.object(input, '')
	if (!envelope) return v.finish<BaseStateMessage>(input)
	const type = v.string(envelope.type, '/type', true)
	const context = v.object(envelope.context, '/context')
	const payload = v.object(envelope.payload, '/payload')
	if (type !== undefined && !isBaseStateMessageType(type))
		v.issue('protocol.unknown_message_type', '/type', 'This decoder accepts only inspection.base-state.request and inspection.base-state.response.')
	if (!context || !payload || !isBaseStateMessageType(type)) return v.finish<BaseStateMessage>(input)
	if (type === 'inspection.base-state.mounted') return decodeMounted(input, context, payload, v)
	const response = type === 'inspection.base-state.response'
	for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `${type} requires context.${key}.`)
	}
	for (const key of ['previewSessionId', 'runtimeGenerationId'] as const) {
		if (Object.hasOwn(context, key)) boundedText(context[key], `/context/${key}`, true, v)
	}
	if (Object.hasOwn(context, 'viewId')) validateUuid(context.viewId, '/context/viewId', v, 'View identity')
	if (Object.hasOwn(context, 'variantId')) boundedText(context.variantId, '/context/variantId', true, v)
	for (const key of INAPPLICABLE_CONTEXT_KEYS) {
		if (Object.hasOwn(context, key)) v.issue('protocol.inapplicable_context_identity', `/context/${key}`, `${type} carries no ${key}.`)
	}
	for (const key of PAYLOAD_ONLY_IDENTITIES) {
		if (Object.hasOwn(context, key)) v.issue('protocol.identity_in_wrong_envelope', `/context/${key}`, `${key} belongs in the message payload, not in shared context.`)
	}
	for (const [key, value] of Object.entries(context)) {
		if (value === null) v.issue('protocol.null_optional_field', `/context/${key}`, 'Optional protocol fields are omitted instead of encoded as null.')
	}

	// Only `requestId` must be non-empty; a Widget identity and a State member name are display-safe text (Clause 01a19a9b-347f-782c-bd9a-22dc52096603).
	const requestId = requiredText(payload, 'requestId', true, v)
	const widgetId = requiredText(payload, 'widgetId', false, v)
	let keys: readonly string[] | undefined
	let renderContext: BaseStateRenderContext | undefined
	let values: Readonly<Record<string, BaseStateMember>> | undefined
	if (response) {
		renderContext = decodeRenderContext(payload.renderContext, '/payload/renderContext', v)
		values = decodeValues(payload.values, '/payload/values', createValueBudget(), v)
	}
	else {
		keys = decodeKeys(payload.keys, '/payload/keys', v)
	}
	if (v.diagnostics.length) return v.finish<BaseStateMessage>(input)

	const normalizedContext: BaseStateContext = Object.freeze({
		previewSessionId: context.previewSessionId as string,
		runtimeGenerationId: context.runtimeGenerationId as string,
		viewId: context.viewId as string,
		...(typeof context.variantId === 'string' ? { variantId: context.variantId } : {}),
	})
	if (response) {
		const message = Object.freeze({
			type,
			context: normalizedContext,
			payload: Object.freeze({ requestId: requestId!, widgetId: widgetId!, renderContext: renderContext!, values: values! }),
		})
		// The bound is on the envelope the Workbench acts on; the values were walked under a budget first, so measuring it is cheap.
		if (jsonLength(message) > MAX_BASE_STATE_RESPONSE_LENGTH) {
			v.issue('protocol.base_state_too_large', '', `An inspection.base-state.response holds at most ${MAX_BASE_STATE_RESPONSE_LENGTH} characters of JSON.`)
			return v.finish<BaseStateMessage>(input)
		}
		return v.finish<BaseStateMessage>(message)
	}
	return v.finish<BaseStateMessage>(Object.freeze({
		type,
		context: normalizedContext,
		payload: Object.freeze({ requestId: requestId!, widgetId: widgetId!, keys: keys! }),
	}))
}

/**
 * Decodes `inspection.base-state.mounted`: the session and generation identities, and a non-empty
 * `viewRevision`. Any other member (a `viewId` or `variantId` a sender adds) is an additive one and
 * is dropped from the normalized copy.
 */
function decodeMounted(
	input: unknown,
	context: Record<string, unknown>,
	payload: Record<string, unknown>,
	v: Validator,
): ValidationResult<BaseStateMessage> {
	for (const key of ['previewSessionId', 'runtimeGenerationId'] as const) {
		if (!Object.hasOwn(context, key)) v.issue('protocol.missing_context_identity', `/context/${key}`, `inspection.base-state.mounted requires context.${key}.`)
		else boundedText(context[key], `/context/${key}`, true, v)
	}
	const viewRevision = requiredText(payload, 'viewRevision', true, v)
	if (v.diagnostics.length) return v.finish<BaseStateMessage>(input)
	return v.finish<BaseStateMessage>(Object.freeze({
		type: 'inspection.base-state.mounted' as const,
		context: Object.freeze({ previewSessionId: context.previewSessionId as string, runtimeGenerationId: context.runtimeGenerationId as string }),
		payload: Object.freeze({ viewRevision: viewRevision! }),
	}))
}

function decodeKeys(value: unknown, path: string, v: Validator): readonly string[] | undefined {
	const list = v.array(value, path)
	if (!list) return undefined
	if (list.length < 1 || list.length > MAX_BASE_STATE_KEYS) {
		v.issue('protocol.invalid_base_state_keys', path, `A request holds 1 to ${MAX_BASE_STATE_KEYS} keys.`)
		return undefined
	}
	const before = v.diagnostics.length
	const seen = new Set<string>()
	const keys: string[] = []
	list.forEach((item, index) => {
		const key = boundedText(item, jsonPointer(path, index), false, v)
		if (key === undefined) return
		if (seen.has(key)) v.issue('protocol.duplicate_base_state_key', jsonPointer(path, index), 'A request names each key at most once.')
		seen.add(key)
		keys.push(key)
	})
	return v.diagnostics.length > before ? undefined : Object.freeze(keys)
}

function decodeRenderContext(value: unknown, path: string, v: Validator): BaseStateRenderContext | undefined {
	const entry = v.object(value, path)
	if (!entry) return undefined
	const before = v.diagnostics.length
	const viewRevision = boundedText(entry.viewRevision, `${path}/viewRevision`, true, v)
	const locale = boundedText(entry.locale, `${path}/locale`, true, v)
	if (locale !== undefined && !isCanonicalLocaleTag(locale)) v.issue('render_context.invalid_locale', `${path}/locale`, 'Locale must be a canonical BCP 47 tag.')
	const viewportId = boundedText(entry.viewportId, `${path}/viewportId`, true, v)
	const themeId = boundedText(entry.themeId, `${path}/themeId`, true, v)
	const viewport = v.object(entry.viewport, `${path}/viewport`)
	const width = viewport ? v.finiteNumber(viewport.width, `${path}/viewport/width`) : undefined
	const height = viewport ? v.finiteNumber(viewport.height, `${path}/viewport/height`) : undefined
	if (v.diagnostics.length > before) return undefined
	return Object.freeze({
		viewRevision: viewRevision!,
		locale: locale!,
		viewportId: viewportId!,
		viewport: Object.freeze({ width: width!, height: height! }),
		themeId: themeId!,
	})
}

/** Reads `values` through its own members only; a prototype member of another name is never consulted. */
function decodeValues(value: unknown, path: string, budget: ValueBudget, v: Validator): Readonly<Record<string, BaseStateMember>> | undefined {
	const entry = v.object(value, path)
	if (!entry) return undefined
	const keys = Object.keys(entry)
	if (keys.length < 1 || keys.length > MAX_BASE_STATE_KEYS) {
		v.issue('protocol.invalid_base_state_keys', path, `A response holds 1 to ${MAX_BASE_STATE_KEYS} members.`)
		return undefined
	}
	const before = v.diagnostics.length
	const decoded: Record<string, BaseStateMember> = Object.create(null)
	for (const key of keys) {
		const memberPath = jsonPointer(path, key)
		boundedText(key, memberPath, false, v)
		const descriptor = Object.getOwnPropertyDescriptor(entry, key)
		if (!descriptor || !('value' in descriptor)) {
			v.issue('protocol.invalid_base_state_member', memberPath, 'A member is a plain data member.')
			continue
		}
		const member = decodeMember(descriptor.value, memberPath, budget, v)
		if (member) Object.defineProperty(decoded, key, { value: member, enumerable: true, writable: true, configurable: true })
	}
	return v.diagnostics.length > before ? undefined : Object.freeze(decoded)
}

function decodeMember(item: unknown, path: string, budget: ValueBudget, v: Validator): BaseStateMember | undefined {
	const member = v.object(item, path)
	if (!member) return undefined
	const hasValue = Object.hasOwn(member, 'value')
	const hasUnavailable = Object.hasOwn(member, 'unavailable')
	if (hasValue === hasUnavailable) {
		v.issue('protocol.invalid_base_state_member', path, 'A member holds exactly one of value and unavailable.')
		return undefined
	}
	if (hasUnavailable) {
		if (member.unavailable !== true) {
			v.issue('protocol.invalid_base_state_member', `${path}/unavailable`, 'unavailable is true when present.')
			return undefined
		}
		return UNAVAILABLE_MEMBER
	}
	const copied = toBaseStateValue(member.value, budget)
	if (!copied.ok) {
		if (copied.tooLarge) v.issue('protocol.base_state_too_large', `${path}/value`, 'A response is walked for at most as many values as its envelope bound has characters.')
		else v.issue('protocol.invalid_base_state_value', `${path}/value`, 'A value is null, a boolean, a finite number, a string, or an array or plain object of these.')
		return undefined
	}
	return Object.freeze({ value: copied.value })
}

function requiredText(payload: Record<string, unknown>, key: string, nonEmpty: boolean, v: Validator): string | undefined {
	if (!Object.hasOwn(payload, key)) {
		v.issue('protocol.missing_base_state_member', `/payload/${key}`, `The message carries payload.${key}.`)
		return undefined
	}
	return boundedText(payload[key], `/payload/${key}`, nonEmpty, v)
}

/** A display-safe string of at most `MAX_BASE_STATE_TEXT_LENGTH` characters, non-empty when `nonEmpty`. */
function boundedText(value: unknown, path: string, nonEmpty: boolean, v: Validator): string | undefined {
	const text = v.string(value, path, nonEmpty)
	if (text !== undefined && (text.length > MAX_BASE_STATE_TEXT_LENGTH || containsProtocolControl(text)))
		v.issue('protocol.unsafe_text', path, 'Base-state text must be bounded and display-safe.')
	return text
}

export const UNAVAILABLE_MEMBER: BaseStateMember = Object.freeze({ unavailable: true as const })

/**
 * How many values one walk (or all the walks of one response) may visit, so a value that shares
 * structure with itself (a DAG a few dozen levels deep is exponentially large as a tree) is refused
 * after bounded work instead of expanded. One visit is at least one character of JSON, so a value
 * past this many visits could not fit the envelope bound anyway.
 */
export type ValueBudget = { remaining: number }

export function createValueBudget(): ValueBudget {
	return { remaining: MAX_BASE_STATE_RESPONSE_LENGTH }
}

const NOT_REPORTABLE = Symbol('not reportable')
const TOO_LARGE = Symbol('too large')

/**
 * Whether `raw` is a value a runtime may report, and a copy of it detached from the original.
 * Anything else (`undefined`, a function, a symbol, a bigint, NaN or an infinite number, a cycle, a
 * class instance, a sparse array, an accessor) is not reportable and reads Unavailable; it is never
 * coerced to `null`. A value that takes more than `budget` visits is refused with `tooLarge`. The
 * copy is built member by member, so a `__proto__` member stays an own member of it.
 */
export function toBaseStateValue(
	raw: unknown,
	budget: ValueBudget = createValueBudget(),
): Readonly<{ ok: true; value: BaseStateValue }> | Readonly<{ ok: false; tooLarge?: true }> {
	const ancestors = new Set<object>()
	const dataMember = (owner: object, key: string): unknown => {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key)
		if (!descriptor || !('value' in descriptor)) throw NOT_REPORTABLE
		return descriptor.value
	}
	const walk = (value: unknown): BaseStateValue => {
		if (--budget.remaining < 0) throw TOO_LARGE
		if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
		if (typeof value === 'number') {
			if (!Number.isFinite(value)) throw NOT_REPORTABLE
			return value
		}
		if (typeof value !== 'object' || ancestors.has(value)) throw NOT_REPORTABLE
		ancestors.add(value)
		let copy: BaseStateValue
		if (Array.isArray(value)) {
			const keys = Object.keys(value)
			if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) throw NOT_REPORTABLE
			const items: BaseStateValue[] = []
			for (const key of keys) items.push(walk(dataMember(value, key)))
			copy = items
		}
		else {
			const prototype = Object.getPrototypeOf(value)
			if (prototype !== Object.prototype && prototype !== null) throw NOT_REPORTABLE
			const members: Record<string, BaseStateValue> = {}
			for (const key of Object.keys(value))
				Object.defineProperty(members, key, { value: walk(dataMember(value, key)), enumerable: true, writable: true, configurable: true })
			copy = members
		}
		ancestors.delete(value)
		return copy
	}
	try {
		return { ok: true, value: walk(raw) }
	}
	catch (cause) {
		if (cause === TOO_LARGE) return { ok: false, tooLarge: true }
		// Not reportable, or nested too deeply to walk (`RangeError`).
		return { ok: false }
	}
}

/**
 * Builds the response to `request`. `readings` holds one entry per requested key in request order, a
 * value already checked with `toBaseStateValue`. Taking keys in that order, a value that would take the
 * whole envelope's JSON past `MAX_BASE_STATE_RESPONSE_LENGTH` is `{ unavailable: true }` instead
 * (Clause 01a19a9b-347f-782c-bd9a-22dc52096603). The result is the message to send: the bridge
 * validates it again before it leaves.
 */
export function encodeBaseStateResponse(input: Readonly<{
	context: BaseStateContext
	requestId: string
	widgetId: string
	renderContext: BaseStateRenderContext
	readings: readonly Readonly<{ key: string; member: BaseStateMember }>[]
}>): BaseStateResponseMessage {
	const values: Record<string, BaseStateMember> = Object.create(null)
	const message: BaseStateResponseMessage = {
		type: 'inspection.base-state.response',
		context: input.context,
		payload: { requestId: input.requestId, widgetId: input.widgetId, renderContext: input.renderContext, values },
	}
	const set = (key: string, member: BaseStateMember) => Object.defineProperty(values, key, { value: member, enumerable: true, writable: true, configurable: true })
	for (const { key } of input.readings) set(key, UNAVAILABLE_MEMBER)
	const unavailableLength = jsonLength(UNAVAILABLE_MEMBER)
	let length = jsonLength(message)
	for (const { key, member } of input.readings) {
		if (!('value' in member)) continue
		const memberLength = jsonLength(member)
		// A value that cannot be serialized is over any bound.
		if (length - unavailableLength + memberLength > MAX_BASE_STATE_RESPONSE_LENGTH) continue
		length += memberLength - unavailableLength
		set(key, member)
	}
	return message
}

/** Every key Unavailable: what a runtime answers when it can read none of them. */
export function unavailableReadings(keys: readonly string[]): readonly Readonly<{ key: string; member: BaseStateMember }>[] {
	return keys.map(key => ({ key, member: UNAVAILABLE_MEMBER }))
}

/**
 * Whether a decoded response answers `request` the way Clause 01a19ab9-d028-7bb9-a370-4736992852f5
 * requires: its `requestId` and `widgetId` echo the request's, and `values` has exactly the request's
 * keys, each as an own member. A response that names the request but fails this is rejected whole.
 */
export function baseStateResponseAnswers(
	response: BaseStateResponseMessage,
	request: Readonly<{ requestId: string; widgetId: string; keys: readonly string[] }>,
): boolean {
	if (response.payload.requestId !== request.requestId || response.payload.widgetId !== request.widgetId) return false
	const answered = Object.keys(response.payload.values)
	return answered.length === request.keys.length && request.keys.every(key => Object.hasOwn(response.payload.values, key))
}

/**
 * One key's member of a decoded response, through own members only; a key the response does not
 * hold reads as unavailable.
 */
export function baseStateMemberOf(values: Readonly<Record<string, BaseStateMember>>, key: string): BaseStateMember {
	return Object.hasOwn(values, key) ? values[key]! : UNAVAILABLE_MEMBER
}
