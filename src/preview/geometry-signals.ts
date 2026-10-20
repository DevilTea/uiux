import type { RuntimeGeometryProducer } from './geometry-producer'

export type GeometrySignalSubscription = Readonly<{ dispose(): void; refreshObservedWidgets(): void }>

/**
 * CSS properties whose animation on an element that is neither a tracked Widget nor one of its
 * ancestors (checked separately) changes nothing the DOM measurer reads: colours it never reads
 * and that no value it reads resolves from. Every other property can move a box, or change an
 * occluder's paint bound (`box-shadow`, `filter`, the transform family, ...) or its classification
 * (`opacity`, `background-color`, `color` through `currentcolor` borders, ...) between two frames,
 * so a region measured at the animation's start could include paint the occluder covers (#261).
 */
/** Period of the idle animation check that notices script animations, which fire no event (#271). */
const IDLE_ANIMATION_CHECK_MS = 250

const GEOMETRY_INERT_PROPERTIES = new Set([
	'outline-color', 'text-decoration-color', 'caret-color', 'accent-color', 'fill', 'stroke',
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
 * animation that can change a tracked Widget's geometry is running (one on an ancestor-or-self of
 * a tracked Widget, or one animating anywhere a property outside `GEOMETRY_INERT_PROPERTIES`, an
 * occluder's paint included), and stops as soon as none is. Whether one runs is decided from
 * `document.getAnimations()`, never by polling styles: after animation boundary events, DOM
 * mutations and stream changes, in every frame while the producer measures every frame, and every
 * `IDLE_ANIMATION_CHECK_MS` while a stream is open and the producer is idle (script animations fire
 * no event).
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
		scheduleAnimationCheck()
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

	function animationsMayChangeGeometry(): boolean {
		const animations = typeof doc.getAnimations === 'function' ? doc.getAnimations() : []
		if (animations.length === 0) return false
		return animations.some((animation) => {
			if (animation.playState !== 'running') return false
			const effect = animation.effect as KeyframeEffect | null
			const target = effect?.target
			if (!target) return false
			for (const element of observed) if (target === element || target.contains(element)) return true
			return animatedProperties(animation, effect).some(property => !GEOMETRY_INERT_PROPERTIES.has(property))
		})
	}

	let animationCheck: number | undefined
	let idleCheck: ReturnType<typeof setTimeout> | undefined
	let disposed = false
	function scheduleAnimationCheck(): void {
		if (disposed || animationCheck !== undefined) return
		if (idleCheck !== undefined) {
			clearTimeout(idleCheck)
			idleCheck = undefined
		}
		// Decide after the frame's style update, when started/ended animations are reflected.
		animationCheck = view.requestAnimationFrame(() => {
			animationCheck = undefined
			decideContinuous()
		})
	}

	function decideContinuous(): void {
		if (disposed) return
		const active = animationsMayChangeGeometry()
		producer.setContinuous(active)
		if (producer.trackedWidgetIds().length === 0) return
		// While the producer measures every frame, check again every frame: an animation can stop
		// without an event that reaches the document (its element removed, a script cancel).
		if (active) scheduleAnimationCheck()
		// A script animation (`element.animate()`) fires no animation event and may start without a
		// DOM mutation, so while a stream is open and the producer is idle, look again at a low rate
		// (#271): one `getAnimations()` pass per `IDLE_ANIMATION_CHECK_MS` straight from the timer, so
		// an idle page schedules no animation frame.
		else if (idleCheck === undefined) {
			idleCheck = setTimeout(() => {
				idleCheck = undefined
				decideContinuous()
			}, IDLE_ANIMATION_CHECK_MS)
		}
	}

	function onAnimationBoundary(): void {
		invalidate()
		scheduleAnimationCheck()
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
	scheduleAnimationCheck()

	return Object.freeze({
		/** Call after the stream set changed: also decides again whether to measure every frame. */
		refreshObservedWidgets() {
			refreshObservedWidgets()
			scheduleAnimationCheck()
		},
		dispose() {
			disposed = true
			if (animationCheck !== undefined) view.cancelAnimationFrame(animationCheck)
			animationCheck = undefined
			if (idleCheck !== undefined) clearTimeout(idleCheck)
			idleCheck = undefined
			resizeObserver.disconnect()
			mutationObserver.disconnect()
			for (const [type, listener, options] of windowEvents) view.removeEventListener(type, listener, options)
			for (const [type, listener, options] of documentEvents) doc.removeEventListener(type, listener, options)
			fonts?.removeEventListener?.('loadingdone', invalidate)
			producer.setContinuous(false)
		},
	})
}

const animatedPropertyCache = new WeakMap<Animation, string[]>()

function animatedProperties(animation: Animation, effect: KeyframeEffect): string[] {
	const cached = animatedPropertyCache.get(animation)
	if (cached) return cached
	const properties = readAnimatedProperties(effect, animation)
	animatedPropertyCache.set(animation, properties)
	return properties
}

function readAnimatedProperties(effect: KeyframeEffect, animation: Animation): string[] {
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
