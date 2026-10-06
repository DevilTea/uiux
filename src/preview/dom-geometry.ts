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
 * paint-containment clip on its containing-block chain, minus proven opaque occluders. It never
 * guesses. Whenever the visible set cannot be proven inside the exact subset below, it reports
 * `regions: []` ("no reliably visible region", Part 4) instead of a bounding box.
 *
 * Exact subset:
 * - Widget and occluder boxes whose transform chain is translation plus uniform positive scale.
 *   Rotation, skew, flips, nonuniform scale, 3D and motion paths fail closed. The chain follows
 *   the flat tree (assigned slot, parent element, shadow host), and an SVG ancestor fails closed.
 * - Rectangular clips are exact. One rounded shape may take part (the Widget's own border radius,
 *   or one rounded overflow clip whose corners reach the visible area): its contour is the
 *   `approximateRoundedRectContour` polygon clipped by the exact rectangle, with that contour's
 *   `maxError`. Two rounded shapes at once, or a rounded shape plus an opaque occluder, fail closed.
 * - Occluders are elements that paint above the Widget, determined from the CSS painting order
 *   (stacking contexts, z-index, positioned layers, tree order). Overlap between two in-flow boxes,
 *   whose backgrounds and inline content interleave, is not decided and fails closed.
 *   - Opaque (subtracted): opacity 1 along the chain, an opaque background colour, no filter,
 *     blend mode, mask or clip-path, square corners where they meet the Widget, painted area
 *     clipped by the occluder's own clip chain.
 *   - Translucent (kept, Part 4): a background with alpha below 1, borders or text only.
 *   - Unsupported (fail closed): replaced content (images, SVG, canvas, video, frames, native
 *     controls), filters, blend modes, masks, clip paths, rounded opaque corners over the Widget.
 *
 * Not modelled: generated content (`::before`/`::after`), box shadows and outlines painted outside
 * an occluder's border box, and text overflowing its box. They are treated as not covering.
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
	'backgroundColor', 'backgroundImage', 'backgroundClip', 'boxShadow', 'outlineStyle', 'outlineWidth', 'appearance',
] as const
type StyleKey = typeof STYLE_KEYS[number] | 'webkitMaskImage' | 'webkitAppearance'
type StyleFacts = Readonly<Record<StyleKey, string>>

function snapshotStyle(style: CSSStyleDeclaration): StyleFacts {
	const facts = {} as Record<StyleKey, string>
	const source = style as unknown as Record<string, string | undefined>
	for (const key of STYLE_KEYS) facts[key] = source[key] ?? ''
	facts.webkitMaskImage = style.getPropertyValue('-webkit-mask-image')
	facts.webkitAppearance = style.getPropertyValue('-webkit-appearance')
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
	// Per-pass caches: layout is read once per element per animation frame.
	let rects = new Map<Element, DOMRect>()
	let candidates: { elements: Element[]; boxes: Float64Array } | undefined
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

	/** Every element that can paint over a Widget, with its border box, measured once per pass. */
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
			const rect = rectOf(element)
			boxes[index * 4] = rect.left
			boxes[index * 4 + 1] = rect.top
			boxes[index * 4 + 2] = rect.right
			boxes[index * 4 + 3] = rect.bottom
		})
		candidates = { elements, boxes }
		return candidates
	}

	type ChainFlags = Readonly<{ opacity: number; transformOk: boolean; compositing: boolean; shapeClip: boolean; hidden: boolean }>

	/** Aggregated style facts of an element and all its flat-tree ancestors. */
	function chainOf(element: Element): ChainFlags {
		const cached = chainFlags.get(element)
		if (cached) return cached
		const style = styleOf(element)
		const parent = flatTreeParent(element)
		const inherited: ChainFlags = parent ? chainOf(parent) : { opacity: 1, transformOk: true, compositing: false, shapeClip: false, hidden: false }
		const opacity = Number.parseFloat(style.opacity)
		const flags: ChainFlags = {
			opacity: inherited.opacity * (Number.isFinite(opacity) ? opacity : 1),
			transformOk: inherited.transformOk && !(parent && isSvgElement(parent)) && transformIsUniform(style),
			compositing: inherited.compositing || hasCompositing(style),
			shapeClip: inherited.shapeClip || (style.clipPath !== '' && style.clipPath !== 'none') || hasMask(style),
			hidden: false,
		}
		chainFlags.set(element, flags)
		return flags
	}

	/** Scale of an element's rendered box over its layout box (uniform under the transform proof). */
	function scaleOf(element: Element): number {
		const html = element as HTMLElement
		const rect = rectOf(element)
		return typeof html.offsetWidth === 'number' && html.offsetWidth > 0 ? rect.width / html.offsetWidth : 1
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

	/** The padding box of an overflow clip, its inner radii applying when the clip is rounded. */
	function clipShapeOf(element: Element): Readonly<{ box: Box; rounded?: RoundedShape }> {
		const style = styleOf(element)
		const rect = rectOf(element)
		const scale = scaleOf(element)
		const html = element as HTMLElement
		const left = rect.left + (html.clientLeft ?? 0) * scale
		const top = rect.top + (html.clientTop ?? 0) * scale
		const box = {
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
	function clipChainOf(element: Element): ClipChain {
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
			const clipX = style.overflowX !== 'visible' || containsPaint(style)
			const clipY = style.overflowY !== 'visible' || containsPaint(style)
			if (clipX || clipY) {
				if ((style.overflowX === 'clip' || style.overflowY === 'clip') && px(style.overflowClipMargin) !== 0) return 'unsupported'
				const shape = clipShapeOf(ancestor)
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
		const order = paintOrder(candidate, target)
		if (order === 'below') return undefined
		if (order === 'unknown') return 'unsupported'
		if (paint === 'replaced' || chain.compositing || chain.shapeClip || !chain.transformOk) return 'unsupported'
		if (paint === 'translucent' || chain.opacity < 1) return { classification: 'translucent', targetContribution: 'proven-nonzero' }

		// Opaque background: the covered area is the background painting area, clipped by the
		// occluder's own clip chain. Rounded corners that reach the Widget are outside the exact subset.
		const bounds = rectOf(candidate)
		const scale = scaleOf(candidate)
		const inset = backgroundInset(style, scale)
		const covered = { left: bounds.left + inset.left, top: bounds.top + inset.top, right: bounds.right - inset.right, bottom: bounds.bottom - inset.bottom }
		const radii = radiiOf(candidate, { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height })
		if (radii && cornersReach({ rect: { x: bounds.left, y: bounds.top, width: bounds.width, height: bounds.height }, radii }, visible)) return 'unsupported'
		const clips = clipChainOf(candidate)
		if (clips === 'unsupported') return 'unsupported'
		const painted = intersect(covered, clips.box)
		if (!painted) return undefined
		if (clips.rounded.some(shape => cornersReach(shape, intersect(painted, visible) ?? painted))) return 'unsupported'
		return { classification: 'opaque', targetContribution: 'proven-zero', shape: { kind: 'rectangle', shape: rectOfBox(painted) } }
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
