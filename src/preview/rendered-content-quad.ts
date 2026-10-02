import type { Point } from './protocol/schema'

export type RenderedContentBoxQuad = Readonly<{
	p1: Point
	p2: Point
	p3: Point
	p4: Point
}>

type QuadPointLike = Readonly<{ x: number; y: number }>
type QuadLike = Readonly<{ p1: QuadPointLike; p2: QuadPointLike; p3: QuadPointLike; p4: QuadPointLike }>

type BoxQuadCapableElement = Element & Readonly<{
	getBoxQuads?: (options?: Readonly<{ box?: 'content' | 'padding' | 'border' | 'margin' }>) => Iterable<QuadLike>
}>

export type RenderedContentBoxMeasurement =
	| Readonly<{ status: 'available'; quad: RenderedContentBoxQuad }>
	| Readonly<{ status: 'unavailable'; reason: 'api-unavailable' | 'measurement-failed' | 'ambiguous-fragments' | 'invalid-geometry' }>

/**
 * Measures the actual rendered iframe content-box quad only when the browser exposes a
 * geometry API capable of returning it. This intentionally has no getBoundingClientRect()
 * fallback: an axis-aligned bbox cannot recover rotation/skew/nonuniform rendered geometry.
 */
export function measureRenderedContentBoxQuad(element: Element): RenderedContentBoxMeasurement {
	const candidate = element as BoxQuadCapableElement
	if (typeof candidate.getBoxQuads !== 'function')
		return { status: 'unavailable', reason: 'api-unavailable' }

	let quads: QuadLike[]
	try {
		quads = [...candidate.getBoxQuads({ box: 'content' })]
	}
	catch {
		return { status: 'unavailable', reason: 'measurement-failed' }
	}

	if (quads.length !== 1)
		return { status: 'unavailable', reason: 'ambiguous-fragments' }
	const quad = quads[0]!
	if (![quad.p1, quad.p2, quad.p3, quad.p4].every(isFinitePoint))
		return { status: 'unavailable', reason: 'invalid-geometry' }

	return {
		status: 'available',
		quad: Object.freeze({
			p1: clonePoint(quad.p1),
			p2: clonePoint(quad.p2),
			p3: clonePoint(quad.p3),
			p4: clonePoint(quad.p4),
		}),
	}
}

function isFinitePoint(point: QuadPointLike): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y)
}

function clonePoint(point: QuadPointLike): Point {
	return Object.freeze({ x: point.x, y: point.y })
}
