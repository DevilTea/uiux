import { defineEventHandler, setResponseHeader, type EventHandler } from 'h3'

/**
 * The server instance header (Clause 01a175ec-c8cb-7cf3-bc94-1168ed11e3a9; owner ruling 4 of
 * 2026-10-26, https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750): every
 * response to an `/api/*` request that passed the Host and Origin gate names the server instance
 * the way `hello` does, so the Workbench detects a restarted server from any read, in polling
 * fallback and before its first `hello` too. It is placed ahead of the access guard, so an
 * authentication refusal carries it as well. The ID is random and readable only same-origin.
 */
export const SERVER_INSTANCE_HEADER = 'X-UIUX-Server-Instance'

function isApiPath(path: string): boolean {
	const pathname = (path.split('?', 1)[0] ?? '/').replace(/\/{2,}/gu, '/')
	return pathname === '/api' || pathname.startsWith('/api/')
}

export function createServerInstanceHeaderHandler(instanceId: () => string | undefined): EventHandler {
	return defineEventHandler((event) => {
		if (!isApiPath(event.path)) return undefined
		let id: string | undefined
		try { id = instanceId() }
		catch { return undefined }
		if (id) setResponseHeader(event, SERVER_INSTANCE_HEADER, id)
		return undefined
	})
}
