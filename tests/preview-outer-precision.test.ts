import { describe, expect, it } from 'vitest'

import {
	affineAmplificationUpperBound,
	evaluateRegionPrecision,
	evaluateSnapshotPrecision,
	mapContourAffine,
	mapPointAffine,
	mapVisibleRegionAffine,
	type AffineOuterMapping,
} from '../src/preview/outer-precision'
import type { Contour, VisibleRegion } from '../src/preview/protocol/schema'

const square: Contour = { commands: [
	{ op: 'moveTo', x: 0, y: 0 },
	{ op: 'lineTo', x: 10, y: 0 },
	{ op: 'cubicBezierTo', c1x: 12, c1y: 0, c2x: 12, c2y: 10, x: 10, y: 10 },
	{ op: 'lineTo', x: 0, y: 10 },
	{ op: 'close' },
] }

function affine(a: number, b: number, c: number, d: number, e = 0, f = 0): AffineOuterMapping {
	return { kind: 'affine', a, b, c, d, e, f }
}

function region(regionId: string, maxError: number): VisibleRegion {
	return { regionId, contour: square, maxError }
}

describe('Preview outer mapping precision', () => {
	it('keeps identity mapping precision effectively unchanged and ignores translation for error amplification', () => {
		const identity = affineAmplificationUpperBound(affine(1, 0, 0, 1))!
		const translated = affineAmplificationUpperBound(affine(1, 0, 0, 1, 500, -300))!
		expect(identity).toBeGreaterThanOrEqual(1)
		expect(identity).toBeLessThan(1 + 1e-12)
		expect(translated).toBe(identity)
		expect(evaluateRegionPrecision(0.49, affine(1, 0, 0, 1, 500, -300))).toMatchObject({ status: 'eligible' })
	})

	it('handles rotation and reflection without inventing scale amplification', () => {
		const angle = Math.PI / 4
		const rotation = affine(Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle))
		const reflection = affine(-1, 0, 0, 1)
		for (const mapping of [rotation, reflection]) {
			const bound = affineAmplificationUpperBound(mapping)!
			expect(bound).toBeGreaterThanOrEqual(1)
			expect(bound).toBeLessThan(1 + 1e-12)
		}
	})

	it('handles extremely large and subnormal finite affine coefficients without avoidable intermediate overflow', () => {
		const huge = affineAmplificationUpperBound(affine(1e308, 0, 0, 1e308))
		expect(huge).toBeDefined()
		expect(huge!).toBeGreaterThanOrEqual(1e308)
		expect(Number.isFinite(huge)).toBe(true)
		expect(evaluateRegionPrecision(1e-308, affine(1e308, 0, 0, 1e308))).not.toMatchObject({ status: 'precision-unavailable' })

		const tiny = affineAmplificationUpperBound(affine(1e-320, 0, 0, 1e-320))
		expect(tiny).toBeGreaterThanOrEqual(1e-320)
		expect(Number.isFinite(tiny)).toBe(true)
	})

	it('uses the maximum singular amplification for nonuniform scale and skew families', () => {
		const cases = [
			affine(4, 0, 0, 0.5),
			affine(1, 0, 3, 1),
			affine(0.001, 0, 0, 7),
			affine(2, -1.5, 0.75, 3),
		]
		for (const mapping of cases) {
			const production = affineAmplificationUpperBound(mapping)!
			const oracle = spectralNormOracle(mapping)
			expect(production).toBeGreaterThanOrEqual(oracle * (1 - 1e-13))
			expect(production / oracle).toBeLessThan(1 + 1e-10)
		}
	})

	it('requires refinement only for regions whose final-display bound exceeds 0.5 CSS px', () => {
		const result = evaluateSnapshotPrecision([
			region('r1', 0.2),
			region('r2', 0.3),
		], affine(2, 0, 0, 2))
		expect(result.status).toBe('refinement-required')
		if (result.status !== 'refinement-required') return
		expect(result.regionIds).toEqual(['r2'])
		expect(result.targetInnerMaxError).toBeLessThan(0.25)
		expect(result.targetInnerMaxError).toBeGreaterThan(0.249999999999)
	})

	it('returns empty for an empty visible-region set without requesting refinement', () => {
		expect(evaluateSnapshotPrecision([], affine(100, 0, 0, 100))).toEqual({ status: 'empty' })
	})

	it('allows stricter local precision policy but never relaxes the canonical 0.5 final-CSS-px ceiling', () => {
		expect(evaluateRegionPrecision(0.3, affine(1, 0, 0, 1), 0.25)).toMatchObject({ status: 'refinement-required' })
		expect(evaluateRegionPrecision(0.6, affine(1, 0, 0, 1), 1)).toEqual({
			status: 'precision-unavailable', reason: 'invalid-mapping',
		})
	})

	it('requires an explicit conservative proof for non-affine mappings', () => {
		expect(evaluateRegionPrecision(0.1, { kind: 'non-affine' })).toEqual({
			status: 'precision-unavailable', reason: 'unproven-non-affine',
		})
		expect(evaluateRegionPrecision(0.1, { kind: 'non-affine', amplificationUpperBound: 4 })).toMatchObject({ status: 'eligible' })
		expect(evaluateRegionPrecision(0.2, { kind: 'non-affine', amplificationUpperBound: 4 })).toMatchObject({ status: 'refinement-required' })
	})

	it('fails closed for non-finite or negative outer mapping proof inputs', () => {
		expect(evaluateRegionPrecision(0.1, affine(Number.NaN, 0, 0, 1))).toEqual({ status: 'precision-unavailable', reason: 'invalid-mapping' })
		expect(evaluateRegionPrecision(0.1, { kind: 'non-affine', amplificationUpperBound: -1 })).toEqual({ status: 'precision-unavailable', reason: 'invalid-mapping' })
		expect(evaluateRegionPrecision(0.1, { kind: 'non-affine', amplificationUpperBound: Number.POSITIVE_INFINITY })).toEqual({ status: 'precision-unavailable', reason: 'invalid-mapping' })
	})

	it('maps points and all contour coordinate fields through the affine outer transform', () => {
		const mapping = affine(2, 1, -0.5, 3, 7, -4)
		expect(mapPointAffine({ x: 2, y: 5 }, mapping)).toEqual({ x: 8.5, y: 13 })
		const mapped = mapContourAffine(square, mapping)
		expect(mapped.commands[0]).toEqual({ op: 'moveTo', x: 7, y: -4 })
		expect(mapped.commands[2]).toEqual({
			op: 'cubicBezierTo',
			c1x: 31, c1y: 8,
			c2x: 26, c2y: 38,
			x: 22, y: 36,
		})
		expect(mapped.commands.at(-1)).toEqual({ op: 'close' })
	})

	it('fails closed when mapping a region with an invalid error bound', () => {
		expect(mapVisibleRegionAffine(region('bad', -1), affine(1, 0, 0, 1))).toBeUndefined()
		expect(mapVisibleRegionAffine(region('bad', Number.POSITIVE_INFINITY), affine(1, 0, 0, 1))).toBeUndefined()
	})

	it('fails closed when finite affine inputs overflow mapped contour coordinates', () => {
		const hugeContour: Contour = { commands: [
			{ op: 'moveTo', x: 1e308, y: 0 },
			{ op: 'lineTo', x: 1e308, y: 1 },
			{ op: 'lineTo', x: 0, y: 1 },
			{ op: 'close' },
		] }
		expect(mapVisibleRegionAffine(
			{ regionId: 'huge', contour: hugeContour, maxError: 0 },
			affine(1e308, 0, 0, 1, 0, 0),
		)).toBeUndefined()
	})

	it('keeps presentation translation changes remappable without changing precision eligibility', () => {
		const source = region('r1', 0.2)
		const first = mapVisibleRegionAffine(source, affine(1.5, 0, 0, 1.5, 0, 0))!
		const moved = mapVisibleRegionAffine(source, affine(1.5, 0, 0, 1.5, 120, 45))!
		expect(moved.finalMaxErrorUpperBound).toBe(first.finalMaxErrorUpperBound)
		expect(moved.contour.commands[0]).not.toEqual(first.contour.commands[0])
	})

	it('keeps the production amplification above an independent closed-form oracle across adversarial deterministic matrices', () => {
		for (let index = 1; index <= 120; index++) {
			const a = Math.sin(index * 1.7) * 20
			const b = Math.cos(index * 0.9) * 8
			const c = Math.sin(index * 0.37) * 13
			const d = Math.cos(index * 1.13) * 17
			const mapping = affine(a, b, c, d)
			const upper = affineAmplificationUpperBound(mapping)!
			const oracle = spectralNormOracle(mapping)
			expect(upper).toBeGreaterThanOrEqual(oracle * (1 - 1e-13))
		}
	})
})

function spectralNormOracle(mapping: AffineOuterMapping): number {
	const scale = Math.max(Math.abs(mapping.a), Math.abs(mapping.b), Math.abs(mapping.c), Math.abs(mapping.d))
	if (scale === 0) return 0
	const a = mapping.a / scale
	const b = mapping.b / scale
	const c = mapping.c / scale
	const d = mapping.d / scale
	const trace = a * a + b * b + c * c + d * d
	const determinant = a * d - b * c
	const discriminant = Math.max(0, trace * trace - 4 * determinant * determinant)
	return scale * Math.sqrt((trace + Math.sqrt(discriminant)) / 2)
}
