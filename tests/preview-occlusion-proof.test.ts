import { describe, expect, it } from 'vitest'

import { planOcclusion, type OcclusionEvidence } from '../src/preview/occlusion-proof'

type Shape = { id: string; points?: Array<[number, number]> }

function opaque(kind: 'rectangle' | 'rounded-box' | 'clip-inset' | 'clip-circle' | 'clip-ellipse' | 'clip-polygon' | 'svg-clip-path', id: string = kind): OcclusionEvidence<Shape> {
	return { classification: 'opaque', targetContribution: 'proven-zero', shape: { kind, shape: { id } } }
}

describe('Preview occlusion proof policy', () => {
	it('permits subtraction only for proven-zero opaque coverage with a reliable actual shape', () => {
		const result = planOcclusion([
			opaque('rectangle', 'rect'),
			opaque('rounded-box', 'rounded'),
			opaque('clip-polygon', 'poly'),
		])
		expect(result).toEqual({
			status: 'precise',
			subtract: [
				{ kind: 'rectangle', shape: { id: 'rect' } },
				{ kind: 'rounded-box', shape: { id: 'rounded' } },
				{ kind: 'clip-polygon', shape: { id: 'poly' } },
			],
			translucentObstruction: false,
		})
	})

	it('supports the canonical first-version reliable basic-shape and SVG clipPath kinds without bbox substitution', () => {
		const kinds = ['clip-inset', 'clip-circle', 'clip-ellipse', 'clip-polygon', 'svg-clip-path'] as const
		const result = planOcclusion(kinds.map(kind => opaque(kind)))
		expect(result.status).toBe('precise')
		if (result.status === 'precise') expect(result.subtract.map(item => item.kind)).toEqual(kinds)
	})

	it('retains reliably visible translucent coverage and emits one shared obstruction state instead of subtracting it', () => {
		const result = planOcclusion<Shape>([
			{ classification: 'translucent', targetContribution: 'proven-nonzero' },
			{ classification: 'translucent', targetContribution: 'proven-nonzero' },
		])
		expect(result).toEqual({ status: 'precise', subtract: [], translucentObstruction: true })
	})

	it('can combine opaque subtraction with a single aggregate translucent-obstruction signal', () => {
		expect(planOcclusion<Shape>([
			opaque('rectangle'),
			{ classification: 'translucent', targetContribution: 'proven-nonzero' },
		])).toEqual({
			status: 'precise',
			subtract: [{ kind: 'rectangle', shape: { id: 'rectangle' } }],
			translucentObstruction: true,
		})
	})

	it('fails structural-only when zero-contribution coverage lacks a reliable actual perimeter', () => {
		expect(planOcclusion<Shape>([
			{ classification: 'opaque', targetContribution: 'proven-zero', shape: undefined },
		])).toEqual({ status: 'structural-only', reason: 'opaque-shape-unavailable' })
	})

	it('fails structural-only for advanced/unknown compositing rather than guessing opaque or translucent behavior', () => {
		for (const reason of ['blend-mode', 'filter', 'backdrop-filter', 'complex-mask', 'unreliable-visible-shape', 'unknown-compositing'] as const) {
			expect(planOcclusion<Shape>([{ classification: 'unsupported', reason }])).toEqual({
				status: 'structural-only', reason: 'unsupported-compositing',
			})
		}
	})

	it('does not allow later reliable evidence to override an earlier unsupported-compositing proof gap', () => {
		const result = planOcclusion<Shape>([
			opaque('rectangle'),
			{ classification: 'unsupported', reason: 'filter' },
			opaque('rounded-box'),
		])
		expect(result).toEqual({ status: 'structural-only', reason: 'unsupported-compositing' })
	})

	it('does not approximate an irregular occluder when its actual visible shape is unavailable', () => {
		const result = planOcclusion<Shape>([
			{ classification: 'unsupported', reason: 'unreliable-visible-shape' },
		])
		expect(result).toEqual({ status: 'structural-only', reason: 'unsupported-compositing' })
	})

	it('returns a precise empty subtraction plan when there are no occluders', () => {
		expect(planOcclusion<Shape>([])).toEqual({ status: 'precise', subtract: [], translucentObstruction: false })
	})

	it('defensively owns reliable clipping-shape evidence', () => {
		const mutable: Shape = { id: 'shape', points: [[1, 2], [3, 4]] }
		const result = planOcclusion<Shape>([{
			classification: 'opaque', targetContribution: 'proven-zero',
			shape: { kind: 'clip-polygon', shape: mutable },
		}])
		mutable.id = 'mutated'
		mutable.points![0]![0] = 999
		expect(result).toEqual({
			status: 'precise',
			subtract: [{ kind: 'clip-polygon', shape: { id: 'shape', points: [[1, 2], [3, 4]] } }],
			translucentObstruction: false,
		})
	})
})
