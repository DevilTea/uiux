import { describe, expect, it } from 'vitest'

import {
	approximateEllipseContour,
	approximateRoundedRectContour,
	type RoundedRectRadii,
} from '../src/preview/rounded-contour'
import { validateGeometryMessage, type Contour, type Point, type WidgetRect } from '../src/preview/protocol/schema'

describe('Preview rounded contour approximation', () => {
	it('approximates a circle with cubic commands under the requested conservative bound', () => {
		const result = approximateEllipseContour({ cx: 50, cy: 50, rx: 40, ry: 40 }, 0.25)
		expect(result).toBeDefined()
		expect(result!.maxError).toBeGreaterThan(0)
		expect(result!.maxError).toBeLessThanOrEqual(0.25)
		expect(result!.contour.commands[0]).toEqual({ op: 'moveTo', x: 90, y: 50 })
		expect(result!.contour.commands.at(-1)).toEqual({ op: 'close' })
		expect(result!.contour.commands.slice(1, -1).every(command => command.op === 'cubicBezierTo')).toBe(true)
		expectProtocolValid(rect(10, 10, 80, 80), result!.contour, result!.maxError)
		expectEllipseSamplesWithinReportedError(result!.contour, { cx: 50, cy: 50, rx: 40, ry: 40 }, result!.maxError)
	})

	it('uses max ellipse radius as a conservative affine amplification bound', () => {
		const ellipse = { cx: 0, cy: 0, rx: 120, ry: 7 }
		const result = approximateEllipseContour(ellipse, 0.1)
		expect(result).toBeDefined()
		expect(result!.maxError).toBeLessThanOrEqual(0.1)
		expectEllipseSamplesWithinReportedError(result!.contour, ellipse, result!.maxError)
		expectProtocolValid(rect(-120, -7, 240, 14), result!.contour, result!.maxError)
	})

	it('normalizes oversized CSS corner radii before generating the rounded rectangle', () => {
		const result = approximateRoundedRectContour(
			rect(0, 0, 100, 40),
			uniformRadii(80, 30),
			0.2,
		)
		expect(result).toBeDefined()
		expect(result!.maxError).toBeLessThanOrEqual(0.2)
		const first = result!.contour.commands[0]
		expect(first).toEqual({ op: 'moveTo', x: 50, y: 0 })
		expectProtocolValid(rect(0, 0, 100, 40), result!.contour, result!.maxError)
	})

	it('keeps rounded-rectangle corner chords inside an independent exact-rational error oracle', () => {
		const rectangle = rect(0, 0, 100, 60)
		const result = approximateRoundedRectContour(
			rectangle,
			uniformRadii(20, 10),
			0.2,
		)
		expect(result).toBeDefined()
		expectRoundedRectSamplesWithinReportedError(
			result!.contour,
			rectangle,
			{ rx: 20, ry: 10 },
			result!.maxError,
		)
		expectProtocolValid(rectangle, result!.contour, result!.maxError)
	})

	it('treats a corner with either zero radius as a square corner and omits zero-length lines', () => {
		const result = approximateRoundedRectContour(
			rect(0, 0, 20, 10),
			{
				topLeft: { rx: 4, ry: 0 },
				topRight: { rx: 0, ry: 4 },
				bottomRight: { rx: 3, ry: 2 },
				bottomLeft: { rx: 0, ry: 0 },
			},
			0.25,
		)
		expect(result).toBeDefined()
		expect(result!.contour.commands.some(command => command.op === 'cubicBezierTo')).toBe(true)
		assertNoZeroLengthLineCommands(result!.contour)
		expectProtocolValid(rect(0, 0, 20, 10), result!.contour, result!.maxError)
	})

	it('applies the CSS overlap factor before a zero-axis corner becomes square', () => {
		const result = approximateRoundedRectContour(
			rect(0, 0, 100, 100),
			{
				topLeft: { rx: 100, ry: 0 },
				topRight: { rx: 100, ry: 100 },
				bottomRight: { rx: 0, ry: 0 },
				bottomLeft: { rx: 0, ry: 0 },
			},
			0.25,
		)
		expect(result).toBeDefined()
		expect(result!.contour.commands[0]).toEqual({ op: 'moveTo', x: 50, y: 0 })
		expectProtocolValid(rect(0, 0, 100, 100), result!.contour, result!.maxError)
	})

	it('returns a rectangle contour with only the conservative numeric allowance when every corner is square', () => {
		const result = approximateRoundedRectContour(rect(2, 3, 8, 5), uniformRadii(0, 0), 0.001)
		expect(result).toBeDefined()
		expect(result!.contour).toEqual({
			commands: [
				{ op: 'moveTo', x: 10, y: 3 },
				{ op: 'lineTo', x: 10, y: 8 },
				{ op: 'lineTo', x: 2, y: 8 },
				{ op: 'lineTo', x: 2, y: 3 },
				{ op: 'close' },
			],
		})
		expect(result!.maxError).toBeGreaterThan(0)
		expect(result!.maxError).toBeLessThanOrEqual(0.001)
		expectProtocolValid(rect(2, 3, 8, 5), result!.contour, result!.maxError)
	})

	it('supports a fully rounded pill/circle topology without protocol-invalid zero-length commands', () => {
		const result = approximateRoundedRectContour(rect(0, 0, 20, 20), uniformRadii(10, 10), 0.2)
		expect(result).toBeDefined()
		assertNoZeroLengthLineCommands(result!.contour)
		expectProtocolValid(rect(0, 0, 20, 20), result!.contour, result!.maxError)
	})

	it('keeps fully rounded pill dimensions protocol-valid at awkward floating widths', () => {
		for (const width of [
			13.300000000000008,
			20.200000000000024,
			22.30000000000003,
		]) {
			const result = approximateRoundedRectContour(
				rect(0, 0, width, 40),
				uniformRadii(width / 2, 20),
				0.25,
			)
			expect(result, String(width)).toBeDefined()
			expectProtocolValid(rect(0, 0, width, 40), result!.contour, result!.maxError)
		}
	})

	it('keeps actual edge coordinates ordered after nonzero-origin rounding', () => {
		const rectangle = rect(10.5, 20.25, 1, 3.333333333333333)
		const result = approximateRoundedRectContour(
			rectangle,
			uniformRadii(0.5, 3.333333333333333 / 2),
			0.25,
		)
		expect(result).toBeDefined()
		expectProtocolValid(rectangle, result!.contour, result!.maxError)
	})

	it('keeps actual edge coordinates ordered for asymmetric radii after shared scaling', () => {
		const width = 0.30000000000000004
		const height = 0.30000000000000004
		const rectangle = rect(0, 0, width, height)
		const result = approximateRoundedRectContour(
			rectangle,
			{
				topLeft: { rx: width * 0.9, ry: height * 0.1 },
				topRight: { rx: width * 0.2, ry: height * 0.8 },
				bottomRight: { rx: width * 0.7, ry: height * 0.3 },
				bottomLeft: { rx: width * 0.4, ry: height * 0.6 },
			},
			0.25,
		)
		expect(result).toBeDefined()
		expectProtocolValid(rectangle, result!.contour, result!.maxError)
	})

	it('keeps deterministic nonzero-origin asymmetric rounded rectangles protocol-valid', () => {
		let state = 0x6d2b79f5
		const next = () => {
			state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0
			return state / 0x1_0000_0000
		}

		for (let index = 0; index < 200; index++) {
			const width = 1 + next() * 79
			const height = 1 + next() * 79
			const rectangle = rect(
				-50 + next() * 100,
				-50 + next() * 100,
				width,
				height,
			)
			const radii: RoundedRectRadii = {
				topLeft: { rx: next() * width * 2, ry: next() * height * 2 },
				topRight: { rx: next() * width * 2, ry: next() * height * 2 },
				bottomRight: { rx: next() * width * 2, ry: next() * height * 2 },
				bottomLeft: { rx: next() * width * 2, ry: next() * height * 2 },
			}
			const result = approximateRoundedRectContour(rectangle, radii, 0.5)
			expect(result, `case ${index}`).toBeDefined()
			expectProtocolValid(rectangle, result!.contour, result!.maxError)
		}
	})

	it('tightens the reported error and increases contour detail for a stricter target', () => {
		const loose = approximateEllipseContour({ cx: 0, cy: 0, rx: 100, ry: 50 }, 1)
		const tight = approximateEllipseContour({ cx: 0, cy: 0, rx: 100, ry: 50 }, 0.1)
		expect(loose).toBeDefined()
		expect(tight).toBeDefined()
		expect(tight!.maxError).toBeLessThanOrEqual(0.1)
		expect(tight!.maxError).toBeLessThan(loose!.maxError)
		expect(tight!.contour.commands.length).toBeGreaterThan(loose!.contour.commands.length)
	})

	it('nudges the shared CSS radius scale downward until rounded sums fit the actual extents', () => {
		const width = 301.08992382884026
		const result = approximateRoundedRectContour(
			rect(0, 0, width, 1000),
			{
				topLeft: { rx: 941.5291731711477, ry: 1 },
				topRight: { rx: 83.04067747667432, ry: 1 },
				bottomRight: { rx: 0, ry: 0 },
				bottomLeft: { rx: 0, ry: 0 },
			},
			0.25,
		)
		expect(result).toBeDefined()
		const first = result!.contour.commands[0]
		const lastDrawing = result!.contour.commands.at(-2)
		expect(first?.op).toBe('moveTo')
		expect(lastDrawing?.op).toBe('cubicBezierTo')
		if (first?.op === 'moveTo' && lastDrawing?.op === 'cubicBezierTo')
			expect(lastDrawing.x).toBeLessThanOrEqual(first.x)
		expectProtocolValid(rect(0, 0, width, 1000), result!.contour, result!.maxError)
	})

	it('fails closed instead of turning overflowed radius normalization into square corners', () => {
		expect(approximateRoundedRectContour(
			rect(0, 0, 100, 40),
			uniformRadii(1e308, 1e308),
			0.25,
		)).toBeUndefined()
	})

	it('fails closed when a nonzero normalized radius would underflow to zero', () => {
		expect(approximateRoundedRectContour(
			rect(0, 0, 1e-200, 1e-200),
			uniformRadii(1e308, 1e308),
			0.25,
		)).toBeUndefined()
	})

	it('fails closed when coordinate quantization already exceeds the requested precision', () => {
		expect(approximateEllipseContour(
			{ cx: 1e15, cy: 1e15, rx: 100, ry: 100 },
			1e-6,
		)).toBeUndefined()
	})

	it('fails closed when even square-corner coordinate arithmetic cannot meet the requested bound', () => {
		expect(approximateRoundedRectContour(
			rect(1e15, 1e15, 100, 100),
			uniformRadii(0, 0),
			1e-6,
		)).toBeUndefined()
	})

	it('fails closed for non-finite, negative, degenerate, or infeasibly precise inputs', () => {
		expect(approximateEllipseContour({ cx: 0, cy: 0, rx: 0, ry: 1 }, 0.1)).toBeUndefined()
		expect(approximateEllipseContour({ cx: 0, cy: 0, rx: -1, ry: 1 }, 0.1)).toBeUndefined()
		expect(approximateEllipseContour({ cx: Number.NaN, cy: 0, rx: 1, ry: 1 }, 0.1)).toBeUndefined()
		expect(approximateEllipseContour({ cx: 0, cy: 0, rx: 1, ry: 1 }, 0)).toBeUndefined()
		expect(approximateEllipseContour({ cx: 0, cy: 0, rx: 1, ry: 1 }, Number.MIN_VALUE)).toBeUndefined()
		expect(approximateRoundedRectContour(rect(0, 0, 0, 10), uniformRadii(2, 2), 0.1)).toBeUndefined()
		expect(approximateRoundedRectContour(rect(0, 0, 10, 10), {
			...uniformRadii(2, 2),
			topLeft: { rx: -1, ry: 2 },
		}, 0.1)).toBeUndefined()
	})

	it('returns deeply frozen protocol-owned geometry', () => {
		const result = approximateRoundedRectContour(rect(0, 0, 20, 10), uniformRadii(3, 3), 0.25)
		expect(result).toBeDefined()
		expect(Object.isFrozen(result)).toBe(true)
		expect(Object.isFrozen(result!.contour)).toBe(true)
		expect(Object.isFrozen(result!.contour.commands)).toBe(true)
		expect(result!.contour.commands.every(Object.isFrozen)).toBe(true)
	})
})

function expectProtocolValid(rectangle: WidgetRect, contour: Contour, maxError: number): void {
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
			regions: [{ regionId: 'region-a', contour, maxError }],
		},
	})
	if (!result.ok) throw new Error(JSON.stringify(result.diagnostics))
}

function expectEllipseSamplesWithinReportedError(
	contour: Contour,
	ellipse: Readonly<{ cx: number; cy: number; rx: number; ry: number }>,
	reportedError: number,
): void {
	const wireSegments = exactCubicWireSegments(contour)
	expect(wireSegments.length).toBeGreaterThan(0)
	expect(wireSegments.length % 4).toBe(0)
	const quarterSegments = wireSegments.length / 4

	const error = exactNumber(reportedError)
	const errorSquared = multiply(error, error)
	const orientations = ['right-bottom', 'bottom-left', 'left-top', 'top-right'] as const

	// Independent high-precision reference oracle: true ellipse samples are
	// constructed as exact BigInt rationals, and their squared distance to the
	// actual IEEE-754 wire chords is compared without floating-point arithmetic.
	// Thirty-one interior rational-parameter samples per production chord
	// exercise each quarter without reusing the production error-bound
	// implementation. The denser reference grid matters for highly anisotropic
	// ellipses, whose maximum chord deviation need not occur at t=1/2.
	for (let quarter = 0; quarter < 4; quarter++) {
		for (let segment = 0; segment < quarterSegments; segment++) {
			for (let subdivision = 1; subdivision < 32; subdivision++) {
				const denominator = BigInt(32 * quarterSegments)
				const numerator = BigInt(32 * segment + subdivision)
				const truePoint = exactEllipsePoint(ellipse, orientations[quarter]!, numerator, denominator)
				const wire = wireSegments[quarter * quarterSegments + segment]!
				const distanceSquared = exactPointToSegmentDistanceSquared(truePoint, wire.from, wire.to)
				expect(compare(distanceSquared, errorSquared)).toBeLessThanOrEqual(0)
			}
		}
	}
}

function expectRoundedRectSamplesWithinReportedError(
	contour: Contour,
	rectangle: WidgetRect,
	radius: Readonly<{ rx: number; ry: number }>,
	reportedError: number,
): void {
	const wireSegments = exactCubicWireSegments(contour)
	expect(wireSegments.length).toBeGreaterThan(0)
	expect(wireSegments.length % 4).toBe(0)
	const quarterSegments = wireSegments.length / 4
	const right = rectangle.x + rectangle.width
	const bottom = rectangle.y + rectangle.height
	const corners = [
		{
			ellipse: { cx: right - radius.rx, cy: rectangle.y + radius.ry, ...radius },
			orientation: 'top-right' as const,
		},
		{
			ellipse: { cx: right - radius.rx, cy: bottom - radius.ry, ...radius },
			orientation: 'right-bottom' as const,
		},
		{
			ellipse: { cx: rectangle.x + radius.rx, cy: bottom - radius.ry, ...radius },
			orientation: 'bottom-left' as const,
		},
		{
			ellipse: { cx: rectangle.x + radius.rx, cy: rectangle.y + radius.ry, ...radius },
			orientation: 'left-top' as const,
		},
	] as const
	const errorSquared = multiply(exactNumber(reportedError), exactNumber(reportedError))

	for (let corner = 0; corner < corners.length; corner++) {
		const reference = corners[corner]!
		for (let segment = 0; segment < quarterSegments; segment++) {
			for (let subdivision = 1; subdivision < 32; subdivision++) {
				const denominator = BigInt(32 * quarterSegments)
				const numerator = BigInt(32 * segment + subdivision)
				const truePoint = exactEllipsePoint(
					reference.ellipse,
					reference.orientation,
					numerator,
					denominator,
				)
				const wire = wireSegments[corner * quarterSegments + segment]!
				const distanceSquared = exactPointToSegmentDistanceSquared(truePoint, wire.from, wire.to)
				expect(compare(distanceSquared, errorSquared)).toBeLessThanOrEqual(0)
			}
		}
	}
}

function exactCubicWireSegments(
	contour: Contour,
): Array<Readonly<{ from: ExactPoint; to: ExactPoint }>> {
	const segments: Array<Readonly<{ from: ExactPoint; to: ExactPoint }>> = []
	let current = exactPoint(readMoveTo(contour))
	for (const command of contour.commands.slice(1)) {
		if (command.op === 'lineTo') {
			current = exactPoint({ x: command.x, y: command.y })
			continue
		}
		if (command.op === 'cubicBezierTo') {
			const to = exactPoint({ x: command.x, y: command.y })
			segments.push({ from: current, to })
			current = to
		}
	}
	return segments
}

type Rational = Readonly<{ n: bigint; d: bigint }>
type ExactPoint = Readonly<{ x: Rational; y: Rational }>

function exactEllipsePoint(
	ellipse: Readonly<{ cx: number; cy: number; rx: number; ry: number }>,
	orientation: 'right-bottom' | 'bottom-left' | 'left-top' | 'top-right',
	tNumerator: bigint,
	tDenominator: bigint,
): ExactPoint {
	const n2 = tDenominator * tDenominator
	const i2 = tNumerator * tNumerator
	const denominator = n2 + i2
	const x = rational(n2 - i2, denominator)
	const y = rational(2n * tNumerator * tDenominator, denominator)
	const cx = exactNumber(ellipse.cx)
	const cy = exactNumber(ellipse.cy)
	const rx = exactNumber(ellipse.rx)
	const ry = exactNumber(ellipse.ry)

	switch (orientation) {
		case 'right-bottom':
			return { x: add(cx, multiply(rx, x)), y: add(cy, multiply(ry, y)) }
		case 'bottom-left':
			return { x: subtract(cx, multiply(rx, y)), y: add(cy, multiply(ry, x)) }
		case 'left-top':
			return { x: subtract(cx, multiply(rx, x)), y: subtract(cy, multiply(ry, y)) }
		case 'top-right':
			return { x: add(cx, multiply(rx, y)), y: subtract(cy, multiply(ry, x)) }
	}
}

function exactPointToSegmentDistanceSquared(point: ExactPoint, from: ExactPoint, to: ExactPoint): Rational {
	const dx = subtract(to.x, from.x)
	const dy = subtract(to.y, from.y)
	const px = subtract(point.x, from.x)
	const py = subtract(point.y, from.y)
	const lengthSquared = add(multiply(dx, dx), multiply(dy, dy))
	const projectionNumerator = add(multiply(px, dx), multiply(py, dy))
	if (compare(projectionNumerator, ZERO) <= 0)
		return add(multiply(px, px), multiply(py, py))
	if (compare(projectionNumerator, lengthSquared) >= 0) {
		const ex = subtract(point.x, to.x)
		const ey = subtract(point.y, to.y)
		return add(multiply(ex, ex), multiply(ey, ey))
	}
	const pointDistanceSquared = add(multiply(px, px), multiply(py, py))
	return subtract(
		pointDistanceSquared,
		divide(multiply(projectionNumerator, projectionNumerator), lengthSquared),
	)
}

const ZERO: Rational = { n: 0n, d: 1n }

function exactPoint(point: Point): ExactPoint {
	return { x: exactNumber(point.x), y: exactNumber(point.y) }
}

function exactNumber(value: number): Rational {
	if (value === 0) return ZERO
	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)
	view.setFloat64(0, value, false)
	const bits = view.getBigUint64(0, false)
	const negative = (bits >> 63n) === 1n
	const exponentBits = Number((bits >> 52n) & 0x7ffn)
	const fractionBits = bits & ((1n << 52n) - 1n)
	const significand = exponentBits === 0 ? fractionBits : (1n << 52n) + fractionBits
	const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52
	let numerator = negative ? -significand : significand
	let denominator = 1n
	if (exponent >= 0) numerator <<= BigInt(exponent)
	else denominator <<= BigInt(-exponent)
	return rational(numerator, denominator)
}

function rational(n: bigint, d: bigint): Rational {
	if (d <= 0n) throw new RangeError('Expected a positive denominator')
	return { n, d }
}

function add(left: Rational, right: Rational): Rational {
	return rational(left.n * right.d + right.n * left.d, left.d * right.d)
}

function subtract(left: Rational, right: Rational): Rational {
	return rational(left.n * right.d - right.n * left.d, left.d * right.d)
}

function multiply(left: Rational, right: Rational): Rational {
	return rational(left.n * right.n, left.d * right.d)
}

function divide(left: Rational, right: Rational): Rational {
	if (right.n === 0n) throw new RangeError('Division by zero')
	const sign = right.n < 0n ? -1n : 1n
	return rational(left.n * right.d * sign, left.d * right.n * sign)
}

function compare(left: Rational, right: Rational): number {
	const difference = left.n * right.d - right.n * left.d
	return difference < 0n ? -1 : difference > 0n ? 1 : 0
}

function readMoveTo(contour: Contour): Point {
	const first = contour.commands[0]
	if (!first || first.op !== 'moveTo') throw new Error('Expected moveTo')
	return { x: first.x, y: first.y }
}

function assertNoZeroLengthLineCommands(contour: Contour): void {
	let current = readMoveTo(contour)
	for (const command of contour.commands.slice(1)) {
		if (command.op === 'lineTo') {
			expect(command.x === current.x && command.y === current.y).toBe(false)
			current = { x: command.x, y: command.y }
		}
		else if (command.op === 'cubicBezierTo') current = { x: command.x, y: command.y }
	}
}

function rect(x: number, y: number, width: number, height: number): WidgetRect {
	return { x, y, width, height }
}

function uniformRadii(rx: number, ry: number): RoundedRectRadii {
	return {
		topLeft: { rx, ry },
		topRight: { rx, ry },
		bottomRight: { rx, ry },
		bottomLeft: { rx, ry },
	}
}
