/**
 * Test-only instrumentation injected with `addInitScript`. It produces no geometry: the real
 * runtime producer in the Preview document answers every request. It records the Preview wire
 * traffic each document receives (the Preview: geometry requests and releases; the Workbench:
 * geometry reports and targeting messages) and counts animation-frame callbacks in every
 * document, so tests can assert idle behaviour.
 */
export type WireRecord = Readonly<{ type: string; context: Record<string, unknown>; payload: Record<string, unknown> }>

export type WireRecorderWindow = Window & {
	/** Wire messages received by this document (geometry and capability), and targeting payloads. */
	__wire: { messages: WireRecord[]; targeting: Record<string, unknown>[] }
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
		if (data.channel === 'uiux:preview:wire' && data.message && typeof data.message.type === 'string')
			window.__wire.messages.push(data.message)
		else if (data.channel === 'uiux:preview:targeting' && data.payload)
			window.__wire.targeting.push(data.payload)
	}, true)
})()`
