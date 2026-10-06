import type { IncomingHttpHeaders } from 'node:http'
import { defineEventHandler, setResponseHeader, setResponseHeaders, setResponseStatus, type EventHandler } from 'h3'

/**
 * Loopback-only request gate (the baseline) for the `uiux dev` server.
 *
 * Binding to 127.0.0.1 keeps other machines out (the LAN listener is not yet available); this
 * gate additionally defeats DNS rebinding (foreign `Host`), cross-site request forgery (foreign
 * `Origin` / `Sec-Fetch-Site`), simple-request form posts (non-JSON bodies) and clickjacking
 * (`frame-ancestors`). It adds no CORS. Authentication runs after it (`src/server/access/http.ts`,
 * accepted identity decision 4) and attaches the request's principal.
 */

/** Hostnames (as they appear in a `Host` header) that address this machine's loopback listener. */
export const LOOPBACK_HOSTNAMES: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '[::1]'])

/** Bind addresses accepted for `NITRO_HOST` / `HOST`; `[::1]` is normalized to `::1` for `listen()`. */
const LOOPBACK_BIND_HOSTS: ReadonlyMap<string, string> = new Map([
	['127.0.0.1', '127.0.0.1'],
	['localhost', 'localhost'],
	['::1', '::1'],
	['[::1]', '::1'],
])

export const DEFAULT_LOOPBACK_BIND_HOST = '127.0.0.1'

export const LAN_EXPOSURE_UNAVAILABLE_MESSAGE
	= 'UIUX listens on loopback only (127.0.0.1, ::1 or localhost); the LAN listener is not yet available.'

export type LoopbackBindResolution
	= | Readonly<{ ok: true; host: string }>
		| Readonly<{ ok: false; variable: 'NITRO_HOST' | 'HOST'; value: string; message: string }>

/**
 * Resolves the address the Nitro node-server entry would bind (`NITRO_HOST || HOST`). Unset means
 * the loopback default; a non-loopback value is refused rather than silently honored or
 * overridden. (`uiux dev` is stricter and refuses a non-loopback value in either variable.)
 */
export function resolveLoopbackBindHost(env: Readonly<Record<string, string | undefined>>): LoopbackBindResolution {
	const variable = env.NITRO_HOST?.trim() ? 'NITRO_HOST' : 'HOST'
	const raw = env[variable]
	if (raw === undefined || raw.trim() === '') return { ok: true, host: DEFAULT_LOOPBACK_BIND_HOST }
	const normalized = LOOPBACK_BIND_HOSTS.get(raw.trim().toLowerCase())
	if (normalized) return { ok: true, host: normalized }
	return {
		ok: false,
		variable,
		value: raw,
		message: `Refusing to listen on ${variable}=${raw}. ${LAN_EXPOSURE_UNAVAILABLE_MESSAGE}`,
	}
}

/** Formats a loopback bind host as an origin host component (IPv6 literals are bracketed). */
export function formatOriginHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

export type LoopbackRequestInput = Readonly<{
	method: string
	/** Request path, optionally with a query string. */
	path: string
	headers: Readonly<IncomingHttpHeaders>
	/**
	 * Port of the local socket that accepted the request. `undefined` accepts any port, which is
	 * only used by the Nuxt development server, where requests arrive through an internal proxy.
	 */
	localPort?: number
	secure?: boolean
}>

export type LoopbackRequestRejection = Readonly<{
	status: number
	statusText: string
	body: Readonly<{
		status: 'rejected'
		code: string
		message: string
		diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[]
	}>
}>

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])
const HOST_PATTERN = /^(127\.0\.0\.1|localhost|\[::1\])(?::(\d{1,5}))?$/

export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
	'Content-Security-Policy': 'frame-ancestors \'self\'',
	'X-Frame-Options': 'SAMEORIGIN',
})

function headerValue(headers: Readonly<IncomingHttpHeaders>, name: string): string | undefined {
	const value = headers[name]
	if (Array.isArray(value)) return value.join(', ')
	return value
}

function reject(status: number, statusText: string, code: string, path: string, message: string): LoopbackRequestRejection {
	return {
		status,
		statusText,
		body: { status: 'rejected', code, message, diagnostics: [{ code, path, message }] },
	}
}

function isMcpPath(path: string): boolean {
	const pathname = path.split('?', 1)[0] ?? ''
	return pathname === '/mcp' || pathname.startsWith('/mcp/')
}

function hasRequestBody(headers: Readonly<IncomingHttpHeaders>): boolean {
	const length = headerValue(headers, 'content-length')
	if (length !== undefined && length.trim() !== '0') return true
	return headerValue(headers, 'transfer-encoding') !== undefined
}

/**
 * Pure request policy. Returns a rejection for requests that must not reach a handler, or
 * `undefined` when the request may proceed.
 */
export function evaluateLoopbackRequest(input: LoopbackRequestInput): LoopbackRequestRejection | undefined {
	const method = input.method.toUpperCase()
	const host = headerValue(input.headers, 'host')?.trim().toLowerCase() ?? ''
	const hostMatch = HOST_PATTERN.exec(host)
	const defaultPort = input.secure ? 443 : 80
	const hostPort = hostMatch?.[2] === undefined ? defaultPort : Number(hostMatch[2])
	if (!hostMatch || (input.localPort !== undefined && hostPort !== input.localPort)) {
		const expected = input.localPort === undefined ? '<port>' : String(input.localPort)
		return reject(
			421,
			'Misdirected Request',
			'request.host_rejected',
			'/headers/host',
			`Host ${JSON.stringify(host)} is not this loopback UIUX server. Use 127.0.0.1:${expected}, localhost:${expected} or [::1]:${expected}.`,
		)
	}

	const stateChanging = !SAFE_METHODS.has(method)
	if (!stateChanging && !isMcpPath(input.path)) return undefined

	const origin = headerValue(input.headers, 'origin')?.trim()
	if (origin) {
		const expectedOrigin = new URL(`${input.secure ? 'https' : 'http'}://${host}`).origin
		let actualOrigin: string | undefined
		try {
			actualOrigin = new URL(origin).origin
		}
		catch {
			actualOrigin = undefined
		}
		if (actualOrigin !== expectedOrigin) {
			return reject(
				403,
				'Forbidden',
				'request.origin_rejected',
				'/headers/origin',
				`Cross-origin request from ${JSON.stringify(origin)} is not allowed; only ${expectedOrigin} may call this server.`,
			)
		}
	}

	const fetchSite = headerValue(input.headers, 'sec-fetch-site')?.trim().toLowerCase()
	if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
		return reject(
			403,
			'Forbidden',
			'request.cross_site_rejected',
			'/headers/sec-fetch-site',
			`Sec-Fetch-Site ${JSON.stringify(fetchSite)} is not allowed; only same-origin or none.`,
		)
	}

	if (stateChanging) {
		const contentType = headerValue(input.headers, 'content-type')
		if (contentType !== undefined || hasRequestBody(input.headers)) {
			const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
			if (mediaType !== 'application/json') {
				return reject(
					415,
					'Unsupported Media Type',
					'request.content_type_rejected',
					'/headers/content-type',
					`State-changing requests must send Content-Type: application/json (received ${JSON.stringify(contentType ?? '')}).`,
				)
			}
		}
	}

	return undefined
}

export type LoopbackGuardOptions = Readonly<{
	/** Skip the `Host` port comparison (Nuxt development server only). */
	anyPort?: boolean
}>

/**
 * h3 handler that applies {@link evaluateLoopbackRequest} and the framing headers. It must run
 * before every other handler, including Nitro's static asset middleware.
 */
export function createLoopbackGuardHandler(options: LoopbackGuardOptions = {}): EventHandler {
	return defineEventHandler((event) => {
		setResponseHeaders(event, SECURITY_HEADERS)
		const socket = event.node.req.socket as (typeof event.node.req.socket & { encrypted?: boolean }) | undefined
		const rejection = evaluateLoopbackRequest({
			method: event.method,
			path: event.path,
			headers: event.node.req.headers,
			localPort: options.anyPort ? undefined : socket?.localPort,
			secure: Boolean(socket?.encrypted),
		})
		if (!rejection) return undefined
		setResponseStatus(event, rejection.status, rejection.statusText)
		setResponseHeader(event, 'Cache-Control', 'no-store')
		setResponseHeader(event, 'Content-Type', 'application/json')
		return rejection.body
	})
}
