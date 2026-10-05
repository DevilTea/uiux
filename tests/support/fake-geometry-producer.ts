/**
 * A test-only stand-in for the runtime geometry producer, injected into the Preview iframe with
 * `addInitScript`. The real producer is separate roadmap work; this stub answers the accepted wire
 * (Discussion #2: `geometry.acquire.request` → `geometry.acquire.response` with `{ rect, regions }`
 * and a monotonically increasing `geometryRevision`) so the Workbench consumer, overlay and
 * mapping can be exercised end to end. It reports a Widget's border box as one rectangular
 * visible region, and re-reports on scroll and resize.
 */
export const FAKE_GEOMETRY_PRODUCER = `(() => {
	if (window === window.parent || !location.pathname.endsWith('/preview')) return
	let revision = 0
	let active
	const report = () => {
		if (!active) return
		const element = document.querySelector('[data-widget-id="' + CSS.escape(active.context.widgetId) + '"]')
		const r = element ? element.getBoundingClientRect() : { x: 0, y: 0, width: 0, height: 0 }
		const regions = r.width && r.height
			? [{ regionId: 'region-1', maxError: 0, contour: { commands: [
				{ op: 'moveTo', x: r.x, y: r.y },
				{ op: 'lineTo', x: r.x + r.width, y: r.y },
				{ op: 'lineTo', x: r.x + r.width, y: r.y + r.height },
				{ op: 'lineTo', x: r.x, y: r.y + r.height },
				{ op: 'close' },
			] } }]
			: []
		window.parent.postMessage({
			channel: 'uiux:preview:wire',
			message: {
				type: 'geometry.acquire.response',
				context: { ...active.context, geometryRevision: ++revision },
				payload: { rect: { x: r.x, y: r.y, width: r.width, height: r.height }, regions },
			},
		}, location.origin)
	}
	window.__fakeGeometryRequests = []
	window.addEventListener('message', (event) => {
		const message = event.data && event.data.message
		if (!event.data || event.data.channel !== 'uiux:preview:wire' || !message || message.type !== 'geometry.acquire.request') return
		window.__fakeGeometryRequests.push(message)
		active = message
		requestAnimationFrame(() => requestAnimationFrame(report))
	})
	let queued = false
	const queue = () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; report() }) }
	new MutationObserver(queue).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
	document.addEventListener('scroll', () => requestAnimationFrame(report), true)
	window.addEventListener('resize', () => requestAnimationFrame(report))
})()`
