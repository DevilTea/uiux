import { describe, expect, it } from 'vitest'

import { ContourRefinement } from '../src/preview/contour-refinement'
import { RuntimeGeometryProducer, type ContourWorkFailure, type WidgetGeometry } from '../src/preview/geometry-producer'
import type { GeometryReport } from '../src/preview/geometry-streams'
import type { AffineOuterMapping } from '../src/preview/outer-precision'
import type { FailureReportMessage } from '../src/preview/protocol/failure-report'
import {
	validateGeometryMessage,
	type ContourCancel,
	type FullContourRequest,
	type FullContourResponse,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type PartialContourRequest,
	type PartialContourResponse,
	type VisibleRegion,
} from '../src/preview/protocol/schema'

/**
 * The runtime's contour work (issue #110): it answers full and partial requests in a frame after its
 * own pending report, honors best-effort cancellation, never answers work of a replaced geometry
 * revision, and keeps its region IDs. The last test runs it against the Workbench's refinement.
 */

const viewId = '11111111-1111-4111-8111-111111111111'
const base = { previewSessionId: 's', runtimeGenerationId: 'g', viewId }

function polygon(x: number, inset: number) {
	return { commands: [
		{ op: 'moveTo', x: x + inset, y: 0 },
		{ op: 'lineTo', x: x + 10 - inset, y: 0 },
		{ op: 'lineTo', x: x + 10, y: 10 - inset },
		{ op: 'lineTo', x: x + inset, y: 10 },
		{ op: 'close' },
	] } as const
}

/** Regions whose outline is finer for a smaller error bound, as a real measurer's would be. */
function regions(count: number, maxError: number): VisibleRegion[] {
	return Array.from({ length: count }, (_, index) => ({ regionId: `r${index}`, maxError, contour: polygon(index * 20, maxError / 10) }))
}

function fixture() {
	const frames: Array<() => void> = []
	const reports: GeometryAcquireResponse[] = []
	const responses: Array<FullContourResponse | PartialContourResponse> = []
	const failures: ContourWorkFailure[] = []
	const measuredAt: Array<[string, number]> = []
	const state = {
		count: 2,
		x: 0,
		throwAt: false,
		refinedCount: undefined as number | undefined,
	}
	const geometry = (maxError: number, count: number): WidgetGeometry => ({ rect: { x: state.x, y: 0, width: 40, height: 10 }, regions: regions(count, maxError) })
	const producer = new RuntimeGeometryProducer({
		send: response => reports.push(response),
		sendContour: response => responses.push(response),
		reportWorkFailure: failure => failures.push(failure),
		measurer: {
			beginPass: () => {},
			measure: () => geometry(0.5, state.count),
			measureAt(widgetId, target) {
				measuredAt.push([widgetId, target])
				if (state.throwAt) throw new Error('boom')
				return geometry(Math.min(0.5, target), state.refinedCount ?? state.count)
			},
			endPass: () => {},
		},
		requestFrame: (callback) => { frames.push(callback); return frames.length },
		cancelFrame: (handle) => { frames[handle - 1] = () => {} },
	})
	producer.setContext({ viewId })
	const runFrames = () => {
		const pending = frames.splice(0)
		for (const frame of pending) frame()
		return pending.length
	}
	return { producer, reports, responses, failures, measuredAt, state, runFrames }
}

function acquire(widgetId = 'a', navigationRequestId = 'n1'): GeometryAcquireRequest {
	return { type: 'geometry.acquire.request', context: { ...base, navigationRequestId, widgetId }, payload: {} }
}

function contextOf(geometryRevision: number, widgetId = 'a') {
	return { ...base, widgetId, geometryRevision }
}

function full(sequence: number, geometryRevision: number, targetMaxError = 0.1, widgetId = 'a'): FullContourRequest {
	return { type: 'contour.full.request', context: contextOf(geometryRevision, widgetId), payload: { sequence, targetMaxError } }
}

function partial(sequence: number, geometryRevision: number, regionIds: string[], targetMaxError = 0.1, baseSnapshotVersion = 1): PartialContourRequest {
	return { type: 'contour.partial.request', context: contextOf(geometryRevision), payload: { sequence, baseSnapshotVersion, regionIds, targetMaxError } }
}

function cancel(sequence: number, geometryRevision: number): ContourCancel {
	return { type: 'contour.cancel', context: contextOf(geometryRevision), payload: { sequence } }
}

function opened() {
	const f = fixture()
	f.producer.receive(acquire())
	f.runFrames()
	expect(f.reports).toHaveLength(1)
	return f
}

describe('Runtime contour work', () => {
	it('answers a full request in a later frame with the whole set at the requested precision', () => {
		const f = opened()
		expect(f.producer.receiveContour(full(1, 1, 0.1))).toBe('queued')
		expect(f.responses).toEqual([])
		f.runFrames()
		expect(f.measuredAt).toEqual([['a', 0.1]])
		const [response] = f.responses as [FullContourResponse]
		expect(response.type).toBe('contour.full.response')
		expect(response.context).toEqual(contextOf(1))
		expect(response.context).not.toHaveProperty('navigationRequestId')
		expect(response.payload.sequence).toBe(1)
		expect(response.payload.regions.map(region => [region.regionId, region.maxError])).toEqual([['r0', 0.1], ['r1', 0.1]])
		expect(validateGeometryMessage(response).ok).toBe(true)
		// Contour work never advances the geometry revision.
		expect(f.reports).toHaveLength(1)
	})

	it('answers a partial request with exactly the requested regions and echoes its base', () => {
		const f = opened()
		f.producer.receiveContour(partial(3, 1, ['r1'], 0.2, 7))
		f.runFrames()
		const [response] = f.responses as [PartialContourResponse]
		expect(response.type).toBe('contour.partial.response')
		expect(response.payload).toMatchObject({ sequence: 3, baseSnapshotVersion: 7 })
		expect(response.payload.regions.map(region => region.regionId)).toEqual(['r1'])
		expect(validateGeometryMessage(response).ok).toBe(true)
	})

	it('honors a cancellation of waiting work only for its exact sequence', () => {
		const f = opened()
		f.producer.receiveContour(full(1, 1))
		expect(f.producer.receiveContour(cancel(2, 1))).toBe('ignored-stale')
		expect(f.producer.receiveContour(cancel(1, 9))).toBe('ignored-stale')
		expect(f.producer.receiveContour(cancel(1, 1))).toBe('canceled')
		f.runFrames()
		expect(f.responses).toEqual([])
		expect(f.measuredAt).toEqual([])
		// A cancellation that arrives too late, or twice, is no failure and changes nothing.
		f.producer.receiveContour(full(2, 1))
		f.runFrames()
		expect(f.responses).toHaveLength(1)
		expect(f.producer.receiveContour(cancel(2, 1))).toBe('ignored-stale')
		expect(f.failures).toEqual([])
	})

	it('lets a newer request replace work that still waits, and ignores an older or repeated sequence', () => {
		const f = opened()
		f.producer.receiveContour(full(2, 1, 0.2))
		f.producer.receiveContour(full(3, 1, 0.05))
		expect(f.producer.receiveContour(full(3, 1))).toBe('ignored-stale')
		expect(f.producer.receiveContour(full(1, 1))).toBe('ignored-stale')
		f.runFrames()
		expect(f.responses.map(response => response.payload.sequence)).toEqual([3])
		expect(f.measuredAt).toEqual([['a', 0.05]])
	})

	it('starts a new sequence domain for a new geometry revision', () => {
		const f = opened()
		f.producer.receiveContour(full(5, 1))
		f.runFrames()
		f.state.x = 3
		f.producer.invalidate()
		f.runFrames()
		expect(f.reports).toHaveLength(2)
		expect(f.producer.receiveContour(full(1, 2))).toBe('queued')
		f.runFrames()
		expect(f.responses.map(response => [response.context.geometryRevision, response.payload.sequence])).toEqual([[1, 5], [2, 1]])
	})

	it('never answers work of a geometry revision that its own pending report replaced', () => {
		const f = opened()
		f.producer.receiveContour(full(1, 1))
		// The Widget moved before the frame: the baseline re-measure reports revision 2 first.
		f.state.x = 5
		f.runFrames()
		expect(f.reports.map(report => report.context.geometryRevision)).toEqual([1, 2])
		expect(f.responses).toEqual([])
		expect(f.producer.receiveContour(full(2, 1))).toBe('ignored-stale')
	})

	it('ignores work for an unknown stream, a replaced context, an unreported revision and a runtime without support', () => {
		const f = opened()
		expect(f.producer.receiveContour(full(1, 1, 0.1, 'unknown'))).toBe('ignored-stale')
		expect(f.producer.receiveContour(full(1, 2))).toBe('ignored-stale')
		expect(f.producer.receiveContour({ ...full(1, 1), context: { ...contextOf(1), variantId: 'dark' } })).toBe('ignored-stale')
		f.producer.setContext({ viewId: '22222222-2222-4222-8222-222222222222' })
		expect(f.producer.receiveContour(full(1, 1))).toBe('ignored-stale')
		const bare = new RuntimeGeometryProducer({
			send: () => {},
			measurer: { beginPass: () => {}, measure: () => ({ rect: { x: 0, y: 0, width: 1, height: 1 }, regions: [] }), endPass: () => {} },
			requestFrame: () => 1,
			cancelFrame: () => {},
		})
		expect(bare.receiveContour(full(1, 1))).toBe('ignored-unsupported')
	})

	it('reports the failure of work it cannot do as a work-scoped failure, with no response', () => {
		const f = opened()
		f.state.throwAt = true
		f.producer.receiveContour(partial(4, 1, ['r0'], 0.1, 6))
		f.runFrames()
		expect(f.responses).toEqual([])
		expect(f.failures).toEqual([{
			context: contextOf(1),
			sequence: 4,
			baseSnapshotVersion: 6,
			reason: 'runtime.unavailable',
			detail: 'Error',
		}])
	})

	it('answers a curve it cannot bound with what it reported, which the Workbench judges a precision miss', () => {
		const f = opened()
		f.state.refinedCount = 0
		f.producer.receiveContour(full(1, 1, 0.01))
		f.runFrames()
		const [response] = f.responses as [FullContourResponse]
		expect(response.payload.regions.map(region => region.maxError)).toEqual([0.5, 0.5])
	})

	it('reports a new geometry revision at that precision instead of renaming regions that no longer correspond', () => {
		const f = opened()
		f.state.refinedCount = 3
		f.producer.receiveContour(full(1, 1, 0.1))
		f.runFrames()
		expect(f.responses).toEqual([])
		// The stream reports revision 2 itself, measured at the requested precision, with its own IDs.
		f.runFrames()
		expect(f.reports.map(report => report.context.geometryRevision)).toEqual([1, 2])
		expect(f.reports[1]!.payload.regions.map(region => [region.regionId, region.maxError])).toEqual([['r0', 0.1], ['r1', 0.1], ['r2', 0.1]])
		// The old revision's work is void, and the new revision can be refined further.
		expect(f.producer.receiveContour(full(2, 1))).toBe('ignored-stale')
		f.state.refinedCount = undefined
		f.state.count = 3
		expect(f.producer.receiveContour(full(1, 2, 0.05))).toBe('queued')
	})
})

describe('Runtime precision held for a stream', () => {
	it('goes back to the default precision once a request asks for coarser contours', () => {
		const f = opened()
		f.state.refinedCount = 3
		f.producer.receiveContour(full(1, 1, 0.1))
		f.runFrames()
		f.runFrames()
		expect(f.reports.at(-1)!.payload.regions.map(region => region.maxError)).toEqual([0.1, 0.1, 0.1])
		f.state.count = 3
		f.state.refinedCount = undefined
		f.producer.receiveContour(full(1, 2, 0.4))
		f.runFrames()
		expect(f.reports.at(-1)!.context.geometryRevision).toBe(3)
		expect(f.reports.at(-1)!.payload.regions.map(region => region.maxError)).toEqual([0.5, 0.5, 0.5])
	})
})

describe('Workbench refinement against the runtime', () => {
	const scale = (value: number): AffineOuterMapping => ({ kind: 'affine', a: value, b: 0, c: 0, d: value, e: 0, f: 0 })

	function loop() {
		const f = fixture()
		f.state.count = 2
		const sent: Array<FullContourRequest | PartialContourRequest | ContourCancel> = []
		const refinement = new ContourRefinement({
			send(message) {
				sent.push(message)
				if (message.type === 'contour.cancel') {
					f.producer.receiveContour(message)
					return true
				}
				f.producer.receiveContour(message)
				return true
			},
		})
		refinement.setContext(base)
		refinement.setDemand('a')
		f.producer.receive(acquire())
		f.runFrames()
		const first = f.reports[0]!
		const report: GeometryReport = { widgetId: 'a', navigationRequestId: 'n1', geometryRevision: first.context.geometryRevision, rect: first.payload.rect, regions: first.payload.regions }
		refinement.acceptReport(report)
		const drain = () => {
			f.runFrames()
			for (const response of f.responses.splice(0)) refinement.receiveResponse(response)
		}
		return { ...f, refinement, sent, drain }
	}

	it('refines on zoom-in, round trip through the runtime, and draws only the finer result', () => {
		const f = loop()
		f.refinement.setMapping(scale(0.9))
		expect(f.refinement.precision('a').status).toBe('precise')
		f.refinement.setMapping(scale(3))
		expect(f.refinement.precision('a').status).toBe('pending')
		f.drain()
		const precision = f.refinement.precision('a')
		expect(precision.status).toBe('precise')
		if (precision.status !== 'precise') throw new Error('unreachable')
		expect(Math.max(...precision.regions.map(region => region.maxError)) * 3).toBeLessThanOrEqual(0.5)
		expect(precision.maxFinalError).toBeLessThanOrEqual(0.5)
		expect(f.sent.map(message => message.type)).toEqual(['contour.partial.request'])
	})

	it('cancels at the runtime when a scale-down restores the cache before the runtime answered', () => {
		const f = loop()
		f.refinement.setMapping(scale(3))
		f.refinement.setMapping(scale(0.8))
		expect(f.sent.map(message => message.type)).toEqual(['contour.partial.request', 'contour.cancel'])
		f.drain()
		expect(f.measuredAt).toEqual([])
		expect(f.refinement.precision('a').status).toBe('precise')
	})

	it('latches on the runtime failing the work and starts nothing else within the geometry revision', () => {
		const f = loop()
		f.state.throwAt = true
		f.refinement.setMapping(scale(3))
		f.runFrames()
		expect(f.failures).toHaveLength(1)
		const failure = f.failures[0]!
		const message: FailureReportMessage = {
			type: 'failure.report',
			context: failure.context,
			payload: { category: 'runtime', reason: failure.reason, sequence: failure.sequence, ...(failure.baseSnapshotVersion !== undefined ? { baseSnapshotVersion: failure.baseSnapshotVersion } : {}) },
		}
		expect(f.refinement.receiveFailureReport(message)).toBe('ended')
		f.refinement.setMapping(scale(5))
		f.refinement.setMapping(scale(2))
		f.runFrames()
		expect(f.sent.filter(request => request.type !== 'contour.cancel')).toHaveLength(1)
		expect(f.refinement.precision('a')).toMatchObject({ status: 'unavailable', reason: 'latched' })
	})
})
