import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	BASE_STATE_RESPONSE_TIMEOUT_MS,
	baseStateBatches,
	createBaseStateRequests,
	mintBaseStateRequestId,
	type BaseStateRequests,
	type BaseStateTarget,
} from '../app/utils/base-state-requests'
import {
	MAX_BASE_STATE_KEYS,
	MAX_BASE_STATE_TEXT_LENGTH,
	UNAVAILABLE_MEMBER,
	validateBaseStateMessage,
	type BaseStateMember,
	type BaseStateRenderContext,
	type BaseStateRequestMessage,
	type BaseStateResponseMessage,
} from '../src/preview/protocol/base-state'

/**
 * The Workbench side of `inspection.base-state` (issue #52): the controller that asks the Preview for
 * the base values of the State members a Variant overrides. Contract Clauses
 * 01a19a9b-3c4d-74cb-9695-ce20087e2188 (one pending request, batches of at most 64, the text bound,
 * the 5000 ms wait, abandonment) and 01a19ab9-d028-7bb9-a370-4736992852f5 (stale, rejected whole,
 * one re-ask), and Feature Rule 01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc (the Base cell never shows a
 * default or a guess).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const RENDER: BaseStateRenderContext = { viewRevision: 'rev-1', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }

function target(overrides: Partial<BaseStateTarget> & { generation?: string; variant?: string | null } = {}): BaseStateTarget {
	const { generation = 'gen-1', variant = 'Error', ...rest } = overrides
	return {
		supported: true,
		context: { previewSessionId: 'session-1', runtimeGenerationId: generation, viewId: VIEW_ID, ...(variant ? { variantId: variant } : {}) },
		renderContext: RENDER,
		widgetId: 'btn',
		keys: ['disabled'],
		...rest,
	}
}

type Harness = ReturnType<typeof harness>
function harness(options: Readonly<{ sendStatus?: (request: BaseStateRequestMessage) => string }> = {}) {
	const sent: BaseStateRequestMessage[] = []
	let ids = 0
	let changes = 0
	const controller: BaseStateRequests = createBaseStateRequests({
		send: (request) => {
			sent.push(request)
			return { status: options.sendStatus?.(request) ?? 'sent' }
		},
		mintRequestId: () => `req-${++ids}`,
		changed: () => { changes++ },
	})
	return {
		controller,
		sent,
		get changes() { return changes },
		/** The response to the latest (or given) request, answering each key from `answers` (default: `{ value: false }`). */
		respond(request: BaseStateRequestMessage = sent.at(-1)!, answers: Readonly<Record<string, BaseStateMember>> = {}, extra: Partial<BaseStateResponseMessage['payload']> = {}, context = request.context): void {
			const values: Record<string, BaseStateMember> = Object.create(null)
			for (const key of request.payload.keys) Object.defineProperty(values, key, { value: answers[key] ?? { value: false }, enumerable: true })
			const decoded = validateBaseStateMessage({
				type: 'inspection.base-state.response',
				context,
				payload: { requestId: request.payload.requestId, widgetId: request.payload.widgetId, renderContext: RENDER, values, ...extra },
			})
			if (!decoded.ok) throw new Error(`fixture response invalid: ${JSON.stringify(decoded.diagnostics)}`)
			controller.receive({ kind: 'response', message: decoded.value as BaseStateResponseMessage })
		},
	}
}

const manyKeys = (count: number) => Array.from({ length: count }, (_, index) => `key${index}`)
const read = (h: Harness, key = 'disabled') => h.controller.read(key)

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('a request for the overridden keys of the selected Widget', () => {
	it('is sent when the Widget is selected, with a fresh non-empty requestId and the open context', () => {
		const h = harness()
		h.controller.retarget(target())
		expect(h.sent).toHaveLength(1)
		expect(h.sent[0]).toEqual({
			type: 'inspection.base-state.request',
			context: { previewSessionId: 'session-1', runtimeGenerationId: 'gen-1', viewId: VIEW_ID, variantId: 'Error' },
			payload: { requestId: 'req-1', widgetId: 'btn', keys: ['disabled'] },
		})
		expect(validateBaseStateMessage(h.sent[0]).ok).toBe(true)
		expect(read(h)).toEqual({ status: 'pending' })
	})

	it('reads the answered value, and an unavailable member as Unavailable', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['disabled', 'count', 'missing'] }))
		h.respond(h.sent[0], { disabled: { value: false }, count: { value: { list: [1, null] } }, missing: UNAVAILABLE_MEMBER })
		expect(read(h, 'disabled')).toEqual({ status: 'value', value: false })
		expect(read(h, 'count')).toEqual({ status: 'value', value: { list: [1, null] } })
		expect(read(h, 'missing')).toEqual({ status: 'unavailable' })
	})

	it('never reads a default or a guess: an unanswered key stays pending, never a value', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['a', 'b'] }))
		expect(read(h, 'a')).toEqual({ status: 'pending' })
		expect(read(h, 'b')).toEqual({ status: 'pending' })
	})

	it('mints a distinct requestId for every request, and the page-wide mint never repeats', () => {
		const h = harness()
		h.controller.retarget(target({ keys: manyKeys(130) }))
		h.respond()
		h.respond()
		expect(new Set(h.sent.map(request => request.payload.requestId)).size).toBe(3)
		const minted = new Set([mintBaseStateRequestId(), mintBaseStateRequestId(), mintBaseStateRequestId()])
		expect(minted.size).toBe(3)
		for (const id of minted) expect(id.length).toBeGreaterThan(0)
	})

	it('asks nothing for a Widget with no overridden keys, and nothing before a Widget is selected', () => {
		const h = harness()
		h.controller.retarget(target({ keys: [] }))
		h.controller.retarget(target({ widgetId: undefined }))
		expect(h.sent).toHaveLength(0)
	})

	it('does not send again for an unchanged target', () => {
		const h = harness()
		h.controller.retarget(target())
		h.controller.retarget(target())
		expect(h.sent).toHaveLength(1)
	})
})

describe('one request pending at a time, in batches of at most 64 (Clause 01a19a9b-3c4d)', () => {
	it('sends the next batch only after the pending one ended, and each carries at most 64 keys', () => {
		const h = harness()
		const keys = manyKeys(150)
		h.controller.retarget(target({ keys }))
		expect(h.sent).toHaveLength(1)
		expect(h.sent[0]!.payload.keys).toEqual(keys.slice(0, 64))
		// Keys of an unsent batch read pending, not Unavailable.
		expect(read(h, 'key100')).toEqual({ status: 'pending' })
		h.respond()
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]!.payload.keys).toEqual(keys.slice(64, 128))
		h.respond()
		expect(h.sent).toHaveLength(3)
		expect(h.sent[2]!.payload.keys).toEqual(keys.slice(128))
		h.respond()
		expect(h.sent.every(request => request.payload.keys.length <= MAX_BASE_STATE_KEYS)).toBe(true)
		expect(keys.every(key => read(h, key).status === 'value')).toBe(true)
	})

	it('splits exactly at the bound', () => {
		expect(baseStateBatches(manyKeys(64)).map(batch => batch.length)).toEqual([64])
		expect(baseStateBatches(manyKeys(65)).map(batch => batch.length)).toEqual([64, 1])
		expect(baseStateBatches(manyKeys(128)).map(batch => batch.length)).toEqual([64, 64])
	})

	it('a later batch follows a timed-out one', () => {
		const h = harness()
		h.controller.retarget(target({ keys: manyKeys(70) }))
		vi.advanceTimersByTime(BASE_STATE_RESPONSE_TIMEOUT_MS)
		expect(read(h, 'key0')).toEqual({ status: 'unavailable' })
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]!.payload.keys).toEqual(manyKeys(70).slice(64))
	})
})

describe('the text bound (Clause 01a19a9b-347f)', () => {
	const long = 'x'.repeat(MAX_BASE_STATE_TEXT_LENGTH + 1)

	it('sends no key beyond 500 characters: that key reads Unavailable and the others are asked', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['ok', long, 'x'.repeat(MAX_BASE_STATE_TEXT_LENGTH)] }))
		expect(h.sent).toHaveLength(1)
		expect(h.sent[0]!.payload.keys).toEqual(['ok', 'x'.repeat(MAX_BASE_STATE_TEXT_LENGTH)])
		expect(read(h, long)).toEqual({ status: 'unavailable' })
		expect(read(h, 'ok')).toEqual({ status: 'pending' })
	})

	it('sends nothing for a widgetId beyond 500 characters: every key reads Unavailable', () => {
		const h = harness()
		h.controller.retarget(target({ widgetId: long, keys: ['a', 'b'] }))
		expect(h.sent).toHaveLength(0)
		expect(read(h, 'a')).toEqual({ status: 'unavailable' })
		expect(read(h, 'b')).toEqual({ status: 'unavailable' })
	})

	it('sends no key that holds a protocol control character', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['ok', 'bad\u0000key'] }))
		expect(h.sent[0]!.payload.keys).toEqual(['ok'])
		expect(read(h, 'bad\u0000key')).toEqual({ status: 'unavailable' })
	})
})

describe('the 5000 ms wait', () => {
	it('ends the request with its keys Unavailable, and a later response is stale', () => {
		const h = harness()
		h.controller.retarget(target())
		const request = h.sent[0]!
		vi.advanceTimersByTime(BASE_STATE_RESPONSE_TIMEOUT_MS - 1)
		expect(read(h)).toEqual({ status: 'pending' })
		vi.advanceTimersByTime(1)
		expect(read(h)).toEqual({ status: 'unavailable' })
		h.respond(request)
		expect(read(h)).toEqual({ status: 'unavailable' })
	})

	it('is the contour refinement wait, 5000 ms', () => {
		expect(BASE_STATE_RESPONSE_TIMEOUT_MS).toBe(5000)
	})

	it('does not end an answered request later', () => {
		const h = harness()
		h.controller.retarget(target())
		h.respond()
		vi.advanceTimersByTime(BASE_STATE_RESPONSE_TIMEOUT_MS * 2)
		expect(read(h)).toEqual({ status: 'value', value: false })
	})
})

describe('abandonment (Clause 01a19a9b-3c4d)', () => {
	const changes: ReadonlyArray<readonly [string, Partial<BaseStateTarget> & { generation?: string; variant?: string | null }]> = [
		['the selected Widget', { widgetId: 'other' }],
		['the generation', { generation: 'gen-2' }],
		['the Variant', { variant: 'Other' }],
		['the View revision', { renderContext: { ...RENDER, viewRevision: 'rev-2' } }],
		['the Locale', { renderContext: { ...RENDER, locale: 'zh-TW' } }],
		['the viewport', { renderContext: { ...RENDER, viewportId: 'mobile', viewport: { width: 390, height: 800 } } }],
		['the viewport size', { renderContext: { ...RENDER, viewport: { width: 1281, height: 800 } } }],
		['the theme', { renderContext: { ...RENDER, themeId: 'dark' } }],
		['the View', { context: { previewSessionId: 'session-1', runtimeGenerationId: 'gen-1', viewId: '11111111-1111-4111-8111-111111111111', variantId: 'Error' } }],
	]

	it.each(changes)('a change of %s abandons the pending request and asks again for the new target', (_name, change) => {
		const h = harness()
		h.controller.retarget(target())
		const first = h.sent[0]!
		h.controller.retarget(target(change))
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]!.payload.requestId).not.toBe(first.payload.requestId)
		expect(read(h)).toEqual({ status: 'pending' })
		// The abandoned request's response is stale and changes nothing.
		h.respond(first)
		expect(read(h)).toEqual({ status: 'pending' })
		h.respond(undefined, {}, { renderContext: change.renderContext ?? RENDER })
		expect(read(h)).toEqual({ status: 'value', value: false })
	})

	it('a change of the selected Widget discards the unsent requests of the previous Widget', () => {
		const h = harness()
		h.controller.retarget(target({ keys: manyKeys(150) }))
		h.controller.retarget(target({ widgetId: 'other', keys: ['disabled'] }))
		h.respond()
		expect(h.sent.map(request => request.payload.widgetId)).toEqual(['btn', 'other'])
		expect(h.sent).toHaveLength(2)
	})

	it('forgets what an earlier target read: there is no cache', () => {
		const h = harness()
		h.controller.retarget(target())
		h.respond()
		expect(read(h).status).toBe('value')
		h.controller.retarget(target({ widgetId: 'other' }))
		expect(read(h)).toEqual({ status: 'pending' })
		h.controller.retarget(target())
		expect(read(h)).toEqual({ status: 'pending' })
		expect(h.sent).toHaveLength(3)
	})

	it('the abandoned request no longer times out into the new one', () => {
		const h = harness()
		h.controller.retarget(target())
		vi.advanceTimersByTime(4000)
		h.controller.retarget(target({ widgetId: 'other' }))
		vi.advanceTimersByTime(2000)
		expect(read(h)).toEqual({ status: 'pending' })
		vi.advanceTimersByTime(3000)
		expect(read(h)).toEqual({ status: 'unavailable' })
	})

	it('disposing abandons the pending request', () => {
		const h = harness()
		h.controller.retarget(target())
		h.controller.dispose()
		h.respond(h.sent[0])
		vi.advanceTimersByTime(BASE_STATE_RESPONSE_TIMEOUT_MS)
		expect(read(h)).toEqual({ status: 'unavailable' })
		expect(h.sent).toHaveLength(1)
	})
})

describe('a feature that is not declared', () => {
	it('reads Unavailable and sends nothing when the generation did not declare it', () => {
		const h = harness()
		h.controller.retarget(target({ supported: false }))
		expect(h.sent).toHaveLength(0)
		expect(read(h)).toEqual({ status: 'unavailable' })
	})

	it('reads Unavailable and sends nothing until the handshake opens, then asks', () => {
		const h = harness()
		h.controller.retarget(target({ supported: undefined }))
		expect(h.sent).toHaveLength(0)
		expect(read(h)).toEqual({ status: 'unavailable' })
		h.controller.retarget(target({ supported: true }))
		expect(h.sent).toHaveLength(1)
		expect(read(h)).toEqual({ status: 'pending' })
	})

	it('abandons the pending request when the generation stops being open', () => {
		const h = harness()
		h.controller.retarget(target())
		h.controller.retarget(target({ supported: undefined }))
		h.respond(h.sent[0])
		expect(read(h)).toEqual({ status: 'unavailable' })
	})

	it('reads Unavailable when the bridge does not let the request leave, and goes on to the next batch', () => {
		let refuse = true
		const h = harness({ sendStatus: () => refuse ? 'gated' : 'sent' })
		h.controller.retarget(target({ keys: manyKeys(70) }))
		// Both batches were refused in turn; nothing is left pending.
		expect(h.sent).toHaveLength(2)
		expect(read(h, 'key0')).toEqual({ status: 'unavailable' })
		expect(read(h, 'key69')).toEqual({ status: 'unavailable' })
		refuse = false
	})
})

describe('what a response may do (Clause 01a19ab9-d028)', () => {
	it('a response whose requestId is not the pending one is stale and has no effect', () => {
		const h = harness()
		h.controller.retarget(target())
		const request = h.sent[0]!
		h.respond({ ...request, payload: { ...request.payload, requestId: 'someone-else' } }, { disabled: { value: true } })
		expect(read(h)).toEqual({ status: 'pending' })
		h.respond(request, { disabled: { value: true } })
		expect(read(h)).toEqual({ status: 'value', value: true })
	})

	it('a response of another generation, View or Variant is stale', () => {
		const h = harness()
		h.controller.retarget(target())
		const request = h.sent[0]!
		h.respond(request, {}, {}, { ...request.context, runtimeGenerationId: 'gen-0' })
		h.respond(request, {}, {}, { ...request.context, variantId: 'Other' })
		h.respond(request, {}, {}, { ...request.context, viewId: '11111111-1111-4111-8111-111111111111' })
		h.respond(request, {}, {}, { ...request.context, previewSessionId: 'session-0' })
		expect(read(h)).toEqual({ status: 'pending' })
	})

	it('a pending-id response that echoes another widgetId is rejected whole: its keys read Unavailable', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['a', 'b'] }))
		h.respond(h.sent[0], { a: { value: 1 }, b: { value: 2 } }, { widgetId: 'not-btn' })
		expect(read(h, 'a')).toEqual({ status: 'unavailable' })
		expect(read(h, 'b')).toEqual({ status: 'unavailable' })
	})

	it('a pending-id response that does not answer exactly its keys is rejected whole', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['a', 'b'] }))
		const request = h.sent[0]!
		// One key missing, and another named in its place.
		h.respond({ ...request, payload: { ...request.payload, keys: ['a', 'extra'] } }, { a: { value: 1 }, extra: { value: 2 } })
		expect(read(h, 'a')).toEqual({ status: 'unavailable' })
		expect(read(h, 'b')).toEqual({ status: 'unavailable' })
	})

	it('a rejected response that names the pending request ends it with its keys Unavailable, and the next batch follows', () => {
		const h = harness()
		h.controller.retarget(target({ keys: manyKeys(70) }))
		h.controller.receive({ kind: 'rejected', requestId: h.sent[0]!.payload.requestId })
		expect(read(h, 'key0')).toEqual({ status: 'unavailable' })
		expect(h.sent).toHaveLength(2)
	})

	it('a rejected response without a requestId, or naming another request, ends nothing', () => {
		const h = harness()
		h.controller.retarget(target())
		h.controller.receive({ kind: 'rejected' })
		h.controller.receive({ kind: 'rejected', requestId: 'someone-else' })
		expect(read(h)).toEqual({ status: 'pending' })
		// The pending request still ends by its own wait.
		vi.advanceTimersByTime(BASE_STATE_RESPONSE_TIMEOUT_MS)
		expect(read(h)).toEqual({ status: 'unavailable' })
	})

	it('a response is never a protocol failure: receiving one of any shape throws nothing', () => {
		const h = harness()
		h.controller.retarget(target())
		expect(() => h.controller.receive({ kind: 'rejected', requestId: 'x' })).not.toThrow()
		expect(() => h.respond(h.sent[0], {}, { widgetId: 'other' })).not.toThrow()
	})
})

describe('a render context that differs from the Workbench\'s (Clause 01a19ab9-cc7c, d028)', () => {
	const members: ReadonlyArray<readonly [string, BaseStateRenderContext]> = [
		['viewRevision', { ...RENDER, viewRevision: 'rev-0' }],
		['locale', { ...RENDER, locale: 'zh-TW' }],
		['viewportId', { ...RENDER, viewportId: 'tablet' }],
		['viewport width', { ...RENDER, viewport: { width: 1000, height: 800 } }],
		['viewport height', { ...RENDER, viewport: { width: 1280, height: 700 } }],
		['themeId', { ...RENDER, themeId: 'dark' }],
	]

	it.each(members)('a differing %s drops the response and asks the same keys once more', (_name, renderContext) => {
		const h = harness()
		h.controller.retarget(target({ keys: ['a', 'b'] }))
		const first = h.sent[0]!
		h.respond(first, { a: { value: 'stale' }, b: { value: 'stale' } }, { renderContext })
		expect(h.sent).toHaveLength(2)
		expect(h.sent[1]!.payload.keys).toEqual(['a', 'b'])
		expect(h.sent[1]!.payload.widgetId).toBe('btn')
		expect(h.sent[1]!.payload.requestId).not.toBe(first.payload.requestId)
		expect(read(h, 'a')).toEqual({ status: 'pending' })
		h.respond(h.sent[1], { a: { value: 'fresh' }, b: { value: 'fresh' } })
		expect(read(h, 'a')).toEqual({ status: 'value', value: 'fresh' })
	})

	it('a second mismatch leaves the keys Unavailable and asks no third time', () => {
		const h = harness()
		h.controller.retarget(target({ keys: ['a'] }))
		const other = { ...RENDER, themeId: 'dark' }
		h.respond(h.sent[0], {}, { renderContext: other })
		h.respond(h.sent[1], {}, { renderContext: other })
		expect(h.sent).toHaveLength(2)
		expect(read(h, 'a')).toEqual({ status: 'unavailable' })
	})

	it('the one re-ask is per request: the next batch gets its own', () => {
		const h = harness()
		h.controller.retarget(target({ keys: manyKeys(70) }))
		const other = { ...RENDER, themeId: 'dark' }
		h.respond(h.sent[0], {}, { renderContext: other })
		h.respond(h.sent[1])
		// Batch two, then its own re-ask.
		expect(h.sent).toHaveLength(3)
		h.respond(h.sent[2], {}, { renderContext: other })
		expect(h.sent).toHaveLength(4)
		expect(h.sent[3]!.payload.keys).toEqual(manyKeys(70).slice(64))
		h.respond(h.sent[3])
		expect(read(h, 'key69')).toEqual({ status: 'value', value: false })
	})

	it('the re-ask has its own 5000 ms wait', () => {
		const h = harness()
		h.controller.retarget(target())
		vi.advanceTimersByTime(4000)
		h.respond(h.sent[0], {}, { renderContext: { ...RENDER, themeId: 'dark' } })
		vi.advanceTimersByTime(4999)
		expect(read(h)).toEqual({ status: 'pending' })
		vi.advanceTimersByTime(1)
		expect(read(h)).toEqual({ status: 'unavailable' })
	})
})
