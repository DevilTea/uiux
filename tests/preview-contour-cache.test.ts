import { describe, expect, it } from 'vitest'

import { ContourCacheController } from '../src/preview/protocol/contour-cache'
import type { Contour, ProtocolContext, VisibleRegion } from '../src/preview/protocol/schema'

const viewId = '11111111-1111-4111-8111-111111111111'
const scope = {
	previewSessionId: 'session-a',
	runtimeGenerationId: 'generation-a',
	viewId,
	variantId: 'default',
	runtimeContextVersion: 3,
	navigationRequestId: 'nav-a',
	widgetId: 'widget-a',
} as const

const rect = { x: 0, y: 0, width: 10, height: 10 } as const

const square: Contour = { commands: [
	{ op: 'moveTo', x: 0, y: 0 },
	{ op: 'lineTo', x: 10, y: 0 },
	{ op: 'lineTo', x: 10, y: 10 },
	{ op: 'lineTo', x: 0, y: 10 },
	{ op: 'close' },
] }

function region(regionId: string, maxError: number): VisibleRegion {
	return { regionId, contour: square, maxError }
}

function context(geometryRevision: number, overrides: Partial<ProtocolContext> = {}): ProtocolContext {
	return { ...scope, geometryRevision, ...overrides }
}

function allocator(start = 40) {
	let next = start
	let calls = 0
	return {
		allocate() { calls++; return next++ },
		get calls() { return calls },
	}
}

describe('Preview authoritative contour cache', () => {
	it('allocates a snapshot only after successful atomic acquisition commit and defensively owns the cache', () => {
		const versions = allocator()
		const controller = new ContourCacheController(scope, () => versions.allocate())
		const source = [region('r1', 0.8)]
		controller.beginAcquisition()
		const committed = controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(7), payload: { rect, regions: source },
		})
		expect(committed.status).toBe('committed')
		expect(versions.calls).toBe(1)
		expect(controller.getSnapshot()).toMatchObject({ geometryRevision: 7, snapshotVersion: 40 })
		expect(controller.getSnapshot()?.rect).toEqual(rect)
		;(rect as { x: number }).x = 999
		source[0] = region('evil', 99)
		expect(controller.getSnapshot()?.regions[0]?.regionId).toBe('r1')
		expect(controller.getSnapshot()?.rect.x).toBe(0)
		controller.endAcquisition()
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(8), payload: { rect, regions: [] } }).status).toBe('stale')
		expect(versions.calls).toBe(1)
		expect(controller.getSnapshot()).toBeUndefined()
	})

	it('accepts pushed stream reports with advancing revisions and supersedes contour work of the old revision', () => {
		const versions = allocator()
		const controller = new ContourCacheController(scope, () => versions.allocate())
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [region('r1', 0.8)] } }).status).toBe('stale')
		controller.beginAcquisition()
		expect(controller.isStreamOpen()).toBe(true)
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [region('r1', 0.8)] } }).status).toBe('committed')
		expect(controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 4, targetMaxError: 0.4 } }).status).toBe('started')
		// The runtime pushes a new complete baseline (scroll, reflow…): it replaces the cache atomically.
		const pushed = controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(3), payload: { rect: { x: 0, y: -5, width: 10, height: 10 }, regions: [region('s1', 0.6)] },
		})
		expect(pushed).toMatchObject({ status: 'committed', supersededSequence: 4, snapshot: { geometryRevision: 3, snapshotVersion: 41 } })
		// Work for the superseded revision is stale, and the new revision has its own sequence domain.
		expect(controller.commitFull({ type: 'contour.full.response', context: context(1), payload: { sequence: 4, regions: [region('r1', 0.3)] } }).status).toBe('stale')
		expect(controller.startFull({ type: 'contour.full.request', context: context(3), payload: { sequence: 1, targetMaxError: 0.4 } }).status).toBe('started')
		// Equal or older revisions never replace the stream's current report.
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(3), payload: { rect, regions: [] } }).status).toBe('non-advancing-geometry-revision')
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(2), payload: { rect, regions: [] } }).status).toBe('non-advancing-geometry-revision')
		expect(controller.getSnapshot()?.geometryRevision).toBe(3)
		// A zero-area rect with no regions is a valid report for an unrendered Widget.
		expect(controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(4), payload: { rect: { x: 0, y: 0, width: 0, height: 0 }, regions: [] } })).toMatchObject({ status: 'committed', supersededSequence: 1 })
		expect(controller.startFull({ type: 'contour.full.request', context: context(4), payload: { sequence: 1, targetMaxError: 0.4 } }).status).toBe('started')
		expect(controller.endAcquisition()).toEqual({ supersededSequence: 1 })
		expect(controller.isStreamOpen()).toBe(false)
	})

	it('rejects malformed or stale acquisition without consuming snapshot versions', () => {
		const versions = allocator()
		const controller = new ContourCacheController(scope, () => versions.allocate())
		controller.beginAcquisition()
		expect(controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1, { widgetId: 'other' }), payload: { rect, regions: [] },
		}).status).toBe('stale-context')
		expect(versions.calls).toBe(0)
		expect(controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [region('r1', -1)] },
		}).status).toBe('invalid')
		expect(versions.calls).toBe(0)
	})

	it('keeps geometry revisions and snapshot versions monotonic across invalidation/acquisition boundaries', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.beginAcquisition()
		expect(controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [region('r1', 0.2)] },
		}).status).toBe('non-advancing-geometry-revision')
		expect(versions.calls).toBe(1)
		const committed = controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(2), payload: { rect, regions: [region('n1', 0.2)] },
		})
		expect(committed.status).toBe('committed')
		expect(controller.getSnapshot()).toMatchObject({ geometryRevision: 2, snapshotVersion: 41 })
		expect(versions.calls).toBe(2)
	})

	it('shares one monotonic full/partial sequence domain and reports superseded work for best-effort cancellation', () => {
		const versions = allocator()
		const controller = seededController(versions)
		const full = controller.startFull({
			type: 'contour.full.request', context: context(1), payload: { sequence: 5, targetMaxError: 0.4 },
		})
		expect(full).toEqual({ status: 'started', sequence: 5 })
		const partial = controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 6, baseSnapshotVersion: 40, regionIds: ['r1'], targetMaxError: 0.3 },
		})
		expect(partial).toEqual({ status: 'started', sequence: 6, supersededSequence: 5 })
		expect(controller.startFull({
			type: 'contour.full.request', context: context(1), payload: { sequence: 6, targetMaxError: 0.2 },
		}).status).toBe('non-monotonic-sequence')
	})

	it('rejects late superseded responses and commits only the latest matching sequence', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 1, targetMaxError: 0.4 } })
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 2, targetMaxError: 0.4 } })
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 1, regions: [region('r1', 0.3), region('r2', 0.3)] },
		}).status).toBe('stale')
		expect(versions.calls).toBe(1)
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 2, regions: [region('r2', 0.3), region('r1', 0.3)] },
		}).status).toBe('committed')
		expect(versions.calls).toBe(2)
	})

	it('classifies an older partial sequence as stale before exact-response validation', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 3, baseSnapshotVersion: 40, regionIds: ['r1'], targetMaxError: 0.2 },
		})
		controller.startFull({
			type: 'contour.full.request', context: context(1), payload: { sequence: 4, targetMaxError: 0.2 },
		})
		expect(controller.commitPartial({
			type: 'contour.partial.response', context: context(1),
			payload: { sequence: 3, baseSnapshotVersion: 999, regions: [region('wrong-id', 9)] },
		}).status).toBe('stale')
		expect(versions.calls).toBe(1)
	})

	it('enforces same-revision region identity continuity and equal-or-better full replacement', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 1, targetMaxError: 1 } })
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 1, regions: [region('renamed', 0.2), region('r2', 0.2)] },
		}).status).toBe('region-identity-changed')
		expect(versions.calls).toBe(1)

		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 2, targetMaxError: 1 } })
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 2, regions: [region('r1', 0.9), region('r2', 0.4)] },
		}).status).toBe('not-better')
		expect(versions.calls).toBe(1)
	})

	it('rejects precision misses atomically without consuming a snapshot version', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 1, targetMaxError: 0.2 } })
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 1, regions: [region('r1', 0.1), region('r2', 0.3)] },
		}).status).toBe('precision-miss')
		expect(versions.calls).toBe(1)
		expect(controller.getSnapshot()?.regions.map(item => item.maxError)).toEqual([0.8, 0.6])
	})

	it('retires a matching full work item after terminal rejection so duplicates are stale and retry is fresh', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 1, targetMaxError: 0.2 } })
		const rejected = {
			type: 'contour.full.response' as const,
			context: context(1),
			payload: { sequence: 1, regions: [region('r1', 0.3), region('r2', 0.3)] },
		}
		expect(controller.commitFull(rejected).status).toBe('precision-miss')
		expect(controller.commitFull(rejected).status).toBe('stale')
		expect(controller.startFull({
			type: 'contour.full.request', context: context(1), payload: { sequence: 2, targetMaxError: 0.2 },
		})).toEqual({ status: 'started', sequence: 2 })
	})

	it('admits partial refinement only for regions that are currently out of the requested tolerance', () => {
		const versions = allocator()
		const controller = seededController(versions)
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r2'], targetMaxError: 0.6 },
		}).status).toBe('region-already-in-tolerance')
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r2'], targetMaxError: 0.59 },
		}).status).toBe('started')
	})

	it('binds partial refinement to the exact authoritative base and exact requested region set', () => {
		const versions = allocator()
		const controller = seededController(versions)
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 39, regionIds: ['r1'], targetMaxError: 0.2 },
		}).status).toBe('stale-base')
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['missing'], targetMaxError: 0.2 },
		}).status).toBe('unknown-region')
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r1', 'r2'], targetMaxError: 0.2 },
		}).status).toBe('started')
		expect(controller.commitPartial({
			type: 'contour.partial.response', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regions: [region('r1', 0.1)] },
		}).status).toBe('invalid')
		expect(versions.calls).toBe(1)
	})

	it('retires a matching partial work item after an invalid exact patch response', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r1', 'r2'], targetMaxError: 0.2 },
		})
		const invalid = {
			type: 'contour.partial.response' as const,
			context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regions: [region('r1', 0.1)] },
		}
		expect(controller.commitPartial(invalid).status).toBe('invalid')
		expect(controller.commitPartial(invalid).status).toBe('stale')
		expect(controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 2, baseSnapshotVersion: 40, regionIds: ['r1', 'r2'], targetMaxError: 0.2 },
		})).toEqual({ status: 'started', sequence: 2 })
	})

	it('atomically merges an in-tolerance partial patch while preserving untouched regions', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r1'], targetMaxError: 0.2 },
		})
		const result = controller.commitPartial({
			type: 'contour.partial.response', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regions: [region('r1', 0.1)] },
		})
		expect(result.status).toBe('committed')
		expect(controller.getSnapshot()).toMatchObject({ snapshotVersion: 41 })
		expect(controller.getSnapshot()?.rect).toEqual(rect)
		expect(controller.getSnapshot()?.regions.map(item => [item.regionId, item.maxError])).toEqual([['r1', 0.1], ['r2', 0.6]])
	})

	it('rejects a partial response when its base became stale before commit', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startPartial({
			type: 'contour.partial.request', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regionIds: ['r1'], targetMaxError: 0.2 },
		})
		controller.beginAcquisition()
		controller.commitAcquisition({ type: 'geometry.acquire.response', context: context(2), payload: { rect, regions: [region('n1', 0.2)] } })
		expect(controller.commitPartial({
			type: 'contour.partial.response', context: context(1),
			payload: { sequence: 1, baseSnapshotVersion: 40, regions: [region('r1', 0.1)] },
		}).status).toBe('stale')
		expect(versions.calls).toBe(2)
	})

	it('retires now-unnecessary pending work when the authoritative cache already meets the latest display precision', () => {
		const versions = allocator()
		const controller = seededController(versions)
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 8, targetMaxError: 0.1 } })
		expect(controller.retireActiveWorkIfCacheMeets(1)).toEqual({ retiredSequence: 8 })
		expect(controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 8, regions: [region('r1', 0.05), region('r2', 0.05)] },
		}).status).toBe('stale')
		expect(versions.calls).toBe(1)
	})

	it('keeps acquisition uncommitted when snapshot allocation fails before the rect/cache commit boundary', () => {
		let call = 0
		const controller = new ContourCacheController(scope, () => call++ === 0 ? -1 : 50)
		controller.beginAcquisition()
		expect(() => controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1),
			payload: { rect: { x: 1, y: 2, width: 30, height: 40 }, regions: [region('r1', 0.2)] },
		})).toThrow(/non-negative/)
		expect(controller.getSnapshot()).toBeUndefined()
		const committed = controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1),
			payload: { rect: { x: 5, y: 6, width: 70, height: 80 }, regions: [region('r1', 0.2)] },
		})
		expect(committed.status).toBe('committed')
		expect(controller.getSnapshot()?.rect).toEqual({ x: 5, y: 6, width: 70, height: 80 })
	})

	it('requires snapshot allocation to be safe and strictly increasing only when a commit succeeds', () => {
		const controller = new ContourCacheController(scope, previous => previous === undefined ? 4 : previous)
		controller.beginAcquisition()
		expect(controller.commitAcquisition({
			type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [] },
		}).status).toBe('committed')
		controller.startFull({ type: 'contour.full.request', context: context(1), payload: { sequence: 1, targetMaxError: 0.2 } })
		expect(() => controller.commitFull({
			type: 'contour.full.response', context: context(1), payload: { sequence: 1, regions: [] },
		})).toThrow(/strictly increasing/)
	})
})

function seededController(versions: ReturnType<typeof allocator>): ContourCacheController {
	const controller = new ContourCacheController(scope, () => versions.allocate())
	controller.beginAcquisition()
	const result = controller.commitAcquisition({
		type: 'geometry.acquire.response', context: context(1), payload: { rect, regions: [region('r1', 0.8), region('r2', 0.6)] },
	})
	if (result.status !== 'committed') throw new Error('seed failed')
	return controller
}
