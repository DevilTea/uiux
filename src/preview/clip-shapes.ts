import { isSimpleRing, pointsRing, rectangleRing, ringShape, type PolygonRing, type PolygonShape } from './polygon-occlusion'
import type { ContourCommand, Point, WidgetRect } from './protocol/schema'
import {
	approximateEllipseContour,
	approximateEllipseOuterPolygon,
	approximateRoundedRectContour,
	approximateRoundedRectOuterPolygon,
	type RoundedRectRadii,
} from './rounded-contour'

/**
 * Shapes of CSS `clip-path` basic shapes, rounded boxes and ellipses as polygons (issue #112).
 *
 * A shape is derived on one of two sides. `cover`: the polygon contains the true shape, for an
 * occluder's covered area, which may only be over-subtracted. `contain`: the polygon lies inside
 * the true shape, for an area the Widget must stay within. Straight-edged shapes are exact on both
 * sides; a curve is approximated by the tangent polygon (`cover`) or the chord polygon (`contain`)
 * within the returned `maxError`. A value the parser or the geometry does not understand gives
 * `undefined`, never a bounding box.
 */

export type ClipSide = 'cover' | 'contain'

export type PageBox = Readonly<{ left: number; top: number; right: number; bottom: number }>

/** The shape of a clip with no area: it removes everything it clips. */
export const EMPTY_SHAPE: PolygonShape = Object.freeze({ polygons: Object.freeze([]), maxError: 0 })

/** A computed length-percentage: `px` in CSS px of the element's own space, or `pct` percent. */
type LengthPercentage = Readonly<{ px: number; pct: number }>

type Radius = Readonly<{ x: LengthPercentage; y: LengthPercentage }>

export type BasicShape =
	| Readonly<{ kind: 'inset'; top: LengthPercentage; right: LengthPercentage; bottom: LengthPercentage; left: LengthPercentage; radii: readonly [Radius, Radius, Radius, Radius] | undefined }>
	| Readonly<{ kind: 'circle'; radius: LengthPercentage | 'closest-side' | 'farthest-side'; cx: LengthPercentage; cy: LengthPercentage }>
	| Readonly<{ kind: 'ellipse'; rx: LengthPercentage | 'closest-side' | 'farthest-side'; ry: LengthPercentage | 'closest-side' | 'farthest-side'; cx: LengthPercentage; cy: LengthPercentage }>
	| Readonly<{ kind: 'polygon'; points: readonly (readonly [LengthPercentage, LengthPercentage])[] }>

export type ClipPathValue =
	| Readonly<{ kind: 'none' }>
	| Readonly<{ kind: 'url'; id: string }>
	| Readonly<{ kind: 'shape'; shape: BasicShape; box: 'border-box' | 'padding-box' | 'content-box' }>

const NUMBER = String.raw`[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?`

function lengthPercentage(token: string): LengthPercentage | undefined {
	const text = token.trim()
	if (text === '0') return { px: 0, pct: 0 }
	const length = new RegExp(`^(${NUMBER})px$`, 'i').exec(text)
	if (length) return { px: Number(length[1]), pct: 0 }
	const percent = new RegExp(`^(${NUMBER})%$`, 'i').exec(text)
	if (percent) return { px: 0, pct: Number(percent[1]) }
	return undefined
}

function splitSpaces(value: string): string[] {
	const parts: string[] = []
	let depth = 0
	let current = ''
	for (const char of value) {
		if (char === '(') depth++
		else if (char === ')') depth = Math.max(0, depth - 1)
		if (depth === 0 && /\s/.test(char)) {
			if (current) parts.push(current)
			current = ''
			continue
		}
		current += char
	}
	if (current) parts.push(current)
	return parts
}

function splitCommas(value: string): string[] {
	return value.split(',').map(part => part.trim())
}

const POSITION_KEYWORDS: Readonly<Record<string, LengthPercentage>> = {
	left: { px: 0, pct: 0 },
	top: { px: 0, pct: 0 },
	center: { px: 0, pct: 50 },
	right: { px: 0, pct: 100 },
	bottom: { px: 0, pct: 100 },
}

/** Parses the computed `clip-path`, or undefined when its form is not understood. */
export function parseClipPath(value: string): ClipPathValue | undefined {
	const text = value.trim()
	if (text === '' || text === 'none') return { kind: 'none' }
	const url = /^url\(\s*(["']?)#([^"')]+)\1\s*\)$/.exec(text)
	if (url) return { kind: 'url', id: url[2]! }
	let box: 'border-box' | 'padding-box' | 'content-box' = 'border-box'
	let functionText: string | undefined
	for (const part of splitSpaces(text)) {
		if (part === 'border-box' || part === 'padding-box' || part === 'content-box') box = part
		else if (functionText === undefined && /^[a-z-]+\(.*\)$/i.test(part)) functionText = part
		else return undefined
	}
	if (functionText === undefined) return undefined
	const match = /^([a-z-]+)\((.*)\)$/is.exec(functionText)
	if (!match) return undefined
	const body = match[2]!.trim()
	const shape = match[1]!.toLowerCase() === 'inset' ? parseInset(body)
		: match[1]!.toLowerCase() === 'circle' ? parseCircle(body)
			: match[1]!.toLowerCase() === 'ellipse' ? parseEllipse(body)
				: match[1]!.toLowerCase() === 'polygon' ? parsePolygon(body)
					: undefined
	return shape ? { kind: 'shape', shape, box } : undefined
}

function parseInset(body: string): BasicShape | undefined {
	const [offsets, rounding] = body.split(/\s+round\s+/i) as [string, string?]
	const values = splitSpaces(offsets).map(lengthPercentage)
	if (values.length < 1 || values.length > 4 || values.some(value => value === undefined)) return undefined
	const [top, right = top, bottom = top, left = right] = values as [LengthPercentage, ...LengthPercentage[]]
	let radii: readonly [Radius, Radius, Radius, Radius] | undefined
	if (rounding !== undefined) {
		const [horizontalText, verticalText] = rounding.split('/') as [string, string?]
		const horizontal = splitSpaces(horizontalText).map(lengthPercentage)
		const vertical = verticalText === undefined ? horizontal : splitSpaces(verticalText).map(lengthPercentage)
		if (horizontal.length < 1 || horizontal.length > 4 || vertical.length < 1 || vertical.length > 4) return undefined
		if (horizontal.some(value => value === undefined) || vertical.some(value => value === undefined)) return undefined
		const expand = (list: readonly (LengthPercentage | undefined)[]): [LengthPercentage, LengthPercentage, LengthPercentage, LengthPercentage] => {
			const [a, b = a, c = a, d = b] = list as [LengthPercentage, ...LengthPercentage[]]
			// top-left, top-right, bottom-right, bottom-left
			return [a, b, c!, d!]
		}
		const xs = expand(horizontal)
		const ys = expand(vertical)
		radii = [{ x: xs[0], y: ys[0] }, { x: xs[1], y: ys[1] }, { x: xs[2], y: ys[2] }, { x: xs[3], y: ys[3] }]
	}
	return { kind: 'inset', top, right: right!, bottom: bottom!, left: left!, radii }
}

function parseExtent(token: string): LengthPercentage | 'closest-side' | 'farthest-side' | undefined {
	if (token === 'closest-side' || token === 'farthest-side') return token
	return lengthPercentage(token)
}

function parsePosition(tokens: readonly string[]): [LengthPercentage, LengthPercentage] | undefined {
	if (tokens.length === 0) return [{ px: 0, pct: 50 }, { px: 0, pct: 50 }]
	if (tokens.length !== 2) return undefined
	const resolve = (token: string) => POSITION_KEYWORDS[token] ?? lengthPercentage(token)
	const x = resolve(tokens[0]!)
	const y = resolve(tokens[1]!)
	// A vertical keyword in the horizontal slot (or the reverse) is not a computed form.
	if (!x || !y || tokens[0] === 'top' || tokens[0] === 'bottom' || tokens[1] === 'left' || tokens[1] === 'right') return undefined
	return [x, y]
}

function splitAt(body: string): [string, string[]] {
	const parts = splitSpaces(body)
	const at = parts.indexOf('at')
	return at < 0 ? [parts.join(' '), []] : [parts.slice(0, at).join(' '), parts.slice(at + 1)]
}

function parseCircle(body: string): BasicShape | undefined {
	const [radiusText, positionTokens] = splitAt(body)
	const position = parsePosition(positionTokens)
	if (!position) return undefined
	const radius = radiusText === '' ? 'closest-side' : parseExtent(radiusText)
	if (radius === undefined) return undefined
	return { kind: 'circle', radius, cx: position[0], cy: position[1] }
}

function parseEllipse(body: string): BasicShape | undefined {
	const [radiiText, positionTokens] = splitAt(body)
	const position = parsePosition(positionTokens)
	if (!position) return undefined
	const radii = radiiText === '' ? ['closest-side', 'closest-side'] : splitSpaces(radiiText)
	if (radii.length !== 2) return undefined
	const rx = parseExtent(radii[0]!)
	const ry = parseExtent(radii[1]!)
	if (rx === undefined || ry === undefined) return undefined
	return { kind: 'ellipse', rx, ry, cx: position[0], cy: position[1] }
}

function parsePolygon(body: string): BasicShape | undefined {
	let list = body
	const rule = /^(nonzero|evenodd)\s*,/i.exec(body)
	if (rule) list = body.slice(rule[0].length)
	const points: [LengthPercentage, LengthPercentage][] = []
	for (const entry of splitCommas(list)) {
		const pair = splitSpaces(entry).map(lengthPercentage)
		if (pair.length !== 2 || pair[0] === undefined || pair[1] === undefined) return undefined
		points.push([pair[0], pair[1]])
	}
	return points.length >= 3 ? { kind: 'polygon', points } : undefined
}

/**
 * Resolves a parsed basic shape against its reference box in page px. `scale` maps the element's
 * local CSS px to page px (the exact chain scale); percentages resolve against the page-space box.
 * The shape of a degenerate or negative size is empty.
 */
export function basicShapePolygon(shape: BasicShape, box: PageBox, scale: number, side: ClipSide, targetMaxError: number): PolygonShape | undefined {
	const width = box.right - box.left
	const height = box.bottom - box.top
	if (!(width > 0) || !(height > 0) || !(scale > 0) || !Number.isFinite(scale)) return undefined
	const resolve = (value: LengthPercentage, basis: number) => value.px * scale + (value.pct / 100) * basis
	switch (shape.kind) {
		case 'inset': {
			const left = box.left + resolve(shape.left, width)
			const top = box.top + resolve(shape.top, height)
			const right = box.right - resolve(shape.right, width)
			const bottom = box.bottom - resolve(shape.bottom, height)
			if (![left, top, right, bottom].every(Number.isFinite)) return undefined
			if (!(right > left) || !(bottom > top)) return EMPTY_SHAPE
			if (!shape.radii) return ringShape(rectangleRing(left, top, right, bottom), 0)
			const corner = (radius: Radius) => {
				const rx = Math.max(0, resolve(radius.x, width))
				const ry = Math.max(0, resolve(radius.y, height))
				return rx > 0 && ry > 0 ? { rx, ry } : { rx: 0, ry: 0 }
			}
			return roundedRectShape({ x: left, y: top, width: right - left, height: bottom - top }, { topLeft: corner(shape.radii[0]), topRight: corner(shape.radii[1]), bottomRight: corner(shape.radii[2]), bottomLeft: corner(shape.radii[3]) }, side, targetMaxError)
		}
		case 'circle':
		case 'ellipse': {
			const cx = box.left + resolve(shape.cx, width)
			const cy = box.top + resolve(shape.cy, height)
			const reference = Math.sqrt((width * width + height * height) / 2)
			const extent = (value: LengthPercentage | 'closest-side' | 'farthest-side', near: number, far: number, basis: number) => {
				if (value === 'closest-side') return Math.min(near, far)
				if (value === 'farthest-side') return Math.max(near, far)
				return resolve(value, basis)
			}
			const dx = [Math.abs(cx - box.left), Math.abs(box.right - cx)] as const
			const dy = [Math.abs(cy - box.top), Math.abs(box.bottom - cy)] as const
			let rx: number
			let ry: number
			if (shape.kind === 'circle') {
				const sides = shape.radius === 'closest-side' ? Math.min(...dx, ...dy) : shape.radius === 'farthest-side' ? Math.max(...dx, ...dy) : resolve(shape.radius, reference)
				rx = sides
				ry = sides
			}
			else {
				rx = extent(shape.rx, dx[0], dx[1], width)
				ry = extent(shape.ry, dy[0], dy[1], height)
			}
			if (!Number.isFinite(rx) || !Number.isFinite(ry) || !Number.isFinite(cx) || !Number.isFinite(cy)) return undefined
			if (!(rx > 0) || !(ry > 0)) return EMPTY_SHAPE
			return ellipseShape({ cx, cy, rx, ry }, side, targetMaxError)
		}
		case 'polygon': {
			const ring: PolygonRing = shape.points.map(([x, y]) => [box.left + resolve(x, width), box.top + resolve(y, height)] as const)
			if (!ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return undefined
			// A self-crossing polygon depends on the fill rule; only a simple one is an exact shape.
			return isSimpleRing(ring) ? ringShape(ring, 0) : undefined
		}
	}
}

export function ellipseShape(ellipse: Readonly<{ cx: number; cy: number; rx: number; ry: number }>, side: ClipSide, targetMaxError: number): PolygonShape | undefined {
	if (side === 'cover') {
		const outer = approximateEllipseOuterPolygon(ellipse, targetMaxError)
		return outer ? ringShape(pointsRing(outer.points), outer.maxError) : undefined
	}
	const inner = approximateEllipseContour(ellipse, targetMaxError)
	return inner ? ringShape(pointsRing(contourVertices(inner.contour.commands)), inner.maxError) : undefined
}

export function roundedRectShape(rect: WidgetRect, radii: RoundedRectRadii, side: ClipSide, targetMaxError: number): PolygonShape | undefined {
	if (side === 'cover') {
		const outer = approximateRoundedRectOuterPolygon(rect, radii, targetMaxError)
		return outer ? ringShape(pointsRing(outer.points), outer.maxError) : undefined
	}
	const inner = approximateRoundedRectContour(rect, radii, targetMaxError)
	return inner ? ringShape(pointsRing(contourVertices(inner.contour.commands)), inner.maxError) : undefined
}

/** Vertices of a contour made of lines and line-equivalent cubic chords (`rounded-contour` output). */
export function contourVertices(commands: readonly ContourCommand[]): Point[] {
	const points: Point[] = []
	for (const command of commands) if (command.op !== 'close') points.push({ x: command.x, y: command.y })
	return points
}

/** A geometric child of an SVG `<clipPath>`, in its user units (or fractions of the bounding box). */
export type SvgPrimitive =
	| Readonly<{ kind: 'rect'; x: number; y: number; width: number; height: number; rx: number; ry: number }>
	| Readonly<{ kind: 'circle'; cx: number; cy: number; r: number }>
	| Readonly<{ kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }>
	| Readonly<{ kind: 'polygon'; points: readonly (readonly [number, number])[] }>

/** Maps user units to page px: `page = origin + scale * user`, per axis. */
export type SvgUnitMapping = Readonly<{ x: number; y: number; sx: number; sy: number }>

/** The shape of one SVG clip primitive under an axis-aligned unit mapping (a circle may become an ellipse). */
export function svgPrimitiveShape(primitive: SvgPrimitive, mapping: SvgUnitMapping, side: ClipSide, targetMaxError: number): PolygonShape | undefined {
	const { x: ox, y: oy, sx, sy } = mapping
	if (!(sx > 0) || !(sy > 0) || ![ox, oy, sx, sy].every(Number.isFinite)) return undefined
	switch (primitive.kind) {
		case 'rect': {
			if (!(primitive.width >= 0) || !(primitive.height >= 0)) return undefined
			if (primitive.width === 0 || primitive.height === 0) return EMPTY_SHAPE
			const left = ox + sx * primitive.x
			const top = oy + sy * primitive.y
			const width = sx * primitive.width
			const height = sy * primitive.height
			const rx = Math.min(Math.max(0, primitive.rx), primitive.width / 2) * sx
			const ry = Math.min(Math.max(0, primitive.ry), primitive.height / 2) * sy
			if (![left, top, width, height, rx, ry].every(Number.isFinite)) return undefined
			if (!(rx > 0) || !(ry > 0)) return ringShape(rectangleRing(left, top, left + width, top + height), 0)
			const corner = { rx, ry }
			return roundedRectShape({ x: left, y: top, width, height }, { topLeft: corner, topRight: corner, bottomRight: corner, bottomLeft: corner }, side, targetMaxError)
		}
		case 'circle': {
			if (!(primitive.r >= 0)) return undefined
			if (primitive.r === 0) return EMPTY_SHAPE
			return ellipseShape({ cx: ox + sx * primitive.cx, cy: oy + sy * primitive.cy, rx: sx * primitive.r, ry: sy * primitive.r }, side, targetMaxError)
		}
		case 'ellipse': {
			if (!(primitive.rx >= 0) || !(primitive.ry >= 0)) return undefined
			if (primitive.rx === 0 || primitive.ry === 0) return EMPTY_SHAPE
			return ellipseShape({ cx: ox + sx * primitive.cx, cy: oy + sy * primitive.cy, rx: sx * primitive.rx, ry: sy * primitive.ry }, side, targetMaxError)
		}
		case 'polygon': {
			const ring: PolygonRing = primitive.points.map(([x, y]) => [ox + sx * x, oy + sy * y] as const)
			if (ring.length < 3 || !ring.every(([x, y]) => Number.isFinite(x) && Number.isFinite(y))) return undefined
			return isSimpleRing(ring) ? ringShape(ring, 0) : undefined
		}
	}
}
