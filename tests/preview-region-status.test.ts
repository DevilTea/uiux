import { describe, expect, it } from 'vitest'

import { declaredRuntimeFeatures } from '../src/preview/declared-features'
import { GeometryStreamCoordinator } from '../src/preview/geometry-streams'
import { RuntimeGeometryProducer, type WidgetGeometry } from '../src/preview/geometry-producer'
import {
	REGION_STATUS_GEOMETRY_FEATURE,
	validateGeometryMessage,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
} from '../src/preview/protocol/schema'

/**
 * `regionStatus` of `geometry.acquire.response` and its capability `geometry.region-status` (issue #106;
 * Clause 01a11a59-dbda-79e5-9337-307bb9c1798b). The runtime's DOM classification is tested in
 * `preview-dom-geometry.test.ts`, the Workbench in `region-status-browser.test.ts`.
 */

const viewId = '11111111-1111-4111-8111-111111111111'
const context = { previewSessionId: 's', runtimeGenerationId: 'g', viewId }
const region = {
	regionId: 'r0',
	maxError: 0,
	contour: { commands: [
		{ op: 'moveTo', x: 0, y: 0 },
		{ op: 'lineTo', x: 10, y: 0 },
		{ op: 'lineTo', x: 10, y: 10 },
		{ op: 'lineTo', x: 0, y: 10 },
		{ op: 'close' },
	] as const },
}
const rect = { x: 0, y: 0, width: 10, height: 10 }

function response(payload: Record<string, unknown>) {
	return { type: 'geometry.acquire.response', context: { ...context, navigationRequestId: 'n', widgetId: 'w', geometryRevision: 1 }, payload }
}

describe('the geometry.region-status feature', () => {
	it('is named by the Contract and declared by a Workbench Preview only', () => {
		expect(REGION_STATUS_GEOMETRY_FEATURE).toBe('geometry.region-status')
		expect(declaredRuntimeFeatures({ harness: false, version: false })).toContain(REGION_STATUS_GEOMETRY_FEATURE)
		expect(declaredRuntimeFeatures({ harness: true, version: false })).not.toContain(REGION_STATUS_GEOMETRY_FEATURE)
		expect(declaredRuntimeFeatures({ harness: false, version: true })).not.toContain(REGION_STATUS_GEOMETRY_FEATURE)
	})
})

describe('the decoder of regionStatus', () => {
	it('accepts translucent with regions, unavailable with none, and a report without a status', () => {
		expect(validateGeometryMessage(response({ rect, regions: [region], regionStatus: 'translucent' })).ok).toBe(true)
		expect(validateGeometryMessage(response({ rect, regions: [], regionStatus: 'unavailable' })).ok).toBe(true)
		expect(validateGeometryMessage(response({ rect, regions: [] })).ok).toBe(true)
		expect(validateGeometryMessage(response({ rect, regions: [region] })).ok).toBe(true)
	})

	it('rejects a status that does not go with its regions, and a value that is not one of the two', () => {
		expect(validateGeometryMessage(response({ rect, regions: [], regionStatus: 'translucent' })).ok).toBe(false)
		expect(validateGeometryMessage(response({ rect, regions: [region], regionStatus: 'unavailable' })).ok).toBe(false)
		expect(validateGeometryMessage(response({ rect, regions: [region], regionStatus: 'opaque' })).ok).toBe(false)
		expect(validateGeometryMessage(response({ rect, regions: [], regionStatus: null })).ok).toBe(false)
	})

	it('carries a status on no contour response', () => {
		const result = validateGeometryMessage({ type: 'contour.full.response', context: { ...context, widgetId: 'w', geometryRevision: 1 }, payload: { sequence: 1, regions: [region], regionStatus: 'translucent' } })
		// Unknown additive members of a contour response are ignored: the status is never read from it.
		expect(result.ok).toBe(true)
	})
})

function producerFixture(declares: boolean) {
	const frames: Array<() => void> = []
	const sent: GeometryAcquireResponse[] = []
	let current: WidgetGeometry = { rect, regions: [region], regionStatus: 'translucent' }
	const producer = new RuntimeGeometryProducer({
		send: message => sent.push(message),
		measurer: { beginPass: () => {}, measure: () => current, endPass: () => {} },
		requestFrame: (callback) => { frames.push(callback); return frames.length },
		cancelFrame: () => {},
		...(declares ? { regionStatus: true } : {}),
	})
	producer.setContext({ viewId })
	const open: GeometryAcquireRequest = { type: 'geometry.acquire.request', context: { ...context, navigationRequestId: 'n1', widgetId: 'w' }, payload: {} }
	producer.receive(open)
	const run = () => { for (const frame of frames.splice(0)) frame() }
	return { sent, run, producer, set: (next: WidgetGeometry) => { current = next } }
}

describe('the runtime geometry producer and regionStatus', () => {
	it('puts the status in the payload of a runtime that declared the feature, and in no other', () => {
		const declared = producerFixture(true)
		declared.run()
		expect(declared.sent[0]!.payload).toEqual({ rect, regions: [region], regionStatus: 'translucent' })
		const silent = producerFixture(false)
		silent.run()
		expect(silent.sent[0]!.payload).toEqual({ rect, regions: [region] })
		expect(Object.hasOwn(silent.sent[0]!.payload, 'regionStatus')).toBe(false)
	})

	it('reports a change of the status alone as a new revision, and nothing while it holds', () => {
		const f = producerFixture(true)
		f.run()
		f.producer.invalidate()
		f.run()
		expect(f.sent).toHaveLength(1)
		// The overlay goes away without the Widget moving or resizing: the same regions, no status, an advanced revision.
		f.set({ rect, regions: [region] })
		f.producer.invalidate()
		f.run()
		expect(f.sent).toHaveLength(2)
		expect(f.sent[1]!.context.geometryRevision).toBe(2)
		expect(Object.hasOwn(f.sent[1]!.payload, 'regionStatus')).toBe(false)
		f.set({ rect, regions: [], regionStatus: 'unavailable' })
		f.producer.invalidate()
		f.run()
		expect(f.sent[2]!.payload).toEqual({ rect, regions: [], regionStatus: 'unavailable' })
		expect(f.sent[2]!.context.geometryRevision).toBe(3)
	})

	it('does not report a status change that the runtime does not declare', () => {
		const f = producerFixture(false)
		f.run()
		f.set({ rect, regions: [region] })
		f.producer.invalidate()
		f.run()
		expect(f.sent).toHaveLength(1)
	})
})

describe('the Workbench coordinator and regionStatus', () => {
	function coordinator(supported: boolean) {
		const streams = new GeometryStreamCoordinator({ send: () => {}, mintId: () => 'id-1' })
		streams.setContext(context)
		streams.setMultiTarget(true)
		streams.setRegionStatusSupported(supported)
		streams.setReady(true)
		streams.setDemand([{ consumerId: 'selection', widgetId: 'w', tier: 'highlight' }])
		return streams
	}
	const reported = (payload: Record<string, unknown>) => ({ type: 'geometry.acquire.response', context: { ...context, navigationRequestId: 'id-1', widgetId: 'w', geometryRevision: 1 }, payload }) as GeometryAcquireResponse

	it('keeps the status of a runtime that declared the feature', () => {
		const streams = coordinator(true)
		expect(streams.accept(reported({ rect, regions: [region], regionStatus: 'translucent' }))).toBe('accepted')
		expect(streams.report('w')?.regionStatus).toBe('translucent')
	})

	it('reads no status from a runtime that did not declare it: an empty set stays "no visible part"', () => {
		const streams = coordinator(false)
		expect(streams.accept(reported({ rect, regions: [], regionStatus: 'unavailable' }))).toBe('accepted')
		expect(streams.report('w')).toMatchObject({ regions: [] })
		expect(streams.report('w')).not.toHaveProperty('regionStatus')
	})

	it('holds the status of a revision with its rect and regions, and drops it with them', () => {
		const streams = coordinator(true)
		streams.accept(reported({ rect, regions: [region], regionStatus: 'translucent' }))
		const next = { ...reported({ rect, regions: [region] }), context: { ...context, navigationRequestId: 'id-1', widgetId: 'w', geometryRevision: 2 } } as GeometryAcquireResponse
		streams.accept(next)
		expect(streams.report('w')).toMatchObject({ geometryRevision: 2 })
		expect(streams.report('w')).not.toHaveProperty('regionStatus')
		streams.setDemand([])
		expect(streams.report('w')).toBeUndefined()
	})
})
