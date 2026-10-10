import { defineNuxtPlugin, navigateTo, useRouter } from '#imports'
import { useAccess } from '../composables/useAccess'
import { useConnectivity } from '../composables/useConnectivity'
import { isRetryableRead, shouldRetryRead, transientRetryDelay } from '../utils/fetch-retry'

/**
 * Watches every Workbench API response at the native `fetch` layer that ofetch delegates to.
 * (Nuxt's auto-imported `$fetch` is the instance captured when `#build/fetch.mjs` evaluated, so
 * replacing `globalThis.$fetch` from a plugin never reached the app's own calls.)
 *
 * - When a session ends mid-use (sign-out elsewhere, Owner revoke, expiry), the next request gets
 *   `401 auth.required` or `auth.invalid_credential`; the Workbench returns to `/login`, keeping
 *   the page to come back to. The session probe itself (`GET /api/session`) and the sign-in
 *   request own their 401: for them it is the expected signed-out answer, handled by their callers.
 * - A request that gets no response at all reports the server unreachable (brief h); any response
 *   reports it reachable again.
 * - A read answered `503` (`persistence.busy`: the Workspace was momentarily busy and nothing was
 *   read) is retried once after the server's `Retry-After`, capped and jittered. Writes are never
 *   retried here; their callers show the transient error instead.
 *
 * The `/preview` document is left alone: it reports failures inside its own frame.
 */
function requestPath(input: RequestInfo | URL): string {
	const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
	try { return new URL(raw, window.location.origin).pathname }
	catch { return raw }
}

export default defineNuxtPlugin({
	name: 'uiux:access',
	setup() {
		const router = useRouter()
		const connectivity = useConnectivity()
		const nativeFetch = window.fetch.bind(window)
		let redirecting = false

		function sessionEnded(path: string): void {
			if (redirecting || path === '/api/session' || path === '/api/session/login') return
			const current = router.currentRoute.value
			if (current.path === '/login' || current.path.startsWith('/preview')) return
			redirecting = true
			// Forget the member locally; asking the server again would only repeat the 401.
			useAccess().expire()
			void Promise.resolve(navigateTo({ path: '/login', query: { next: current.fullPath, expired: '1' } })).finally(() => {
				redirecting = false
			})
		}

		window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const path = requestPath(input)
			const api = path.startsWith('/api/')
			const retryable = api && isRetryableRead(path, input, init)
			// A Request body can be read only once; keep a copy for the retry.
			const retryInput = retryable && input instanceof Request ? input.clone() : input
			let response: Response
			try {
				response = await nativeFetch(input, init)
				if (retryable && shouldRetryRead(response) && !init?.signal?.aborted) {
					await new Promise(resolve => setTimeout(resolve, transientRetryDelay(response)))
					response = await nativeFetch(retryInput, init)
				}
			}
			catch (cause) {
				if (api && (cause as { name?: string } | undefined)?.name !== 'AbortError') connectivity.markUnreachable()
				throw cause
			}
			if (api) {
				connectivity.markReachable()
				if (response.status === 401) sessionEnded(path)
			}
			return response
		}
	},
})
