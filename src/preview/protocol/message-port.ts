import type { PreviewProtocolTransport, PreviewWireMessage } from './bridge'

export type PreviewProtocolMessageEvent = Readonly<{ data: unknown }>

export type PreviewProtocolMessagePort = Readonly<{
	postMessage(message: PreviewWireMessage): void
	addEventListener(type: 'message', listener: (event: PreviewProtocolMessageEvent) => void): void
	removeEventListener(type: 'message', listener: (event: PreviewProtocolMessageEvent) => void): void
	start?(): void
}>

export type PreviewProtocolPortSubscription = Readonly<{
	dispose(): void
}>

/**
 * Adapts a browser MessagePort-like channel to the Preview protocol transport boundary.
 *
 * The transport deliberately performs no direct bridge invocation: even same-origin Preview
 * runtimes cross the structured-clone/message boundary before either side validates the wire
 * message with its protocol bridge.
 */
export function createPreviewProtocolMessagePortTransport(
	port: Pick<PreviewProtocolMessagePort, 'postMessage'>,
): PreviewProtocolTransport {
	return Object.freeze({
		send(message) {
			port.postMessage(message)
		},
	})
}

/**
 * Subscribes one protocol receiver to a MessagePort-like channel.
 *
 * Port ownership stays with the caller: disposing removes this listener but does not close the
 * port, allowing lifecycle/channel replacement to be coordinated by the surrounding Preview
 * session controller.
 */
export function subscribePreviewProtocolMessagePort(
	port: Pick<PreviewProtocolMessagePort, 'addEventListener' | 'removeEventListener' | 'start'>,
	receive: (input: unknown) => void,
): PreviewProtocolPortSubscription {
	let active = true
	const listener = (event: PreviewProtocolMessageEvent) => {
		if (!active) return
		receive(event.data)
	}
	port.addEventListener('message', listener)
	port.start?.()

	return Object.freeze({
		dispose() {
			if (!active) return
			active = false
			port.removeEventListener('message', listener)
		},
	})
}
