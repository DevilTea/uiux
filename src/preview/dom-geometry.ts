import { flatTreeParent, isSvgElement } from './axis-aligned-content-quad'
import type { WidgetGeometry, WidgetMeasurer } from './geometry-producer'
import { planOcclusion, type OcclusionEvidence } from './occlusion-proof'
import type { ContourCommand, Point, VisibleRegion, WidgetRect } from './protocol/schema'
import { subtractAxisAlignedRectangularOcclusion } from './rectangular-occlusion'
import { approximateRoundedRectContour, type RoundedRectRadii } from './rounded-contour'

/**
 * DOM measurement for the runtime geometry producer (Part 4 visible regions, first version).
 *
 * For one Widget element it reports the full rendered border box (`rect`) and the regions of it
 * that are reliably visible: the part surviving the content viewport, every ancestor overflow or
 * paint-containment clip on its containing-block chain, minus proven opaque occluders and minus the
 * finite paint bound of every occluder whose exact covering shape is unproven. It never guesses.
 * Whenever the visible set cannot be proven inside the subset below, it reports `regions: []`
 * ("no reliably visible region", Part 4) instead of a bounding box.
 *
 * Exact subset:
 * - Widget boxes whose transform chain is translation plus uniform positive scale. Rotation, skew,
 *   flips, nonuniform scale, 3D and motion paths fail closed. The chain follows the flat tree
 *   (assigned slot, parent element, shadow host), and an SVG ancestor fails closed. A filter, blend
 *   mode, mask or clip path on the Widget's own chain fails closed too.
 * - Rectangular clips are exact. One rounded shape may take part (the Widget's own border radius,
 *   or one rounded overflow clip whose corners reach the visible area): its contour is the
 *   `approximateRoundedRectContour` polygon clipped by the exact rectangle, with that contour's
 *   `maxError`. Two rounded shapes at once, or a rounded shape plus any cut, fail closed.
 * - Occluders are elements that paint above the Widget, determined from the CSS painting order
 *   (stacking contexts, z-index, positioned layers, tree order). An undecided order (overlap
 *   between two in-flow boxes, whose backgrounds and inline content interleave) is taken as above.
 *   An element is examined when its paint extent overlaps the visible area: its border box grown
 *   by its own outline, outer shadows, border-image outset and replaced-content clip margin and by
 *   the filter extent of it and every ancestor (Discussion #241 owner decision 2).
 *   - Opaque (subtracted exactly): order proven above, opacity 1 along the chain, an opaque
 *     background colour, no filter, blend mode, mask or clip-path, a uniform transform chain,
 *     square corners where they meet the Widget, painted area clipped by the occluder's own clips.
 *   - Translucent (kept, Part 4): a background with alpha below 1, borders or text only.
 *   - Bounded (Discussion #241 R6; subtracted by an over-approximation): replaced content (images,
 *     SVG, canvas, video, frames, native controls), filters, blend modes, masks, clip paths,
 *     rounded opaque corners over the Widget, transforms outside the uniform subset, rounded or
 *     unsupported clips of the occluder, and an undecided paint order. The cut is the occluder's
 *     paint extent united with its own text (inline boxes grown by one em of glyph ink, its
 *     decoration, stroke and text shadows), with the engine's pixel snapping under transforms,
 *     clipped by its clip chain only when no filter grows it and its chain is uniform, and rounded
 *     outward to whole device pixels. Outsets scale by the exact uniform chain scale (transforms
 *     and zoom), otherwise by a bound from the snapped layout size. Subtracting more than the
 *     occluder paints only shrinks what is reported visible. A bounded cut lying wholly inside the
 *     visible area would leave only an unreported interior hole, so the Widget gets no precise
 *     region (Discussion #241 owner decision 1); exact cuts may still leave such holes.
 *   - Unbounded (fail closed): a filter other than the CSS shorthand functions (such as `url()`),
 *     a 3D transform or `-webkit-box-reflect` on the occluder's chain, replaced content whose
 *     overflow is visible, an unparsed shadow, outline, outset or text style, or an outset that a
 *     transform without a measurable box makes unscalable.
 *
 * Not modelled (issue #112): generated content (`::before`/`::after`, list markers); box shadows,
 * outlines and overflowing text of exact or translucent occluders; the text of an element whose
 * paint extent does not reach the Widget; paint without a finite bound of an element whose border
 * box does not overlap the Widget; glyph ink farther than one em from its inline boxes (such as
 * stacked combining marks) and decorations propagated from an ancestor. They are treated as not
 * covering.
 */

export type DomGeometryMeasurerOptions = Readonly<{
	document: Document
	/** Error target of rounded-corner contours, in inner CSS px. */
	roundedTargetMaxError?: number
}>

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>
type RoundedShape = Readonly<{ rect: WidgetRect; radii: RoundedRectRadii }>
type ClipChain = Readonly<{ box: Box; rounded: readonly RoundedShape[] }> | 'unsupported'
type PaintKey = Readonly<{ element: Element; flow: boolean; z: number }>

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
	let filteredChains = new Map<Element, boolean>()
	// Per-pass caches: layout is read once per element per animation frame.
	let rects = new Map<Element, DOMRect>()
	let candidates: { elements: Element[]; boxes: Float64Array } | undefined
	let paintBounds = new Map<Element, Box | 'unbounded' | 'empty'>()
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
			if (mayPaintOutside(element)) {
				const extent = paintExtent(element, false)
				if (extent !== 'unbounded') box = union(box, extent)
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
			value = filteredChain(element)
				|| style.boxShadow !== 'none'
				|| style.outlineStyle !== 'none'
				|| style.borderImageSource !== 'none'
				|| (CLIPPED_REPLACED_TAGS.has(element.tagName.toUpperCase()) && trailingLength(style.overflowClipMargin) !== 0)
			reaches.set(element, value)
		}
		return value
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
	type ChainFlags = Readonly<{ opacity: number; transformOk: boolean; compositing: boolean; shapeClip: boolean; hidden: boolean; planar: boolean; reflect: boolean; scale: number; ceiling: number; transformed: boolean }>

	/** Aggregated style facts of an element and all its flat-tree ancestors. */
	function chainOf(element: Element): ChainFlags {
		const cached = chainFlags.get(element)
		if (cached) return cached
		const style = styleOf(element)
		const parent = flatTreeParent(element)
		const inherited: ChainFlags = parent ? chainOf(parent) : { opacity: 1, transformOk: true, compositing: false, shapeClip: false, hidden: false, planar: true, reflect: false, scale: 1, ceiling: 1, transformed: false }
		const opacity = Number.parseFloat(style.opacity)
		const transformOk = inherited.transformOk && !(parent && isSvgElement(parent)) && transformIsUniform(style)
		// The engine ignores the transform of a box that is not transformable, though it is computed.
		const zoom = zoomFactor(style)
		const transform = transformFactor(style)
		const flags: ChainFlags = {
			opacity: inherited.opacity * (Number.isFinite(opacity) ? opacity : 1),
			transformOk,
			compositing: inherited.compositing || hasCompositing(style),
			shapeClip: inherited.shapeClip || (style.clipPath !== '' && style.clipPath !== 'none') || hasMask(style),
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
		const html = element as HTMLElement
		const width = typeof html.offsetWidth === 'number' ? html.offsetWidth : rect.width
		const height = typeof html.offsetHeight === 'number' ? html.offsetHeight : rect.height
		const scale = scaleOf(element)
		const corner = (value: string) => {
			const [first, second] = value.trim().split(/\s+/)
			const rx = length(first, width) * scale
			const ry = length(second ?? first, height) * scale
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
	function clipChainOf(element: Element, outward = false): ClipChain {
		let box = viewportBox()
		const rounded: RoundedShape[] = []
		let mode = positionMode(styleOf(element))
		for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
			if (ancestor === doc.body || ancestor === doc.documentElement) break
			const style = styleOf(ancestor)
			const containsFixed = containsFixedDescendants(style)
			const containing = mode === 'flow'
				|| (mode === 'absolute' && (style.position !== 'static' || containsFixed))
				|| (mode === 'fixed' && containsFixed)
			if (!containing) continue
			const overflows = overflowApplies(ancestor, style)
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
		if (chain.opacity === 0 || !chain.transformOk || chain.compositing || chain.shapeClip) return []

		const clips = clipChainOf(element)
		if (clips === 'unsupported') return []
		const visible = intersect(boxOfRect(rect), clips.box)
		if (!visible) return []

		// At most one rounded shape may reach the visible area (see the module comment).
		const rounded: RoundedShape[] = []
		const own = radiiOf(element, rect)
		if (own && cornersReach({ rect, radii: own }, visible)) rounded.push({ rect, radii: own })
		for (const shape of clips.rounded) if (cornersReach(shape, visible)) rounded.push(shape)
		if (rounded.length > 1) return []

		const occlusion = occlusionEvidence(element, visible)
		if (occlusion === 'unsupported') return []
		const plan = planOcclusion(occlusion)
		if (plan.status !== 'precise') return []

		if (rounded.length === 1) {
			if (plan.subtract.length > 0) return []
			const approximated = approximateRoundedRectContour(rounded[0]!.rect, rounded[0]!.radii, roundedTargetMaxError)
			if (!approximated) return []
			const polygon = clipPolygonToBox(contourVertices(approximated.contour.commands), visible)
			if (!polygon) return []
			return [Object.freeze({ regionId: 'r0', maxError: approximated.maxError, contour: Object.freeze({ commands: Object.freeze(polygonCommands(polygon)) }) })]
		}

		// A bounded cut lying wholly inside the visible area would leave only an interior hole, which
		// is never reported (Rule 01a11687-3037): no precise region (Discussion #241 owner decision 1).
		for (const cut of plan.subtract) {
			if (cut.kind !== 'paint-bound') continue
			const { x, y, width, height } = cut.shape
			if (x > visible.left && y > visible.top && x + width < visible.right && y + height < visible.bottom) return []
		}
		const contours = subtractAxisAlignedRectangularOcclusion(rectOfBox(visible), plan.subtract.map(item => item.shape))
		if (!contours) return []
		return contours.map((contour, index) => Object.freeze({ regionId: `r${index}`, maxError: 0, contour }))
	}

	/** Classifies every element whose box overlaps the visible area and is not the Widget's own. */
	function occlusionEvidence(target: Element, visible: Box): OcclusionEvidence<WidgetRect>[] | 'unsupported' {
		const { elements, boxes } = candidateBoxes()
		const evidence: OcclusionEvidence<WidgetRect>[] = []
		for (let index = 0; index < elements.length; index++) {
			const left = Math.max(visible.left, boxes[index * 4]!)
			const top = Math.max(visible.top, boxes[index * 4 + 1]!)
			const right = Math.min(visible.right, boxes[index * 4 + 2]!)
			const bottom = Math.min(visible.bottom, boxes[index * 4 + 3]!)
			if (!(right > left) || !(bottom > top)) continue
			const candidate = elements[index]!
			if (candidate === target || candidate.contains(target) || target.contains(candidate)) continue
			const item = classifyCandidate(candidate, target, visible)
			if (item === 'unsupported') return 'unsupported'
			if (item) evidence.push(item)
		}
		return evidence
	}

	function classifyCandidate(candidate: Element, target: Element, visible: Box): OcclusionEvidence<WidgetRect> | 'unsupported' | undefined {
		const style = styleOf(candidate)
		if (style.visibility !== 'visible') return undefined
		const chain = chainOf(candidate)
		if (chain.opacity === 0) return undefined
		const paint = paintedContent(candidate, style)
		if (paint === 'nothing') return undefined
		// An undecided order is taken as above: covering paint that is really below only cuts more.
		const order = paintOrder(candidate, target)
		if (order === 'below') return undefined
		if (paint === 'replaced' || chain.compositing || chain.shapeClip || !chain.transformOk || chain.reflect) return boundedCut(candidate)
		if (paint === 'translucent' || chain.opacity < 1) return { classification: 'translucent', targetContribution: 'proven-nonzero' }
		if (order === 'unknown') return boundedCut(candidate)

		// Opaque background: the covered area is the background painting area, clipped by the
		// occluder's own clip chain. Rounded corners that reach the Widget are outside the exact subset.
		const bounds = rectOf(candidate)
		const scale = scaleOf(candidate)
		const inset = backgroundInset(style, scale)
		const covered = { left: bounds.left + inset.left, top: bounds.top + inset.top, right: bounds.right - inset.right, bottom: bounds.bottom - inset.bottom }
		const radii = radiiOf(candidate, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
		if (radii && cornersReach({ rect: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }, radii }, visible)) return boundedCut(candidate)
		const clips = clipChainOf(candidate)
		if (clips === 'unsupported') return boundedCut(candidate)
		const painted = intersect(covered, clips.box)
		if (!painted) return undefined
		if (clips.rounded.some(shape => cornersReach(shape, intersect(painted, visible) ?? painted))) return boundedCut(candidate)
		return { classification: 'opaque', targetContribution: 'proven-zero', shape: { kind: 'rectangle', shape: rectOfBox(painted) } }
	}

	/**
	 * Evidence for an occluder whose exact covering shape or paint order is unproven: its finite
	 * paint bound (Discussion #241 R6), or `unsupported` when no finite bound is provable.
	 */
	function boundedCut(candidate: Element): OcclusionEvidence<WidgetRect> | 'unsupported' | undefined {
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
			if (extent !== 'unbounded' && !extent.filtered && chainOf(element).transformOk) {
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
		if (box && text) {
			const glyphs = ownTextBound(element, style)
			if (glyphs === 'unbounded') return 'unbounded'
			if (glyphs) box = union(box, glyphs)
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
	 * The client box of the element's own text nodes, grown by how far their glyphs, decorations,
	 * strokes and text shadows can paint beyond the text's inline boxes; undefined without rendered
	 * text. Glyph ink is taken to stay within one em of the inline boxes, a decoration within its
	 * offset plus its thickness (one em when automatic) beyond that.
	 */
	function ownTextBound(element: Element, style: StyleFacts): Box | undefined | 'unbounded' {
		let box: Box | undefined
		for (const node of Array.from(element.childNodes)) {
			if (node.nodeType !== 3 || !node.textContent) continue
			const range = doc.createRange()
			range.selectNodeContents(node)
			const rect = range.getBoundingClientRect()
			if (!(rect.width > 0) && !(rect.height > 0)) continue
			box = box ? union(box, rect) : { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
		}
		if (!box) return undefined
		const shadow = shadowOutsets(style.textShadow, false)
		const em = lengthPx(style.fontSize)
		const stroke = style.webkitTextStrokeWidth === '' ? 0 : lengthPx(style.webkitTextStrokeWidth)
		if (!shadow || em === undefined || stroke === undefined) return 'unbounded'
		let decoration = 0
		if (style.textDecorationLine !== '' && style.textDecorationLine !== 'none') {
			const offset = style.textUnderlineOffset === 'auto' || style.textUnderlineOffset === '' ? 0 : lengthPx(style.textUnderlineOffset)
			const thickness = /^(?:auto|from-font)?$/.test(style.textDecorationThickness) ? em : lengthPx(style.textDecorationThickness)
			if (offset === undefined || thickness === undefined) return 'unbounded'
			decoration = Math.abs(offset) + Math.abs(thickness)
		}
		const reach = em + Math.abs(stroke) + decoration
		const grown = growBox(box, element, { left: reach + shadow.left, top: reach + shadow.top, right: reach + shadow.right, bottom: reach + shadow.bottom })
		return grown ?? 'unbounded'
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

	/** What an element paints itself, children excluded (they are candidates of their own). */
	function paintedContent(element: Element, style: StyleFacts): 'nothing' | 'translucent' | 'opaque' | 'replaced' {
		const tag = element.tagName.toUpperCase()
		if (REPLACED_TAGS.has(tag)) return 'replaced'
		if (NATIVE_CONTROL_TAGS.has(tag) && style.appearance !== 'none' && style.webkitAppearance !== 'none') return 'replaced'
		const background = colorAlpha(style.backgroundColor)
		if (background === undefined) return 'replaced'
		if (background === 1 && style.backgroundClip !== 'text') return 'opaque'
		const marks = background > 0
			|| style.backgroundImage !== 'none'
			|| style.boxShadow !== 'none'
			|| (style.outlineStyle !== 'none' && px(style.outlineWidth) > 0)
			|| hasVisibleBorder(style)
			|| hasOwnText(element)
		return marks ? 'translucent' : 'nothing'
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
			filteredChains = new Map()
		},
	})
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
 * Whether the engine applies the element's transform (CSS Transforms 1 "transformable element"): not
 * for a box-less element, a table-column or table-column-group box, or a non-replaced inline box.
 * SVG elements and replaced or native-control elements keep it.
 */
function isTransformable(element: Element, style: StyleFacts): boolean {
	const display = style.display.trim()
	if (display === 'contents' || display === 'none' || display === 'table-column' || display === 'table-column-group') return false
	const inline = display === 'inline' || /^inline (?:flow|list-item|flow list-item)$/.test(display) || display.startsWith('ruby')
	if (!inline || isSvgElement(element)) return true
	const tag = element.tagName.toUpperCase()
	if (tag === 'OBJECT') return !element.hasChildNodes()
	return CLIPPED_REPLACED_TAGS.has(tag) || NATIVE_CONTROL_TAGS.has(tag) || tag === 'FIELDSET'
}

/**
 * Whether CSS overflow clips the element's content: it does not apply to a non-replaced inline box
 * (an inline `<object>` with fallback content is not replaced, though the engine forces its overflow
 * to clip and ignores its transform), so a child's outline paints outside it.
 */
function overflowApplies(element: Element, style: StyleFacts): boolean {
	const display = style.display.trim()
	const inline = display === 'inline' || /^inline (?:flow|list-item|flow list-item)$/.test(display) || display.startsWith('ruby')
	if (!inline || isSvgElement(element)) return true
	const tag = element.tagName.toUpperCase()
	if (tag === 'OBJECT') return !element.hasChildNodes()
	return CLIPPED_REPLACED_TAGS.has(tag) || NATIVE_CONTROL_TAGS.has(tag)
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

function length(value: string | undefined, basis: number): number {
	if (!value) return 0
	if (value.endsWith('%')) return (Number.parseFloat(value) / 100) * basis
	return px(value)
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

/** Vertices of a contour made of lines and line-equivalent cubic chords (rounded-contour output). */
function contourVertices(commands: readonly ContourCommand[]): Point[] {
	const points: Point[] = []
	for (const command of commands) if (command.op !== 'close') points.push({ x: command.x, y: command.y })
	return points
}

/** Sutherland–Hodgman clipping of a convex polygon by an exact axis-aligned box. */
function clipPolygonToBox(points: readonly Point[], box: Box): Point[] | undefined {
	let output = [...points]
	const edges: ReadonlyArray<Readonly<{ inside: (p: Point) => boolean; cut: (a: Point, b: Point) => Point }>> = [
		{ inside: p => p.x >= box.left, cut: (a, b) => ({ x: box.left, y: a.y + (b.y - a.y) * (box.left - a.x) / (b.x - a.x) }) },
		{ inside: p => p.x <= box.right, cut: (a, b) => ({ x: box.right, y: a.y + (b.y - a.y) * (box.right - a.x) / (b.x - a.x) }) },
		{ inside: p => p.y >= box.top, cut: (a, b) => ({ x: a.x + (b.x - a.x) * (box.top - a.y) / (b.y - a.y), y: box.top }) },
		{ inside: p => p.y <= box.bottom, cut: (a, b) => ({ x: a.x + (b.x - a.x) * (box.bottom - a.y) / (b.y - a.y), y: box.bottom }) },
	]
	for (const edge of edges) {
		const input = output
		output = []
		for (let index = 0; index < input.length; index++) {
			const current = input[index]!
			const previous = input[(index + input.length - 1) % input.length]!
			const currentInside = edge.inside(current)
			const previousInside = edge.inside(previous)
			if (currentInside) {
				if (!previousInside) output.push(edge.cut(previous, current))
				output.push(current)
			}
			else if (previousInside) output.push(edge.cut(previous, current))
		}
		if (output.length === 0) return undefined
	}
	const deduplicated: Point[] = []
	for (const point of output) {
		const last = deduplicated[deduplicated.length - 1]
		if (!last || last.x !== point.x || last.y !== point.y) deduplicated.push(point)
	}
	while (deduplicated.length > 1 && deduplicated[0]!.x === deduplicated[deduplicated.length - 1]!.x && deduplicated[0]!.y === deduplicated[deduplicated.length - 1]!.y) deduplicated.pop()
	if (deduplicated.length < 3) return undefined
	let area = 0
	for (let index = 0; index < deduplicated.length; index++) {
		const a = deduplicated[index]!
		const b = deduplicated[(index + 1) % deduplicated.length]!
		area += a.x * b.y - b.x * a.y
	}
	return area !== 0 ? deduplicated : undefined
}

function polygonCommands(points: readonly Point[]): ContourCommand[] {
	const [first, ...rest] = points
	return [
		Object.freeze({ op: 'moveTo' as const, x: first!.x, y: first!.y }),
		...rest.map(point => Object.freeze({ op: 'lineTo' as const, x: point.x, y: point.y })),
		Object.freeze({ op: 'close' as const }),
	]
}
