import type { PreviewWireMessage, PreviewProtocolTransport } from './bridge'

export const PREVIEW_WIRE_CHANNEL = 'uiux:preview:wire' as const
export const PREVIEW_CONTEXT_CHANNEL = 'uiux:preview:context' as const
export const PREVIEW_TARGETING_CHANNEL = 'uiux:preview:targeting' as const

export type PreviewContextPayload = Readonly<{
	viewId: string
	variantName?: string
	locale: string
	viewportId: string
	viewport: Readonly<{ width: number; height: number }>
	themeId: string
}>

export type PreviewTargetingPurpose = 'comment-range' | 'inspection'

/**
 * Targeting traffic on the Preview's targeting channel (Part 3). Workbench sends `enter` (with a
 * fresh `targetingInteractionId` and its purpose) and `exit`. The runtime hit-tests and sends
 * `hover` (the current candidate; no `widgetId` clears it), `select` and `escape`, echoing the
 * active `targetingInteractionId` and its `runtimeGenerationId` so Workbench can reject traffic
 * from a replaced interaction or a retired generation. Hover candidate geometry is never carried
 * here: Workbench tracks the candidate Widget with an accepted `geometry.acquire.*` stream.
 */
export type PreviewTargetingPayload = Readonly<{
	type: 'enter' | 'exit' | 'hover' | 'select' | 'escape'
	purpose?: PreviewTargetingPurpose
	targetingInteractionId?: string
	runtimeGenerationId?: string
	pointerType?: 'mouse' | 'pen'
	widgetId?: string
	viewId?: string
}>

export type PreviewWireEnvelope = Readonly<{
	channel: typeof PREVIEW_WIRE_CHANNEL
	message: PreviewWireMessage
}>

export type PreviewContextEnvelope = Readonly<{
	channel: typeof PREVIEW_CONTEXT_CHANNEL
	payload: PreviewContextPayload
}>

export type PreviewTargetingEnvelope = Readonly<{
	channel: typeof PREVIEW_TARGETING_CHANNEL
	payload: PreviewTargetingPayload
}>

export type PreviewTransportEnvelope =
	| PreviewWireEnvelope
	| PreviewContextEnvelope
	| PreviewTargetingEnvelope

export function isPreviewTransportEnvelope(value: unknown): value is PreviewTransportEnvelope {
	if (!isRecord(value)) return false
	const channel = value.channel
	if (channel === PREVIEW_WIRE_CHANNEL)
		return isRecord(value.message) && typeof value.message.type === 'string'
	if (channel === PREVIEW_CONTEXT_CHANNEL)
		return isRecord(value.payload) && typeof (value.payload as Record<string, unknown>).viewId === 'string'
	if (channel === PREVIEW_TARGETING_CHANNEL)
		return isRecord(value.payload) && typeof (value.payload as Record<string, unknown>).type === 'string'
	return false
}

export function createPostMessageTransport(
	getTargetWindow: () => Window | null | undefined,
	targetOrigin = '*',
): PreviewProtocolTransport {
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
