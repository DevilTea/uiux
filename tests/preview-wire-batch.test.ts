import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type BridgeReceiveResult,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import {
	PREVIEW_WIRE_BATCH_MAX_MESSAGES,
	PREVIEW_WIRE_CHANNEL,
	createBatchingWireSender,
	createPostMessageTransport,
	createPreviewWirePost,
	isPreviewTransportEnvelope,
	readPreviewWirePost,
	type PreviewWirePost,
} from '../src/preview/protocol/transport'
import { WIDGET_EVENTS_FEATURE, type WidgetEventOccurrenceMessage } from '../src/preview/protocol/widget-events'

/**
 * Transport-level batching on the wire channel: `{ channel, messages: [...] }` is a container of
 * complete envelopes that adds no fields, each inner envelope passes the bridge's gates on its own,
 * and the single-envelope post `{ channel, message }` stays valid.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID } as const

function occurrence(armId: string, widgetId = 'retry'): WidgetEventOccurrenceMessage {
	return { type: 'widget.event.occurrence', context: { ...context, widgetId }, payload: { armId, event: 'click' } }
}

describe('wire post container', () => {
	it('builds a single post for one envelope and a batch for several, with no extra fields', () => {
		const one = createPreviewWirePost([occurrence('a')])
		expect(one).toEqual({ channel: PREVIEW_WIRE_CHANNEL, message: occurrence('a') })
		const many = createPreviewWirePost([occurrence('a'), occurrence('b')])
		expect(Object.keys(many).sort()).toEqual(['channel', 'messages'])
		expect(many).toEqual({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a'), occurrence('b')] })
		// The inner envelopes are the same objects a single post would carry.
		const inner = occurrence('c')
		expect((createPreviewWirePost([inner, inner]) as { messages: readonly unknown[] }).messages[0]).toBe(inner)
	})

	it('refuses an empty or oversized post', () => {
		expect(() => createPreviewWirePost([])).toThrow(RangeError)
		const tooMany = Array.from({ length: PREVIEW_WIRE_BATCH_MAX_MESSAGES + 1 }, (_, index) => occurrence(`a-${index}`))
		expect(() => createPreviewWirePost(tooMany)).toThrow(RangeError)
		expect(() => createPreviewWirePost(tooMany.slice(1))).not.toThrow()
	})

	it('reads a single post and a batch into the inner envelopes, in order', () => {
		const single = { channel: PREVIEW_WIRE_CHANNEL, message: occurrence('a') }
		expect(readPreviewWirePost(single)).toEqual([occurrence('a')])
		const batch = { channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a'), occurrence('b'), occurrence('c')] }
		expect(readPreviewWirePost(batch)).toEqual([occurrence('a'), occurrence('b'), occurrence('c')])
		// A one-element batch is valid too, though senders post one envelope in the single form.
		expect(readPreviewWirePost({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a')] })).toEqual([occurrence('a')])
	})

	it('does not validate inner envelopes: they are left for the bridge gates', () => {
		const items = [occurrence('a'), { type: 'nonsense' }, 42, null]
		expect(readPreviewWirePost({ channel: PREVIEW_WIRE_CHANNEL, messages: items })).toEqual(items)
	})

	it('rejects malformed containers whole', () => {
		const message = occurrence('a')
		for (const post of [
			null,
			'text',
			[message],
			{ channel: 'uiux:preview:context', message },
			{ channel: PREVIEW_WIRE_CHANNEL },
			{ channel: PREVIEW_WIRE_CHANNEL, message: undefined },
			{ channel: PREVIEW_WIRE_CHANNEL, message: null },
			{ channel: PREVIEW_WIRE_CHANNEL, message, messages: [message] },
			{ channel: PREVIEW_WIRE_CHANNEL, messages: [] },
			{ channel: PREVIEW_WIRE_CHANNEL, messages: message },
			{ channel: PREVIEW_WIRE_CHANNEL, messages: { 0: message, length: 1 } },
			// The batch adds no fields of its own.
			{ channel: PREVIEW_WIRE_CHANNEL, messages: [message], batchId: 'b-1' },
			{ channel: PREVIEW_WIRE_CHANNEL, messages: [message], context },
			{ channel: PREVIEW_WIRE_CHANNEL, messages: Array.from({ length: PREVIEW_WIRE_BATCH_MAX_MESSAGES + 1 }, () => message) },
		])
			expect(readPreviewWirePost(post), JSON.stringify(post)?.slice(0, 120)).toBeUndefined()
	})

	it('recognizes a batch as a transport envelope when every item looks like an envelope', () => {
		expect(isPreviewTransportEnvelope({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a'), occurrence('b')] })).toBe(true)
		expect(isPreviewTransportEnvelope({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a'), { context }] })).toBe(false)
		expect(isPreviewTransportEnvelope({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a')], extra: 1 })).toBe(false)
	})

	it('keeps the postMessage transport on the single-envelope form', () => {
		const posted: unknown[] = []
		const target = { postMessage: (data: unknown, origin: string) => posted.push({ data, origin }) } as unknown as Window
		createPostMessageTransport(() => target, 'http://127.0.0.1:3950').send(occurrence('a'))
		expect(posted).toEqual([{ data: { channel: PREVIEW_WIRE_CHANNEL, message: occurrence('a') }, origin: 'http://127.0.0.1:3950' }])
	})
})

describe('batching sender', () => {
	function manual() {
		const posts: PreviewWirePost[] = []
		const tasks: (() => void)[] = []
		const sender = createBatchingWireSender(post => posts.push(post), flush => tasks.push(flush))
		const endTask = () => { for (const task of tasks.splice(0)) task() }
		return { posts, sender, endTask }
	}

	it('posts every envelope of one task in one post, in send order, and schedules once', () => {
		const { posts, sender, endTask } = manual()
		sender.send(occurrence('a'))
		sender.send(occurrence('b'))
		sender.send(occurrence('c'))
		expect(posts).toEqual([])
		endTask()
		expect(posts).toEqual([{ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('a'), occurrence('b'), occurrence('c')] }])
		endTask()
		expect(posts).toHaveLength(1)
	})

	it('posts a lone envelope in the single form', () => {
		const { posts, sender, endTask } = manual()
		sender.send(occurrence('a'))
		endTask()
		expect(posts).toEqual([{ channel: PREVIEW_WIRE_CHANNEL, message: occurrence('a') }])
	})

	it('splits a larger outbox into posts of at most the cap, keeping order', () => {
		const { posts, sender, endTask } = manual()
		const count = PREVIEW_WIRE_BATCH_MAX_MESSAGES * 2 + 1
		for (let index = 0; index < count; index++) sender.send(occurrence(`a-${index}`))
		endTask()
		expect(posts.map(post => readPreviewWirePost(post)!.length)).toEqual([PREVIEW_WIRE_BATCH_MAX_MESSAGES, PREVIEW_WIRE_BATCH_MAX_MESSAGES, 1])
		expect(posts.flatMap(post => readPreviewWirePost(post)!.map(item => (item as WidgetEventOccurrenceMessage).payload.armId)))
			.toEqual(Array.from({ length: count }, (_, index) => `a-${index}`))
	})

	it('flushes at the end of the task with the default microtask schedule', async () => {
		const posts: PreviewWirePost[] = []
		const sender = createBatchingWireSender(post => posts.push(post))
		sender.send(occurrence('a'))
		sender.send(occurrence('b'))
		expect(posts).toEqual([])
		await Promise.resolve()
		expect(posts).toHaveLength(1)
	})
})

describe('batches through the protocol bridges', () => {
	function connected() {
		const workbenchOut: PreviewWireMessage[] = []
		const posts: PreviewWirePost[] = []
		const tasks: (() => void)[] = []
		const runtimeTransport: PreviewProtocolTransport = createBatchingWireSender(post => posts.push(post), flush => tasks.push(flush))
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', { send: message => workbenchOut.push(message) }, () => ({ ok: true }))
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features: ['geometry', WIDGET_EVENTS_FEATURE] }, runtimeTransport)
		workbench.admitGeneration('generation-a', 'initial')
		const endTask = () => { for (const task of tasks.splice(0)) task() }
		/** What the Workbench's window listener does with one post. */
		const deliver = (post: unknown): BridgeReceiveResult[] => (readPreviewWirePost(post) ?? []).map(input => workbench.receive(input))
		return { workbench, runtime, workbenchOut, posts, endTask, deliver }
	}

	function open(parts: ReturnType<typeof connected>) {
		parts.runtime.declareCapabilities()
		parts.endTask()
		expect(parts.deliver(parts.posts.shift()).map(result => result.status)).toEqual(['ack-dispatched'])
		expect(parts.runtime.receive(parts.workbenchOut.at(-1)).status).toBe('accepted')
	}

	it('carries occurrences sent in one task in one batch and routes each one', () => {
		const parts = connected()
		open(parts)
		expect(parts.runtime.sendWidgetEventOccurrence(occurrence('arm-1', 'retry')).status).toBe('sent')
		expect(parts.runtime.sendWidgetEventOccurrence(occurrence('arm-1', 'done')).status).toBe('sent')
		parts.endTask()
		expect(parts.posts).toHaveLength(1)
		expect(parts.deliver(parts.posts[0])).toEqual([
			{ status: 'accepted', message: occurrence('arm-1', 'retry') },
			{ status: 'accepted', message: occurrence('arm-1', 'done') },
		])
	})

	it('gates each inner envelope independently, as separate posts would', () => {
		const parts = connected()
		open(parts)
		const items: unknown[] = [
			occurrence('arm-1'),
			{ ...occurrence('arm-1'), payload: {} },
			{ ...occurrence('arm-1'), context: { ...occurrence('arm-1').context, runtimeGenerationId: 'generation-old' } },
			{ ...occurrence('arm-1'), context: { ...occurrence('arm-1').context, previewSessionId: 'session-old' } },
			{ type: 'widget.event.arm', context, payload: { armId: 'arm-2', triggers: [] } },
			occurrence('arm-2'),
		]
		const batched = parts.deliver({ channel: PREVIEW_WIRE_CHANNEL, messages: items }).map(result => result.status)
		const separate = items.flatMap(item => parts.deliver({ channel: PREVIEW_WIRE_CHANNEL, message: item })).map(result => result.status)
		expect(batched).toEqual(['accepted', 'invalid', 'stale-generation', 'stale-session', 'wrong-direction', 'accepted'])
		expect(batched).toEqual(separate)
	})

	it('drops a malformed container without reaching the bridge', () => {
		const parts = connected()
		open(parts)
		expect(parts.deliver({ channel: PREVIEW_WIRE_CHANNEL, messages: [occurrence('arm-1')], sequence: 1 })).toEqual([])
		expect(parts.deliver({ channel: PREVIEW_WIRE_CHANNEL, messages: [] })).toEqual([])
	})
})
