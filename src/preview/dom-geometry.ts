import { flatTreeParent, isSvgElement } from './axis-aligned-content-quad'
import type { WidgetGeometry, WidgetMeasurer } from './geometry-producer'
import { planOcclusion, type OcclusionEvidence, type ProvenOccluderShapeKind } from './occlusion-proof'
import type { ContourCommand, Point, VisibleRegion, WidgetRect } from './protocol/schema'
import { subtractAxisAlignedRectangularOcclusion } from './rectangular-occlusion'
import { basicShapePolygon, EMPTY_SHAPE, parseClipPath, roundedRectShape, svgPrimitiveShape, type ClipSide, type SvgPrimitive } from './clip-shapes'
import { boundsOf, intersectShapes, MAX_CUT_SHAPES, MAX_CUT_VERTICES, outerRings, rectangleShape, subtractShapes, unionShapes, vertexCount, type PolygonShape } from './polygon-occlusion'
import type { RoundedRectRadii } from './rounded-contour'

/**
 * DOM measurement for the runtime geometry producer (Part 4 visible regions, first version).
 *
 * For one Widget element it reports the full rendered border box (`rect`) and the regions of it
 * that are reliably visible: the part surviving the content viewport, every ancestor overflow or
 * paint-containment clip on its containing-block chain and every clip path on its chain, minus
 * proven opaque occluders and minus the finite paint bound of every occluder whose exact covering
 * shape is unproven. It never guesses. Whenever the visible set cannot be proven inside the subset
 * below, it reports `regions: []` ("no reliably visible region", Part 4) instead of a bounding box.
 *
 * Exact subset:
 * - Widget boxes whose transform chain is translation plus uniform positive scale. Rotation, skew,
 *   flips, nonuniform scale, 3D and motion paths fail closed. The chain follows the flat tree
 *   (assigned slot, parent element, shadow host), and an SVG ancestor fails closed. A filter, blend
 *   mode or mask on the Widget's own chain fails closed too.
 * - Rectangular clips are exact. Rounded shapes (the Widget's own border radius, rounded overflow
 *   clips whose corners reach the visible area) and clip paths on the Widget's chain (`inset()`,
 *   `circle()`, `ellipse()`, simple `polygon()` and geometric SVG `<clipPath>` references; see
 *   `clip-shapes.ts`) take part as polygons that lie inside the true shape, so the Widget keeps
 *   at most what it truly shows. Any number may combine, with the largest approximation error as
 *   the region's `maxError`.
 * - Occluders are elements that paint above the Widget, determined from the CSS painting order
 *   (stacking contexts, z-index, positioned layers, tree order). An undecided order (overlap
 *   between two in-flow boxes, whose backgrounds and inline content interleave) is taken as above.
 *   An element is examined when its paint reaches the visible area: its border box grown by its own
 *   outline, outer shadows, border-image outset, replaced-content clip margin, generated content,
 *   list marker, overflowing text and the filter extent of it and every ancestor (Discussion #241
 *   owner decision 2). Paint without a finite bound is examined wherever its clips allow.
 *   - Opaque (subtracted exactly): order proven above, opacity 1 along the chain, an opaque
 *     background colour, no filter, blend mode or mask, a uniform transform chain, painted area
 *     clipped by the occluder's own clips. Rounded corners, rounded clips, clip paths and SVG clip
 *     paths reaching the Widget make the cut a polygon that contains the true covered area.
 *   - Translucent (kept, Part 4): a background colour with alpha below 1 and no image, borders with
 *     alpha below 1, or anything under an opacity below 1. Solid opaque borders cut four exact
 *     strips.
 *   - Bounded (Discussion #241 R6; subtracted by an over-approximation): replaced content (images,
 *     SVG, canvas, video, frames, native controls), filters, blend modes, masks, clip paths that
 *     cannot be derived, transforms outside the uniform subset, an undecided paint order, a fill
 *     that is an image or gradient, other borders, and paint beyond the exact cut: box shadows,
 *     outlines, border images, text and generated content that are not wholly under it. The cut is
 *     the occluder's paint extent united with its own text (inline boxes grown by one em of glyph
 *     ink, its decoration, including one propagated from an ancestor, stroke and text shadows),
 *     its positioned pseudo-elements and its list marker, with the engine's pixel snapping under
 *     transforms, clipped by its clip chain only when no filter grows it and its chain is uniform,
 *     and rounded outward to whole device pixels. Outsets scale by the exact uniform chain scale
 *     (transforms and zoom), otherwise by a bound from the snapped layout size. Subtracting more
 *     than the occluder paints only shrinks what is reported visible. A bounded cut lying wholly
 *     inside the visible area would leave only an unreported interior hole, so the Widget gets no
 *     precise region (Discussion #241 owner decision 1); exact cuts may still leave such holes.
 *   - Unbounded (fail closed): a filter other than the CSS shorthand functions (such as `url()`),
 *     a 3D transform or `-webkit-box-reflect` on the occluder's chain, replaced content whose
 *     overflow is visible, an unparsed shadow, outline, outset or text style, text with more than twelve
 *     combining marks stacked on one letter, a transformed, floated, shadowed or offset pseudo-element, a list marker of unknown
 *     width, or an outset that a transform without a measurable box makes unscalable.
 * - The `::backdrop` of a top-layer element paints over the viewport: translucent when its fill and
 *   opacity prove it (kept), unsupported when it is opaque, an image, filtered, blended or bordered.
 *
 * Glyph ink is taken to stay within one em of the inline boxes of its text in a bound, and within
 * those boxes when the text lies under an exact cut.
 */

export type DomGeometryMeasurerOptions = Readonly<{
	document: Document
	/** Error target of rounded-corner contours, in inner CSS px. */
	roundedTargetMaxError?: number
}>

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>
type RoundedShape = Readonly<{ rect: WidgetRect; radii: RoundedRectRadii }>
/** What an occluder removes: a rectangle, or polygons containing its true shape (a curve, a clip). */
type CutShape = WidgetRect | PolygonShape

/** The most cuts of any kind a curved subtraction takes on. */
const MAX_TOTAL_CUTS = 400

function boundsOverlap(a: Box | undefined, b: Box | undefined): boolean {
	return !!a && !!b && Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
}

function isRectangleShape(shape: PolygonShape): boolean {
	return shape.polygons.length === 1 && shape.polygons[0]!.length === 1 && shape.polygons[0]![0]!.length === 4
}

function isPolygonCut(shape: CutShape): shape is PolygonShape {
	return 'polygons' in shape
}
type ClipChain = Readonly<{ box: Box; rounded: readonly RoundedShape[] }> | 'unsupported'
type PaintKey = Readonly<{ element: Element; flow: boolean; z: number }>
/**
 * What an element's generated content (`::before`, `::after`, a list marker) can paint beyond its own
 * text: `flow` when some of it sits in the element's content flow (so it stays within the scrollable
 * overflow), and the page-space boxes of the rest. `unbounded` when no finite bound is provable.
 */
type GeneratedContent = Readonly<{ flow: boolean; boxes: readonly Box[] }> | 'unbounded'
/** The client box of an element's own text nodes, and the most combining marks it stacks on one letter. */
type OwnText = Readonly<{ box: Box; stack: number }>

/**
 * The computed-style values the measurer reads, snapshotted once per element per style epoch.
 * Reading a live CSSStyleDeclaration property is not free, and scroll changes no computed style.
 */
const STYLE_KEYS = [
	'position', 'zIndex', 'display', 'visibility', 'overflowX', 'overflowY', 'opacity',
	'transform', 'translate', 'rotate', 'scale', 'offsetPath', 'filter', 'backdropFilter', 'mixBlendMode',
	'maskImage', 'clipPath', 'isolation', 'perspective', 'contain', 'willChange', 'containerType', 'overflowClipMargin',
	'borderTopLeftRadius', 'borderTopRightRadius', 'borderBottomRightRadius', 'borderBottomLeftRadius',
	'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
	'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle',
	'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor',
	'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
	'backgroundColor', 'backgroundImage', 'backgroundClip', 'boxShadow', 'outlineStyle', 'outlineWidth', 'outlineOffset', 'appearance',
	'borderImageSource', 'borderImageOutset', 'zoom',
	'textShadow', 'fontSize', 'textDecorationLine', 'textUnderlineOffset', 'textDecorationThickness',
	'direction', 'writingMode', 'textIndent', 'listStyleType', 'listStylePosition', 'listStyleImage',
] as const
type StyleKey = typeof STYLE_KEYS[number] | 'webkitMaskImage' | 'webkitAppearance' | 'webkitBoxReflect' | 'webkitTextStrokeWidth'
type StyleFacts = Readonly<Record<StyleKey, string>>

function snapshotStyle(style: CSSStyleDeclaration): StyleFacts {
	const facts = {} as Record<StyleKey, string>
	const source = style as unknown as Record<string, string | undefined>
	for (const key of STYLE_KEYS) facts[key] = source[key] ?? ''
	facts.webkitMaskImage = style.getPropertyValue('-webkit-mask-image')
	facts.webkitAppearance = style.getPropertyValue('-webkit-appearance')
	facts.webkitBoxReflect = style.getPropertyValue('-webkit-box-reflect')
	facts.webkitTextStrokeWidth = style.getPropertyValue('-webkit-text-stroke-width')
	return facts
}

const ZERO_GEOMETRY: WidgetGeometry = Object.freeze({ rect: Object.freeze({ x: 0, y: 0, width: 0, height: 0 }), regions: Object.freeze([]) })
const UNIFORM_SCALE_TOLERANCE = 1e-6
const REPLACED_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED', 'PICTURE', 'AUDIO'])
const NATIVE_CONTROL_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'METER', 'PROGRESS'])

export function createDomGeometryMeasurer(options: DomGeometryMeasurerOptions): WidgetMeasurer {
	const doc = options.document
	const view = doc.defaultView!
	const roundedTargetMaxError = options.roundedTargetMaxError ?? 0.5

	// Style-epoch caches: computed style, DOM structure and paint order. They survive scroll-only
	// passes and are dropped by `invalidateStyles()` (mutations, resizes, interaction, animations).
	let styles = new Map<Element, StyleFacts>()
	let chainFlags = new Map<Element, ChainFlags>()
	let stacking = new Map<Element, boolean>()
	let positioned = new Map<Element, boolean>()
	let paintOrders = new Map<Element, Map<Element, 'above' | 'below' | 'unknown'>>()
	let widgets: Map<string, Element> | undefined
	let candidateElements: Element[] | undefined
	let reaches = new Map<Element, boolean>()
	let generators = new Map<Element, boolean>()
	let texts = new Map<Element, boolean>()
	let filteredChains = new Map<Element, boolean>()
	// Per-pass caches: layout is read once per element per animation frame.
	let rects = new Map<Element, DOMRect>()
	let candidates: { elements: Element[]; boxes: Float64Array } | undefined
	let paintBounds = new Map<Element, Box | 'unbounded' | 'empty'>()
	let generatedContents = new Map<Element, GeneratedContent>()
	let ownTexts = new Map<Element, OwnText | undefined>()
	let topLayer: readonly Element[] | undefined
	let topLayerSet: ReadonlySet<Element> | undefined
	let chainShapes = new Map<Element, Map<ClipSide, PolygonShape[] | 'unsupported'>>()
	let coverShapes = new Map<Element, PolygonShape | undefined>()
	let viewport: Box | undefined

	function rectOf(element: Element): DOMRect {
		let rect = rects.get(element)
		if (!rect) {
			rect = element.getBoundingClientRect()
			rects.set(element, rect)
		}
		return rect
	}

	function styleOf(element: Element): StyleFacts {
		let style = styles.get(element)
		if (!style) {
			style = snapshotStyle(view.getComputedStyle(element))
			styles.set(element, style)
		}
		return style
	}

	function widgetElement(widgetId: string): Element | undefined {
		if (!widgets) {
			widgets = new Map()
			for (const element of Array.from(doc.querySelectorAll('[data-widget-id]'))) {
				const id = element.getAttribute('data-widget-id')
				if (id && !widgets.has(id)) widgets.set(id, element)
			}
		}
		return widgets.get(widgetId)
	}

	function viewportBox(): Box {
		if (!viewport) {
			const root = doc.documentElement
			viewport = { left: 0, top: 0, right: root.clientWidth, bottom: root.clientHeight }
		}
		return viewport
	}

	/**
	 * Every element that can paint over a Widget, with the box it can paint in, measured once per
	 * pass: its border box, grown by its own outsets and the filter extents of its chain when it has
	 * any (Discussion #241 owner decision 2). Paint without a finite bound is selected by its border box.
	 */
	function candidateBoxes(): { elements: Element[]; boxes: Float64Array } {
		if (candidates) return candidates
		if (!candidateElements) {
			candidateElements = []
			const all = doc.body ? doc.body.getElementsByTagName('*') : []
			for (let index = 0; index < all.length; index++) {
				const element = all[index]!
				// Elements inside an <svg> are covered by the <svg> root, which is replaced content.
				if (!(element instanceof view.HTMLElement) && element.tagName.toUpperCase() !== 'SVG') continue
				candidateElements.push(element)
			}
		}
		const elements = candidateElements
		const boxes = new Float64Array(elements.length * 4)
		elements.forEach((element, index) => {
			let box: Box = rectOf(element)
			if (mayPaintOutside(element) || textMayEscape(element)) {
				const extent = paintExtent(element, false)
				// Paint without a finite bound can reach any pixel its clips allow: it is selected everywhere
				// they do, never only where its border box is (Rule 01a11687-3214).
				if (extent === 'unbounded') {
					const clips = clipChainOf(element, true)
					box = union(box, clips === 'unsupported' ? viewportBox() : clips.box)
				}
				else box = union(box, extent)
			}
			boxes[index * 4] = box.left
			boxes[index * 4 + 1] = box.top
			boxes[index * 4 + 2] = box.right
			boxes[index * 4 + 3] = box.bottom
		})
		candidates = { elements, boxes }
		return candidates
	}

	/**
	 * Whether an element's own paint may reach beyond its border box through an outline, an outer
	 * shadow, a border-image outset, a replaced element's clip margin or a filter on its flat-tree
	 * chain. A cheap per-style-epoch screen over a few computed values, so that only these elements
	 * pay for the full paint extent in every pass.
	 */
	function mayPaintOutside(element: Element): boolean {
		let value = reaches.get(element)
		if (value === undefined) {
			const style = view.getComputedStyle(element)
			const chain = chainOf(element)
			value = filteredChain(element)
				|| !chain.planar
				|| chain.reflect
				|| style.boxShadow !== 'none'
				|| style.outlineStyle !== 'none'
				|| style.borderImageSource !== 'none'
				|| (CLIPPED_REPLACED_TAGS.has(element.tagName.toUpperCase()) && trailingLength(style.overflowClipMargin) !== 0)
				|| generatesContent(element)
			reaches.set(element, value)
		}
		return value
	}

	/** Whether the element has a `::before`, a `::after` or a list marker, judged from computed values only (per style epoch). */
	function generatesContent(element: Element): boolean {
		let value = generators.get(element)
		if (value === undefined) {
			const style = styleOf(element)
			value = (/(?:^|\s)list-item(?:\s|$)/.test(style.display) && (style.listStyleType !== 'none' || style.listStyleImage !== 'none'))
				|| pseudoGenerates(view.getComputedStyle(element, '::before'))
				|| pseudoGenerates(view.getComputedStyle(element, '::after'))
			generators.set(element, value)
		}
		return value
	}

	/** Whether the element has a text node child with something to paint (per style epoch). */
	function hasText(element: Element): boolean {
		let value = texts.get(element)
		if (value === undefined) {
			value = hasOwnText(element)
			texts.set(element, value)
		}
		return value
	}

	/**
	 * Whether an element's own text can paint beyond its border box, judged cheaply: it overflows its
	 * box, is laid out outside the horizontal left-to-right flow or indented backwards, or has a
	 * shadow, a stroke or a decoration that reaches past the glyphs. Evaluated in every pass: overflow
	 * is layout, not style.
	 */
	function textMayEscape(element: Element): boolean {
		const style = styleOf(element)
		if (!hasText(element)) return false
		if (style.textShadow !== 'none' || (style.webkitTextStrokeWidth !== '' && px(style.webkitTextStrokeWidth) !== 0) || decorationOf(element) !== undefined) return true
		if (isInlineDisplay(style) || clipsOwnContent(element, style)) return false
		if (style.direction !== 'ltr' || style.writingMode !== 'horizontal-tb' || (style.textIndent.startsWith('-') && px(style.textIndent) !== 0)) return true
		const html = element as HTMLElement
		return typeof html.scrollWidth === 'number' && (html.scrollWidth > html.clientWidth || html.scrollHeight > html.clientHeight)
	}

	function filteredChain(element: Element): boolean {
		let value = filteredChains.get(element)
		if (value === undefined) {
			const filter = view.getComputedStyle(element).filter
			const parent = flatTreeParent(element)
			value = (filter !== '' && filter !== 'none') || (!!parent && filteredChain(parent))
			filteredChains.set(element, value)
		}
		return value
	}

	/**
	 * `planar`: no 3D transform on the chain, so every transform is 2D affine and an element's
	 * rendered rect is the bounding box of its transformed border box. `reflect`: a box reflection
	 * on the chain paints a copy of the element elsewhere. `scale`: the uniform chain's scale
	 * (`uniformScaleOf`), NaN outside the uniform proof. `ceiling`: the product of every chain factor
	 * above 1, transformable or not, which bounds the rendered scale from above whichever transforms
	 * the engine applies. `transformed`: a transform on the chain.
	 */
	type ChainFlags = Readonly<{ opacity: number; transformOk: boolean; compositing: boolean; clipPath: boolean; mask: boolean; hidden: boolean; planar: boolean; reflect: boolean; scale: number; ceiling: number; transformed: boolean }>

	/** Aggregated style facts of an element and all its flat-tree ancestors. */
	function chainOf(element: Element): ChainFlags {
		const cached = chainFlags.get(element)
		if (cached) return cached
		const style = styleOf(element)
		const parent = flatTreeParent(element)
		const inherited: ChainFlags = parent ? chainOf(parent) : { opacity: 1, transformOk: true, compositing: false, clipPath: false, mask: false, hidden: false, planar: true, reflect: false, scale: 1, ceiling: 1, transformed: false }
		const opacity = Number.parseFloat(style.opacity)
		const transformOk = inherited.transformOk && !(parent && isSvgElement(parent)) && transformIsUniform(style)
		// The engine ignores the transform of a box that is not transformable, though it is computed.
		const zoom = zoomFactor(style)
		const transform = transformFactor(style)
		const flags: ChainFlags = {
			opacity: inherited.opacity * (Number.isFinite(opacity) ? opacity : 1),
			transformOk,
			compositing: inherited.compositing || hasCompositing(style),
			clipPath: inherited.clipPath || (style.clipPath !== '' && style.clipPath !== 'none'),
			mask: inherited.mask || hasMask(style),
			hidden: false,
			planar: inherited.planar && !hasThreeDTransform(style),
			reflect: inherited.reflect || (style.webkitBoxReflect !== '' && style.webkitBoxReflect !== 'none'),
			// A box classified as not transformable still enlarges the scale: a misclassification may only
			// ever over-estimate, never drop an applied scale-up.
			scale: transformOk ? inherited.scale * zoom * (isTransformable(element, style) ? transform : Math.max(1, transform)) : Number.NaN,
			ceiling: transformOk ? inherited.ceiling * Math.max(1, zoom) * Math.max(1, transform) : Number.NaN,
			transformed: inherited.transformed || hasTransform(style),
		}
		chainFlags.set(element, flags)
		return flags
	}

	/**
	 * Scale of an element's rendered box over its local CSS px under a uniform chain: the product of
	 * the chain's transform scales and zoom factors, exact where the pixel-snapped `offsetWidth` and
	 * `offsetHeight` (each within 1px of the layout size) are not. When that product disagrees with
	 * the rendered rect (an unmodelled scaling), the rect over the smallest layout size the snapped
	 * one allows bounds it from above; undefined when no bound is provable. Without a snapped size
	 * above 1px the agreement cannot be checked, so the chain's ceiling bounds the scale instead.
	 */
	function uniformScaleOf(element: Element): number | undefined {
		const { scale, ceiling } = chainOf(element)
		if (!(scale > 0) || !Number.isFinite(scale) || !Number.isFinite(ceiling)) return undefined
		const html = element as HTMLElement
		if (typeof html.offsetWidth !== 'number' || typeof html.offsetHeight !== 'number' || html.offsetWidth <= 1 || html.offsetHeight <= 1) return Math.max(scale, ceiling)
		const rect = rectOf(element)
		const agrees = (rendered: number, snapped: number) => Math.abs(rendered - scale * snapped) <= scale + 1e-3
		if (agrees(rect.width, html.offsetWidth) && agrees(rect.height, html.offsetHeight)) return scale
		const bound = Math.max(rect.width / (html.offsetWidth - 1), rect.height / (html.offsetHeight - 1))
		return html.offsetWidth > 1 && html.offsetHeight > 1 && Number.isFinite(bound) ? bound : undefined
	}

	/** Scale of an element's rendered box over its layout box (uniform under the transform proof). */
	function scaleOf(element: Element): number {
		const scale = uniformScaleOf(element)
		if (scale !== undefined) return scale
		const html = element as HTMLElement
		return typeof html.offsetWidth === 'number' && html.offsetWidth > 0 ? rectOf(element).width / html.offsetWidth : 1
	}

	function radiiOf(element: Element, rect: WidgetRect): RoundedRectRadii | undefined {
		const style = styleOf(element)
		const scale = scaleOf(element)
		// A percentage resolves against the rendered border box, which is exact under the uniform chain.
		const resolve = (value: string | undefined, basis: number) => value?.endsWith('%') ? (Number.parseFloat(value) / 100) * basis : px(value) * scale
		const corner = (value: string) => {
			const [first, second] = value.trim().split(/\s+/)
			const rx = resolve(first, rect.width)
			const ry = resolve(second ?? first, rect.height)
			return { rx: rx > 0 && ry > 0 ? rx : 0, ry: rx > 0 && ry > 0 ? ry : 0 }
		}
		const radii = {
			topLeft: corner(style.borderTopLeftRadius),
			topRight: corner(style.borderTopRightRadius),
			bottomRight: corner(style.borderBottomRightRadius),
			bottomLeft: corner(style.borderBottomLeftRadius),
		}
		return Object.values(radii).some(radius => radius.rx > 0) ? radii : undefined
	}

	/**
	 * The padding box of an overflow clip, its inner radii applying when the clip is rounded.
	 * `outward` measures it from the exact border box and border widths instead of the integer
	 * `clientLeft`/`clientWidth` (each within 1px of the layout values), scrollbars included, so that
	 * it never under-covers the clip.
	 */
	function clipShapeOf(element: Element, outward = false): Readonly<{ box: Box; rounded?: RoundedShape }> {
		const style = styleOf(element)
		const rect = rectOf(element)
		const scale = scaleOf(element)
		const html = element as HTMLElement
		const left = rect.left + (html.clientLeft ?? 0) * scale
		const top = rect.top + (html.clientTop ?? 0) * scale
		const box = outward
			? {
					left: rect.left + px(style.borderLeftWidth) * scale,
					top: rect.top + px(style.borderTopWidth) * scale,
					right: rect.right - px(style.borderRightWidth) * scale,
					bottom: rect.bottom - px(style.borderBottomWidth) * scale,
				}
			: {
					left,
					top,
					right: left + (html.clientWidth ?? rect.width) * scale,
					bottom: top + (html.clientHeight ?? rect.height) * scale,
				}
		const outer = radiiOf(element, { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
		if (!outer) return { box }
		const bl = px(style.borderLeftWidth) * scale
		const bt = px(style.borderTopWidth) * scale
		const br = px(style.borderRightWidth) * scale
		const bb = px(style.borderBottomWidth) * scale
		const inner = (radius: { rx: number; ry: number }, bx: number, by: number) => {
			const rx = Math.max(0, radius.rx - bx)
			const ry = Math.max(0, radius.ry - by)
			return rx > 0 && ry > 0 ? { rx, ry } : { rx: 0, ry: 0 }
		}
		const radii = {
			topLeft: inner(outer.topLeft, bl, bt),
			topRight: inner(outer.topRight, br, bt),
			bottomRight: inner(outer.bottomRight, br, bb),
			bottomLeft: inner(outer.bottomLeft, bl, bb),
		}
		const innerRect = { x: rect.left + bl, y: rect.top + bt, width: rect.width - bl - br, height: rect.height - bt - bb }
		if (!Object.values(radii).some(radius => radius.rx > 0) || !(innerRect.width > 0) || !(innerRect.height > 0)) return { box }
		return { box, rounded: { rect: innerRect, radii } }
	}

	/**
	 * Intersection of the content viewport with every clip on the element's containing-block chain.
	 * Absolutely positioned boxes escape overflow clips below their containing block; fixed boxes
	 * escape every clip below an ancestor that contains fixed descendants.
	 */
	function clipChainOf(element: Element, outward = false, conservative = false): ClipChain {
		let box = viewportBox()
		const rounded: RoundedShape[] = []
		let mode = positionMode(styleOf(element))
		const top = topLayerElements()
		for (let ancestor = element.parentElement, below: Element = element; ancestor; below = ancestor, ancestor = ancestor.parentElement) {
			// A top-layer element is rendered outside its ancestors: their clips do not reach it.
			if (top.has(below)) break
			if (ancestor === doc.body || ancestor === doc.documentElement) break
			const style = styleOf(ancestor)
			const containsFixed = containsFixedDescendants(style)
			const containing = mode === 'flow'
				|| (mode === 'absolute' && (style.position !== 'static' || containsFixed))
				|| (mode === 'fixed' && containsFixed)
			if (!containing) continue
			const overflows = overflowApplies(ancestor, style, conservative)
			const clipX = (overflows && style.overflowX !== 'visible') || containsPaint(style)
			const clipY = (overflows && style.overflowY !== 'visible') || containsPaint(style)
			if (clipX || clipY) {
				if ((style.overflowX === 'clip' || style.overflowY === 'clip') && px(style.overflowClipMargin) !== 0) return 'unsupported'
				const shape = clipShapeOf(ancestor, outward)
				box = {
					left: clipX ? Math.max(box.left, shape.box.left) : box.left,
					top: clipY ? Math.max(box.top, shape.box.top) : box.top,
					right: clipX ? Math.min(box.right, shape.box.right) : box.right,
					bottom: clipY ? Math.min(box.bottom, shape.box.bottom) : box.bottom,
				}
				if (shape.rounded) {
					if (!(clipX && clipY)) return 'unsupported'
					rounded.push(shape.rounded)
				}
			}
			mode = positionMode(style)
		}
		return { box, rounded }
	}

	function measure(widgetId: string): WidgetGeometry {
		const element = widgetElement(widgetId)
		if (!element || !element.isConnected || element.getClientRects().length === 0) return ZERO_GEOMETRY
		const bounds = rectOf(element)
		const rect: WidgetRect = Object.freeze({ x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
		if (!(rect.width > 0) || !(rect.height > 0)) return Object.freeze({ rect, regions: Object.freeze([]) })
		return Object.freeze({ rect, regions: Object.freeze(visibleRegions(element, rect)) })
	}

	function visibleRegions(element: Element, rect: WidgetRect): readonly VisibleRegion[] {
		const style = styleOf(element)
		if (style.visibility !== 'visible') return []
		const chain = chainOf(element)
		if (chain.opacity === 0 || !chain.transformOk || chain.compositing || chain.mask) return []

		const clips = clipChainOf(element, false, true)
		if (clips === 'unsupported') return []
		const visible = intersect(boxOfRect(rect), clips.box)
		if (!visible) return []

		// Shapes the Widget stays inside, each approximated from inside: its own rounded corners and
		// those of a rounded overflow clip whose corners reach the visible area, then every clip path.
		const contained: PolygonShape[] = []
		const own = radiiOf(element, rect)
		const roundedClips: RoundedShape[] = []
		if (own && cornersReach({ rect, radii: own }, visible)) roundedClips.push({ rect, radii: own })
		for (const shape of clips.rounded) if (cornersReach(shape, visible)) roundedClips.push(shape)
		for (const shape of roundedClips) {
			const approximated = roundedRectShape(shape.rect, shape.radii, 'contain', roundedTargetMaxError)
			if (!approximated) return []
			contained.push(approximated)
		}
		if (chain.clipPath) {
			const shapes = chainClipShapes(element, 'contain')
			if (shapes === 'unsupported') return []
			contained.push(...shapes)
		}

		const occlusion = occlusionEvidence(element, visible)
		if (occlusion === 'unsupported') return []
		const plan = planOcclusion(occlusion)
		if (plan.status !== 'precise') return []

		// A bounded cut lying wholly inside the visible area would leave only an interior hole, which
		// is never reported (Rule 01a11687-3037): no precise region (Discussion #241 owner decision 1).
		for (const cut of plan.subtract) {
			if (cut.kind !== 'paint-bound') continue
			const { x, y, width, height } = cut.shape as WidgetRect
			if (x > visible.left && y > visible.top && x + width < visible.right && y + height < visible.bottom) return []
		}

		const curved = contained.length > 0 || plan.subtract.some(cut => isPolygonCut(cut.shape))
		if (!curved) {
			const contours = subtractAxisAlignedRectangularOcclusion(rectOfBox(visible), plan.subtract.map(item => item.shape as WidgetRect))
			if (!contours) return []
			return contours.map((contour, index) => Object.freeze({ regionId: `r${index}`, maxError: 0, contour }))
		}

		// Curved shapes on either side: polygons, with the largest approximation error they carry.
		let base: PolygonShape | undefined = rectangleShape(visible.left, visible.top, visible.right, visible.bottom)
		if (contained.length > 0) base = intersectShapes(base, contained)
		if (!base) return []
		const cuts = cappedCuts(plan.subtract.map(cut => isPolygonCut(cut.shape) ? cut.shape : rectangleShape(cut.shape.x, cut.shape.y, cut.shape.x + cut.shape.width, cut.shape.y + cut.shape.height)))
		if (!cuts) return []
		const result = subtractShapes(base, cuts)
		if (!result) return []
		const rings = outerRings(result)
		if (!rings) return []
		return rings.map((ring, index) => Object.freeze({
			regionId: `r${index}`,
			maxError: result.maxError,
			contour: Object.freeze({ commands: Object.freeze(polygonCommands(ring.map(([x, y]) => ({ x, y })))) }),
		}))
	}

	/**
	 * The cuts of one Widget within the work caps. Past `MAX_CUT_SHAPES` polygons or `MAX_CUT_VERTICES`
	 * vertices in all, every polygon cut becomes its bounding box, which contains it and so only
	 * removes more; past `MAX_TOTAL_CUTS` cuts of any kind there is no answer.
	 */
	function cappedCuts(cuts: PolygonShape[]): PolygonShape[] | undefined {
		if (cuts.length > MAX_TOTAL_CUTS) return undefined
		const polygons = cuts.filter(cut => cut.polygons.length > 0 && !isRectangleShape(cut))
		if (polygons.length <= MAX_CUT_SHAPES && polygons.reduce((sum, cut) => sum + vertexCount(cut), 0) <= MAX_CUT_VERTICES) return cuts
		return cuts.flatMap((cut) => {
			if (!polygons.includes(cut)) return [cut]
			const bounds = boundsOf(cut)
			return bounds ? [rectangleShape(bounds.left, bounds.top, bounds.right, bounds.bottom)] : []
		})
	}

	/**
	 * Every clip path on the element's flat-tree chain as a polygon shape on the given side, or
	 * `unsupported` when one cannot be derived: a mask, a path, URL or reference form this module does
	 * not model, a box without a measurable scale, an SVG element.
	 */
	function chainClipShapes(element: Element, side: ClipSide): PolygonShape[] | 'unsupported' {
		let bySide = chainShapes.get(element)
		if (!bySide) chainShapes.set(element, bySide = new Map())
		let shapes = bySide.get(side)
		if (!shapes) bySide.set(side, shapes = computeChainClipShapes(element, side))
		return shapes
	}

	function computeChainClipShapes(element: Element, side: ClipSide): PolygonShape[] | 'unsupported' {
		const shapes: PolygonShape[] = []
		const top = topLayerElements()
		for (let node: Element | null = element; node; node = flatTreeParent(node)) {
			const style = styleOf(node)
			if (hasMask(style)) return 'unsupported'
			if (style.clipPath !== '' && style.clipPath !== 'none') {
				const shape = clipPathShape(node, style, side)
				if (!shape) return 'unsupported'
				shapes.push(shape)
			}
			// A top-layer element is rendered outside its ancestors: their clips do not reach it.
			if (top.has(node)) break
		}
		return shapes
	}

	function topLayerElements(): ReadonlySet<Element> {
		return topLayerSet ??= new Set(topLayerRoots())
	}

	/**
	 * The scale of an element's local CSS px to page px, only when it is proven exact: the uniform
	 * chain's scale, agreeing with the rendered rect to within the pixel snapping of the integer layout
	 * size. Undefined otherwise: a shape derived from it could not be called exact.
	 */
	function exactScaleOf(element: Element): number | undefined {
		const { scale } = chainOf(element)
		if (!(scale > 0) || !Number.isFinite(scale)) return undefined
		const html = element as HTMLElement
		if (typeof html.offsetWidth !== 'number' || typeof html.offsetHeight !== 'number' || html.offsetWidth <= 1 || html.offsetHeight <= 1) return undefined
		const rect = rectOf(element)
		const agrees = (rendered: number, snapped: number) => Math.abs(rendered - scale * snapped) <= scale + 1e-3
		return agrees(rect.width, html.offsetWidth) && agrees(rect.height, html.offsetHeight) ? scale : undefined
	}

	/** The reference box of a `clip-path` in page px, for the geometry boxes of an HTML box. */
	function referenceBoxOf(element: Element, style: StyleFacts, box: 'border-box' | 'padding-box' | 'content-box', scale: number): Box | undefined {
		if (isSvgElement(element) || !isBoxed(style)) return undefined
		const rect = rectOf(element)
		if (!(rect.width > 0) || !(rect.height > 0)) return undefined
		const border = { left: px(style.borderLeftWidth) * scale, top: px(style.borderTopWidth) * scale, right: px(style.borderRightWidth) * scale, bottom: px(style.borderBottomWidth) * scale }
		const padding = { left: px(style.paddingLeft) * scale, top: px(style.paddingTop) * scale, right: px(style.paddingRight) * scale, bottom: px(style.paddingBottom) * scale }
		const inset = box === 'border-box' ? { left: 0, top: 0, right: 0, bottom: 0 }
			: box === 'padding-box' ? border
				: { left: border.left + padding.left, top: border.top + padding.top, right: border.right + padding.right, bottom: border.bottom + padding.bottom }
		return { left: rect.left + inset.left, top: rect.top + inset.top, right: rect.right - inset.right, bottom: rect.bottom - inset.bottom }
	}

	/** The shape of one element's own `clip-path` (a basic shape or an SVG `<clipPath>` reference). */
	function clipPathShape(element: Element, style: StyleFacts, side: ClipSide): PolygonShape | undefined {
		const parsed = parseClipPath(style.clipPath)
		if (!parsed || parsed.kind === 'none') return undefined
		const scale = exactScaleOf(element)
		if (scale === undefined) return undefined
		if (parsed.kind === 'shape') {
			const box = referenceBoxOf(element, style, parsed.box, scale)
			return box ? basicShapePolygon(parsed.shape, box, scale, side, roundedTargetMaxError) : undefined
		}
		const rect = rectOf(element)
		if (isSvgElement(element) || !isBoxed(style) || !(rect.width > 0) || !(rect.height > 0)) return undefined
		return svgClipPathShape(element, parsed.id, { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, scale, side)
	}

	/**
	 * The shape of a geometric SVG `<clipPath>` (`rect`, `circle`, `ellipse` and `polygon` children
	 * without transforms or clips of their own) referenced by an HTML element: the union of its
	 * children. User space has its origin at the border box's top-left corner and one local CSS px per
	 * user unit; `objectBoundingBox` units are fractions of the border box.
	 */
	function svgClipPathShape(element: Element, id: string, border: Box, scale: number, side: ClipSide): PolygonShape | undefined {
		const root = element.getRootNode() as Partial<Document>
		const target = typeof root.getElementById === 'function' ? root.getElementById(id) : null
		if (!target || target.localName !== 'clipPath' || target.namespaceURI !== 'http://www.w3.org/2000/svg') return undefined
		if (target.hasAttribute('transform') || target.hasAttribute('clip-path')) return undefined
		const own = view.getComputedStyle(target)
		if (own.clipPath !== 'none' && own.clipPath !== '') return undefined
		const units = target.getAttribute('clipPathUnits') ?? 'userSpaceOnUse'
		if (units !== 'userSpaceOnUse' && units !== 'objectBoundingBox') return undefined
		const bounding = units === 'objectBoundingBox'
		const mapping = bounding
			? { x: border.left, y: border.top, sx: border.right - border.left, sy: border.bottom - border.top }
			: { x: border.left, y: border.top, sx: scale, sy: scale }
		const shapes: PolygonShape[] = []
		for (const child of Array.from(target.children)) {
			const style = view.getComputedStyle(child)
			if (style.display === 'none') continue
			if (child.hasAttribute('transform') || child.hasAttribute('clip-path') || (style.transform !== 'none' && style.transform !== '') || (style.clipPath !== 'none' && style.clipPath !== '')) return undefined
			if (style.visibility !== 'visible') return undefined
			const primitive = svgPrimitiveOf(child, style)
			if (!primitive) return undefined
			const shape = svgPrimitiveShape(primitive, mapping, side, roundedTargetMaxError)
			if (!shape) return undefined
			shapes.push(shape)
		}
		if (shapes.length === 0) return EMPTY_SHAPE
		return unionShapes(shapes)
	}

	function svgPrimitiveOf(child: Element, style: CSSStyleDeclaration): SvgPrimitive | undefined {
		const user = (value: string | undefined): number | undefined => {
			const text = (value ?? '').trim()
			if (text === '' || text === 'auto') return 0
			const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(px)?$/i.exec(text)
			// A percentage or relative length has no exact value here; `px` and a bare number are user units (fractions of the box under `objectBoundingBox`).
			return match ? Number(match[1]) : undefined
		}
		switch (child.localName) {
			case 'rect': {
				const [x, y, width, height] = [user(style.x), user(style.y), user(style.width), user(style.height)]
				const radiusX = style.rx.trim() === 'auto' ? undefined : user(style.rx)
				const radiusY = style.ry.trim() === 'auto' ? undefined : user(style.ry)
				if (x === undefined || y === undefined || width === undefined || height === undefined) return undefined
				if ((style.rx.trim() !== 'auto' && radiusX === undefined) || (style.ry.trim() !== 'auto' && radiusY === undefined)) return undefined
				if (style.width.trim() === 'auto' || style.height.trim() === 'auto') return undefined
				return { kind: 'rect', x, y, width, height, rx: radiusX ?? radiusY ?? 0, ry: radiusY ?? radiusX ?? 0 }
			}
			case 'circle': {
				const [cx, cy, r] = [user(style.cx), user(style.cy), user(style.r)]
				return cx === undefined || cy === undefined || r === undefined ? undefined : { kind: 'circle', cx, cy, r }
			}
			case 'ellipse': {
				const [cx, cy] = [user(style.cx), user(style.cy)]
				const radiusX = style.rx.trim() === 'auto' ? undefined : user(style.rx)
				const radiusY = style.ry.trim() === 'auto' ? undefined : user(style.ry)
				if (cx === undefined || cy === undefined || (radiusX === undefined && radiusY === undefined)) return undefined
				if ((style.rx.trim() !== 'auto' && radiusX === undefined) || (style.ry.trim() !== 'auto' && radiusY === undefined)) return undefined
				return { kind: 'ellipse', cx, cy, rx: radiusX ?? radiusY!, ry: radiusY ?? radiusX! }
			}
			case 'polygon': {
				const numbers = (child.getAttribute('points') ?? '').trim().split(/[\s,]+/).filter(Boolean).map(Number)
				if (numbers.length < 6 || numbers.length % 2 !== 0 || !numbers.every(Number.isFinite)) return undefined
				const points: Array<readonly [number, number]> = []
				for (let index = 0; index < numbers.length; index += 2) points.push([numbers[index]!, numbers[index + 1]!])
				return { kind: 'polygon', points }
			}
			default:
				return undefined
		}
	}

	/** Classifies every element whose paint can reach the visible area and is not the Widget's own. */
	function occlusionEvidence(target: Element, visible: Box): OcclusionEvidence<CutShape>[] | 'unsupported' {
		const { elements, boxes } = candidateBoxes()
		const evidence: OcclusionEvidence<CutShape>[] = []
		for (let index = 0; index < elements.length; index++) {
			const left = Math.max(visible.left, boxes[index * 4]!)
			const top = Math.max(visible.top, boxes[index * 4 + 1]!)
			const right = Math.min(visible.right, boxes[index * 4 + 2]!)
			const bottom = Math.min(visible.bottom, boxes[index * 4 + 3]!)
			if (!(right > left) || !(bottom > top)) continue
			const candidate = elements[index]!
			if (candidate === target || candidate.contains(target) || target.contains(candidate)) continue
			const items = classifyCandidate(candidate, target, visible)
			if (items === 'unsupported') return 'unsupported'
			evidence.push(...items)
		}
		// The `::backdrop` of a top-layer element paints over the whole viewport, wherever the element is.
		for (const root of topLayerRoots()) {
			if (root === target || root.contains(target)) continue
			const items = backdropEvidence(root)
			if (items === 'unsupported') return 'unsupported'
			evidence.push(...items)
		}
		return evidence
	}

	/** The elements in the top layer (modal dialogs, open popovers, the fullscreen element), found once per pass. */
	function topLayerRoots(): readonly Element[] {
		if (!topLayer) {
			try {
				topLayer = Array.from(doc.querySelectorAll(':modal, :popover-open, :fullscreen'))
			}
			catch {
				// Engines without these pseudo-classes have no top layer content of that kind.
				topLayer = []
			}
		}
		return topLayer
	}

	/**
	 * What a top-layer element's `::backdrop` paints: nothing, something translucent (kept), or
	 * paint that is not proven translucent (an opaque or image fill, a filter, a blend, a border or
	 * shadow): its box is the viewport only by default, so that is unsupported, not a cut.
	 */
	function backdropEvidence(root: Element): Evidence[] | 'unsupported' {
		const facts = view.getComputedStyle(root, '::backdrop')
		const alpha = colorAlpha(facts.backgroundColor)
		if (alpha === undefined) return 'unsupported'
		const opacity = Number.parseFloat(facts.opacity)
		const image = facts.backgroundImage !== '' && facts.backgroundImage !== 'none'
		const set = (value: string | undefined) => value !== undefined && value !== '' && value !== 'none'
		const border = (['Top', 'Right', 'Bottom', 'Left'] as const).some(side => px(facts.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0 && facts.getPropertyValue(`border-${side.toLowerCase()}-style`) !== 'none')
		const marks = alpha > 0 || image || border || set(facts.boxShadow) || (facts.outlineStyle !== 'none' && px(facts.outlineWidth) > 0)
		if (!marks || opacity === 0) return []
		if (facts.visibility === 'hidden') return []
		if (set(facts.filter) || set(facts.backdropFilter) || (facts.mixBlendMode !== '' && facts.mixBlendMode !== 'normal')) return 'unsupported'
		if (opacity < 1) return [TRANSLUCENT]
		if (alpha === 1 || image || border || set(facts.boxShadow) || (facts.outlineStyle !== 'none' && px(facts.outlineWidth) > 0)) return 'unsupported'
		return [TRANSLUCENT]
	}

	type Evidence = OcclusionEvidence<CutShape>
	const TRANSLUCENT: Evidence = Object.freeze({ classification: 'translucent', targetContribution: 'proven-nonzero' })

	/**
	 * The evidence of one element, for every pixel it paints (its children are candidates of their
	 * own): an opaque fill is subtracted exactly, a translucent fill keeps what it covers, and any paint
	 * beyond that, such as borders, shadows, outlines, text, generated content and markers, is neither
	 * ignored nor assumed translucent: it is cut by its finite paint bound, or is unbounded (Rule
	 * 01a11687-3214).
	 */
	function classifyCandidate(candidate: Element, target: Element, visible: Box): Evidence[] | 'unsupported' {
		const style = styleOf(candidate)
		if (style.visibility !== 'visible') return []
		const chain = chainOf(candidate)
		if (chain.opacity === 0) return []
		const replaced = isReplacedPaint(candidate, style)
		const fill = replaced ? 'unknown' : fillKind(style)
		if (!replaced && fill === 'none' && !paintsBesidesFill(candidate, style)) return []
		// An undecided order is taken as above: covering paint that is really below only cuts more.
		const order = paintOrder(candidate, target)
		if (order === 'below') return []
		const bounded = (): Evidence[] | 'unsupported' => {
			const cut = boundedCut(candidate)
			return cut === 'unsupported' ? cut : cut ? [cut] : []
		}
		if (replaced || chain.compositing || chain.mask || !chain.transformOk || chain.reflect) return bounded()
		// Under an opacity below 1 everything the element paints, text and borders included, lets the Widget show.
		if (chain.opacity < 1) return chain.clipPath ? bounded() : [TRANSLUCENT]
		if (fill === 'unknown') return bounded()

		const evidence: Evidence[] = []
		if (fill === 'translucent') {
			if (chain.clipPath) return bounded()
			evidence.push(TRANSLUCENT)
		}
		let exact: ExactCut | undefined
		if (fill === 'opaque') {
			if (order === 'unknown') return bounded()
			const result = exactOpaqueCut(candidate, style, chain, visible)
			if (result === 'bounded') return bounded()
			exact = result
		}
		const extra = extraPaint(candidate, style, exact)
		if (extra === 'unbounded') return 'unsupported'
		if (extra === 'bounded') {
			const cut = boundedCut(candidate)
			if (cut === 'unsupported') return cut
			// The paint bound contains the exact cut: it replaces it.
			return cut ? [...evidence, cut] : evidence
		}
		// A border an opaque fill does not lie under (a fill clipped to the padding or content box).
		if (!(fill === 'opaque' && (style.backgroundClip === 'border-box' || style.backgroundClip === ''))) {
			const borders = borderEvidence(candidate, style)
			if (borders === 'bounded') return bounded()
			evidence.push(...borders)
		}
		if (exact) evidence.push(exact.evidence)
		return evidence
	}

	/** The exact cut of an opaque fill, and the rectangle it is when it is one (for the paint that must lie under it). */
	type ExactCut = Readonly<{ evidence: Evidence; rect: Box | undefined; clip: Box }>

	/**
	 * Opaque background: the covered area is the background painting area, clipped by the occluder's
	 * own clip chain. Rounded corners, clip paths and SVG clip paths that reach the Widget make the
	 * covered area a polygon that contains the true shape (Rules 01a11687-3109, 01a11687-3297); one that
	 * cannot be derived exactly falls back to the finite paint bound (`bounded`). Undefined: it covers
	 * nothing the Widget can show.
	 */
	function exactOpaqueCut(candidate: Element, style: StyleFacts, chain: ChainFlags, visible: Box): ExactCut | 'bounded' | undefined {
		const bounds = rectOf(candidate)
		const scale = scaleOf(candidate)
		const inset = backgroundInset(style, scale)
		const covered = { left: bounds.left + inset.left, top: bounds.top + inset.top, right: bounds.right - inset.right, bottom: bounds.bottom - inset.bottom }
		const clips = clipChainOf(candidate)
		if (clips === 'unsupported') return 'bounded'
		const painted = intersect(covered, clips.box)
		if (!painted) return undefined
		const reach = intersect(painted, visible) ?? painted
		const covers: PolygonShape[] = []
		let kind: ProvenOccluderShapeKind = 'rectangle'
		const outer = radiiOf(candidate, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
		if (outer) {
			const radii = insetRadii(outer, inset)
			const shape: RoundedShape = { rect: rectOfBox(covered), radii }
			if (cornersReach(shape, reach)) {
				let approximated = coverShapes.get(candidate)
				if (!coverShapes.has(candidate)) {
					approximated = exactScaleOf(candidate) === undefined ? undefined : roundedRectShape(shape.rect, shape.radii, 'cover', roundedTargetMaxError)
					coverShapes.set(candidate, approximated)
				}
				if (!approximated) return 'bounded'
				covers.push(approximated)
				kind = 'rounded-box'
			}
		}
		for (const shape of clips.rounded) {
			if (!cornersReach(shape, reach)) continue
			const approximated = roundedRectShape(shape.rect, shape.radii, 'cover', roundedTargetMaxError)
			if (!approximated) return 'bounded'
			covers.push(approximated)
			kind = 'rounded-box'
		}
		if (chain.clipPath) {
			const shapes = chainClipShapes(candidate, 'cover')
			if (shapes === 'unsupported') return 'bounded'
			covers.push(...shapes)
			kind = clipShapeKind(candidate)
		}
		if (covers.length === 0) return { evidence: { classification: 'opaque', targetContribution: 'proven-zero', shape: { kind: 'rectangle', shape: rectOfBox(painted) } }, rect: painted, clip: clips.box }
		const shape = intersectShapes(rectangleShape(painted.left, painted.top, painted.right, painted.bottom), covers)
		if (!shape) return 'bounded'
		// Nothing of the occluder lies where it clips: it covers nothing. An empty answer for shapes whose
		// boxes overlap is not believed: the paint bound stands in for it.
		if (shape.polygons.length === 0) {
			const painting = rectangleShape(painted.left, painted.top, painted.right, painted.bottom)
			const plausible = covers.every(cover => cover.polygons.length > 0 && boundsOverlap(boundsOf(cover), boundsOf(painting)))
			return plausible ? 'bounded' : undefined
		}
		return { evidence: { classification: 'opaque', targetContribution: 'proven-zero', shape: { kind, shape } }, rect: undefined, clip: clips.box }
	}

	/**
	 * What an element paints beyond its exact opaque fill, if it has one: its outlines and outer
	 * shadows, its text, its generated content and marker, each only when it is not wholly under the
	 * exact rectangle. `bounded`: cut by the paint bound; `unbounded`: no finite bound is provable.
	 */
	function extraPaint(element: Element, style: StyleFacts, exact: ExactCut | undefined): 'none' | 'bounded' | 'unbounded' {
		const outsets = ownPaintOutsets(element, style)
		if (!outsets) return 'unbounded'
		if (!isZeroOutsets(outsets)) return 'bounded'
		// Paint that lies under the exact rectangle, after the element's clips, is covered already.
		const under = (box: Box) => {
			if (!exact?.rect) return false
			const shown = intersect(box, exact.clip)
			return shown === undefined || contains(exact.rect, shown)
		}
		const content = generatedContent(element)
		if (content === 'unbounded') return 'unbounded'
		if (content.boxes.some(box => !under(box))) return 'bounded'
		if (content.flow) {
			const overflow = flowOverflowBox(element, style)
			if (overflow === 'unbounded') return 'unbounded'
			if (overflow || !under(rectOf(element))) return 'bounded'
		}
		const text = ownTextBound(element, style, false)
		if (text === 'unbounded') return 'unbounded'
		if (text) {
			// Text the element clips itself (overflow, containment) never leaves its padding box.
			const scale = uniformScaleOf(element)
			const rect = rectOf(element)
			const clipped = clipsOwnContent(element, style) && scale !== undefined
				? intersect(text, { left: rect.left + px(style.borderLeftWidth) * scale, top: rect.top + px(style.borderTopWidth) * scale, right: rect.right - px(style.borderRightWidth) * scale, bottom: rect.bottom - px(style.borderBottomWidth) * scale })
				: text
			if (clipped && !under(clipped)) return 'bounded'
		}
		return 'none'
	}

	/**
	 * Evidence for an element's borders: a solid opaque border without rounded corners is four exact
	 * rectangles, a translucent one keeps what it covers, and any other border (dashed, double,
	 * rounded, an image) is `bounded`.
	 */
	function borderEvidence(element: Element, style: StyleFacts): Evidence[] | 'bounded' {
		const sides = (['Top', 'Right', 'Bottom', 'Left'] as const).filter((side) => {
			const lineStyle = style[`border${side}Style`]
			return px(style[`border${side}Width`]) > 0 && lineStyle !== 'none' && lineStyle !== 'hidden' && colorAlpha(style[`border${side}Color`]) !== 0
		})
		if (sides.length === 0) return []
		if (style.borderImageSource !== 'none' && style.borderImageSource !== '') return 'bounded'
		const evidence: Evidence[] = []
		let opaque = false
		for (const side of sides) {
			const alpha = colorAlpha(style[`border${side}Color`])
			if (alpha === undefined) return 'bounded'
			if (alpha < 1) {
				if (!evidence.includes(TRANSLUCENT)) evidence.push(TRANSLUCENT)
				continue
			}
			if (style[`border${side}Style`] !== 'solid') return 'bounded'
			opaque = true
		}
		if (!opaque) return evidence
		const bounds = rectOf(element)
		const outer = radiiOf(element, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
		const clips = clipChainOf(element)
		if (outer || clips === 'unsupported' || clips.rounded.length > 0 || chainOf(element).clipPath) return 'bounded'
		const scale = scaleOf(element)
		// Each strip spans the whole side, corners included: where two solid opaque sides meet, that is exactly what they paint.
		const strips: Readonly<Record<typeof sides[number], Box>> = {
			Top: { left: bounds.left, top: bounds.top, right: bounds.right, bottom: bounds.top + px(style.borderTopWidth) * scale },
			Bottom: { left: bounds.left, top: bounds.bottom - px(style.borderBottomWidth) * scale, right: bounds.right, bottom: bounds.bottom },
			Left: { left: bounds.left, top: bounds.top, right: bounds.left + px(style.borderLeftWidth) * scale, bottom: bounds.bottom },
			Right: { left: bounds.right - px(style.borderRightWidth) * scale, top: bounds.top, right: bounds.right, bottom: bounds.bottom },
		}
		for (const side of sides) {
			if (colorAlpha(style[`border${side}Color`]) !== 1) continue
			const shown = intersect(strips[side], clips.box)
			if (shown) evidence.push({ classification: 'opaque', targetContribution: 'proven-zero', shape: { kind: 'rectangle', shape: rectOfBox(shown) } })
		}
		return evidence
	}

	/** Whether the element paints anything besides its background colour: borders, outlines, shadows, text, generated content. */
	function paintsBesidesFill(element: Element, style: StyleFacts): boolean {
		if (hasVisibleBorder(style) || hasText(element)) return true
		const outsets = ownPaintOutsets(element, style)
		if (!outsets || !isZeroOutsets(outsets) || style.boxShadow !== 'none' || (style.outlineStyle !== 'none' && px(style.outlineWidth) > 0)) return true
		const content = generatedContent(element)
		return content === 'unbounded' || content.flow || content.boxes.length > 0
	}

	/** The kind of the nearest clip path on the element's flat-tree chain. */
	function clipShapeKind(element: Element): ProvenOccluderShapeKind {
		for (let node: Element | null = element; node; node = flatTreeParent(node)) {
			const parsed = parseClipPath(styleOf(node).clipPath)
			if (!parsed || parsed.kind === 'none') continue
			if (parsed.kind === 'url') return 'svg-clip-path'
			return parsed.shape.kind === 'inset' ? 'clip-inset' : parsed.shape.kind === 'circle' ? 'clip-circle' : parsed.shape.kind === 'ellipse' ? 'clip-ellipse' : 'clip-polygon'
		}
		return 'rectangle'
	}

	/**
	 * Evidence for an occluder whose exact covering shape or paint order is unproven: its finite
	 * paint bound (Discussion #241 R6), or `unsupported` when no finite bound is provable.
	 */
	function boundedCut(candidate: Element): OcclusionEvidence<CutShape> | 'unsupported' | undefined {
		const bound = paintBound(candidate)
		if (bound === 'unbounded') return 'unsupported'
		if (bound === 'empty') return undefined
		// Rasterization covers every device pixel the paint touches, antialiased edges included. The
		// engine snaps box paint to whole CSS px before scaling to device pixels, so an edge can move
		// up to half a CSS px at any device pixel ratio: round outward to whole CSS px, then outward to
		// device pixels.
		const ratio = view.devicePixelRatio > 0 ? view.devicePixelRatio : 1
		const outward = {
			left: Math.floor(Math.floor(bound.left) * ratio) / ratio,
			top: Math.floor(Math.floor(bound.top) * ratio) / ratio,
			right: Math.ceil(Math.ceil(bound.right) * ratio) / ratio,
			bottom: Math.ceil(Math.ceil(bound.bottom) * ratio) / ratio,
		}
		return { classification: 'bounded', targetContribution: 'unproven', bound: { kind: 'paint-bound', shape: rectOfBox(outward) } }
	}

	/**
	 * An over-approximation of everything the element itself paints (its children are candidates of
	 * their own), in inner CSS px: the paint extent with its own text (see `paintExtent`), cut by its
	 * clip chain. A clip only removes paint, so the clip chain is applied only when no filter grows
	 * the paint after it and the chain's clip boxes are exact (uniform chain); each clip box is first
	 * grown by the rounding of the integer client sizes it is measured from.
	 */
	function paintBound(element: Element): Box | 'unbounded' | 'empty' {
		let bound = paintBounds.get(element)
		if (bound === undefined) {
			const extent = paintExtent(element, true)
			bound = extent
			// A positioned pseudo-element escapes the clips between its element and its containing block.
			const content = generatedContent(element)
			const escapes = content !== 'unbounded' && content.boxes.length > 0
			if (extent !== 'unbounded' && !extent.filtered && !escapes && chainOf(element).transformOk) {
				const clips = clipChainOf(element, true)
				bound = clips === 'unsupported' ? extent : intersect(extent, clips.box) ?? 'empty'
			}
			paintBounds.set(element, bound)
		}
		return bound
	}

	/**
	 * The element's own paint grown as far as it can reach, in inner CSS px: the rendered rect, which
	 * under a 2D affine chain bounds the transformed border box, grown by the element's own outsets,
	 * united with its own text (when `text` is set), then grown by the extent of every filter on its
	 * flat-tree chain. `unbounded` when no finite bound is provable.
	 */
	function paintExtent(element: Element, text: boolean): (Box & { filtered: boolean }) | 'unbounded' {
		const chain = chainOf(element)
		if (!chain.planar || chain.reflect) return 'unbounded'
		const style = styleOf(element)
		const outsets = ownPaintOutsets(element, style)
		if (!outsets) return 'unbounded'
		// Inside a transformed space the engine snaps box paint and paint offsets to whole pixels of
		// that space, each moving an edge by up to half a local pixel: one local CSS px covers both.
		// The offset of each transformed element is snapped in its parent's space (see below).
		const own = chain.transformed ? { left: outsets.left + 1, top: outsets.top + 1, right: outsets.right + 1, bottom: outsets.bottom + 1 } : outsets
		const rect = rectOf(element)
		let box: Box | undefined = growBox({ left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }, element, own)
		if (box) {
			// Generated content and list markers outside the box; the overflow of what sits in its flow.
			const content = contentBoxes(element, style)
			if (content === 'unbounded') return 'unbounded'
			for (const part of content) box = union(box, part)
			// Its own text: always for a bound, and for the selection when it can leave the box.
			if (text || textMayEscape(element)) {
				const glyphs = ownTextBound(element, style, true)
				if (glyphs === 'unbounded') return 'unbounded'
				if (glyphs) box = union(box, glyphs)
			}
		}
		let filtered = false
		for (let node: Element | null = element; node && box; node = flatTreeParent(node)) {
			const nodeStyle = styleOf(node)
			if (hasTransform(nodeStyle)) {
				const parent = flatTreeParent(node)
				box = parent ? growBox(box, parent, HALF_PIXEL) : { left: box.left - 0.5, top: box.top - 0.5, right: box.right + 0.5, bottom: box.bottom + 0.5 }
				if (!box) break
			}
			const filter = nodeStyle.filter
			if (filter === '' || filter === 'none') continue
			const extent = filterOutsets(filter)
			if (!extent) return 'unbounded'
			if (isZeroOutsets(extent)) continue
			filtered = true
			box = growBox(box, node, extent)
		}
		if (!box || ![box.left, box.top, box.right, box.bottom].every(Number.isFinite)) return 'unbounded'
		return { ...box, filtered }
	}

	/**
	 * The page-space boxes, beyond the border box, in which an element's generated content, list marker
	 * and the overflow of its in-flow content can paint; `unbounded` when no finite bound is provable.
	 */
	function contentBoxes(element: Element, style: StyleFacts): Box[] | 'unbounded' {
		const content = generatedContent(element)
		if (content === 'unbounded') return 'unbounded'
		const boxes = [...content.boxes]
		if (content.flow) {
			const overflow = flowOverflowBox(element, style)
			if (overflow === 'unbounded') return 'unbounded'
			if (overflow) boxes.push(overflow)
		}
		return boxes
	}

	function generatedContent(element: Element): GeneratedContent {
		let content = generatedContents.get(element)
		if (!content) {
			content = computeGeneratedContent(element)
			generatedContents.set(element, content)
		}
		return content
	}

	/**
	 * The generated content of an element: its `::before`, `::after` and list marker. In-flow content
	 * stays inside the element's scrollable overflow. A positioned pseudo-element is bounded by its
	 * resolved box (and the text it can overflow it by); one that is transformed, floated, offset, or
	 * paints a shadow, outline, filter or blend has no bound here.
	 */
	function computeGeneratedContent(element: Element): GeneratedContent {
		if (!generatesContent(element)) return NO_GENERATED_CONTENT
		const style = styleOf(element)
		const boxes: Box[] = []
		let flow = false
		const em = lengthPx(style.fontSize)
		const scale = uniformScaleOf(element)
		for (const pseudo of ['::before', '::after'] as const) {
			const facts = view.getComputedStyle(element, pseudo)
			if (!pseudoGenerates(facts)) continue
			if (em === undefined || scale === undefined || pseudoMovesPaint(facts)) return 'unbounded'
			const position = facts.position
			if (position === 'absolute' || position === 'fixed') {
				const box = absolutePseudoBox(element, facts, position, scale)
				if (!box) return 'unbounded'
				boxes.push(box)
				continue
			}
			if (facts.float !== 'none') return 'unbounded'
			if ([facts.marginTop, facts.marginRight, facts.marginBottom, facts.marginLeft].some(margin => px(margin) < 0)) return 'unbounded'
			if ((position === 'relative' || position === 'sticky') && [facts.top, facts.right, facts.bottom, facts.left].some(offset => offset !== 'auto' && px(offset) !== 0)) return 'unbounded'
			if (style.textIndent.startsWith('-') && px(style.textIndent) !== 0) return 'unbounded'
			flow = true
		}
		if (/(?:^|\s)list-item(?:\s|$)/.test(style.display) && (style.listStyleType !== 'none' || style.listStyleImage !== 'none')) {
			if (style.listStylePosition === 'inside') flow = true
			else {
				const reach = markerReach(element, style)
				if (reach === undefined || em === undefined || scale === undefined) return 'unbounded'
				const rect = rectOf(element)
				boxes.push({ left: rect.left - reach * scale, top: rect.top - em * scale, right: rect.right + reach * scale, bottom: rect.bottom + em * scale })
			}
		}
		return { flow, boxes }
	}

	/** The overflow of an element's in-flow content past its padding box, grown by the integer rounding of the scroll sizes. */
	function flowOverflowBox(element: Element, style: StyleFacts): Box | undefined | 'unbounded' {
		if (isInlineDisplay(style) || clipsOwnContent(element, style)) return undefined
		const html = element as HTMLElement
		if (typeof html.scrollWidth !== 'number') return undefined
		const dx = Math.max(0, html.scrollWidth - html.clientWidth)
		const dy = Math.max(0, html.scrollHeight - html.clientHeight)
		if (dx === 0 && dy === 0) return undefined
		const scale = uniformScaleOf(element)
		if (scale === undefined) return 'unbounded'
		const rect = rectOf(element)
		return { left: rect.left - (dx + 1) * scale, top: rect.top - (dy + 1) * scale, right: rect.right + (dx + 1) * scale, bottom: rect.bottom + (dy + 1) * scale }
	}

	/**
	 * The box of an absolutely positioned or fixed pseudo-element from its resolved style: the padding
	 * box of its containing block plus its resolved offset and margin, its resolved size, and the text
	 * that can overflow that size (one em of glyph ink per character of its string content).
	 */
	function absolutePseudoBox(element: Element, facts: CSSStyleDeclaration, position: 'absolute' | 'fixed', scale: number): Box | undefined {
		const block = containingBlockBox(element, position)
		if (!block) return undefined
		const resolved = (value: string) => /^[+-]?(?:\d+\.?\d*|\.\d+)px$/i.test(value.trim()) ? px(value) : undefined
		const left = resolved(facts.left)
		const top = resolved(facts.top)
		const width = resolved(facts.width)
		const height = resolved(facts.height)
		const marginLeft = resolved(facts.marginLeft)
		const marginTop = resolved(facts.marginTop)
		const em = resolved(facts.fontSize)
		if (left === undefined || top === undefined || width === undefined || height === undefined || marginLeft === undefined || marginTop === undefined || em === undefined) return undefined
		const frame = facts.boxSizing === 'border-box'
			? { width: 0, height: 0 }
			: { width: px(facts.paddingLeft) + px(facts.paddingRight) + px(facts.borderLeftWidth) + px(facts.borderRightWidth), height: px(facts.paddingTop) + px(facts.paddingBottom) + px(facts.borderTopWidth) + px(facts.borderBottomWidth) }
		const x = block.box.left + (left + marginLeft) * block.scale
		const y = block.box.top + (top + marginTop) * block.scale
		const reach = facts.overflowX === 'visible' ? pseudoTextLength(facts.content) * em * scale : 0
		const ink = facts.overflowY === 'visible' ? em * scale : 0
		return {
			left: x - reach - 1,
			top: y - ink - 1,
			right: x + (width + frame.width) * scale + reach + 1,
			bottom: y + (height + frame.height) * scale + ink + 1,
		}
	}

	/** The padding box of the containing block of an absolutely positioned or fixed box generated by `element`, in page px. */
	function containingBlockBox(element: Element, mode: 'absolute' | 'fixed'): Readonly<{ box: Box; scale: number }> | undefined {
		for (let node: Element | null = element; node && node !== doc.documentElement; node = node.parentElement) {
			const style = styleOf(node)
			const contains = mode === 'absolute' ? style.position !== 'static' || containsFixedDescendants(style) : containsFixedDescendants(style)
			if (!contains) continue
			const scale = uniformScaleOf(node)
			if (scale === undefined) return undefined
			const rect = rectOf(node)
			return { scale, box: { left: rect.left + px(style.borderLeftWidth) * scale, top: rect.top + px(style.borderTopWidth) * scale, right: rect.right - px(style.borderRightWidth) * scale, bottom: rect.bottom - px(style.borderBottomWidth) * scale } }
		}
		const root = doc.documentElement
		const x = mode === 'absolute' ? -view.scrollX : 0
		const y = mode === 'absolute' ? -view.scrollY : 0
		return { scale: 1, box: { left: x, top: y, right: x + root.clientWidth, bottom: y + root.clientHeight } }
	}

	/** The client box of the element's own text nodes, measured once per pass; undefined without rendered text. */
	function ownTextOf(element: Element): OwnText | undefined {
		if (ownTexts.has(element)) return ownTexts.get(element)
		let box: Box | undefined
		let stack = 0
		for (const node of Array.from(element.childNodes)) {
			if (node.nodeType !== 3 || !node.textContent) continue
			const range = doc.createRange()
			range.selectNodeContents(node)
			const rect = range.getBoundingClientRect()
			if (!(rect.width > 0) && !(rect.height > 0)) continue
			box = box ? union(box, rect) : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
			for (const run of node.textContent.matchAll(COMBINING_MARKS)) stack = Math.max(stack, run[0].length)
		}
		const text = box ? { box, stack } : undefined
		ownTexts.set(element, text)
		return text
	}

	/**
	 * The element's own text as paint: the client box of its text nodes grown by how far their
	 * decorations (its own and those propagated from an ancestor), strokes and text shadows can paint
	 * beyond the inline boxes, and with `ink` by one em of glyph ink; undefined without rendered text.
	 * Combining marks add an em each to the reach, and more than `MAX_MARK_STACK` stacked on one letter have no bound. A decoration reaches its offset plus its thickness (one
	 * em when automatic).
	 */
	function ownTextBound(element: Element, style: StyleFacts, ink: boolean): Box | undefined | 'unbounded' {
		const text = ownTextOf(element)
		if (!text) return undefined
		if (text.stack > MAX_MARK_STACK) return 'unbounded'
		const shadow = shadowOutsets(style.textShadow, false)
		const em = lengthPx(style.fontSize)
		const stroke = style.webkitTextStrokeWidth === '' ? 0 : lengthPx(style.webkitTextStrokeWidth)
		if (!shadow || em === undefined || stroke === undefined) return 'unbounded'
		const decoration = decorationReach(element, em)
		if (decoration === undefined) return 'unbounded'
		// Each mark stacked on a letter can sit about an em farther from the line than the one below it.
		const reach = (ink ? em : 0) + text.stack * em + Math.abs(stroke) + decoration
		const grown = growBox(text.box, element, { left: reach + shadow.left, top: reach + shadow.top, right: reach + shadow.right, bottom: reach + shadow.bottom })
		return grown ?? 'unbounded'
	}

	/**
	 * How far the text decorations that apply to an element's text reach beyond its inline boxes: the
	 * largest of the element's own and every ancestor's (a decoration propagates to descendant text),
	 * 0 without any, undefined when a value is not understood.
	 */
	function decorationReach(element: Element, em: number): number | undefined {
		let reach = 0
		for (let node: Element | null = element; node; node = flatTreeParent(node)) {
			const style = styleOf(node)
			if (style.textDecorationLine === '' || style.textDecorationLine === 'none') continue
			const nodeEm = Math.max(em, lengthPx(style.fontSize) ?? em)
			const offset = style.textUnderlineOffset === 'auto' || style.textUnderlineOffset === '' ? 0 : lengthPx(style.textUnderlineOffset)
			const thickness = /^(?:auto|from-font)?$/.test(style.textDecorationThickness) ? nodeEm : lengthPx(style.textDecorationThickness)
			if (offset === undefined || thickness === undefined) return undefined
			reach = Math.max(reach, Math.abs(offset) + Math.abs(thickness))
		}
		return reach
	}

	/** Whether an element or an ancestor has a text decoration (which propagates to the element's text). */
	function decorationOf(element: Element): true | undefined {
		for (let node: Element | null = element; node; node = flatTreeParent(node)) {
			const line = styleOf(node).textDecorationLine
			if (line !== '' && line !== 'none') return true
		}
		return undefined
	}

	/**
	 * Grows a client box by outsets given in the element's local CSS px. Under a uniform chain each
	 * side scales by the element's scale (`uniformScaleOf`). Under any other 2D affine chain the
	 * rendered rect W × H of the local border box w × h gives |a| ≤ W/w and |c| ≤ W/h for the linear
	 * part [[a, c], [b, d]], so an outset e grows x by at most e(W/w + W/h) on each side, and y
	 * likewise with H. The layout size is known only through the pixel-snapped `offsetWidth` and
	 * `offsetHeight`, each within 1px of it, so w > offsetWidth - 1; a snapped size of 1px or less
	 * leaves the growth unbounded (undefined).
	 */
	function growBox(box: Box, element: Element, outsets: Outsets): Box | undefined {
		if (isZeroOutsets(outsets)) return box
		if (chainOf(element).transformOk) {
			const scale = uniformScaleOf(element)
			if (scale === undefined) return undefined
			return { left: box.left - outsets.left * scale, top: box.top - outsets.top * scale, right: box.right + outsets.right * scale, bottom: box.bottom + outsets.bottom * scale }
		}
		const html = element as HTMLElement
		const width = typeof html.offsetWidth === 'number' ? html.offsetWidth - 1 : 0
		const height = typeof html.offsetHeight === 'number' ? html.offsetHeight - 1 : 0
		if (!(width > 0) || !(height > 0)) return undefined
		const rect = rectOf(element)
		const extent = Math.max(outsets.left, outsets.top, outsets.right, outsets.bottom)
		const x = extent * (rect.width / width + rect.width / height)
		const y = extent * (rect.height / width + rect.height / height)
		return { left: box.left - x, top: box.top - y, right: box.right + x, bottom: box.bottom + y }
	}

	/**
	 * Whether `candidate` paints above `target` under the CSS painting order: compare the two
	 * items that represent them inside their nearest common stacking context.
	 */
	function paintOrder(candidate: Element, target: Element): 'above' | 'below' | 'unknown' {
		let byTarget = paintOrders.get(target)
		if (!byTarget) paintOrders.set(target, byTarget = new Map())
		let order = byTarget.get(candidate)
		if (!order) byTarget.set(candidate, order = computePaintOrder(candidate, target))
		return order
	}

	function computePaintOrder(candidate: Element, target: Element): 'above' | 'below' | 'unknown' {
		const candidateTop = inTopLayer(candidate)
		const targetTop = inTopLayer(target)
		if (candidateTop !== targetTop) return candidateTop ? 'above' : 'below'
		if (candidateTop) return 'unknown'
		const targetAncestors = new Set<Element>()
		for (let node: Element | null = target; node; node = node.parentElement) targetAncestors.add(node)
		let common: Element | null = candidate
		while (common && !targetAncestors.has(common)) common = common.parentElement
		if (!common) return 'unknown'
		let context: Element | null = common
		while (context && context !== doc.documentElement && !createsStackingContext(context)) context = context.parentElement
		const left = paintKey(candidate, context)
		const right = paintKey(target, context)
		if (left.element === right.element) return 'unknown'
		if (left.flow && right.flow) return 'unknown'
		const leftLayer = layerOf(left)
		const rightLayer = layerOf(right)
		if (leftLayer !== rightLayer) return leftLayer > rightLayer ? 'above' : 'below'
		if (!left.flow && left.z !== right.z) return left.z > right.z ? 'above' : 'below'
		return right.element.compareDocumentPosition(left.element) & Node.DOCUMENT_POSITION_FOLLOWING ? 'above' : 'below'
	}

	function paintKey(element: Element, context: Element | null): PaintKey {
		let outermostContext: Element | undefined
		let nearestPositioned: Element | undefined
		for (let node: Element | null = element; node && node !== context; node = node.parentElement) {
			if (createsStackingContext(node)) outermostContext = node
			if (!nearestPositioned && isPositioned(node)) nearestPositioned = node
		}
		const representative = outermostContext ?? nearestPositioned
		if (!representative) return { element, flow: true, z: 0 }
		return { element: representative, flow: false, z: zIndexOf(representative) }
	}

	function isPositioned(element: Element): boolean {
		let value = positioned.get(element)
		if (value === undefined) {
			const style = styleOf(element)
			value = style.position !== 'static' || (style.zIndex !== 'auto' && isFlexOrGridItem(element))
			positioned.set(element, value)
		}
		return value
	}

	function zIndexOf(element: Element): number {
		const style = styleOf(element)
		if (style.zIndex === 'auto' || !isPositioned(element)) return 0
		const z = Number.parseInt(style.zIndex, 10)
		return Number.isFinite(z) ? z : 0
	}

	function isFlexOrGridItem(element: Element): boolean {
		const parent = element.parentElement
		return !!parent && /(?:^|-)(?:flex|grid)$/.test(styleOf(parent).display)
	}

	function createsStackingContext(element: Element): boolean {
		let value = stacking.get(element)
		if (value === undefined) {
			value = computeCreatesStackingContext(element)
			stacking.set(element, value)
		}
		return value
	}

	function computeCreatesStackingContext(element: Element): boolean {
		if (element === doc.documentElement) return true
		const style = styleOf(element)
		if (style.position === 'fixed' || style.position === 'sticky') return true
		if (style.zIndex !== 'auto' && isPositioned(element)) return true
		if (Number.parseFloat(style.opacity) < 1) return true
		if (hasTransform(style) || hasCompositing(style) || hasMask(style)) return true
		if (style.clipPath !== '' && style.clipPath !== 'none') return true
		if (style.isolation === 'isolate') return true
		if (style.perspective !== '' && style.perspective !== 'none') return true
		if (containsPaint(style) || /layout|strict|content/.test(style.contain)) return true
		if (/transform|opacity|filter|perspective|isolation|mask|clip-path/.test(style.willChange)) return true
		if (style.containerType === 'size' || style.containerType === 'inline-size') return true
		return false
	}

	function inTopLayer(element: Element): boolean {
		for (let node: Element | null = element; node; node = node.parentElement) {
			try {
				if (node.matches(':modal, :popover-open, :fullscreen')) return true
			}
			catch {
				// Engines without these pseudo-classes have no top layer content of that kind.
			}
		}
		return false
	}

	function resetPass(): void {
		rects = new Map()
		paintBounds = new Map()
		generatedContents = new Map()
		ownTexts = new Map()
		topLayer = undefined
		topLayerSet = undefined
		chainShapes = new Map()
		coverShapes = new Map()
		candidates = undefined
		viewport = undefined
	}

	return Object.freeze({
		beginPass: resetPass,
		measure,
		endPass: resetPass,
		invalidateStyles() {
			styles = new Map()
			chainFlags = new Map()
			stacking = new Map()
			positioned = new Map()
			paintOrders = new Map()
			widgets = undefined
			candidateElements = undefined
			reaches = new Map()
			generators = new Map()
			texts = new Map()
			filteredChains = new Map()
		},
	})
}

/** A run of combining marks after a letter. */
const COMBINING_MARKS = /\p{M}+/gu
/** The most marks stacked on one letter that have a bound (Thai, Devanagari, Arabic and decomposed Latin stack at most 3 or 4); more has none. */
const MAX_MARK_STACK = 12
const NO_GENERATED_CONTENT: GeneratedContent = Object.freeze({ flow: false, boxes: Object.freeze([]) })

/** Whether the resolved style of a `::before` or `::after` belongs to a generated box. */
function pseudoGenerates(facts: CSSStyleDeclaration): boolean {
	const content = facts.content
	return content !== '' && content !== 'none' && content !== 'normal' && facts.display !== 'none'
}

/** Whether a generated box paints outside the box it is laid out in: transformed, filtered, blended, shadowed or outlined. */
function pseudoMovesPaint(facts: CSSStyleDeclaration): boolean {
	const set = (value: string | undefined) => value !== undefined && value !== '' && value !== 'none'
	return set(facts.transform) || set(facts.translate) || set(facts.rotate) || set(facts.scale) || set(facts.offsetPath)
		|| set(facts.filter) || (facts.mixBlendMode !== '' && facts.mixBlendMode !== 'normal')
		|| set(facts.boxShadow) || set(facts.textShadow) || set(facts.borderImageSource)
		|| (facts.outlineStyle !== 'none' && px(facts.outlineWidth) > 0)
		|| set(facts.getPropertyValue('-webkit-box-reflect'))
}

/** The number of characters a generated box's string content paints (a counter or other function counts as 16). */
function pseudoTextLength(content: string): number {
	let length = 0
	const strings = content.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)
	let rest = content
	for (const match of strings) {
		length += (match[1] ?? match[2] ?? '').length
		rest = rest.replace(match[0], '')
	}
	if (/(?:counters?|attr|image-set|element)\(/.test(rest)) length += 16
	return length
}

/**
 * How far an outside list marker reaches beyond the box of its item, in the item's local CSS px: the
 * widest marker the list style can produce, or undefined when it has no bound (an image, a custom
 * string, a counter style with no known width).
 */
function markerReach(element: Element, style: StyleFacts): number | undefined {
	const em = lengthPx(style.fontSize)
	if (em === undefined || (style.listStyleImage !== 'none' && style.listStyleImage !== '')) return undefined
	const type = style.listStyleType.trim()
	if (type === 'none') return 0
	if (/^(?:disc|circle|square|disclosure-open|disclosure-closed)$/.test(type)) return 2 * em
	if (/^(?:decimal|decimal-leading-zero|lower-roman|upper-roman|lower-alpha|upper-alpha|lower-latin|upper-latin)$/.test(type)) {
		const ordinal = (element as HTMLLIElement).value
		if (typeof ordinal !== 'number' || !Number.isFinite(ordinal)) return undefined
		// A roman numeral up to 3999 has at most 15 letters, an alphabetic counter fewer than the digits of the value.
		const characters = /roman/.test(type) ? Math.max(15, String(Math.abs(ordinal)).length) : String(Math.abs(ordinal)).length + 1
		return (characters + 2) * em
	}
	return undefined
}

/** Whether the element clips its own in-flow content on both axes (so none of it paints outside its padding box). */
function clipsOwnContent(element: Element, style: StyleFacts): boolean {
	if (!overflowApplies(element, style, true)) return false
	return (style.overflowX !== 'visible' && style.overflowY !== 'visible') || containsPaint(style)
}

/** Whether the element paints replaced content: an image, SVG, canvas, video, frame, native control, or a fill that is not understood. */
function isReplacedPaint(element: Element, style: StyleFacts): boolean {
	const tag = element.tagName.toUpperCase()
	if (REPLACED_TAGS.has(tag)) return true
	if (NATIVE_CONTROL_TAGS.has(tag) && style.appearance !== 'none' && style.webkitAppearance !== 'none') return true
	return colorAlpha(style.backgroundColor) === undefined
}

/**
 * What the background colour and image of a box paint: `opaque` (an opaque colour below the clip
 * to the box, whatever an image adds), `translucent` (a colour with alpha below 1 and no image),
 * `none`, or `unknown` (an image over a not opaque colour, or text-clipped: it may be opaque anywhere).
 */
function fillKind(style: StyleFacts): 'none' | 'translucent' | 'opaque' | 'unknown' {
	const alpha = colorAlpha(style.backgroundColor) ?? 0
	const textClip = style.backgroundClip === 'text'
	if (alpha === 1 && !textClip) return 'opaque'
	if (textClip || style.backgroundImage !== 'none') return 'unknown'
	return alpha > 0 ? 'translucent' : 'none'
}

/** Whether `outer` contains `inner`, allowing for floating-point noise. */
function contains(outer: Box, inner: Box): boolean {
	return outer.left <= inner.left + 1e-6 && outer.top <= inner.top + 1e-6 && outer.right >= inner.right - 1e-6 && outer.bottom >= inner.bottom - 1e-6
}

function layerOf(key: PaintKey): number {
	if (key.flow) return 0
	if (key.z < 0) return -1
	return key.z === 0 ? 1 : 2
}

function positionMode(style: StyleFacts): 'fixed' | 'absolute' | 'flow' {
	if (style.position === 'fixed') return 'fixed'
	if (style.position === 'absolute') return 'absolute'
	return 'flow'
}

function containsFixedDescendants(style: StyleFacts): boolean {
	return hasTransform(style)
		|| (style.perspective !== '' && style.perspective !== 'none')
		|| (style.filter !== '' && style.filter !== 'none')
		|| (style.backdropFilter !== undefined && style.backdropFilter !== '' && style.backdropFilter !== 'none')
		|| containsPaint(style)
		|| /layout|strict|content/.test(style.contain)
		|| /transform|perspective|filter/.test(style.willChange)
}

function containsPaint(style: StyleFacts): boolean {
	return /paint|strict|content/.test(style.contain)
}

function hasTransform(style: StyleFacts): boolean {
	return (style.transform !== '' && style.transform !== 'none')
		|| (style.translate !== undefined && style.translate !== '' && style.translate !== 'none')
		|| (style.rotate !== undefined && style.rotate !== '' && style.rotate !== 'none')
		|| (style.scale !== undefined && style.scale !== '' && style.scale !== 'none')
		|| (style.offsetPath !== undefined && style.offsetPath !== '' && style.offsetPath !== 'none')
}

function hasCompositing(style: StyleFacts): boolean {
	return (style.filter !== '' && style.filter !== 'none')
		|| (style.backdropFilter !== undefined && style.backdropFilter !== '' && style.backdropFilter !== 'none')
		|| (style.mixBlendMode !== '' && style.mixBlendMode !== 'normal')
}

function hasMask(style: StyleFacts): boolean {
	const mask = style.maskImage || style.webkitMaskImage
	return mask !== '' && mask !== 'none'
}

/** Translation plus uniform positive scale (the same proof as the outer axis-aligned mapping). */
function transformIsUniform(style: StyleFacts): boolean {
	if (style.offsetPath !== undefined && style.offsetPath !== '' && style.offsetPath !== 'none') return false
	if (style.rotate !== undefined && style.rotate !== '' && style.rotate !== 'none' && !/^0(?:deg|rad|turn|grad)?$/.test(style.rotate.trim())) return false
	if (style.scale !== undefined && style.scale !== '' && style.scale !== 'none') {
		const factors = style.scale.trim().split(/\s+/).map(Number)
		if (factors.length > 2 || !factors.every(factor => Number.isFinite(factor) && factor > 0)) return false
		if (factors.length === 2 && factors[0] !== factors[1]) return false
	}
	const transform = style.transform?.trim()
	if (!transform || transform === 'none') return true
	const match = /^matrix\(([^)]*)\)$/.exec(transform)
	if (!match) return false
	const [a, b, c, d, e, f] = match[1]!.split(',').map(part => Number(part.trim()))
	if (![a, b, c, d, e, f].every(Number.isFinite)) return false
	if (b !== 0 || c !== 0 || !(a! > 0) || !(d! > 0)) return false
	return Math.abs(a! - d!) <= UNIFORM_SCALE_TOLERANCE * Math.max(a!, d!)
}

/** The zoom an element applies to its subtree. NaN when the value is not understood. */
function zoomFactor(style: StyleFacts): number {
	const zoom = style.zoom === '' || style.zoom === 'normal' ? 1 : Number(style.zoom)
	return zoom > 0 ? zoom : Number.NaN
}

/**
 * The scale of an element's own `transform` and `scale` under the uniform proof. NaN when a
 * value is not understood.
 */
function transformFactor(style: StyleFacts): number {
	let factor = 1
	if (style.scale !== undefined && style.scale !== '' && style.scale !== 'none') factor *= Number(style.scale.trim().split(/\s+/)[0])
	const transform = style.transform?.trim()
	if (transform && transform !== 'none') factor *= Number(/^matrix\(([^,)]*)/.exec(transform)?.[1])
	return factor
}

/**
 * Whether an inline-level element is replaced-like, laid out as an atomic inline box: a replaced
 * element, a native control or a fieldset. Shared by `isTransformable` and `overflowApplies` so the
 * two cannot diverge. An `<object>` is replaced-like only while it has no fallback content.
 */
function isAtomicInlineTag(element: Element): boolean {
	const tag = element.tagName.toUpperCase()
	if (tag === 'OBJECT') return !element.hasChildNodes()
	return CLIPPED_REPLACED_TAGS.has(tag) || NATIVE_CONTROL_TAGS.has(tag) || tag === 'FIELDSET'
}

/** Elements positively known to be non-replaced inline boxes when displayed `inline`. */
const PLAIN_INLINE_TAGS = new Set([
	'SPAN', 'A', 'B', 'I', 'U', 'S', 'EM', 'STRONG', 'SMALL', 'CODE', 'KBD', 'SAMP', 'VAR', 'MARK', 'ABBR', 'CITE', 'DFN',
	'Q', 'SUB', 'SUP', 'TIME', 'DATA', 'BDI', 'BDO', 'LABEL', 'FONT', 'DEL', 'INS', 'TT', 'BIG', 'STRIKE',
])

function isInlineDisplay(style: StyleFacts): boolean {
	const display = style.display.trim()
	return display === 'inline' || /^inline (?:flow|list-item|flow list-item)$/.test(display) || display.startsWith('ruby')
}

/**
 * Whether the engine applies the element's transform (CSS Transforms 1 "transformable element"): not
 * for a box-less element, a table-column or table-column-group box, or a non-replaced inline box.
 * SVG elements and replaced or native-control elements keep it.
 */
function isTransformable(element: Element, style: StyleFacts): boolean {
	const display = style.display.trim()
	if (display === 'contents' || display === 'none' || display === 'table-column' || display === 'table-column-group') return false
	if (!isInlineDisplay(style) || isSvgElement(element)) return true
	return isAtomicInlineTag(element)
}

/**
 * Whether CSS overflow clips the element's content: it does not apply to a non-replaced inline box
 * (an inline `<object>` with fallback content is not replaced: the engine forces only its computed
 * overflow value to clip), so a child's outline paints outside it. With `conservative` (the Widget's
 * own visible area) any doubt applies the clip, since a smaller visible area is the safe error:
 * only a tag positively known to be a plain inline box is exempt.
 */
function overflowApplies(element: Element, style: StyleFacts, conservative = false): boolean {
	if (!isInlineDisplay(style) || isSvgElement(element)) return true
	if (isAtomicInlineTag(element)) return true
	if (!conservative) return false
	const tag = element.tagName.toUpperCase()
	return !PLAIN_INLINE_TAGS.has(tag) && !tag.includes('-')
}

/** Whether the element's own transform leaves the plane (any 3D transform function or component). */
export function hasThreeDTransform(style: Readonly<Record<'transform' | 'translate' | 'scale' | 'rotate', string>>): boolean {
	if (/^matrix3d\(/.test(style.transform?.trim() ?? '')) return true
	const parts = (value: string | undefined) => (value ?? '').trim().split(/\s+/).filter(Boolean)
	if (style.translate && style.translate !== 'none' && parts(style.translate).length > 2) return true
	if (style.scale && style.scale !== 'none' && parts(style.scale).length > 2) return true
	const rotate = parts(style.rotate)
	return style.rotate !== 'none' && rotate.length > 1 && rotate[0] !== 'z' && !(rotate.length === 4 && rotate[0] === '0' && rotate[1] === '0')
}

/** Per-side growth of a box, in CSS px, every side zero or positive. */
export type Outsets = Readonly<{ left: number; top: number; right: number; bottom: number }>

const ZERO_OUTSETS: Outsets = Object.freeze({ left: 0, top: 0, right: 0, bottom: 0 })
const HALF_PIXEL: Outsets = Object.freeze({ left: 0.5, top: 0.5, right: 0.5, bottom: 0.5 })

function isZeroOutsets(outsets: Outsets): boolean {
	return outsets.left === 0 && outsets.top === 0 && outsets.right === 0 && outsets.bottom === 0
}

function maxOutsets(a: Outsets, b: Outsets): Outsets {
	return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }
}

/** Replaced elements whose content can leave the box only while their overflow is visible. */
const CLIPPED_REPLACED_TAGS = new Set(['IMG', 'SVG', 'CANVAS', 'VIDEO', 'IFRAME', 'OBJECT', 'EMBED', 'AUDIO'])

/**
 * How far an element's own paint can reach beyond its border box, in its local CSS px: its
 * outline, outer box shadows, border-image outset and, for replaced content, the overflow clip
 * margin. Undefined when the reach has no provable finite bound or a value is not understood.
 */
function ownPaintOutsets(element: Element, style: StyleFacts): Outsets | undefined {
	let outsets = ZERO_OUTSETS
	if (CLIPPED_REPLACED_TAGS.has(element.tagName.toUpperCase())) {
		// Replaced content (an image with `object-position`, say) is unbounded unless clipped.
		if (style.overflowX === 'visible' || style.overflowY === 'visible') return undefined
		if (style.overflowX === 'clip' || style.overflowY === 'clip') {
			const margin = trailingLength(style.overflowClipMargin)
			if (margin === undefined) return undefined
			outsets = maxOutsets(outsets, uniformOutsets(margin))
		}
	}
	const shadow = boxShadowOutsets(style.boxShadow)
	if (!shadow) return undefined
	outsets = maxOutsets(outsets, shadow)
	if (style.outlineStyle !== '' && style.outlineStyle !== 'none') {
		const width = lengthPx(style.outlineWidth)
		const offset = lengthPx(style.outlineOffset)
		if (width === undefined || offset === undefined) return undefined
		// `auto` focus rings are drawn by the engine; take twice the usual ring width as headroom.
		const reach = style.outlineStyle === 'auto' ? Math.max(0, offset) + 2 * Math.max(width, 3) + 4 : Math.max(0, width + offset)
		outsets = maxOutsets(outsets, uniformOutsets(reach))
	}
	if (style.borderImageSource !== '' && style.borderImageSource !== 'none') {
		const image = borderImageOutsets(style)
		if (!image) return undefined
		outsets = maxOutsets(outsets, image)
	}
	return outsets
}

function uniformOutsets(value: number): Outsets {
	const side = Math.max(0, value)
	return { left: side, top: side, right: side, bottom: side }
}

/** `border-image-outset`: one to four lengths or multiples of the matching border width. */
export function borderImageOutsets(style: Readonly<Record<'borderImageOutset' | 'borderTopWidth' | 'borderRightWidth' | 'borderBottomWidth' | 'borderLeftWidth', string>>): Outsets | undefined {
	const tokens = style.borderImageOutset.trim().split(/\s+/).filter(Boolean)
	if (tokens.length < 1 || tokens.length > 4) return undefined
	const [top, right = top, bottom = top, left = right] = tokens as [string, ...string[]]
	const side = (token: string, border: string) => {
		if (/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(token)) return Number(token) * px(border)
		return lengthPx(token)
	}
	const values = [side(top, style.borderTopWidth), side(right!, style.borderRightWidth), side(bottom!, style.borderBottomWidth), side(left!, style.borderLeftWidth)]
	if (!values.every(value => value !== undefined && Number.isFinite(value))) return undefined
	const [t, r, b, l] = values as number[]
	return { left: Math.max(0, l!), top: Math.max(0, t!), right: Math.max(0, r!), bottom: Math.max(0, b!) }
}

/**
 * Reach of a computed `box-shadow` list beyond the border box, per side. A blur radius b paints
 * within 3σ of the shadow edge, where engines take σ ≤ 0.58b + 0.5; 2b + 2 covers it. Inset
 * shadows paint inside the padding box. Undefined when the value is not understood.
 */
export function boxShadowOutsets(value: string): Outsets | undefined {
	return shadowOutsets(value, true)
}

/**
 * Reach of a computed `text-shadow` list beyond the text's glyphs, per side: offsets and blur as
 * for box shadows, without spread or inset. Undefined when the value is not understood.
 */
export function textShadowOutsets(value: string): Outsets | undefined {
	return shadowOutsets(value, false)
}

function shadowOutsets(value: string, box: boolean): Outsets | undefined {
	const text = value.trim()
	if (text === '' || text === 'none') return ZERO_OUTSETS
	let outsets = ZERO_OUTSETS
	for (const layer of splitTopLevel(text, ',')) {
		const tokens = splitTopLevel(layer, ' ')
		const lengths: number[] = []
		let inset = false
		for (const token of tokens) {
			if (token === 'inset' && box) inset = true
			else if (isColorToken(token)) continue
			else {
				const length = lengthPx(token)
				if (length === undefined) return undefined
				lengths.push(length)
			}
		}
		if (lengths.length < 2 || lengths.length > (box ? 4 : 3)) return undefined
		if (inset) continue
		const [dx, dy, blur = 0, spread = 0] = lengths as [number, number, number?, number?]
		const reach = spread + (blur > 0 ? 2 * blur + 2 : 0)
		outsets = maxOutsets(outsets, {
			left: Math.max(0, reach - dx),
			top: Math.max(0, reach - dy),
			right: Math.max(0, reach + dx),
			bottom: Math.max(0, reach + dy),
		})
	}
	return outsets
}

const NON_GEOMETRIC_FILTERS = new Set(['brightness', 'contrast', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate', 'sepia'])

/**
 * How far a computed `filter` list can move paint, per side. The colour functions keep every
 * transparent pixel transparent and move nothing. `blur(σ)` and `drop-shadow(… σ)` reach 3σ in
 * engines; 4σ + 2 covers it, and a drop shadow adds its offset. Any other function, such as an
 * SVG `url()` filter whose region can be anything, has no bound here: undefined.
 */
export function filterOutsets(value: string): Outsets | undefined {
	const text = value.trim()
	if (text === '' || text === 'none') return ZERO_OUTSETS
	let left = 0
	let top = 0
	let right = 0
	let bottom = 0
	for (const token of splitTopLevel(text, ' ')) {
		const match = /^([a-z-]+)\((.*)\)$/i.exec(token)
		if (!match) return undefined
		const name = match[1]!.toLowerCase()
		if (NON_GEOMETRIC_FILTERS.has(name)) continue
		if (name === 'blur') {
			const sigma = match[2]!.trim() === '' ? 0 : lengthPx(match[2]!.trim())
			if (sigma === undefined || sigma < 0) return undefined
			const reach = sigma > 0 ? 4 * sigma + 2 : 0
			left += reach
			top += reach
			right += reach
			bottom += reach
			continue
		}
		if (name === 'drop-shadow') {
			const lengths: number[] = []
			for (const part of splitTopLevel(match[2]!, ' ')) {
				if (isColorToken(part)) continue
				const length = lengthPx(part)
				if (length === undefined) return undefined
				lengths.push(length)
			}
			if (lengths.length < 2 || lengths.length > 3) return undefined
			const [dx, dy, sigma = 0] = lengths as [number, number, number?]
			if (sigma < 0) return undefined
			const reach = sigma > 0 ? 4 * sigma + 2 : 0
			left += Math.max(0, reach - dx)
			top += Math.max(0, reach - dy)
			right += Math.max(0, reach + dx)
			bottom += Math.max(0, reach + dy)
			continue
		}
		return undefined
	}
	return { left, top, right, bottom }
}

/** Splits at a separator outside parentheses; a space separator also collapses runs of spaces. */
function splitTopLevel(value: string, separator: ',' | ' '): string[] {
	const parts: string[] = []
	let depth = 0
	let current = ''
	for (const char of value) {
		if (char === '(') depth++
		else if (char === ')') depth = Math.max(0, depth - 1)
		if (depth === 0 && (separator === ' ' ? /\s/.test(char) : char === separator)) {
			if (current.trim()) parts.push(current.trim())
			current = ''
			continue
		}
		current += char
	}
	if (current.trim()) parts.push(current.trim())
	return parts
}

function isColorToken(token: string): boolean {
	return /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix|light-dark)\(.*\)$/i.test(token)
		|| /^(?:transparent|currentcolor|#[0-9a-f]{3,8})$/i.test(token)
}

/** A computed length in px (`0` allowed), or undefined for anything else. */
function lengthPx(value: string | undefined): number | undefined {
	const text = (value ?? '').trim()
	if (text === '0') return 0
	const match = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)px$/i.exec(text)
	return match ? Number(match[1]) : undefined
}

/** The length at the end of `overflow-clip-margin` (`content-box 10px`, `0px`), 0 for a bare box. */
export function trailingLength(value: string): number | undefined {
	const tokens = value.trim().split(/\s+/).filter(Boolean)
	if (tokens.length === 0) return 0
	const last = tokens[tokens.length - 1]!
	if (/^(?:content|padding|border)-box$/.test(last)) return 0
	return lengthPx(last)
}

function backgroundInset(style: StyleFacts, scale: number): Box {
	const borders = { left: px(style.borderLeftWidth), top: px(style.borderTopWidth), right: px(style.borderRightWidth), bottom: px(style.borderBottomWidth) }
	const padding = { left: px(style.paddingLeft), top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom) }
	const clip = style.backgroundClip
	const inset = clip === 'content-box'
		? { left: borders.left + padding.left, top: borders.top + padding.top, right: borders.right + padding.right, bottom: borders.bottom + padding.bottom }
		: clip === 'padding-box' ? borders : { left: 0, top: 0, right: 0, bottom: 0 }
	return { left: inset.left * scale, top: inset.top * scale, right: inset.right * scale, bottom: inset.bottom * scale }
}

function hasVisibleBorder(style: StyleFacts): boolean {
	return (['Top', 'Right', 'Bottom', 'Left'] as const).some((side) => {
		const width = px(style[`border${side}Width`])
		const lineStyle = style[`border${side}Style`]
		const alpha = colorAlpha(style[`border${side}Color`])
		return width > 0 && lineStyle !== 'none' && lineStyle !== 'hidden' && alpha !== 0
	})
}

function hasOwnText(element: Element): boolean {
	for (const node of Array.from(element.childNodes)) {
		if (node.nodeType === 3 && node.textContent && node.textContent.trim()) return true
	}
	return false
}

/** Alpha of a computed colour, or undefined when the serialization is not understood. */
export function colorAlpha(color: string): number | undefined {
	const value = color.trim()
	if (value === 'transparent') return 0
	const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(value)
	if (slash) return slash[2] ? Number(slash[1]) / 100 : Number(slash[1])
	const rgba = /^rgba\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*([\d.]+)\s*\)$/.exec(value)
	if (rgba) return Number(rgba[1])
	if (/^(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)\(/.test(value)) return 1
	return undefined
}

function px(value: string | undefined): number {
	const parsed = Number.parseFloat(value ?? '0')
	return Number.isFinite(parsed) ? parsed : 0
}

function boxOfRect(rect: WidgetRect): Box {
	return { left: rect.x, top: rect.y, right: rect.x + rect.width, bottom: rect.y + rect.height }
}

function rectOfBox(box: Box): WidgetRect {
	return { x: box.left, y: box.top, width: box.right - box.left, height: box.bottom - box.top }
}

function union(a: Box, b: Box): Box {
	return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) }
}

function intersect(a: Box, b: Box): Box | undefined {
	const left = Math.max(a.left, b.left)
	const top = Math.max(a.top, b.top)
	const right = Math.min(a.right, b.right)
	const bottom = Math.min(a.bottom, b.bottom)
	return right > left && bottom > top ? { left, top, right, bottom } : undefined
}

/** Whether any rounded corner box of the shape overlaps the area with positive area. */
function cornersReach(shape: RoundedShape, area: Box): boolean {
	const { x, y, width, height } = shape.rect
	const { topLeft, topRight, bottomRight, bottomLeft } = shape.radii
	const corners: Box[] = [
		{ left: x, top: y, right: x + topLeft.rx, bottom: y + topLeft.ry },
		{ left: x + width - topRight.rx, top: y, right: x + width, bottom: y + topRight.ry },
		{ left: x + width - bottomRight.rx, top: y + height - bottomRight.ry, right: x + width, bottom: y + height },
		{ left: x, top: y + height - bottomLeft.ry, right: x + bottomLeft.rx, bottom: y + height },
	]
	return corners.some(corner => corner.right > corner.left && corner.bottom > corner.top && intersect(corner, area) !== undefined)
}

/** The radii of a box inset on each side: each corner radius shrinks by the inset beside it (CSS inner radius). */
function insetRadii(radii: RoundedRectRadii, inset: Box): RoundedRectRadii {
	const shrink = (radius: { rx: number; ry: number }, horizontal: number, vertical: number) => {
		const rx = Math.max(0, radius.rx - horizontal)
		const ry = Math.max(0, radius.ry - vertical)
		return rx > 0 && ry > 0 ? { rx, ry } : { rx: 0, ry: 0 }
	}
	return {
		topLeft: shrink(radii.topLeft, inset.left, inset.top),
		topRight: shrink(radii.topRight, inset.right, inset.top),
		bottomRight: shrink(radii.bottomRight, inset.right, inset.bottom),
		bottomLeft: shrink(radii.bottomLeft, inset.left, inset.bottom),
	}
}

/** Whether the element generates a box a reference box can be taken from (not inline, `contents` or `none`). */
function isBoxed(style: StyleFacts): boolean {
	const display = style.display.trim()
	return display !== 'contents' && display !== 'none' && !isInlineDisplay(style)
}

function polygonCommands(points: readonly Point[]): ContourCommand[] {
	const [first, ...rest] = points
	return [
		Object.freeze({ op: 'moveTo' as const, x: first!.x, y: first!.y }),
		...rest.map(point => Object.freeze({ op: 'lineTo' as const, x: point.x, y: point.y })),
		Object.freeze({ op: 'close' as const }),
	]
}
