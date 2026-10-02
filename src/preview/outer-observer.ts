export type FrameHandle = number

export type OuterMappingObserverDependencies<Mapping> = Readonly<{
	requestFrame: (callback: () => void) => FrameHandle
	cancelFrame: (handle: FrameHandle) => void
	measureRenderedMapping: () => Mapping | undefined
	onMappingMeasured: (mapping: Mapping) => void
	onMappingUnavailable: () => void
	onInnerGeometryInvalidated: () => void
}>

export type OuterMappingObserverSnapshot = Readonly<{
	overlayActive: boolean
	mappingDirty: boolean
	frameScheduled: boolean
	measurement: 'unknown' | 'available' | 'unavailable'
	contentViewport?: Readonly<{ width: number; height: number }>
}>

/**
 * Workbench-side outer mapping lifecycle.
 *
 * While an overlay is active, one rAF callback continuously remeasures the browser-reported
 * rendered mapping so CSS transitions/animations stay tracked. Event signals merely mark the
 * mapping dirty and are coalesced into that single-frame cadence. No rAF loop survives once
 * the overlay becomes inactive.
 */
export class OuterMappingObserverController<Mapping> {
	private readonly deps: OuterMappingObserverDependencies<Mapping>
	private overlayActive = false
	private mappingDirty = true
	private frameHandle?: FrameHandle
	private measurement: 'unknown' | 'available' | 'unavailable' = 'unknown'
	private contentViewport?: Readonly<{ width: number; height: number }>
	private disposed = false

	constructor(deps: OuterMappingObserverDependencies<Mapping>) {
		this.deps = deps
	}

	setOverlayActive(active: boolean): void {
		this.assertLive()
		if (this.overlayActive === active) return
		this.overlayActive = active
		if (active) {
			this.ensureFrame()
			return
		}
		this.cancelScheduledFrame()
	}

	markMappingDirty(): void {
		this.assertLive()
		this.mappingDirty = true
		if (this.overlayActive) this.ensureFrame()
	}

	observeContentViewport(width: number, height: number): Readonly<{ changed: boolean; invalidatedInnerGeometry: boolean }> {
		this.assertLive()
		assertDimension(width, 'width')
		assertDimension(height, 'height')
		const previous = this.contentViewport
		this.contentViewport = Object.freeze({ width, height })
		this.mappingDirty = true
		if (this.overlayActive) this.ensureFrame()
		if (!previous) return { changed: false, invalidatedInnerGeometry: false }
		if (previous.width === width && previous.height === height)
			return { changed: false, invalidatedInnerGeometry: false }
		this.deps.onInnerGeometryInvalidated()
		return { changed: true, invalidatedInnerGeometry: true }
	}

	snapshot(): OuterMappingObserverSnapshot {
		return Object.freeze({
			overlayActive: this.overlayActive,
			mappingDirty: this.mappingDirty,
			frameScheduled: this.frameHandle !== undefined,
			measurement: this.measurement,
			...(this.contentViewport ? { contentViewport: Object.freeze({ ...this.contentViewport }) } : {}),
		})
	}

	dispose(): void {
		if (this.disposed) return
		this.cancelScheduledFrame()
		this.overlayActive = false
		this.disposed = true
	}

	private ensureFrame(): void {
		if (!this.overlayActive || this.frameHandle !== undefined || this.disposed) return
		this.frameHandle = this.deps.requestFrame(() => this.onAnimationFrame())
	}

	private onAnimationFrame(): void {
		this.frameHandle = undefined
		if (!this.overlayActive || this.disposed) return

		const mapping = this.deps.measureRenderedMapping()
		if (mapping === undefined) {
			if (this.measurement !== 'unavailable') this.deps.onMappingUnavailable()
			this.measurement = 'unavailable'
			this.mappingDirty = true
		} else {
			this.deps.onMappingMeasured(mapping)
			this.measurement = 'available'
			this.mappingDirty = false
		}

		// Deliberately continue only while a highlight/targeting overlay is active.
		// This is what tracks transform transitions/animations that emit no per-frame event.
		this.ensureFrame()
	}

	private cancelScheduledFrame(): void {
		if (this.frameHandle === undefined) return
		this.deps.cancelFrame(this.frameHandle)
		this.frameHandle = undefined
	}

	private assertLive(): void {
		if (this.disposed) throw new Error('OuterMappingObserverController is disposed.')
	}
}

export type ContentBoxResizeObserver = Readonly<{ disconnect: () => void }>

/**
 * Browser adapter for the canonical iframe content-box ResizeObserver signal.
 * The rendered-content-box quad itself remains supplied by measureRenderedMapping; this helper
 * intentionally does not reconstruct transformed geometry from getBoundingClientRect().
 */
export function observeIframeContentBox(
	target: Element,
	onContentViewport: (width: number, height: number) => void,
	ResizeObserverImplementation: typeof ResizeObserver = ResizeObserver,
): ContentBoxResizeObserver {
	const observer = new ResizeObserverImplementation(entries => {
		const entry = entries.find(candidate => candidate.target === target)
		if (!entry) return
		onContentViewport(entry.contentRect.width, entry.contentRect.height)
	})
	observer.observe(target, { box: 'content-box' })
	return Object.freeze({ disconnect: () => observer.disconnect() })
}

function assertDimension(value: number, name: string): void {
	if (!Number.isFinite(value) || value < 0)
		throw new TypeError(`${name} must be a finite non-negative CSS-pixel dimension.`)
}
