import { readonly, shallowRef } from 'vue'

/**
 * Whether the UIUX server answers (brief h, "Server unreachable"). The access plugin reports
 * every request that got no HTTP response at all (the server stopped, the port closed, the
 * network went away) and every response that did arrive. While unreachable, `GET /api/health`
 * (public, no credential) is polled with a backoff; the first answer marks the server reachable
 * again and runs the registered recovery (the shell re-reads the Workspace).
 */
export type Connectivity = 'online' | 'offline' | 'reconnecting'

const state = shallowRef<Connectivity>('online')
const since = shallowRef<number>()
let timer: ReturnType<typeof setTimeout> | undefined
let attempt = 0
const recoveries = new Set<() => void>()

const BACKOFF_MS = [2000, 3000, 5000, 8000, 13000] as const

async function probe(): Promise<boolean> {
	try {
		// Native fetch: a probe must not re-enter the `$fetch` hooks that report connectivity.
		const response = await fetch('/api/health', { cache: 'no-store' })
		return response.ok
	}
	catch {
		return false
	}
}

function schedule(): void {
	if (timer) return
	const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!
	timer = setTimeout(() => {
		timer = undefined
		void check()
	}, delay)
}

async function check(): Promise<boolean> {
	if (state.value === 'online') return true
	state.value = 'reconnecting'
	attempt += 1
	if (await probe()) {
		markReachable()
		return true
	}
	state.value = 'offline'
	schedule()
	return false
}

function markUnreachable(): void {
	if (typeof window === 'undefined') return
	if (state.value === 'online') {
		state.value = 'offline'
		since.value = Date.now()
		attempt = 0
	}
	schedule()
}

function markReachable(): void {
	if (state.value === 'online') return
	state.value = 'online'
	since.value = undefined
	attempt = 0
	if (timer) clearTimeout(timer)
	timer = undefined
	for (const run of recoveries) run()
}

export function useConnectivity() {
	return {
		state: readonly(state),
		since: readonly(since),
		markUnreachable,
		markReachable,
		/** Asks the server now (the Retry action); resolves true when it answered. */
		retry: () => check(),
		/** Runs `recover` each time the server becomes reachable again; returns the unsubscribe. */
		onRecover(recover: () => void): () => void {
			recoveries.add(recover)
			return () => { recoveries.delete(recover) }
		},
	}
}
