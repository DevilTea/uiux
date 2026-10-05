import type { RuntimeGeometryProducer } from './geometry-producer'

export type GeometrySignalSubscription = Readonly<{ dispose(): void; refreshObservedWidgets(): void }>

/**
 * CSS properties whose animation cannot move or resize any other box: paint-only properties and
 * the transform family, which moves only its own element (and matters when that element is a
 * tracked Widget or one of its ancestors, checked separately).
 */
const NON_LAYOUT_PROPERTIES = new Set([
	'color', 'background-color', 'background', 'border-color', 'outline-color', 'text-decoration-color',
	'fill', 'stroke', 'box-shadow', 'text-shadow', 'caret-color', 'accent-color', 'filter', 'backdrop-filter', 'opacity',
	'transform', 'translate', 'rotate', 'scale',
])

/**
 * Event-driven invalidation for the runtime geometry producer (Part 2, 2026-10-05 decision 3).
 *
 * Every signal that can change a tracked Widget's `rect` or `regions` marks the producer dirty,
 * and the producer coalesces them into one recomputation in the next animation frame:
 * scroll in any scroll container (capture phase), viewport resize, `ResizeObserver` on the
 * document and on every tracked Widget, DOM mutations, font loading, image loads and interaction
 * state that restyles elements (hover, focus, press). Nothing runs while nothing changes: there is
 * no idle frame loop. A continuous per-frame recomputation runs only while a CSS transition or
 * animation that can move a tracked Widget is running (one on an ancestor-or-self of a tracked
 * Widget, or one animating a layout property anywhere), and stops as soon as none is.
 */
export function attachGeometrySignals(
	view: Window,
	producer: RuntimeGeometryProducer,
	widgetElement: (widgetId: string) => Element | null | undefined,
): GeometrySignalSubscription {
	const doc = view.document
	const invalidate = () => producer.invalidate()
	// Scroll moves boxes but changes no computed style, so style-derived caches survive it.
	const invalidateLayout = () => producer.invalidate('layout')
	const observed = new Set<Element>()

	const resizeObserver = new ResizeObserver(invalidate)
	resizeObserver.observe(doc.documentElement)
	const mutationObserver = new MutationObserver(() => {
		invalidate()
		refreshObservedWidgets()
	})
	mutationObserver.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true })

	function refreshObservedWidgets(): void {
		const next = new Set<Element>()
		for (const widgetId of producer.trackedWidgetIds()) {
			const element = widgetElement(widgetId)
			if (element) next.add(element)
		}
		for (const element of observed) if (!next.has(element)) resizeObserver.unobserve(element)
		for (const element of next) if (!observed.has(element)) resizeObserver.observe(element)
		observed.clear()
		for (const element of next) observed.add(element)
	}

	let animationCheckScheduled = false
	function animationsMayMoveWidgets(): boolean {
		const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations() : []
		if (animations.length === 0) return false
		const tracked = producer.trackedWidgetIds().map(widgetElement).filter((element): element is Element => !!element)
		return animations.some((animation) => {
			if (animation.playState !== 'running') return false
			const effect = animation.effect as KeyframeEffect | null
			const target = effect?.target
			if (!target) return false
			if (tracked.some(element => target === element || target.contains(element))) return true
			return animatedProperties(animation, effect).some(property => !NON_LAYOUT_PROPERTIES.has(property))
		})
	}

	function onAnimationBoundary(): void {
		invalidate()
		if (animationCheckScheduled) return
		animationCheckScheduled = true
		// Decide after the frame's style update, when started/ended animations are reflected.
		view.requestAnimationFrame(() => {
			animationCheckScheduled = false
			producer.setContinuous(animationsMayMoveWidgets())
		})
	}

	const windowEvents: ReadonlyArray<readonly [string, EventListener, AddEventListenerOptions | boolean]> = [
		['resize', invalidate, false],
	]
	const documentEvents: ReadonlyArray<readonly [string, EventListener, AddEventListenerOptions | boolean]> = [
		['scroll', invalidateLayout, { capture: true, passive: true }],
		['load', invalidate, true],
		['pointerover', invalidate, { capture: true, passive: true }],
		['pointerout', invalidate, { capture: true, passive: true }],
		['pointerdown', invalidate, { capture: true, passive: true }],
		['pointerup', invalidate, { capture: true, passive: true }],
		['focusin', invalidate, true],
		['focusout', invalidate, true],
		['input', invalidate, true],
		['change', invalidate, true],
		['transitionrun', onAnimationBoundary, true],
		['transitionend', onAnimationBoundary, true],
		['transitioncancel', onAnimationBoundary, true],
		['animationstart', onAnimationBoundary, true],
		['animationend', onAnimationBoundary, true],
		['animationcancel', onAnimationBoundary, true],
	]
	for (const [type, listener, options] of windowEvents) view.addEventListener(type, listener, options)
	for (const [type, listener, options] of documentEvents) doc.addEventListener(type, listener, options)
	const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts
	fonts?.addEventListener?.('loadingdone', invalidate)
	void fonts?.ready?.then(invalidate, () => undefined)

	refreshObservedWidgets()

	return Object.freeze({
		refreshObservedWidgets,
		dispose() {
			resizeObserver.disconnect()
			mutationObserver.disconnect()
			for (const [type, listener, options] of windowEvents) view.removeEventListener(type, listener, options)
			for (const [type, listener, options] of documentEvents) doc.removeEventListener(type, listener, options)
			fonts?.removeEventListener?.('loadingdone', invalidate)
			producer.setContinuous(false)
		},
	})
}

function animatedProperties(animation: Animation, effect: KeyframeEffect): string[] {
	const transition = (animation as Animation & { transitionProperty?: string }).transitionProperty
	if (transition) return [transition]
	try {
		const properties = new Set<string>()
		for (const keyframe of effect.getKeyframes()) {
			for (const key of Object.keys(keyframe)) {
				if (key === 'offset' || key === 'easing' || key === 'composite' || key === 'computedOffset') continue
				properties.add(key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`))
			}
		}
		return [...properties]
	}
	catch {
		return ['unknown']
	}
}
