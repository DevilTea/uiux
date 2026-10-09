import { describe, expect, it } from 'vitest'

import { deriveOuterMapping } from '../src/preview/derived-outer-mapping'
import { mapPointAffine } from '../src/preview/outer-precision'
import type { RenderedContentBoxQuad } from '../src/preview/rendered-content-quad'

function quad(points: [[number, number], [number, number], [number, number], [number, number]]): RenderedContentBoxQuad {
	const [p1, p2, p3, p4] = points
	return {
		p1: { x: p1[0], y: p1[1] },
		p2: { x: p2[0], y: p2[1] },
		p3: { x: p3[0], y: p3[1] },
		p4: { x: p4[0], y: p4[1] },
	}
}

describe('rendered content quad -> outer mapping', () => {
	it('derives identity + translation from an axis-aligned rendered content quad', () => {
		const result = deriveOuterMapping({ width: 200, height: 100 }, quad([
			[30, 40], [230, 40], [230, 140], [30, 140],
		]))
		expect(result).toEqual({
			status: 'affine',
			mapping: { kind: 'affine', a: 1, b: 0, c: 0, d: 1, e: 30, f: 40 },
		})
	})

	it('derives rotation, skew, nonuniform scale, and translation from the actual rendered parallelogram', () => {
		const result = deriveOuterMapping({ width: 100, height: 50 }, quad([
			[10, 20],
			[210, 120],
			[185, 270],
			[-15, 170],
		]))
		expect(result.status).toBe('affine')
		if (result.status !== 'affine') return
		expect(result.mapping).toEqual({ kind: 'affine', a: 2, b: 1, c: -0.5, d: 3, e: 10, f: 20 })
		expect(mapPointAffine({ x: 100, y: 50 }, result.mapping)).toEqual({ x: 185, y: 270 })
	})

	it('classifies a perspective/non-parallelogram quad as non-affine instead of fitting an affine approximation', () => {
		const source = quad([[0, 0], [100, 5], [90, 90], [5, 100]])
		const result = deriveOuterMapping({ width: 100, height: 100 }, source)
		expect(result).toEqual({ status: 'non-affine', quad: source })
	})

	it('tolerates only scale-relative floating roundoff in the fourth corner, not a CSS-pixel geometric epsilon', () => {
		const base = 1e12
		const width = 800
		const height = 600
		const p1: [number, number] = [base, -base]
		const p2: [number, number] = [base + width * 1.25, -base + width * 0.2]
		const p4: [number, number] = [base + height * -0.1, -base + height * 0.75]
		const exactP3: [number, number] = [p2[0] + p4[0] - p1[0], p2[1] + p4[1] - p1[1]]
		const representableNoise = Number.EPSILON * base
		expect(deriveOuterMapping({ width, height }, quad([p1, p2, [exactP3[0] + representableNoise, exactP3[1]], p4])).status).toBe('affine')
		expect(deriveOuterMapping({ width, height }, quad([p1, p2, [exactP3[0] + 1, exactP3[1]], p4])).status).toBe('non-affine')
	})

	it('uses stable difference ratios for huge finite coordinates when the transform coefficients remain finite', () => {
		const result = deriveOuterMapping({ width: 1e308, height: 1e308 }, quad([
			[-1e308, -1e308],
			[1e308, -1e308],
			[1e308, 1e308],
			[-1e308, 1e308],
		]))
		expect(result.status).toBe('affine')
		if (result.status !== 'affine') return
		expect(result.mapping.a).toBeCloseTo(2, 12)
		expect(result.mapping.d).toBeCloseTo(2, 12)
		expect(result.mapping.b).toBe(0)
		expect(result.mapping.c).toBe(0)
	})

	it('rejects zero/non-finite viewport dimensions because a full 2D mapping cannot be recovered', () => {
		const source = quad([[0, 0], [100, 0], [100, 100], [0, 100]])
		for (const viewport of [
			{ width: 0, height: 100 },
			{ width: 100, height: 0 },
			{ width: Number.POSITIVE_INFINITY, height: 100 },
			{ width: Number.NaN, height: 100 },
		]) expect(deriveOuterMapping(viewport, source)).toEqual({ status: 'unavailable', reason: 'invalid-viewport' })
	})

	it('rejects non-finite quad geometry', () => {
		const source = quad([[0, 0], [100, 0], [Number.POSITIVE_INFINITY, 100], [0, 100]])
		expect(deriveOuterMapping({ width: 100, height: 100 }, source)).toEqual({ status: 'unavailable', reason: 'invalid-quad' })
	})

	it('defensively owns non-affine quad evidence', () => {
		const source = quad([[0, 0], [100, 5], [90, 90], [5, 100]])
		const result = deriveOuterMapping({ width: 100, height: 100 }, source)
		expect(result.status).toBe('non-affine')
		// The quad type is readonly; the test mutates the caller's evidence on purpose to prove the result owns a copy.
		const callerPoint = source.p1 as { x: number }
		callerPoint.x = 999
		if (result.status === 'non-affine') expect(result.quad.p1.x).toBe(0)
	})
})
