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
 * - Nothing is replayed (Rule 01a11485-f39f-7464-9f8f-608335ed9800): after a reconnect, or when
 *   `hello` names a different server instance (a restart), subscribers get `resync` and re-read
 *   everything they show.
 * - When the stream cannot connect (no `EventSource`, refused, or dropped), the state is `fallback`
 *   and subscribers get a `resync` every `FALLBACK_POLL_MS` while the page is visible (Rule
 *   01a11485-f3d9-7663-b344-a60c2a949e5e). A dropped stream reconnects by itself; a refused one
 *   (401, 403, the 429 stream cap) is retried after `REFUSED_RETRY_MS`.
 */
export type LiveState = 'idle' | 'connecting' | 'open' | 'fallback'

export type LiveResourceChange = Readonly<{ kind: string; key: string; revision?: string; removed: boolean }>

/** `resync`: re-read everything shown; otherwise only `changes` (one entry per resource, the latest). */
export type LiveBatch = Readonly<{ resync: boolean; changes: readonly LiveResourceChange[] }>

export const LIVE_EVENTS_PATH = '/api/events'
export const LIVE_BATCH_MS = 150
export const FALLBACK_POLL_MS = 15_000
export const REFUSED_RETRY_MS = 60_000

const state = shallowRef<LiveState>('idle')
const resourceListeners = new Set<(batch: LiveBatch) => void>()
const lockListeners = new Set<() => void>()
const accessListeners = new Set<() => void>()

let source: EventSource | undefined
let started = false
let serverInstanceId: string | undefined
/** A `hello` was received on an earlier connection, so the next one is a reconnect. */
let connectedBefore = false
let pendingChanges = new Map<string, LiveResourceChange>()
let pendingResync = false
let pendingLocks = false
let pendingAccess = false
let flushTimer: ReturnType<typeof setTimeout> | undefined
let fallbackTimer: ReturnType<typeof setInterval> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined

function call(listeners: ReadonlySet<() => void>): void {
	for (const listener of [...listeners]) {
		try { listener() }
		catch (error) { console.error(error) }
	}
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

function connect(): void {
	if (!started || source) return
	if (typeof EventSource === 'undefined') {
		startFallback()
		return
	}
	if (state.value !== 'fallback') state.value = 'connecting'
	const stream = new EventSource(LIVE_EVENTS_PATH)
	source = stream
	stream.addEventListener('hello', (event) => {
		const id = parse(event as MessageEvent)?.serverInstanceId
		const restarted = serverInstanceId !== undefined && typeof id === 'string' && id !== serverInstanceId
		const reconnected = connectedBefore || state.value === 'fallback'
		if (typeof id === 'string') serverInstanceId = id
		connectedBefore = true
		stopFallback()
		state.value = 'open'
		// Whatever changed while no stream was open was not sent and is not replayed.
		if (restarted || reconnected) queueResync()
	})
	stream.addEventListener('resource.changed', event => queueResource(event as MessageEvent, false))
	stream.addEventListener('resource.removed', event => queueResource(event as MessageEvent, true))
	stream.addEventListener('lock.changed', () => {
		pendingLocks = true
		schedule()
	})
	stream.addEventListener('access.changed', () => {
		pendingAccess = true
		schedule()
	})
	stream.onerror = () => {
		if (source !== stream) return
		startFallback()
		if (stream.readyState !== EventSource.CLOSED) return
		// Refused (a non-2xx answer) or not an event stream: EventSource gives up, so retry later.
		stream.close()
		source = undefined
		retryTimer ??= setTimeout(() => {
			retryTimer = undefined
			connect()
		}, REFUSED_RETRY_MS)
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
	if (flushTimer) clearTimeout(flushTimer)
	flushTimer = undefined
	pendingChanges = new Map()
	pendingResync = pendingLocks = pendingAccess = false
	connectedBefore = false
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
