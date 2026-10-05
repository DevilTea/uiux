import { defineNuxtRouteMiddleware, navigateTo, useRuntimeConfig } from '#imports'
import { useAccess } from '../composables/useAccess'

/**
 * Every Workbench route needs a signed-in member (accepted identity decision 4, default D4: the
 * loopback browser is not implicitly the Owner). `/login` and the `/preview` document stay public;
 * the Preview's data requests ride the same-origin session cookie. Published snapshots have no server.
 */
export default defineNuxtRouteMiddleware(async (to) => {
	if (useRuntimeConfig().public.uiuxMode === 'publication') return
	if (to.path === '/login' || to.path.startsWith('/preview')) return
	const access = useAccess()
	const session = await access.load().catch(() => undefined)
	if (!session) return navigateTo({ path: '/login', query: to.fullPath && to.fullPath !== '/' ? { next: to.fullPath } : {} })
	if (to.path === '/members' && !access.isOwner.value) return navigateTo('/')
})
