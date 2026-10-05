import { onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue'
import { measureContentBoxQuad } from '../../src/preview/axis-aligned-content-quad'
import { deriveOuterMapping } from '../../src/preview/derived-outer-mapping'
import { OuterMappingObserverController } from '../../src/preview/outer-observer'
import type { AffineOuterMapping } from '../../src/preview/outer-precision'

export type CanvasMappingStatus = 'unknown' | 'available' | 'unavailable'

/**
 * Inner content-viewport → overlay-layer mapping for the canvas (Part 3 observer lifecycle).
 *
 * While the overlay is active, the shared `OuterMappingObserverController` remeasures once per
 * animation frame, so zoom tweens, scrolling and panel resizes stay tracked without a perpetual
 * loop when nothing is drawn. The mapping is relative to the overlay layer, which scrolls with
 * the frame, so overlay marks are positioned in that layer's own CSS px. A non-affine or
 * unmeasurable mapping is reported as `unavailable`; callers then draw nothing (no heuristic).
 */
export function useCanvasMapping(options: Readonly<{
	iframe: Ref<HTMLIFrameElement | undefined>
	overlay: Ref<HTMLElement | undefined>
	viewport: Ref<Readonly<{ width: number; height: number }>>
	active: Ref<boolean>
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
		// Content-viewport size changes are handled by the session, which reopens geometry with a fresh request.
		onInnerGeometryInvalidated() {},
	})

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

	onBeforeUnmount(() => controller.dispose())

	return { mapping, status, markDirty: () => controller.markMappingDirty() }
}

function sameMapping(left: AffineOuterMapping, right: AffineOuterMapping): boolean {
	return left.a === right.a && left.b === right.b && left.c === right.c
		&& left.d === right.d && left.e === right.e && left.f === right.f
}
