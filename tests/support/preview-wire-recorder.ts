/**
 * Test-only instrumentation injected with `addInitScript`. It produces no geometry: the real
 * runtime producer in the Preview document answers every request. It records the Preview wire
 * traffic each document receives (the Preview: geometry requests and releases; the Workbench:
 * geometry reports and `targeting.*` messages, which travel in the protocol envelope) and counts animation-frame callbacks in every
 * document, so tests can assert idle behaviour.
 */
export type WireRecord = Readonly<{ type: string; context: Record<string, unknown>; payload: Record<string, unknown> }>

export type WireRecorderWindow = Window & {
	/** Wire messages received by this document (capability, geometry and targeting), and the targeting subset. */
	__wire: { messages: WireRecord[]; targeting: WireRecord[] }
	__rafCallbacks: number
}

export const PREVIEW_WIRE_RECORDER = `(() => {
	const raf = window.requestAnimationFrame.bind(window)
	window.__rafCallbacks = 0
	window.requestAnimationFrame = (callback) => raf((time) => { window.__rafCallbacks++; callback(time) })
	window.__wire = { messages: [], targeting: [] }
	window.addEventListener('message', (event) => {
		const data = event.data
		if (!data || typeof data !== 'object') return
		if (data.channel !== 'uiux:preview:wire' || !data.message || typeof data.message.type !== 'string') return
		window.__wire.messages.push(data.message)
		if (data.message.type.startsWith('targeting.')) window.__wire.targeting.push(data.message)
	}, true)
})()`
