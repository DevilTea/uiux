import type { PreviewWireMessage, PreviewProtocolTransport } from './bridge'

export const PREVIEW_WIRE_CHANNEL = 'uiux:preview:wire' as const
export const PREVIEW_CONTEXT_CHANNEL = 'uiux:preview:context' as const

export type PreviewContextPayload = Readonly<{
	viewId: string
	variantName?: string
	locale: string
	viewportId: string
	viewport: Readonly<{ width: number; height: number }>
	themeId: string
}>

/**
 * Targeting runs in the protocol envelope on the wire channel (`targeting.*`, see ./targeting);
 * the former ad hoc `uiux:preview:targeting` channel is retired.
 */
export type PreviewTargetingPurpose = 'comment-range' | 'inspection'

/** One protocol envelope in one `postMessage`. */
export type PreviewWireEnvelope = Readonly<{
	channel: typeof PREVIEW_WIRE_CHANNEL
	message: PreviewWireMessage
}>

/**
 * Transport-level batching (multi-target decision group, alternative 2): the envelopes one side
 * sends during one task leave in one `postMessage`, in send order.
 *
 * The batch is a container only. It adds no fields of its own (no id, sequence, count or context):
 * its keys are exactly `channel` and `messages`, and every inner item is a complete protocol
 * envelope, the same object that would otherwise travel as `message`. The receiver unpacks it and
 * gives each inner envelope, in order and independently, to the same bridge gates a single post
 * goes through, so one invalid inner envelope is rejected on its own and its siblings still apply.
 * Receiving a batch is therefore equivalent to receiving its envelopes as consecutive single posts.
 * The single-envelope post stays valid, and a sender posts one envelope in that form.
 */
export type PreviewWireBatchEnvelope = Readonly<{
	channel: typeof PREVIEW_WIRE_CHANNEL
	messages: readonly PreviewWireMessage[]
}>

/** What may cross the wire channel in one `postMessage`. */
export type PreviewWirePost = PreviewWireEnvelope | PreviewWireBatchEnvelope

/**
 * The most envelopes one batch may carry. A Workbench tracks at most 64 geometry streams, so one
 * runtime task stays far below this; a sender splits a larger outbox into several posts and a
 * receiver drops a larger batch whole.
 */
export const PREVIEW_WIRE_BATCH_MAX_MESSAGES = 256

/**
 * Builds the post for envelopes sent in one task: one envelope travels as `{ channel, message }`,
 * several as `{ channel, messages }`. At most `PREVIEW_WIRE_BATCH_MAX_MESSAGES`, at least one.
 */
export function createPreviewWirePost(messages: readonly PreviewWireMessage[]): PreviewWirePost {
	if (messages.length === 0) throw new RangeError('A wire post carries at least one envelope.')
	if (messages.length > PREVIEW_WIRE_BATCH_MAX_MESSAGES) throw new RangeError(`A wire batch carries at most ${PREVIEW_WIRE_BATCH_MAX_MESSAGES} envelopes.`)
	if (messages.length === 1) return { channel: PREVIEW_WIRE_CHANNEL, message: messages[0]! }
	return { channel: PREVIEW_WIRE_CHANNEL, messages: [...messages] }
}

/**
 * Validates the container of a wire-channel post and returns the inner envelopes, still
 * unvalidated, in order; `undefined` when the post is not a well-formed wire post (wrong channel,
 * both or neither of `message` and `messages`, an empty `message`, extra keys on a batch, a
 * `messages` that is not an array, an empty or oversized batch).
 * The caller passes every returned item to the bridge's `receive`, one by one: inner envelopes are
 * validated only there, by the existing gates, never here.
 */
export function readPreviewWirePost(data: unknown): readonly unknown[] | undefined {
	if (!isRecord(data) || data.channel !== PREVIEW_WIRE_CHANNEL) return undefined
	const hasMessage = Object.hasOwn(data, 'message')
	const hasMessages = Object.hasOwn(data, 'messages')
	if (hasMessage === hasMessages) return undefined
	if (hasMessage) return data.message ? [data.message] : undefined
	const messages = data.messages
	if (!Array.isArray(messages) || messages.length === 0 || messages.length > PREVIEW_WIRE_BATCH_MAX_MESSAGES) return undefined
	if (Object.keys(data).some(key => key !== 'channel' && key !== 'messages')) return undefined
	return Array.from(messages)
}

/**
 * A sender that batches the envelopes of one task: the first `send` of a task schedules a flush at
 * its end (a microtask), and the flush posts the outbox in order, split into posts of at most
 * `PREVIEW_WIRE_BATCH_MAX_MESSAGES`.
 */
export function createBatchingWireSender(
	post: (wirePost: PreviewWirePost) => void,
	schedule: (flush: () => void) => void = queueMicrotask,
): PreviewProtocolTransport & { flush: () => void } {
	let outbox: PreviewWireMessage[] = []
	function flush(): void {
		const pending = outbox
		outbox = []
		for (let start = 0; start < pending.length; start += PREVIEW_WIRE_BATCH_MAX_MESSAGES)
			post(createPreviewWirePost(pending.slice(start, start + PREVIEW_WIRE_BATCH_MAX_MESSAGES)))
	}
	return {
		send(message: PreviewWireMessage) {
			if (!outbox.length) schedule(flush)
			outbox.push(message)
		},
		flush,
	}
}

export type PreviewContextEnvelope = Readonly<{
	channel: typeof PREVIEW_CONTEXT_CHANNEL
	payload: PreviewContextPayload
}>

export type PreviewTransportEnvelope =
	| PreviewWirePost
	| PreviewContextEnvelope

/**
 * A shallow shape check of one transport post. For a batch, each inner item needs only to look
 * like an envelope here; the bridge validates it fully.
 */
export function isPreviewTransportEnvelope(value: unknown): value is PreviewTransportEnvelope {
	if (!isRecord(value)) return false
	const channel = value.channel
	if (channel === PREVIEW_WIRE_CHANNEL) {
		const messages = readPreviewWirePost(value)
		return !!messages && messages.every(message => isRecord(message) && typeof message.type === 'string')
	}
	if (channel === PREVIEW_CONTEXT_CHANNEL)
		return isRecord(value.payload) && typeof (value.payload as Record<string, unknown>).viewId === 'string'
	return false
}

/**
 * A `postMessage` transport. Both sides post with their own origin as `targetOrigin`, never `'*'`
 * (Widget Event reporting decision 9, R15), so the caller names it explicitly.
 */
export function createPostMessageTransport(
	getTargetWindow: () => Window | null | undefined,
	targetOrigin: string,
): PreviewProtocolTransport {
	if (!targetOrigin || targetOrigin === '*') throw new TypeError('The protocol channel posts to an explicit same origin, never \'*\'.')
	return {
		send(message: PreviewWireMessage) {
			const target = getTargetWindow()
			if (!target) return
			target.postMessage(createPreviewWirePost([message]), targetOrigin)
		},
	}
}

/**
 * Deterministic in-memory bidirectional transport pair for headless unit testing.
 */
export function createInMemoryTransportPair(): Readonly<{
	workbenchTransport: PreviewProtocolTransport
	runtimeTransport: PreviewProtocolTransport
	onWorkbenchReceive: (listener: (msg: PreviewWireMessage) => void) => void
	onRuntimeReceive: (listener: (msg: PreviewWireMessage) => void) => void
}> {
	const workbenchListeners = new Set<(msg: PreviewWireMessage) => void>()
	const runtimeListeners = new Set<(msg: PreviewWireMessage) => void>()

	const workbenchTransport: PreviewProtocolTransport = {
		send(message) {
			// Workbench sends to Runtime
			for (const listener of runtimeListeners)
				listener(message)
		},
	}

	const runtimeTransport: PreviewProtocolTransport = {
		send(message) {
			// Runtime sends to Workbench
			for (const listener of workbenchListeners)
				listener(message)
		},
	}

	return Object.freeze({
		workbenchTransport,
		runtimeTransport,
		onWorkbenchReceive(listener) { workbenchListeners.add(listener) },
		onRuntimeReceive(listener) { runtimeListeners.add(listener) },
	})
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}
