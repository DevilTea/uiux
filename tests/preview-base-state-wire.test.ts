import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import {
	BASE_STATE_FEATURE,
	baseStateMemberOf,
	baseStateResponseAnswers,
	encodeBaseStateResponse,
	MAX_BASE_STATE_KEYS,
	MAX_BASE_STATE_RESPONSE_LENGTH,
	toBaseStateValue,
	unavailableReadings,
	validateBaseStateMessage,
	type BaseStateRequestMessage,
	type BaseStateResponseMessage,
} from '../src/preview/protocol/base-state'
import { jsonLength } from '../src/preview/protocol/checks-report'
import { FAILURE_REPORTS_FEATURE } from '../src/preview/protocol/failure-report'
import { declaredRuntimeFeatures } from '../src/preview/declared-features'

/**
 * `inspection.base-state` on the wire (issue #52; owner ruling of 2026-11-02, Discussion #241): the
 * decoder and its bounds (Clauses 01a19a9b-308e-7377-ac04-54b81a96e5ed,
 * 01a19a9b-347f-782c-bd9a-22dc52096603 and 01a19ab9-cc7c-749c-98fc-ebf18dd27743), the encoder's
 * bound on the whole envelope, the bridges' gates, and the features each kind of Preview declares.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const compatible = { ok: true } as const
const WITH_BASE_STATE = { protocolVersion: 1, features: ['geometry', FAILURE_REPORTS_FEATURE, BASE_STATE_FEATURE] } as const
const WITHOUT_BASE_STATE = { protocolVersion: 1, features: ['geometry', FAILURE_REPORTS_FEATURE] } as const

const context = (overrides: Record<string, unknown> = {}) => ({
	previewSessionId: 'session-a',
	runtimeGenerationId: 'generation-a',
	viewId: VIEW_ID,
	variantId: 'Loading',
	...overrides,
})
const request = (payload: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => ({
	type: 'inspection.base-state.request',
	context: context(ctx),
	payload: { requestId: 'request-1', widgetId: 'button-1', keys: ['count', 'label'], ...payload },
})
const renderContext = (overrides: Record<string, unknown> = {}) => ({
	viewRevision: 'revision-1',
	locale: 'en-US',
	viewportId: 'desktop',
	viewport: { width: 1280, height: 800 },
	themeId: 'light',
	...overrides,
})
const response = (payload: Record<string, unknown> = {}, ctx: Record<string, unknown> = {}) => ({
	type: 'inspection.base-state.response',
	context: context(ctx),
	payload: {
		requestId: 'request-1',
		widgetId: 'button-1',
		renderContext: renderContext(),
		values: { count: { value: 0 }, label: { unavailable: true } },
		...payload,
	},
})
const issues = (input: unknown) => {
	const result = validateBaseStateMessage(input)
	return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}
const decodedResponse = (input: unknown): BaseStateResponseMessage => {
	const result = validateBaseStateMessage(input)
	if (!result.ok || result.value.type !== 'inspection.base-state.response') throw new Error(`not decoded: ${result.diagnostics.map(d => d.code).join(', ')}`)
	return result.value
}

describe('inspection.base-state request decoder', () => {
	it('decodes a request to its known members and ignores additive ones', () => {
		const result = validateBaseStateMessage({ ...request({ extra: 1 }, { extra: 2 }), extraTop: true })
		expect(result).toMatchObject({ ok: true })
		expect(result.ok && result.value).toEqual({
			type: 'inspection.base-state.request',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, variantId: 'Loading' },
			payload: { requestId: 'request-1', widgetId: 'button-1', keys: ['count', 'label'] },
		})
		// The Variant is present exactly while one is open.
		const base = request()
		delete (base.context as Record<string, unknown>).variantId
		expect(issues(base)).toEqual([])
	})

	it('requires the context identities and keeps payload identities out of shared context', () => {
		for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId']) {
			const input = request()
			delete (input.context as Record<string, unknown>)[key]
			expect(issues(input)).toContain('protocol.missing_context_identity')
		}
		expect(issues(request({}, { viewId: 'not-a-uuid' }))).not.toEqual([])
		expect(issues(request({}, { variantId: null }))).toContain('protocol.null_optional_field')
		expect(issues(request({}, { requestId: 'r' }))).toContain('protocol.identity_in_wrong_envelope')
		expect(issues(request({}, { widgetId: 'w' }))).toContain('protocol.identity_in_wrong_envelope')
		expect(issues(request({}, { runtimeContextVersion: 1 }))).toContain('protocol.inapplicable_context_identity')
	})

	it('bounds requestId, widgetId and every key as non-empty display-safe text of at most 500 characters', () => {
		expect(issues(request({ requestId: 'r'.repeat(500), widgetId: 'w'.repeat(500), keys: ['k'.repeat(500)] }))).toEqual([])
		expect(issues(request({ requestId: '' }))).toContain('schema.empty_string')
		expect(issues(request({ requestId: 'r'.repeat(501) }))).toContain('protocol.unsafe_text')
		expect(issues(request({ widgetId: 'w'.repeat(501) }))).toContain('protocol.unsafe_text')
		expect(issues(request({ keys: ['k'.repeat(501)] }))).toContain('protocol.unsafe_text')
		expect(issues(request({ keys: ['a\u0000b'] }))).toContain('protocol.unsafe_text')
		expect(issues(request({ keys: [''] }))).toContain('schema.empty_string')
		expect(issues(request({ keys: [3] }))).toContain('schema.expected_string')
		const noRequestId = request()
		delete (noRequestId.payload as Record<string, unknown>).requestId
		expect(issues(noRequestId)).toContain('protocol.missing_base_state_member')
		const noWidget = request()
		delete (noWidget.payload as Record<string, unknown>).widgetId
		expect(issues(noWidget)).toContain('protocol.missing_base_state_member')
	})

	it('holds 1 to 64 distinct keys', () => {
		const keys = (count: number) => Array.from({ length: count }, (_, index) => `key-${index}`)
		expect(issues(request({ keys: keys(1) }))).toEqual([])
		expect(issues(request({ keys: keys(MAX_BASE_STATE_KEYS) }))).toEqual([])
		expect(issues(request({ keys: [] }))).toContain('protocol.invalid_base_state_keys')
		expect(issues(request({ keys: keys(MAX_BASE_STATE_KEYS + 1) }))).toContain('protocol.invalid_base_state_keys')
		expect(issues(request({ keys: ['a', 'b', 'a'] }))).toContain('protocol.duplicate_base_state_key')
		expect(issues(request({ keys: 'count' }))).toContain('schema.expected_array')
	})

	it('accepts a key named like an Object.prototype member as an ordinary key', () => {
		const result = validateBaseStateMessage(request({ keys: ['__proto__', 'constructor', 'toString'] }))
		expect(result.ok && result.value.type === 'inspection.base-state.request' && result.value.payload.keys).toEqual(['__proto__', 'constructor', 'toString'])
	})

	it('rejects an unknown type, a non-envelope and a missing context or payload', () => {
		expect(issues({ ...request(), type: 'inspection.base-state.nope' })).toContain('protocol.unknown_message_type')
		expect(issues('nope')).toContain('schema.expected_object')
		expect(issues({ type: 'inspection.base-state.request', payload: {} })).toContain('schema.expected_object')
	})
})

describe('inspection.base-state response decoder', () => {
	it('decodes `{ value }` members, `null` among them, and `{ unavailable: true }` members', () => {
		const message = decodedResponse(response({
			values: {
				zero: { value: 0 },
				nothing: { value: null },
				no: { value: false },
				text: { value: 'a' },
				list: { value: [1, 'b', null, [true]] },
				object: { value: { nested: { deep: [1] } } },
				gone: { unavailable: true },
			},
		}))
		expect(message.payload.requestId).toBe('request-1')
		expect(message.payload.widgetId).toBe('button-1')
		expect(message.payload.renderContext).toEqual(renderContext())
		expect(message.payload.values).toEqual({
			zero: { value: 0 },
			nothing: { value: null },
			no: { value: false },
			text: { value: 'a' },
			list: { value: [1, 'b', null, [true]] },
			object: { value: { nested: { deep: [1] } } },
			gone: { unavailable: true },
		})
		expect(baseStateMemberOf(message.payload.values, 'nothing')).toEqual({ value: null })
	})

	it('rejects a member with both, with neither, with `unavailable` other than true, or with a value that is not allowed', () => {
		const values = (member: unknown) => response({ values: { count: member } })
		expect(issues(values({ value: 1, unavailable: true }))).toContain('protocol.invalid_base_state_member')
		expect(issues(values({}))).toContain('protocol.invalid_base_state_member')
		expect(issues(values({ unavailable: false }))).toContain('protocol.invalid_base_state_member')
		expect(issues(values({ unavailable: 'true' }))).toContain('protocol.invalid_base_state_member')
		expect(issues(values('bare'))).toContain('schema.expected_object')
		expect(issues(values({ value: undefined }))).toContain('protocol.invalid_base_state_value')
		expect(issues(values({ value: Number.NaN }))).toContain('protocol.invalid_base_state_value')
		expect(issues(values({ value: Number.POSITIVE_INFINITY }))).toContain('protocol.invalid_base_state_value')
		expect(issues(values({ value: () => 1 }))).toContain('protocol.invalid_base_state_value')
		expect(issues(values({ value: { inner: undefined } }))).toContain('protocol.invalid_base_state_value')
		expect(issues(values({ value: new Date(0) }))).toContain('protocol.invalid_base_state_value')
		// An absent `unavailable` or a `value` member of another kind of value is not a reason.
		expect(issues(values({ value: 1, reason: 'why' }))).toEqual([])
	})

	it('reads `values` through its own members only, and a `__proto__` key stays an own member', () => {
		const wire = JSON.parse('{"__proto__":{"value":1},"constructor":{"unavailable":true}}') as Record<string, unknown>
		expect(Object.hasOwn(wire, '__proto__')).toBe(true)
		const message = decodedResponse(response({ values: wire }))
		expect(Object.keys(message.payload.values).sort()).toEqual(['__proto__', 'constructor'])
		expect(baseStateMemberOf(message.payload.values, '__proto__')).toEqual({ value: 1 })
		expect(baseStateMemberOf(message.payload.values, 'constructor')).toEqual({ unavailable: true })
		// A member the object only inherits is not read, and an object with a prototype is no plain object.
		const inherited = Object.create({ inheritedKey: { value: 'leaked' } }) as Record<string, unknown>
		inherited.own = { value: 1 }
		expect(issues(response({ values: inherited }))).toContain('schema.expected_object')
		const decoded = decodedResponse(response({ values: { own: { value: 1 } } }))
		expect(baseStateMemberOf(decoded.payload.values, 'inheritedKey')).toEqual({ unavailable: true })
		expect(baseStateMemberOf(decoded.payload.values, 'toString')).toEqual({ unavailable: true })
		// An accessor is no data member.
		const accessor = {}
		Object.defineProperty(accessor, 'count', { enumerable: true, get: () => ({ value: 1 }) })
		expect(issues(response({ values: accessor }))).toContain('protocol.invalid_base_state_member')
	})

	it('answers a request only with exactly its keys, echoing its requestId and widgetId', () => {
		const message = decodedResponse(response({ values: { count: { value: 1 }, label: { unavailable: true } } }))
		const asked = { requestId: 'request-1', widgetId: 'button-1', keys: ['label', 'count'] }
		expect(baseStateResponseAnswers(message, asked)).toBe(true)
		expect(baseStateResponseAnswers(message, { ...asked, requestId: 'request-2' })).toBe(false)
		expect(baseStateResponseAnswers(message, { ...asked, widgetId: 'button-2' })).toBe(false)
		expect(baseStateResponseAnswers(message, { ...asked, keys: ['count'] })).toBe(false)
		expect(baseStateResponseAnswers(message, { ...asked, keys: ['count', 'label', 'extra'] })).toBe(false)
		expect(baseStateResponseAnswers(message, { ...asked, keys: ['count', 'other'] })).toBe(false)
		// A key the response lacks is not answered by an inherited member of the same name.
		const lacking = decodedResponse(response({ values: { count: { value: 1 } } }))
		expect(baseStateResponseAnswers(lacking, { ...asked, keys: ['count', '__proto__'] })).toBe(false)
		expect(baseStateResponseAnswers(lacking, { ...asked, keys: ['count', 'toString'] })).toBe(false)
	})

	it('holds 1 to 64 members, each named by display-safe text', () => {
		const members = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, index) => [`key-${index}`, { unavailable: true }]))
		expect(issues(response({ values: members(MAX_BASE_STATE_KEYS) }))).toEqual([])
		expect(issues(response({ values: members(MAX_BASE_STATE_KEYS + 1) }))).toContain('protocol.invalid_base_state_keys')
		expect(issues(response({ values: {} }))).toContain('protocol.invalid_base_state_keys')
		expect(issues(response({ values: { ['k'.repeat(501)]: { unavailable: true } } }))).toContain('protocol.unsafe_text')
		expect(issues(response({ values: [] }))).toContain('schema.expected_object')
	})

	it('requires the five renderContext members, with bounded text and a canonical Locale', () => {
		expect(issues(response({ renderContext: renderContext({ viewRevision: 'r'.repeat(500) }) }))).toEqual([])
		for (const key of ['viewRevision', 'locale', 'viewportId', 'viewport', 'themeId']) {
			const incomplete = renderContext()
			delete (incomplete as Record<string, unknown>)[key]
			expect(issues(response({ renderContext: incomplete }))).not.toEqual([])
		}
		expect(issues(response({ renderContext: renderContext({ viewRevision: '' }) }))).toContain('schema.empty_string')
		expect(issues(response({ renderContext: renderContext({ viewRevision: 'r'.repeat(501) }) }))).toContain('protocol.unsafe_text')
		expect(issues(response({ renderContext: renderContext({ themeId: 't'.repeat(501) }) }))).toContain('protocol.unsafe_text')
		expect(issues(response({ renderContext: renderContext({ viewportId: 'a\u0007' }) }))).toContain('protocol.unsafe_text')
		expect(issues(response({ renderContext: renderContext({ locale: 'en_us' }) }))).toContain('render_context.invalid_locale')
		expect(issues(response({ renderContext: renderContext({ viewport: { width: Number.NaN, height: 800 } }) }))).toContain('schema.expected_finite_number')
		expect(issues(response({ renderContext: renderContext({ viewport: { width: 1, height: '8' } }) }))).toContain('schema.expected_finite_number')
		expect(issues(response({ renderContext: undefined }))).toContain('schema.expected_object')
	})

	it('refuses a response whose whole envelope exceeds 1048576 characters of JSON, and admits one at the bound', () => {
		const sized = (length: number) => response({ values: { big: { value: 'x'.repeat(length) } } })
		const overhead = jsonLength(sized(0))
		const atBound = sized(MAX_BASE_STATE_RESPONSE_LENGTH - overhead)
		expect(jsonLength(atBound)).toBe(MAX_BASE_STATE_RESPONSE_LENGTH)
		expect(issues(atBound)).toEqual([])
		const beyond = sized(MAX_BASE_STATE_RESPONSE_LENGTH - overhead + 1)
		expect(jsonLength(beyond)).toBe(MAX_BASE_STATE_RESPONSE_LENGTH + 1)
		expect(issues(beyond)).toEqual(['protocol.base_state_too_large'])
	})
})

describe('inspection.base-state values', () => {
	it('copies allowed values and refuses every other one instead of coercing it', () => {
		const original = { a: [1, { b: null }], text: 's', flag: true }
		const copied = toBaseStateValue(original)
		expect(copied).toEqual({ ok: true, value: original })
		if (copied.ok) expect(copied.value).not.toBe(original)
		expect(toBaseStateValue(null)).toEqual({ ok: true, value: null })
		expect(toBaseStateValue(JSON.parse('{"__proto__":{"x":1}}'))).toEqual({ ok: true, value: JSON.parse('{"__proto__":{"x":1}}') })
		class Point { x = 1 }
		const cyclic: Record<string, unknown> = {}
		cyclic.self = cyclic
		const sparse = [1, 2, 3]
		delete sparse[1]
		for (const refused of [undefined, () => 1, Symbol('s'), 10n, Number.NaN, Number.POSITIVE_INFINITY, new Point(), new Date(0), new Map(), cyclic, sparse, { inner: undefined }])
			expect(toBaseStateValue(refused)).toEqual({ ok: false })
		// A value nested too deeply to serialize is refused rather than thrown.
		let deep: unknown = 'leaf'
		for (let index = 0; index < 200_000; index++) deep = [deep]
		expect(toBaseStateValue(deep)).toEqual({ ok: false })
	})
})

describe('inspection.base-state response encoder', () => {
	const wireContext = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID } as const
	const encode = (readings: Parameters<typeof encodeBaseStateResponse>[0]['readings']) => encodeBaseStateResponse({
		context: wireContext,
		requestId: 'request-1',
		widgetId: 'button-1',
		renderContext: renderContext() as never,
		readings,
	})

	it('answers every key in request order, as an own member of an object without a prototype', () => {
		const message = encode([
			{ key: '__proto__', member: { value: 1 } },
			{ key: 'count', member: { unavailable: true } },
			{ key: 'toString', member: { value: null } },
		])
		expect(Object.keys(message.payload.values)).toEqual(['__proto__', 'count', 'toString'])
		expect(Object.getPrototypeOf(message.payload.values)).toBeNull()
		expect(Object.getOwnPropertyDescriptor(message.payload.values, '__proto__')?.value).toEqual({ value: 1 })
		// It survives its own decoder and a JSON round trip.
		expect(validateBaseStateMessage(message).ok).toBe(true)
		expect(validateBaseStateMessage(JSON.parse(JSON.stringify(message))).ok).toBe(true)
		expect(JSON.stringify(message)).toContain('"__proto__":{"value":1}')
	})

	it('makes a value that would pass the bound Unavailable, taking keys in request order', () => {
		// A key not yet decided counts as Unavailable, so the answer never passes the bound whatever follows.
		const skeleton = jsonLength(encode(unavailableReadings(['a', 'b', 'c'])))
		const length = (member: unknown) => JSON.stringify(member).length
		const unavailableLength = length({ unavailable: true })
		const afterA = skeleton - unavailableLength + length({ value: 'small' })
		const fits = MAX_BASE_STATE_RESPONSE_LENGTH - afterA + unavailableLength - length({ value: '' })
		const atBound = encode([
			{ key: 'a', member: { value: 'small' } },
			{ key: 'b', member: { value: 'x'.repeat(fits) } },
			{ key: 'c', member: { value: 'tail' } },
		])
		expect(jsonLength(atBound)).toBeLessThanOrEqual(MAX_BASE_STATE_RESPONSE_LENGTH)
		expect(atBound.payload.values).toEqual({ a: { value: 'small' }, b: { value: 'x'.repeat(fits) }, c: { value: 'tail' } })
		expect(validateBaseStateMessage(atBound).ok).toBe(true)
		const beyond = encode([
			{ key: 'a', member: { value: 'small' } },
			{ key: 'b', member: { value: 'x'.repeat(fits + 1) } },
			{ key: 'c', member: { value: 'tail' } },
		])
		// The value over the bound is Unavailable; the ones before it keep theirs, and a later one that fits still does.
		expect(beyond.payload.values).toEqual({ a: { value: 'small' }, b: { unavailable: true }, c: { value: 'tail' } })
		expect(jsonLength(beyond)).toBeLessThanOrEqual(MAX_BASE_STATE_RESPONSE_LENGTH)
		expect(validateBaseStateMessage(beyond).ok).toBe(true)
		// Earlier keys take the room first: a later key that no longer fits is the Unavailable one.
		const first = encode([
			{ key: 'a', member: { value: 'x'.repeat(MAX_BASE_STATE_RESPONSE_LENGTH - 2000) } },
			{ key: 'b', member: { value: 'x'.repeat(5000) } },
		])
		expect(first.payload.values.a).toMatchObject({ value: expect.any(String) })
		expect(first.payload.values.b).toEqual({ unavailable: true })
	})

	it('answers every key Unavailable when it can read none', () => {
		const message = encode(unavailableReadings(['a', 'b']))
		expect(message.payload.values).toEqual({ a: { unavailable: true }, b: { unavailable: true } })
	})
})

function collector(messages: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send(message) { messages.push(message) } }
}

/** A Workbench bridge with generation-a open, and the runtime bridge that declared it. */
function openGeneration(declaration: typeof WITH_BASE_STATE | typeof WITHOUT_BASE_STATE = WITH_BASE_STATE) {
	const workbenchOutbound: PreviewWireMessage[] = []
	const runtimeOutbound: PreviewWireMessage[] = []
	const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
	const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', declaration, collector(runtimeOutbound))
	expect(workbench.receive(runtime.declareCapabilities()).status).toBe('ack-dispatched')
	return { workbench, runtime, workbenchOutbound, runtimeOutbound }
}

describe('inspection.base-state in the bridges', () => {
	it('sends a request only after the ACK and only to a generation that declared the feature, and the runtime sees it after observing the ACK', () => {
		const workbenchOutbound: PreviewWireMessage[] = []
		const runtimeOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', WITH_BASE_STATE, collector(runtimeOutbound))
		const message = request() as unknown as BaseStateRequestMessage
		// Before the generation is admitted and acknowledged nothing crosses.
		expect(workbench.sendBaseStateRequest(message).status).not.toBe('sent')
		workbench.receive(runtime.declareCapabilities())
		expect(workbench.sendBaseStateRequest(message)).toEqual({ status: 'sent' })
		const sent = workbenchOutbound.at(-1)!
		// Traffic of its own generation before the ACK is observed is an established violation.
		expect(runtime.receive(sent)).toEqual({ status: 'invalid-state', detail: 'inspection.base-state.request before capability.ack' })
		expect(runtime.receive(workbenchOutbound[0])).toMatchObject({ status: 'accepted' })
		expect(runtime.receive(sent)).toMatchObject({ status: 'accepted', message: { type: 'inspection.base-state.request' } })
	})

	it('does not send to a generation that did not declare the feature, and the runtime drops what it does not know', () => {
		const { workbench, runtime, workbenchOutbound } = openGeneration(WITHOUT_BASE_STATE)
		const before = workbenchOutbound.length
		expect(workbench.sendBaseStateRequest(request() as unknown as BaseStateRequestMessage)).toEqual({ status: 'not-permitted' })
		expect(workbenchOutbound).toHaveLength(before)
		runtime.receive(workbenchOutbound[0])
		// Even a request that reaches it, valid or not, is dropped without effect and fails nothing.
		expect(runtime.receive(request())).toEqual({ status: 'gated' })
		expect(runtime.receive(request({ keys: [] }))).toEqual({ status: 'gated' })
		expect(runtime.sendBaseStateResponse(response() as unknown as BaseStateResponseMessage)).toEqual({ status: 'not-permitted' })
	})

	it('does not send a request beyond a bound or a response, and refuses the wrong direction on receive', () => {
		const { workbench, runtime, workbenchOutbound, runtimeOutbound } = openGeneration()
		runtime.receive(workbenchOutbound[0])
		const before = workbenchOutbound.length
		const tooMany = workbench.sendBaseStateRequest(request({ keys: Array.from({ length: MAX_BASE_STATE_KEYS + 1 }, (_, index) => `k${index}`) }) as unknown as BaseStateRequestMessage)
		expect(tooMany.status).toBe('invalid')
		expect(workbench.sendBaseStateRequest(request({ widgetId: 'w'.repeat(501) }) as unknown as BaseStateRequestMessage).status).toBe('invalid')
		expect(workbench.sendBaseStateRequest(response() as unknown as BaseStateRequestMessage)).toEqual({ status: 'wrong-direction' })
		expect(workbenchOutbound).toHaveLength(before)
		// A request travels the other way only as a request, a response only as a response.
		expect(workbench.receive(request())).toEqual({ status: 'wrong-direction' })
		expect(runtime.receive(response())).toEqual({ status: 'wrong-direction' })
		expect(runtime.sendBaseStateResponse(request() as unknown as BaseStateResponseMessage)).toEqual({ status: 'wrong-direction' })
		expect(runtimeOutbound.filter(message => message.type.startsWith('inspection.'))).toEqual([])
	})

	it('treats a request beyond a bound or undecodable as an invalid message, and a response that is not pending as nothing the bridge judges', () => {
		const { runtime, workbenchOutbound, runtimeOutbound } = openGeneration()
		runtime.receive(workbenchOutbound[0])
		const over = request({ keys: Array.from({ length: MAX_BASE_STATE_KEYS + 1 }, (_, index) => `k${index}`) })
		const result = runtime.receive(over)
		expect(result).toMatchObject({ status: 'invalid' })
		if (result.status !== 'invalid') throw new Error('expected invalid')
		// The invalid-message rule: one generation-scoped failure.report, as for any undecodable Workbench traffic.
		expect(runtime.reportInvalidTraffic(over, result.diagnostics)).toEqual({ status: 'sent' })
		expect(runtimeOutbound.at(-1)).toMatchObject({ type: 'failure.report', payload: { category: 'protocol', reason: 'protocol.invalid_message' } })
	})

	it('drops stale traffic of another session or generation without a verdict', () => {
		const { workbench, runtime, workbenchOutbound } = openGeneration()
		runtime.receive(workbenchOutbound[0])
		expect(runtime.receive(request({}, { previewSessionId: 'session-b' }))).toEqual({ status: 'stale-session' })
		expect(runtime.receive(request({}, { runtimeGenerationId: 'generation-b' }))).toEqual({ status: 'stale-generation' })
		expect(workbench.receive(response({}, { previewSessionId: 'session-b' }))).toEqual({ status: 'stale-session' })
	})

	it('lets the runtime send a response only after the ACK, and the Workbench accepts it for the open generation that declared the feature', () => {
		const { workbench, runtime, workbenchOutbound, runtimeOutbound } = openGeneration()
		const answer = response() as unknown as BaseStateResponseMessage
		expect(runtime.sendBaseStateResponse(answer)).toEqual({ status: 'gated' })
		runtime.receive(workbenchOutbound[0])
		expect(runtime.sendBaseStateResponse(answer)).toEqual({ status: 'sent' })
		const sent = runtimeOutbound.at(-1)!
		const received = workbench.receive(sent)
		expect(received).toMatchObject({ status: 'accepted', message: { type: 'inspection.base-state.response', payload: { requestId: 'request-1', widgetId: 'button-1' } } })
		if (received.status === 'accepted' && received.message.type === 'inspection.base-state.response')
			expect(baseStateMemberOf(received.message.payload.values, 'count')).toEqual({ value: 0 })
	})

	it('drops a response of a generation that did not declare the feature, without failing it', () => {
		const { workbench } = openGeneration(WITHOUT_BASE_STATE)
		expect(workbench.receive(response())).toEqual({ status: 'gated' })
	})

	it('rejects a response that does not decode or exceeds its bound, whole, never as an invalid message', () => {
		const { workbench } = openGeneration()
		const broken = workbench.receive(response({ values: { count: { value: 1, unavailable: true } } }))
		expect(broken).toMatchObject({ status: 'rejected', requestId: 'request-1' })
		expect(broken.status).not.toBe('invalid')
		const huge = workbench.receive(response({ values: { big: { value: 'x'.repeat(MAX_BASE_STATE_RESPONSE_LENGTH) } } }))
		expect(huge).toMatchObject({ status: 'rejected', requestId: 'request-1', diagnostics: [{ code: 'protocol.base_state_too_large' }] })
		// Nothing names a request when the payload has no requestId.
		const anonymous = response()
		delete (anonymous.payload as Record<string, unknown>).requestId
		const result = workbench.receive(anonymous)
		expect(result.status).toBe('rejected')
		expect(result).not.toHaveProperty('requestId')
		// The generation is still open: a valid response is accepted afterwards.
		expect(workbench.receive(response())).toMatchObject({ status: 'accepted' })
	})
})

describe('inspection.base-state declaration', () => {
	it('is declared only by a Workbench Preview', () => {
		expect(declaredRuntimeFeatures({ harness: false, version: false })).toContain(BASE_STATE_FEATURE)
		expect(declaredRuntimeFeatures({ harness: true, version: false })).not.toContain(BASE_STATE_FEATURE)
		expect(declaredRuntimeFeatures({ harness: false, version: true })).not.toContain(BASE_STATE_FEATURE)
		expect(declaredRuntimeFeatures({ harness: true, version: true })).not.toContain(BASE_STATE_FEATURE)
		expect(BASE_STATE_FEATURE).toBe('inspection.base-state')
	})
})
