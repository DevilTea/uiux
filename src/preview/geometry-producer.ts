import {
	MAX_TRACKED_WIDGETS,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type GeometryReleaseRequest,
	type VisibleRegion,
	type WidgetRect,
} from './protocol/schema'

/** One Widget's complete geometry at one instant, in inner content-viewport CSS px. */
export type WidgetGeometry = Readonly<{ rect: WidgetRect; regions: readonly VisibleRegion[] }>

/**
 * Measures Widgets for one recomputation pass. `beginPass`/`endPass` bracket the pass so a
 * measurer can share layout reads between every stream measured in the same frame.
 */
export type WidgetMeasurer = Readonly<{
	beginPass(): void
	measure(widgetId: string): WidgetGeometry
	endPass(): void
	/** Drops style-derived caches. Scroll changes layout only, so it does not call this. */
	invalidateStyles?(): void
}>

/** `layout`: only positions may have changed (scroll). `all`: styles or the DOM may have changed too. */
export type GeometryInvalidation = 'layout' | 'all'

/** The runtime context the Preview currently renders; streams for another context never report. */
export type RuntimeGeometryContext = Readonly<{ viewId: string; variantId?: string }>

export type GeometryProducerDependencies = Readonly<{
	/** Sends one validated report through the runtime protocol bridge (gates included). */
	send(response: GeometryAcquireResponse): void
	measurer: WidgetMeasurer
	requestFrame(callback: () => void): number
	cancelFrame(handle: number): void
	/** Monotonic clock for the optional per-frame work statistics. */
	now?: () => number
	/** Streams supported at once. A runtime declaring `geometry.multi-target` supports at least 64. */
	maxStreams?: number
}>

export type GeometryRequestOutcome =
	| 'opened'
	| 'superseded'
	| 'released'
	| 'ignored-over-cap'
	| 'ignored-unknown-stream'

export type GeometryProducerStats = Readonly<{
	frames: number
	reports: number
	/** Wall time of each recomputation pass, newest last (bounded). */
	frameDurations: readonly number[]
}>

type Stream = {
	readonly request: GeometryAcquireRequest
	/** The request's correlation identities, echoed on every report of the stream. */
	readonly context: StreamContext
	/** False until this stream sent its first (baseline) report. */
	reported: boolean
	dirty: boolean
	lastKey?: string
}

const MAX_RECORDED_FRAMES = 2048

/**
 * The runtime geometry producer of one runtime generation (Part 2, 2026-10-05 multi-target group).
 *
 * - One `geometry.acquire.request` opens a stream for one Widget. A new request for a Widget that
 *   already has a stream supersedes it at once; streams for different Widgets coexist up to the
 *   cap, and requests beyond the cap are ignored silently (decisions 3 and 6).
 * - After a baseline, a stream reports again only when its `rect` or `regions` really change,
 *   each time with the Widget's next geometry revision. Revisions are per Widget for the whole
 *   generation, so the first report of a superseding stream is still newer (decision 4, gate 5).
 * - Invalidations are coalesced: one recomputation per animation frame, dirty streams only, at
 *   most one report per stream per frame, and no frame is requested while nothing is dirty.
 * - `geometry.release` ends a stream; a release naming a superseded stream is ignored.
 * - A stream whose View or Variant is not the one rendered stays silent until the runtime renders
 *   that context; a context change ends every stream of the previous context without a release.
 */
export class RuntimeGeometryProducer {
	private readonly deps: GeometryProducerDependencies
	private readonly maxStreams: number
	private readonly streams = new Map<string, Stream>()
	private readonly revisions = new Map<string, number>()
	private context?: RuntimeGeometryContext
	private frameHandle?: number
	private continuous = false
	private disposed = false
	private frames = 0
	private reports = 0
	private readonly durations: number[] = []

	constructor(deps: GeometryProducerDependencies) {
		this.deps = deps
		this.maxStreams = deps.maxStreams ?? MAX_TRACKED_WIDGETS
		if (!Number.isSafeInteger(this.maxStreams) || this.maxStreams < 1) throw new RangeError('maxStreams must be a positive safe integer.')
	}

	/** Sets the View/Variant the runtime renders. Streams of a previous context end implicitly. */
	setContext(context: RuntimeGeometryContext): void {
		const previous = this.context
		this.context = Object.freeze({ viewId: context.viewId, ...(context.variantId ? { variantId: context.variantId } : {}) })
		if (previous && sameContext(previous, this.context)) return
		for (const [widgetId, stream] of this.streams) {
			if (previous && matchesContext(stream.request, previous) && !matchesContext(stream.request, this.context))
				this.streams.delete(widgetId)
			else stream.dirty = true
		}
		this.schedule()
	}

	receive(request: GeometryAcquireRequest | GeometryReleaseRequest): GeometryRequestOutcome {
		this.assertLive()
		const { widgetId, navigationRequestId } = request.context
		const current = this.streams.get(widgetId)
		if (request.type === 'geometry.release') {
			if (!current || current.request.context.navigationRequestId !== navigationRequestId) return 'ignored-unknown-stream'
			this.streams.delete(widgetId)
			return 'released'
		}
		if (!current && this.streams.size >= this.maxStreams) return 'ignored-over-cap'
		this.streams.set(widgetId, { request, context: streamContext(request), reported: false, dirty: true })
		this.schedule()
		return current ? 'superseded' : 'opened'
	}

	/** Marks every stream dirty (layout, scroll, mutation, font or state change). */
	invalidate(scope: GeometryInvalidation = 'all'): void {
		if (this.disposed) return
		if (scope === 'all') this.deps.measurer.invalidateStyles?.()
		let any = false
		for (const stream of this.streams.values()) {
			stream.dirty = true
			any = true
		}
		if (any) this.schedule()
	}

	/** Keeps recomputing every frame, e.g. while a transition or animation may move tracked Widgets. */
	setContinuous(active: boolean): void {
		if (this.disposed || this.continuous === active) return
		this.continuous = active
		if (active) this.invalidate()
	}

	trackedWidgetIds(): readonly string[] {
		return [...this.streams.keys()]
	}

	hasPendingFrame(): boolean {
		return this.frameHandle !== undefined
	}

	stats(): GeometryProducerStats {
		return Object.freeze({ frames: this.frames, reports: this.reports, frameDurations: Object.freeze([...this.durations]) })
	}

	resetStats(): void {
		this.frames = 0
		this.reports = 0
		this.durations.length = 0
	}

	dispose(): void {
		if (this.disposed) return
		this.disposed = true
		if (this.frameHandle !== undefined) this.deps.cancelFrame(this.frameHandle)
		this.frameHandle = undefined
		this.streams.clear()
	}

	/** Runs the pending recomputation now (tests and harnesses drive frames explicitly). */
	flush(): void {
		if (this.frameHandle !== undefined) {
			this.deps.cancelFrame(this.frameHandle)
			this.frameHandle = undefined
		}
		this.runFrame()
	}

	private schedule(): void {
		if (this.disposed || this.frameHandle !== undefined) return
		this.frameHandle = this.deps.requestFrame(() => {
			this.frameHandle = undefined
			this.runFrame()
		})
	}

	private runFrame(): void {
		if (this.disposed) return
		const now = this.deps.now
		const started = now?.()
		let measured = false
		for (const [widgetId, stream] of this.streams) {
			if (!stream.dirty) continue
			if (!this.context || !matchesContext(stream.request, this.context)) continue
			if (!measured) {
				this.deps.measurer.beginPass()
				measured = true
			}
			stream.dirty = false
			const geometry = this.deps.measurer.measure(widgetId)
			const key = geometryKey(geometry)
			if (stream.reported && key === stream.lastKey) continue
			const geometryRevision = (this.revisions.get(widgetId) ?? 0) + 1
			if (!Number.isSafeInteger(geometryRevision)) throw new RangeError('Geometry revision exhausted the JSON safe-integer range.')
			this.revisions.set(widgetId, geometryRevision)
			stream.reported = true
			stream.lastKey = key
			this.reports++
			this.deps.send({
				type: 'geometry.acquire.response',
				context: { ...stream.context, geometryRevision },
				payload: { rect: geometry.rect, regions: geometry.regions },
			})
		}
		if (measured) {
			this.deps.measurer.endPass()
			this.frames++
			if (started !== undefined && now) {
				this.durations.push(now() - started)
				if (this.durations.length > MAX_RECORDED_FRAMES) this.durations.shift()
			}
		}
		if (this.continuous) this.invalidate()
	}

	private assertLive(): void {
		if (this.disposed) throw new Error('RuntimeGeometryProducer is disposed.')
	}
}

type StreamContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	runtimeContextVersion?: number
	navigationRequestId?: string
	widgetId: string
}>

/** Canonical context keys of the request, omitting absent ones (absent is omitted, never undefined). */
function streamContext(request: GeometryAcquireRequest): StreamContext {
	const { previewSessionId, runtimeGenerationId, viewId, variantId, runtimeContextVersion, navigationRequestId, widgetId } = request.context
	return Object.freeze({
		previewSessionId,
		runtimeGenerationId,
		viewId,
		...(variantId !== undefined ? { variantId } : {}),
		...(runtimeContextVersion !== undefined ? { runtimeContextVersion } : {}),
		...(navigationRequestId !== undefined ? { navigationRequestId } : {}),
		widgetId,
	})
}

function matchesContext(request: GeometryAcquireRequest, context: RuntimeGeometryContext): boolean {
	return request.context.viewId === context.viewId && (request.context.variantId ?? undefined) === context.variantId
}

function sameContext(left: RuntimeGeometryContext, right: RuntimeGeometryContext): boolean {
	return left.viewId === right.viewId && left.variantId === right.variantId
}

/** Equality key of a report: a stream sends nothing while its `rect` and `regions` stay equal. */
function geometryKey(geometry: WidgetGeometry): string {
	const { rect, regions } = geometry
	let key = `${rect.x},${rect.y},${rect.width},${rect.height}`
	for (const region of regions) {
		key += `|${region.regionId}:${region.maxError}`
		for (const command of region.contour.commands) {
			switch (command.op) {
				case 'moveTo': key += `M${command.x},${command.y}`; break
				case 'lineTo': key += `L${command.x},${command.y}`; break
				case 'cubicBezierTo': key += `C${command.c1x},${command.c1y},${command.c2x},${command.c2y},${command.x},${command.y}`; break
				default: key += 'Z'
			}
		}
	}
	return key
}
