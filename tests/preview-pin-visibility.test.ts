import { describe, expect, it } from 'vitest'

import type { GeometryReport } from '../src/preview/geometry-streams'
import type { AffineOuterMapping } from '../src/preview/outer-precision'
import {
	aggregateEdgeIndicators,
	clusterPins,
	isPointReliablyVisible,
	PinPlacementEngine,
	pinGeometryDemand,
	resolvePinPoint,
	type PinPlacementInputs,
	type PinThreadInput,
} from '../src/preview/pin-visibility'
import type { VisibleRegion } from '../src/preview/protocol/schema'
import { approximateRoundedRectContour } from '../src/preview/rounded-contour'

const viewId = '11111111-1111-4111-8111-111111111111'
const half: AffineOuterMapping = { kind: 'affine', a: 0.5, b: 0, c: 0, d: 0.5, e: 100, f: 50 }

function box(x: number, y: number, width: number, height: number, maxError = 0, regionId = 'r0'): VisibleRegion {
	return { regionId, maxError, contour: { commands: [
		{ op: 'moveTo', x, y }, { op: 'lineTo', x: x + width, y }, { op: 'lineTo', x: x + width, y: y + height }, { op: 'lineTo', x, y: y + height }, { op: 'close' },
	] } }
}

function thread(threadId: string, widgetId: string, extra: Partial<PinThreadInput> = {}): PinThreadInput {
	return { threadId, anchor: { viewId, widgetId }, status: 'open', ...extra }
}

function inputs(reports: Record<string, GeometryReport>, extra: Partial<PinPlacementInputs> = {}): PinPlacementInputs {
	return {
		viewId,
		viewport: { width: 400, height: 300 },
		mapping: half,
		live: true,
		multiTarget: true,
		report: widgetId => reports[widgetId],
		isTracked: widgetId => widgetId in reports || widgetId === 'pending',
		...extra,
	}
}

function geometry(widgetId: string, rect: GeometryReport['rect'], regions: VisibleRegion[], geometryRevision = 1): GeometryReport {
	return { widgetId, navigationRequestId: `n-${widgetId}`, geometryRevision, rect, regions }
}

describe('Pin point resolution', () => {
	it('uses displayHint first, then the session point, then the default top-right inset point', () => {
		const rect = { x: 10, y: 20, width: 200, height: 100 }
		expect(resolvePinPoint(thread('t', 'w', { displayHint: { pin: { x: 0.25, y: 0.5 } }, sessionPoint: { x: 1, y: 1 } }), rect)).toEqual({ point: { x: 60, y: 70 }, source: 'hint' })
		expect(resolvePinPoint(thread('t', 'w', { sessionPoint: { x: 1, y: 0 } }), rect)).toEqual({ point: { x: 210, y: 20 }, source: 'session' })
		expect(resolvePinPoint(thread('t', 'w'), rect)).toEqual({ point: { x: 206, y: 24 }, source: 'default' })
		expect(resolvePinPoint(thread('t', 'w'), rect, 2)).toEqual({ point: { x: 166, y: 24 }, source: 'default' })
		expect(resolvePinPoint(thread('t', 'root'), rect, 1)).toEqual({ point: { x: 36, y: 16 }, source: 'default' })
		// An out-of-range hint is ignored rather than clamped.
		expect(resolvePinPoint(thread('t', 'w', { displayHint: { pin: { x: 1.5, y: 0.5 } } }), rect).source).toBe('default')
	})
})

describe('Per-pin visibility (decision 7)', () => {
	it('draws a pin only farther than maxError inside a visible region, never clamped', () => {
		const regions = [box(0, 0, 100, 100, 0.5)]
		expect(isPointReliablyVisible({ x: 50, y: 50 }, regions)).toBe(true)
		expect(isPointReliablyVisible({ x: 0.6, y: 50 }, regions)).toBe(true)
		expect(isPointReliablyVisible({ x: 0.5, y: 50 }, regions)).toBe(false)
		expect(isPointReliablyVisible({ x: 0.2, y: 50 }, regions)).toBe(false)
		expect(isPointReliablyVisible({ x: -1, y: 50 }, regions)).toBe(false)
		// Exact regions: a point on the boundary is not reliably visible.
		expect(isPointReliablyVisible({ x: 0, y: 50 }, [box(0, 0, 100, 100)])).toBe(false)
		// Any of several disconnected regions.
		expect(isPointReliablyVisible({ x: 150, y: 10 }, [box(0, 0, 100, 100), box(140, 0, 20, 20)])).toBe(true)
	})

	it('handles cubic contours conservatively', () => {
		const rounded = approximateRoundedRectContour({ x: 0, y: 0, width: 100, height: 100 }, {
			topLeft: { rx: 20, ry: 20 }, topRight: { rx: 20, ry: 20 }, bottomRight: { rx: 20, ry: 20 }, bottomLeft: { rx: 20, ry: 20 },
		}, 0.25)!
		const region: VisibleRegion = { regionId: 'r', contour: rounded.contour, maxError: rounded.maxError }
		expect(isPointReliablyVisible({ x: 50, y: 50 }, [region])).toBe(true)
		// The square corner lies outside the rounded corner.
		expect(isPointReliablyVisible({ x: 1, y: 1 }, [region])).toBe(false)
		const curved: VisibleRegion = { regionId: 'c', maxError: 0, contour: { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 50, c1y: -40, c2x: 100, c2y: -40, x: 100, y: 0 },
			{ op: 'lineTo', x: 100, y: 50 },
			{ op: 'lineTo', x: 0, y: 50 },
			{ op: 'close' },
		] } }
		expect(isPointReliablyVisible({ x: 50, y: -20 }, [curved])).toBe(true)
		expect(isPointReliablyVisible({ x: 50, y: -40 }, [curved])).toBe(false)
	})

	it('classifies every row of the decision 7 table', () => {
		const engine = new PinPlacementEngine()
		const reports = {
			shown: geometry('shown', { x: 0, y: 0, width: 200, height: 100 }, [box(0, 0, 200, 100)]),
			hidden: geometry('hidden', { x: 0, y: 0, width: 0, height: 0 }, []),
			above: geometry('above', { x: 20, y: -500, width: 100, height: 40 }, []),
			below: geometry('below', { x: 20, y: 900, width: 100, height: 40 }, []),
			clipped: geometry('clipped', { x: 0, y: 0, width: 200, height: 100 }, [box(0, 50, 200, 50)]),
			occluded: geometry('occluded', { x: 0, y: 0, width: 200, height: 100 }, []),
		}
		const threads = [
			thread('t-shown', 'shown'),
			thread('t-hidden', 'hidden'),
			thread('t-above', 'above'),
			thread('t-below', 'below'),
			thread('t-clipped', 'clipped'),
			thread('t-occluded', 'occluded'),
			thread('t-invalid', 'gone', { anchorValid: false }),
			thread('t-variant', 'shown', { variantNames: ['compact'] }),
			thread('t-other-view', 'shown', { anchor: { viewId: '22222222-2222-4222-8222-222222222222', widgetId: 'shown' } }),
			thread('t-cap', 'untracked'),
			thread('t-pending', 'pending'),
		]
		const placements = Object.fromEntries(engine.place(threads, inputs(reports)).map(p => [p.threadId, p]))
		expect(placements['t-shown']).toMatchObject({ state: 'visible', point: { x: 100 + 196 * 0.5, y: 50 + 4 * 0.5 }, pointSource: 'default', geometryRevision: 1 })
		expect(placements['t-hidden']).toMatchObject({ state: 'hidden', reason: 'not-rendered' })
		expect(placements['t-above']).toMatchObject({ state: 'offscreen', edge: { side: 'top', scope: 'frame', point: { x: 100 + 70 * 0.5, y: 50 } } })
		expect(placements['t-below']).toMatchObject({ state: 'offscreen', edge: { side: 'bottom', point: { y: 50 + 300 * 0.5 } } })
		expect(placements['t-clipped']).toMatchObject({ state: 'hidden', reason: 'point-not-visible' })
		expect(placements['t-clipped']!.point).toBeUndefined()
		expect(placements['t-occluded']).toMatchObject({ state: 'hidden', reason: 'no-visible-region' })
		expect(placements['t-invalid']).toMatchObject({ state: 'invalid', reason: 'missing-widget' })
		expect(placements['t-variant']).toMatchObject({ state: 'hidden', reason: 'other-variant' })
		expect(placements['t-other-view']).toMatchObject({ state: 'hidden', reason: 'other-view' })
		expect(placements['t-cap']).toMatchObject({ state: 'hidden', reason: 'over-cap' })
		expect(placements['t-pending']).toMatchObject({ state: 'hidden', reason: 'awaiting-geometry' })

		// A non-affine or unmeasurable mapping hides every pin.
		const unmapped = engine.place(threads.slice(0, 1), inputs(reports, { mapping: undefined }))
		expect(unmapped[0]).toMatchObject({ state: 'hidden', reason: 'mapping-unavailable' })
		// Reconnecting hides every pin.
		expect(engine.place(threads.slice(0, 1), inputs(reports, { live: false }))[0]).toMatchObject({ state: 'hidden', reason: 'reconnecting' })
		// Without geometry.multi-target the untracked thread is a single-stream fallback row.
		expect(engine.place([thread('t-cap', 'untracked')], inputs(reports, { multiTarget: false }))[0]).toMatchObject({ reason: 'single-stream' })
		// A Variant-scoped thread is shown in its own Variant.
		expect(engine.place([thread('t-variant', 'shown', { variantNames: ['compact'] })], inputs(reports, { variantId: 'compact' }))[0]!.state).toBe('visible')
	})

	it('turns a mapped point outside the visible stage into a stage edge indicator', () => {
		const engine = new PinPlacementEngine()
		const reports = { shown: geometry('shown', { x: 0, y: 0, width: 200, height: 100 }, [box(0, 0, 200, 100)]) }
		const [placement] = engine.place([thread('t', 'shown')], inputs(reports, { stage: { left: 0, top: 0, right: 150, bottom: 400 } }))
		expect(placement).toMatchObject({ state: 'offscreen', edge: { side: 'right', scope: 'stage', point: { x: 150, y: 52 } } })
	})

	it('fans default pins on one Widget, clusters close pins and aggregates edge indicators', () => {
		const engine = new PinPlacementEngine()
		const reports = {
			w: geometry('w', { x: 0, y: 0, width: 300, height: 100 }, [box(0, 0, 300, 100)]),
			up: geometry('up', { x: 0, y: -200, width: 10, height: 10 }, []),
		}
		const placements = engine.place([thread('a', 'w'), thread('b', 'w'), thread('c', 'w', { displayHint: { pin: { x: 0.1, y: 0.5 } } }), thread('d', 'up'), thread('e', 'up')], inputs(reports))
		expect(placements.slice(0, 2).map(p => p.innerPoint)).toEqual([{ x: 296, y: 4 }, { x: 276, y: 4 }])
		const clusters = clusterPins(placements)
		expect(clusters.map(cluster => cluster.threadIds)).toEqual([['a', 'b'], ['c']])
		expect(aggregateEdgeIndicators(placements)).toEqual([{ side: 'top', scope: 'frame', point: { x: 102.5, y: 50 }, threadIds: ['d', 'e'] }])
	})

	it('re-tests containment only when the Widget revision or the pin point changes', () => {
		const engine = new PinPlacementEngine()
		let tests = 0
		const regions = new Proxy([box(0, 0, 200, 100)], { get(target, key, receiver) { if (key === 'some') tests++; return Reflect.get(target, key, receiver) } })
		let report = geometry('w', { x: 0, y: 0, width: 200, height: 100 }, regions, 1)
		const context = inputs({}, { report: () => report, isTracked: () => true })
		engine.place([thread('t', 'w')], context)
		engine.place([thread('t', 'w')], { ...context, mapping: { ...half, e: 300 } })
		expect(tests).toBe(1)
		report = { ...report, geometryRevision: 2 }
		engine.place([thread('t', 'w')], context)
		expect(tests).toBe(2)
	})

	it('derives the pin demand of in-scope threads only, ordered data for the cap', () => {
		const demand = pinGeometryDemand([
			thread('a', 'w1', { status: 'resolved', latestActivity: '2026-10-01T00:00:00Z' }),
			thread('b', 'w2', { anchorValid: false }),
			thread('c', 'w3', { variantNames: ['compact'] }),
		], { viewId })
		expect(demand).toEqual([{ consumerId: 'pin:a', widgetId: 'w1', tier: 'pin', status: 'resolved', latestActivity: Date.parse('2026-10-01T00:00:00Z') }])
	})
})
