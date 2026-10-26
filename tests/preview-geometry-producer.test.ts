import { describe, expect, it } from 'vitest'

import { RuntimeGeometryProducer, type WidgetGeometry } from '../src/preview/geometry-producer'
import {
	MAX_TRACKED_WIDGETS,
	validateGeometryMessage,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type GeometryReleaseRequest,
	type GeometryRevealRequest,
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

function fixture(maxStreams?: number, reveal?: (widgetId: string) => boolean, revealReady?: () => boolean) {
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
		...(reveal ? { reveal } : {}),
		...(revealReady ? { revealReady } : {}),
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

function revealRequest(widgetId: string, navigationRequestId: string, extra: Record<string, unknown> = {}): GeometryRevealRequest {
	return {
		type: 'geometry.reveal',
		context: { previewSessionId: 's', runtimeGenerationId: 'g', viewId, navigationRequestId, widgetId, ...extra },
		payload: {},
	}
}

// Clauses 01a11a59-d8be-78aa-bdc7-28aa62bd9444, 01a11a59-da48-7437-bee8-67787175cbda and 01a11a70-3d8d-7e52-9412-8a92797814e6.
describe('Runtime geometry producer (geometry.reveal)', () => {
	it('scrolls for a reveal that names the open stream of its Widget, and reports the moved Widget as the stream\'s next report', () => {
		const revealed: string[] = []
		let scrolled = false
		const f = fixture(undefined, (widgetId) => { revealed.push(widgetId); scrolled = true; return true })
		f.place('a', 0, 900)
		f.producer.receive(acquire('a', 'n1'))
		f.runFrames()
		expect(f.sent).toHaveLength(1)
		expect(f.sent[0]!.payload.rect.y).toBe(900)
		expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('revealed')
		expect(revealed).toEqual(['a'])
		// The scroll moved the Widget; no reply exists, so the stream reports it with an advanced revision.
		expect(scrolled).toBe(true)
		f.place('a', 0, 100)
		f.runFrames()
		expect(f.sent).toHaveLength(2)
		expect(f.sent[1]!.context).toMatchObject({ navigationRequestId: 'n1', geometryRevision: 2 })
		expect(f.sent[1]!.payload.rect.y).toBe(100)
	})

	it('does nothing, and sends nothing, when the reveal does not apply to the Widget', () => {
		const f = fixture(undefined, () => false)
		f.place('a', 0, 10)
		f.producer.receive(acquire('a', 'n1'))
		f.runFrames()
		expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('no-op')
		expect(f.frames).toHaveLength(0)
		expect(f.sent).toHaveLength(1)
	})

	it('ignores a reveal as stale unless it names the open stream of its Widget in that stream\'s context', () => {
		const revealed: string[] = []
		const f = fixture(undefined, (widgetId) => { revealed.push(widgetId); return true })
		f.place('a', 0, 0)
		f.producer.receive(acquire('a', 'n1'))
		// Unknown Widget, superseded identity and released stream.
		expect(f.producer.receiveReveal(revealRequest('b', 'n1'))).toBe('ignored-stale')
		f.producer.receive(acquire('a', 'n2'))
		expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('ignored-stale')
		// A context other than the one the stream was acquired for.
		expect(f.producer.receiveReveal(revealRequest('a', 'n2', { runtimeContextVersion: 7 }))).toBe('ignored-stale')
		expect(f.producer.receiveReveal(revealRequest('a', 'n2', { variantId: 'compact' }))).toBe('ignored-stale')
		f.producer.receive(release('a', 'n2'))
		expect(f.producer.receiveReveal(revealRequest('a', 'n2'))).toBe('ignored-stale')
		expect(revealed).toEqual([])
	})

	it('ignores a reveal for a stream whose render context is not the one rendered, and for a stream ended by a context change', () => {
		const revealed: string[] = []
		const f = fixture(undefined, (widgetId) => { revealed.push(widgetId); return true })
		f.producer.receive(acquire('a', 'n1', { variantId: 'compact' }))
		expect(f.producer.receiveReveal(revealRequest('a', 'n1', { variantId: 'compact' }))).toBe('ignored-stale')
		f.producer.setContext({ viewId, variantId: 'compact' })
		expect(f.producer.receiveReveal(revealRequest('a', 'n1', { variantId: 'compact' }))).toBe('revealed')
		f.producer.setContext({ viewId })
		expect(f.producer.receiveReveal(revealRequest('a', 'n1', { variantId: 'compact' }))).toBe('ignored-stale')
		expect(revealed).toEqual(['a'])
	})

	describe('a document that has not rendered yet', () => {
		function loading() {
			const revealed: string[] = []
			let ready = false
			const f = fixture(undefined, (widgetId) => { revealed.push(widgetId); return true }, () => ready)
			return { f, revealed, settle: () => { ready = true; f.producer.releaseDeferredReveals() } }
		}

		it('holds a reveal until the document settles, then applies it to the stream that is open', () => {
			const { f, revealed, settle } = loading()
			f.place('a', 0, 900)
			f.producer.receive(acquire('a', 'n1'))
			expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('deferred')
			f.producer.releaseDeferredReveals()
			expect(revealed).toEqual([])
			settle()
			expect(revealed).toEqual(['a'])
			// Applied once: a second release finds nothing waiting.
			settle()
			expect(revealed).toEqual(['a'])
		})

		it('drops a held reveal whose stream ended or was superseded meanwhile', () => {
			const { f, revealed, settle } = loading()
			f.producer.receive(acquire('a', 'n1'))
			f.producer.receive(acquire('b', 'm1'))
			f.producer.receive(acquire('c', 'k1'))
			expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('deferred')
			expect(f.producer.receiveReveal(revealRequest('b', 'm1'))).toBe('deferred')
			expect(f.producer.receiveReveal(revealRequest('c', 'k1'))).toBe('deferred')
			f.producer.receive(acquire('a', 'n2'))
			f.producer.receive(release('b', 'm1'))
			settle()
			expect(revealed).toEqual(['c'])
		})

		it('does not hold a reveal that names no open stream', () => {
			const { f, settle, revealed } = loading()
			expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('ignored-stale')
			settle()
			expect(revealed).toEqual([])
		})
	})

	it('answers nothing without a reveal dependency (a runtime that does not support it)', () => {
		const f = fixture()
		f.producer.receive(acquire('a', 'n1'))
		expect(f.producer.receiveReveal(revealRequest('a', 'n1'))).toBe('ignored-unsupported')
	})
})

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

	// Clause 01a11a70-4261-7155-8aed-28bed7a89064 (issue #339): the runtime's own permanent failure.
	it('stops for good and reports itself unavailable once when a frame pass throws', () => {
		const frames: Array<() => void> = []
		const failures: string[] = []
		let broken = false
		const producer = new RuntimeGeometryProducer({
			send: () => {},
			reportFailure: detail => failures.push(detail),
			measurer: {
				beginPass: () => {},
				measure() {
					if (broken) throw new TypeError('measure exploded')
					return { rect: { x: 0, y: 0, width: 4, height: 4 }, regions: [] }
				},
				endPass: () => {},
			},
			requestFrame: (callback) => { frames.push(callback); return frames.length },
			cancelFrame: () => {},
		})
		producer.setContext({ viewId })
		producer.receive(acquire('a', 'n1'))
		broken = true
		producer.flush()
		expect(failures).toEqual(['TypeError'])
		// Nothing more runs: the producer is disposed, so no second report follows.
		producer.flush()
		expect(failures).toHaveLength(1)
		expect(() => producer.receive(acquire('a', 'n2'))).toThrow()
	})

	it('lets a frame exception propagate when nothing is there to report it', () => {
		const producer = new RuntimeGeometryProducer({
			send: () => {},
			measurer: { beginPass: () => {}, measure() { throw new TypeError('measure exploded') }, endPass: () => {} },
			requestFrame: () => 1,
			cancelFrame: () => {},
		})
		producer.setContext({ viewId })
		producer.receive(acquire('a', 'n1'))
		expect(() => producer.flush()).toThrow('measure exploded')
		// Without failure.reports (a version frame, a harness) the producer is not disposed: it keeps serving.
		expect(() => producer.receive(acquire('b', 'n2'))).not.toThrow()
		expect(() => producer.flush()).toThrow('measure exploded')
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
