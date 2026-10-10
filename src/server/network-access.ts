/**
 * Network access (Feature 01a12500-a0a0-74c0-b83b-3dbb628689e4): the bind address, the origins an
 * operator configures, and the startup output that names them. Shared by `uiux dev` (bundled on
 * demand, see `bin/uiux.mjs`), the Nitro plugin and the request gate, so the CLI refuses exactly
 * what the server would refuse.
 *
 * - Clause 01a12500-a26d-744c-a5ef-4e05fea5c060: `--host` takes a loopback or a wildcard address.
 * - Clause 01a12500-a436-7368-8347-809e0176cfcc: the origin format and the ambiguous sets refused
 *   at startup.
 * - Rule 01a12500-a9c5-74e6-868a-2a6f4a5f3315: a wildcard bind needs at least one origin.
 */

/** Host names (as they appear in a `Host` header) that address this machine's loopback interface. */
export const LOOPBACK_HOSTNAMES: readonly string[] = Object.freeze(['127.0.0.1', 'localhost', '[::1]'])

/** Bind addresses `--host` accepts, normalized for `listen()` (`[::1]` becomes `::1`). */
const LOOPBACK_BIND_HOSTS: ReadonlyMap<string, string> = new Map([
	['127.0.0.1', '127.0.0.1'],
	['localhost', 'localhost'],
	['::1', '::1'],
	['[::1]', '::1'],
])
const WILDCARD_BIND_HOSTS: ReadonlyMap<string, string> = new Map([
	['0.0.0.0', '0.0.0.0'],
	['::', '::'],
])

export const DEFAULT_LOOPBACK_BIND_HOST = '127.0.0.1'

/**
 * Internal `uiux dev` → server handoff. It is not configuration: a packaged server started
 * without it (run directly) binds and accepts loopback only and serves no configured origin
 * (Rule 01a11485-ee85-7844-b82f-fd6a7cebb763), whatever `HOST` or `NITRO_HOST` say.
 */
export const DEV_HANDOFF_VARIABLE = 'UIUX_INTERNAL_DEV_NETWORK'

/** One configured origin, as `--origin` gave it and normalized. */
export type ConfiguredOrigin = Readonly<{
	/** The serialized origin, as a browser sends it in `Origin` (`https://uiux.corp.example`). */
	origin: string
	scheme: 'http' | 'https'
	/** The host as it appears in a `Host` header: lowercase, IPv6 literals bracketed. */
	hostname: string
	port: number
	/** The port is the scheme's default (80 or 443), so a port-less `Host` can match it. */
	defaultPort: boolean
	/** The host is one of {@link LOOPBACK_HOSTNAMES}. */
	loopback: boolean
}>

export type NetworkConfig = Readonly<{
	/** The address handed to `listen()`. */
	bindHost: string
	wildcard: boolean
	origins: readonly ConfiguredOrigin[]
}>

export const LOOPBACK_ONLY_NETWORK: NetworkConfig = Object.freeze({ bindHost: DEFAULT_LOOPBACK_BIND_HOST, wildcard: false, origins: Object.freeze([]) })

export type Resolution<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; message: string }>

const ACCEPTED_HOSTS = '127.0.0.1, ::1, [::1], localhost, 0.0.0.0 or ::'

/** Resolves a `--host` value: a loopback address or a wildcard address, nothing else. */
export function parseBindHost(raw: string): Resolution<Readonly<{ host: string; wildcard: boolean }>> {
	const key = raw.trim().toLowerCase()
	const loopback = LOOPBACK_BIND_HOSTS.get(key)
	if (loopback) return { ok: true, value: { host: loopback, wildcard: false } }
	const wildcard = WILDCARD_BIND_HOSTS.get(key)
	if (wildcard) return { ok: true, value: { host: wildcard, wildcard: true } }
	return { ok: false, message: `--host ${JSON.stringify(raw)} is not accepted. Use a loopback address or a wildcard address (${ACCEPTED_HOSTS}); restrict who can reach the server with --origin and the host firewall.` }
}

/** Whether `host` (a `Host`-header host, lowercase) is a loopback host name. */
export function isLoopbackHostname(host: string): boolean {
	return LOOPBACK_HOSTNAMES.includes(host)
}

const ORIGIN_SHAPE = /^(https?):\/\/([^/?#\s]+)\/?$/iu

/** Parses one `--origin` value (Clause 01a12500-a436-7368-8347-809e0176cfcc). */
export function parseConfiguredOrigin(raw: string): Resolution<ConfiguredOrigin> {
	const refuse = (detail: string): Resolution<ConfiguredOrigin> => ({
		ok: false,
		message: `--origin ${JSON.stringify(raw)} is not an origin: ${detail} Use http:// or https:// followed by a host and an optional :<port>, such as https://uiux.corp.example or http://10.0.0.5:3000.`,
	})
	const shape = ORIGIN_SHAPE.exec(raw.trim())
	if (!shape) return refuse('it must have no path, query or fragment.')
	if (shape[2]!.includes('@')) return refuse('it must have no user information.')
	let url: URL
	try { url = new URL(raw.trim()) }
	catch { return refuse('the host or port is invalid.') }
	if (url.username || url.password) return refuse('it must have no user information.')
	if (url.pathname !== '/' || url.search !== '' || url.hash !== '') return refuse('it must have no path, query or fragment.')
	if (!url.hostname) return refuse('the host is missing.')
	const scheme = url.protocol === 'https:' ? 'https' : 'http'
	const defaultPortNumber = scheme === 'https' ? 443 : 80
	const port = url.port === '' ? defaultPortNumber : Number(url.port)
	if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('the port must be from 1 to 65535.')
	const hostname = url.hostname.toLowerCase()
	return {
		ok: true,
		value: Object.freeze({
			origin: url.origin,
			scheme,
			hostname,
			port,
			defaultPort: port === defaultPortNumber,
			loopback: isLoopbackHostname(hostname),
		}),
	}
}

/**
 * Validates a complete bind and origin set against the bound port. Refuses a wildcard bind
 * without an origin, and every ambiguous origin set (owner ruling 1 of Discussion #174).
 */
export function resolveNetworkConfig(input: Readonly<{ host?: string; origins: readonly string[]; port: number }>): Resolution<NetworkConfig> {
	let bindHost = DEFAULT_LOOPBACK_BIND_HOST
	let wildcard = false
	if (input.host !== undefined) {
		const bind = parseBindHost(input.host)
		if (!bind.ok) return bind
		bindHost = bind.value.host
		wildcard = bind.value.wildcard
	}
	const origins: ConfiguredOrigin[] = []
	for (const raw of input.origins) {
		const parsed = parseConfiguredOrigin(raw)
		if (!parsed.ok) return parsed
		const origin = parsed.value
		const sameHostAndPort = origins.find(other => other.hostname === origin.hostname && other.port === origin.port)
		if (sameHostAndPort)
			return { ok: false, message: `--origin ${origin.origin} and ${sameHostAndPort.origin} share the host and port ${origin.hostname}:${origin.port}; a request's Host could not tell them apart.` }
		const sameHostDefault = origin.defaultPort && origins.find(other => other.hostname === origin.hostname && other.defaultPort)
		if (sameHostDefault)
			return { ok: false, message: `--origin ${origin.origin} and ${sameHostDefault.origin} are on the same host and both use their scheme's default port; browsers send the same Host ${origin.hostname} for both.` }
		if (origin.loopback && origin.port === input.port)
			return { ok: false, message: `--origin ${origin.origin} is the loopback address ${origin.hostname}:${origin.port} that the server already serves; list only origins that reach it another way.` }
		origins.push(origin)
	}
	if (wildcard && origins.length === 0)
		return { ok: false, message: `--host ${bindHost} listens on every network interface, so it needs at least one --origin naming how people reach the server (such as --origin http://10.0.0.5:${input.port}).` }
	return { ok: true, value: Object.freeze({ bindHost, wildcard, origins: Object.freeze(origins) }) }
}

/** The handoff value `uiux dev` passes to the server it spawns. */
export function encodeDevHandoff(input: Readonly<{ host?: string; origins: readonly string[] }>): string {
	return JSON.stringify({ host: input.host ?? null, origins: input.origins })
}

/** Reads the handoff back (the server validates it again, against its own port). */
export function decodeDevHandoff(raw: string, port: number): Resolution<NetworkConfig> {
	let value: unknown
	try { value = JSON.parse(raw) }
	catch { return { ok: false, message: `${DEV_HANDOFF_VARIABLE} is not valid JSON.` } }
	const record = value as { host?: unknown; origins?: unknown } | null
	if (typeof record !== 'object' || record === null || (record.host !== null && typeof record.host !== 'string') || !Array.isArray(record.origins) || !record.origins.every(item => typeof item === 'string'))
		return { ok: false, message: `${DEV_HANDOFF_VARIABLE} is malformed.` }
	return resolveNetworkConfig({ ...(typeof record.host === 'string' ? { host: record.host } : {}), origins: record.origins as string[], port })
}

/** The port Nitro's node-server entry binds: `NITRO_PORT || PORT`, default 3000. */
export function resolveListenPort(env: Readonly<Record<string, string | undefined>>): number {
	const raw = env.NITRO_PORT || env.PORT
	const port = raw === undefined ? Number.NaN : Number(raw)
	return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 3000
}

/** An `http` configured origin that is not a loopback origin crosses the network in clear text. */
export function isPlaintextNetworkOrigin(origin: ConfiguredOrigin): boolean {
	return origin.scheme === 'http' && !origin.loopback
}

/**
 * Startup output (Rules 01a12500-b4af-7446-a66e-40de3db3dac2 and
 * 01a12500-b2db-7083-973d-1bf90a859a5b): the loopback URL, each configured origin, and a
 * plaintext warning for each `http` origin that is not a loopback origin.
 */
export function startupLines(loopbackUrl: string, network: NetworkConfig): readonly string[] {
	const lines = [`uiux: loopback URL ${loopbackUrl}`]
	for (const origin of network.origins) lines.push(`uiux: configured origin ${origin.origin}`)
	for (const origin of network.origins.filter(isPlaintextNetworkOrigin))
		lines.push(`uiux: warning: ${origin.origin} is plain HTTP. Sign-in links, session cookies and Tokens cross the network in clear text there, and roster administration is refused on it. Prefer an https origin served by a TLS-terminating proxy.`)
	return lines
}

/** Whether `address` (a socket's `remoteAddress`) is a loopback peer. */
export function isLoopbackPeer(address: string | undefined): boolean {
	// A socket without an IP peer is a local (Unix domain) socket.
	if (address === undefined || address === '') return true
	const normalized = address.toLowerCase()
	if (normalized === '::1') return true
	const v4 = normalized.startsWith('::ffff:') ? normalized.slice(7) : normalized
	return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(v4)
}

let serverNetwork: NetworkConfig = LOOPBACK_ONLY_NETWORK

/** Set once by the Nitro plugin at startup (and by tests). */
export function setServerNetwork(network: NetworkConfig): void {
	serverNetwork = network
}

export function getServerNetwork(): NetworkConfig {
	return serverNetwork
}
