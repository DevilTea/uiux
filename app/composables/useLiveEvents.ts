import { getCurrentScope, onScopeDispose, readonly, shallowRef } from 'vue'

/**
 * The Workbench's one subscription to the change-event stream `GET /api/events` (Feature "Live
 * refresh", 01a111e4-0315-7755-b867-e3c7b50d22e6; wire owned by Clause
 * 01a114ec-e839-7b11-957c-41c88b692e12). The shell starts it once per signed-in Workbench session;
 * surfaces subscribe to what they show and re-read it through the normal point-read and list APIs,
 * because events carry no content (Rule 01a11485-f382-7307-b0c1-a1947715cf03).
 *
 * - Events arriving close together are delivered as one batch, deduplicated per resource, so an
 *   Agent's burst of writes costs one re-read.
 * - Nothing is replayed (Rule 01a11485-f39f-7464-9f8f-608335ed9800): every `hello` (the first of a
 *   session, a reconnect, or a restarted server) gives subscribers a `resync` to re-read everything
 *   they show, because a write between a page's first reads and the server accepting its stream is
 *   never sent (#281).
 * - When the stream cannot connect (no `EventSource`, refused, or dropped), the state is `fallback`
 *   and subscribers get a `resync` every `FALLBACK_POLL_MS` while the page is visible (Rule
 *   01a11485-f3d9-7663-b344-a60c2a949e5e). A dropped stream reconnects by itself; a refused one
 *   (401, 403, the 429 stream limit) is retried after `REFUSED_RETRY_MS`.
 * - Liveness (Discussion #241, https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19070362):
 *   a stream that sends no `hello` within `HELLO_TIMEOUT_MS` of connecting, or nothing (an event or
 *   the `heartbeat` the server sends about every 20 seconds) for `SILENCE_TIMEOUT_MS`, is closed and
 *   opened again; after `LIVENESS_FAILURES_BEFORE_FALLBACK` such failures in a row the Workbench
 *   polls, and tries the stream again after `REFUSED_RETRY_MS`. The next `hello` resyncs.
 */
export type LiveState = 'idle' | 'connecting' | 'open' | 'fallback'

export type LiveResourceChange = Readonly<{ kind: string; key: string; revision?: string; removed: boolean }>

/** `resync`: re-read everything shown; otherwise only `changes` (one entry per resource, the latest). */
export type LiveBatch = Readonly<{ resync: boolean; changes: readonly LiveResourceChange[] }>

export const LIVE_EVENTS_PATH = '/api/events'
export const LIVE_BATCH_MS = 150
export const FALLBACK_POLL_MS = 15_000
export const REFUSED_RETRY_MS = 60_000
/** The server's heartbeat interval (Clause 01a114ec-e839-7b11-957c-41c88b692e12). */
export const SERVER_HEARTBEAT_MS = 20_000
/** How long a new stream may take to send `hello`. */
export const HELLO_TIMEOUT_MS = 10_000
/** How long an open stream may stay silent: two and a half heartbeat intervals. */
export const SILENCE_TIMEOUT_MS = SERVER_HEARTBEAT_MS * 5 / 2
/** Liveness failures in a row after which the Workbench polls instead of reopening the stream at once. */
export const LIVENESS_FAILURES_BEFORE_FALLBACK = 3

const state = shallowRef<LiveState>('idle')
const resourceListeners = new Set<(batch: LiveBatch) => void>()
const lockListeners = new Set<() => void>()
const accessListeners = new Set<() => void>()
const restartListeners = new Set<() => void>()
/**
 * The server instance ID last seen by this page, from any `/api/*` response (the
 * `X-UIUX-Server-Instance` header) or a `hello`'s `serverInstanceId`. It outlives `stop()`, so a
 * page that signs in again after the server restarted still tells the new instance apart.
 */
let serverInstanceId: string | undefined

let source: EventSource | undefined
let started = false
let pendingChanges = new Map<string, LiveResourceChange>()
let pendingResync = false
let pendingLocks = false
let pendingAccess = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let fallbackTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
/** Fires when the stream sent no `hello` in time, or went silent. */
let livenessTimer: ReturnType<typeof setTimeout> | undefined
/** Liveness failures since the last `hello`. */
let livenessFailures = 0

function call(listeners: ReadonlySet<() => void>): void {
	for (const listener of [...listeners]) {
		try { listener() }
		catch (error) { console.error(error) }
	}
}

/**
 * The one comparison behind restart detection (Rule 01a1161c-3b51-7ebd-bff2-987863a7c1cb, Clause
 * 01a175ec-c8cb-7cf3-bc94-1168ed11e3a9), fed by every `/api/*` response and every `hello`: the
 * first ID seen seeds it, an ID that differs from the last one seen reports a restart once, and a
 * later sighting of that same ID (the `hello` after the header that already told) reports nothing.
 */
export function observeServerInstance(instance: unknown): void {
	if (typeof instance !== 'string' || !instance || instance === serverInstanceId) return
	const restarted = serverInstanceId !== undefined
	serverInstanceId = instance
	if (restarted) call(restartListeners)
}

/** Forgets the seen server instance (tests). */
export function resetServerInstance(): void {
	serverInstanceId = undefined
}

function flush(): void {
	flushTimer = undefined
	const batch: LiveBatch = { resync: pendingResync, changes: [...pendingChanges.values()] }
	const locks = pendingLocks || pendingResync
	const access = pendingAccess || pendingResync
	pendingChanges = new Map()
	pendingResync = false
	pendingLocks = false
	pendingAccess = false
	if (batch.resync || batch.changes.length > 0) {
		for (const listener of [...resourceListeners]) {
			try { listener(batch) }
			catch (error) { console.error(error) }
		}
	}
	if (access) call(accessListeners)
	if (locks) call(lockListeners)
}

function schedule(): void {
	flushTimer ??= setTimeout(flush, LIVE_BATCH_MS)
}

function queueResync(): void {
	pendingResync = true
	schedule()
}

function parse(event: MessageEvent): Record<string, unknown> | undefined {
	try {
		const data = JSON.parse(String(event.data)) as unknown
		return typeof data === 'object' && data !== null && !Array.isArray(data) ? data as Record<string, unknown> : undefined
	}
	catch { return undefined }
}

function queueResource(event: MessageEvent, removed: boolean): void {
	const data = parse(event)
	if (!data || typeof data.kind !== 'string' || typeof data.key !== 'string') return
	const change: LiveResourceChange = { kind: data.kind, key: data.key, removed, ...(!removed && typeof data.revision === 'string' ? { revision: data.revision } : {}) }
	pendingChanges.set(`${change.kind}\u0000${change.key}`, change)
	schedule()
}

function startFallback(): void {
	if (!started) return
	state.value = 'fallback'
	fallbackTimer ??= setInterval(() => {
		if (typeof document === 'undefined' || document.visibilityState === 'visible') queueResync()
	}, FALLBACK_POLL_MS)
}

function stopFallback(): void {
	if (fallbackTimer) clearInterval(fallbackTimer)
	fallbackTimer = undefined
}

function clearLiveness(): void {
	if (livenessTimer) clearTimeout(livenessTimer)
	livenessTimer = undefined
}

/** (Re)arms the liveness watchdog of `stream`: `hello` is due within `ms`, or the next sign of life. */
function armLiveness(stream: EventSource, ms: number): void {
	clearLiveness()
	livenessTimer = setTimeout(() => {
		livenessTimer = undefined
		if (source === stream) stale(stream)
	}, ms)
}

function scheduleRetry(): void {
	retryTimer ??= setTimeout(() => {
		retryTimer = undefined
		connect()
	}, REFUSED_RETRY_MS)
}

/** The stream sent no `hello` in time, or went silent: drop it and open it again, or poll after repeated failures. */
function stale(stream: EventSource): void {
	stream.close()
	source = undefined
	livenessFailures += 1
	// Whatever was sent meanwhile is lost: the next `hello` resyncs.
	// Poll while the reopened stream owes its `hello`; that `hello` stops it.
	startFallback()
	if (livenessFailures >= LIVENESS_FAILURES_BEFORE_FALLBACK) {
		scheduleRetry()
		return
	}
	connect()
}

function connect(): void {
	if (!started || source) return
	if (typeof EventSource === 'undefined') {
		startFallback()
		return
	}
	if (state.value !== 'fallback') state.value = 'connecting'
	const stream = new EventSource(LIVE_EVENTS_PATH)
	source = stream
	armLiveness(stream, HELLO_TIMEOUT_MS)
	/** Any event is a sign of life once `hello` arrived. */
	const alive = () => { if (state.value === 'open' && source === stream) armLiveness(stream, SILENCE_TIMEOUT_MS) }
	stream.addEventListener('hello', (event) => {
		// A `hello` naming another server instance than the last one seen: the server restarted, and
		// every Preview session of the page starts over (Rule 01a1161c-3b51-7ebd-bff2-987863a7c1cb).
		observeServerInstance(parse(event as MessageEvent)?.serverInstanceId)
		livenessFailures = 0
		stopFallback()
		state.value = 'open'
		armLiveness(stream, SILENCE_TIMEOUT_MS)
		// Whatever changed while no stream was open was not sent and is not replayed. That includes the
		// gap between a page's first reads and the server accepting its stream, so the first `hello`
		// resyncs too (one extra quiet re-read per session start, #281).
		queueResync()
	})
	stream.addEventListener('heartbeat', alive)
	stream.addEventListener('resource.changed', (event) => {
		alive()
		queueResource(event as MessageEvent, false)
	})
	stream.addEventListener('resource.removed', (event) => {
		alive()
		queueResource(event as MessageEvent, true)
	})
	stream.addEventListener('lock.changed', () => {
		alive()
		pendingLocks = true
		schedule()
	})
	stream.addEventListener('access.changed', () => {
		alive()
		pendingAccess = true
		schedule()
	})
	stream.onerror = () => {
		if (source !== stream) return
		startFallback()
		if (stream.readyState !== EventSource.CLOSED) {
			// EventSource reconnects by itself: the new connection owes a `hello` in time.
			armLiveness(stream, HELLO_TIMEOUT_MS)
			return
		}
		// Refused (a non-2xx answer) or not an event stream: EventSource gives up, so retry later.
		clearLiveness()
		stream.close()
		source = undefined
		scheduleRetry()
	}
}

/** Opens the stream (idempotent). The shell calls it while a member is signed in. */
function start(): void {
	if (started) return
	started = true
	connect()
}

/** Closes the stream and stops the fallback polling (sign-out, leaving the shell). */
function stop(): void {
	started = false
	source?.close()
	source = undefined
	stopFallback()
	if (retryTimer) clearTimeout(retryTimer)
	retryTimer = undefined
	clearLiveness()
	livenessFailures = 0
	if (flushTimer) clearTimeout(flushTimer)
	flushTimer = undefined
	pendingChanges = new Map()
	pendingResync = pendingLocks = pendingAccess = false
	state.value = 'idle'
}

function subscribe<T>(listeners: Set<T>, listener: T): () => void {
	listeners.add(listener)
	const remove = () => { listeners.delete(listener) }
	if (getCurrentScope()) onScopeDispose(remove)
	return remove
}

export function useLiveEvents() {
	return {
		state: readonly(state),
		start,
		stop,
		/** Batches of resource changes, or `resync`; removed when the calling scope ends. */
		onResources: (listener: (batch: LiveBatch) => void) => subscribe(resourceListeners, listener),
		/** A lease was acquired, released, ended or force-released, or a resync is due. */
		onLocks: (listener: () => void) => subscribe(lockListeners, listener),
		/**
		 * An `/api/*` response or a `hello` named a server instance other than the previous one: the
		 * server restarted. Called once, at once (before the resync a `hello` also queues).
		 */
		onServerRestart: (listener: () => void) => subscribe(restartListeners, listener),
		/** The roster or the member's keys changed, or a resync is due. */
		onAccess: (listener: () => void) => subscribe(accessListeners, listener),
	}
}

/** The keys of `kind` a batch names, or `undefined` when everything should be re-read (`resync`). */
export function changedKeys(batch: LiveBatch, kind: string): ReadonlySet<string> | undefined {
	if (batch.resync) return undefined
	return new Set(batch.changes.filter(change => change.kind === kind).map(change => change.key))
}

/** Whether a batch asks for a re-read of any of `kinds`. */
export function touchesKinds(batch: LiveBatch, kinds: readonly string[]): boolean {
	return batch.resync || batch.changes.some(change => kinds.includes(change.kind))
}
