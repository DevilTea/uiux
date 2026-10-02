import type { AffineOuterMapping } from './outer-precision'
import type { RenderedContentBoxQuad } from './rendered-content-quad'

export type ContentViewportSize = Readonly<{ width: number; height: number }>

export type DerivedOuterMapping =
	| Readonly<{ status: 'affine'; mapping: AffineOuterMapping }>
	| Readonly<{ status: 'non-affine'; quad: RenderedContentBoxQuad }>
	| Readonly<{ status: 'unavailable'; reason: 'invalid-viewport' | 'invalid-quad' | 'non-finite-transform' }>

/**
 * Derives an inner-content-viewport -> Workbench affine map from the actual rendered content
 * quad when that quad is a numerically credible parallelogram. A non-parallelogram is retained
 * only as non-affine evidence; callers must not approximate it with an affine/bbox fallback.
 *
 * The parallelogram comparison uses only scale-relative floating-point roundoff allowance, not
 * a CSS-pixel geometric epsilon. It is therefore a numerical classification guard, not contour
 * repair or visible-geometry tolerance.
 */
export function deriveOuterMapping(
	viewport: ContentViewportSize,
	quad: RenderedContentBoxQuad,
): DerivedOuterMapping {
	if (!validDimension(viewport.width) || !validDimension(viewport.height) || viewport.width === 0 || viewport.height === 0)
		return { status: 'unavailable', reason: 'invalid-viewport' }
	if (![quad.p1, quad.p2, quad.p3, quad.p4].every(point => Number.isFinite(point.x) && Number.isFinite(point.y)))
		return { status: 'unavailable', reason: 'invalid-quad' }

	if (!parallelogramCoordinate(quad.p1.x, quad.p2.x, quad.p3.x, quad.p4.x)
		|| !parallelogramCoordinate(quad.p1.y, quad.p2.y, quad.p3.y, quad.p4.y))
		return { status: 'non-affine', quad: cloneQuad(quad) }

	const a = stableDifferenceRatio(quad.p2.x, quad.p1.x, viewport.width)
	const b = stableDifferenceRatio(quad.p2.y, quad.p1.y, viewport.width)
	const c = stableDifferenceRatio(quad.p4.x, quad.p1.x, viewport.height)
	const d = stableDifferenceRatio(quad.p4.y, quad.p1.y, viewport.height)
	if (![a, b, c, d, quad.p1.x, quad.p1.y].every(Number.isFinite))
		return { status: 'unavailable', reason: 'non-finite-transform' }

	return Object.freeze({
		status: 'affine' as const,
		mapping: Object.freeze({
			kind: 'affine' as const,
			a, b, c, d,
			e: quad.p1.x,
			f: quad.p1.y,
		}),
	})
}

function parallelogramCoordinate(p1: number, p2: number, p3: number, p4: number): boolean {
	const scale = Math.max(Math.abs(p1), Math.abs(p2), Math.abs(p3), Math.abs(p4))
	if (scale === 0) return true
	const q1 = p1 / scale
	const q2 = p2 / scale
	const q3 = p3 / scale
	const q4 = p4 / scale
	const residual = q3 - q2 - q4 + q1
	const magnitude = Math.abs(q1) + Math.abs(q2) + Math.abs(q3) + Math.abs(q4)
	const roundoffAllowance = 64 * Number.EPSILON * Math.max(1, magnitude)
	return Math.abs(residual) <= roundoffAllowance
}

function stableDifferenceRatio(left: number, right: number, denominator: number): number {
	const scale = Math.max(Math.abs(left), Math.abs(right), Math.abs(denominator))
	if (scale === 0) return Number.NaN
	return (left / scale - right / scale) / (denominator / scale)
}

function validDimension(value: number): boolean {
	return Number.isFinite(value) && value >= 0
}

function cloneQuad(quad: RenderedContentBoxQuad): RenderedContentBoxQuad {
	return Object.freeze({
		p1: Object.freeze({ ...quad.p1 }),
		p2: Object.freeze({ ...quad.p2 }),
		p3: Object.freeze({ ...quad.p3 }),
		p4: Object.freeze({ ...quad.p4 }),
	})
}
