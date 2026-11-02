import { thumbnailDigestHex } from '../../domain/thumbnails/digest'
import { isFullUuid } from '../../domain/validation'
import { diagnostics } from '../../logging/diagnostics'
import type {
	ThumbnailCapturer,
	ThumbnailInputsSource,
	ThumbnailOperations,
	ThumbnailPlan,
	ThumbnailState,
	ThumbnailStatus,
	ThumbnailStore,
} from '../ports/thumbnails'
import type { KitBuildStatus } from '../ports/kit-build'
import type { ChangeEvent, ChangeEventBus } from './change-events'

/**
 * Clause 01a19b99-ce21-7b2c-b039-f9afa8f95a97: the quiet period is 10 seconds, the ceiling 60
 * seconds, the in-flight limit 1 thumbnail capture (`runPump` runs one at a time) and the failure
 * interval 60 seconds.
 */
export const THUMBNAIL_QUIET_MS = 10_000
export const THUMBNAIL_CEILING_MS = 60_000
export const THUMBNAIL_FAILURE_INTERVAL_MS = 60_000
/** How often the worker looks at the kit build and at a hold that may have ended; not a contract value. */
export const THUMBNAIL_POLL_MS = 500

export type ThumbnailTiming = Readonly<{
	quietMs: number
	ceilingMs: number
	failureIntervalMs: number
	pollMs: number
}>

export const DEFAULT_THUMBNAIL_TIMING: ThumbnailTiming = Object.freeze({
	quietMs: THUMBNAIL_QUIET_MS,
	ceilingMs: THUMBNAIL_CEILING_MS,
	failureIntervalMs: THUMBNAIL_FAILURE_INTERVAL_MS,
	pollMs: THUMBNAIL_POLL_MS,
})

export type ThumbnailServiceOptions = Readonly<{
	inputs: ThumbnailInputsSource
	store: ThumbnailStore
	capturer: ThumbnailCapturer
	/** The change-event bus: its writes restart the quiet period, and `thumbnail.changed` is published on it. */
	events?: ChangeEventBus
	/** The kit build under `uiux dev`; without it no build holds the worker back and no output change is seen. */
	kitBuild?: () => KitBuildStatus
	/** Test-only override of the timing values. */
	timing?: Partial<ThumbnailTiming>
	now?: () => number
}>

/** The operations where no thumbnail worker runs (no `uiux dev` server): no View has a thumbnail and none is captured. */
export const NO_THUMBNAILS: ThumbnailOperations = Object.freeze({
	read: async () => undefined,
	list: async () => [],
	request: async () => [],
})

export interface ThumbnailService extends ThumbnailOperations {
	/** Starts watching writes and the kit build; nothing is captured until a quiet period passed or a request names a View. */
	start(): void
	/** Stops the timers and the subscription, and closes the capture browser. */
	stop(): Promise<void>
	/** Resolves once nothing is queued and no capture runs (for tests and shutdown). */
	idle(): Promise<void>
}

/** The kinds of write that affect how a View renders (Rule 01a19b99-d2cb-79ae-9e3d-ba6c24bc1f6a). */
const RENDERING_KINDS: readonly string[] = ['view', 'locale', 'asset', 'workspace', 'product-kit']

/**
 * The thumbnail worker and its three operations (Feature 01a19b99-c9ee-7dcb-ae96-bbe31f12591c).
 *
 * - One Workspace-wide quiet timer (Rule 01a19b99-d2cb-79ae-9e3d-ba6c24bc1f6a) restarted by a write of a
 *   rendering kind and by a new kit build output generation, and never held past the ceiling counted
 *   from the first change no pass has covered (Rule 01a19bac-ea4d-79eb-9c1b-0c887270b5d5). When it
 *   fires, a pass queues each View whose thumbnail is missing or stale (Rule 01a19b99-d383-7c4f-ad37-402eca1ef90e).
 * - A request queues the named Views at once, except one that failed within the failure interval
 *   (Rules 01a19b99-d42e-7b72-b30b-480057b269d9 and 01a19b99-d760-7e54-9a5e-1d98e9306de7).
 * - One capture runs at a time, a View is queued at most once (Rule 01a19b99-d509-708b-8d53-ac59f3ea0413),
 *   and nothing is captured while a hold applies (Rule 01a19b99-d5e3-7c51-a1f5-2ea86f20f9f6).
 * - A capture that fails stores and deletes nothing (Rule 01a19b99-d6a9-7208-912e-f154133e553b).
 */
export function createThumbnailService(options: ThumbnailServiceOptions): ThumbnailService {
	const timing: ThumbnailTiming = { ...DEFAULT_THUMBNAIL_TIMING, ...options.timing }
	const { inputs, store, capturer, events } = options
	const now = options.now ?? Date.now

	/** Views waiting to be captured, in order, each at most once. */
	const queue: string[] = []
	let inFlight: string | undefined
	/** Set when the View in flight was removed meanwhile: its capture is discarded. */
	let inFlightRemoved = false
	/** When the last capture of a View failed. */
	const failedAt = new Map<string, number>()
	/** The Views announced as refreshing, so a change of the set is announced once. */
	let announced = new Set<string>()
	let held = false

	let started = false
	let stopped = false
	let quietTimer: ReturnType<typeof setTimeout> | undefined
	let pollTimer: ReturnType<typeof setInterval> | undefined
	let unsubscribe: (() => void) | undefined
	/** When the first change that no pass has covered happened, and when the last one did. */
	let firstUncovered: number | undefined
	let lastChange = 0
	let lastKitOutput: string | undefined
	let pumping: Promise<void> | undefined

	function publish(key: string): void {
		const event: ChangeEvent = { type: 'thumbnail.changed', key }
		events?.publish(event)
	}

	/** The Views whose thumbnail is being refreshed: the one in flight, and the queued ones unless a hold applies (Rule 01a19b99-d985-7c77-9420-1c5a19db7c69). */
	function refreshingKeys(): Set<string> {
		const keys = new Set<string>()
		if (inFlight !== undefined) keys.add(inFlight)
		if (!held) for (const key of queue) keys.add(key)
		return keys
	}

	/** Announces each View whose refreshing state changed since the last announcement (Rule 01a19b99-da51-7960-9a2a-9e26a9324cbc). */
	function announce(): void {
		const current = refreshingKeys()
		for (const key of current) if (!announced.has(key)) publish(key)
		for (const key of announced) if (!current.has(key)) publish(key)
		announced = current
	}

	async function refreshHeld(): Promise<boolean> {
		const build = options.kitBuild?.()
		const kitHeld = build?.state === 'building' || build?.state === 'failed'
		held = kitHeld || await inputs.defaultLocaleMissing().catch(() => false)
		return held
	}

	function enqueue(key: string): void {
		if (key === inFlight || queue.includes(key)) return
		queue.push(key)
	}

	function dequeue(key: string): void {
		const index = queue.indexOf(key)
		if (index >= 0) queue.splice(index, 1)
	}

	function stateOf(plan: ThumbnailPlan | undefined, files: readonly Readonly<{ digest: string }>[]): ThumbnailState {
		if (plan?.digest && files.some(file => file.digest === thumbnailDigestHex(plan.digest!))) return 'fresh'
		return files.length > 0 ? 'stale' : 'missing'
	}

	// --- the quiet period ---------------------------------------------------------------------

	/** A write that affects rendering, or a new kit build output: restart the quiet period, within the ceiling. */
	function touch(): void {
		if (stopped) return
		const at = now()
		firstUncovered ??= at
		lastChange = at
		if (quietTimer) clearTimeout(quietTimer)
		const due = Math.min(lastChange + timing.quietMs, firstUncovered + timing.ceilingMs)
		quietTimer = setTimeout(() => { void runPass() }, Math.max(0, due - at))
		quietTimer.unref?.()
	}

	/** The pass the quiet period ends with: every View whose thumbnail is then missing or stale is queued. */
	async function runPass(): Promise<void> {
		quietTimer = undefined
		firstUncovered = undefined
		if (stopped) return
		try {
			const plans = await inputs.plans()
			await dropRemoved(new Set(plans.map(plan => plan.key)))
			for (const plan of plans) {
				if (stateOf(plan, await store.list(plan.key)) === 'fresh') continue
				// A View that failed within the failure interval is tried again by the next write or request after it, not by this pass.
				const failed = failedAt.get(plan.key)
				if (failed !== undefined && now() - failed < timing.failureIntervalMs) continue
				enqueue(plan.key)
			}
		}
		catch (error) {
			diagnostics.warn(`uiux: a thumbnail pass failed: ${message(error)}`)
		}
		await refreshHeld()
		announce()
		void pump()
	}

	/** Deletes the thumbnails of Views that no longer exist, and drops them from the queue (Rule 01a19b99-d814-7fdf-8742-5f7fad22684a). */
	async function dropRemoved(existing: ReadonlySet<string>): Promise<void> {
		for (const key of [...queue]) if (!existing.has(key)) dequeue(key)
		for (const key of await store.views()) {
			if (existing.has(key) || key === inFlight) continue
			await store.remove(key)
			publish(key)
		}
	}

	function onEvent(event: ChangeEvent): void {
		if (event.type !== 'resource.changed' && event.type !== 'resource.removed') return
		if (!RENDERING_KINDS.includes(event.kind)) return
		if (event.type === 'resource.removed' && event.kind === 'view') void viewRemoved(event.key)
		touch()
	}

	async function viewRemoved(key: string): Promise<void> {
		dequeue(key)
		failedAt.delete(key)
		if (key === inFlight) inFlightRemoved = true
		else {
			try { await store.remove(key) }
			catch (error) { diagnostics.warn(`uiux: could not delete the thumbnail of a removed View: ${message(error)}`) }
		}
		publish(key)
		announce()
	}

	// --- the queue ----------------------------------------------------------------------------

	function pump(): Promise<void> {
		pumping ??= runPump().finally(() => { pumping = undefined })
		return pumping
	}

	async function runPump(): Promise<void> {
		for (;;) {
			// The browser is closed whenever the queue is empty or held back, and launched again by the next capture.
			try { await drain() }
			finally { await capturer.close().catch(() => undefined) }
			if (stopped || queue.length === 0 || held) return
		}
	}

	async function drain(): Promise<void> {
		while (!stopped && queue.length > 0) {
			if (await refreshHeld()) {
				announce()
				return
			}
			const key = queue.shift()!
			inFlight = key
			inFlightRemoved = false
			announce()
			try { await captureOne(key) }
			catch (error) { fail(key, message(error)) }
			const removed = inFlightRemoved
			inFlight = undefined
			if (removed) await store.remove(key).catch(() => undefined)
			announce()
		}
	}

	function fail(key: string, reason: string): void {
		failedAt.set(key, now())
		// A failed capture shows nowhere in the Workbench: it goes to the server diagnostics only.
		diagnostics.warn(`uiux: the thumbnail of View ${key} was not captured: ${reason}`)
	}

	async function captureOne(key: string): Promise<void> {
		const [plan] = await inputs.plans([key])
		if (!plan) return // the View no longer exists
		if (stopped) return // a stopped service launches no browser
		if (!plan.digest || !plan.context) return fail(key, 'its thumbnail input digest or default context cannot be computed')
		const hex = thumbnailDigestHex(plan.digest)
		if ((await store.list(key)).some(file => file.digest === hex)) return // already fresh
		const outcome = await capturer.capture({ key, context: plan.context })
		if (!outcome.ok) return fail(key, outcome.reason)
		if (inFlightRemoved) return
		try { await store.write(key, hex, outcome.png) }
		catch (error) { return fail(key, `the image could not be stored: ${message(error)}`) }
		failedAt.delete(key)
		publish(key)
	}

	// --- the operations -----------------------------------------------------------------------

	async function statuses(plans: readonly ThumbnailPlan[]): Promise<readonly ThumbnailStatus[]> {
		await refreshHeld()
		const refreshing = refreshingKeys()
		const result: ThumbnailStatus[] = []
		for (const plan of plans) result.push({ key: plan.key, state: stateOf(plan, await store.list(plan.key)), refreshing: refreshing.has(plan.key) })
		return result
	}

	async function read(viewId: string): Promise<Uint8Array | undefined> {
		if (!isFullUuid(viewId)) return undefined
		const files = [...await store.list(viewId)].sort((a, b) => b.modifiedMs - a.modifiedMs)
		if (files.length === 0) return undefined
		let chosen = files[0]!
		// At most one file per View remains (Rule 01a19bb9-95ef-7a61-b7e7-0114c9327cff); the digest is read only to choose between two.
		if (files.length > 1) {
			const [plan] = await inputs.plans([viewId])
			const fresh = plan?.digest ? files.find(file => file.digest === thumbnailDigestHex(plan.digest!)) : undefined
			if (fresh) chosen = fresh
		}
		return await store.read(viewId, chosen.digest)
	}

	async function list(viewIds?: readonly string[]): Promise<readonly ThumbnailStatus[]> {
		return statuses(await inputs.plans(viewIds))
	}

	async function request(viewIds: readonly string[]): Promise<readonly ThumbnailStatus[]> {
		const plans = await inputs.plans(viewIds)
		const at = now()
		for (const plan of plans) {
			if (plan.key === inFlight || queue.includes(plan.key)) continue
			if (stateOf(plan, await store.list(plan.key)) === 'fresh') continue
			const failed = failedAt.get(plan.key)
			if (failed !== undefined && at - failed < timing.failureIntervalMs) continue
			enqueue(plan.key)
		}
		await refreshHeld()
		announce()
		void pump()
		return statuses(plans)
	}

	// --- lifecycle ----------------------------------------------------------------------------

	function tick(): void {
		const output = options.kitBuild?.().outputVersion
		if (output !== lastKitOutput) {
			lastKitOutput = output
			touch()
		}
		if (queue.length > 0 || announced.size > 0) {
			void refreshHeld().then(() => {
				announce()
				if (!held && queue.length > 0) void pump()
			})
		}
	}

	return {
		read,
		list,
		request,
		start() {
			if (started || stopped) return
			started = true
			lastKitOutput = options.kitBuild?.().outputVersion
			unsubscribe = events?.subscribe(onEvent)
			pollTimer = setInterval(tick, timing.pollMs)
			pollTimer.unref?.()
		},
		async stop() {
			stopped = true
			unsubscribe?.()
			unsubscribe = undefined
			if (quietTimer) clearTimeout(quietTimer)
			if (pollTimer) clearInterval(pollTimer)
			quietTimer = pollTimer = undefined
			await capturer.close(true).catch(() => undefined)
			await pumping?.catch(() => undefined)
		},
		async idle() {
			while (pumping || quietTimer) {
				if (pumping) await pumping
				else await new Promise(resolve => setTimeout(resolve, 10))
			}
		},
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}
