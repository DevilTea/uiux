import { onBeforeUnmount, onMounted, ref, shallowRef, watch, type Ref } from 'vue'
import { measureContentBoxQuad } from '../../src/preview/axis-aligned-content-quad'
import { deriveOuterMapping } from '../../src/preview/derived-outer-mapping'
import { OuterMappingObserverController, type OuterMappingLoopMode } from '../../src/preview/outer-observer'
import type { AffineOuterMapping } from '../../src/preview/outer-precision'

export type CanvasMappingStatus = 'unknown' | 'available' | 'unavailable'

/**
 * Inner content-viewport → overlay-layer mapping for the canvas (Part 3 observer lifecycle).
 *
 * One measurement per frame per iframe serves every overlay consumer. In `continuous` mode (a
 * selection highlight or a hover/targeting outline is shown) the shared
 * `OuterMappingObserverController` remeasures every animation frame, so zoom tweens, scrolling and
 * panel resizes stay tracked. In `event-driven` mode (pins only, 2026-10-05 decision 9) it
 * remeasures once after a dirty signal, and every frame only while a CSS transition or animation
 * runs on an ancestor of the iframe; with nothing changing it requests no frame at all. The
 * mapping is relative to the overlay layer, which scrolls with the frame, so overlay marks are
 * positioned in that layer's own CSS px. A non-affine or unmeasurable mapping is reported as
 * `unavailable`; callers then draw nothing (no heuristic).
 */
export function useCanvasMapping(options: Readonly<{
	iframe: Ref<HTMLIFrameElement | undefined>
	overlay: Ref<HTMLElement | undefined>
	viewport: Ref<Readonly<{ width: number; height: number }>>
	active: Ref<boolean>
	mode?: Ref<OuterMappingLoopMode>
}>) {
	const mapping = shallowRef<AffineOuterMapping>()
	const status = ref<CanvasMappingStatus>('unknown')

	function measure(): AffineOuterMapping | undefined {
		const iframe = options.iframe.value
		const overlay = options.overlay.value
		if (!iframe || !overlay || !iframe.isConnected) return undefined
		const measured = measureContentBoxQuad(iframe)
		if (measured.status !== 'available') return undefined
		const layer = overlay.getBoundingClientRect()
		const layerScale = overlay.offsetWidth > 0 ? layer.width / overlay.offsetWidth : 1
		if (!(layerScale > 0)) return undefined
		const local = (point: Readonly<{ x: number; y: number }>) => ({ x: (point.x - layer.left) / layerScale, y: (point.y - layer.top) / layerScale })
		const derived = deriveOuterMapping(options.viewport.value, {
			p1: local(measured.quad.p1),
			p2: local(measured.quad.p2),
			p3: local(measured.quad.p3),
			p4: local(measured.quad.p4),
		})
		return derived.status === 'affine' ? derived.mapping : undefined
	}

	const controller = new OuterMappingObserverController<AffineOuterMapping>({
		requestFrame: callback => requestAnimationFrame(callback),
		cancelFrame: handle => cancelAnimationFrame(handle),
		measureRenderedMapping: measure,
		onMappingMeasured(next) {
			status.value = 'available'
			if (!mapping.value || !sameMapping(mapping.value, next)) mapping.value = next
		},
		onMappingUnavailable() {
			status.value = 'unavailable'
			mapping.value = undefined
		},
		// Content-viewport size changes are handled by the session, which reopens geometry with fresh identities.
		onInnerGeometryInvalidated() {},
	})

	watch(() => options.mode?.value ?? 'continuous', mode => controller.setMode(mode), { immediate: true })

	watch(options.active, (active) => {
		controller.setOverlayActive(active)
		if (!active) {
			mapping.value = undefined
			status.value = 'unknown'
		}
	}, { immediate: true })

	watch(options.viewport, (viewport) => {
		controller.observeContentViewport(viewport.width, viewport.height)
	}, { immediate: true, deep: true })

	// Dirty signals for the event-driven mode. In continuous mode they are absorbed by the loop.
	const markDirty = () => controller.markMappingDirty()
	/** Running CSS transitions/animations on ancestors of the iframe (they move it without events). */
	const running = new Set<EventTarget>()
	function onAnimationEvent(event: Event): void {
		const iframe = options.iframe.value
		const target = event.target
		if (!iframe || !(target instanceof Node) || !target.contains(iframe)) return
		if (event.type === 'transitionrun' || event.type === 'animationstart') running.add(target)
		else if (!hasRunningAnimation(target)) running.delete(target)
		controller.setAnimating(running.size > 0)
		markDirty()
	}
	const animationEvents = ['transitionrun', 'transitionend', 'transitioncancel', 'animationstart', 'animationend', 'animationcancel'] as const
	const resizeObserver = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(markDirty)
	onMounted(() => {
		window.addEventListener('resize', markDirty)
		for (const type of animationEvents) document.addEventListener(type, onAnimationEvent, true)
	})
	watch([options.iframe, options.overlay], ([iframe, overlay]) => {
		resizeObserver?.disconnect()
		if (iframe) resizeObserver?.observe(iframe)
		if (overlay) resizeObserver?.observe(overlay)
	}, { immediate: true, flush: 'post' })

	onBeforeUnmount(() => {
		window.removeEventListener('resize', markDirty)
		for (const type of animationEvents) document.removeEventListener(type, onAnimationEvent, true)
		resizeObserver?.disconnect()
		controller.dispose()
	})

	return { mapping, status, markDirty }
}

function hasRunningAnimation(target: EventTarget): boolean {
	const element = target as Element
	return typeof element.getAnimations === 'function' && element.getAnimations().some(animation => animation.playState === 'running')
}

function sameMapping(left: AffineOuterMapping, right: AffineOuterMapping): boolean {
	return left.a === right.a && left.b === right.b && left.c === right.c
		&& left.d === right.d && left.e === right.e && left.f === right.f
}
