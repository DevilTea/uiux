import type { Contour, ContourCommand, Point } from './protocol/schema'

export type Bounds = Readonly<{
	left: number
	top: number
	right: number
	bottom: number
}>

export type HighlightRegion = Readonly<{
	regionId: string
	contour: Contour
}>

/**
 * Axis-aligned bounds of an already protocol-validated rendered contour, including cubic extrema.
 * This presentation helper is not a second wire validator; undefined only protects against
 * unusable/non-finite inputs accidentally reaching the presentation layer.
 */
export function contourBounds(contour: Contour): Bounds | undefined {
	const commands = contour.commands
	if (commands.length < 3 || commands[0]?.op !== 'moveTo' || commands.at(-1)?.op !== 'close') return undefined

	const start = pointFromCommand(commands[0])
	if (!start || !finitePoint(start)) return undefined
	let current = start
	let bounds = pointBounds(start)
	let drawingSegments = 0

	for (let index = 1; index < commands.length; index++) {
		const command = commands[index]!
		if (command.op === 'moveTo') return undefined
		if (command.op === 'lineTo') {
			const end = pointFromCommand(command)
			if (!end || !finitePoint(end)) return undefined
			bounds = includePoint(bounds, end)
			current = end
			drawingSegments++
			continue
		}
		if (command.op === 'cubicBezierTo') {
			const c1 = { x: command.c1x, y: command.c1y }
			const c2 = { x: command.c2x, y: command.c2y }
			const end = { x: command.x, y: command.y }
			if (![c1, c2, end].every(finitePoint)) return undefined
			bounds = includeCubicBounds(bounds, current, c1, c2, end)
			current = end
			drawingSegments++
			continue
		}
		if (command.op === 'close') {
			if (index !== commands.length - 1) return undefined
			bounds = includePoint(bounds, start)
			current = start
			continue
		}
		return undefined
	}

	if (drawingSegments === 0) return undefined
	return Object.freeze(bounds)
}

/**
 * Canonical anchor basis for the single shared translucent-obstruction indicator:
 * aggregate outer bounds across every currently highlighted visible region.
 */
export function aggregateHighlightBounds(regions: readonly HighlightRegion[]): Bounds | undefined {
	let aggregate: Bounds | undefined
	for (const region of regions) {
		const bounds = contourBounds(region.contour)
		if (!bounds) return undefined
		aggregate = aggregate ? unionBounds(aggregate, bounds) : bounds
	}
	return aggregate && Object.freeze({ ...aggregate })
}

function includeCubicBounds(bounds: Bounds, p0: Point, p1: Point, p2: Point, p3: Point): Bounds {
	let next = includePoint(includePoint(bounds, p0), p3)
	for (const t of cubicExtremaParameters(p0.x, p1.x, p2.x, p3.x))
		next = includePoint(next, cubicPoint(p0, p1, p2, p3, t))
	for (const t of cubicExtremaParameters(p0.y, p1.y, p2.y, p3.y))
		next = includePoint(next, cubicPoint(p0, p1, p2, p3, t))
	return next
}

function cubicExtremaParameters(p0: number, p1: number, p2: number, p3: number): number[] {
	const coordinateScale = Math.max(Math.abs(p0), Math.abs(p1), Math.abs(p2), Math.abs(p3))
	if (coordinateScale === 0) return []
	const q0 = p0 / coordinateScale
	const q1 = p1 / coordinateScale
	const q2 = p2 / coordinateScale
	const q3 = p3 / coordinateScale
	const a = -q0 + 3 * q1 - 3 * q2 + q3
	const b = 2 * (q0 - 2 * q1 + q2)
	const c = q1 - q0
	if (![a, b, c].every(Number.isFinite)) return []

	if (a === 0) {
		if (b === 0) return []
		const t = -c / b
		return t > 0 && t < 1 ? [t] : []
	}

	const discriminant = b * b - 4 * a * c
	if (!(discriminant >= 0) || !Number.isFinite(discriminant)) return []
	const root = Math.sqrt(discriminant)
	const q = -0.5 * (b + Math.sign(b || 1) * root)
	const roots = q === 0 ? [-b / (2 * a)] : [q / a, c / q]
	const unique: number[] = []
	for (const t of roots) {
		if (Number.isFinite(t) && t > 0 && t < 1 && !unique.includes(t)) unique.push(t)
	}
	return unique
}

function cubicPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
	const u = 1 - t
	const uu = u * u
	const tt = t * t
	return {
		x: uu * u * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + tt * t * p3.x,
		y: uu * u * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + tt * t * p3.y,
	}
}

function pointFromCommand(command: ContourCommand): Point | undefined {
	return command.op === 'moveTo' || command.op === 'lineTo'
		? { x: command.x, y: command.y }
		: undefined
}

function pointBounds(point: Point): Bounds {
	return { left: point.x, top: point.y, right: point.x, bottom: point.y }
}

function includePoint(bounds: Bounds, point: Point): Bounds {
	return {
		left: Math.min(bounds.left, point.x),
		top: Math.min(bounds.top, point.y),
		right: Math.max(bounds.right, point.x),
		bottom: Math.max(bounds.bottom, point.y),
	}
}

function unionBounds(left: Bounds, right: Bounds): Bounds {
	return {
		left: Math.min(left.left, right.left),
		top: Math.min(left.top, right.top),
		right: Math.max(left.right, right.right),
		bottom: Math.max(left.bottom, right.bottom),
	}
}

function finitePoint(point: Point): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y)
}
