import { createHash } from 'node:crypto'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ThumbnailCaptureOutcome, ThumbnailCapturer, ThumbnailInputsSource, ThumbnailPlan, ThumbnailStore } from '../src/application/ports/thumbnails'
import type { KitBuildStatus } from '../src/application/ports/kit-build'
import { createChangeEventBus, type ChangeEvent } from '../src/application/services/change-events'
import { createThumbnailService, THUMBNAIL_CEILING_MS, THUMBNAIL_FAILURE_INTERVAL_MS, THUMBNAIL_QUIET_MS, type ThumbnailService } from '../src/application/services/thumbnails'
import { thumbnailDigestHex } from '../src/domain/thumbnails/digest'

/**
 * The thumbnail worker (Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c) with in-memory inputs, store and
 * capturer under fake timers, so the quiet period, the ceiling, the queue, the hold and the failure
 * interval are exercised at their real values without waiting.
 */
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const CONTEXT = { viewId: A, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47])

const digestOf = (label: string) => `sha256:${createHash('sha256').update(label).digest('hex')}`

type Harness = ReturnType<typeof setup>

function setup() {
	const bus = createChangeEventBus()
	/** The current digest of each existing View (`undefined`: it cannot be computed). */
	const views = new Map<string, string | undefined>()
	const files = new Map<string, Map<string, number>>()
	const removed: string[] = []
	const captures: string[] = []
	const events: ChangeEvent[] = []
	bus.subscribe(event => events.push(event))
	const state = {
		localeMissing: false,
		kit: { state: 'ready' } as KitBuildStatus,
		outcome: { ok: true, png: PNG } as ThumbnailCaptureOutcome,
		gate: undefined as Promise<void> | undefined,
		closed: 0,
		inFlight: 0,
		maxInFlight: 0,
	}
	const inputs: ThumbnailInputsSource = {
		plans: async keys => [...views]
			.filter(([key]) => !keys || keys.includes(key))
			.map(([key, digest]): ThumbnailPlan => ({ key, context: { ...CONTEXT, viewId: key }, ...(digest ? { digest } : {}) })),
		defaultLocaleMissing: async () => state.localeMissing,
	}
	const store: ThumbnailStore = {
		list: async key => [...(files.get(key) ?? [])].map(([digest, modifiedMs]) => ({ digest, modifiedMs })),
		read: async (key, digest) => files.get(key)?.has(digest) ? PNG : undefined,
		write: async (key, digest) => { files.set(key, new Map([[digest, Date.now()]])) },
		remove: async (key) => { files.delete(key); removed.push(key) },
		views: async () => [...files.keys()],
	}
	const capturer: ThumbnailCapturer = {
		capture: async ({ key }) => {
			captures.push(key)
			state.inFlight += 1
			state.maxInFlight = Math.max(state.maxInFlight, state.inFlight)
			try {
				await state.gate
				return state.outcome
			}
			finally { state.inFlight -= 1 }
		},
		close: async () => { state.closed += 1 },
	}
	const service = createThumbnailService({ inputs, store, capturer, events: bus, kitBuild: () => state.kit })
	service.start()
	return {
		bus,
		views,
		files,
		removed,
		captures,
		events,
		state,
		service,
		/** A stored file for `label`'s digest, as if captured before. */
		store(key: string, label: string) { files.set(key, new Map([[thumbnailDigestHex(digestOf(label)), Date.now()]])) },
		write(kind: string, key = A) { bus.publish({ type: 'resource.changed', kind: kind as 'view', key, revision: 'r1' as never }) },
		thumbnailEvents: () => events.filter(event => event.type === 'thumbnail.changed').map(event => (event as { key: string }).key),
	}
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms)

let h: Harness
let service: ThumbnailService
beforeEach(() => {
	vi.useFakeTimers()
	h = setup()
	service = h.service
})
afterEach(async () => {
	await service.stop()
	vi.useRealTimers()
})

describe('the quiet period (Rule 01a19b99-d2cb-79ae-9e3d-ba6c24bc1f6a)', () => {
	it('captures a burst of writes once, after 10 seconds without a write (Scenario 01a19b99-e1bc-7f09-b7a8-b205513d1d7a)', async () => {
		h.views.set(A, digestOf('v1'))
		h.store(A, 'v1')
		h.views.set(A, digestOf('v2')) // the View changed: its thumbnail is stale
		for (let write = 0; write < 3; write++) {
			h.write('view')
			await advance(THUMBNAIL_QUIET_MS - 1000)
		}
		expect(h.captures).toEqual([])
		await advance(THUMBNAIL_QUIET_MS)
		expect(h.captures).toEqual([A])
		expect([...h.files.get(A)!.keys()]).toEqual([thumbnailDigestHex(digestOf('v2'))])
	})

	it('restarts on a write of a rendering kind only', async () => {
		h.views.set(A, digestOf('v1'))
		h.write('view')
		await advance(THUMBNAIL_QUIET_MS - 1)
		h.write('review') // not a kind that affects rendering
		await advance(1)
		expect(h.captures).toEqual([A])
	})

	it.each(['view', 'locale', 'asset', 'workspace', 'product-kit'])('is restarted by a write of kind %s', async (kind) => {
		h.views.set(A, digestOf('v1'))
		h.write(kind, kind === 'locale' ? 'en-US' : A)
		await advance(THUMBNAIL_QUIET_MS - 1000)
		h.write(kind, kind === 'locale' ? 'en-US' : A)
		await advance(THUMBNAIL_QUIET_MS - 1)
		expect(h.captures).toEqual([])
		await advance(1)
		expect(h.captures).toEqual([A])
	})

	it('is restarted by a new kit build output generation', async () => {
		h.views.set(A, digestOf('v1'))
		h.write('view')
		await advance(THUMBNAIL_QUIET_MS - 1000)
		h.state.kit = { state: 'ready', outputVersion: '1.1' }
		await advance(THUMBNAIL_QUIET_MS - 1000)
		expect(h.captures).toEqual([]) // the 10 s of the write alone have passed
		await advance(1500) // the worker notices the output within its poll interval
		expect(h.captures).toEqual([A])
	})

	it('queues only the Views whose thumbnail is missing or stale (Rule 01a19b99-d383-7c4f-ad37-402eca1ef90e)', async () => {
		h.views.set(A, digestOf('a'))
		h.views.set(B, digestOf('b'))
		h.store(A, 'a') // fresh
		h.write('view')
		await advance(THUMBNAIL_QUIET_MS)
		expect(h.captures).toEqual([B])
	})
})

describe('the ceiling (Rule 01a19bac-ea4d-79eb-9c1b-0c887270b5d5)', () => {
	it('starts a pass 60 seconds after the first change, whatever follows (Scenario 01a19bac-eca4-78e9-a9b8-f522b0c9af04)', async () => {
		h.views.set(A, digestOf('v1'))
		h.store(A, 'v1')
		h.views.set(A, digestOf('v2'))
		let elapsed = 0
		while (elapsed < THUMBNAIL_CEILING_MS - 5000) {
			h.write('view')
			await advance(5000)
			elapsed += 5000
		}
		expect(h.captures).toEqual([])
		h.write('view') // at 55 s
		await advance(5000 - 1)
		expect(h.captures).toEqual([])
		await advance(1) // 60 s after the first change
		expect(h.captures).toEqual([A])
	})

	it('covers the changes that follow by a later pass', async () => {
		h.views.set(A, digestOf('v1'))
		for (let elapsed = 0; elapsed < 90_000; elapsed += 5000) {
			h.write('view')
			h.views.set(A, digestOf(`v${elapsed}`))
			await advance(5000)
		}
		expect(h.captures).toEqual([A]) // the pass at 60 s
		await advance(THUMBNAIL_QUIET_MS)
		expect(h.captures).toEqual([A, A]) // the changes after it, once they waited
	})
})

describe('the queue (Rule 01a19b99-d509-708b-8d53-ac59f3ea0413)', () => {
	it('runs one capture at a time and queues a View once', async () => {
		h.views.set(A, digestOf('a'))
		h.views.set(B, digestOf('b'))
		let release!: () => void
		h.state.gate = new Promise<void>((resolve) => { release = resolve })
		await service.request([A, B])
		await service.request([A, B])
		await advance(100)
		expect(h.captures).toEqual([A])
		release()
		await advance(100)
		expect(h.captures).toEqual([A, B])
		expect(h.state.maxInFlight).toBe(1)
	})

	it('closes the capture browser once the queue is empty', async () => {
		h.views.set(A, digestOf('a'))
		await service.request([A])
		await advance(100)
		expect(h.state.closed).toBeGreaterThan(0)
	})
})

describe('a request (Rule 01a19b99-d42e-7b72-b30b-480057b269d9)', () => {
	it('queues the named missing and stale Views at once, not the fresh ones', async () => {
		h.views.set(A, digestOf('a'))
		h.views.set(B, digestOf('b'))
		h.store(B, 'b')
		const listed = await service.request([A, B])
		await advance(10)
		expect(h.captures).toEqual([A])
		expect(listed.map(item => [item.key, item.state])).toEqual([[A, 'missing'], [B, 'fresh']])
	})

	it('names no View that does not exist', async () => {
		h.views.set(A, digestOf('a'))
		expect(await service.request(['33333333-3333-4333-8333-333333333333'])).toEqual([])
	})

	it('does not capture on a plain read or list (Rule 01a19b99-d8d5-742c-97aa-1b8701b909f7)', async () => {
		h.views.set(A, digestOf('a'))
		expect(await service.read(A)).toBeUndefined()
		await service.list([A])
		await advance(THUMBNAIL_QUIET_MS * 2)
		expect(h.captures).toEqual([])
	})
})

describe('a hold (Rule 01a19b99-d5e3-7c51-a1f5-2ea86f20f9f6)', () => {
	it.each([
		['the kit build is running', (hh: Harness) => { hh.state.kit = { state: 'building' } }, (hh: Harness) => { hh.state.kit = { state: 'ready' } }],
		['the kit build failed', (hh: Harness) => { hh.state.kit = { state: 'failed', message: 'x' } }, (hh: Harness) => { hh.state.kit = { state: 'ready' } }],
		['the default Locale has no Locale file', (hh: Harness) => { hh.state.localeMissing = true }, (hh: Harness) => { hh.state.localeMissing = false }],
	])('captures nothing while %s, keeps the View queued, and resumes after', async (_name, hold, lift) => {
		h.views.set(A, digestOf('a'))
		hold(h)
		const listed = await service.request([A])
		await advance(THUMBNAIL_QUIET_MS * 3)
		expect(h.captures).toEqual([])
		// Queued, but a View held back is not refreshing (Rule 01a19b99-d985-7c77-9420-1c5a19db7c69).
		expect(listed[0]).toMatchObject({ key: A, state: 'missing', refreshing: false })
		expect((await service.list([A]))[0]!.refreshing).toBe(false)
		lift(h)
		await advance(1000)
		expect(h.captures).toEqual([A])
	})

	it('lists a queued View as refreshing while nothing holds it back', async () => {
		h.views.set(A, digestOf('a'))
		let release!: () => void
		h.state.gate = new Promise<void>((resolve) => { release = resolve })
		const listed = await service.request([A])
		expect(listed[0]!.refreshing).toBe(true)
		release()
		await advance(100)
		expect((await service.list([A]))[0]).toMatchObject({ state: 'fresh', refreshing: false })
	})
})

describe('a failed capture (Rules 01a19b99-d6a9-7208-912e-f154133e553b and 01a19b99-d760-7e54-9a5e-1d98e9306de7)', () => {
	it('changes no stored thumbnail, leaves it stale, and is not queued again by a request within 60 seconds', async () => {
		h.views.set(A, digestOf('v1'))
		h.store(A, 'v1')
		h.views.set(A, digestOf('v2'))
		const before = new Map(h.files.get(A)!)
		h.state.outcome = { ok: false, reason: 'cannot render' }
		await service.request([A])
		await advance(100)
		expect(h.captures).toEqual([A])
		expect(h.files.get(A)).toEqual(before)
		expect((await service.list([A]))[0]).toMatchObject({ state: 'stale', refreshing: false })

		await advance(THUMBNAIL_FAILURE_INTERVAL_MS - 1000)
		await service.request([A])
		await advance(100)
		expect(h.captures).toEqual([A])

		await advance(1000)
		await service.request([A])
		await advance(100)
		expect(h.captures).toEqual([A, A])
	})

	it('does not stop the quiet-period pass from trying the View again', async () => {
		h.views.set(A, digestOf('v1'))
		h.state.outcome = { ok: false, reason: 'cannot render' }
		await service.request([A])
		await advance(100)
		h.write('view')
		await advance(THUMBNAIL_QUIET_MS)
		expect(h.captures).toEqual([A, A])
	})

	it('fails a View whose thumbnail input digest cannot be computed without capturing, and keeps what is stored', async () => {
		h.views.set(A, undefined)
		h.store(A, 'old')
		const before = new Map(h.files.get(A)!)
		const listed = await service.request([A])
		expect(listed[0]!.state).toBe('stale') // Clause 01a19b99-cd8b-7a8d-a357-5a55fa9453d7: also when the digest cannot be computed
		await advance(100)
		expect(h.captures).toEqual([])
		expect(h.files.get(A)).toEqual(before)
		await service.request([A])
		await advance(100)
		expect(h.captures).toEqual([]) // and the failure interval applies to it too
	})

	it('treats a View without a file and without a digest as missing', async () => {
		h.views.set(A, undefined)
		expect((await service.list([A]))[0]!.state).toBe('missing')
	})
})

describe('a removed View (Rule 01a19b99-d814-7fdf-8742-5f7fad22684a)', () => {
	it('is dropped from the queue and its thumbnail deleted', async () => {
		h.views.set(A, digestOf('a'))
		h.views.set(B, digestOf('b'))
		h.store(B, 'old')
		let release!: () => void
		h.state.gate = new Promise<void>((resolve) => { release = resolve })
		await service.request([A, B])
		await advance(10) // A in flight, B queued
		h.views.delete(B)
		h.bus.publish({ type: 'resource.removed', kind: 'view', key: B })
		await advance(10)
		release()
		await advance(100)
		expect(h.captures).toEqual([A])
		expect(h.removed).toContain(B)
		expect(h.files.has(B)).toBe(false)
	})

	it('has its thumbnail deleted by the next pass when it was removed while no server ran', async () => {
		h.views.set(A, digestOf('a'))
		h.store(A, 'a')
		h.store(B, 'gone') // a cache directory of a View that no longer exists
		h.write('view')
		await advance(THUMBNAIL_QUIET_MS)
		expect(h.files.has(B)).toBe(false)
		expect(h.files.has(A)).toBe(true)
	})
})

describe('the change event (Rule 01a19b99-da51-7960-9a2a-9e26a9324cbc, Clause 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7)', () => {
	it('is sent when a thumbnail is stored and when the View enters and leaves the queue, carrying only the key', async () => {
		h.views.set(A, digestOf('a'))
		await service.request([A])
		await advance(100)
		const events = h.events.filter(event => event.type === 'thumbnail.changed')
		// queued (refreshing on), stored, refreshing off
		expect(events.length).toBeGreaterThanOrEqual(2)
		for (const event of events) expect(event).toEqual({ type: 'thumbnail.changed', key: A })
		expect(h.thumbnailEvents().filter(key => key === A).length).toBeGreaterThanOrEqual(2)
	})

	it('is sent for a View that stops or starts refreshing as a hold begins and ends', async () => {
		h.views.set(A, digestOf('a'))
		await service.request([A])
		await advance(100)
		h.events.length = 0
		h.views.set(A, digestOf('a2'))
		h.state.kit = { state: 'building' }
		await service.request([A])
		await advance(1000)
		// queued while held: it never started refreshing, so nothing was announced
		expect(h.thumbnailEvents()).toEqual([])
		h.state.kit = { state: 'ready' }
		await advance(1000)
		expect(h.thumbnailEvents()).toContain(A)
	})

	it('is sent when no thumbnail is stored by a failure, but the refreshing state leaves the View', async () => {
		h.views.set(A, digestOf('a'))
		h.state.outcome = { ok: false, reason: 'x' }
		await service.request([A])
		await advance(100)
		expect(h.thumbnailEvents().length).toBeGreaterThanOrEqual(2) // refreshing on, then off
		expect(h.files.has(A)).toBe(false)
	})
})

describe('reading (Rule 01a19b99-d8d5-742c-97aa-1b8701b909f7)', () => {
	it('returns the stored image of a fresh or stale thumbnail, and nothing while it is missing', async () => {
		h.views.set(A, digestOf('a'))
		expect(await service.read(A)).toBeUndefined()
		h.store(A, 'a')
		expect(await service.read(A)).toEqual(PNG)
		h.views.set(A, digestOf('a2')) // now stale
		expect(await service.read(A)).toEqual(PNG)
		expect(await service.read('not-a-view-key')).toBeUndefined()
	})
})
