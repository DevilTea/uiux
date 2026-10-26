import {
	MAX_TRACKED_WIDGETS,
	type ContourCancel,
	type FullContourRequest,
	type FullContourResponse,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type GeometryReleaseRequest,
	type GeometryRevealRequest,
	type PartialContourRequest,
	type PartialContourResponse,
	type ProtocolContext,
	type RegionStatus,
	type VisibleRegion,
	type WidgetRect,
} from './protocol/schema'

/** One Widget's complete geometry at one instant, in inner content-viewport CSS px. */
export type WidgetGeometry = Readonly<{
	rect: WidgetRect
	regions: readonly VisibleRegion[]
	/**
	 * What the report says about its regions, for a runtime that declares `geometry.region-status`:
	 * absent when neither `translucent` nor `unavailable` applies (Clause 01a11a59-dbda-79e5-9337-307bb9c1798b).
	 */
	regionStatus?: RegionStatus
}>

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
	/**
	 * Measures the Widget as `measure` does, but with every curved contour approximated to at most
	 * `targetMaxError` inner CSS px, when it can. Without it the runtime answers no contour work.
	 */
	measureAt?(widgetId: string, targetMaxError: number): WidgetGeometry
}>

/** Contour work that the runtime failed for good, which it reports as a work-scoped `failure.report`. */
export type ContourWorkFailure = Readonly<{
	context: ProtocolContext & Readonly<{ geometryRevision: number }>
	sequence: number
	baseSnapshotVersion?: number
	reason: string
	detail?: string
}>

export type ContourRequestMessage = FullContourRequest | PartialContourRequest | ContourCancel

/** `layout`: only positions may have changed (scroll). `all`: styles or the DOM may have changed too. */
export type GeometryInvalidation = 'layout' | 'all'

/** The runtime context the Preview currently renders; streams for another context never report. */
export type RuntimeGeometryContext = Readonly<{ viewId: string; variantId?: string }>

export type GeometryProducerDependencies = Readonly<{
	/** Sends one validated report through the runtime protocol bridge (gates included). */
	send(response: GeometryAcquireResponse): void
	/** Sends one contour response through the bridge. Without it the runtime answers no contour work. */
	sendContour?(response: FullContourResponse | PartialContourResponse): void
	/** Reports contour work that failed for good; that work ends without a response. */
	reportWorkFailure?(failure: ContourWorkFailure): void
	measurer: WidgetMeasurer
	/**
	 * Scrolls the Preview document to the Widget when a reveal applies to it (see `reveal.ts`) and says
	 * whether anything moved. Without it the runtime does not support `geometry.reveal`.
	 */
	reveal?(widgetId: string): boolean
	/**
	 * Whether the document has rendered what it shows and can tell if a Widget has a rendered box. Until
	 * then a reveal waits (see `releaseDeferredReveals`); without this dependency it never waits.
	 */
	revealReady?(): boolean
	requestFrame(callback: () => void): number
	cancelFrame(handle: number): void
	/** Monotonic clock for the optional per-frame work statistics. */
	now?: () => number
	/**
	 * Whether the runtime declares `geometry.region-status`. Without it no report carries a `regionStatus`,
	 * whatever the measurer found (Clause 01a11a59-dbda-79e5-9337-307bb9c1798b).
	 */
	regionStatus?: boolean
	/** Streams supported at once. A runtime declaring `geometry.multi-target` supports at least 64. */
	maxStreams?: number
}>

export type GeometryRequestOutcome =
	| 'opened'
	| 'superseded'
	| 'released'
	| 'ignored-over-cap'
	| 'ignored-unknown-stream'

/**
 * `revealed`: the Preview scrolled. `no-op`: the reveal named an open stream but did not apply to its
 * Widget. `deferred`: the document had not rendered yet, so the reveal waits for it.
 */
export type RevealRequestOutcome = 'revealed' | 'no-op' | 'deferred' | 'ignored-stale' | 'ignored-unsupported'

export type ContourRequestOutcome = 'queued' | 'canceled' | 'ignored-stale' | 'ignored-unsupported'

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
	/** What the stream's latest report said, and the geometry revision it carried. */
	lastGeometry?: WidgetGeometry
	reportedRevision?: number
	/**
	 * The finest contour precision that a refinement asked for when its answer could not keep the
	 * reported regions: the stream then reports a new geometry revision at that precision itself.
	 */
	target?: number
	/** Report even when the geometry key is unchanged. */
	force?: boolean
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
	/** The contour work waiting for the next frame: at most one per Widget, the newest request. */
	private readonly jobs = new Map<string, ContourJob>()
	/** The newest reveal per Widget that arrived before the document could answer it. */
	private readonly deferredReveals = new Map<string, GeometryRevealRequest>()
	/** The newest contour-work sequence seen per Widget: an older or repeated one is ignored. */
	private readonly lastSequences = new Map<string, Readonly<{ geometryRevision: number; sequence: number }>>()
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

	/**
	 * One `geometry.reveal` (Clauses 01a11a59-d8be-78aa-bdc7-28aa62bd9444, 01a11a59-da48-7437-bee8-67787175cbda
	 * and 01a11a70-3d8d-7e52-9412-8a92797814e6): a one-way command on an open stream. It is stale, and ignored,
	 * unless it names the open stream of its Widget in the render context that stream was acquired for. There is
	 * no reply: a scroll that moved the Widget reaches the Workbench only as the stream's next report.
	 */
	receiveReveal(request: GeometryRevealRequest): RevealRequestOutcome {
		this.assertLive()
		const outcome = this.applyReveal(request, true)
		if (outcome === 'deferred') this.deferredReveals.set(request.context.widgetId, request)
		return outcome
	}

	/**
	 * Applies the reveals that arrived before the document could answer (`revealReady`): the Workbench
	 * asks right after it opens the stream of a navigation, and a freshly loaded document has not
	 * rendered its View yet. Each is judged as on arrival, against the stream that is open now: one whose
	 * stream ended or was superseded meanwhile is stale. A reveal waits for the document's first
	 * settling only; after it, a Widget that is still not rendered gets nothing, as on any reveal.
	 */
	releaseDeferredReveals(): void {
		if (this.disposed || this.deferredReveals.size === 0) return
		if (this.deps.revealReady && !this.deps.revealReady()) return
		const requests = [...this.deferredReveals.values()]
		this.deferredReveals.clear()
		for (const request of requests) this.applyReveal(request, false)
	}

	private applyReveal(request: GeometryRevealRequest, mayDefer: boolean): RevealRequestOutcome {
		const { widgetId, navigationRequestId } = request.context
		const stream = this.streams.get(widgetId)
		if (!stream || stream.request.context.navigationRequestId !== navigationRequestId) return 'ignored-stale'
		const acquired = stream.context
		if (request.context.viewId !== acquired.viewId || request.context.variantId !== acquired.variantId
			|| request.context.runtimeContextVersion !== acquired.runtimeContextVersion) return 'ignored-stale'
		if (!this.context || !matchesContext(stream.request, this.context)) return 'ignored-stale'
		if (!this.deps.reveal) return 'ignored-unsupported'
		if (mayDefer && this.deps.revealReady && !this.deps.revealReady()) return 'deferred'
		if (!this.deps.reveal(widgetId)) return 'no-op'
		// Scroll signals reach the producer too, in a later task; this one need not wait for them.
		this.invalidate('layout')
		return 'revealed'
	}

	/**
	 * One contour request or cancellation of the Workbench (Clauses 01a11687-3d25-7a87-a3a9-bc5e0353be63,
	 * 01a11687-3d6e-79e8-8f1f-7934ece17ed6 and 01a11687-403f-78cb-b625-b6e56d35ead0). A request is
	 * answered in a frame after the stream's own pending report: it is current only while it names the
	 * stream's Widget, render context and latest reported geometry revision, and a newer request of the
	 * Widget replaces an older one still waiting. `contour.cancel` drops matching waiting work only;
	 * it never fails, and a response the work already sent is the Workbench's to reject.
	 */
	receiveContour(request: ContourRequestMessage): ContourRequestOutcome {
		this.assertLive()
		const { widgetId } = request.context
		if (request.type === 'contour.cancel') {
			const job = this.jobs.get(widgetId)
			if (!job || job.request.payload.sequence !== request.payload.sequence
				|| job.request.context.geometryRevision !== request.context.geometryRevision) return 'ignored-stale'
			this.jobs.delete(widgetId)
			return 'canceled'
		}
		if (!this.deps.measurer.measureAt || !this.deps.sendContour) return 'ignored-unsupported'
		const stream = this.streams.get(widgetId)
		if (!stream || !this.currentFor(stream, request.context)) return 'ignored-stale'
		// Sequences of one Widget and geometry revision only increase; a new revision starts a new domain.
		const last = this.lastSequences.get(widgetId)
		if (last && last.geometryRevision === request.context.geometryRevision && request.payload.sequence <= last.sequence) return 'ignored-stale'
		this.lastSequences.set(widgetId, { geometryRevision: request.context.geometryRevision, sequence: request.payload.sequence })
		this.jobs.set(widgetId, { request })
		// A request for coarser contours than the stream was held to means the finer need has ended: the stream
		// goes back to its default precision, and reports it when that differs.
		if (stream.target !== undefined && request.payload.targetMaxError > stream.target) {
			stream.target = undefined
			stream.force = true
		}
		// Re-measure first: a change that is not reported yet makes this revision, and the work, stale.
		stream.dirty = true
		this.schedule()
		return 'queued'
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
		this.deferredReveals.clear()
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
			const geometry = stream.target !== undefined && this.deps.measurer.measureAt
				? this.deps.measurer.measureAt(widgetId, stream.target)
				: this.deps.measurer.measure(widgetId)
			const key = geometryKey(geometry, this.deps.regionStatus === true)
			const forced = stream.force === true
			stream.force = false
			if (stream.reported && key === stream.lastKey && !forced) continue
			const geometryRevision = (this.revisions.get(widgetId) ?? 0) + 1
			if (!Number.isSafeInteger(geometryRevision)) throw new RangeError('Geometry revision exhausted the JSON safe-integer range.')
			this.revisions.set(widgetId, geometryRevision)
			stream.reported = true
			stream.lastKey = key
			stream.lastGeometry = geometry
			stream.reportedRevision = geometryRevision
			this.reports++
			this.deps.send({
				type: 'geometry.acquire.response',
				context: { ...stream.context, geometryRevision },
				payload: {
					rect: geometry.rect,
					regions: geometry.regions,
					...(this.deps.regionStatus && geometry.regionStatus ? { regionStatus: geometry.regionStatus } : {}),
				},
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
		this.runContourJobs()
		if (this.continuous) this.invalidate()
	}

	/**
	 * Answers the queued contour work, after this frame's reports: work for a geometry revision that
	 * a report just replaced is stale and ends here without a response.
	 */
	private runContourJobs(): void {
		if (this.jobs.size === 0) return
		const jobs = [...this.jobs]
		this.jobs.clear()
		let measured = false
		for (const [widgetId, job] of jobs) {
			const stream = this.streams.get(widgetId)
			const request = job.request
			if (!stream || !this.currentFor(stream, request.context)) continue
			const measurer = this.deps.measurer
			if (!measurer.measureAt || !this.deps.sendContour || !stream.lastGeometry) continue
			if (!measured) {
				measurer.beginPass()
				measured = true
			}
			const target = request.payload.targetMaxError
			let refined: WidgetGeometry
			try {
				refined = measurer.measureAt(widgetId, target)
			}
			catch (cause) {
				this.deps.reportWorkFailure?.({
					context: { ...workContext(stream, request.context.geometryRevision) },
					sequence: request.payload.sequence,
					...(request.type === 'contour.partial.request' ? { baseSnapshotVersion: request.payload.baseSnapshotVersion } : {}),
					// No new reason code (Discussion #131 decision 10): with work-scope correlation,
					// `runtime.unavailable` means that this refinement is permanently unavailable.
					reason: 'runtime.unavailable',
					detail: cause instanceof Error ? cause.name : 'Error',
				})
				continue
			}
			const reported = stream.lastGeometry
			// An approximation too coarse to bound (a curve beyond the work caps) leaves no region at all:
			// the runtime then answers with what it reported, which the Workbench judges a precision miss.
			if (refined.regions.length === 0 && reported.regions.length > 0) refined = reported
			else if (!regionsCorrespond(reported, refined)) {
				// The regions no longer correspond: a new geometry revision at this precision, never renamed regions.
				stream.target = Math.min(stream.target ?? Number.POSITIVE_INFINITY, target)
				stream.force = true
				stream.dirty = true
				this.schedule()
				continue
			}
			const context = { ...workContext(stream, request.context.geometryRevision) }
			if (request.type === 'contour.full.request') {
				this.deps.sendContour({ type: 'contour.full.response', context, payload: { sequence: request.payload.sequence, regions: refined.regions } })
			}
			else {
				const ids = new Set(request.payload.regionIds)
				this.deps.sendContour({
					type: 'contour.partial.response',
					context,
					payload: {
						sequence: request.payload.sequence,
						baseSnapshotVersion: request.payload.baseSnapshotVersion,
						regions: refined.regions.filter(region => ids.has(region.regionId)),
					},
				})
			}
		}
		if (measured) this.deps.measurer.endPass()
	}

	/** Whether the request names this stream's Widget, render context and latest reported geometry revision. */
	private currentFor(stream: Stream, context: ProtocolContext & Readonly<{ geometryRevision: number }>): boolean {
		return stream.reported
			&& stream.reportedRevision === context.geometryRevision
			&& context.viewId === stream.context.viewId
			&& context.variantId === stream.context.variantId
			&& context.runtimeContextVersion === stream.context.runtimeContextVersion
			&& !!this.context && matchesContext(stream.request, this.context)
	}

	private assertLive(): void {
		if (this.disposed) throw new Error('RuntimeGeometryProducer is disposed.')
	}
}

type ContourJob = Readonly<{ request: FullContourRequest | PartialContourRequest }>

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

/** The context of a contour response or work failure: the stream's, without its identity, at one revision. */
function workContext(stream: Stream, geometryRevision: number): ProtocolContext & Readonly<{ geometryRevision: number }> {
	const { previewSessionId, runtimeGenerationId, viewId, variantId, runtimeContextVersion, widgetId } = stream.context
	return {
		previewSessionId,
		runtimeGenerationId,
		viewId,
		...(variantId !== undefined ? { variantId } : {}),
		...(runtimeContextVersion !== undefined ? { runtimeContextVersion } : {}),
		widgetId,
		geometryRevision,
	}
}

const CORRESPONDENCE_EPSILON = 1e-6

/**
 * Whether a finer measurement still holds the reported regions: the same region IDs, each with a
 * bounding box that can differ only by both approximations' error bounds. Region IDs are never
 * renamed to fit, so anything else makes a new geometry revision.
 */
function regionsCorrespond(reported: WidgetGeometry, refined: WidgetGeometry): boolean {
	if (reported.regions.length !== refined.regions.length) return false
	for (const [index, before] of reported.regions.entries()) {
		const after = refined.regions[index]!
		if (before.regionId !== after.regionId) return false
		const allowance = before.maxError + after.maxError + CORRESPONDENCE_EPSILON
		const a = regionBounds(before)
		const b = regionBounds(after)
		if (!a || !b) return false
		if (Math.abs(a.left - b.left) > allowance || Math.abs(a.top - b.top) > allowance
			|| Math.abs(a.right - b.right) > allowance || Math.abs(a.bottom - b.bottom) > allowance) return false
	}
	return true
}

function regionBounds(region: VisibleRegion): Readonly<{ left: number; top: number; right: number; bottom: number }> | undefined {
	let left = Number.POSITIVE_INFINITY
	let top = Number.POSITIVE_INFINITY
	let right = Number.NEGATIVE_INFINITY
	let bottom = Number.NEGATIVE_INFINITY
	for (const command of region.contour.commands) {
		if (command.op === 'close') continue
		left = Math.min(left, command.x)
		top = Math.min(top, command.y)
		right = Math.max(right, command.x)
		bottom = Math.max(bottom, command.y)
	}
	return Number.isFinite(left) ? { left, top, right, bottom } : undefined
}

function matchesContext(request: GeometryAcquireRequest, context: RuntimeGeometryContext): boolean {
	return request.context.viewId === context.viewId && (request.context.variantId ?? undefined) === context.variantId
}

function sameContext(left: RuntimeGeometryContext, right: RuntimeGeometryContext): boolean {
	return left.viewId === right.viewId && left.variantId === right.variantId
}

/** Equality key of a report: a stream sends nothing while its `rect`, `regions` and `regionStatus` stay equal. */
function geometryKey(geometry: WidgetGeometry, withStatus: boolean): string {
	const { rect, regions } = geometry
	let key = `${rect.x},${rect.y},${rect.width},${rect.height}${withStatus && geometry.regionStatus ? `#${geometry.regionStatus}` : ''}`
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
