import polygonClipping from 'polygon-clipping'
import type { Point } from './protocol/schema'

/**
 * Polygon algebra for the Preview's curved occluders (Part 4, issue #112).
 *
 * A visible area is a set of polygons. Every shape that shrinks it is first approximated as a
 * polygon on the safe side: a covering shape (an occluder, a clip the Widget must stay inside) by a
 * polygon that contains it when it removes area, and a shape the Widget must stay inside by a
 * polygon contained in it. Subtracting more or keeping less only ever shrinks what is reported as
 * visible, so the report never claims a pixel the browser does not show of the Widget.
 *
 * The boolean operations are fail-closed: any input or output the library cannot represent
 * robustly (an exception, a degenerate or self-touching ring) gives `undefined`, never a repair.
 */

/** One closed ring as `[x, y]` pairs, the first point not repeated at the end. */
export type PolygonRing = ReadonlyArray<readonly [number, number]>
/** A ring and the holes cut out of it. */
export type Polygon = ReadonlyArray<PolygonRing>
export type MultiPolygon = ReadonlyArray<Polygon>

/** A covering or contained shape as polygons, with the deviation bound of its approximation. */
export type PolygonShape = Readonly<{ polygons: MultiPolygon; maxError: number }>

export function pointsRing(points: readonly Point[]): PolygonRing {
	return points.map(point => [point.x, point.y] as const)
}

export function rectangleRing(left: number, top: number, right: number, bottom: number): PolygonRing {
	return [[left, top], [right, top], [right, bottom], [left, bottom]]
}

export function ringShape(ring: PolygonRing, maxError: number): PolygonShape {
	return Object.freeze({ polygons: Object.freeze([Object.freeze([ring])]), maxError })
}

export function rectangleShape(left: number, top: number, right: number, bottom: number): PolygonShape {
	return ringShape(rectangleRing(left, top, right, bottom), 0)
}

/** The most vertices a ring may have to be tested for simplicity (the test is quadratic) or used as an exact shape. */
export const MAX_RING_VERTICES = 256
/** The most polygon cuts, and the most vertices in all of them, one Widget's subtraction takes on; past it a cut is its bounding box. */
export const MAX_CUT_SHAPES = 40
export const MAX_CUT_VERTICES = 2000

type LibraryGeometry = Parameters<typeof polygonClipping.union>[0]
type Bounds = Readonly<{ left: number; top: number; right: number; bottom: number }>

export function vertexCount(shape: PolygonShape): number {
	return shape.polygons.reduce((sum, polygon) => sum + polygon.reduce((inner, ring) => inner + ring.length, 0), 0)
}

/** The bounding box of a shape, undefined for an empty one. */
export function boundsOf(shape: PolygonShape): Bounds | undefined {
	let bounds: Bounds | undefined
	for (const polygon of shape.polygons) {
		for (const [x, y] of polygon[0] ?? []) {
			bounds = bounds ? { left: Math.min(bounds.left, x), top: Math.min(bounds.top, y), right: Math.max(bounds.right, x), bottom: Math.max(bounds.bottom, y) } : { left: x, top: y, right: x, bottom: y }
		}
	}
	return bounds
}

function ringArea(ring: PolygonRing): number {
	let twice = 0
	for (let index = 0; index < ring.length; index++) {
		const a = ring[index]!
		const b = ring[(index + 1) % ring.length]!
		twice += a[0] * b[1] - b[0] * a[1]
	}
	return Math.abs(twice) / 2
}

function areaOf(shape: MultiPolygon): number {
	return shape.reduce((sum, polygon) => sum + ringArea(polygon[0] ?? []) - polygon.slice(1).reduce((holes, hole) => holes + ringArea(hole), 0), 0)
}

function insideRing(ring: PolygonRing, [x, y]: readonly [number, number]): boolean {
	let odd = false
	for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
		const [xa, ya] = ring[a]!
		const [xb, yb] = ring[b]!
		if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) odd = !odd
	}
	return odd
}

function distanceToRing(ring: PolygonRing, [x, y]: readonly [number, number]): number {
	let best = Number.POSITIVE_INFINITY
	for (let index = 0; index < ring.length; index++) {
		const [ax, ay] = ring[index]!
		const [bx, by] = ring[(index + 1) % ring.length]!
		const dx = bx - ax
		const dy = by - ay
		const t = dx === 0 && dy === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
		best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
	}
	return best
}

/** The slack, in px, of the sanity checks on the library's output: coordinates and areas carry rounding. */
function slack(...shapes: readonly PolygonShape[]): number {
	let scale = 1
	for (const shape of shapes) {
		const bounds = boundsOf(shape)
		if (bounds) scale = Math.max(scale, Math.abs(bounds.left), Math.abs(bounds.top), Math.abs(bounds.right), Math.abs(bounds.bottom))
	}
	return scale * 1e-9
}

function withinBounds(inner: Bounds | undefined, outer: Bounds | undefined, epsilon: number): boolean {
	if (!inner) return true
	if (!outer) return false
	return inner.left >= outer.left - epsilon && inner.top >= outer.top - epsilon && inner.right <= outer.right + epsilon && inner.bottom <= outer.bottom + epsilon
}

function guarded(operation: () => MultiPolygon): MultiPolygon | undefined {
	try {
		const result = operation()
		return result.every(polygon => polygon.every(ring => ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y)))) ? result : undefined
	}
	catch {
		return undefined
	}
}

function geometry(shape: MultiPolygon): LibraryGeometry {
	return shape.map(polygon => polygon.map(ring => ring.map(([x, y]) => [x, y] as [number, number]))) as LibraryGeometry
}

/** The part of `base` inside every one of `shapes`. */
export function intersectShapes(base: PolygonShape, shapes: readonly PolygonShape[]): PolygonShape | undefined {
	if (shapes.length === 0) return base
	const polygons = guarded(() => polygonClipping.intersection(geometry(base.polygons), ...shapes.map(shape => geometry(shape.polygons))) as MultiPolygon)
	if (!polygons) return undefined
	// The library's answer is checked against what any intersection must satisfy; a violation is no answer.
	const epsilon = slack(base, ...shapes)
	const result = { polygons, maxError: 0 }
	const smallest = Math.min(areaOf(base.polygons), ...shapes.map(shape => areaOf(shape.polygons)))
	if (areaOf(polygons) > smallest + epsilon * Math.max(1, smallest)) return undefined
	if (!withinBounds(boundsOf(result), boundsOf(base), epsilon) || !shapes.every(shape => withinBounds(boundsOf(result), boundsOf(shape), epsilon))) return undefined
	return Object.freeze({ polygons, maxError: Math.max(base.maxError, ...shapes.map(shape => shape.maxError)) })
}

/** The union of shapes. */
export function unionShapes(shapes: readonly PolygonShape[]): PolygonShape | undefined {
	if (shapes.length === 0) return undefined
	const [first, ...rest] = shapes as [PolygonShape, ...PolygonShape[]]
	const polygons = guarded(() => polygonClipping.union(geometry(first.polygons), ...rest.map(shape => geometry(shape.polygons))) as MultiPolygon)
	if (!polygons) return undefined
	const epsilon = slack(...shapes)
	const total = shapes.reduce((sum, shape) => sum + areaOf(shape.polygons), 0)
	const largest = Math.max(...shapes.map(shape => areaOf(shape.polygons)))
	const area = areaOf(polygons)
	if (area > total + epsilon * Math.max(1, total) || area < largest - epsilon * Math.max(1, largest)) return undefined
	return Object.freeze({ polygons, maxError: Math.max(...shapes.map(shape => shape.maxError)) })
}

/**
 * `base` minus every cut. Each cut must contain the area it truly removes. The deviation bound is
 * the largest of the inputs': the result lies inside the true area (it only ever removes more),
 * and what it lacks lies within that bound of the true area's boundary.
 */
export function subtractShapes(base: PolygonShape, cuts: readonly PolygonShape[]): PolygonShape | undefined {
	if (cuts.length === 0) return base
	const polygons = guarded(() => polygonClipping.difference(geometry(base.polygons), ...cuts.map(cut => geometry(cut.polygons))) as MultiPolygon)
	if (!polygons) return undefined
	// The library's answer is checked against what any difference must satisfy; a violation is no answer.
	const epsilon = slack(base, ...cuts)
	const baseArea = areaOf(base.polygons)
	const area = areaOf(polygons)
	if (area > baseArea + epsilon * Math.max(1, baseArea)) return undefined
	if (!withinBounds(boundsOf({ polygons, maxError: 0 }), boundsOf(base), epsilon)) return undefined
	// A cut with a vertex well inside the base takes some of it away: the result must be smaller.
	if (area >= baseArea - epsilon * Math.max(1, baseArea) && cuts.some(cut => overlapsInterior(base, cut, epsilon * 1e3))) return undefined
	return Object.freeze({ polygons, maxError: Math.max(base.maxError, ...cuts.map(cut => cut.maxError)) })
}

/** Whether some vertex of `cut` lies inside `base`'s outer boundary by more than `margin`, so the two overlap with area. */
function overlapsInterior(base: PolygonShape, cut: PolygonShape, margin: number): boolean {
	for (const polygon of cut.polygons) {
		for (const vertex of polygon[0] ?? []) {
			if (base.polygons.some(basePolygon => basePolygon[0] !== undefined && insideRing(basePolygon[0], vertex) && distanceToRing(basePolygon[0], vertex) > margin)) return true
		}
	}
	return false
}

/**
 * The outer boundary of every piece, in contour order: interior holes are never reported
 * (Rule 01a11687-3037). Undefined when a ring cannot be a valid contour: fewer than three distinct
 * vertices, a repeated vertex (a ring touching itself), no area.
 */
export function outerRings(shape: PolygonShape): readonly PolygonRing[] | undefined {
	const rings: PolygonRing[] = []
	for (const polygon of shape.polygons) {
		const outer = polygon[0]
		if (!outer) continue
		const open = outer.length > 1 && samePair(outer[0]!, outer[outer.length - 1]!) ? outer.slice(0, -1) : outer
		if (!validRing(open)) return undefined
		rings.push(open)
	}
	return rings
}

function samePair(a: readonly [number, number], b: readonly [number, number]): boolean {
	return a[0] === b[0] && a[1] === b[1]
}

function validRing(ring: PolygonRing): boolean {
	if (ring.length < 3) return false
	const seen = new Set<string>()
	for (const [x, y] of ring) {
		const key = `${x},${y}`
		if (seen.has(key)) return false
		seen.add(key)
	}
	let twice = 0
	for (let index = 0; index < ring.length; index++) {
		const a = ring[index]!
		const b = ring[(index + 1) % ring.length]!
		twice += a[0] * b[1] - b[0] * a[1]
	}
	return twice !== 0
}

/**
 * Whether a ring is simple: non-degenerate, and no two edges meet except consecutive ones at their
 * shared vertex. Used before a user-supplied `polygon()` is taken as an exact shape.
 */
export function isSimpleRing(ring: PolygonRing): boolean {
	if (ring.length > MAX_RING_VERTICES || !validRing(ring)) return false
	const count = ring.length
	for (let first = 0; first < count; first++) {
		const a = ring[first]!
		const b = ring[(first + 1) % count]!
		for (let second = first + 1; second < count; second++) {
			const adjacent = second === first + 1 || (first === 0 && second === count - 1)
			const c = ring[second]!
			const d = ring[(second + 1) % count]!
			if (adjacent) {
				// Adjacent edges may share only their common vertex: reject a fold-back along the same line.
				const shared = second === first + 1 ? b : a
				const other1 = second === first + 1 ? a : b
				const other2 = second === first + 1 ? d : c
				if (cross(shared, other1, other2) === 0 && dot(shared, other1, other2) > 0) return false
				continue
			}
			if (segmentsMeet(a, b, c, d)) return false
		}
	}
	return true
}

function cross(origin: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
	return (a[0] - origin[0]) * (b[1] - origin[1]) - (a[1] - origin[1]) * (b[0] - origin[0])
}

function dot(origin: readonly [number, number], a: readonly [number, number], b: readonly [number, number]): number {
	return (a[0] - origin[0]) * (b[0] - origin[0]) + (a[1] - origin[1]) * (b[1] - origin[1])
}

function onSegment(a: readonly [number, number], b: readonly [number, number], p: readonly [number, number]): boolean {
	return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0]) && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1])
}

/** Whether two closed segments share any point, touching included. */
function segmentsMeet(a: readonly [number, number], b: readonly [number, number], c: readonly [number, number], d: readonly [number, number]): boolean {
	const d1 = Math.sign(cross(c, d, a))
	const d2 = Math.sign(cross(c, d, b))
	const d3 = Math.sign(cross(a, b, c))
	const d4 = Math.sign(cross(a, b, d))
	if (d1 * d2 < 0 && d3 * d4 < 0) return true
	if (d1 === 0 && onSegment(c, d, a)) return true
	if (d2 === 0 && onSegment(c, d, b)) return true
	if (d3 === 0 && onSegment(a, b, c)) return true
	if (d4 === 0 && onSegment(a, b, d)) return true
	return false
}
