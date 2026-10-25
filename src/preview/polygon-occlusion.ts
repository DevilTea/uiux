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

type LibraryGeometry = Parameters<typeof polygonClipping.union>[0]

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
	return Object.freeze({ polygons, maxError: Math.max(base.maxError, ...shapes.map(shape => shape.maxError)) })
}

/** The union of shapes. */
export function unionShapes(shapes: readonly PolygonShape[]): PolygonShape | undefined {
	if (shapes.length === 0) return undefined
	const [first, ...rest] = shapes as [PolygonShape, ...PolygonShape[]]
	const polygons = guarded(() => polygonClipping.union(geometry(first.polygons), ...rest.map(shape => geometry(shape.polygons))) as MultiPolygon)
	if (!polygons) return undefined
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
	return Object.freeze({ polygons, maxError: Math.max(base.maxError, ...cuts.map(cut => cut.maxError)) })
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
	if (!validRing(ring)) return false
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
