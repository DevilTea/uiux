import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { FALLBACK_POLL_MS, HELLO_TIMEOUT_MS, LIVE_BATCH_MS, LIVE_EVENTS_PATH, LIVENESS_FAILURES_BEFORE_FALLBACK, REFUSED_RETRY_MS, SERVER_HEARTBEAT_MS, SILENCE_TIMEOUT_MS, changedKeys, observeServerInstance, resetServerInstance, touchesKinds, useLiveEvents, type LiveBatch } from '../app/composables/useLiveEvents'

/**
 * The Workbench side of live refresh (Rules 01a11485-f39f-7464-9f8f-608335ed9800 and
 * 01a11485-f3d9-7663-b344-a60c2a949e5e): batching, resync on a reconnect or a restarted server,
 * and polling while the stream cannot connect. A stand-in `EventSource` plays the server.
 */
class FakeEventSource {
	static readonly CONNECTING = 0
	static readonly OPEN = 1
	static readonly CLOSED = 2
	static instances: FakeEventSource[] = []
	readyState = FakeEventSource.CONNECTING
	onerror: (() => void) | null = null
	private readonly listeners = new Map<string, ((event: MessageEvent) => void)[]>()
	constructor(readonly url: string) {
		FakeEventSource.instances.push(this)
	}

	addEventListener(name: string, listener: (event: MessageEvent) => void): void {
		this.listeners.set(name, [...this.listeners.get(name) ?? [], listener])
	}

	emit(name: string, data: unknown): void {
		this.readyState = FakeEventSource.OPEN
		for (const listener of this.listeners.get(name) ?? []) listener({ data: JSON.stringify(data) } as MessageEvent)
	}

	fail(readyState: number): void {
		this.readyState = readyState
		this.onerror?.()
	}

	close(): void {
		this.readyState = FakeEventSource.CLOSED
	}
}

const live = useLiveEvents()
let batches: LiveBatch[]
let locks: number
let access: number
const removers: (() => void)[] = []

beforeEach(() => {
	vi.useFakeTimers()
	FakeEventSource.instances = []
	vi.stubGlobal('EventSource', FakeEventSource)
	vi.stubGlobal('document', { visibilityState: 'visible' })
	batches = []
	locks = 0
	access = 0
	removers.push(live.onResources(batch => batches.push(batch)), live.onLocks(() => { locks += 1 }), live.onAccess(() => { access += 1 }))
})

afterEach(() => {
	live.stop()
	for (const remove of removers.splice(0)) remove()
	vi.unstubAllGlobals()
	vi.useRealTimers()
})

const current = () => FakeEventSource.instances.at(-1)!

/** Delivers the first `hello` and lets its resync (one per session start, #281) pass, so a test sees only what it triggers. */
function openStream(): void {
	current().emit('hello', { serverInstanceId: 'a' })
	vi.advanceTimersByTime(LIVE_BATCH_MS)
	batches.length = 0
	locks = 0
	access = 0
}

describe('useLiveEvents', () => {
	it('opens one stream, and batches the events of a burst into one delivery, one entry per resource', () => {
		live.start()
		live.start()
		expect(FakeEventSource.instances).toHaveLength(1)
		expect(current().url).toBe(LIVE_EVENTS_PATH)
		openStream()
		expect(live.state.value).toBe('open')
		current().emit('resource.changed', { kind: 'view', key: 'v1', revision: 'r1' })
		current().emit('resource.changed', { kind: 'view', key: 'v1', revision: 'r2' })
		current().emit('resource.removed', { kind: 'review', key: 't1' })
		current().emit('lock.changed', { kind: 'view', key: 'v1' })
		expect(batches).toEqual([])
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: false, changes: [
			{ kind: 'view', key: 'v1', revision: 'r2', removed: false },
			{ kind: 'review', key: 't1', removed: true },
		] }])
		expect(locks).toBe(1)
		expect(access).toBe(0)
		expect(changedKeys(batches[0]!, 'view')).toEqual(new Set(['v1']))
		expect(touchesKinds(batches[0]!, ['flow'])).toBe(false)
	})

	it('resyncs everything on the first hello (a write before the stream was accepted is never sent), after a reconnect, and when the server instance changes', () => {
		live.start()
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toEqual([])
		current().emit('hello', { serverInstanceId: 'a' })
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		expect(locks).toBe(1)
		expect(access).toBe(1)
		batches.length = 0
		locks = 0
		access = 0

		// A dropped stream reconnects by itself; meanwhile the Workbench polls.
		current().fail(FakeEventSource.CONNECTING)
		expect(live.state.value).toBe('fallback')
		current().emit('hello', { serverInstanceId: 'a' })
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		expect(locks).toBe(1)
		expect(access).toBe(1)

		// A restarted server names a new instance on the same connection's next hello.
		current().emit('hello', { serverInstanceId: 'b' })
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches.at(-1)).toEqual({ resync: true, changes: [] })
		expect(live.state.value).toBe('open')
	})

	it('reports a server restart once, when a hello names another server instance, before its resync (issue #101)', () => {
		let restarts = 0
		const order: string[] = []
		live.start()
		// The page module remembers the instance of earlier tests: settle on 'a' before listening.
		current().emit('hello', { serverInstanceId: 'a' })
		removers.push(live.onServerRestart(() => {
			restarts += 1
			order.push(`restart:${batches.length}`)
		}))
		// A reconnect to the same instance is no restart.
		current().fail(FakeEventSource.CONNECTING)
		current().emit('hello', { serverInstanceId: 'a' })
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(restarts).toBe(0)
		batches.length = 0

		current().emit('hello', { serverInstanceId: 'b' })
		expect(restarts).toBe(1)
		expect(order).toEqual(['restart:0'])
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		// A hello without an instance ID changes nothing.
		current().emit('hello', {})
		expect(restarts).toBe(1)

		// The known instance outlives sign-out: signing in again to a restarted server is told apart.
		live.stop()
		live.start()
		current().emit('hello', { serverInstanceId: 'c' })
		expect(restarts).toBe(2)
	})

	it('compares the server instance of every API response with the one seen before, and of hello with the same state (issue #317)', () => {
		let restarts = 0
		resetServerInstance()
		removers.push(live.onServerRestart(() => { restarts += 1 }))
		// The first read seeds the instance, with no stream and no hello: nothing to report yet.
		observeServerInstance('a')
		observeServerInstance('a')
		observeServerInstance(null)
		observeServerInstance('')
		expect(restarts).toBe(0)

		// A read naming another instance reports the restart once, with no stream open.
		observeServerInstance('b')
		observeServerInstance('b')
		expect(restarts).toBe(1)

		// The hello that follows the same restart does not report it again, and the next one is told apart.
		live.start()
		current().emit('hello', { serverInstanceId: 'b' })
		expect(restarts).toBe(1)
		current().emit('hello', { serverInstanceId: 'c' })
		expect(restarts).toBe(2)
		// A read of the instance the hello already named reports nothing.
		observeServerInstance('c')
		expect(restarts).toBe(2)
	})

	it('reports a restart seen by a read while the page polls in fallback, with no hello (issue #317)', () => {
		let restarts = 0
		resetServerInstance()
		removers.push(live.onServerRestart(() => { restarts += 1 }))
		vi.stubGlobal('EventSource', undefined)
		live.start()
		expect(live.state.value).toBe('fallback')
		observeServerInstance('a')
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches.at(-1)).toEqual({ resync: true, changes: [] })
		// The poll's re-read names a new instance.
		observeServerInstance('b')
		expect(restarts).toBe(1)
	})

	it('falls back to polling when the stream is refused, and tries the stream again later', () => {
		live.start()
		current().fail(FakeEventSource.CLOSED)
		expect(live.state.value).toBe('fallback')
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches).toHaveLength(2)
		expect(FakeEventSource.instances).toHaveLength(1)
		vi.advanceTimersByTime(REFUSED_RETRY_MS)
		expect(FakeEventSource.instances.length).toBeGreaterThan(1)
		current().emit('hello', { serverInstanceId: 'a' })
		expect(live.state.value).toBe('open')
		const polled = batches.length
		vi.advanceTimersByTime(FALLBACK_POLL_MS * 2)
		// One resync for the reconnect, and no more polling once the stream is open.
		expect(batches.length).toBe(polled + 1)
	})

	it('polls without EventSource, and stops everything on stop()', () => {
		vi.stubGlobal('EventSource', undefined)
		live.start()
		expect(live.state.value).toBe('fallback')
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches).toHaveLength(1)
		live.stop()
		expect(live.state.value).toBe('idle')
		vi.advanceTimersByTime(FALLBACK_POLL_MS * 3)
		expect(batches).toHaveLength(1)
	})

	it('delivers access.changed to the access listeners only', () => {
		live.start()
		openStream()
		current().emit('access.changed', {})
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(access).toBe(1)
		expect(locks).toBe(0)
		expect(batches).toEqual([])
	})
})

describe('useLiveEvents liveness (Discussion #241 owner decision 3)', () => {
	it('reopens a stream that sends no hello in time, keeps one alive on heartbeats, reopens one gone silent, and resyncs on recovery', () => {
		live.start()
		const first = current()
		vi.advanceTimersByTime(HELLO_TIMEOUT_MS)
		expect(first.readyState).toBe(FakeEventSource.CLOSED)
		expect(FakeEventSource.instances).toHaveLength(2)
		current().emit('hello', { serverInstanceId: 'a' })
		expect(live.state.value).toBe('open')
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		// Whatever the first, silent stream missed is read again.
		expect(batches).toEqual([{ resync: true, changes: [] }])

		// Heartbeats keep the stream open past the silence bound.
		for (let beat = 0; beat < 4; beat++) {
			vi.advanceTimersByTime(SERVER_HEARTBEAT_MS)
			current().emit('heartbeat', {})
		}
		expect(FakeEventSource.instances).toHaveLength(2)
		expect(live.state.value).toBe('open')

		// Silence for two and a half heartbeat intervals: closed and reopened.
		expect(SILENCE_TIMEOUT_MS).toBe(SERVER_HEARTBEAT_MS * 2.5)
		const silent = current()
		vi.advanceTimersByTime(SILENCE_TIMEOUT_MS)
		expect(silent.readyState).toBe(FakeEventSource.CLOSED)
		expect(FakeEventSource.instances).toHaveLength(3)
		current().emit('hello', { serverInstanceId: 'a' })
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches).toHaveLength(2)
		expect(batches.at(-1)).toEqual({ resync: true, changes: [] })
	})

	it('polls after repeated liveness failures, then tries the stream again later', () => {
		live.start()
		for (let attempt = 1; attempt < LIVENESS_FAILURES_BEFORE_FALLBACK; attempt++) {
			vi.advanceTimersByTime(HELLO_TIMEOUT_MS)
			expect(FakeEventSource.instances).toHaveLength(attempt + 1)
		}
		vi.advanceTimersByTime(HELLO_TIMEOUT_MS)
		expect(live.state.value).toBe('fallback')
		const opened = FakeEventSource.instances.length
		expect(opened).toBe(LIVENESS_FAILURES_BEFORE_FALLBACK)
		expect(FakeEventSource.instances.every(stream => stream.readyState === FakeEventSource.CLOSED)).toBe(true)
		// The reopens polled already while they owed a hello.
		batches.length = 0
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		vi.advanceTimersByTime(REFUSED_RETRY_MS - FALLBACK_POLL_MS - LIVE_BATCH_MS)
		expect(FakeEventSource.instances).toHaveLength(opened + 1)
		current().emit('hello', { serverInstanceId: 'a' })
		expect(live.state.value).toBe('open')
		vi.advanceTimersByTime(LIVE_BATCH_MS)
		expect(batches.at(-1)).toEqual({ resync: true, changes: [] })
	})

	it('polls while a stream reopened after silence owes its hello, and stops when the hello arrives', () => {
		live.start()
		current().emit('hello', { serverInstanceId: 'a' })
		vi.advanceTimersByTime(SILENCE_TIMEOUT_MS)
		expect(FakeEventSource.instances).toHaveLength(2)
		expect(live.state.value).toBe('fallback')
		batches.length = 0
		vi.advanceTimersByTime(FALLBACK_POLL_MS + LIVE_BATCH_MS)
		expect(batches).toEqual([{ resync: true, changes: [] }])
		current().emit('hello', { serverInstanceId: 'a' })
		expect(live.state.value).toBe('open')
		batches.length = 0
		vi.advanceTimersByTime(FALLBACK_POLL_MS * 2)
		// Only the resync of the recovery, no more polling.
		expect(batches).toEqual([{ resync: true, changes: [] }])
	})

	it('owes a hello again while EventSource reconnects by itself', () => {
		live.start()
		current().emit('hello', { serverInstanceId: 'a' })
		current().fail(FakeEventSource.CONNECTING)
		expect(live.state.value).toBe('fallback')
		vi.advanceTimersByTime(HELLO_TIMEOUT_MS)
		// No hello on the browser's own reconnect: the stream is replaced.
		expect(FakeEventSource.instances).toHaveLength(2)
		current().emit('hello', { serverInstanceId: 'a' })
		expect(live.state.value).toBe('open')
	})
})
