import { defineEventHandler, setResponseHeader, setResponseStatus, type EventHandler, type H3Event } from 'h3'

import type { Principal } from '../../application/access/principal'
import { authorizeOperation, type AccessOperation } from '../../application/access/policy'
import { createScopedWorkspaceSession, type ScopedWorkspaceSession } from '../../application/access/scoped-session'
import type { AccessService, AuthFailure } from './service'
import { AccessError, ACCESS_ERROR_HTTP_STATUS } from './roster'

/**
 * Authentication on every surface (accepted identity decision 4). It runs after the
 * baseline gates (Host, Origin, Sec-Fetch-Site, Content-Type, framing) and attaches the request's
 * principal to `event.context`; authorization happens in the shared application layer.
 */
export type RequestClass = 'public' | 'well-known' | 'mcp' | 'api'

declare module 'h3' {
	interface H3EventContext {
		uiuxPrincipal?: Principal
	}
}

export function classifyRequest(method: string, path: string): RequestClass {
	const pathname = (path.split('?', 1)[0] ?? '/').replace(/\/{2,}/gu, '/')
	if (pathname === '/.well-known' || pathname.startsWith('/.well-known/')) return 'well-known'
	if (pathname === '/mcp' || pathname.startsWith('/mcp/')) return 'mcp'
	if (pathname === '/api' || pathname.startsWith('/api/')) {
		const upper = method.toUpperCase()
		if (pathname === '/api/health' && (upper === 'GET' || upper === 'HEAD')) return 'public'
		if (pathname === '/api/session/login' && upper === 'POST') return 'public'
		// Nuxt Icon's collection endpoint serves static icon data, never Workspace data.
		if (pathname.startsWith('/api/_nuxt_icon/')) return 'public'
		return 'api'
	}
	// SPA documents, `/_nuxt/*` assets and `/login`: static code with no Workspace data.
	return 'public'
}

export const WWW_AUTHENTICATE = 'Bearer realm="uiux"'

function json(event: H3Event, status: number, body: unknown) {
	setResponseStatus(event, status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	setResponseHeader(event, 'Content-Type', 'application/json')
	return body
}

export function authFailureBody(failure: AuthFailure) {
	return {
		status: 'rejected',
		code: failure.code,
		message: failure.message,
		diagnostics: [{ code: failure.code, path: '/headers/authorization', message: failure.message }],
	}
}

export function sendAuthFailure(event: H3Event, failure: AuthFailure, options: Readonly<{ mcp: boolean; cookieName?: string }>) {
	if (options.mcp || failure.status === 401) setResponseHeader(event, 'WWW-Authenticate', WWW_AUTHENTICATE)
	if (failure.retryAfterSeconds) setResponseHeader(event, 'Retry-After', failure.retryAfterSeconds)
	if (failure.clearCookie && options.cookieName) setResponseHeader(event, 'Set-Cookie', clearedCookie(options.cookieName, secureCookieFor(event)))
	return json(event, failure.status, authFailureBody(failure))
}

export function sessionCookie(name: string, value: string, maxAgeSeconds: number, secure: boolean): string {
	return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? '; Secure' : ''}`
}

export function clearedCookie(name: string, secure = false): string {
	return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`
}

/**
 * `Secure` follows the configured scheme of the origin the request's `Host` matched (Clause
 * 01a11485-f916-7e0c-b6c3-19c0c0b199d2), never the socket or a forwarding header: UIUX serves
 * plain HTTP, and an `https` origin is served by a TLS-terminating front end.
 */
export function secureCookieFor(event: H3Event): boolean {
	return event.context.uiuxOrigin?.scheme === 'https'
}

function headerValue(event: H3Event, name: string): string | undefined {
	const value = event.node.req.headers[name]
	return Array.isArray(value) ? value.join(', ') : value
}

/**
 * h3 handler resolving the principal for every `/api/*` and `/mcp` request. Public routes pass
 * through; `/.well-known/*` answers a JSON 404 so MCP clients probing for OAuth metadata get a
 * clean "not found" instead of the SPA fallback.
 */
export function createAccessGuardHandler(resolveAccess: () => Promise<AccessService>): EventHandler {
	return defineEventHandler(async (event) => {
		const kind = classifyRequest(event.method, event.path)
		if (kind === 'public') return undefined
		if (kind === 'well-known') {
			return json(event, 404, { status: 'not_found', code: 'request.not_found', message: 'UIUX advertises no OAuth or other well-known metadata. /mcp takes a static bearer token created with uiux token create.' })
		}
		const access = await resolveAccess()
		const result = await access.authenticate({
			surface: kind === 'mcp' ? 'mcp' : 'api',
			authorization: headerValue(event, 'authorization'),
			cookieHeader: kind === 'mcp' ? undefined : headerValue(event, 'cookie'),
			remoteAddress: event.node.req.socket?.remoteAddress,
			userAgent: headerValue(event, 'user-agent'),
			...(event.context.uiuxOrigin ? { origin: event.context.uiuxOrigin } : {}),
		})
		if (!result.ok) return sendAuthFailure(event, result, { mcp: kind === 'mcp', cookieName: access.cookieName })
		event.context.uiuxPrincipal = result.principal
		return undefined
	})
}

export class MissingPrincipalError extends Error {
	constructor() {
		super('No authenticated principal is attached to this request; the access guard must run first.')
		this.name = 'MissingPrincipalError'
	}
}

export function requestPrincipal(event: H3Event): Principal {
	const principal = event.context.uiuxPrincipal
	if (!principal) throw new MissingPrincipalError()
	return principal
}

/** Returns a JSON `403 auth.scope_denied` body when the principal may not perform the operation. */
export function denyUnlessAllowed(event: H3Event, operation: AccessOperation): unknown | undefined {
	const denied = authorizeOperation(requestPrincipal(event), operation)
	if (!denied) return undefined
	return json(event, 403, { status: 'blocked', code: denied.code, requiredRole: denied.requiredRole, message: denied.message, diagnostics: [{ code: denied.code, path: '/', message: denied.message }] })
}

export function accessErrorResponse(event: H3Event, error: unknown) {
	if (!(error instanceof AccessError)) throw error
	return json(event, ACCESS_ERROR_HTTP_STATUS[error.code] ?? 400, { status: 'invalid', code: error.code, message: error.message, diagnostics: [{ code: error.code, path: '/', message: error.message }] })
}

export function createRequestSession(
	event: H3Event,
	runtime: Readonly<{ app: Parameters<typeof createScopedWorkspaceSession>[0]; leases: Parameters<typeof createScopedWorkspaceSession>[2]['leases'] }>,
): ScopedWorkspaceSession {
	return createScopedWorkspaceSession(runtime.app, requestPrincipal(event), { transport: 'http', leases: runtime.leases })
}
