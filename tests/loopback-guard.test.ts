import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp, createRouter, defineEventHandler, toNodeListener } from 'h3'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import mcpRoute from '../server/routes/mcp'
import createViewRoute from '../server/api/views.post'
import {
	createLoopbackGuardHandler,
	evaluateLoopbackRequest,
	evaluateRequestGate,
	formatOriginHost,
	resolveLoopbackBindHost,
	SECURITY_HEADERS,
} from '../src/server/loopback-guard'
import { resolveNetworkConfig } from '../src/server/network-access'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { createAccessGuardHandler } from '../src/server/access/http'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import { provisionToken } from './support/access'

const PORT = 4321
const VIEW_ID = '77777777-7777-4777-8777-777777777777'

function evaluate(method: string, path: string, headers: IncomingHttpHeaders, localPort: number | null = PORT) {
	return evaluateLoopbackRequest({ method, path, headers, localPort: localPort ?? undefined })
}

const json = { 'content-type': 'application/json', 'content-length': '2' }

describe('loopback bind resolution', () => {
	it('defaults to 127.0.0.1 and accepts explicit loopback hosts', () => {
		expect(resolveLoopbackBindHost({})).toEqual({ ok: true, host: '127.0.0.1' })
		expect(resolveLoopbackBindHost({ HOST: '' })).toEqual({ ok: true, host: '127.0.0.1' })
		expect(resolveLoopbackBindHost({ HOST: 'localhost' })).toEqual({ ok: true, host: 'localhost' })
		expect(resolveLoopbackBindHost({ NITRO_HOST: '[::1]' })).toEqual({ ok: true, host: '::1' })
		expect(resolveLoopbackBindHost({ NITRO_HOST: '::1', HOST: '127.0.0.1' })).toEqual({ ok: true, host: '::1' })
		// Nitro binds NITRO_HOST || HOST, so an inherited HOST is irrelevant once NITRO_HOST is loopback.
		expect(resolveLoopbackBindHost({ NITRO_HOST: '127.0.0.1', HOST: 'my-mac.local' })).toEqual({ ok: true, host: '127.0.0.1' })
	})

	it('keeps a packaged server run directly loopback-only, a wildcard HOST included, and points to uiux dev', () => {
		for (const env of [{ HOST: '0.0.0.0' }, { NITRO_HOST: '::' }, { HOST: '192.168.1.20' }, { NITRO_HOST: '10.0.0.2', HOST: '127.0.0.1' }]) {
			const result = resolveLoopbackBindHost(env)
			expect(result.ok).toBe(false)
			if (!result.ok) expect(result.message).toMatch(/listens on loopback only .* uiux dev --host <address> --origin <url>/u)
		}
	})

	it('brackets IPv6 loopback in origins', () => {
		expect(formatOriginHost('::1')).toBe('[::1]')
		expect(formatOriginHost('127.0.0.1')).toBe('127.0.0.1')
	})
})

describe('loopback request policy', () => {
	it('accepts only loopback Host values on the bound port', () => {
		for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, `LOCALHOST:${PORT}`])
			expect(evaluate('GET', '/', { host })).toBeUndefined()

		for (const host of [`attacker.test:${PORT}`, `127.0.0.1.attacker.test:${PORT}`, `192.168.1.20:${PORT}`, `0.0.0.0:${PORT}`, `127.0.0.1:${PORT + 1}`, '127.0.0.1', `user@127.0.0.1:${PORT}`, '']) {
			const rejection = evaluate('GET', '/', { host })
			expect(rejection?.status, host).toBe(421)
			expect(rejection?.body.code).toBe('request.host_rejected')
		}
		expect(evaluate('GET', '/', {})?.status).toBe(421)
	})

	it('ignores the Host port only when the caller opts out (Nuxt dev proxy)', () => {
		expect(evaluate('GET', '/', { host: 'localhost:3000' }, null)).toBeUndefined()
		expect(evaluate('GET', '/', { host: 'attacker.test:3000' }, null)?.status).toBe(421)
	})

	it('blocks DNS-rebinding Host values on /mcp, /api and SPA assets alike', () => {
		for (const path of ['/mcp', '/api/views', '/api/history/versions', '/_nuxt/entry.js', '/preview'])
			expect(evaluate('GET', path, { host: `rebind.attacker.test:${PORT}` })?.status).toBe(421)
		expect(evaluate('POST', '/mcp', { host: `rebind.attacker.test:${PORT}`, ...json })?.status).toBe(421)
	})

	it('allows same-origin and Origin-less (non-browser) mutations', () => {
		const host = `127.0.0.1:${PORT}`
		expect(evaluate('POST', '/api/views', { host, ...json })).toBeUndefined()
		expect(evaluate('POST', '/api/views', { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', ...json })).toBeUndefined()
		expect(evaluate('PUT', '/api/views/x/spec', { host: `localhost:${PORT}`, origin: `http://localhost:${PORT}`, ...json })).toBeUndefined()
		expect(evaluate('POST', '/mcp', { host: `[::1]:${PORT}`, origin: `http://[::1]:${PORT}`, 'content-type': 'application/json; charset=utf-8', 'transfer-encoding': 'chunked' })).toBeUndefined()
		expect(evaluate('DELETE', '/mcp', { host })).toBeUndefined()
		expect(evaluate('POST', '/api/reviews/x/ready', { host, 'sec-fetch-site': 'none', ...json })).toBeUndefined()
	})

	it('blocks cross-origin mutations, including other loopback origins and opaque origins', () => {
		const host = `127.0.0.1:${PORT}`
		for (const origin of ['https://attacker.test', `http://localhost:${PORT}`, 'http://127.0.0.1:5173', `https://127.0.0.1:${PORT}`, 'null', 'not a url']) {
			for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
				const rejection = evaluate(method, '/api/views', { host, origin, ...json })
				expect(rejection?.status, `${method} ${origin}`).toBe(403)
				expect(rejection?.body.code).toBe('request.origin_rejected')
			}
		}
		expect(evaluate('POST', '/mcp', { host, origin: 'https://attacker.test', ...json })?.status).toBe(403)
	})

	it('blocks Sec-Fetch-Site cross-site and same-site mutations', () => {
		const host = `127.0.0.1:${PORT}`
		for (const site of ['cross-site', 'same-site']) {
			const rejection = evaluate('POST', '/api/reviews', { host, 'sec-fetch-site': site, ...json })
			expect(rejection?.status).toBe(403)
			expect(rejection?.body.code).toBe('request.cross_site_rejected')
		}
	})

	it('applies Origin and Sec-Fetch-Site to every /mcp method but not to safe /api reads', () => {
		const host = `127.0.0.1:${PORT}`
		expect(evaluate('GET', '/mcp', { host, origin: 'https://attacker.test' })?.status).toBe(403)
		expect(evaluate('GET', '/mcp', { host, 'sec-fetch-site': 'cross-site' })?.status).toBe(403)
		expect(evaluate('GET', '/api/health', { host, origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' })).toBeUndefined()
	})

	it('requires application/json for mutation bodies (no simple-request form or text posts)', () => {
		const host = `127.0.0.1:${PORT}`
		for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'application/json-patch+json']) {
			const rejection = evaluate('POST', '/api/views', { host, 'content-type': contentType, 'content-length': '10' })
			expect(rejection?.status, contentType).toBe(415)
			expect(rejection?.body.code).toBe('request.content_type_rejected')
		}
		expect(evaluate('POST', '/api/views', { host, 'content-length': '10' })?.status).toBe(415)
		expect(evaluate('POST', '/api/reviews/x/ready', { host, 'content-length': '0' })).toBeUndefined()
	})
})

describe('request gate with configured origins', () => {
	const network = resolveNetworkConfig({ host: '0.0.0.0', origins: ['https://uiux.corp.example', 'http://10.0.0.5:3000', 'http://uiux-lan.test:8080', 'http://localhost:8443'], port: PORT })
	if (!network.ok) throw new Error(network.message)
	const origins = network.value.origins
	const gate = (method: string, path: string, headers: IncomingHttpHeaders, remoteAddress = '192.168.1.20') =>
		evaluateRequestGate({ method, path, headers, localPort: PORT, remoteAddress, origins })

	it('keeps the loopback default when no origin is configured', () => {
		expect(evaluateRequestGate({ method: 'GET', path: '/', headers: { host: `127.0.0.1:${PORT}` }, localPort: PORT, remoteAddress: '127.0.0.1' })).toMatchObject({ ok: true, origin: { origin: `http://127.0.0.1:${PORT}`, kind: 'loopback' } })
		expect(evaluateRequestGate({ method: 'GET', path: '/', headers: { host: `uiux.corp.example` }, localPort: PORT, remoteAddress: '127.0.0.1' })).toMatchObject({ ok: false, rejection: { status: 421 } })
	})

	it('matches a configured host and port, and a port-less Host to the one default-port origin', () => {
		expect(gate('GET', '/', { host: 'uiux.corp.example' })).toMatchObject({ ok: true, origin: { origin: 'https://uiux.corp.example', kind: 'configured', scheme: 'https', loopbackHost: false } })
		expect(gate('GET', '/', { host: 'UIUX.corp.example:443' })).toMatchObject({ ok: true, origin: { origin: 'https://uiux.corp.example' } })
		expect(gate('GET', '/', { host: '10.0.0.5:3000' })).toMatchObject({ ok: true, origin: { origin: 'http://10.0.0.5:3000', scheme: 'http' } })
		expect(gate('GET', '/', { host: 'uiux-lan.test:8080' })).toMatchObject({ ok: true, origin: { origin: 'http://uiux-lan.test:8080' } })
		// A port-less Host means the scheme's default port; these origins use other ports.
		for (const host of ['10.0.0.5', 'uiux-lan.test', 'uiux.corp.example:80', 'uiux.corp.example:3000', '10.0.0.5:8080'])
			expect(gate('GET', '/', { host }), host).toMatchObject({ ok: false, rejection: { status: 421, body: { code: 'request.host_rejected' } } })
	})

	it('still refuses a foreign Host on every path', () => {
		for (const path of ['/', '/mcp', '/api/views', '/_nuxt/entry.js'])
			for (const host of ['rebind.attacker.test', `attacker.test:${PORT}`, 'uiux.corp.example.attacker.test', `0.0.0.0:${PORT}`, `192.168.1.20:${PORT}`, 'user@uiux.corp.example'])
				expect(gate('GET', path, { host }), `${host} ${path}`).toMatchObject({ ok: false, rejection: { status: 421 } })
	})

	it('accepts a loopback Host only from a loopback peer', () => {
		for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.8.9.10'])
			expect(gate('GET', '/', { host: `localhost:${PORT}` }, peer), String(peer)).toMatchObject({ ok: true, origin: { kind: 'loopback' } })
		for (const peer of ['192.168.1.20', '10.0.0.7', '::ffff:10.0.0.7', 'fe80::1']) {
			for (const host of [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`, 'localhost:8443'])
				expect(gate('GET', '/', { host }, peer), `${host} from ${peer}`).toMatchObject({ ok: false, rejection: { status: 421, body: { code: 'request.host_rejected' } } })
		}
		// A configured origin on a loopback host name is a loopback origin, also for the peer check.
		expect(gate('GET', '/', { host: 'localhost:8443' }, '127.0.0.1')).toMatchObject({ ok: true, origin: { kind: 'configured', loopbackHost: true } })
	})

	it('requires a present Origin to equal the matched origin, scheme and port included, and allows a missing one', () => {
		expect(gate('POST', '/api/views', { host: 'uiux.corp.example', origin: 'https://uiux.corp.example', ...json })).toMatchObject({ ok: true })
		expect(gate('POST', '/api/views', { host: 'uiux.corp.example', ...json })).toMatchObject({ ok: true })
		expect(gate('POST', '/mcp', { host: '10.0.0.5:3000', ...json })).toMatchObject({ ok: true })
		expect(gate('GET', '/mcp', { host: '10.0.0.5:3000', origin: 'http://10.0.0.5:3000' })).toMatchObject({ ok: true })
		for (const [host, origin] of [
			['uiux.corp.example', 'http://uiux.corp.example'],
			['uiux.corp.example', 'https://uiux.corp.example:8443'],
			['10.0.0.5:3000', 'https://10.0.0.5:3000'],
			['10.0.0.5:3000', 'http://uiux-lan.test:8080'],
			['uiux-lan.test:8080', 'https://uiux.corp.example'],
			['uiux.corp.example', `http://127.0.0.1:${PORT}`],
		]) {
			for (const path of ['/api/views', '/mcp'])
				expect(gate('POST', path, { host, origin, ...json }), `${host} ${origin} ${path}`).toMatchObject({ ok: false, rejection: { status: 403, body: { code: 'request.origin_rejected' } } })
		}
	})

	it('never takes the origin or the scheme from forwarding headers', () => {
		const forwarded = { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'uiux.corp.example', 'x-forwarded-port': '443', forwarded: 'proto=https;host=uiux.corp.example' }
		expect(gate('GET', '/', { host: 'rebind.attacker.test', ...forwarded })).toMatchObject({ ok: false, rejection: { status: 421 } })
		expect(gate('GET', '/', { host: '10.0.0.5:3000', ...forwarded })).toMatchObject({ ok: true, origin: { origin: 'http://10.0.0.5:3000', scheme: 'http' } })
		expect(gate('POST', '/api/views', { host: '10.0.0.5:3000', origin: 'https://uiux.corp.example', ...forwarded, ...json })).toMatchObject({ ok: false, rejection: { status: 403 } })
	})
})

describe('loopback guard on a live h3 server with the real /mcp and /api routes', () => {
	let root: string
	let server: Server
	let port: number
	let token: string
	const previousRoot = process.env.UIUX_WORKSPACE_ROOT
	const previousOrigin = process.env.UIUX_SERVER_ORIGIN

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), 'uiux-loopback-guard-'))
		await mkdir(join(root, '.uiux'), { recursive: true })
		await writeFile(join(root, '.uiux', 'workspace.json'), `${JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }, null, 2)}\n`)
		process.env.UIUX_WORKSPACE_ROOT = root
		process.env.UIUX_SERVER_ORIGIN = 'http://127.0.0.1:1'
		token = await provisionToken(root, { nickname: 'claude', kind: 'agent', role: 'editor' })

		const app = createApp()
		app.use(createLoopbackGuardHandler())
		app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
		const router = createRouter()
		router.use('/mcp', mcpRoute)
		router.post('/api/views', createViewRoute)
		router.get('/', defineEventHandler(event => {
			event.node.res.setHeader('content-type', 'text/html')
			return '<!doctype html><title>Workbench</title>'
		}))
		app.use(router)
		server = createServer(toNodeListener(app))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		port = (server.address() as AddressInfo).port
	})

	afterAll(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()))
		await closeSelectedWorkspaceServerRuntime()
		if (previousRoot === undefined) delete process.env.UIUX_WORKSPACE_ROOT
		else process.env.UIUX_WORKSPACE_ROOT = previousRoot
		if (previousOrigin === undefined) delete process.env.UIUX_SERVER_ORIGIN
		else process.env.UIUX_SERVER_ORIGIN = previousOrigin
		await rm(root, { recursive: true, force: true })
	})

	function send(method: string, path: string, headers: OutgoingHttpHeaders, body?: string) {
		return new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
				let text = ''
				res.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: text }))
			})
			req.once('error', reject)
			req.end(body)
		})
	}

	const initialize = JSON.stringify({
		jsonrpc: '2.0',
		id: 1,
		method: 'initialize',
		params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rebind', version: '1' } },
	})
	const mcpHeaders = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
	const viewBody = JSON.stringify({ id: VIEW_ID, name: 'Guarded', spec: { intent: 'x', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } })

	it('blocks a DNS-rebinding Host on /mcp before the MCP handler runs', async () => {
		const response = await send('POST', '/mcp', { ...mcpHeaders, host: `rebind.attacker.test:${port}` }, initialize)
		expect(response.status).toBe(421)
		expect(response.headers['content-type']).toMatch(/application\/json/u)
		expect(JSON.parse(response.body)).toMatchObject({ status: 'rejected', code: 'request.host_rejected' })
		expect(response.headers['access-control-allow-origin']).toBeUndefined()
	})

	it('blocks a cross-origin browser POST to /mcp', async () => {
		const response = await send('POST', '/mcp', { ...mcpHeaders, origin: 'https://attacker.test', 'sec-fetch-site': 'cross-site' }, initialize)
		expect(response.status).toBe(403)
		expect(response.headers['access-control-allow-origin']).toBeUndefined()
	})

	it('keeps Origin-less MCP clients working', async () => {
		const client = new Client({ name: 'uiux-loopback-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }))
			const tools = await client.listTools()
			expect(tools.tools.some(tool => tool.name === 'create_view')).toBe(true)
		}
		finally { await client.close() }
	})

	it('blocks cross-origin, cross-site and non-JSON /api mutations without touching the Workspace', async () => {
		const crossOrigin = await send('POST', '/api/views', { 'content-type': 'application/json', origin: 'https://attacker.test' }, viewBody)
		expect(crossOrigin.status).toBe(403)
		expect(JSON.parse(crossOrigin.body)).toMatchObject({ code: 'request.origin_rejected' })
		const crossSite = await send('POST', '/api/views', { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, viewBody)
		expect(crossSite.status).toBe(403)
		const formPost = await send('POST', '/api/views', { 'content-type': 'text/plain' }, viewBody)
		expect(formPost.status).toBe(415)
		const rebind = await send('POST', '/api/views', { 'content-type': 'application/json', host: `attacker.test:${port}` }, viewBody)
		expect(rebind.status).toBe(421)
		await expect(readdir(join(root, 'views'))).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('allows Origin-less and same-origin JSON /api mutations', async () => {
		const sameOrigin = await send('POST', '/api/views', { 'content-type': 'application/json', authorization: `Bearer ${token}`, origin: `http://127.0.0.1:${port}`, 'sec-fetch-site': 'same-origin' }, viewBody)
		expect(sameOrigin.status).toBe(201)
		const noOrigin = await send('POST', '/api/views', { 'content-type': 'application/json', authorization: `Bearer ${token}` }, viewBody)
		expect(noOrigin.status).toBe(409)
		expect(JSON.parse(noOrigin.body)).toMatchObject({ status: 'already_exists' })
	})

	it('sends framing protection and no CORS headers on HTML responses', async () => {
		const response = await send('GET', '/', {})
		expect(response.status).toBe(200)
		for (const [name, value] of Object.entries(SECURITY_HEADERS))
			expect(response.headers[name.toLowerCase()]).toBe(value)
		expect(Object.keys(response.headers).filter(name => name.startsWith('access-control-'))).toEqual([])
	})
})
