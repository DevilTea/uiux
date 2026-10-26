import type { Contour, ContourCommand, Point, WidgetRect } from './protocol/schema'

export type EllipseGeometry = Readonly<{
	cx: number
	cy: number
	rx: number
	ry: number
}>

export type CornerRadius = Readonly<{ rx: number; ry: number }>

export type RoundedRectRadii = Readonly<{
	topLeft: CornerRadius
	topRight: CornerRadius
	bottomRight: CornerRadius
	bottomLeft: CornerRadius
}>

export type ApproximatedContour = Readonly<{
	contour: Contour
	maxError: number
}>

const MAX_ARC_SEGMENTS_PER_QUADRANT = 65_536
const NUMERIC_ERROR_FACTOR = 1024 * Number.EPSILON

/**
 * Produces a closed cubic contour for an axis-aligned ellipse.
 *
 * Each circular/elliptical arc is represented by line-equivalent cubic Bézier
 * chords. Quarter-circle sample points use the exact rational parametrization
 * x=(1-t^2)/(1+t^2), y=2t/(1+t^2) with t=i/n, so production does not depend on
 * transcendental libm accuracy. Because d(2*atan(t))/dt <= 2, each chord spans
 * at most 2/n radians. Unit-circle sagitta is therefore <= 1/(2*n^2), and the
 * ellipse affine scale amplifies that Euclidean error by at most max(rx, ry).
 */
export function approximateEllipseContour(
	ellipse: EllipseGeometry,
	targetMaxError: number,
): ApproximatedContour | undefined {
	if (!validTargetMaxError(targetMaxError) || !validEllipse(ellipse)) return undefined
	if (ellipse.rx === 0 || ellipse.ry === 0) return undefined

	const numericError = coordinateNumericError([
		ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry,
		ellipse.cx - ellipse.rx,
		ellipse.cx + ellipse.rx,
		ellipse.cy - ellipse.ry,
		ellipse.cy + ellipse.ry,
	])
	const plan = planQuarterArc(Math.max(ellipse.rx, ellipse.ry), targetMaxError, numericError)
	if (!plan) return undefined

	const start = point(ellipse.cx + ellipse.rx, ellipse.cy)
	const commands: ContourCommand[] = [Object.freeze({ op: 'moveTo', ...start })]
	let current = start
	const quarters = [
		{ orientation: 'right-bottom', end: point(ellipse.cx, ellipse.cy + ellipse.ry) },
		{ orientation: 'bottom-left', end: point(ellipse.cx - ellipse.rx, ellipse.cy) },
		{ orientation: 'left-top', end: point(ellipse.cx, ellipse.cy - ellipse.ry) },
		{ orientation: 'top-right', end: start },
	] as const

	for (const quarter of quarters) {
		const appended = appendEllipseArc(
			commands,
			current,
			ellipse,
			quarter.orientation,
			plan.segments,
			quarter.end,
		)
		if (!appended) return undefined
		current = appended
	}
	commands.push(Object.freeze({ op: 'close' }))

	return freezeResult(commands, plan.reportedError)
}

/**
 * Produces a closed contour for a CSS-style rounded rectangle after applying
 * the standard radius-overlap scaling rule. Corners with either zero radius
 * are treated as square corners.
 */
export function approximateRoundedRectContour(
	rect: WidgetRect,
	radii: RoundedRectRadii,
	targetMaxError: number,
): ApproximatedContour | undefined {
	const bounds = rectBounds(rect)
	if (!bounds || rect.width === 0 || rect.height === 0 || !validTargetMaxError(targetMaxError))
		return undefined
	const normalized = normalizeRadii(bounds, rect.width, rect.height, radii)
	if (!normalized) return undefined

	const numericError = coordinateNumericError([
		bounds.left, bounds.top, bounds.right, bounds.bottom,
		normalized.topLeft.rx, normalized.topLeft.ry,
		normalized.topRight.rx, normalized.topRight.ry,
		normalized.bottomRight.rx, normalized.bottomRight.ry,
		normalized.bottomLeft.rx, normalized.bottomLeft.ry,
	])
	if (numericError > targetMaxError) return undefined

	const cornerPlans = [
		planCorner(normalized.topRight, targetMaxError, numericError),
		planCorner(normalized.bottomRight, targetMaxError, numericError),
		planCorner(normalized.bottomLeft, targetMaxError, numericError),
		planCorner(normalized.topLeft, targetMaxError, numericError),
	] as const
	if (cornerPlans.some(plan => plan === undefined)) return undefined

	const start = point(bounds.right - normalized.topRight.rx, bounds.top)
	const commands: ContourCommand[] = [Object.freeze({ op: 'moveTo', ...start })]
	let current = start
	let reportedError = numericError

	const corners = [
		{
			center: point(bounds.right - normalized.topRight.rx, bounds.top + normalized.topRight.ry),
			radius: normalized.topRight,
			orientation: 'top-right',
			arcEnd: point(bounds.right, bounds.top + normalized.topRight.ry),
			plan: cornerPlans[0]!,
		},
		{
			center: point(bounds.right - normalized.bottomRight.rx, bounds.bottom - normalized.bottomRight.ry),
			radius: normalized.bottomRight,
			orientation: 'right-bottom',
			arcEnd: point(bounds.right - normalized.bottomRight.rx, bounds.bottom),
			plan: cornerPlans[1]!,
		},
		{
			center: point(bounds.left + normalized.bottomLeft.rx, bounds.bottom - normalized.bottomLeft.ry),
			radius: normalized.bottomLeft,
			orientation: 'bottom-left',
			arcEnd: point(bounds.left, bounds.bottom - normalized.bottomLeft.ry),
			plan: cornerPlans[2]!,
		},
		{
			center: point(bounds.left + normalized.topLeft.rx, bounds.top + normalized.topLeft.ry),
			radius: normalized.topLeft,
			orientation: 'left-top',
			arcEnd: point(bounds.left + normalized.topLeft.rx, bounds.top),
			plan: cornerPlans[3]!,
		},
	] as const

	for (let index = 0; index < corners.length; index++) {
		const corner = corners[index]!
		if (index > 0) {
			const lineTarget = index === 1
				? point(bounds.right, bounds.bottom - normalized.bottomRight.ry)
				: index === 2
					? point(bounds.left + normalized.bottomLeft.rx, bounds.bottom)
					: point(bounds.left, bounds.top + normalized.topLeft.ry)
			current = appendLine(commands, current, lineTarget)
		}

		if (corner.radius.rx === 0 || corner.radius.ry === 0) {
			current = appendLine(commands, current, corner.arcEnd)
			continue
		}

		const appended = appendEllipseArc(
			commands,
			current,
			{ cx: corner.center.x, cy: corner.center.y, rx: corner.radius.rx, ry: corner.radius.ry },
			corner.orientation,
			corner.plan.segments,
			corner.arcEnd,
		)
		if (!appended) return undefined
		current = appended
		reportedError = Math.max(reportedError, corner.plan.reportedError)
	}

	// The top edge is represented by close. It is exact and avoids a redundant
	// zero-length line when opposing top radii consume the entire width.
	commands.push(Object.freeze({ op: 'close' }))
	return freezeResult(commands, reportedError)
}

type Bounds = Readonly<{ left: number; top: number; right: number; bottom: number }>
type ArcPlan = Readonly<{ segments: number; reportedError: number }>

function planCorner(
	radius: CornerRadius,
	targetMaxError: number,
	numericError: number,
): ArcPlan | undefined {
	if (radius.rx === 0 || radius.ry === 0) return { segments: 0, reportedError: 0 }
	return planQuarterArc(Math.max(radius.rx, radius.ry), targetMaxError, numericError)
}

function planQuarterArc(
	maxRadius: number,
	targetMaxError: number,
	numericError: number,
): ArcPlan | undefined {
	const geometricBudget = targetMaxError - numericError
	if (!(geometricBudget > 0) || !Number.isFinite(geometricBudget)) return undefined

	const ratio = maxRadius / (2 * geometricBudget)
	if (!Number.isFinite(ratio) || ratio < 0) return undefined
	let segments = Math.max(1, Math.ceil(Math.sqrt(ratio)))
	if (!Number.isSafeInteger(segments) || segments > MAX_ARC_SEGMENTS_PER_QUADRANT) return undefined

	let reportedError = arcErrorBound(maxRadius, segments, numericError)
	while (reportedError > targetMaxError) {
		segments++
		if (segments > MAX_ARC_SEGMENTS_PER_QUADRANT) return undefined
		reportedError = arcErrorBound(maxRadius, segments, numericError)
	}
	return Object.freeze({ segments, reportedError })
}

function arcErrorBound(maxRadius: number, segments: number, numericError: number): number {
	const geometric = maxRadius / (2 * segments * segments)
	const total = geometric + numericError
	return Number.isFinite(total) ? total : Number.POSITIVE_INFINITY
}

type QuarterOrientation = 'right-bottom' | 'bottom-left' | 'left-top' | 'top-right'

function appendEllipseArc(
	commands: ContourCommand[],
	current: Point,
	ellipse: EllipseGeometry,
	orientation: QuarterOrientation,
	segments: number,
	exactEnd: Point,
): Point | undefined {
	if (segments <= 0) return undefined
	let from = current
	for (let index = 1; index <= segments; index++) {
		const next = index === segments
			? exactEnd
			: rationalQuarterPoint(ellipse, orientation, index, segments)
		if (!finitePoint(next) || samePoint(from, next)) return undefined
		commands.push(Object.freeze({
			op: 'cubicBezierTo',
			c1x: from.x,
			c1y: from.y,
			c2x: next.x,
			c2y: next.y,
			x: next.x,
			y: next.y,
		}))
		from = next
	}
	return from
}

function rationalQuarterPoint(
	ellipse: EllipseGeometry,
	orientation: QuarterOrientation,
	index: number,
	segments: number,
): Point {
	const n2 = segments * segments
	const i2 = index * index
	const denominator = n2 + i2
	const x = (n2 - i2) / denominator
	const y = (2 * segments * index) / denominator

	switch (orientation) {
		case 'right-bottom':
			return point(ellipse.cx + ellipse.rx * x, ellipse.cy + ellipse.ry * y)
		case 'bottom-left':
			return point(ellipse.cx - ellipse.rx * y, ellipse.cy + ellipse.ry * x)
		case 'left-top':
			return point(ellipse.cx - ellipse.rx * x, ellipse.cy - ellipse.ry * y)
		case 'top-right':
			return point(ellipse.cx + ellipse.rx * y, ellipse.cy - ellipse.ry * x)
	}
}

function appendLine(commands: ContourCommand[], current: Point, next: Point): Point {
	if (samePoint(current, next)) return current
	commands.push(Object.freeze({ op: 'lineTo', ...next }))
	return next
}

function normalizeRadii(
	bounds: Bounds,
	width: number,
	height: number,
	radii: RoundedRectRadii,
): RoundedRectRadii | undefined {
	const corners = [
		radii.topLeft, radii.topRight, radii.bottomRight, radii.bottomLeft,
	] as const
	if (!corners.every(validRadius)) return undefined

	const topLeft = radii.topLeft
	const topRight = radii.topRight
	const bottomRight = radii.bottomRight
	const bottomLeft = radii.bottomLeft
	const sums = [
		topLeft.rx + topRight.rx,
		bottomLeft.rx + bottomRight.rx,
		topLeft.ry + bottomLeft.ry,
		topRight.ry + bottomRight.ry,
	] as const
	if (sums.some(sum => !Number.isFinite(sum))) return undefined

	const factors = [
		ratioOrInfinity(width, sums[0]),
		ratioOrInfinity(width, sums[1]),
		ratioOrInfinity(height, sums[2]),
		ratioOrInfinity(height, sums[3]),
	]
	let scale = Math.min(1, ...factors)
	if (!Number.isFinite(scale) || scale < 0) return undefined
	if (scale === 0 && corners.some(radius => radius.rx > 0 || radius.ry > 0)) return undefined

	for (let correction = 0; correction < 64; correction++) {
		const scaled = (radius: CornerRadius): CornerRadius | undefined => {
			const rx = radius.rx * scale
			const ry = radius.ry * scale
			if (!Number.isFinite(rx) || !Number.isFinite(ry)) return undefined
			if ((radius.rx > 0 && rx === 0) || (radius.ry > 0 && ry === 0)) return undefined
			return Object.freeze({ rx, ry })
		}
		const scaledTopLeft = scaled(topLeft)
		const scaledTopRight = scaled(topRight)
		const scaledBottomRight = scaled(bottomRight)
		const scaledBottomLeft = scaled(bottomLeft)
		if (!scaledTopLeft || !scaledTopRight || !scaledBottomRight || !scaledBottomLeft) return undefined
		const scaledCssRadii = Object.freeze({
			topLeft: scaledTopLeft,
			topRight: scaledTopRight,
			bottomRight: scaledBottomRight,
			bottomLeft: scaledBottomLeft,
		})
		if (
			radiiFitExtents(width, height, scaledCssRadii)
			&& radiiFitActualBounds(bounds, scaledCssRadii)
		) {
			return Object.freeze({
				topLeft: squareZeroRadius(scaledTopLeft),
				topRight: squareZeroRadius(scaledTopRight),
				bottomRight: squareZeroRadius(scaledBottomRight),
				bottomLeft: squareZeroRadius(scaledBottomLeft),
			})
		}

		const next = nextDownPositive(scale)
		if (!(next > 0) || next === scale) return undefined
		scale = next
	}
	return undefined
}

function radiiFitExtents(width: number, height: number, radii: RoundedRectRadii): boolean {
	return radii.topLeft.rx + radii.topRight.rx <= width
		&& radii.bottomLeft.rx + radii.bottomRight.rx <= width
		&& radii.topLeft.ry + radii.bottomLeft.ry <= height
		&& radii.topRight.ry + radii.bottomRight.ry <= height
}

function radiiFitActualBounds(bounds: Bounds, radii: RoundedRectRadii): boolean {
	const topLeftEndX = bounds.left + radii.topLeft.rx
	const topRightStartX = bounds.right - radii.topRight.rx
	const bottomLeftEndX = bounds.left + radii.bottomLeft.rx
	const bottomRightStartX = bounds.right - radii.bottomRight.rx
	const topLeftEndY = bounds.top + radii.topLeft.ry
	const bottomLeftStartY = bounds.bottom - radii.bottomLeft.ry
	const topRightEndY = bounds.top + radii.topRight.ry
	const bottomRightStartY = bounds.bottom - radii.bottomRight.ry

	return [
		topLeftEndX, topRightStartX, bottomLeftEndX, bottomRightStartX,
		topLeftEndY, bottomLeftStartY, topRightEndY, bottomRightStartY,
	].every(Number.isFinite)
		&& topLeftEndX <= topRightStartX
		&& bottomLeftEndX <= bottomRightStartX
		&& topLeftEndY <= bottomLeftStartY
		&& topRightEndY <= bottomRightStartY
}

function nextDownPositive(value: number): number {
	if (!(value > 0) || !Number.isFinite(value)) return Number.NaN
	const buffer = new ArrayBuffer(8)
	const view = new DataView(buffer)
	view.setFloat64(0, value, false)
	const bits = view.getBigUint64(0, false)
	view.setBigUint64(0, bits - 1n, false)
	return view.getFloat64(0, false)
}

function ratioOrInfinity(extent: number, sum: number): number {
	return sum === 0 ? Number.POSITIVE_INFINITY : extent / sum
}

function squareZeroRadius(radius: CornerRadius): CornerRadius {
	return radius.rx === 0 || radius.ry === 0
		? Object.freeze({ rx: 0, ry: 0 })
		: radius
}

function validRadius(radius: CornerRadius): boolean {
	return Number.isFinite(radius.rx) && Number.isFinite(radius.ry)
		&& radius.rx >= 0 && radius.ry >= 0
}

function validEllipse(ellipse: EllipseGeometry): boolean {
	if (![ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry].every(Number.isFinite)) return false
	return ellipse.rx >= 0 && ellipse.ry >= 0
}

function rectBounds(rect: WidgetRect): Bounds | undefined {
	if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)
		|| rect.width < 0 || rect.height < 0)
		return undefined
	const right = rect.x + rect.width
	const bottom = rect.y + rect.height
	if (!Number.isFinite(right) || !Number.isFinite(bottom)) return undefined
	if ((rect.width > 0 && !(right > rect.x)) || (rect.height > 0 && !(bottom > rect.y)))
		return undefined
	return { left: rect.x, top: rect.y, right, bottom }
}

function validTargetMaxError(value: number): boolean {
	return Number.isFinite(value) && value > 0
}

function coordinateNumericError(values: readonly number[]): number {
	const scale = Math.max(1, ...values.map(value => Math.abs(value)))
	const error = scale * NUMERIC_ERROR_FACTOR
	return Number.isFinite(error) ? error : Number.POSITIVE_INFINITY
}

function freezeResult(commands: ContourCommand[], maxError: number): ApproximatedContour {
	return Object.freeze({
		contour: Object.freeze({ commands: Object.freeze(commands) }),
		maxError,
	})
}

function point(x: number, y: number): Point {
	return Object.freeze({ x, y })
}

function finitePoint(value: Point): boolean {
	return Number.isFinite(value.x) && Number.isFinite(value.y)
}

function samePoint(left: Point, right: Point): boolean {
	return left.x === right.x && left.y === right.y
}

export type ApproximatedPolygon = Readonly<{
	points: readonly Point[]
	maxError: number
}>

/**
 * Produces a polygon that contains a CSS-style rounded rectangle (after the standard radius-overlap
 * scaling), for a covering shape whose approximation may only ever remove more than the shape does.
 *
 * Each corner arc is replaced by the tangent polygon of an equal-angle subdivision: every edge
 * touches the arc, so the polygon contains the arc and the straight sides are kept exactly. For a
 * unit circle and an arc step of phi = (pi/2)/n the farthest polygon point is sec(phi/2) - 1 away,
 * at most 1/(2n^2), the bound the inscribed contour of `approximateRoundedRectContour` plans with,
 * and an ellipse corner maps that distance by at most max(rx, ry) under its affine scaling.
 */
export function approximateRoundedRectOuterPolygon(
	rect: WidgetRect,
	radii: RoundedRectRadii,
	targetMaxError: number,
): ApproximatedPolygon | undefined {
	const bounds = rectBounds(rect)
	if (!bounds || rect.width === 0 || rect.height === 0 || !validTargetMaxError(targetMaxError))
		return undefined
	const normalized = normalizeRadii(bounds, rect.width, rect.height, radii)
	if (!normalized) return undefined
	const numericError = coordinateNumericError([
		bounds.left, bounds.top, bounds.right, bounds.bottom,
		normalized.topLeft.rx, normalized.topLeft.ry,
		normalized.topRight.rx, normalized.topRight.ry,
		normalized.bottomRight.rx, normalized.bottomRight.ry,
		normalized.bottomLeft.rx, normalized.bottomLeft.ry,
	])
	if (numericError > targetMaxError) return undefined

	const corners = [
		{ radius: normalized.topLeft, cx: bounds.left + normalized.topLeft.rx, cy: bounds.top + normalized.topLeft.ry, start: Math.PI, square: point(bounds.left, bounds.top) },
		{ radius: normalized.topRight, cx: bounds.right - normalized.topRight.rx, cy: bounds.top + normalized.topRight.ry, start: 1.5 * Math.PI, square: point(bounds.right, bounds.top) },
		{ radius: normalized.bottomRight, cx: bounds.right - normalized.bottomRight.rx, cy: bounds.bottom - normalized.bottomRight.ry, start: 0, square: point(bounds.right, bounds.bottom) },
		{ radius: normalized.bottomLeft, cx: bounds.left + normalized.bottomLeft.rx, cy: bounds.bottom - normalized.bottomLeft.ry, start: 0.5 * Math.PI, square: point(bounds.left, bounds.bottom) },
	] as const

	const points: Point[] = []
	let reportedError = numericError
	for (const corner of corners) {
		const { rx, ry } = corner.radius
		if (rx === 0 || ry === 0) {
			points.push(corner.square)
			continue
		}
		const plan = planQuarterArc(Math.max(rx, ry), targetMaxError, numericError)
		if (!plan) return undefined
		reportedError = Math.max(reportedError, plan.reportedError)
		appendTangentArc(points, { cx: corner.cx, cy: corner.cy, rx, ry }, corner.start, plan.segments)
	}
	return finishPolygon(points, reportedError)
}

/** The tangent polygon of an axis-aligned ellipse, containing it (see `approximateRoundedRectOuterPolygon`). */
export function approximateEllipseOuterPolygon(
	ellipse: EllipseGeometry,
	targetMaxError: number,
): ApproximatedPolygon | undefined {
	if (!validTargetMaxError(targetMaxError) || !validEllipse(ellipse)) return undefined
	if (ellipse.rx === 0 || ellipse.ry === 0) return undefined
	const numericError = coordinateNumericError([
		ellipse.cx, ellipse.cy, ellipse.rx, ellipse.ry,
		ellipse.cx - ellipse.rx, ellipse.cx + ellipse.rx, ellipse.cy - ellipse.ry, ellipse.cy + ellipse.ry,
	])
	const plan = planQuarterArc(Math.max(ellipse.rx, ellipse.ry), targetMaxError, numericError)
	if (!plan) return undefined
	const points: Point[] = []
	for (let quarter = 0; quarter < 4; quarter++) appendTangentArc(points, ellipse, quarter * 0.5 * Math.PI, plan.segments, false)
	return finishPolygon(points, plan.reportedError)
}

/**
 * Appends one quarter arc of an ellipse, from angle `start`, as the vertices of its tangent
 * polygon: the two arc ends (when `ends`) joined by the intersections of consecutive tangents.
 */
function appendTangentArc(points: Point[], ellipse: EllipseGeometry, start: number, segments: number, ends = true): void {
	const step = (0.5 * Math.PI) / segments
	// Scales a mid-step direction out to the intersection of the two tangents around it.
	const reach = 1 / Math.cos(step / 2)
	const onEllipse = (angle: number, factor: number) => point(ellipse.cx + ellipse.rx * Math.cos(angle) * factor, ellipse.cy + ellipse.ry * Math.sin(angle) * factor)
	if (ends) points.push(onEllipse(start, 1))
	for (let index = 0; index < segments; index++) points.push(onEllipse(start + (index + 0.5) * step, reach))
	if (ends) points.push(onEllipse(start + 0.5 * Math.PI, 1))
}

function finishPolygon(points: readonly Point[], maxError: number): ApproximatedPolygon | undefined {
	const deduplicated: Point[] = []
	for (const next of points) {
		if (!finitePoint(next)) return undefined
		const last = deduplicated[deduplicated.length - 1]
		if (!last || !samePoint(last, next)) deduplicated.push(next)
	}
	while (deduplicated.length > 1 && samePoint(deduplicated[0]!, deduplicated[deduplicated.length - 1]!)) deduplicated.pop()
	if (deduplicated.length < 3 || !Number.isFinite(maxError)) return undefined
	return Object.freeze({ points: Object.freeze(deduplicated), maxError })
}
