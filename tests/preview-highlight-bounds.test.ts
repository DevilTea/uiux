import { describe, expect, it } from 'vitest'

import { aggregateHighlightBounds, contourBounds } from '../src/preview/highlight-bounds'
import type { Contour } from '../src/preview/protocol/schema'

describe('Preview highlight aggregate bounds', () => {
	it('computes line contour bounds including the implicit close edge', () => {
		const contour: Contour = { commands: [
			{ op: 'moveTo', x: 10, y: 20 },
			{ op: 'lineTo', x: 30, y: 15 },
			{ op: 'lineTo', x: 25, y: 50 },
			{ op: 'close' },
		] }
		expect(contourBounds(contour)).toEqual({ left: 10, top: 15, right: 30, bottom: 50 })
	})

	it('uses true cubic extrema instead of control-point hull bounds', () => {
		const contour: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 100, c2x: 10, c2y: 100, x: 10, y: 0 },
			{ op: 'lineTo', x: 0, y: 0 },
			{ op: 'close' },
		] }
		const bounds = contourBounds(contour)!
		expect(bounds.left).toBe(0)
		expect(bounds.right).toBe(10)
		expect(bounds.top).toBe(0)
		expect(bounds.bottom).toBeCloseTo(75, 12)
		expect(bounds.bottom).toBeLessThan(100)
	})

	it('finds both extrema of an S-shaped cubic when they fall inside the segment', () => {
		const contour: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 100, c1y: 100, c2x: -100, c2y: -100, x: 0, y: 0 },
			{ op: 'lineTo', x: 1, y: 0 },
			{ op: 'close' },
		] }
		const bounds = contourBounds(contour)!
		expect(bounds.left).toBeLessThan(-28)
		expect(bounds.right).toBeGreaterThan(28)
		expect(bounds.top).toBeLessThan(-28)
		expect(bounds.bottom).toBeGreaterThan(28)
	})

	it('aggregates all disconnected visible-region bounds independent of region order', () => {
		const a: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 }, { op: 'lineTo', x: 10, y: 0 },
			{ op: 'lineTo', x: 10, y: 10 }, { op: 'close' },
		] }
		const b: Contour = { commands: [
			{ op: 'moveTo', x: 100, y: -20 }, { op: 'lineTo', x: 120, y: -20 },
			{ op: 'lineTo', x: 120, y: 5 }, { op: 'close' },
		] }
		const forward = aggregateHighlightBounds([{ regionId: 'a', contour: a }, { regionId: 'b', contour: b }])
		const reverse = aggregateHighlightBounds([{ regionId: 'b', contour: b }, { regionId: 'a', contour: a }])
		expect(forward).toEqual({ left: 0, top: -20, right: 120, bottom: 10 })
		expect(reverse).toEqual(forward)
	})

	it('returns no aggregate bounds for an empty visible-region set', () => {
		expect(aggregateHighlightBounds([])).toBeUndefined()
	})

	it('remains finite and finds extrema for huge finite cubic coordinates', () => {
		const contour: Contour = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'cubicBezierTo', c1x: 0, c1y: 1e308, c2x: 1e307, c2y: 1e308, x: 1e307, y: 0 },
			{ op: 'lineTo', x: 0, y: 0 },
			{ op: 'close' },
		] }
		const bounds = contourBounds(contour)!
		expect(Number.isFinite(bounds.bottom)).toBe(true)
		expect(bounds.bottom).toBeGreaterThan(7.4e307)
		expect(bounds.bottom).toBeLessThan(7.6e307)
	})

	it('fails closed instead of repairing malformed/non-finite contour input', () => {
		const missingClose = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'lineTo', x: 1, y: 1 },
		] } as Contour
		const noDrawingSegment = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'close' },
		] } as Contour
		const nonFinite = { commands: [
			{ op: 'moveTo', x: 0, y: 0 },
			{ op: 'lineTo', x: Number.POSITIVE_INFINITY, y: 1 },
			{ op: 'close' },
		] } as Contour
		expect(contourBounds(missingClose)).toBeUndefined()
		expect(contourBounds(noDrawingSegment)).toBeUndefined()
		expect(contourBounds(nonFinite)).toBeUndefined()
		expect(aggregateHighlightBounds([{ regionId: 'bad', contour: nonFinite }])).toBeUndefined()
	})
})
