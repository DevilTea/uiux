import { defineNuxtPlugin, navigateTo, useRouter, useRuntimeConfig } from '#imports'
import { useAccess } from '../composables/useAccess'

/**
 * When a session ends mid-use (sign-out elsewhere, Owner revoke, expiry), the next request gets
 * `401 auth.required` or `auth.invalid_credential`; the Workbench returns to `/login`. The
 * `/preview` document is left alone: it reports failures inside its own frame.
 */
export default defineNuxtPlugin({
	name: 'uiux:access',
	setup() {
		if (useRuntimeConfig().public.uiuxMode === 'publication') return
		const router = useRouter()
		const original = globalThis.$fetch
		let redirecting = false
		globalThis.$fetch = original.create({
			onResponseError({ request, response }) {
				if (response.status !== 401 || redirecting) return
				const url = typeof request === 'string' ? request : request instanceof Request ? request.url : String(request)
				if (url.includes('/api/session/login')) return
				const current = router.currentRoute.value
				if (current.path === '/login' || current.path.startsWith('/preview')) return
				redirecting = true
				void useAccess().load(true).finally(() => {
					redirecting = false
					void navigateTo({ path: '/login', query: { next: current.fullPath } })
				})
			},
		}) as typeof original
	},
})
