import type { Diagnostic } from '../../domain/validation'
import {
	responseMeetsRequestedPrecision,
	validateGeometryMessage,
	validatePartialResponseAgainstRequest,
	type FullContourRequest,
	type FullContourResponse,
	type GeometryAcquireResponse,
	type PartialContourRequest,
	type PartialContourResponse,
	type ProtocolContext,
	type VisibleRegion,
	type WidgetRect,
} from './schema'

export type SnapshotVersionAllocator = (previous: number | undefined) => number

export type ContourCacheSnapshot = Readonly<{
	geometryRevision: number
	snapshotVersion: number
	rect: WidgetRect
	regions: readonly VisibleRegion[]
}>

type ActiveWork =
	| Readonly<{ kind: 'full'; request: FullContourRequest }>
	| Readonly<{ kind: 'partial'; request: PartialContourRequest }>

export type StartWorkResult =
	| Readonly<{ status: 'started'; sequence: number; supersededSequence?: number }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'stale-context' | 'stale-geometry' | 'non-monotonic-sequence' | 'no-cache' | 'stale-base' | 'unknown-region' | 'region-already-in-tolerance' }>

export type CommitResult =
	| Readonly<{ status: 'committed'; snapshot: ContourCacheSnapshot }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'stale' | 'wrong-work-kind' | 'stale-base' | 'precision-miss' | 'region-identity-changed' | 'not-better' }>

export type AcquisitionCommitResult =
	| Readonly<{ status: 'committed'; snapshot: ContourCacheSnapshot; supersededSequence?: number }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'stale' | 'stale-context' | 'non-advancing-geometry-revision' }>

/**
 * Workbench-local authoritative contour cache and freshness controller for one geometry stream.
 * Snapshot version allocation is injected so this layer does not define a wire-visible starting value.
 *
 * Acquisition is a stream (Part 2, 2026-10-05 multi-target decision 3): after `beginAcquisition()`
 * the runtime pushes a complete `geometry.acquire.response` whenever the Widget's `rect` or
 * `regions` really change, each with a strictly advancing `geometryRevision`. Every accepted
 * report replaces the cache atomically and starts a fresh contour-work sequence domain; contour
 * work still in flight for the previous revision is superseded (best-effort cancel). The stream
 * stays open until `endAcquisition()` (release, supersession or an implicit end).
 */
export class ContourCacheController {
	private readonly scope: Omit<ProtocolContext, 'geometryRevision'>
	private readonly allocateSnapshotVersion: SnapshotVersionAllocator
	private streamOpen = false
	private cache?: ContourCacheSnapshot
	private activeWork?: ActiveWork
	private lastSequence?: number
	private lastGeometryRevision?: number
	private lastSnapshotVersion?: number
	private currentRect?: WidgetRect

	constructor(scope: Omit<ProtocolContext, 'geometryRevision'>, allocateSnapshotVersion: SnapshotVersionAllocator) {
		this.scope = { ...scope }
		this.allocateSnapshotVersion = allocateSnapshotVersion
	}

	beginAcquisition(): Readonly<{ supersededSequence?: number }> {
		const supersededSequence = this.activeWork?.request.payload.sequence
		this.streamOpen = true
		this.activeWork = undefined
		this.lastSequence = undefined
		this.cache = undefined
		this.currentRect = undefined
		return supersededSequence === undefined ? {} : { supersededSequence }
	}

	/** Ends the stream: later reports are stale and the cache is dropped (no last-known geometry). */
	endAcquisition(): Readonly<{ supersededSequence?: number }> {
		const supersededSequence = this.activeWork?.request.payload.sequence
		this.streamOpen = false
		this.activeWork = undefined
		this.lastSequence = undefined
		this.cache = undefined
		this.currentRect = undefined
		return supersededSequence === undefined ? {} : { supersededSequence }
	}

	isStreamOpen(): boolean {
		return this.streamOpen
	}

	commitAcquisition(response: GeometryAcquireResponse): AcquisitionCommitResult {
		if (!this.streamOpen) return { status: 'stale' }
		const decoded = validateGeometryMessage(response)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'geometry.acquire.response') return { status: 'stale' }
		if (!sameScope(this.scope, decoded.value.context)) return { status: 'stale-context' }

		if (this.lastGeometryRevision !== undefined && decoded.value.context.geometryRevision <= this.lastGeometryRevision)
			return { status: 'non-advancing-geometry-revision' }

		const supersededSequence = this.activeWork?.request.payload.sequence
		const snapshot = this.commitComplete(
			decoded.value.context.geometryRevision,
			decoded.value.payload.regions,
			decoded.value.payload.rect,
		)
		this.lastGeometryRevision = decoded.value.context.geometryRevision
		// A new geometry revision starts a new contour-work sequence domain; work for the old one is void.
		this.lastSequence = undefined
		this.activeWork = undefined
		return supersededSequence === undefined
			? { status: 'committed', snapshot }
			: { status: 'committed', snapshot, supersededSequence }
	}

	startFull(request: FullContourRequest): StartWorkResult {
		const decoded = validateGeometryMessage(request)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'contour.full.request') return { status: 'stale-context' }
		return this.startWork({ kind: 'full', request: decoded.value })
	}

	startPartial(request: PartialContourRequest): StartWorkResult {
		const decoded = validateGeometryMessage(request)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'contour.partial.request') return { status: 'stale-context' }
		if (!this.cache) return { status: 'no-cache' }
		if (!sameScope(this.scope, decoded.value.context)) return { status: 'stale-context' }
		if (decoded.value.context.geometryRevision !== this.cache.geometryRevision) return { status: 'stale-geometry' }
		// Bound once so the narrowing on `decoded.value.type` survives into the callbacks below.
		const payload = decoded.value.payload
		if (payload.baseSnapshotVersion !== this.cache.snapshotVersion) return { status: 'stale-base' }
		const known = new Map(this.cache.regions.map(region => [region.regionId, region] as const))
		if (payload.regionIds.some(regionId => !known.has(regionId))) return { status: 'unknown-region' }
		if (payload.regionIds.some(regionId => known.get(regionId)!.maxError <= payload.targetMaxError))
			return { status: 'region-already-in-tolerance' }
		return this.startWork({ kind: 'partial', request: decoded.value })
	}

	commitFull(response: FullContourResponse): CommitResult {
		const decoded = validateGeometryMessage(response)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'contour.full.response') return { status: 'wrong-work-kind' }
		const active = this.activeWork
		if (!active || active.kind !== 'full') return { status: 'stale' }
		if (!responseMatchesRequest(active.request, decoded.value)) return { status: 'stale' }
		this.activeWork = undefined
		if (!responseMeetsRequestedPrecision(decoded.value.payload.regions, active.request.payload.targetMaxError))
			return { status: 'precision-miss' }
		if (this.cache) {
			if (!sameRegionIdSet(this.cache.regions, decoded.value.payload.regions)) return { status: 'region-identity-changed' }
			if (!isEqualOrBetter(this.cache.regions, decoded.value.payload.regions)) return { status: 'not-better' }
		}
		const snapshot = this.commitComplete(decoded.value.context.geometryRevision, decoded.value.payload.regions)
		return { status: 'committed', snapshot }
	}

	commitPartial(response: PartialContourResponse): CommitResult {
		const decoded = validateGeometryMessage(response)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'contour.partial.response') return { status: 'wrong-work-kind' }
		const active = this.activeWork
		if (!active || active.kind !== 'partial') return { status: 'stale' }
		if (!this.cache) return { status: 'stale' }
		if (!responseMatchesRequest(active.request, decoded.value)) return { status: 'stale' }
		this.activeWork = undefined
		const match = validatePartialResponseAgainstRequest(active.request, decoded.value)
		if (!match.ok) return { status: 'invalid', diagnostics: match.diagnostics }
		if (active.request.payload.baseSnapshotVersion !== this.cache.snapshotVersion) return { status: 'stale-base' }
		if (!responseMeetsRequestedPrecision(decoded.value.payload.regions, active.request.payload.targetMaxError))
			return { status: 'precision-miss' }

		const replacements = new Map(decoded.value.payload.regions.map(region => [region.regionId, region] as const))
		const merged = this.cache.regions.map(region => replacements.get(region.regionId) ?? region)
		if (!isEqualOrBetter(this.cache.regions, merged)) return { status: 'not-better' }
		const snapshot = this.commitComplete(decoded.value.context.geometryRevision, merged)
		return { status: 'committed', snapshot }
	}

	retireActiveWorkIfCacheMeets(targetMaxError: number): Readonly<{ retiredSequence?: number }> {
		if (!Number.isFinite(targetMaxError) || targetMaxError <= 0 || !this.cache || !this.activeWork)
			return {}
		if (!responseMeetsRequestedPrecision(this.cache.regions, targetMaxError)) return {}
		const retiredSequence = this.activeWork.request.payload.sequence
		this.activeWork = undefined
		return { retiredSequence }
	}

	getSnapshot(): ContourCacheSnapshot | undefined {
		return this.cache && cloneSnapshot(this.cache)
	}

	private startWork(work: ActiveWork): StartWorkResult {
		if (!this.cache) return { status: 'no-cache' }
		if (!sameScope(this.scope, work.request.context)) return { status: 'stale-context' }
		if (work.request.context.geometryRevision !== this.cache.geometryRevision) return { status: 'stale-geometry' }
		const sequence = work.request.payload.sequence
		if (this.lastSequence !== undefined && sequence <= this.lastSequence) return { status: 'non-monotonic-sequence' }
		const supersededSequence = this.activeWork?.request.payload.sequence
		this.lastSequence = sequence
		this.activeWork = work
		return supersededSequence === undefined
			? { status: 'started', sequence }
			: { status: 'started', sequence, supersededSequence }
	}

	private commitComplete(
		geometryRevision: number,
		regions: readonly VisibleRegion[],
		rect: WidgetRect | undefined = this.currentRect,
	): ContourCacheSnapshot {
		if (!rect) throw new Error('Cannot commit contour cache without an acquired Widget rectangle.')
		const nextVersion = this.allocateSnapshotVersion(this.lastSnapshotVersion)
		if (!Number.isSafeInteger(nextVersion) || nextVersion < 0)
			throw new RangeError('Snapshot allocator must return a non-negative JSON safe integer.')
		if (this.lastSnapshotVersion !== undefined && nextVersion <= this.lastSnapshotVersion)
			throw new RangeError('Snapshot allocator must return a strictly increasing version within a runtime generation.')
		const snapshot = Object.freeze({
			geometryRevision,
			snapshotVersion: nextVersion,
			rect: Object.freeze({ ...rect }),
			regions: cloneRegions(regions),
		})
		this.cache = snapshot
		this.currentRect = snapshot.rect
		this.lastSnapshotVersion = nextVersion
		return cloneSnapshot(snapshot)
	}
}

function responseMatchesRequest(
	request: FullContourRequest | PartialContourRequest,
	response: FullContourResponse | PartialContourResponse,
): boolean {
	return sameScope(request.context, response.context)
		&& request.context.geometryRevision === response.context.geometryRevision
		&& request.payload.sequence === response.payload.sequence
}

function sameScope(left: Omit<ProtocolContext, 'geometryRevision'>, right: ProtocolContext): boolean {
	return left.previewSessionId === right.previewSessionId
		&& left.runtimeGenerationId === right.runtimeGenerationId
		&& left.viewId === right.viewId
		&& left.variantId === right.variantId
		&& left.runtimeContextVersion === right.runtimeContextVersion
		&& left.navigationRequestId === right.navigationRequestId
		&& left.widgetId === right.widgetId
}

function sameRegionIdSet(left: readonly VisibleRegion[], right: readonly VisibleRegion[]): boolean {
	if (left.length !== right.length) return false
	const ids = new Set(left.map(region => region.regionId))
	return right.every(region => ids.has(region.regionId))
}

function isEqualOrBetter(previous: readonly VisibleRegion[], next: readonly VisibleRegion[]): boolean {
	const previousError = new Map(previous.map(region => [region.regionId, region.maxError] as const))
	return next.every(region => {
		const before = previousError.get(region.regionId)
		return before !== undefined && region.maxError <= before
	})
}

function cloneRegions(regions: readonly VisibleRegion[]): readonly VisibleRegion[] {
	return Object.freeze(regions.map(region => Object.freeze({
		regionId: region.regionId,
		maxError: region.maxError,
		contour: Object.freeze({
			commands: Object.freeze(region.contour.commands.map(command => Object.freeze({ ...command }))),
		}),
	})))
}

function cloneSnapshot(snapshot: ContourCacheSnapshot): ContourCacheSnapshot {
	return Object.freeze({
		geometryRevision: snapshot.geometryRevision,
		snapshotVersion: snapshot.snapshotVersion,
		rect: Object.freeze({ ...snapshot.rect }),
		regions: cloneRegions(snapshot.regions),
	})
}
