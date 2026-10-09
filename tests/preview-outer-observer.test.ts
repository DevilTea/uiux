import { describe, expect, it, vi } from 'vitest'

import {
	observeIframeContentBox,
	OuterMappingObserverController,
	type FrameHandle,
} from '../src/preview/outer-observer'

type Mapping = Readonly<{ quadVersion: number }>

function harness(measurements: Array<Mapping | undefined> = []) {
	let nextHandle = 1
	const frames = new Map<FrameHandle, () => void>()
	const measured: Mapping[] = []
	let unavailable = 0
	let innerInvalidations = 0
	let measureCalls = 0
	const controller = new OuterMappingObserverController<Mapping>({
		requestFrame(callback) {
			const handle = nextHandle++
			frames.set(handle, callback)
			return handle
		},
		cancelFrame(handle) { frames.delete(handle) },
		measureRenderedMapping() {
			measureCalls++
			return measurements.shift()
		},
		onMappingMeasured(mapping) { measured.push(mapping) },
		onMappingUnavailable() { unavailable++ },
		onInnerGeometryInvalidated() { innerInvalidations++ },
	})

	function flushOneFrame(): void {
		const first = frames.entries().next().value as [FrameHandle, () => void] | undefined
		if (!first) throw new Error('no scheduled frame')
		frames.delete(first[0])
		first[1]()
	}

	return {
		controller, frames, measured,
		get unavailable() { return unavailable },
		get innerInvalidations() { return innerInvalidations },
		get measureCalls() { return measureCalls },
		flushOneFrame,
	}
}

describe('Preview outer mapping observer lifecycle', () => {
	it('runs no animation-frame loop while no overlay is active', () => {
		const h = harness([{ quadVersion: 1 }])
		h.controller.markMappingDirty()
		expect(h.frames.size).toBe(0)
		expect(h.measureCalls).toBe(0)
		expect(h.controller.snapshot()).toMatchObject({ overlayActive: false, mappingDirty: true, frameScheduled: false })
	})

	it('coalesces dirty signals into one scheduled frame and measures at most once in that frame', () => {
		const h = harness([{ quadVersion: 1 }, { quadVersion: 2 }])
		h.controller.setOverlayActive(true)
		h.controller.markMappingDirty()
		h.controller.markMappingDirty()
		expect(h.frames.size).toBe(1)
		h.flushOneFrame()
		expect(h.measureCalls).toBe(1)
		expect(h.measured).toEqual([{ quadVersion: 1 }])
		expect(h.frames.size).toBe(1)
	})

	it('remeasures every active-overlay frame even after dirty state clears so CSS transform animation remains trackable', () => {
		const h = harness([{ quadVersion: 1 }, { quadVersion: 2 }, { quadVersion: 3 }])
		h.controller.setOverlayActive(true)
		h.flushOneFrame()
		expect(h.controller.snapshot().mappingDirty).toBe(false)
		h.flushOneFrame()
		h.flushOneFrame()
		expect(h.measured).toEqual([{ quadVersion: 1 }, { quadVersion: 2 }, { quadVersion: 3 }])
		expect(h.measureCalls).toBe(3)
	})

	it('cancels the pending frame immediately when overlay activity ends', () => {
		const h = harness([{ quadVersion: 1 }])
		h.controller.setOverlayActive(true)
		expect(h.frames.size).toBe(1)
		h.controller.setOverlayActive(false)
		expect(h.frames.size).toBe(0)
		expect(h.controller.snapshot()).toMatchObject({ overlayActive: false, frameScheduled: false })
		expect(h.measureCalls).toBe(0)
	})

	it('treats outer movement/transform dirtiness as mapping-only and never invalidates inner geometry', () => {
		const h = harness([{ quadVersion: 1 }])
		h.controller.observeContentViewport(800, 600)
		h.controller.markMappingDirty()
		h.controller.markMappingDirty()
		expect(h.innerInvalidations).toBe(0)
	})

	it('uses content-box size changes as the outer-side signal to invalidate and reacquire inner geometry', () => {
		const h = harness()
		expect(h.controller.observeContentViewport(800, 600)).toEqual({ changed: false, invalidatedInnerGeometry: false })
		expect(h.controller.observeContentViewport(800, 600)).toEqual({ changed: false, invalidatedInnerGeometry: false })
		expect(h.innerInvalidations).toBe(0)
		expect(h.controller.observeContentViewport(801, 600)).toEqual({ changed: true, invalidatedInnerGeometry: true })
		expect(h.innerInvalidations).toBe(1)
		expect(h.controller.observeContentViewport(801, 601)).toEqual({ changed: true, invalidatedInnerGeometry: true })
		expect(h.innerInvalidations).toBe(2)
	})

	it('never retains a stale precise mapping when reliable browser mapping becomes unavailable', () => {
		const h = harness([{ quadVersion: 1 }, undefined, undefined, { quadVersion: 4 }])
		h.controller.setOverlayActive(true)
		h.flushOneFrame()
		expect(h.controller.snapshot()).toMatchObject({ measurement: 'available', mappingDirty: false })
		h.flushOneFrame()
		expect(h.controller.snapshot()).toMatchObject({ measurement: 'unavailable', mappingDirty: true })
		expect(h.unavailable).toBe(1)
		h.flushOneFrame()
		expect(h.unavailable).toBe(1)
		h.flushOneFrame()
		expect(h.controller.snapshot()).toMatchObject({ measurement: 'available', mappingDirty: false })
		expect(h.measured.at(-1)).toEqual({ quadVersion: 4 })
	})

	it('schedules a prompt active-overlay remeasurement after content viewport change without creating duplicate frames', () => {
		const h = harness([{ quadVersion: 1 }])
		h.controller.setOverlayActive(true)
		expect(h.frames.size).toBe(1)
		h.controller.observeContentViewport(800, 600)
		h.controller.observeContentViewport(900, 600)
		expect(h.frames.size).toBe(1)
		expect(h.innerInvalidations).toBe(1)
	})

	it('rejects non-finite or negative content viewport dimensions', () => {
		const h = harness()
		for (const [width, height] of [[-1, 1], [1, -1], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]] as const) {
			expect(() => h.controller.observeContentViewport(width, height)).toThrow(/finite non-negative/)
		}
	})

	it('dispose cancels rAF and prevents later lifecycle mutation', () => {
		const h = harness([{ quadVersion: 1 }])
		h.controller.setOverlayActive(true)
		h.controller.dispose()
		expect(h.frames.size).toBe(0)
		expect(() => h.controller.markMappingDirty()).toThrow(/disposed/)
		expect(() => h.controller.setOverlayActive(true)).toThrow(/disposed/)
	})

	it('browser adapter observes the iframe content box specifically and forwards contentRect width/height', () => {
		const target = {} as Element
		const observe = vi.fn()
		const disconnect = vi.fn()
		let callback!: ResizeObserverCallback
		class FakeResizeObserver {
			constructor(cb: ResizeObserverCallback) { callback = cb }
			observe = observe
			disconnect = disconnect
			unobserve = vi.fn()
		}
		const seen: Array<[number, number]> = []
		const binding = observeIframeContentBox(target, (width, height) => seen.push([width, height]), FakeResizeObserver as unknown as typeof ResizeObserver)
		expect(observe).toHaveBeenCalledWith(target, { box: 'content-box' })
		callback([{ target, contentRect: { width: 640, height: 480 } } as unknown as ResizeObserverEntry], {} as ResizeObserver)
		expect(seen).toEqual([[640, 480]])
		binding.disconnect()
		expect(disconnect).toHaveBeenCalledOnce()
	})
})
