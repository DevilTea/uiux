import { describe, expect, it } from 'vitest'

import { ContourRefinement } from '../src/preview/contour-refinement'
import type { GeometryReport, GeometryStreamContext } from '../src/preview/geometry-streams'
import type { AffineOuterMapping } from '../src/preview/outer-precision'
import type { FailureReportMessage } from '../src/preview/protocol/failure-report'
import type {
	ContourCancel,
	FullContourRequest,
	FullContourResponse,
	PartialContourRequest,
	PartialContourResponse,
	VisibleRegion,
} from '../src/preview/protocol/schema'

/**
 * The Workbench's contour precision check and refinement driver (issue #110): the display tolerance
 * under the outer mapping, refinement requests, cancellation, merging, escalation and the latch.
 */

const viewId = '11111111-1111-4111-8111-111111111111'
const context: GeometryStreamContext = { previewSessionId: 's', runtimeGenerationId: 'g1', viewId, variantId: 'dark' }
type Sent = FullContourRequest | PartialContourRequest | ContourCancel

const scale = (value: number): AffineOuterMapping => ({ kind: 'affine', a: value, b: 0, c: 0, d: value, e: 12, f: 7 })

function square(x: number, size = 10) {
	return { commands: [
		{ op: 'moveTo', x, y: 0 },
		{ op: 'lineTo', x: x + size, y: 0 },
		{ op: 'lineTo', x: x + size, y: size },
		{ op: 'lineTo', x, y: size },
		{ op: 'close' },
	] } as const
}

function region(regionId: string, maxError: number, x = 0): VisibleRegion {
	return { regionId, contour: square(x), maxError }
}

function report(geometryRevision: number, regions: readonly VisibleRegion[], widgetId = 'w'): GeometryReport {
	return { widgetId, navigationRequestId: `nav-${geometryRevision}`, geometryRevision, rect: { x: 0, y: 0, width: 40, height: 10 }, regions }
}

function fixture(options: { open?: boolean } = {}) {
	const sent: Sent[] = []
	const state = { open: options.open ?? true }
	const refinement = new ContourRefinement({ send: (message) => { if (!state.open) return false; sent.push(message); return true } })
	refinement.setContext(context)
	refinement.setDemand('w')
	const requests = () => sent.filter((message): message is FullContourRequest | PartialContourRequest => message.type !== 'contour.cancel')
	const cancels = () => sent.filter((message): message is ContourCancel => message.type === 'contour.cancel')
	return { refinement, sent, state, requests, cancels }
}

function workContext(geometryRevision: number, widgetId = 'w') {
	return { ...context, widgetId, geometryRevision }
}

function partialResponse(request: PartialContourRequest, regions: readonly VisibleRegion[]): PartialContourResponse {
	return { type: 'contour.partial.response', context: request.context, payload: { sequence: request.payload.sequence, baseSnapshotVersion: request.payload.baseSnapshotVersion, regions } }
}

function fullResponse(request: FullContourRequest, regions: readonly VisibleRegion[]): FullContourResponse {
	return { type: 'contour.full.response', context: request.context, payload: { sequence: request.payload.sequence, regions } }
}

function failureReport(request: FullContourRequest | PartialContourRequest, overrides: { sequence?: number } = {}): FailureReportMessage {
	return {
		type: 'failure.report',
		context: { ...request.context },
		payload: {
			category: 'runtime',
			reason: 'runtime.unavailable',
			sequence: overrides.sequence ?? request.payload.sequence,
			...(request.type === 'contour.partial.request' ? { baseSnapshotVersion: request.payload.baseSnapshotVersion } : {}),
		},
	}
}

describe('Contour precision at the display scale', () => {
	it('draws only while every contour meets the display tolerance, and sends nothing for it', () => {
		const f = fixture()
		f.refinement.setMapping(scale(1))
		f.refinement.acceptReport(report(1, [region('r0', 0.49), region('r1', 0.2, 20)]))
		expect(f.refinement.precision('w')).toMatchObject({ status: 'precise', geometryRevision: 1 })
		expect(f.sent).toEqual([])
		// The error is amplified by the mapping's largest singular value, so a smaller scale only helps.
		f.refinement.setMapping(scale(0.4))
		expect(f.refinement.precision('w')).toMatchObject({ status: 'precise' })
		expect(f.sent).toEqual([])
	})

	it('hides the whole highlight while a contour misses the tolerance, and says nothing until the mapping is known', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		expect(f.refinement.precision('w').status).toBe('pending')
		expect(f.sent).toEqual([])
		f.refinement.setMapping(scale(2))
		expect(f.refinement.precision('w').status).toBe('pending')
	})

	it('draws nothing for a Widget without regions or another Widget than the demanded one', () => {
		const f = fixture()
		f.refinement.setMapping(scale(1))
		f.refinement.acceptReport(report(1, []))
		expect(f.refinement.precision('w').status).toBe('none')
		expect(f.refinement.precision('other').status).toBe('none')
		f.refinement.acceptReport(report(2, [region('r0', 0)], 'other'))
		expect(f.refinement.precision('other').status).toBe('none')
	})
})

describe('Contour refinement on zoom', () => {
	it('requests finer contours of only the failing regions for the unchanged geometry', () => {
		const f = fixture()
		f.refinement.acceptReport(report(4, [region('r0', 0.5), region('r1', 0.1, 20), region('r2', 0.5, 40)]))
		f.refinement.setMapping(scale(2))
		expect(f.requests()).toHaveLength(1)
		const request = f.requests()[0] as PartialContourRequest
		expect(request.type).toBe('contour.partial.request')
		expect(request.context).toEqual(workContext(4))
		expect(request.context).not.toHaveProperty('navigationRequestId')
		expect(request.payload).toMatchObject({ sequence: 1, baseSnapshotVersion: 1, regionIds: ['r0', 'r2'] })
		// Amplification 2 (plus rounding up): the inner bound must be just below 0.25.
		expect(request.payload.targetMaxError).toBeLessThan(0.25)
		expect(request.payload.targetMaxError).toBeGreaterThan(0.2499)
		expect(f.refinement.precision('w').status).toBe('pending')
	})

	it('restores the highlight only from a result that meets the tolerance, merging per region at once', () => {
		const f = fixture()
		f.refinement.acceptReport(report(4, [region('r0', 0.5), region('r1', 0.1, 20)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0] as PartialContourRequest
		const outcome = f.refinement.receiveResponse(partialResponse(request, [region('r0', 0.2)]))
		expect(outcome).toBe('committed')
		const precision = f.refinement.precision('w')
		expect(precision).toMatchObject({ status: 'precise' })
		if (precision.status !== 'precise') throw new Error('unreachable')
		expect(precision.regions.map(item => [item.regionId, item.maxError])).toEqual([['r0', 0.2], ['r1', 0.1]])
		// No further work: the merged cache meets the tolerance.
		expect(f.requests()).toHaveLength(1)
		expect(f.cancels()).toEqual([])
	})

	it('restores an accurate cache on scale-down at once, retiring and canceling the pending work', () => {
		const f = fixture()
		f.refinement.acceptReport(report(4, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0]!
		f.refinement.setMapping(scale(0.9))
		expect(f.refinement.precision('w').status).toBe('precise')
		expect(f.requests()).toHaveLength(1)
		expect(f.cancels()).toEqual([{ type: 'contour.cancel', context: workContext(4), payload: { sequence: request.payload.sequence } }])
		// The retired work never commits, even when its result would meet the tolerance.
		expect(f.refinement.receiveResponse(partialResponse(request as PartialContourRequest, [region('r0', 0.1)]))).toBe('stale')
		expect(f.refinement.state().work).toBeUndefined()
	})

	it('waits for work that is fine enough, and supersedes it with a cancel for a finer need', () => {
		const f = fixture()
		f.refinement.acceptReport(report(4, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.setMapping(scale(1.5))
		f.refinement.setMapping(scale(2))
		expect(f.requests()).toHaveLength(1)
		f.refinement.setMapping(scale(4))
		expect(f.requests().map(request => request.payload.sequence)).toEqual([1, 2])
		expect(f.cancels().map(cancel => cancel.payload.sequence)).toEqual([1])
		// Newer work never waits for the cancellation: the request follows the cancel in the same turn.
		expect(f.sent.map(message => message.type)).toEqual(['contour.partial.request', 'contour.cancel', 'contour.partial.request'])
		const [older, newer] = f.requests() as PartialContourRequest[]
		expect(f.refinement.receiveResponse(partialResponse(older!, [region('r0', 0.01)]))).toBe('stale')
		expect(f.refinement.precision('w').status).toBe('pending')
		expect(f.refinement.receiveResponse(partialResponse(newer!, [region('r0', 0.01)]))).toBe('committed')
		expect(f.refinement.precision('w').status).toBe('precise')
	})

	it('never sends contour work for the same scale twice and counts sequences per generation', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.acceptReport(report(2, [region('r0', 0.5)]))
		f.refinement.acceptReport(report(3, [region('r0', 0.5)]))
		// Each new geometry revision needs its own refinement, and the work for older ones is canceled.
		expect(f.requests().map(request => [request.context.geometryRevision, request.payload.sequence])).toEqual([[1, 1], [2, 2], [3, 3]])
		expect(f.cancels().map(cancel => [cancel.context.geometryRevision, cancel.payload.sequence])).toEqual([[1, 1], [2, 2]])
	})

	it('drops the cache and cancels the work when the report is gone', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.dropReport('w')
		expect(f.cancels()).toHaveLength(1)
		expect(f.refinement.precision('w').status).toBe('none')
		f.refinement.setMapping(scale(3))
		expect(f.requests()).toHaveLength(1)
	})
})

describe('Cancellation on a context change', () => {
	it('cancels the work of the previous View or Variant, and ends it with the new context', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.setContext({ ...context, variantId: 'light' })
		expect(f.cancels()).toEqual([{ type: 'contour.cancel', context: workContext(1), payload: { sequence: 1 } }])
		expect(f.refinement.precision('w').status).toBe('none')
		expect(f.refinement.state().work).toBeUndefined()
	})

	it('cancels when the demanded Widget changes, and sends nothing on a generation boundary', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.setDemand('other')
		expect(f.cancels()).toHaveLength(1)
		f.refinement.setDemand('w')
		f.refinement.acceptReport(report(2, [region('r0', 0.5)]))
		expect(f.requests()).toHaveLength(2)
		f.refinement.setContext({ ...context, runtimeGenerationId: 'g2' })
		expect(f.cancels()).toHaveLength(1)
		// A new generation starts its own sequence domain.
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		expect((f.requests().at(-1) as PartialContourRequest).payload.sequence).toBe(1)
	})

	it('never commits a response of a replaced context', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0] as PartialContourRequest
		f.refinement.setContext({ ...context, viewId: '22222222-2222-4222-8222-222222222222' })
		expect(f.refinement.receiveResponse(partialResponse(request, [region('r0', 0.1)]))).toBe('stale')
	})
})

describe('Recoverable refinement failures', () => {
	it('retries a rejected partial refinement once with the full original region set, then regenerates', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5), region('r1', 0.5, 20)]))
		f.refinement.setMapping(scale(2))
		const first = f.requests()[0] as PartialContourRequest
		// A precision miss: the response is rejected whole.
		expect(f.refinement.receiveResponse(partialResponse(first, [region('r0', 0.4), region('r1', 0.1)]))).toBe('rejected')
		const retry = f.requests()[1] as PartialContourRequest
		expect(retry.type).toBe('contour.partial.request')
		expect(retry.payload).toMatchObject({ sequence: 2, baseSnapshotVersion: 1, regionIds: ['r0', 'r1'] })
		// A missing region result rejects the whole response too.
		expect(f.refinement.receiveResponse(partialResponse(retry, [region('r0', 0.1)]))).toBe('rejected')
		const regeneration = f.requests()[2] as FullContourRequest
		expect(regeneration.type).toBe('contour.full.request')
		expect(regeneration.payload.sequence).toBe(3)
		expect(f.refinement.state().work?.kind).toBe('full')
		// Nothing of the failed attempts was credited.
		expect(f.refinement.precision('w').status).toBe('pending')
		expect(f.refinement.receiveResponse(fullResponse(regeneration, [region('r0', 0.1), region('r1', 0.1, 20)]))).toBe('committed')
		expect(f.refinement.precision('w').status).toBe('precise')
	})

	it('stops after a failed regeneration: unavailable at that precision, not latched, no storm of requests', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.receiveResponse(partialResponse(f.requests()[0] as PartialContourRequest, [region('r0', 0.4)]))
		f.refinement.receiveResponse(partialResponse(f.requests()[1] as PartialContourRequest, [region('r0', 0.4)]))
		expect(f.requests()).toHaveLength(3)
		expect(f.refinement.receiveResponse(fullResponse(f.requests()[2] as FullContourRequest, [region('r0', 0.4)]))).toBe('rejected')
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'exhausted' })
		f.refinement.setMapping(scale(2.5))
		f.refinement.setMapping(scale(3))
		expect(f.requests()).toHaveLength(3)
		// A coarser need than the failed target is still asked for, and a new geometry revision starts over.
		f.refinement.setMapping(scale(1.5))
		expect(f.requests()).toHaveLength(4)
		f.refinement.setMapping(scale(2))
		f.refinement.acceptReport(report(2, [region('r0', 0.5)]))
		expect(f.requests().length).toBeGreaterThan(4)
		expect(f.refinement.state().latchedRevision).toBeUndefined()
	})

	it('rejects a response that echoes another base whole, and retries it like any other rejection', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0] as PartialContourRequest
		// A runtime echoes the base it was asked to refine; another one rejects the whole response.
		const wrongBase = partialResponse({ ...request, payload: { ...request.payload, baseSnapshotVersion: 9 } }, [region('r0', 0.1)])
		expect(f.refinement.receiveResponse(wrongBase)).toBe('rejected')
		expect(f.requests()).toHaveLength(2)
		expect((f.requests().at(-1) as PartialContourRequest).payload).toMatchObject({ baseSnapshotVersion: 1, regionIds: ['r0'] })
	})

	it('rolls a request back when it cannot leave, and asks again at the next change', () => {
		const f = fixture({ open: false })
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		expect(f.refinement.state().work).toBeUndefined()
		f.state.open = true
		f.refinement.setMapping(scale(2.5))
		expect(f.requests()).toHaveLength(1)
		expect(f.refinement.state().work?.sequence).toBeGreaterThan(1)
	})
})

describe('Non-recoverable refinement failure latch', () => {
	function latched() {
		const f = fixture()
		f.refinement.acceptReport(report(5, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0] as PartialContourRequest
		const reports: Array<FailureReportMessage | undefined> = []
		f.refinement.subscribeLatch(item => reports.push(item))
		const message = failureReport(request)
		expect(f.refinement.receiveFailureReport(message)).toBe('ended')
		return { ...f, request, reports, message }
	}

	it('ends the work without a response and starts no refinement or regeneration within the revision', () => {
		const f = latched()
		expect(f.reports).toEqual([f.message])
		expect(f.refinement.state()).toEqual({ latchedRevision: 5 })
		expect(f.requests()).toHaveLength(1)
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'latched' })
		// The ended work never commits.
		expect(f.refinement.receiveResponse(partialResponse(f.request, [region('r0', 0.1)]))).toBe('stale')
	})

	it('is not cleared by scale changes, and a cache that meets the tolerance still draws', () => {
		const f = latched()
		f.refinement.setMapping(scale(4))
		f.refinement.setMapping(scale(2.5))
		f.refinement.setMapping(scale(0.9))
		expect(f.refinement.precision('w').status).toBe('precise')
		f.refinement.setMapping(scale(3))
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'latched' })
		expect(f.requests()).toHaveLength(1)
		expect(f.reports).toHaveLength(1)
	})

	it('is cleared by a new geometry revision, which then refines again', () => {
		const f = latched()
		f.refinement.acceptReport(report(6, [region('r0', 0.5, 3)]))
		expect(f.reports.at(-1)).toBeUndefined()
		expect(f.refinement.state().latchedRevision).toBeUndefined()
		expect(f.requests()).toHaveLength(2)
	})

	it('is cleared by another context and by a new generation', () => {
		const first = latched()
		first.refinement.setContext({ ...context, variantId: 'light' })
		expect(first.reports.at(-1)).toBeUndefined()
		first.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		expect(first.requests()).toHaveLength(2)

		const second = latched()
		second.refinement.setContext({ ...context, runtimeGenerationId: 'g2' })
		expect(second.reports.at(-1)).toBeUndefined()
		second.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		expect(second.requests()).toHaveLength(2)
	})

	it('ignores a report that names other work, however well formed', () => {
		const f = fixture()
		f.refinement.acceptReport(report(5, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const request = f.requests()[0] as PartialContourRequest
		const outcomes = [
			failureReport(request, { sequence: request.payload.sequence + 1 }),
			{ ...failureReport(request), context: { ...failureReport(request).context, geometryRevision: 4 } },
			{ ...failureReport(request), context: { ...failureReport(request).context, widgetId: 'other' } },
			{ ...failureReport(request), context: { ...failureReport(request).context, variantId: 'light' } },
			{ ...failureReport(request), payload: { ...failureReport(request).payload, baseSnapshotVersion: 7 } },
		].map(message => f.refinement.receiveFailureReport(message as FailureReportMessage))
		expect(outcomes).toEqual(['stale', 'stale', 'stale', 'stale', 'stale'])
		expect(f.refinement.state().latchedRevision).toBeUndefined()
		expect(f.refinement.state().work?.sequence).toBe(request.payload.sequence)
	})

	it('ignores a report for work that was already superseded', () => {
		const f = fixture()
		f.refinement.acceptReport(report(5, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		const older = f.requests()[0] as PartialContourRequest
		f.refinement.setMapping(scale(4))
		expect(f.refinement.receiveFailureReport(failureReport(older))).toBe('stale')
		expect(f.refinement.state().latchedRevision).toBeUndefined()
		expect(f.refinement.state().work?.sequence).toBe(2)
	})

	it('latches a complete regeneration too, and still draws nothing finer', () => {
		const f = fixture()
		f.refinement.acceptReport(report(5, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.receiveResponse(partialResponse(f.requests()[0] as PartialContourRequest, [region('r0', 0.4)]))
		f.refinement.receiveResponse(partialResponse(f.requests()[1] as PartialContourRequest, [region('r0', 0.4)]))
		const full = f.requests()[2] as FullContourRequest
		expect(f.refinement.receiveFailureReport(failureReport(full))).toBe('ended')
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'latched' })
		expect(f.requests()).toHaveLength(3)
	})
})

describe('Verdict under the drawn mapping, latch persistence, frames, visibility', () => {
	it('judges the cache under the mapping the caller draws with, not the one it was last told', () => {
		const f = fixture()
		f.refinement.setMapping(scale(0.9))
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		expect(f.refinement.precision('w').status).toBe('precise')
		// The canvas already draws at scale 3: the same tick must not draw against the verdict of 0.9.
		expect(f.refinement.precision('w', { mapping: scale(3) }).status).toBe('pending')
		expect(f.refinement.precision('w', { mapping: undefined }).status).toBe('pending')
		f.refinement.setMapping(scale(3))
		expect(f.refinement.precision('w', { mapping: scale(0.9) }).status).toBe('precise')
	})

	it('keeps the latch of unchanged geometry across deselect and select, and ends it for changed geometry', () => {
		const f = fixture()
		f.refinement.acceptReport(report(5, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		f.refinement.receiveFailureReport(failureReport(f.requests()[0] as PartialContourRequest))
		const reports: Array<FailureReportMessage | undefined> = []
		f.refinement.subscribeLatch(item => reports.push(item))
		f.refinement.setDemand(undefined)
		f.refinement.setDemand('w')
		expect(reports).toEqual([])
		// The reopened stream reports its baseline under a new revision, with the same geometry.
		f.refinement.acceptReport(report(9, [region('r0', 0.5)]))
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'latched' })
		expect(f.refinement.state().latchedRevision).toBe(9)
		expect(f.requests()).toHaveLength(1)
		// Other geometry is a geometry change.
		f.refinement.acceptReport(report(10, [region('r0', 0.5, 3)]))
		expect(reports.at(-1)).toBeUndefined()
		expect(f.refinement.state().latchedRevision).toBeUndefined()
		expect(f.requests()).toHaveLength(2)
	})

	it('ignores float jitter of the mapping but not a larger amplification', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.2)]))
		f.refinement.setMapping(scale(2))
		let calls = 0
		f.refinement.subscribe(() => { calls++ })
		// Jitter that does not amplify more is noise; one that does is kept, so a verdict never rests on less.
		f.refinement.setMapping(scale(2 - 1e-13))
		expect(calls).toBe(0)
		f.refinement.setMapping(scale(2 + 1e-13))
		expect(calls).toBe(1)
		f.refinement.setMapping(scale(2 - 1e-13))
		expect(calls).toBe(1)
		f.refinement.setMapping(scale(2.0001))
		expect(calls).toBe(2)
	})

	it('asks for finer contours only after the mapping held still for a frame, and retires work at once', () => {
		const frames: Array<() => void> = []
		const sent: Array<FullContourRequest | PartialContourRequest | ContourCancel> = []
		const refinement = new ContourRefinement({
			send: (message) => { sent.push(message); return true },
			requestFrame: callback => frames.push(callback),
			cancelFrame: () => {},
		})
		refinement.setContext(context)
		refinement.setDemand('w')
		refinement.acceptReport(report(1, [region('r0', 0.5)]))
		const runFrame = () => frames.splice(0).forEach(frame => frame())
		for (const value of [1.2, 1.5, 1.8, 2]) {
			refinement.setMapping(scale(value))
			runFrame()
		}
		expect(sent).toEqual([])
		// A quiet frame later the finest need is asked for, once.
		runFrame()
		runFrame()
		expect(sent.map(message => message.type)).toEqual(['contour.partial.request'])
		refinement.setMapping(scale(0.9))
		expect(sent.map(message => message.type)).toEqual(['contour.partial.request', 'contour.cancel'])
		expect(refinement.precision('w').status).toBe('precise')
	})

	it('asks for no contour work while the Widget is offscreen or hidden, and retires what is pending', () => {
		const f = fixture()
		f.refinement.setVisible(false)
		f.refinement.acceptReport(report(1, [region('r0', 0.5)]))
		f.refinement.setMapping(scale(2))
		expect(f.sent).toEqual([])
		f.refinement.setVisible(true)
		expect(f.requests()).toHaveLength(1)
		f.refinement.setVisible(false)
		expect(f.cancels()).toHaveLength(1)
		expect(f.refinement.state().work).toBeUndefined()
	})

	it('rejects a complete regeneration whose region IDs changed, and stops asking at that precision', () => {
		const f = fixture()
		f.refinement.acceptReport(report(1, [region('r0', 0.5), region('r1', 0.5, 20)]))
		f.refinement.setMapping(scale(2))
		f.refinement.receiveResponse(partialResponse(f.requests()[0] as PartialContourRequest, [region('r0', 0.4), region('r1', 0.4)]))
		f.refinement.receiveResponse(partialResponse(f.requests()[1] as PartialContourRequest, [region('r0', 0.4), region('r1', 0.4)]))
		const full = f.requests()[2] as FullContourRequest
		expect(full.type).toBe('contour.full.request')
		// Fine enough, but one region was renamed: the runtime must have established a new revision instead.
		expect(f.refinement.receiveResponse(fullResponse(full, [region('r0', 0.1), region('r9', 0.1, 20)]))).toBe('rejected')
		expect(f.refinement.precision('w')).toMatchObject({ status: 'unavailable', reason: 'exhausted' })
		expect(f.requests()).toHaveLength(3)
	})
})
