import { describe, expect, it } from 'vitest'

import { RuntimeGeometryProducer, type WidgetGeometry } from '../src/preview/geometry-producer'
import {
	MAX_TRACKED_WIDGETS,
	validateGeometryMessage,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type GeometryReleaseRequest,
} from '../src/preview/protocol/schema'

const viewId = '11111111-1111-4111-8111-111111111111'

function rectRegion(x: number, y: number, width: number, height: number) {
	return {
		regionId: 'r0',
		maxError: 0,
		contour: { commands: [
			{ op: 'moveTo', x, y },
			{ op: 'lineTo', x: x + width, y },
			{ op: 'lineTo', x: x + width, y: y + height },
			{ op: 'lineTo', x, y: y + height },
			{ op: 'close' },
		] as const },
	}
}

function fixture(maxStreams?: number) {
	const frames: Array<() => void> = []
	const sent: GeometryAcquireResponse[] = []
	const geometry = new Map<string, WidgetGeometry>()
	const measured: string[] = []
	let passes = 0
	const producer = new RuntimeGeometryProducer({
		send: response => sent.push(response),
		measurer: {
			beginPass: () => { passes++ },
			measure(widgetId) {
				measured.push(widgetId)
				return geometry.get(widgetId) ?? { rect: { x: 0, y: 0, width: 0, height: 0 }, regions: [] }
			},
			endPass: () => {},
		},
		requestFrame: (callback) => { frames.push(callback); return frames.length },
		cancelFrame: (handle) => { frames[handle - 1] = () => {} },
		...(maxStreams ? { maxStreams } : {}),
	})
	producer.setContext({ viewId })
	const runFrames = () => {
		const pending = frames.splice(0)
		for (const frame of pending) frame()
		return pending.length
	}
	const place = (widgetId: string, x: number, y: number, width = 40, height = 20) => {
		geometry.set(widgetId, { rect: { x, y, width, height }, regions: [rectRegion(x, y, width, height)] })
	}
	return { producer, frames, sent, geometry, measured, runFrames, place, get passes() { return passes } }
}

function acquire(widgetId: string, navigationRequestId: string, extra: Record<string, unknown> = {}): GeometryAcquireRequest {
	return {
		type: 'geometry.acquire.request',
		context: { previewSessionId: 's', runtimeGenerationId: 'g', viewId, navigationRequestId, widgetId, ...extra },
		payload: {},
	}
}

function release(widgetId: string, navigationRequestId: string): GeometryReleaseRequest {
	return {
		type: 'geometry.release',
		context: { previewSessionId: 's', runtimeGenerationId: 'g', viewId, navigationRequestId, widgetId },
		payload: {},
	}
}

describe('Runtime geometry producer (multi-target streams)', () => {
	it('answers a request with a complete baseline in the next frame, echoing the request context', () => {
		const f = fixture()
		f.place('a', 10, 20)
		expect(f.producer.receive(acquire('a', 'n1', { variantId: undefined }))).toBe('opened')
		expect(f.sent).toHaveLength(0)
		expect(f.runFrames()).toBe(1)
		expect(f.sent).toHaveLength(1)
		const [report] = f.sent
		expect(report!.context).toMatchObject({ previewSessionId: 's', runtimeGenerationId: 'g', viewId, navigationRequestId: 'n1', widgetId: 'a', geometryRevision: 1 })
		expect(report!.payload.rect).toEqual({ x: 10, y: 20, width: 40, height: 20 })
		expect(validateGeometryMessage(report).ok).toBe(true)
	})

	it('re-reports only on a real change, at most once per frame, with an advancing revision and no idle frames', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.producer.receive(acquire('a', 'n1'))
		f.runFrames()
		// Many invalidations in one frame coalesce into one recomputation and no report when unchanged.
		f.producer.invalidate()
		f.producer.invalidate()
		f.producer.invalidate()
		expect(f.frames).toHaveLength(1)
		f.runFrames()
		expect(f.sent).toHaveLength(1)
		// Nothing dirty: no frame is requested at all.
		expect(f.frames).toHaveLength(0)
		expect(f.producer.hasPendingFrame()).toBe(false)
		// A scroll moves the Widget: one new complete report with the next revision.
		f.place('a', 0, -30)
		f.producer.invalidate()
		f.producer.invalidate()
		f.runFrames()
		expect(f.sent).toHaveLength(2)
		expect(f.sent[1]!.context.geometryRevision).toBe(2)
		expect(f.sent[1]!.payload.rect.y).toBe(-30)
		expect(f.frames).toHaveLength(0)
	})

	it('reports an unrendered Widget as a zero-area rect with no regions and keeps the stream open', () => {
		const f = fixture()
		f.producer.receive(acquire('ghost', 'n1'))
		f.runFrames()
		expect(f.sent[0]!.payload).toEqual({ rect: { x: 0, y: 0, width: 0, height: 0 }, regions: [] })
		f.place('ghost', 5, 5)
		f.producer.invalidate()
		f.runFrames()
		expect(f.sent[1]!.payload.rect.width).toBe(40)
		expect(f.sent[1]!.context.geometryRevision).toBe(2)
	})

	it('keeps streams per Widget: different Widgets coexist, a new request for the same Widget supersedes', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.place('b', 50, 0)
		f.producer.receive(acquire('a', 'n1'))
		f.producer.receive(acquire('b', 'n2'))
		f.runFrames()
		expect(f.sent.map(report => report.context.navigationRequestId)).toEqual(['n1', 'n2'])
		expect(f.producer.receive(acquire('a', 'n3'))).toBe('superseded')
		f.runFrames()
		// The superseding stream gets its baseline even though nothing moved, with a newer Widget revision.
		expect(f.sent[2]!.context).toMatchObject({ navigationRequestId: 'n3', widgetId: 'a', geometryRevision: 2 })
		f.place('a', 0, 10)
		f.producer.invalidate()
		f.runFrames()
		expect(f.sent.slice(3).map(report => report.context.navigationRequestId)).toEqual(['n3'])
	})

	it('ends a stream on geometry.release and ignores a release that names a superseded stream', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.producer.receive(acquire('a', 'n1'))
		f.producer.receive(acquire('a', 'n2'))
		expect(f.producer.receive(release('a', 'n1'))).toBe('ignored-unknown-stream')
		f.runFrames()
		expect(f.sent).toHaveLength(1)
		expect(f.producer.receive(release('a', 'n2'))).toBe('released')
		f.place('a', 0, 99)
		f.producer.invalidate()
		expect(f.frames).toHaveLength(0)
		expect(f.producer.trackedWidgetIds()).toEqual([])
	})

	it('supports 64 concurrent streams and ignores the excess silently', () => {
		expect(MAX_TRACKED_WIDGETS).toBe(64)
		const f = fixture()
		for (let index = 0; index < 70; index++) {
			f.place(`w${index}`, index, 0)
			const outcome = f.producer.receive(acquire(`w${index}`, `n${index}`))
			expect(outcome).toBe(index < 64 ? 'opened' : 'ignored-over-cap')
		}
		f.runFrames()
		expect(f.sent).toHaveLength(64)
		expect(f.passes).toBe(1)
		// A released slot is free at once; superseding an open Widget never needs a slot.
		f.producer.receive(release('w0', 'n0'))
		expect(f.producer.receive(acquire('w65', 'n65b'))).toBe('opened')
		expect(f.producer.receive(acquire('w1', 'n1b'))).toBe('superseded')
		expect(f.producer.receive(acquire('w66', 'n66b'))).toBe('ignored-over-cap')
	})

	it('measures only dirty streams: a new stream does not re-measure the others', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.place('b', 0, 0)
		f.producer.receive(acquire('a', 'n1'))
		f.runFrames()
		f.measured.length = 0
		f.producer.receive(acquire('b', 'n2'))
		f.runFrames()
		expect(f.measured).toEqual(['b'])
	})

	it('keeps a stream of another Variant silent and ends streams of a previous context without a release', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.producer.receive(acquire('a', 'base'))
		f.runFrames()
		expect(f.sent).toHaveLength(1)
		// Workbench may open the new Variant's stream before the runtime renders that Variant.
		f.producer.receive(acquire('b', 'compact', { variantId: 'compact' }))
		f.place('b', 1, 1)
		f.runFrames()
		expect(f.sent).toHaveLength(1)
		f.producer.setContext({ viewId, variantId: 'compact' })
		f.runFrames()
		expect(f.sent.map(report => report.context.navigationRequestId)).toEqual(['base', 'compact'])
		expect(f.sent[1]!.context.variantId).toBe('compact')
		expect(f.producer.trackedWidgetIds()).toEqual(['b'])
	})

	it('recomputes every frame only while continuous tracking is on (running transitions)', () => {
		const f = fixture()
		f.place('a', 0, 0)
		f.producer.receive(acquire('a', 'n1'))
		f.runFrames()
		f.producer.setContinuous(true)
		for (let frame = 1; frame <= 3; frame++) {
			f.place('a', frame * 10, 0)
			expect(f.runFrames()).toBe(1)
		}
		expect(f.sent).toHaveLength(4)
		f.producer.setContinuous(false)
		f.runFrames()
		expect(f.frames).toHaveLength(0)
	})

	it('stops all work on dispose', () => {
		const f = fixture()
		f.producer.receive(acquire('a', 'n1'))
		f.producer.dispose()
		f.runFrames()
		expect(f.sent).toHaveLength(0)
		expect(() => f.producer.receive(acquire('a', 'n2'))).toThrow()
	})
})
