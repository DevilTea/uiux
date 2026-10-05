import { measureRenderedContentBoxQuad, type RenderedContentBoxMeasurement, type RenderedContentBoxQuad } from './rendered-content-quad'

/**
 * Workbench-side outer mapping for engines without `getBoxQuads()` (Chromium, WebKit).
 *
 * Part 3 makes the rendered content-box quad authoritative because an axis-aligned bounding
 * box cannot recover rotation, skew or nonuniform scale. This module therefore never *infers*
 * a mapping from a bounding box. It first proves, from the computed style of the element and
 * every ancestor, that the rendered transform chain is a uniform positive scale plus
 * translation. Only under that proof is the border box from `getBoundingClientRect()` the exact
 * rendered quad, and the content box follows from the computed border and padding widths.
 * When any link of the chain is rotated, skewed, flipped, nonuniform, 3D or on a motion path,
 * the measurement fails closed as `unavailable` and the overlay stays paused, exactly as with
 * an unmeasurable quad.
 */

export type AxisAlignedProofFailure =
	| 'detached'
	| 'non-axis-aligned-transform'
	| 'nonuniform-scale'
	| 'three-dimensional-transform'
	| 'motion-path'
	| 'empty-box'
	| 'invalid-geometry'

export type AxisAlignedMeasurement =
	| Readonly<{ status: 'available'; quad: RenderedContentBoxQuad; source: 'box-quads' | 'axis-aligned-proof' }>
	| Readonly<{ status: 'unavailable'; reason: AxisAlignedProofFailure | 'api-unavailable' | 'measurement-failed' | 'ambiguous-fragments' }>

type StyleLike = Readonly<{
	transform?: string
	rotate?: string
	scale?: string
	offsetPath?: string
	borderLeftWidth?: string
	borderTopWidth?: string
	borderRightWidth?: string
	borderBottomWidth?: string
	paddingLeft?: string
	paddingTop?: string
	paddingRight?: string
	paddingBottom?: string
}>

type ElementLike = Readonly<{
	parentElement: ElementLike | null
	offsetWidth?: number
	offsetHeight?: number
	getBoundingClientRect: () => Readonly<{ left: number; top: number; width: number; height: number }>
}>

export type AxisAlignedDependencies = Readonly<{
	getComputedStyle: (element: ElementLike) => StyleLike
}>

/** Relative roundoff allowed when comparing the two scale factors of a uniform scale. */
const UNIFORM_SCALE_TOLERANCE = 1e-6

/**
 * Measures the iframe content-box quad: the browser quad API when it exists, otherwise the
 * axis-aligned proof above. Callers feed the result to `deriveOuterMapping`.
 */
export function measureContentBoxQuad(element: Element, deps?: AxisAlignedDependencies): AxisAlignedMeasurement {
	const native: RenderedContentBoxMeasurement = measureRenderedContentBoxQuad(element)
	if (native.status === 'available') return { status: 'available', quad: native.quad, source: 'box-quads' }
	if (native.reason !== 'api-unavailable') return native
	return measureAxisAlignedContentBoxQuad(element as unknown as ElementLike, deps)
}

export function measureAxisAlignedContentBoxQuad(element: ElementLike, deps?: AxisAlignedDependencies): AxisAlignedMeasurement {
	const styleOf = deps?.getComputedStyle ?? ((target: ElementLike) => globalThis.getComputedStyle(target as unknown as Element) as unknown as StyleLike)

	for (let link: ElementLike | null = element; link; link = link.parentElement) {
		const failure = transformFailure(styleOf(link))
		if (failure) return { status: 'unavailable', reason: failure }
	}

	const width = element.offsetWidth ?? 0
	const height = element.offsetHeight ?? 0
	if (!(width > 0) || !(height > 0)) return { status: 'unavailable', reason: 'empty-box' }

	const rect = element.getBoundingClientRect()
	if (![rect.left, rect.top, rect.width, rect.height].every(Number.isFinite)) return { status: 'unavailable', reason: 'invalid-geometry' }
	if (!(rect.width > 0) || !(rect.height > 0)) return { status: 'unavailable', reason: 'detached' }

	const scaleX = rect.width / width
	const scaleY = rect.height / height
	if (Math.abs(scaleX - scaleY) > UNIFORM_SCALE_TOLERANCE * Math.max(scaleX, scaleY)) return { status: 'unavailable', reason: 'nonuniform-scale' }

	const style = styleOf(element)
	const insetLeft = (px(style.borderLeftWidth) + px(style.paddingLeft)) * scaleX
	const insetTop = (px(style.borderTopWidth) + px(style.paddingTop)) * scaleY
	const insetRight = (px(style.borderRightWidth) + px(style.paddingRight)) * scaleX
	const insetBottom = (px(style.borderBottomWidth) + px(style.paddingBottom)) * scaleY
	const left = rect.left + insetLeft
	const top = rect.top + insetTop
	const right = rect.left + rect.width - insetRight
	const bottom = rect.top + rect.height - insetBottom
	if (!(right > left) || !(bottom > top)) return { status: 'unavailable', reason: 'empty-box' }

	return {
		status: 'available',
		source: 'axis-aligned-proof',
		quad: Object.freeze({
			p1: Object.freeze({ x: left, y: top }),
			p2: Object.freeze({ x: right, y: top }),
			p3: Object.freeze({ x: right, y: bottom }),
			p4: Object.freeze({ x: left, y: bottom }),
		}),
	}
}

function transformFailure(style: StyleLike): AxisAlignedProofFailure | undefined {
	if (style.offsetPath && style.offsetPath !== 'none') return 'motion-path'
	if (style.rotate && style.rotate !== 'none' && !/^0(deg|rad|turn|grad)?$/.test(style.rotate.trim())) return 'non-axis-aligned-transform'
	if (style.scale && style.scale !== 'none') {
		const factors = style.scale.trim().split(/\s+/).map(Number)
		if (factors.length > 2 || !factors.every(factor => Number.isFinite(factor) && factor > 0)) return 'non-axis-aligned-transform'
		if (factors.length === 2 && factors[0] !== factors[1]) return 'nonuniform-scale'
	}
	const transform = style.transform?.trim()
	if (!transform || transform === 'none') return undefined
	if (transform.startsWith('matrix3d(')) return 'three-dimensional-transform'
	const match = /^matrix\(([^)]*)\)$/.exec(transform)
	if (!match) return 'non-axis-aligned-transform'
	const [a, b, c, d, e, f] = match[1]!.split(',').map(part => Number(part.trim()))
	if (![a, b, c, d, e, f].every(Number.isFinite)) return 'non-axis-aligned-transform'
	if (b !== 0 || c !== 0 || !(a! > 0) || !(d! > 0)) return 'non-axis-aligned-transform'
	if (Math.abs(a! - d!) > UNIFORM_SCALE_TOLERANCE * Math.max(a!, d!)) return 'nonuniform-scale'
	return undefined
}

function px(value: string | undefined): number {
	const parsed = Number.parseFloat(value ?? '0')
	return Number.isFinite(parsed) ? parsed : 0
}
