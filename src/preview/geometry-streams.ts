import {
	MAX_TRACKED_WIDGETS,
	type GeometryAcquireRequest,
	type GeometryAcquireResponse,
	type GeometryReleaseRequest,
	type VisibleRegion,
	type WidgetRect,
} from './protocol/schema'

/**
 * Workbench geometry stream coordinator (Part 2, 2026-10-05 multi-target decision group; Part 3
 * companion). It owns every `geometry.acquire.*` stream of one Preview session and fans each
 * Widget's reports out to every local consumer of that Widget (Checks/selection highlight, hover
 * candidate, comment pins, pending composer).
 *
 * - One stream per Widget, identified by a Workbench-minted `navigationRequestId` that is never
 *   reused in a runtime generation (decision 2). A consumer may bring its own identity (a Checks
 *   navigation request); it then supersedes the Widget's stream and the other consumers move to it.
 * - Demand beyond the cap (64, or 1 without `geometry.multi-target`) is assigned in priority order:
 *   targeting (open thread, pending composer, hover candidate), then the Checks highlight, then
 *   pins by thread status (ready-for-review, open, resolved), latest activity (newest first) and
 *   `widgetId` (decision 6). Widgets without a stream have no geometry, never a last-known one.
 * - Streams leaving the assignment are released at once with `geometry.release` when the runtime
 *   declared `geometry.multi-target`; without it nothing is ever released (decision 5).
 * - Reports pass, in order, the runtime context, the open-stream and the per-Widget revision gates
 *   (decision 4; session, generation and payload are the bridge's). A stale report affects only
 *   its own stream.
 * - A View/Variant/runtime-context change ends every stream without a release and reopens them
 *   with fresh identities; a generation boundary voids everything until the next capability ACK;
 *   a content-box size change hides every report at once and reopens every stream with fresh
 *   identities, coalesced to one reopen per animation frame.
 */

export type GeometryStreamContext = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	runtimeContextVersion?: number
}>

/** Priority tiers of decision 6, highest first. */
export type GeometryDemandTier = 'targeting' | 'highlight' | 'pin'
export type GeometryThreadStatus = 'ready-for-review' | 'open' | 'resolved'

export type GeometryDemand = Readonly<{
	/** Stable identity of the consumer, e.g. `pin:<threadId>`, `selection`, `hover`. */
	consumerId: string
	widgetId: string
	tier: GeometryDemandTier
	/** Pin ordering inside the `pin` tier. */
	status?: GeometryThreadStatus
	/** Latest canonical activity, epoch ms; newer first. */
	latestActivity?: number
	/** A consumer-minted stream identity (Checks navigation). It must be fresh for this generation. */
	navigationRequestId?: string
}>

export type GeometryReport = Readonly<{
	widgetId: string
	navigationRequestId: string
	geometryRevision: number
	rect: WidgetRect
	regions: readonly VisibleRegion[]
}>

export type GeometryReportOutcome = 'accepted' | 'no-context' | 'stale-context' | 'stale-stream' | 'stale-revision'

export type GeometryStreamDependencies = Readonly<{
	send(message: GeometryAcquireRequest | GeometryReleaseRequest): void
	mintId?: () => string
	requestFrame?: (callback: () => void) => number
	cancelFrame?: (handle: number) => void
}>

export type GeometryStreamSnapshot = Readonly<{
	ready: boolean
	multiTarget: boolean
	cap: number
	streams: ReadonlyArray<Readonly<{ widgetId: string; navigationRequestId: string }>>
	overCap: readonly string[]
	retiredCount: number
}>

type OpenStream = { widgetId: string; navigationRequestId: string; ownerId?: string }

const TIER_RANK: Readonly<Record<GeometryDemandTier, number>> = { targeting: 0, highlight: 1, pin: 2 }
const STATUS_RANK: Readonly<Record<GeometryThreadStatus, number>> = { 'ready-for-review': 0, 'open': 1, 'resolved': 2 }

let mintCounter = 0
function defaultMint(): string {
	mintCounter++
	const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
	return `geometry-${mintCounter}-${random}`
}

export class GeometryStreamCoordinator {
	private readonly deps: GeometryStreamDependencies
	private readonly mintId: () => string
	private context?: GeometryStreamContext
	private ready = false
	private multiTarget = false
	private demands: readonly GeometryDemand[] = []
	private readonly streams = new Map<string, OpenStream>()
	private readonly reports = new Map<string, GeometryReport>()
	private readonly lastRevision = new Map<string, number>()
	private retired = new Set<string>()
	private overCap: readonly string[] = []
	private readonly listeners = new Set<(changed: ReadonlySet<string>) => void>()
	private reopenFrame?: number

	constructor(deps: GeometryStreamDependencies) {
		this.deps = deps
		this.mintId = deps.mintId ?? defaultMint
	}

	/** The current runtime context; `undefined` when no View is mounted. */
	setContext(next: GeometryStreamContext | undefined): void {
		const previous = this.context
		this.context = next ? Object.freeze({ ...next }) : undefined
		if (sameContext(previous, this.context)) return
		const generationChanged = previous?.runtimeGenerationId !== this.context?.runtimeGenerationId
			|| previous?.previewSessionId !== this.context?.previewSessionId
		if (generationChanged) {
			// Generation boundary: every stream is void, and IDs, revisions and retired IDs start a new domain.
			this.ready = false
			this.streams.clear()
			this.lastRevision.clear()
			this.retired = new Set()
		}
		else {
			// View/Variant/runtime-context change: streams end without a release (decision 3.5).
			for (const stream of this.streams.values()) this.retired.add(stream.navigationRequestId)
			this.streams.clear()
		}
		this.clearReports()
		this.reconcile()
	}

	/** Opens the traffic gate after the generation's capability ACK, or closes it. */
	setReady(ready: boolean): void {
		if (this.ready === ready) return
		this.ready = ready
		if (!ready) {
			for (const stream of this.streams.values()) this.retired.add(stream.navigationRequestId)
			this.streams.clear()
			this.clearReports()
		}
		this.reconcile()
	}

	/** Whether the runtime declared `geometry.multi-target` (the feature is optional). */
	setMultiTarget(enabled: boolean): void {
		if (this.multiTarget === enabled) return
		this.multiTarget = enabled
		this.reconcile()
	}

	/** Replaces the whole demand. Called on filter, thread, status, selection or hover changes. */
	setDemand(demands: readonly GeometryDemand[]): void {
		this.demands = Object.freeze([...demands])
		this.reconcile()
	}

	/**
	 * Content-box size change: hide every report now; in the next animation frame reopen every
	 * stream with a fresh identity, so pre-resize reports in flight fail the stream gate. Streams
	 * whose identity a consumer owns (Checks navigation) are reopened by that consumer.
	 */
	invalidateContentBox(): void {
		this.clearReports()
		if (this.reopenFrame !== undefined) return
		const run = () => {
			this.reopenFrame = undefined
			this.reopenAll()
		}
		if (this.deps.requestFrame) this.reopenFrame = this.deps.requestFrame(run)
		else run()
	}

	accept(response: GeometryAcquireResponse): GeometryReportOutcome {
		const context = this.context
		if (!context) return 'no-context'
		const reported = response.context
		if (reported.previewSessionId !== context.previewSessionId || reported.runtimeGenerationId !== context.runtimeGenerationId
			|| reported.viewId !== context.viewId || reported.variantId !== context.variantId
			|| reported.runtimeContextVersion !== context.runtimeContextVersion) return 'stale-context'
		const stream = this.streams.get(reported.widgetId)
		if (!stream || !reported.navigationRequestId || stream.navigationRequestId !== reported.navigationRequestId) return 'stale-stream'
		const last = this.lastRevision.get(reported.widgetId)
		if (last !== undefined && reported.geometryRevision <= last) return 'stale-revision'
		this.lastRevision.set(reported.widgetId, reported.geometryRevision)
		this.reports.set(reported.widgetId, Object.freeze({
			widgetId: reported.widgetId,
			navigationRequestId: stream.navigationRequestId,
			geometryRevision: reported.geometryRevision,
			rect: response.payload.rect,
			regions: response.payload.regions,
		}))
		this.emit(new Set([reported.widgetId]))
		return 'accepted'
	}

	/** The latest accepted report of the Widget's current stream, if any. */
	report(widgetId: string): GeometryReport | undefined {
		return this.reports.get(widgetId)
	}

	/** The open stream identity of a Widget, if it has one. */
	streamId(widgetId: string): string | undefined {
		return this.streams.get(widgetId)?.navigationRequestId
	}

	isTracked(widgetId: string): boolean {
		return this.streams.has(widgetId)
	}

	/** Widgets with demand but no stream because of the cap (Comments tab: "Not shown on canvas"). */
	overCapWidgets(): readonly string[] {
		return this.overCap
	}

	cap(): number {
		return this.multiTarget ? MAX_TRACKED_WIDGETS : 1
	}

	isMultiTarget(): boolean {
		return this.multiTarget
	}

	isReady(): boolean {
		return this.ready
	}

	subscribe(listener: (changed: ReadonlySet<string>) => void): () => void {
		this.listeners.add(listener)
		return () => { this.listeners.delete(listener) }
	}

	snapshot(): GeometryStreamSnapshot {
		return Object.freeze({
			ready: this.ready,
			multiTarget: this.multiTarget,
			cap: this.cap(),
			streams: Object.freeze([...this.streams.values()].map(stream => Object.freeze({ widgetId: stream.widgetId, navigationRequestId: stream.navigationRequestId }))),
			overCap: this.overCap,
			retiredCount: this.retired.size,
		})
	}

	dispose(): void {
		if (this.reopenFrame !== undefined) this.deps.cancelFrame?.(this.reopenFrame)
		this.reopenFrame = undefined
		this.listeners.clear()
		this.streams.clear()
		this.reports.clear()
	}

	private reopenAll(): void {
		if (!this.ready || !this.context) return
		for (const stream of [...this.streams.values()]) {
			if (stream.ownerId) continue
			this.retired.add(stream.navigationRequestId)
			const navigationRequestId = this.freshId()
			stream.navigationRequestId = navigationRequestId
			this.sendAcquire(stream.widgetId, navigationRequestId)
		}
	}

	private reconcile(): void {
		const assignment = this.assign()
		this.overCap = Object.freeze(assignment.overCap)
		if (!this.ready || !this.context) return
		const changed = new Set<string>()
		// Release (or, without the feature, silently drop) streams that left the assignment.
		for (const [widgetId, stream] of [...this.streams]) {
			if (assignment.widgets.has(widgetId)) continue
			this.streams.delete(widgetId)
			this.retired.add(stream.navigationRequestId)
			if (this.multiTarget) this.sendRelease(widgetId, stream.navigationRequestId)
			if (this.reports.delete(widgetId)) changed.add(widgetId)
		}
		for (const [widgetId, owned] of assignment.widgets) {
			const current = this.streams.get(widgetId)
			const ownedUsable = owned && !this.retired.has(owned.navigationRequestId)
			if (current && (!ownedUsable || current.navigationRequestId === owned.navigationRequestId)) {
				// Keep the stream. It stays consumer-owned only while that consumer still brings the identity.
				current.ownerId = ownedUsable && current.navigationRequestId === owned.navigationRequestId ? owned.consumerId : undefined
				continue
			}
			if (current) {
				// A consumer-owned request supersedes the Widget's stream (decision 3.3).
				this.retired.add(current.navigationRequestId)
				if (this.reports.delete(widgetId)) changed.add(widgetId)
			}
			const navigationRequestId = ownedUsable ? owned.navigationRequestId : this.freshId()
			this.streams.set(widgetId, { widgetId, navigationRequestId, ...(ownedUsable ? { ownerId: owned.consumerId } : {}) })
			this.sendAcquire(widgetId, navigationRequestId)
		}
		if (changed.size) this.emit(changed)
	}

	private assign(): { widgets: Map<string, Readonly<{ consumerId: string; navigationRequestId: string }> | undefined>; overCap: string[] } {
		const best = new Map<string, GeometryDemand>()
		const owned = new Map<string, GeometryDemand>()
		for (const demand of this.demands) {
			const current = best.get(demand.widgetId)
			if (!current || compareDemand(demand, current) < 0) best.set(demand.widgetId, demand)
			if (demand.navigationRequestId) {
				const owner = owned.get(demand.widgetId)
				if (!owner || compareDemand(demand, owner) < 0) owned.set(demand.widgetId, demand)
			}
		}
		const ordered = [...best.values()].sort(compareDemand)
		const cap = this.cap()
		const widgets = new Map<string, Readonly<{ consumerId: string; navigationRequestId: string }> | undefined>()
		const overCap: string[] = []
		for (const demand of ordered) {
			if (widgets.size >= cap) {
				overCap.push(demand.widgetId)
				continue
			}
			const owner = owned.get(demand.widgetId)
			widgets.set(demand.widgetId, owner ? { consumerId: owner.consumerId, navigationRequestId: owner.navigationRequestId! } : undefined)
		}
		return { widgets, overCap }
	}

	private freshId(): string {
		for (;;) {
			const id = this.mintId()
			if (id && !this.retired.has(id) && ![...this.streams.values()].some(stream => stream.navigationRequestId === id)) return id
		}
	}

	private baseContext(widgetId: string, navigationRequestId: string) {
		const context = this.context!
		return {
			previewSessionId: context.previewSessionId,
			runtimeGenerationId: context.runtimeGenerationId,
			viewId: context.viewId,
			...(context.variantId !== undefined ? { variantId: context.variantId } : {}),
			...(context.runtimeContextVersion !== undefined ? { runtimeContextVersion: context.runtimeContextVersion } : {}),
			navigationRequestId,
			widgetId,
		}
	}

	private sendAcquire(widgetId: string, navigationRequestId: string): void {
		this.deps.send({ type: 'geometry.acquire.request', context: this.baseContext(widgetId, navigationRequestId), payload: {} })
	}

	private sendRelease(widgetId: string, navigationRequestId: string): void {
		this.deps.send({ type: 'geometry.release', context: this.baseContext(widgetId, navigationRequestId), payload: {} })
	}

	private clearReports(): void {
		if (this.reports.size === 0) return
		const changed = new Set(this.reports.keys())
		this.reports.clear()
		this.emit(changed)
	}

	private emit(changed: ReadonlySet<string>): void {
		for (const listener of this.listeners) listener(changed)
	}
}

/** Decision 6 ordering: tier, then thread status, latest activity (newest first), then widgetId. */
export function compareDemand(left: GeometryDemand, right: GeometryDemand): number {
	const tier = TIER_RANK[left.tier] - TIER_RANK[right.tier]
	if (tier) return tier
	const status = (left.status ? STATUS_RANK[left.status] : 3) - (right.status ? STATUS_RANK[right.status] : 3)
	if (status) return status
	const activity = (right.latestActivity ?? Number.NEGATIVE_INFINITY) - (left.latestActivity ?? Number.NEGATIVE_INFINITY)
	if (activity && Number.isFinite(activity)) return activity
	if (left.latestActivity !== right.latestActivity) return left.latestActivity === undefined ? 1 : -1
	return left.widgetId < right.widgetId ? -1 : left.widgetId > right.widgetId ? 1 : 0
}

function sameContext(left: GeometryStreamContext | undefined, right: GeometryStreamContext | undefined): boolean {
	if (!left || !right) return left === right
	return left.previewSessionId === right.previewSessionId
		&& left.runtimeGenerationId === right.runtimeGenerationId
		&& left.viewId === right.viewId
		&& left.variantId === right.variantId
		&& left.runtimeContextVersion === right.runtimeContextVersion
}
