import type { GeometryReport, GeometryStreamContext } from './geometry-streams'
import { affineAmplificationUpperBound, evaluateSnapshotPrecision, type OuterErrorMapping, type SnapshotPrecisionEvaluation } from './outer-precision'
import { ContourCacheController } from './protocol/contour-cache'
import type { FailureReportMessage } from './protocol/failure-report'
import type {
	ContourCancel,
	FullContourRequest,
	FullContourResponse,
	PartialContourRequest,
	PartialContourResponse,
	VisibleRegion,
	WidgetRect,
} from './protocol/schema'

/**
 * The Workbench side of contour precision and refinement for the one Widget whose precise highlight
 * is shown (Rules 01a11687-32da-7ea6-83aa-d7451aaf0111, 01a11687-331e-7b04-98ad-f9f949eebd65 and the
 * refinement rules of 01a111e4-0258-7bd1-805a-b270040f08ba and 01a111e4-0265-770f-b7f7-4c49074711fd;
 * the wire is the Preview protocol Contract's contour Clauses).
 *
 * It owns one `ContourCacheController` (the complete cache of the Widget's geometry revision), judges
 * the cache against the display tolerance under the current outer mapping, and drives the work:
 *
 * - A cache that meets the tolerance draws; one that misses it hides the whole highlight and asks for
 *   finer contours of only the failing regions (`contour.partial.request`) for the unchanged
 *   geometry. A scale that needs finer contours than the work in flight supersedes it (the older
 *   sequence is canceled, best effort); a scale-down that the cache already meets retires and cancels it.
 * - A response that is rejected (a precision miss, a missing, duplicated or invalid region result, a
 *   base that is no longer the cache) is a recoverable failure: the first of a partial refinement is
 *   retried at once with the full original region set, then a complete regeneration follows. A
 *   regeneration that fails leaves the highlight unavailable for that precision until the geometry
 *   changes.
 * - A work-scoped `failure.report` that names the work in flight is a non-recoverable refinement
 *   failure: that work ends, nothing starts again within the same geometry revision, and no
 *   regeneration follows. Scale changes alone never clear it; a new geometry revision, another
 *   context or another generation does (a new revision advances `geometryRevision`; a context or
 *   generation change drops this state).
 *
 * Contour messages carry the Widget and its geometry revision, never the stream identity
 * (Clause 01a11687-3d25-7a87-a3a9-bc5e0353be63). Sequences come from one counter per generation, so
 * they only ever increase and never repeat, within every Widget and geometry revision.
 */

export type ContourRefinementDependencies = Readonly<{
	/** Sends one contour request; false when it did not leave (the generation is not open). */
	send(message: FullContourRequest | PartialContourRequest | ContourCancel): boolean
	/**
	 * Animation frames, so that a mapping that changes every frame (a zoom) asks for finer contours only
	 * once it has held still for a frame. Without it, every change is judged at once.
	 */
	requestFrame?(callback: () => void): number
	cancelFrame?(handle: number): void
}>

export type HighlightUnavailableReason = 'latched' | 'exhausted' | 'unproven-mapping' | 'invalid-mapping'

/**
 * What the Workbench may draw of the Widget's contours now: `precise` carries the regions of the
 * cache, which meet the display tolerance; `pending` draws nothing while the mapping or finer
 * contours are awaited; `unavailable` draws nothing and says that precise highlighting is unavailable.
 */
export type HighlightPrecision =
	| Readonly<{ status: 'none' }>
	| Readonly<{ status: 'pending' }>
	| Readonly<{ status: 'precise'; geometryRevision: number; regions: readonly VisibleRegion[]; maxFinalError: number }>
	| Readonly<{ status: 'unavailable'; reason: HighlightUnavailableReason; bounds?: WidgetRect }>

export type RefinementResponseOutcome = 'committed' | 'stale' | 'rejected'
export type RefinementFailureOutcome = 'ended' | 'stale'

type Work = Readonly<{
	kind: 'full' | 'partial'
	sequence: number
	geometryRevision: number
	targetMaxError: number
	/** A partial request's region set; empty for a complete regeneration. */
	regionIds: readonly string[]
	baseSnapshotVersion?: number
	/** This partial refinement is the one immediate retry of a failed one. */
	retry: boolean
}>

/**
 * A refinement that failed for good: no new refinement starts within its geometry revision. It is kept
 * per Widget across demand changes, so that deselecting and selecting again, or toggling Comment mode,
 * does not end it for geometry that did not change (Rule 01a11687-3650-7490-a7ec-80b2570582f6).
 */
type Latch = Readonly<{ revision: number; key: string; report: FailureReportMessage }>

type Entry = {
	readonly widgetId: string
	readonly controller: ContourCacheController
	work?: Work
	/** A complete regeneration for this target failed within the revision: nothing finer is asked for. */
	exhausted?: Readonly<{ geometryRevision: number; targetMaxError: number }>
}

export class ContourRefinement {
	private readonly deps: ContourRefinementDependencies
	private context?: GeometryStreamContext
	private mapping?: OuterErrorMapping
	private demand?: string
	private entry?: Entry
	private readonly latches = new Map<string, Latch>()
	private visible = true
	private frame?: number
	private mappingChanged = false
	private memo?: Readonly<{ regions: readonly VisibleRegion[]; mapping: OuterErrorMapping; result: SnapshotPrecisionEvaluation }>
	private sequence = 0
	private readonly listeners = new Set<() => void>()
	private readonly latchListeners = new Set<(report: FailureReportMessage | undefined) => void>()

	constructor(deps: ContourRefinementDependencies) {
		this.deps = deps
	}

	/**
	 * The runtime context: a different View, Variant, runtime context or generation drops the cache,
	 * the work (canceled while its generation is still the current one) and the latch.
	 */
	setContext(next: GeometryStreamContext | undefined): void {
		if (sameContext(this.context, next)) return
		const generationChanged = this.context?.previewSessionId !== next?.previewSessionId
			|| this.context?.runtimeGenerationId !== next?.runtimeGenerationId
		this.dropEntry(!generationChanged)
		// Another context or generation ends every latch.
		if (this.latches.size) {
			this.latches.clear()
			this.emitLatch()
		}
		this.context = next ? Object.freeze({ ...next }) : undefined
		if (generationChanged) this.sequence = 0
		this.openEntry()
		this.publish()
	}

	/** The Widget whose precise highlight is wanted; `undefined` when none is. Another Widget retires the work. */
	setDemand(widgetId: string | undefined): void {
		if (this.demand === widgetId) return
		this.dropEntry(true)
		this.demand = widgetId
		this.openEntry()
		this.publish()
	}

	/** The current outer mapping of the Preview, or `undefined` while it cannot be measured. */
	setMapping(next: OuterErrorMapping | undefined): void {
		const settled = settleMapping(this.mapping, next)
		if (settled === this.mapping) return
		this.mapping = settled
		if (this.deps.requestFrame) {
			// Pending work that the new scale makes unnecessary is retired now; finer contours are asked for
			// once the mapping has held still for a frame.
			this.evaluate(true)
			this.mappingChanged = true
			this.scheduleSettle()
		}
		else this.evaluate()
		this.publish()
	}

	/** Whether the demanded Widget is visible in the Preview: an offscreen or hidden one asks for no contour work. */
	setVisible(visible: boolean): void {
		if (this.visible === visible) return
		this.visible = visible
		this.evaluate()
		this.publish()
	}

	/** An accepted geometry report of the demanded Widget's stream: its complete baseline cache. */
	acceptReport(report: GeometryReport): void {
		const entry = this.entry
		const context = this.context
		if (!entry || !context || report.widgetId !== entry.widgetId) return
		if (!entry.controller.isStreamOpen()) entry.controller.beginAcquisition()
		const result = entry.controller.commitAcquisition({
			type: 'geometry.acquire.response',
			context: { ...this.scope(entry), geometryRevision: report.geometryRevision },
			payload: { rect: report.rect, regions: report.regions },
		})
		if (result.status !== 'committed') return
		// Work for the superseded revision is void; the runtime may still stop it.
		if (entry.work) this.cancel(entry, entry.work)
		entry.work = undefined
		entry.exhausted = undefined
		// A newer geometry revision ends the latch unless the geometry is the same: a reopened stream
		// reports its baseline under a new revision even when nothing moved.
		const latch = this.latches.get(entry.widgetId)
		if (latch && report.geometryRevision > latch.revision) {
			if (geometryKey(report) === latch.key) this.latches.set(entry.widgetId, { ...latch, revision: report.geometryRevision })
			else this.clearLatch(entry)
		}
		this.evaluate()
		this.publish()
	}

	/** The Widget's report is gone (released, superseded, hidden at a resize): the cache and the work end with it. */
	dropReport(widgetId: string): void {
		const entry = this.entry
		if (!entry || entry.widgetId !== widgetId) return
		if (entry.work) this.cancel(entry, entry.work)
		entry.work = undefined
		entry.exhausted = undefined
		entry.controller.endAcquisition()
		this.publish()
	}

	/** A `contour.full.response` or `contour.partial.response` that passed the bridge's gates. */
	receiveResponse(message: FullContourResponse | PartialContourResponse): RefinementResponseOutcome {
		const entry = this.entry
		if (!entry || !entry.work || message.context.widgetId !== entry.widgetId) return 'stale'
		const work = entry.work
		const result = message.type === 'contour.full.response' ? entry.controller.commitFull(message) : entry.controller.commitPartial(message)
		switch (result.status) {
			case 'stale':
			case 'wrong-work-kind':
				return 'stale'
			case 'committed':
				entry.work = undefined
				entry.exhausted = undefined
				this.evaluate()
				this.publish()
				return 'committed'
			default:
				// Rejected whole: a precision miss, an invalid, missing or duplicated region result, a base that
				// is no longer the cache, regions that no longer match by identity.
				entry.work = undefined
				this.recover(entry, work)
				this.publish()
				return 'rejected'
		}
	}

	/**
	 * A work-scoped `failure.report` (Clause 01a11a59-def9-797a-8d08-5e4b02ecd900). When it names the
	 * work in flight, that work ends without a response as a non-recoverable refinement failure and
	 * latches refinement for the geometry revision; a report for any other work is stale.
	 */
	receiveFailureReport(message: FailureReportMessage): RefinementFailureOutcome {
		const entry = this.entry
		const context = this.context
		const work = entry?.work
		if (!entry || !context || !work) return 'stale'
		const reported = message.context
		if (reported.widgetId !== entry.widgetId
			|| reported.viewId !== context.viewId
			|| reported.variantId !== context.variantId
			|| reported.runtimeContextVersion !== context.runtimeContextVersion
			|| reported.geometryRevision !== work.geometryRevision
			|| message.payload.sequence !== work.sequence
			|| message.payload.baseSnapshotVersion !== work.baseSnapshotVersion) return 'stale'
		entry.controller.endWork(work.sequence)
		entry.work = undefined
		const snapshot = entry.controller.currentSnapshot()
		this.latches.set(entry.widgetId, { revision: work.geometryRevision, key: snapshot ? geometryKey(snapshot) : '', report: message })
		this.emitLatch()
		this.publish()
		return 'ended'
	}

	/** What may be drawn of the demanded Widget now. */
	precision(widgetId: string, options?: Readonly<{ mapping: OuterErrorMapping | undefined }>): HighlightPrecision {
		const entry = this.entry
		if (!entry || entry.widgetId !== widgetId) return NONE
		const snapshot = entry.controller.currentSnapshot()
		if (!snapshot) return NONE
		// The verdict can be asked for under the mapping the caller draws with, so that no frame draws
		// against the verdict of an older one.
		const mapping = options ? options.mapping : this.mapping
		if (!mapping) return PENDING
		const evaluation = this.judge(snapshot.regions, mapping)
		switch (evaluation.status) {
			case 'empty':
				return NONE
			case 'eligible':
				return Object.freeze({ status: 'precise', geometryRevision: snapshot.geometryRevision, regions: snapshot.regions, maxFinalError: evaluation.maxFinalError })
			case 'precision-unavailable':
				return unavailable(evaluation.reason === 'unproven-non-affine' ? 'unproven-mapping' : 'invalid-mapping', snapshot.regions)
			case 'refinement-required':
				if (this.latches.get(entry.widgetId)?.revision === snapshot.geometryRevision) return unavailable('latched', snapshot.regions)
				if (entry.exhausted?.geometryRevision === snapshot.geometryRevision && evaluation.targetInnerMaxError <= entry.exhausted.targetMaxError)
					return unavailable('exhausted', snapshot.regions)
				return PENDING
		}
	}

	/** The contour work in flight and the latch, for diagnostics and tests. */
	state(): Readonly<{ work?: Work; latchedRevision?: number }> {
		const entry = this.entry
		const latch = entry ? this.latches.get(entry.widgetId) : undefined
		return Object.freeze({
			...(entry?.work ? { work: entry.work } : {}),
			...(latch ? { latchedRevision: latch.revision } : {}),
		})
	}

	/** Called after every change of what may be drawn or of the work. */
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener)
		return () => { this.listeners.delete(listener) }
	}

	/** Called with the work-scoped report that latched refinement, and with `undefined` when the latch ends. */
	subscribeLatch(listener: (report: FailureReportMessage | undefined) => void): () => void {
		this.latchListeners.add(listener)
		return () => { this.latchListeners.delete(listener) }
	}

	dispose(): void {
		if (this.frame !== undefined) this.deps.cancelFrame?.(this.frame)
		this.frame = undefined
		this.dropEntry(true)
		this.latches.clear()
		this.listeners.clear()
		this.latchListeners.clear()
		this.context = undefined
		this.demand = undefined
	}

	private openEntry(): void {
		if (!this.context || !this.demand) return
		const widgetId = this.demand
		const scope = this.scopeOf(widgetId)
		this.entry = {
			widgetId,
			controller: new ContourCacheController(scope, previous => (previous ?? 0) + 1),
		}
	}

	private dropEntry(cancelWork: boolean): void {
		const entry = this.entry
		if (!entry) return
		if (cancelWork && entry.work) this.cancel(entry, entry.work)
		this.entry = undefined
	}

	private clearLatch(entry: Entry): void {
		this.latches.delete(entry.widgetId)
		this.emitLatch()
	}

	/** Tells the latch listeners the latest latch's report, or that none remains. */
	private emitLatch(): void {
		const latest = [...this.latches.values()].at(-1)
		for (const listener of this.latchListeners) listener(latest?.report)
	}

	/** The evaluation of the cache's regions under a mapping, kept while neither changes. */
	private judge(regions: readonly VisibleRegion[], mapping: OuterErrorMapping): SnapshotPrecisionEvaluation {
		const memo = this.memo
		if (memo && memo.regions === regions && memo.mapping === mapping) return memo.result
		const result = evaluateSnapshotPrecision(regions, mapping)
		this.memo = { regions, mapping, result }
		return result
	}

	private scheduleSettle(): void {
		if (this.frame !== undefined || !this.deps.requestFrame) return
		this.frame = this.deps.requestFrame(() => {
			this.frame = undefined
			if (this.mappingChanged) {
				this.mappingChanged = false
				this.scheduleSettle()
				return
			}
			this.evaluate()
			this.publish()
		})
	}

	private scopeOf(widgetId: string) {
		const context = this.context!
		return {
			previewSessionId: context.previewSessionId,
			runtimeGenerationId: context.runtimeGenerationId,
			viewId: context.viewId,
			...(context.variantId !== undefined ? { variantId: context.variantId } : {}),
			...(context.runtimeContextVersion !== undefined ? { runtimeContextVersion: context.runtimeContextVersion } : {}),
			widgetId,
		}
	}

	private scope(entry: Entry) {
		return this.scopeOf(entry.widgetId)
	}

	/** Judges the cache against the display tolerance and starts, keeps or retires the work accordingly. */
	private evaluate(deferRefinement = false): void {
		const entry = this.entry
		if (!entry || !this.mapping) return
		const snapshot = entry.controller.currentSnapshot()
		if (!snapshot) return
		const evaluation = this.judge(snapshot.regions, this.mapping)
		switch (evaluation.status) {
			case 'empty':
			case 'eligible':
			case 'precision-unavailable':
				// The cache already meets the tolerance (or no finer contour can be judged): pending work is
				// unnecessary, and nothing is sent for the restored highlight.
				this.retire(entry)
				return
			case 'refinement-required':
				// An offscreen or hidden Widget draws no highlight, so nothing finer is asked for.
				if (!this.visible) {
					this.retire(entry)
					return
				}
				if (!deferRefinement) this.refine(entry, snapshot.geometryRevision, snapshot.snapshotVersion, evaluation)
		}
	}

	private refine(
		entry: Entry,
		geometryRevision: number,
		baseSnapshotVersion: number,
		evaluation: Extract<SnapshotPrecisionEvaluation, { status: 'refinement-required' }>,
	): void {
		// A failed refinement stops every further one within the revision, whatever the scale does.
		if (this.latches.get(entry.widgetId)?.revision === geometryRevision) return
		const target = evaluation.targetInnerMaxError
		// The work in flight asks for contours at least this fine: it is awaited, not repeated.
		if (entry.work && entry.work.targetMaxError <= target) return
		if (entry.exhausted?.geometryRevision === geometryRevision && target <= entry.exhausted.targetMaxError) return
		if (this.startPartial(entry, evaluation.regionIds, baseSnapshotVersion, target, false)) return
		this.startFull(entry, geometryRevision, target)
	}

	/** One immediate retry of a failed partial refinement, then a complete regeneration, then nothing more. */
	private recover(entry: Entry, failed: Work): void {
		const snapshot = entry.controller.currentSnapshot()
		if (!snapshot || !this.mapping) return
		const evaluation = this.judge(snapshot.regions, this.mapping)
		if (evaluation.status !== 'refinement-required' || !this.visible) return
		if (this.latches.get(entry.widgetId)?.revision === snapshot.geometryRevision) return
		const target = evaluation.targetInnerMaxError
		if (failed.kind === 'full') {
			entry.exhausted = { geometryRevision: failed.geometryRevision, targetMaxError: failed.targetMaxError }
			return
		}
		const baseCurrent = snapshot.geometryRevision === failed.geometryRevision && snapshot.snapshotVersion === failed.baseSnapshotVersion
		if (!failed.retry && baseCurrent && this.startPartial(entry, failed.regionIds, snapshot.snapshotVersion, target, true)) return
		this.startFull(entry, snapshot.geometryRevision, target)
	}

	private startPartial(entry: Entry, regionIds: readonly string[], baseSnapshotVersion: number, targetMaxError: number, retry: boolean): boolean {
		const snapshot = entry.controller.currentSnapshot()
		if (!snapshot || regionIds.length === 0) return false
		const sequence = this.nextSequence()
		const request: PartialContourRequest = {
			type: 'contour.partial.request',
			context: { ...this.scope(entry), geometryRevision: snapshot.geometryRevision },
			payload: { sequence, baseSnapshotVersion, regionIds: [...regionIds], targetMaxError },
		}
		const previous = entry.work
		const started = entry.controller.startPartial(request)
		if (started.status !== 'started') return false
		return this.dispatch(entry, request, previous, {
			kind: 'partial', sequence, geometryRevision: snapshot.geometryRevision, targetMaxError, regionIds: Object.freeze([...regionIds]), baseSnapshotVersion, retry,
		})
	}

	private startFull(entry: Entry, geometryRevision: number, targetMaxError: number): boolean {
		const sequence = this.nextSequence()
		const request: FullContourRequest = {
			type: 'contour.full.request',
			context: { ...this.scope(entry), geometryRevision },
			payload: { sequence, targetMaxError },
		}
		const previous = entry.work
		const started = entry.controller.startFull(request)
		if (started.status !== 'started') return false
		return this.dispatch(entry, request, previous, {
			kind: 'full', sequence, geometryRevision, targetMaxError, regionIds: Object.freeze([]), retry: false,
		})
	}

	/** Cancels the work the new one supersedes, sends the request and records it; rolls back when it cannot leave. */
	private dispatch(entry: Entry, request: FullContourRequest | PartialContourRequest, previous: Work | undefined, work: Work): boolean {
		if (previous) this.cancel(entry, previous)
		if (!this.deps.send(request)) {
			entry.controller.endWork(work.sequence)
			entry.work = undefined
			return false
		}
		entry.work = work
		return true
	}

	private retire(entry: Entry): void {
		const work = entry.work
		if (!work) return
		entry.controller.endWork(work.sequence)
		entry.work = undefined
		this.cancel(entry, work)
	}

	/** `contour.cancel` is one-way, unacknowledged and best effort: nothing waits for it, and its loss is no failure. */
	private cancel(entry: Entry, work: Work): void {
		this.deps.send({
			type: 'contour.cancel',
			context: { ...this.scope(entry), geometryRevision: work.geometryRevision },
			payload: { sequence: work.sequence },
		})
	}

	private nextSequence(): number {
		if (this.sequence >= Number.MAX_SAFE_INTEGER) throw new RangeError('Contour-work sequence exhausted the JSON safe-integer range.')
		this.sequence++
		return this.sequence
	}

	private publish(): void {
		for (const listener of this.listeners) listener()
	}
}

const NONE: HighlightPrecision = Object.freeze({ status: 'none' })
const PENDING: HighlightPrecision = Object.freeze({ status: 'pending' })

function unavailable(reason: HighlightUnavailableReason, regions: readonly VisibleRegion[]): HighlightPrecision {
	const bounds = aggregateBounds(regions)
	return Object.freeze({ status: 'unavailable', reason, ...(bounds ? { bounds } : {}) })
}

/** The bounds of every region's contour points (control points included), in inner CSS px. */
export function aggregateBounds(regions: readonly VisibleRegion[]): WidgetRect | undefined {
	let left = Number.POSITIVE_INFINITY
	let top = Number.POSITIVE_INFINITY
	let right = Number.NEGATIVE_INFINITY
	let bottom = Number.NEGATIVE_INFINITY
	const include = (x: number, y: number) => {
		left = Math.min(left, x)
		top = Math.min(top, y)
		right = Math.max(right, x)
		bottom = Math.max(bottom, y)
	}
	for (const region of regions) {
		for (const command of region.contour.commands) {
			if (command.op === 'close') continue
			if (command.op === 'cubicBezierTo') {
				include(command.c1x, command.c1y)
				include(command.c2x, command.c2y)
			}
			include(command.x, command.y)
		}
	}
	return Number.isFinite(left) ? Object.freeze({ x: left, y: top, width: right - left, height: bottom - top }) : undefined
}

function sameContext(left: GeometryStreamContext | undefined, right: GeometryStreamContext | undefined): boolean {
	if (!left || !right) return left === right
	return left.previewSessionId === right.previewSessionId
		&& left.runtimeGenerationId === right.runtimeGenerationId
		&& left.viewId === right.viewId
		&& left.variantId === right.variantId
		&& left.runtimeContextVersion === right.runtimeContextVersion
}

/** The relative difference below which two measurements of one mapping are the same mapping. */
const MAPPING_JITTER = 1e-9

/**
 * The mapping to keep when `next` is measured: the previous one while `next` differs from it by no more
 * than float jitter and does not amplify more, so a mapping that is measured every frame does not
 * re-judge the cache for noise, and the verdict never rests on a smaller amplification than a measured one.
 */
function settleMapping(previous: OuterErrorMapping | undefined, next: OuterErrorMapping | undefined): OuterErrorMapping | undefined {
	if (!previous || !next) return next
	if (previous.kind === 'affine' && next.kind === 'affine') {
		const pairs: ReadonlyArray<readonly [number, number]> = [[previous.a, next.a], [previous.b, next.b], [previous.c, next.c], [previous.d, next.d], [previous.e, next.e], [previous.f, next.f]]
		if (!pairs.every(([x, y]) => Math.abs(x - y) <= MAPPING_JITTER * (1 + Math.abs(x)))) return next
		const before = affineAmplificationUpperBound(previous)
		const after = affineAmplificationUpperBound(next)
		return before !== undefined && after !== undefined && before >= after ? previous : next
	}
	if (previous.kind === 'non-affine' && next.kind === 'non-affine' && previous.amplificationUpperBound === next.amplificationUpperBound) return previous
	return next
}

/** The identity of a cache's geometry, for telling a reopened stream's unchanged baseline from a change. */
function geometryKey(geometry: Readonly<{ rect: WidgetRect; regions: readonly VisibleRegion[] }>): string {
	return JSON.stringify([geometry.rect, geometry.regions.map(region => [region.regionId, region.maxError, region.contour.commands])])
}
