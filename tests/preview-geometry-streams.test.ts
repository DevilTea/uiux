import { describe, expect, it } from 'vitest'

import { GeometryStreamCoordinator, type GeometryDemand, type GeometryStreamContext } from '../src/preview/geometry-streams'
import { OuterMappingObserverController } from '../src/preview/outer-observer'
import { RuntimeGeometryProducer } from '../src/preview/geometry-producer'
import type { GeometryAcquireRequest, GeometryAcquireResponse, GeometryReleaseRequest } from '../src/preview/protocol/schema'

const viewId = '11111111-1111-4111-8111-111111111111'
const base: GeometryStreamContext = { previewSessionId: 's', runtimeGenerationId: 'g1', viewId }

type Sent = GeometryAcquireRequest | GeometryReleaseRequest

function coordinator(options: { multiTarget?: boolean; frames?: Array<() => void> } = {}) {
	const sent: Sent[] = []
	let next = 0
	const frames = options.frames
	const streams = new GeometryStreamCoordinator({
		send: message => sent.push(message),
		mintId: () => `id-${++next}`,
		...(frames ? { requestFrame: (callback: () => void) => frames.push(callback), cancelFrame: () => {} } : {}),
	})
	streams.setContext(base)
	streams.setMultiTarget(options.multiTarget ?? true)
	streams.setReady(true)
	return { streams, sent }
}

function report(widgetId: string, navigationRequestId: string, geometryRevision: number, extra: Partial<GeometryAcquireResponse['context']> = {}, y = 0): GeometryAcquireResponse {
	return {
		type: 'geometry.acquire.response',
		context: { ...base, navigationRequestId, widgetId, geometryRevision, ...extra },
		payload: { rect: { x: 0, y, width: 10, height: 10 }, regions: [] },
	}
}

const pin = (widgetId: string, status: GeometryDemand['status'], latestActivity?: number, threadId = widgetId): GeometryDemand => ({
	consumerId: `pin:${threadId}`, widgetId, tier: 'pin', ...(status ? { status } : {}), ...(latestActivity !== undefined ? { latestActivity } : {}),
})

describe('Workbench geometry stream coordinator', () => {
	it('opens one stream per Widget with fresh identities and shares it between consumers', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([pin('a', 'open', 1, 't1'), pin('a', 'open', 2, 't2'), pin('b', 'open')])
		expect(sent.map(message => [message.type, message.context.widgetId, message.context.navigationRequestId])).toEqual([
			['geometry.acquire.request', 'a', 'id-1'],
			['geometry.acquire.request', 'b', 'id-2'],
		])
		expect(sent[0]!.payload).toEqual({})
		expect(sent[0]!.context).not.toHaveProperty('geometryRevision')
		// Re-declaring the same demand sends nothing.
		streams.setDemand([pin('a', 'open', 1, 't1'), pin('b', 'open')])
		expect(sent).toHaveLength(2)
	})

	it('applies the gates in order: context, open stream, per-Widget revision', () => {
		const { streams } = coordinator()
		streams.setDemand([pin('a', 'open')])
		expect(streams.accept(report('a', 'id-1', 1, { variantId: 'compact' }))).toBe('stale-context')
		expect(streams.accept(report('a', 'other', 1))).toBe('stale-stream')
		expect(streams.accept(report('b', 'id-1', 1))).toBe('stale-stream')
		expect(streams.accept(report('a', 'id-1', 2))).toBe('accepted')
		expect(streams.accept(report('a', 'id-1', 2))).toBe('stale-revision')
		expect(streams.accept(report('a', 'id-1', 1))).toBe('stale-revision')
		expect(streams.accept(report('a', 'id-1', 3, {}, 40))).toBe('accepted')
		expect(streams.report('a')).toMatchObject({ geometryRevision: 3, rect: { y: 40 } })
	})

	it('releases streams that leave the demand, and later reports of a released stream are stale', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([pin('a', 'open'), pin('b', 'open')])
		streams.accept(report('a', 'id-1', 1))
		streams.setDemand([pin('b', 'open')])
		expect(sent.at(-1)).toMatchObject({ type: 'geometry.release', context: { widgetId: 'a', navigationRequestId: 'id-1' }, payload: {} })
		expect(sent.at(-1)!.context).not.toHaveProperty('geometryRevision')
		expect(streams.report('a')).toBeUndefined()
		expect(streams.accept(report('a', 'id-1', 2))).toBe('stale-stream')
		// Reopening uses a fresh identity, never the released one.
		streams.setDemand([pin('a', 'open'), pin('b', 'open')])
		expect(sent.at(-1)).toMatchObject({ type: 'geometry.acquire.request', context: { widgetId: 'a', navigationRequestId: 'id-3' } })
		// The first report of the reopened stream must still be newer than the last accepted for the Widget.
		expect(streams.accept(report('a', 'id-3', 1))).toBe('stale-revision')
		expect(streams.accept(report('a', 'id-3', 2))).toBe('accepted')
	})

	it('caps open streams at 64 and assigns them by tier, status, latest activity and widgetId', () => {
		const { streams, sent } = coordinator()
		const demands: GeometryDemand[] = []
		for (let index = 0; index < 80; index++) {
			const status = index % 3 === 0 ? 'resolved' : index % 3 === 1 ? 'open' : 'ready-for-review'
			demands.push(pin(`w${String(index).padStart(2, '0')}`, status, index))
		}
		demands.push({ consumerId: 'selection', widgetId: 'w00', tier: 'highlight' })
		demands.push({ consumerId: 'hover', widgetId: 'w03', tier: 'targeting' })
		streams.setDemand(demands)
		const opened = sent.filter(message => message.type === 'geometry.acquire.request').map(message => message.context.widgetId)
		expect(opened).toHaveLength(64)
		expect(opened.slice(0, 2)).toEqual(['w03', 'w00'])
		// Then every ready-for-review (newest first), then open, and the oldest resolved ones lose.
		const ready = demands.filter(d => d.status === 'ready-for-review' && d.tier === 'pin').map(d => d.widgetId).reverse()
		expect(opened.slice(2, 2 + ready.length)).toEqual(ready.filter(id => id !== 'w03' && id !== 'w00'))
		expect(streams.overCapWidgets()).toHaveLength(80 - 64)
		expect(streams.overCapWidgets().every(id => demands.find(d => d.widgetId === id)!.status === 'resolved')).toBe(true)
		// A status change re-runs the assignment: a released slot is reused at once.
		const promoted = streams.overCapWidgets()[0]!
		streams.setDemand(demands.map(d => d.widgetId === promoted && d.tier === 'pin' ? { ...d, status: 'ready-for-review' } : d))
		expect(streams.isTracked(promoted)).toBe(true)
		expect(sent.filter(message => message.type === 'geometry.release')).toHaveLength(1)
		expect(streams.snapshot().streams).toHaveLength(64)
	})

	it('lets a Checks navigation bring its own identity and supersede the Widget stream; pins move to it', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([pin('a', 'open')])
		streams.accept(report('a', 'id-1', 1))
		streams.setDemand([pin('a', 'open'), { consumerId: 'selection', widgetId: 'a', tier: 'highlight', navigationRequestId: 'nav-7' }])
		expect(sent.at(-1)).toMatchObject({ type: 'geometry.acquire.request', context: { widgetId: 'a', navigationRequestId: 'nav-7' } })
		expect(sent.filter(message => message.type === 'geometry.release')).toHaveLength(0)
		expect(streams.streamId('a')).toBe('nav-7')
		expect(streams.report('a')).toBeUndefined()
		expect(streams.accept(report('a', 'id-1', 2))).toBe('stale-stream')
		expect(streams.accept(report('a', 'nav-7', 2))).toBe('accepted')
		// The selection leaves: the pin keeps the stream, nothing is reopened.
		streams.setDemand([pin('a', 'open')])
		expect(sent).toHaveLength(2)
		expect(streams.streamId('a')).toBe('nav-7')
	})

	it('falls back to one stream and never releases without geometry.multi-target', () => {
		const { streams, sent } = coordinator({ multiTarget: false })
		streams.setDemand([pin('a', 'ready-for-review'), pin('b', 'open'), { consumerId: 'selection', widgetId: 'c', tier: 'highlight' }])
		expect(sent.map(message => message.context.widgetId)).toEqual(['c'])
		expect(streams.overCapWidgets()).toEqual(['a', 'b'])
		streams.setDemand([pin('a', 'ready-for-review'), pin('b', 'open')])
		expect(sent.map(message => [message.type, message.context.widgetId])).toEqual([['geometry.acquire.request', 'c'], ['geometry.acquire.request', 'a']])
		expect(sent.some(message => message.type === 'geometry.release')).toBe(false)
	})

	it('ends every stream without a release on a Variant change and reopens under the new context', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([pin('a', 'open'), pin('b', 'open')])
		streams.accept(report('a', 'id-1', 4))
		streams.setContext({ ...base, variantId: 'compact' })
		expect(sent.filter(message => message.type === 'geometry.release')).toHaveLength(0)
		expect(sent.slice(2).map(message => [message.context.widgetId, message.context.navigationRequestId, message.context.variantId])).toEqual([
			['a', 'id-3', 'compact'], ['b', 'id-4', 'compact'],
		])
		expect(streams.report('a')).toBeUndefined()
		expect(streams.accept(report('a', 'id-1', 5))).toBe('stale-context')
		// Same generation: the Widget revision domain continues.
		expect(streams.accept(report('a', 'id-3', 4, { variantId: 'compact' }))).toBe('stale-revision')
		expect(streams.accept(report('a', 'id-3', 5, { variantId: 'compact' }))).toBe('accepted')
	})

	it('voids everything on a generation boundary and reopens only after the new capability ACK', () => {
		const { streams, sent } = coordinator()
		streams.setDemand([pin('a', 'open')])
		streams.accept(report('a', 'id-1', 9))
		streams.setContext({ ...base, runtimeGenerationId: 'g2' })
		expect(streams.report('a')).toBeUndefined()
		expect(streams.isReady()).toBe(false)
		expect(sent).toHaveLength(1)
		streams.setReady(true)
		expect(sent.at(-1)).toMatchObject({ context: { runtimeGenerationId: 'g2', widgetId: 'a', navigationRequestId: 'id-2' } })
		// A fresh generation starts a fresh revision domain.
		expect(streams.accept({ ...report('a', 'id-2', 1), context: { ...report('a', 'id-2', 1).context, runtimeGenerationId: 'g2' } })).toBe('accepted')
	})

	it('hides every report at once on a content-box resize and reopens all streams once, next frame', () => {
		const frames: Array<() => void> = []
		const { streams, sent } = coordinator({ frames })
		streams.setDemand([pin('a', 'open'), pin('b', 'open'), { consumerId: 'selection', widgetId: 'c', tier: 'highlight', navigationRequestId: 'nav-1' }])
		streams.accept(report('a', 'id-1', 1))
		const changed: string[][] = []
		streams.subscribe(widgets => changed.push([...widgets]))
		streams.invalidateContentBox()
		streams.invalidateContentBox()
		expect(streams.report('a')).toBeUndefined()
		expect(changed).toEqual([['a']])
		expect(frames).toHaveLength(1)
		frames.splice(0).forEach(frame => frame())
		const reopened = sent.slice(3).map(message => [message.context.widgetId, message.context.navigationRequestId])
		// The consumer-owned (Checks) stream is reopened by its owner with a new navigation request.
		expect(reopened).toEqual([['a', 'id-3'], ['b', 'id-4']])
		expect(streams.accept(report('a', 'id-1', 2))).toBe('stale-stream')
		expect(streams.accept(report('a', 'id-3', 2))).toBe('accepted')
	})

	it('sends nothing before the capability ACK and opens the assigned streams when it arrives', () => {
		const sent: Sent[] = []
		const streams = new GeometryStreamCoordinator({ send: message => sent.push(message), mintId: (() => { let n = 0; return () => `x${++n}` })() })
		streams.setContext(base)
		streams.setMultiTarget(true)
		streams.setDemand([pin('a', 'open')])
		expect(sent).toHaveLength(0)
		streams.setReady(true)
		expect(sent).toHaveLength(1)
	})

	it('drives the real runtime producer end to end: release, supersession and staleness', () => {
		const runtimeFrames: Array<() => void> = []
		const toWorkbench: GeometryAcquireResponse[] = []
		let y = 0
		const producer = new RuntimeGeometryProducer({
			send: response => toWorkbench.push(response),
			measurer: { beginPass() {}, endPass() {}, measure: () => ({ rect: { x: 0, y, width: 10, height: 10 }, regions: [] }) },
			requestFrame: callback => runtimeFrames.push(callback),
			cancelFrame: () => {},
		})
		producer.setContext({ viewId })
		const streams = new GeometryStreamCoordinator({ send: message => producer.receive(message), mintId: (() => { let n = 0; return () => `s${++n}` })() })
		streams.setContext(base)
		streams.setMultiTarget(true)
		streams.setReady(true)
		const flush = () => {
			runtimeFrames.splice(0).forEach(frame => frame())
			return toWorkbench.splice(0).map(message => streams.accept(message))
		}
		streams.setDemand([pin('a', 'open'), pin('b', 'open')])
		expect(flush()).toEqual(['accepted', 'accepted'])
		y = 30
		producer.invalidate()
		expect(flush()).toEqual(['accepted', 'accepted'])
		expect(streams.report('a')?.rect.y).toBe(30)
		streams.setDemand([pin('b', 'open')])
		expect(producer.trackedWidgetIds()).toEqual(['b'])
		producer.invalidate()
		expect(flush()).toEqual([])
	})
})

describe('Outer mapping observer: event-driven pins-only mode', () => {
	function controller() {
		const frames: Array<() => void> = []
		let measured = 0
		const observer = new OuterMappingObserverController<number>({
			requestFrame: callback => frames.push(callback),
			cancelFrame: (handle) => { frames[handle - 1] = () => {} },
			measureRenderedMapping: () => ++measured,
			onMappingMeasured: () => {},
			onMappingUnavailable: () => {},
			onInnerGeometryInvalidated: () => {},
		})
		const run = () => {
			const pending = frames.splice(0)
			pending.forEach(frame => frame())
			return pending.length
		}
		return { observer, run, get measured() { return measured } }
	}

	it('measures once after a dirty signal and is idle otherwise; continuous mode keeps the accepted loop', () => {
		const c = controller()
		c.observer.setMode('event-driven')
		c.observer.setOverlayActive(true)
		expect(c.run()).toBe(1)
		expect(c.run()).toBe(0)
		c.observer.markMappingDirty()
		c.observer.markMappingDirty()
		expect(c.run()).toBe(1)
		expect(c.run()).toBe(0)
		expect(c.measured).toBe(2)
		// While an ancestor transition or a Workbench zoom tween runs, it measures every frame.
		c.observer.setAnimating(true)
		expect(c.run()).toBe(1)
		expect(c.run()).toBe(1)
		c.observer.setAnimating(false)
		expect(c.run()).toBe(1)
		expect(c.run()).toBe(0)
		// A highlight or targeting overlay switches back to the continuous loop.
		c.observer.setMode('continuous')
		expect(c.run()).toBe(1)
		expect(c.run()).toBe(1)
		expect(c.observer.snapshot()).toMatchObject({ mode: 'continuous', overlayActive: true })
	})
})
