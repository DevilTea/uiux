import type { IncomingHttpHeaders } from 'node:http'
import { defineEventHandler, setResponseHeader, setResponseHeaders, setResponseStatus, type EventHandler, type H3Event } from 'h3'

import {
	DEFAULT_LOOPBACK_BIND_HOST,
	getServerNetwork,
	isLoopbackHostname,
	isLoopbackPeer,
	LOOPBACK_HOSTNAMES,
	type ConfiguredOrigin,
	type NetworkConfig,
} from './network-access'

/**
 * Baseline request gate (Feature 01a111e4-02a6-7585-9bf1-5e40eb53b4cc) for the UIUX server.
 *
 * It selects the origin a request arrived on from its `Host` (Clause 01a114ec-eb22-7acd-ae70-62f7f17fa6f2):
 * a loopback host name on the bound port, accepted only from a loopback peer (Rule
 * 01a12500-ad67-7e14-b375-78a59f822687), or the host and port of a configured origin. It then
 * defeats DNS rebinding (foreign `Host`), cross-site request forgery (an `Origin` other than the
 * matched origin, `Sec-Fetch-Site`), simple-request form posts (non-JSON bodies) and clickjacking
 * (`frame-ancestors`). It adds no CORS and reads no forwarding header (Rule
 * 01a12500-ba1c-7a07-8341-2a8b0691e8c5). Authentication runs after it (`src/server/access/http.ts`)
 * and the matched origin is attached to the event for origin-specific policy.
 */

export { DEFAULT_LOOPBACK_BIND_HOST, LOOPBACK_HOSTNAMES }

/** Bind addresses accepted for `NITRO_HOST` / `HOST` by a packaged server run directly. */
const LOOPBACK_BIND_HOSTS: ReadonlyMap<string, string> = new Map([
	['127.0.0.1', '127.0.0.1'],
	['localhost', 'localhost'],
	['::1', '::1'],
	['[::1]', '::1'],
])

export const LOOPBACK_ONLY_MESSAGE
	= 'The UIUX server run directly listens on loopback only (127.0.0.1, ::1 or localhost). To serve other machines, start it with uiux dev --host <address> --origin <url>.'

export type LoopbackBindResolution
	= | Readonly<{ ok: true; host: string }>
		| Readonly<{ ok: false; variable: 'NITRO_HOST' | 'HOST'; value: string; message: string }>

/**
 * Resolves the address the Nitro node-server entry would bind (`NITRO_HOST || HOST`) for a
 * packaged server run directly (Rule 01a11485-ee85-7844-b82f-fd6a7cebb763). Unset means the
 * loopback default; a non-loopback value, a wildcard included, is refused rather than silently
 * honored or overridden.
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
		message: `Refusing to listen on ${variable}=${raw}. ${LOOPBACK_ONLY_MESSAGE}`,
	}
}

/** Formats a bind host as an origin host component (IPv6 literals are bracketed). */
export function formatOriginHost(host: string): string {
	return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
}

/** The origin a request's `Host` matched, which origin-specific policy follows (Rule 01a12500-ab96-73d7-83ec-707a7ab56d49). */
export type MatchedOrigin = Readonly<{
	/** The serialized origin (`http://127.0.0.1:3000`, `https://uiux.corp.example`). */
	origin: string
	/** `loopback`: a loopback host name on the bound port; `configured`: a configured origin. */
	kind: 'loopback' | 'configured'
	scheme: 'http' | 'https'
	/** The origin's host is a loopback host name (a configured origin can be one, on another port). */
	loopbackHost: boolean
}>

declare module 'h3' {
	interface H3EventContext {
		uiuxOrigin?: MatchedOrigin
	}
}

/**
 * Roster administration is served only on a loopback origin or an `https` configured origin
 * (Rule 01a12500-b105-7773-822f-359d4dcbd1da).
 */
export function servesRosterAdministration(origin: MatchedOrigin | undefined): boolean {
	if (!origin) return false
	return origin.loopbackHost || origin.scheme === 'https'
}

export type LoopbackRequestInput = Readonly<{
	method: string
	/** Request path, optionally with a query string. */
	path: string
	headers: Readonly<IncomingHttpHeaders>
	/**
	 * Port of the local socket that accepted the request. `undefined` accepts any port for the
	 * loopback host names, which is only used by the Nuxt development server, where requests
	 * arrive through an internal proxy.
	 */
	localPort?: number
	/** The connection's peer address; `undefined` for a local (Unix domain) socket. */
	remoteAddress?: string
	/** Configured origins; none by default (loopback only). */
	origins?: readonly ConfiguredOrigin[]
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

export type RequestGateOutcome
	= | Readonly<{ ok: true; origin: MatchedOrigin }>
		| Readonly<{ ok: false; rejection: LoopbackRequestRejection }>

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const ALLOWED_FETCH_SITES = new Set(['same-origin', 'none'])
/** `name` or `name:port`, where `name` is a DNS name, an IPv4 address or a bracketed IPv6 literal. */
const HOST_PATTERN = /^(\[[0-9a-f:.]+\]|[a-z0-9._-]+)(?::(\d{1,5}))?$/u

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
 * Matches a `Host` header against the Host allowlist (Clause 01a114ec-eb22-7acd-ae70-62f7f17fa6f2):
 * the loopback host names on the bound port, plus the host and port of each configured origin; a
 * `Host` without a port matches the one configured origin on that host that uses its scheme's
 * default port. Plain HTTP only (Rule 01a12500-bbed-7aaa-a9bf-869e5e09bd45), so a port-less
 * loopback `Host` means port 80.
 */
function matchHost(host: string, input: LoopbackRequestInput): MatchedOrigin | undefined {
	const match = HOST_PATTERN.exec(host)
	if (!match) return undefined
	const hostname = match[1]!
	const explicitPort = match[2] === undefined ? undefined : Number(match[2])
	if (explicitPort !== undefined && (explicitPort < 1 || explicitPort > 65535)) return undefined
	const configured = (input.origins ?? []).find(origin => origin.hostname === hostname
		&& (explicitPort === undefined ? origin.defaultPort : origin.port === explicitPort))
	if (configured) return { origin: configured.origin, kind: 'configured', scheme: configured.scheme, loopbackHost: configured.loopback }
	if (!isLoopbackHostname(hostname)) return undefined
	const port = explicitPort ?? 80
	if (input.localPort !== undefined && port !== input.localPort) return undefined
	return { origin: new URL(`http://${hostname}:${port}`).origin, kind: 'loopback', scheme: 'http', loopbackHost: true }
}

function describeAllowlist(input: LoopbackRequestInput): string {
	const port = input.localPort === undefined ? '<port>' : String(input.localPort)
	const loopback = LOOPBACK_HOSTNAMES.map(name => `${name}:${port}`)
	const configured = (input.origins ?? []).map(origin => origin.origin)
	return [...loopback, ...configured].join(', ')
}

/**
 * Pure request policy. Returns the matched origin, or a rejection for requests that must not
 * reach a handler.
 */
export function evaluateRequestGate(input: LoopbackRequestInput): RequestGateOutcome {
	const method = input.method.toUpperCase()
	const host = headerValue(input.headers, 'host')?.trim().toLowerCase() ?? ''
	const matched = matchHost(host, input)
	// A loopback host name claims a local client; only a loopback peer may make that claim.
	if (!matched || (matched.loopbackHost && !isLoopbackPeer(input.remoteAddress))) {
		return {
			ok: false,
			rejection: reject(
				421,
				'Misdirected Request',
				'request.host_rejected',
				'/headers/host',
				`Host ${JSON.stringify(host)} is not an origin of this UIUX server. Use one of ${describeAllowlist(input)}${matched ? ' (loopback host names only from this machine)' : ''}.`,
			),
		}
	}

	const stateChanging = !SAFE_METHODS.has(method)
	if (!stateChanging && !isMcpPath(input.path)) return { ok: true, origin: matched }

	const origin = headerValue(input.headers, 'origin')?.trim()
	if (origin) {
		let actualOrigin: string | undefined
		try {
			actualOrigin = new URL(origin).origin
		}
		catch {
			actualOrigin = undefined
		}
		if (actualOrigin !== matched.origin) {
			return {
				ok: false,
				rejection: reject(
					403,
					'Forbidden',
					'request.origin_rejected',
					'/headers/origin',
					`Cross-origin request from ${JSON.stringify(origin)} is not allowed; only ${matched.origin} may call this server through ${JSON.stringify(host)}.`,
				),
			}
		}
	}

	const fetchSite = headerValue(input.headers, 'sec-fetch-site')?.trim().toLowerCase()
	if (fetchSite && !ALLOWED_FETCH_SITES.has(fetchSite)) {
		return {
			ok: false,
			rejection: reject(
				403,
				'Forbidden',
				'request.cross_site_rejected',
				'/headers/sec-fetch-site',
				`Sec-Fetch-Site ${JSON.stringify(fetchSite)} is not allowed; only same-origin or none.`,
			),
		}
	}

	if (stateChanging) {
		const contentType = headerValue(input.headers, 'content-type')
		if (contentType !== undefined || hasRequestBody(input.headers)) {
			const mediaType = contentType?.split(';', 1)[0]?.trim().toLowerCase()
			if (mediaType !== 'application/json') {
				return {
					ok: false,
					rejection: reject(
						415,
						'Unsupported Media Type',
						'request.content_type_rejected',
						'/headers/content-type',
						`State-changing requests must send Content-Type: application/json (received ${JSON.stringify(contentType ?? '')}).`,
					),
				}
			}
		}
	}

	return { ok: true, origin: matched }
}

/** {@link evaluateRequestGate} reduced to its rejection, or `undefined` when the request may proceed. */
export function evaluateLoopbackRequest(input: LoopbackRequestInput): LoopbackRequestRejection | undefined {
	const outcome = evaluateRequestGate(input)
	return outcome.ok ? undefined : outcome.rejection
}

export type LoopbackGuardOptions = Readonly<{
	/** Skip the loopback `Host` port comparison (Nuxt development server only). */
	anyPort?: boolean
	/** The bind and origin configuration; defaults to the server's ({@link getServerNetwork}). */
	network?: () => NetworkConfig
}>

/** The origin the request's `Host` matched; the gate attaches it before any handler runs. */
export function requestOrigin(event: H3Event): MatchedOrigin | undefined {
	return event.context.uiuxOrigin
}

/**
 * h3 handler that applies {@link evaluateRequestGate} and the framing headers. It must run before
 * every other handler, including Nitro's static asset middleware.
 */
export function createLoopbackGuardHandler(options: LoopbackGuardOptions = {}): EventHandler {
	const network = options.network ?? getServerNetwork
	return defineEventHandler((event) => {
		setResponseHeaders(event, SECURITY_HEADERS)
		const socket = event.node.req.socket as typeof event.node.req.socket | undefined
		const outcome = evaluateRequestGate({
			method: event.method,
			path: event.path,
			headers: event.node.req.headers,
			localPort: options.anyPort ? undefined : socket?.localPort,
			remoteAddress: socket?.remoteAddress,
			origins: network().origins,
		})
		if (outcome.ok) {
			event.context.uiuxOrigin = outcome.origin
			return undefined
		}
		const { rejection } = outcome
		setResponseStatus(event, rejection.status, rejection.statusText)
		setResponseHeader(event, 'Cache-Control', 'no-store')
		setResponseHeader(event, 'Content-Type', 'application/json')
		return rejection.body
	})
}
