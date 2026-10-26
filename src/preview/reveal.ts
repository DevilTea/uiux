/**
 * What a runtime that declares `geometry.reveal` does with a reveal (Clauses
 * 01a11a59-da48-7437-bee8-67787175cbda and 01a11a70-3d8d-7e52-9412-8a92797814e6; issue #105).
 *
 * The runtime scrolls only when the Widget has a rendered box of non-zero area, nothing on its chain
 * hides it (`display`, `visibility`, zero opacity), and no part of its box lies inside the visible
 * area of its scroll containers. It then scrolls only scroll containers of its own document, the
 * root scroller included, instantly and by the least movement that brings the box into view.
 *
 * `Element.scrollIntoView()` is deliberately not used: in a same-origin iframe it can also scroll
 * the containing documents, which a reveal must never do.
 */

export type RevealOutcome = 'scrolled' | 'none'

type Box = Readonly<{ left: number; top: number; right: number; bottom: number }>

/**
 * The scroll offset change on one axis that brings the box `[start, end]` into the visible interval
 * `[areaStart, areaEnd]` with the least movement: the `nearest` alignment of CSSOM View
 * `scrollIntoView`. A box already inside needs none; a box wider than the area aligns the edge it
 * lies beyond, so the movement is never larger than the one that makes the box overlap the area.
 */
export function nearestScrollDelta(start: number, end: number, areaStart: number, areaEnd: number): number {
	const size = end - start
	const areaSize = areaEnd - areaStart
	const startOutside = start < areaStart
	const endOutside = end > areaEnd
	if (!startOutside && !endOutside) return 0
	if (startOutside && endOutside) return 0
	if ((startOutside && size < areaSize) || (endOutside && size > areaSize)) return start - areaStart
	return end - areaEnd
}

function overlaps(a: Box, b: Box): boolean {
	return Math.min(a.right, b.right) > Math.max(a.left, b.left) && Math.min(a.bottom, b.bottom) > Math.max(a.top, b.top)
}

function intersect(a: Box, b: Box): Box {
	const left = Math.max(a.left, b.left)
	const top = Math.max(a.top, b.top)
	return { left, top, right: Math.max(left, Math.min(a.right, b.right)), bottom: Math.max(top, Math.min(a.bottom, b.bottom)) }
}

function boxOf(element: Element): Box {
	const rect = element.getBoundingClientRect()
	return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
}

const SCROLLABLE_OVERFLOW = new Set(['auto', 'scroll', 'hidden'])

type Container = Readonly<{ element: Element; root: boolean }>

/** Whether an element is a scroll container whose scroll offset a script can move. */
function isScrollContainer(doc: Document, element: Element, style: CSSStyleDeclaration): boolean {
	if (element === doc.documentElement) return false
	if (!SCROLLABLE_OVERFLOW.has(style.overflowX) && !SCROLLABLE_OVERFLOW.has(style.overflowY)) return false
	// The body's overflow belongs to the viewport while the root element's is `visible`.
	if (element === doc.body) {
		const rootStyle = doc.defaultView!.getComputedStyle(doc.documentElement)
		if (rootStyle.overflowX === 'visible' && rootStyle.overflowY === 'visible') return false
	}
	return true
}

/** Whether an ancestor's own box makes it the containing block of an absolutely positioned or fixed descendant. */
function establishesContainingBlock(style: CSSStyleDeclaration, fixed: boolean): boolean {
	const transformed = (value: string) => value !== '' && value !== 'none'
	if (transformed(style.transform) || transformed(style.translate) || transformed(style.rotate) || transformed(style.scale)
		|| transformed(style.perspective) || transformed(style.filter) || transformed(style.backdropFilter)
		|| /paint|layout|strict|content/.test(style.contain) || /transform|perspective|filter/.test(style.willChange)) return true
	return !fixed && style.position !== 'static'
}

/**
 * The scroll containers that clip and can scroll the element, innermost first, ending with the
 * root scroller. An ancestor that is not in the element's containing-block chain (an absolutely
 * positioned element escaping it) neither clips nor scrolls it. `undefined` when the element is
 * fixed to the viewport, which no scrolling can bring into view.
 */
function scrollContainersOf(doc: Document, element: Element): readonly Container[] | undefined {
	const view = doc.defaultView!
	const containers: Container[] = []
	let subject = element
	for (let node = element.parentElement; node; node = node.parentElement) {
		if (node === doc.documentElement) break
		const subjectPosition = view.getComputedStyle(subject).position
		const style = view.getComputedStyle(node)
		if ((subjectPosition === 'absolute' && !establishesContainingBlock(style, false))
			|| (subjectPosition === 'fixed' && !establishesContainingBlock(style, true))) continue
		if (isScrollContainer(doc, node, style)) containers.push({ element: node, root: false })
		subject = node
	}
	if (view.getComputedStyle(subject).position === 'fixed') return undefined
	containers.push({ element: doc.scrollingElement ?? doc.documentElement, root: true })
	return containers
}

/** The part of a container the content shows: the viewport for the root scroller, else its padding box. */
function visibleBoxOf(doc: Document, container: Container): Box {
	if (container.root) return { left: 0, top: 0, right: doc.documentElement.clientWidth, bottom: doc.documentElement.clientHeight }
	const box = boxOf(container.element)
	const left = box.left + container.element.clientLeft
	const top = box.top + container.element.clientTop
	return { left, top, right: left + container.element.clientWidth, bottom: top + container.element.clientHeight }
}

/** Whether a rendered Widget is hidden by `display`, `visibility` or zero opacity on its chain. */
function hiddenByChain(doc: Document, element: Element): boolean {
	const view = doc.defaultView!
	const own = view.getComputedStyle(element)
	if (own.visibility !== 'visible') return true
	for (let node: Element | null = element; node; node = node.parentElement) {
		const style = view.getComputedStyle(node)
		if (style.display === 'none' || Number.parseFloat(style.opacity) === 0) return true
	}
	return false
}

/**
 * Scrolls the Widget's own document so that its box comes into view, when a reveal applies to it.
 * Nothing else changes: no focus, no event, no Variant, State, visibility or DOM.
 */
export function revealWidgetElement(doc: Document, element: Element): RevealOutcome {
	const view = doc.defaultView
	if (!view || !element.isConnected) return 'none'
	const first = boxOf(element)
	if (!(first.right - first.left > 0 && first.bottom - first.top > 0)) return 'none'
	if (hiddenByChain(doc, element)) return 'none'
	const containers = scrollContainersOf(doc, element)
	if (!containers) return 'none'
	const visible = containers.reduce((area, container) => intersect(area, visibleBoxOf(doc, container)), { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity } as Box)
	if (overlaps(first, visible)) return 'none'

	let moved = false
	for (const container of containers) {
		const box = boxOf(element)
		const area = visibleBoxOf(doc, container)
		const dx = nearestScrollDelta(box.left, box.right, area.left, area.right)
		const dy = nearestScrollDelta(box.top, box.bottom, area.top, area.bottom)
		if (dx === 0 && dy === 0) continue
		const target = container.element
		const left = target.scrollLeft
		const top = target.scrollTop
		// `behavior: 'instant'` also overrides a `scroll-behavior: smooth` of the document or container.
		target.scrollTo({ left: left + dx, top: top + dy, behavior: 'instant' })
		if (target.scrollLeft !== left || target.scrollTop !== top) moved = true
	}
	return moved ? 'scrolled' : 'none'
}

/** The first element of the document that carries the Widget's identity, as the geometry measurer finds it. */
export function findWidgetElement(doc: Document, widgetId: string): Element | null {
	try {
		return doc.querySelector(`[data-widget-id="${CSS.escape(widgetId)}"]`)
	}
	catch {
		return null
	}
}

export function revealWidget(doc: Document, widgetId: string): RevealOutcome {
	const element = findWidgetElement(doc, widgetId)
	return element ? revealWidgetElement(doc, element) : 'none'
}
