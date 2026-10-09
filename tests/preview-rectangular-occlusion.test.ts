import { describe, expect, it } from 'vitest'

import { subtractAxisAlignedRectangularOcclusion } from '../src/preview/rectangular-occlusion'
import { validateGeometryMessage, type Contour, type WidgetRect } from '../src/preview/protocol/schema'

const target = rect(0, 0, 10, 10)

describe('Preview exact rectangular occlusion subtraction', () => {
	it('returns the exact target outline when no positive-area occluder intersects it', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(20, 20, 5, 5),
			rect(10, 2, 3, 3),
			rect(5, 5, 0, 4),
		])
		expect(contours).toEqual([contour([
			[0, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('returns no visible contour when opaque rectangles cover the whole target', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(-5, -5, 20, 20),
		])
		expect(contours).toEqual([])
		expectProtocolValid(target, contours)
	})

	it('omits a fully interior hole contour and preserves only the surviving piece outermost boundary', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(2, 2, 6, 6),
		])
		expect(contours).toEqual([contour([
			[0, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('ignores corner-touching interior hole boundaries when deriving the outermost contour', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(2, 2, 2, 2),
			rect(4, 4, 2, 2),
		])
		expect(contours).toEqual([contour([
			[0, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('keeps an exterior notch exact while omitting complex enclosed hole boundaries', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(3, -2, 4, 3),
			rect(2, 3, 2, 2),
			rect(4, 5, 2, 2),
		])
		expect(contours).toEqual([contour([
			[0, 0], [3, 0], [3, 1], [7, 1], [7, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('includes precise cut edges for a boundary notch without emitting internal grid seams', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(3, -2, 4, 6),
		])
		expect(contours).toEqual([contour([
			[0, 0], [3, 0], [3, 4], [7, 4], [7, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('emits every disconnected surviving piece when an opaque strip splits the target', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(4, -5, 2, 20),
		])
		expect(contours).toEqual([
			contour([[0, 0], [4, 0], [4, 10], [0, 10]]),
			contour([[6, 0], [10, 0], [10, 10], [6, 10]]),
		])
		expectProtocolValid(target, contours)
	})

	it('subtracts overlapping rectangles as one exact union and can isolate an interior visible piece', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(0, 0, 10, 2),
			rect(0, 8, 10, 2),
			rect(0, 2, 2, 6),
			rect(8, 2, 2, 6),
			rect(0, 0, 3, 2),
		])
		expect(contours).toEqual([contour([
			[2, 2], [8, 2], [8, 8], [2, 8],
		])])
		expectProtocolValid(target, contours)
	})

	it('keeps diagonal-only visible pieces as separate valid contours', () => {
		const smallTarget = rect(0, 0, 2, 2)
		const contours = subtractAxisAlignedRectangularOcclusion(smallTarget, [
			rect(1, 0, 1, 1),
			rect(0, 1, 1, 1),
		])
		expect(contours).toEqual([
			contour([[0, 0], [1, 0], [1, 1], [0, 1]]),
			contour([[1, 1], [2, 1], [2, 2], [1, 2]]),
		])
		expectProtocolValid(smallTarget, contours)
	})

	it('emits all four surviving pieces when crossing strips divide the target', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(4, -1, 2, 12),
			rect(-1, 4, 12, 2),
		])
		expect(contours).toEqual([
			contour([[0, 0], [4, 0], [4, 4], [0, 4]]),
			contour([[6, 0], [10, 0], [10, 4], [6, 4]]),
			contour([[0, 6], [4, 6], [4, 10], [0, 10]]),
			contour([[6, 6], [10, 6], [10, 10], [6, 10]]),
		])
		expectProtocolValid(target, contours)
	})

	it('preserves exact subpixel CSS coordinates without integer snapping', () => {
		const subpixelTarget = rect(0.125, 0.25, 1, 1)
		const contours = subtractAxisAlignedRectangularOcclusion(subpixelTarget, [
			rect(0.375, 0, 0.25, 0.5),
		])
		expect(contours).toEqual([contour([
			[0.125, 0.25], [0.375, 0.25], [0.375, 0.5], [0.625, 0.5],
			[0.625, 0.25], [1.125, 0.25], [1.125, 1.25], [0.125, 1.25],
		])])
		expectProtocolValid(subpixelTarget, contours)
	})

	it('merges adjacent collinear occluders without leaving artificial contour vertices', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(2, -1, 2, 3),
			rect(4, -1, 2, 3),
		])
		expect(contours).toEqual([contour([
			[0, 0], [2, 0], [2, 2], [6, 2], [6, 0], [10, 0], [10, 10], [0, 10],
		])])
		expectProtocolValid(target, contours)
	})

	it('handles multiple cuts without order-dependent occlusion semantics', () => {
		const leftThenTop = subtractAxisAlignedRectangularOcclusion(target, [
			rect(-1, 3, 5, 4),
			rect(6, -1, 5, 5),
		])
		const topThenLeft = subtractAxisAlignedRectangularOcclusion(target, [
			rect(6, -1, 5, 5),
			rect(-1, 3, 5, 4),
		])
		expect(leftThenTop).toEqual(topThenLeft)
		expectProtocolValid(target, leftThenTop)
	})

	it('fails closed for invalid or numerically unrepresentable rectangles', () => {
		expect(subtractAxisAlignedRectangularOcclusion(
			{ x: 0, y: 0, width: -1, height: 1 },
			[],
		)).toBeUndefined()
		expect(subtractAxisAlignedRectangularOcclusion(
			{ x: Number.MAX_VALUE, y: 0, width: Number.MAX_VALUE, height: 1 },
			[],
		)).toBeUndefined()
		expect(subtractAxisAlignedRectangularOcclusion(
			target,
			[{ x: Number.NaN, y: 0, width: 1, height: 1 }],
		)).toBeUndefined()
		expect(subtractAxisAlignedRectangularOcclusion(
			{ x: 1e308, y: 0, width: 1, height: 1 },
			[],
		)).toBeUndefined()
	})

	it('returns an empty exact result for a zero-area target', () => {
		expect(subtractAxisAlignedRectangularOcclusion(rect(1, 2, 0, 4), [])).toEqual([])
		expect(subtractAxisAlignedRectangularOcclusion(rect(1, 2, 4, 0), [])).toEqual([])
	})

	it('returns frozen contours and command arrays owned by the result', () => {
		const contours = subtractAxisAlignedRectangularOcclusion(target, [
			rect(4, -5, 2, 20),
		])
		expect(Object.isFrozen(contours)).toBe(true)
		expect(contours).toBeDefined()
		for (const item of contours ?? []) {
			expect(Object.isFrozen(item)).toBe(true)
			expect(Object.isFrozen(item.commands)).toBe(true)
			expect(item.commands.every(Object.isFrozen)).toBe(true)
		}
	})
})

function rect(x: number, y: number, width: number, height: number): WidgetRect {
	return { x, y, width, height }
}

function contour(points: readonly (readonly [number, number])[]): Contour {
	return {
		commands: [
			{ op: 'moveTo', x: points[0]![0], y: points[0]![1] },
			...points.slice(1).map(([x, y]) => ({ op: 'lineTo' as const, x, y })),
			{ op: 'close' },
		],
	}
}

function expectProtocolValid(rectangle: WidgetRect, contours: readonly Contour[] | undefined): void {
	expect(contours).toBeDefined()
	if (!contours) return
	const result = validateGeometryMessage({
		type: 'geometry.acquire.response',
		context: {
			previewSessionId: 'session-a',
			runtimeGenerationId: 'generation-a',
			viewId: '11111111-1111-4111-8111-111111111111',
			widgetId: 'widget-a',
			geometryRevision: 1,
		},
		payload: {
			rect: rectangle,
			regions: contours.map((item, index) => ({
				regionId: 'region-' + index,
				contour: item,
				maxError: 0,
			})),
		},
	})
	expect(result.ok, result.ok ? undefined : JSON.stringify(result.diagnostics)).toBe(true)
}
