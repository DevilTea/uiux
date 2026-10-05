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

export type PreviewWireEnvelope = Readonly<{
	channel: typeof PREVIEW_WIRE_CHANNEL
	message: PreviewWireMessage
}>

export type PreviewContextEnvelope = Readonly<{
	channel: typeof PREVIEW_CONTEXT_CHANNEL
	payload: PreviewContextPayload
}>

export type PreviewTransportEnvelope =
	| PreviewWireEnvelope
	| PreviewContextEnvelope

export function isPreviewTransportEnvelope(value: unknown): value is PreviewTransportEnvelope {
	if (!isRecord(value)) return false
	const channel = value.channel
	if (channel === PREVIEW_WIRE_CHANNEL)
		return isRecord(value.message) && typeof value.message.type === 'string'
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
			const envelope: PreviewWireEnvelope = {
				channel: PREVIEW_WIRE_CHANNEL,
				message,
			}
			target.postMessage(envelope, targetOrigin)
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
