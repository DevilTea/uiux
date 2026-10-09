import type { GeometryDemand, GeometryReport, GeometryThreadStatus } from './geometry-streams'
import { mapPointAffine, type AffineOuterMapping } from './outer-precision'
import type { Contour, Point, VisibleRegion, WidgetRect } from './protocol/schema'

/**
 * Per-pin placement and visibility (Part 2/3, 2026-10-05 multi-target group, decision 7).
 *
 * A pin is drawn only when its point `P` (inner content-viewport CSS px) lies inside a reliably
 * visible region of the Widget's latest accepted report, farther than that region's `maxError`
 * from its boundary. The test runs in inner space, so it needs no outer amplification bound and
 * pins never ask for contour precision work. Nothing is inferred: no clamping, no fallback point,
 * no last-known position, no DOM sampling. Translucent coverage is kept inside regions by the
 * runtime (Part 4), so it does not hide a pin.
 */

export type PinThreadInput = Readonly<{
	threadId: string
	anchor: Readonly<{ viewId: string; widgetId: string }>
	/** Anchor Variant scope; empty or absent means View-wide. */
	variantNames?: readonly string[]
	status: GeometryThreadStatus
	/** Latest canonical activity (ISO 8601 or epoch ms); orders pins when demand exceeds the cap. */
	latestActivity?: string | number
	/** Non-authoritative Phase 2 pin hint: `pin {x, y}` in 0..1 of the Widget's full rendered rect. */
	displayHint?: Readonly<{ pin: Readonly<{ x: number; y: number }> }>
	/** In-tab click memory for threads created in this tab (normalized like the hint). */
	sessionPoint?: Readonly<{ x: number; y: number }>
	/** False when the anchored Widget no longer exists in the View IR. */
	anchorValid?: boolean
}>

export type PinPlacementState = 'visible' | 'hidden' | 'offscreen' | 'invalid'

/** Why a pin is not drawn; the Comments tab groups rows by it (brief c, decision 7 table). */
export type PinHiddenReason =
	| 'awaiting-geometry'
	| 'not-rendered'
	| 'no-visible-region'
	| 'point-not-visible'
	| 'mapping-unavailable'
	| 'over-cap'
	| 'single-stream'
	| 'other-variant'
	| 'other-view'
	| 'reconnecting'

export type PinEdgeSide = 'top' | 'right' | 'bottom' | 'left'
export type PinPointSource = 'hint' | 'session' | 'default'

export type PinPlacement = Readonly<{
	threadId: string
	widgetId: string
	state: PinPlacementState
	/** Present when `state` is `hidden` (or `invalid`: `missing-widget`). */
	reason?: PinHiddenReason | 'missing-widget'
	/** Pin tip in overlay-layer CSS px; present only when `state` is `visible`. */
	point?: Point
	/** Pin point in inner content-viewport CSS px, when geometry is current. */
	innerPoint?: Point
	pointSource?: PinPointSource
	/** Edge indicator for `offscreen`: the side and the anchor point on that edge, in overlay px. */
	edge?: Readonly<{ side: PinEdgeSide; point: Point; scope: 'frame' | 'stage' }>
	geometryRevision?: number
}>

export type PinPlacementInputs = Readonly<{
	viewId?: string
	/** Selected Variant name; empty or absent is the base. */
	variantId?: string
	/** Inner content viewport `W × H` (the iframe's logical size). */
	viewport: Readonly<{ width: number; height: number }>
	/** Inner → overlay mapping; absent when unmeasurable or non-affine (all pins hidden). */
	mapping?: AffineOuterMapping
	/** Visible canvas stage in overlay px; pins mapped outside it become stage edge indicators. */
	stage?: Readonly<{ left: number; top: number; right: number; bottom: number }>
	/** False while the Preview reconnects (generation boundary): every pin is hidden. */
	live: boolean
	multiTarget: boolean
	report(widgetId: string): GeometryReport | undefined
	isTracked(widgetId: string): boolean
}>

/** Default point (brief c §7): Widget top-right inset 4px, fanning out leftward at 20px steps. */
export const PIN_DEFAULT_INSET = 4
export const PIN_FAN_STEP = 20
/** RootShell (blank-area) threads sit at the frame's top-left inset 16px, fanning out rightward. */
export const PIN_ROOT_INSET = 16
/** Pins whose mapped points are this close merge into a count cluster (presentation only). */
export const PIN_CLUSTER_RADIUS = 24

/**
 * Pin point source order: the thread's `displayHint.pin`, then the in-tab session point, then the
 * default point. Normalized points are applied to the latest accepted full Widget `rect`.
 */
export function resolvePinPoint(
	thread: PinThreadInput,
	rect: WidgetRect,
	fanIndex = 0,
): Readonly<{ point: Point; source: PinPointSource }> {
	const hint = thread.displayHint?.pin
	if (hint && validUnit(hint)) return { point: { x: rect.x + hint.x * rect.width, y: rect.y + hint.y * rect.height }, source: 'hint' }
	const session = thread.sessionPoint
	if (session && validUnit(session)) return { point: { x: rect.x + session.x * rect.width, y: rect.y + session.y * rect.height }, source: 'session' }
	// The RootShell is the frame itself: its default point is the frame's (content viewport's) top-left.
	if (thread.anchor.widgetId === 'root') return { point: { x: PIN_ROOT_INSET + fanIndex * PIN_FAN_STEP, y: PIN_ROOT_INSET }, source: 'default' }
	return { point: { x: rect.x + rect.width - PIN_DEFAULT_INSET - fanIndex * PIN_FAN_STEP, y: rect.y + PIN_DEFAULT_INSET }, source: 'default' }
}

/** Geometry demand for the pin consumers of the in-scope threads (decision 6, tier `pin`). */
export function pinGeometryDemand(threads: readonly PinThreadInput[], inputs: Pick<PinPlacementInputs, 'viewId' | 'variantId'>): GeometryDemand[] {
	const demands: GeometryDemand[] = []
	for (const thread of threads) {
		if (scopeReason(thread, inputs) || thread.anchorValid === false) continue
		const activity = activityMs(thread.latestActivity)
		demands.push({
			consumerId: `pin:${thread.threadId}`,
			widgetId: thread.anchor.widgetId,
			tier: 'pin',
			status: thread.status,
			...(activity !== undefined ? { latestActivity: activity } : {}),
		})
	}
	return demands
}

/**
 * Computes every thread's placement. Containment results are cached per thread and Widget
 * revision, so a frame in which only the outer mapping moved costs one affine map per pin, and a
 * report re-tests only the threads of its own Widget.
 */
export class PinPlacementEngine {
	private readonly containment = new Map<string, Readonly<{ revision: number; x: number; y: number; visible: boolean }>>()

	place(threads: readonly PinThreadInput[], inputs: PinPlacementInputs): PinPlacement[] {
		const fan = new Map<string, number>()
		const placements: PinPlacement[] = []
		const seen = new Set<string>()
		for (const thread of threads) {
			seen.add(thread.threadId)
			placements.push(this.placeOne(thread, inputs, fan))
		}
		for (const threadId of this.containment.keys()) if (!seen.has(threadId)) this.containment.delete(threadId)
		return placements
	}

	private placeOne(thread: PinThreadInput, inputs: PinPlacementInputs, fan: Map<string, number>): PinPlacement {
		const widgetId = thread.anchor.widgetId
		const base = { threadId: thread.threadId, widgetId }
		const scope = scopeReason(thread, inputs)
		if (scope) return { ...base, state: 'hidden', reason: scope }
		if (thread.anchorValid === false) return { ...base, state: 'invalid', reason: 'missing-widget' }
		if (!inputs.live) return { ...base, state: 'hidden', reason: 'reconnecting' }
		if (!inputs.isTracked(widgetId)) return { ...base, state: 'hidden', reason: inputs.multiTarget ? 'over-cap' : 'single-stream' }
		const report = inputs.report(widgetId)
		if (!report) return { ...base, state: 'hidden', reason: 'awaiting-geometry' }
		const { rect, regions } = report
		const revision = { geometryRevision: report.geometryRevision }
		if (!(rect.width > 0) || !(rect.height > 0)) return { ...base, ...revision, state: 'hidden', reason: 'not-rendered' }
		const { width, height } = inputs.viewport
		const intersects = rect.x < width && rect.y < height && rect.x + rect.width > 0 && rect.y + rect.height > 0
		if (!intersects) {
			if (!inputs.mapping) return { ...base, ...revision, state: 'hidden', reason: 'mapping-unavailable' }
			return { ...base, ...revision, state: 'offscreen', edge: frameEdge(rect, inputs.viewport, inputs.mapping) }
		}
		if (!inputs.mapping) return { ...base, ...revision, state: 'hidden', reason: 'mapping-unavailable' }
		if (regions.length === 0) return { ...base, ...revision, state: 'hidden', reason: 'no-visible-region' }

		const usesDefault = !thread.displayHint?.pin && !thread.sessionPoint
		const fanIndex = usesDefault ? (fan.get(widgetId) ?? 0) : 0
		if (usesDefault) fan.set(widgetId, fanIndex + 1)
		const { point, source } = resolvePinPoint(thread, rect, fanIndex)
		const cached = this.containment.get(thread.threadId)
		let visible: boolean
		if (cached && cached.revision === report.geometryRevision && cached.x === point.x && cached.y === point.y) visible = cached.visible
		else {
			visible = isPointReliablyVisible(point, regions)
			this.containment.set(thread.threadId, { revision: report.geometryRevision, x: point.x, y: point.y, visible })
		}
		const placed = { ...base, ...revision, innerPoint: point, pointSource: source }
		if (!visible) return { ...placed, state: 'hidden', reason: 'point-not-visible' }
		const mapped = mapPointAffine(point, inputs.mapping)
		const stage = inputs.stage
		if (stage && (mapped.x < stage.left || mapped.x > stage.right || mapped.y < stage.top || mapped.y > stage.bottom)) {
			return { ...placed, state: 'offscreen', edge: stageEdge(mapped, stage) }
		}
		return { ...placed, state: 'visible', point: mapped }
	}
}

/**
 * The conservative containment test: `P` is inside some region's contour (even-odd) and farther
 * than that region's `maxError` from its boundary.
 */
export function isPointReliablyVisible(point: Point, regions: readonly VisibleRegion[]): boolean {
	return regions.some((region) => {
		const polygon = flattenContour(region.contour)
		if (!polygon) return false
		const margin = region.maxError + polygon.flatteningError
		return pointInPolygon(point, polygon.points) && distanceToPolygon(point, polygon.points) > margin
	})
}

export type PinCluster = Readonly<{ point: Point; threadIds: readonly string[] }>

/** Merges visible pins whose mapped points are within `radius` px (presentation only). */
export function clusterPins(placements: readonly PinPlacement[], radius = PIN_CLUSTER_RADIUS): PinCluster[] {
	const clusters: { x: number; y: number; threadIds: string[] }[] = []
	for (const placement of placements) {
		if (placement.state !== 'visible' || !placement.point) continue
		const { x, y } = placement.point
		const near = clusters.find(cluster => Math.hypot(cluster.x - x, cluster.y - y) <= radius)
		if (near) {
			const count = near.threadIds.length
			near.x = (near.x * count + x) / (count + 1)
			near.y = (near.y * count + y) / (count + 1)
			near.threadIds.push(placement.threadId)
		}
		else clusters.push({ x, y, threadIds: [placement.threadId] })
	}
	return clusters.map(cluster => Object.freeze({ point: { x: cluster.x, y: cluster.y }, threadIds: Object.freeze(cluster.threadIds) }))
}

export type PinEdgeIndicator = Readonly<{ side: PinEdgeSide; scope: 'frame' | 'stage'; point: Point; threadIds: readonly string[] }>

/** Aggregates off-screen pins into one chevron-and-count indicator per edge. */
export function aggregateEdgeIndicators(placements: readonly PinPlacement[]): PinEdgeIndicator[] {
	const groups = new Map<string, { side: PinEdgeSide; scope: 'frame' | 'stage'; x: number; y: number; threadIds: string[] }>()
	for (const placement of placements) {
		if (placement.state !== 'offscreen' || !placement.edge) continue
		const key = `${placement.edge.scope}:${placement.edge.side}`
		const group = groups.get(key)
		if (group) {
			group.x += placement.edge.point.x
			group.y += placement.edge.point.y
			group.threadIds.push(placement.threadId)
		}
		else groups.set(key, { side: placement.edge.side, scope: placement.edge.scope, x: placement.edge.point.x, y: placement.edge.point.y, threadIds: [placement.threadId] })
	}
	return [...groups.values()].map(group => Object.freeze({
		side: group.side,
		scope: group.scope,
		point: { x: group.x / group.threadIds.length, y: group.y / group.threadIds.length },
		threadIds: Object.freeze(group.threadIds),
	}))
}

function scopeReason(thread: PinThreadInput, inputs: Pick<PinPlacementInputs, 'viewId' | 'variantId'>): 'other-view' | 'other-variant' | undefined {
	if (inputs.viewId !== undefined && thread.anchor.viewId !== inputs.viewId) return 'other-view'
	const scope = thread.variantNames
	if (!scope || scope.length === 0) return undefined
	return inputs.variantId && scope.includes(inputs.variantId) ? undefined : 'other-variant'
}

function activityMs(value: string | number | undefined): number | undefined {
	if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
	if (typeof value === 'string') {
		const parsed = Date.parse(value)
		return Number.isFinite(parsed) ? parsed : undefined
	}
	return undefined
}

function validUnit(point: Readonly<{ x: number; y: number }>): boolean {
	return Number.isFinite(point.x) && Number.isFinite(point.y) && point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1
}

/** Nearest canvas-frame edge for a Widget wholly outside the content viewport. */
function frameEdge(rect: WidgetRect, viewport: Readonly<{ width: number; height: number }>, mapping: AffineOuterMapping): NonNullable<PinPlacement['edge']> {
	const side: PinEdgeSide = rect.y + rect.height <= 0 ? 'top'
		: rect.y >= viewport.height ? 'bottom'
			: rect.x + rect.width <= 0 ? 'left' : 'right'
	const center = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
	const clamped = {
		x: side === 'left' ? 0 : side === 'right' ? viewport.width : clamp(center.x, 0, viewport.width),
		y: side === 'top' ? 0 : side === 'bottom' ? viewport.height : clamp(center.y, 0, viewport.height),
	}
	return { side, scope: 'frame', point: mapPointAffine(clamped, mapping) }
}

function stageEdge(mapped: Point, stage: NonNullable<PinPlacementInputs['stage']>): NonNullable<PinPlacement['edge']> {
	const side: PinEdgeSide = mapped.y < stage.top ? 'top' : mapped.y > stage.bottom ? 'bottom' : mapped.x < stage.left ? 'left' : 'right'
	return { side, scope: 'stage', point: { x: clamp(mapped.x, stage.left, stage.right), y: clamp(mapped.y, stage.top, stage.bottom) } }
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value))
}

type FlatPolygon = Readonly<{ points: readonly Point[]; flatteningError: number }>

const CUBIC_FLATTENING_TOLERANCE = 0.05
const MAX_CUBIC_DEPTH = 16

/**
 * Flattens a validated contour to a polygon. Lines are exact; a cubic is subdivided until the
 * standard control-polygon bound (3/4 of the largest second difference) is within tolerance, and
 * that bound is added to the visibility margin, so the polygon test stays conservative.
 */
function flattenContour(contour: Contour): FlatPolygon | undefined {
	const points: Point[] = []
	let current: Point | undefined
	let flatteningError = 0
	for (const command of contour.commands) {
		if (command.op === 'moveTo' || command.op === 'lineTo') {
			current = { x: command.x, y: command.y }
			points.push(current)
		}
		else if (command.op === 'cubicBezierTo') {
			if (!current) return undefined
			const c1 = { x: command.c1x, y: command.c1y }
			const c2 = { x: command.c2x, y: command.c2y }
			const end = { x: command.x, y: command.y }
			if (samePoint(c1, current) && samePoint(c2, end)) points.push(end) // line-equivalent chord
			else flatteningError = Math.max(flatteningError, flattenCubic(current, c1, c2, end, points, 0))
			current = end
		}
	}
	return points.length >= 3 ? { points, flatteningError } : undefined
}

function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, out: Point[], depth: number): number {
	const bound = 0.75 * Math.max(
		Math.hypot(p0.x - 2 * p1.x + p2.x, p0.y - 2 * p1.y + p2.y),
		Math.hypot(p1.x - 2 * p2.x + p3.x, p1.y - 2 * p2.y + p3.y),
	)
	if (bound <= CUBIC_FLATTENING_TOLERANCE || depth >= MAX_CUBIC_DEPTH) {
		out.push(p3)
		return bound
	}
	const p01 = mid(p0, p1)
	const p12 = mid(p1, p2)
	const p23 = mid(p2, p3)
	const p012 = mid(p01, p12)
	const p123 = mid(p12, p23)
	const middle = mid(p012, p123)
	return Math.max(flattenCubic(p0, p01, p012, middle, out, depth + 1), flattenCubic(middle, p123, p23, p3, out, depth + 1))
}

function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
	let inside = false
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		const a = polygon[index]!
		const b = polygon[previous]!
		if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
	}
	return inside
}

function distanceToPolygon(point: Point, polygon: readonly Point[]): number {
	let best = Number.POSITIVE_INFINITY
	for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
		best = Math.min(best, distanceToSegment(point, polygon[previous]!, polygon[index]!))
	}
	return best
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
	const dx = b.x - a.x
	const dy = b.y - a.y
	const length = dx * dx + dy * dy
	const t = length === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / length, 0, 1)
	return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

function mid(a: Point, b: Point): Point {
	return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
}

function samePoint(a: Point, b: Point): boolean {
	return a.x === b.x && a.y === b.y
}

// ---------------------------------------------------------------------------------------------
// Muted pins (Workbench IA Rules 01a1170f-c1ae, 01a1170f-c23d, 01a1170f-c282)
// ---------------------------------------------------------------------------------------------

/** A thread's recorded render context, or the Preview's current one: Locale, viewport ID and theme ID. */
export type PinRenderContext = Readonly<{ locale?: string; viewportId?: string; themeId?: string }>

/**
 * Whether a thread's pin and bubble are muted: its recorded render context differs from the
 * Preview's current one (Rule 01a1170f-c1ae). Only the members the thread records are compared,
 * so a member it does not record never makes it differ, and a thread without a recorded context
 * is never muted (Rule 01a1170f-c23d). `current` holds the keys the Preview actually shows, with
 * empty selections already resolved to their defaults.
 *
 * Muting is presentation only: it is not an input to placement, so it never shows a pin that
 * another rule hides and never moves one (Rule 01a1170f-c282).
 */
export function renderContextDiffers(recorded: PinRenderContext | undefined, current: PinRenderContext): boolean {
	if (!recorded) return false
	return (recorded.locale !== undefined && recorded.locale !== current.locale)
		|| (recorded.viewportId !== undefined && recorded.viewportId !== current.viewportId)
		|| (recorded.themeId !== undefined && recorded.themeId !== current.themeId)
}
