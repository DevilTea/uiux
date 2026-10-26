import { describe, expect, it } from 'vitest'

import { basicShapePolygon, parseClipPath, roundedRectShape, svgPrimitiveShape, type BasicShape } from '../src/preview/clip-shapes'
import { intersectShapes, isSimpleRing, outerRings, rectangleShape, ringShape, subtractShapes, unionShapes, type PolygonRing, type PolygonShape } from '../src/preview/polygon-occlusion'
import { approximateEllipseOuterPolygon, approximateRoundedRectOuterPolygon, type RoundedRectRadii } from '../src/preview/rounded-contour'

/**
 * Curved occluders and clips as polygons (Part 4, issue #112): the polygon of a covering shape
 * contains it, the polygon of a contained shape lies inside it, both within the reported maxError,
 * and the boolean operations fail closed.
 */

type Pair = readonly [number, number]

function areaOf(ring: PolygonRing): number {
	let twice = 0
	for (let index = 0; index < ring.length; index++) {
		const a = ring[index]!
		const b = ring[(index + 1) % ring.length]!
		twice += a[0] * b[1] - b[0] * a[1]
	}
	return Math.abs(twice) / 2
}

function totalArea(shape: PolygonShape): number {
	return shape.polygons.reduce((sum, polygon) => sum + areaOf(polygon[0]!) - polygon.slice(1).reduce((holes, hole) => holes + areaOf(hole), 0), 0)
}

function inside(ring: PolygonRing, [x, y]: Pair): boolean {
	let odd = false
	for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
		const [xa, ya] = ring[a]!
		const [xb, yb] = ring[b]!
		if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) odd = !odd
	}
	return odd
}

function distanceToRing(ring: PolygonRing, [x, y]: Pair): number {
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

const ring = (shape: PolygonShape): PolygonRing => shape.polygons[0]![0]!

function ellipsePoints(cx: number, cy: number, rx: number, ry: number, count = 720): Pair[] {
	return Array.from({ length: count }, (_, index) => [cx + rx * Math.cos(index * 2 * Math.PI / count), cy + ry * Math.sin(index * 2 * Math.PI / count)] as const)
}

describe('Outer polygons of curved covering shapes', () => {
	it('contains every point of an ellipse and stays within the reported error of it', () => {
		for (const [rx, ry, target] of [[40, 40, 0.25], [120, 7, 0.1], [3, 90, 0.5]] as const) {
			const result = approximateEllipseOuterPolygon({ cx: 50, cy: 60, rx, ry }, target)
			expect(result, `${rx}x${ry}`).toBeDefined()
			expect(result!.maxError).toBeGreaterThan(0)
			expect(result!.maxError).toBeLessThanOrEqual(target)
			const polygon = result!.points.map(point => [point.x, point.y] as const)
			for (const point of ellipsePoints(50, 60, rx, ry)) {
				expect(inside(polygon, point) || distanceToRing(polygon, point) < 1e-9, `${rx}x${ry} contains`).toBe(true)
				expect(distanceToRing(polygon, point), `${rx}x${ry} error`).toBeLessThanOrEqual(result!.maxError)
			}
			// The polygon's own corners are the farthest points: none lies beyond the bound of the ellipse.
			for (const [x, y] of polygon) expect(Math.abs(Math.hypot((x - 50) / rx, (y - 60) / ry) - 1) * Math.max(rx, ry)).toBeLessThanOrEqual(result!.maxError + 1e-9)
		}
	})

	it('contains a rounded rectangle, keeps its straight sides exact and bounds the corner error', () => {
		const radii: RoundedRectRadii = { topLeft: { rx: 30, ry: 20 }, topRight: { rx: 10, ry: 10 }, bottomRight: { rx: 0, ry: 0 }, bottomLeft: { rx: 25, ry: 25 } }
		const rectangle = { x: 10, y: 20, width: 120, height: 80 }
		const result = approximateRoundedRectOuterPolygon(rectangle, radii, 0.2)
		expect(result).toBeDefined()
		expect(result!.maxError).toBeLessThanOrEqual(0.2)
		const polygon = result!.points.map(point => [point.x, point.y] as const)
		// The square corner stays square; no vertex leaves the rectangle's box.
		expect(polygon.some(([x, y]) => x === 130 && y === 100)).toBe(true)
		for (const [x, y] of polygon) {
			expect(x).toBeGreaterThanOrEqual(10 - 1e-9)
			expect(x).toBeLessThanOrEqual(130 + 1e-9)
			expect(y).toBeGreaterThanOrEqual(20 - 1e-9)
			expect(y).toBeLessThanOrEqual(100 + 1e-9)
		}
		// Every point of the true shape's boundary is inside, or on, the polygon.
		for (const [cx, cy, rx, ry, from] of [[40, 40, 30, 20, Math.PI], [120, 30, 10, 10, 1.5 * Math.PI], [35, 75, 25, 25, 0.5 * Math.PI]] as const) {
			for (let step = 0; step <= 90; step++) {
				const angle = from + step * (0.5 * Math.PI) / 90
				const point: Pair = [cx + rx * Math.cos(angle), cy + ry * Math.sin(angle)]
				expect(inside(polygon, point) || distanceToRing(polygon, point) < 1e-9).toBe(true)
			}
		}
		// Larger than the inscribed shape, smaller than the box.
		expect(areaOf(polygon)).toBeLessThanOrEqual(120 * 80)
	})

	it('applies the CSS overlap scaling before approximating and rejects what it cannot represent', () => {
		const pill = approximateRoundedRectOuterPolygon({ x: 0, y: 0, width: 100, height: 40 }, { topLeft: { rx: 80, ry: 30 }, topRight: { rx: 80, ry: 30 }, bottomRight: { rx: 80, ry: 30 }, bottomLeft: { rx: 80, ry: 30 } }, 0.2)
		expect(pill).toBeDefined()
		const polygon = pill!.points.map(point => [point.x, point.y] as const)
		// 80 × 30 corners overflow the 100 × 40 box: the factor 100 / 160 leaves 50 × 18.75 corners.
		for (let step = 0; step <= 90; step++) {
			const angle = Math.PI + step * (0.5 * Math.PI) / 90
			const point: Pair = [50 + 50 * Math.cos(angle), 18.75 + 18.75 * Math.sin(angle)]
			expect(inside(polygon, point) || distanceToRing(polygon, point) < 1e-9).toBe(true)
		}
		expect(approximateRoundedRectOuterPolygon({ x: 0, y: 0, width: 0, height: 10 }, { topLeft: { rx: 1, ry: 1 }, topRight: { rx: 1, ry: 1 }, bottomRight: { rx: 1, ry: 1 }, bottomLeft: { rx: 1, ry: 1 } }, 0.5)).toBeUndefined()
		expect(approximateEllipseOuterPolygon({ cx: 0, cy: 0, rx: 0, ry: 5 }, 0.5)).toBeUndefined()
		expect(approximateEllipseOuterPolygon({ cx: 0, cy: 0, rx: 5, ry: 5 }, 0)).toBeUndefined()
		expect(approximateEllipseOuterPolygon({ cx: Number.NaN, cy: 0, rx: 5, ry: 5 }, 0.5)).toBeUndefined()
	})
})

describe('Clip path values and shapes', () => {
	it('parses the computed forms of the supported basic shapes and reference boxes', () => {
		expect(parseClipPath('none')).toEqual({ kind: 'none' })
		expect(parseClipPath('url("#clip")')).toEqual({ kind: 'url', id: 'clip' })
		expect(parseClipPath('circle(50% at 50% 50%)')).toMatchObject({ kind: 'shape', box: 'border-box', shape: { kind: 'circle' } })
		expect(parseClipPath('ellipse(30% 45% at 10px 20%) padding-box')).toMatchObject({ kind: 'shape', box: 'padding-box', shape: { kind: 'ellipse' } })
		expect(parseClipPath('inset(10px 20px 30px 40px round 5px / 6px)')).toMatchObject({ kind: 'shape', shape: { kind: 'inset' } })
		expect(parseClipPath('content-box polygon(50% 0%, 100% 100%, 0% 100%)')).toMatchObject({ kind: 'shape', box: 'content-box', shape: { kind: 'polygon' } })
	})

	it('has no value for forms it cannot derive exactly', () => {
		for (const value of ['path("M 0 0 L 10 0 L 10 10 Z")', 'circle(calc(10px + 20%))', 'inset(1em)', 'polygon(0 0, 10px)', 'polygon(0 0, 10px 0)', 'circle(5px at left 10px top 20px)', 'xywh(0 0 10px 10px)', 'url(other.svg#x)', 'blur(2px)', 'circle(5px) margin-box']) {
			expect(parseClipPath(value), value).toBeUndefined()
		}
	})

	it('derives circle, ellipse and inset shapes on either side of the true shape within their maxError', () => {
		const box = { left: 100, top: 50, right: 300, bottom: 150 }
		const circle = parseClipPath('circle(40% at 25% 50%)')
		const ellipse = parseClipPath('ellipse(closest-side farthest-side at 50% 50%)')
		for (const parsed of [circle, ellipse]) {
			const shape = (parsed as { shape: BasicShape }).shape
			const cover = basicShapePolygon(shape, box, 1, 'cover', 0.25)!
			const contain = basicShapePolygon(shape, box, 1, 'contain', 0.25)!
			expect(cover.maxError).toBeGreaterThan(0)
			expect(cover.maxError).toBeLessThanOrEqual(0.25)
			expect(totalArea(cover)).toBeGreaterThan(totalArea(contain))
			// The contained polygon lies in the covering one.
			for (const vertex of ring(contain)) expect(inside(ring(cover), vertex) || distanceToRing(ring(cover), vertex) < 1e-9).toBe(true)
		}
		// circle(40%): radius 0.4 of sqrt((200² + 100²)/2) about (150, 100).
		const radius = 0.4 * Math.sqrt((200 * 200 + 100 * 100) / 2)
		const cover = basicShapePolygon((circle as { shape: BasicShape }).shape, box, 1, 'cover', 0.25)!
		for (const point of ellipsePoints(150, 100, radius, radius, 360)) expect(inside(ring(cover), point) || distanceToRing(ring(cover), point) < 1e-9).toBe(true)
		// A rounded inset resolves its offsets, percentages and radii in the box.
		const inset = parseClipPath('inset(10px 20% 30px 5px round 10px)') as { shape: BasicShape }
		const rounded = basicShapePolygon(inset.shape, box, 2, 'cover', 0.25)!
		const xs = ring(rounded).map(([x]) => x)
		const ys = ring(rounded).map(([, y]) => y)
		expect(Math.min(...xs)).toBeCloseTo(100 + 5 * 2, 6)
		expect(Math.max(...xs)).toBeCloseTo(300 - 0.2 * 200, 6)
		expect(Math.min(...ys)).toBeCloseTo(50 + 10 * 2, 6)
		expect(Math.max(...ys)).toBeCloseTo(150 - 30 * 2, 6)
	})

	it('is exact for a simple polygon, empty for a degenerate shape and unavailable for a self-crossing one', () => {
		const box = { left: 0, top: 0, right: 100, bottom: 100 }
		const triangle = (parseClipPath('polygon(50% 0%, 100% 100%, 0% 100%)') as { shape: BasicShape }).shape
		const exact = basicShapePolygon(triangle, box, 1, 'cover', 0.5)!
		expect(exact.maxError).toBe(0)
		expect(totalArea(exact)).toBe(5000)
		expect(basicShapePolygon(triangle, box, 1, 'contain', 0.5)).toEqual(exact)
		const bowtie = (parseClipPath('polygon(0 0, 100% 100%, 100% 0, 0 100%)') as { shape: BasicShape }).shape
		expect(basicShapePolygon(bowtie, box, 1, 'cover', 0.5)).toBeUndefined()
		const empty = basicShapePolygon((parseClipPath('inset(60px 0 60px 0)') as { shape: BasicShape }).shape, box, 1, 'cover', 0.5)!
		expect(empty.polygons).toEqual([])
		expect(basicShapePolygon(triangle, { left: 0, top: 0, right: 0, bottom: 10 }, 1, 'cover', 0.5)).toBeUndefined()
		expect(basicShapePolygon(triangle, box, Number.NaN, 'cover', 0.5)).toBeUndefined()
	})

	it('maps SVG clip primitives through the unit mapping, a circle becoming an ellipse under bounding-box units', () => {
		const user = { x: 100, y: 200, sx: 2, sy: 2 }
		const circle = svgPrimitiveShape({ kind: 'circle', cx: 50, cy: 50, r: 40 }, user, 'cover', 0.25)!
		expect(Math.min(...ring(circle).map(([x]) => x))).toBeLessThanOrEqual(100 + 2 * 10)
		expect(Math.min(...ring(circle).map(([x]) => x))).toBeGreaterThan(100 + 2 * 10 - 0.26)
		const box = { x: 0, y: 0, sx: 200, sy: 100 }
		const bbox = svgPrimitiveShape({ kind: 'circle', cx: 0.5, cy: 0.5, r: 0.4 }, box, 'contain', 0.25)!
		const xs = ring(bbox).map(([x]) => x)
		const ys = ring(bbox).map(([, y]) => y)
		expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(160, 0)
		expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(80, 0)
		const rect = svgPrimitiveShape({ kind: 'rect', x: 10, y: 10, width: 50, height: 30, rx: 5, ry: 0 }, user, 'cover', 0.25)!
		expect(rect.maxError).toBe(0)
		expect(totalArea(rect)).toBeCloseTo(100 * 60, 6)
		expect(svgPrimitiveShape({ kind: 'rect', x: 0, y: 0, width: -1, height: 5, rx: 0, ry: 0 }, user, 'cover', 0.25)).toBeUndefined()
		expect(svgPrimitiveShape({ kind: 'circle', cx: 0, cy: 0, r: 0 }, user, 'cover', 0.25)!.polygons).toEqual([])
		expect(svgPrimitiveShape({ kind: 'polygon', points: [[0, 0], [10, 10], [10, 0], [0, 10]] }, user, 'cover', 0.25)).toBeUndefined()
		expect(svgPrimitiveShape({ kind: 'circle', cx: 0, cy: 0, r: 1 }, { x: 0, y: 0, sx: 0, sy: 1 }, 'cover', 0.25)).toBeUndefined()
	})

	it('derives a rounded rectangle on either side of the true shape', () => {
		const radii: RoundedRectRadii = { topLeft: { rx: 20, ry: 20 }, topRight: { rx: 20, ry: 20 }, bottomRight: { rx: 20, ry: 20 }, bottomLeft: { rx: 20, ry: 20 } }
		const rectangle = { x: 0, y: 0, width: 100, height: 60 }
		const cover = roundedRectShape(rectangle, radii, 'cover', 0.2)!
		const contain = roundedRectShape(rectangle, radii, 'contain', 0.2)!
		expect(totalArea(cover)).toBeGreaterThan(totalArea(contain))
		// The true area is 100 * 60 - (4 - pi) * 20^2.
		const truth = 100 * 60 - (4 - Math.PI) * 400
		expect(totalArea(cover)).toBeGreaterThan(truth - 1e-9)
		expect(totalArea(contain)).toBeLessThan(truth + 1e-9)
		expect(totalArea(cover) - totalArea(contain)).toBeLessThan(2 * 0.2 * 2 * (100 + 60) + 1)
	})
})

describe('Polygon algebra', () => {
	const box = rectangleShape(0, 0, 100, 100)

	it('subtracts a corner cut into one piece, a crossing band into two, and drops the hole of an interior cut', () => {
		const corner = outerRings(subtractShapes(box, [rectangleShape(0, 0, 50, 50)])!)!
		expect(corner).toHaveLength(1)
		expect(areaOf(corner[0]!)).toBe(7500)
		const band = outerRings(subtractShapes(box, [rectangleShape(-10, 40, 110, 60)])!)!
		expect(band.map(areaOf).sort()).toEqual([4000, 4000])
		const interior = subtractShapes(box, [rectangleShape(20, 20, 50, 50)])!
		expect(interior.polygons[0]!).toHaveLength(2)
		const rings = outerRings(interior)!
		expect(rings).toHaveLength(1)
		expect(areaOf(rings[0]!)).toBe(10000)
		expect(outerRings(subtractShapes(box, [rectangleShape(-1, -1, 101, 101)])!)).toEqual([])
	})

	it('survives a cut that shares an edge with the base and a cut that only touches it', () => {
		const flush = outerRings(subtractShapes(box, [rectangleShape(0, 0, 100, 30)])!)!
		expect(flush).toHaveLength(1)
		expect(areaOf(flush[0]!)).toBe(7000)
		const touching = outerRings(subtractShapes(box, [rectangleShape(100, 0, 150, 100)])!)!
		expect(areaOf(touching[0]!)).toBe(10000)
	})

	it('carries the largest approximation error of its inputs and intersects and unites shapes', () => {
		const approximate: PolygonShape = ringShape([[10, 10], [60, 10], [60, 60], [10, 60]], 0.3)
		const result = subtractShapes(intersectShapes(box, [approximate])!, [ringShape([[0, 0], [20, 0], [20, 20], [0, 20]], 0.45)])!
		expect(result.maxError).toBe(0.45)
		expect(totalArea(result)).toBe(2500 - 100)
		expect(totalArea(unionShapes([rectangleShape(0, 0, 10, 10), rectangleShape(5, 0, 20, 10)])!)).toBe(200)
		expect(unionShapes([])).toBeUndefined()
		expect(intersectShapes(box, [])).toBe(box)
		expect(subtractShapes(box, [])).toBe(box)
	})

	it('rejects a ring that cannot be a contour instead of repairing it', () => {
		expect(outerRings({ polygons: [[[[0, 0], [10, 0], [10, 10], [0, 10], [10, 0]]]], maxError: 0 })).toBeUndefined()
		expect(outerRings({ polygons: [[[[0, 0], [10, 0], [20, 0]]]], maxError: 0 })).toBeUndefined()
		expect(outerRings({ polygons: [[[[0, 0], [10, 0]]]], maxError: 0 })).toBeUndefined()
		expect(subtractShapes(box, [{ polygons: [[[[Number.NaN, 0], [1, 0], [1, 1]]]], maxError: 0 }])).toBeUndefined()
	})

	it('tells a simple ring from a crossing, touching or degenerate one', () => {
		expect(isSimpleRing([[0, 0], [10, 0], [10, 10], [0, 10]])).toBe(true)
		expect(isSimpleRing([[0, 0], [10, 10], [10, 0], [0, 10]])).toBe(false)
		expect(isSimpleRing([[0, 0], [10, 0], [5, 0], [5, 5]])).toBe(false)
		expect(isSimpleRing([[0, 0], [10, 0], [10, 10], [5, 0], [0, 10]])).toBe(false)
		expect(isSimpleRing([[0, 0], [10, 0], [20, 0]])).toBe(false)
		expect(isSimpleRing([[0, 0], [10, 0]])).toBe(false)
	})
})
