import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import mcpRoute from '../server/routes/mcp'
import createViewRoute from '../server/api/views.post'
import updateViewSpecRoute from '../server/api/views/[id]/spec.put'
import readResourceRoute from '../server/api/resources/[kind]/[key].get'
import createReviewRoute from '../server/api/reviews.post'
import resolveReviewRoute from '../server/api/reviews/[id]/resolve.post'
import healthRoute from '../server/api/health.get'
import loginRoute from '../server/api/session/login.post'
import sessionGetRoute from '../server/api/session.get'
import sessionDeleteRoute from '../server/api/session.delete'
import locksRoute from '../server/api/locks.get'
import lockDeleteRoute from '../server/api/locks/[kind]/[key].delete'
import membersGetRoute from '../server/api/access/members.get'
import membersPostRoute from '../server/api/access/members.post'
import memberPatchRoute from '../server/api/access/members/[id].patch'
import memberDeleteRoute from '../server/api/access/members/[id].delete'
import tokensGetRoute from '../server/api/access/tokens.get'
import tokensPostRoute from '../server/api/access/tokens.post'
import tokenDeleteRoute from '../server/api/access/tokens/[id].delete'
import invitesPostRoute from '../server/api/access/invites.post'
import sessionsGetRoute from '../server/api/access/sessions.get'
import sessionDeleteByIdRoute from '../server/api/access/sessions/[id].delete'
import mcpAttemptsRoute from '../server/api/access/mcp-attempts.get'
import { createAccessGuardHandler } from '../src/server/access/http'
import { generateCredential } from '../src/server/access/credentials'
import { runAccessCommand } from '../src/cli/access'
import { createInvite, removeMember, revokeToken } from '../src/server/access/roster'
import { AccessStore, accessStorePaths, resolveUiuxHome } from '../src/server/access/store'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { LOOPBACK_ONLY_NETWORK, resolveNetworkConfig, setServerNetwork, type NetworkConfig } from '../src/server/network-access'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { provisionToken } from './support/access'
import { BUILT_IN_ACCESS_PRESETS, keysForRole, PERMISSION_KEYS } from '../src/application/access/keys'
import { writeCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const spec = { intent: 'x', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }

let root: string
let server: Server
let origin: string
let agentToken: string
let ownerCookie: string
let inviteLink: string | undefined
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-access-http-')))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	process.env.UIUX_WORKSPACE_ROOT = root

	server = createServer(toNodeListener(buildApp()))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin

	// First run: no human Owner yet, so the server creates one and mints a single-use invite.
	const banner = await (await getSelectedWorkspaceServerRuntime().access()).bootstrap([origin])
	inviteLink = banner?.find(line => line.includes('/login#'))?.trim().split(' ').at(-1)
	agentToken = await provisionToken(root, { nickname: 'claude', kind: 'agent', role: 'editor' })
})

/** The real routes behind the request gate and the access guard, with the given bind and origin configuration. */
function buildApp(network?: () => NetworkConfig) {
	const app = createApp()
	app.use(createLoopbackGuardHandler(network ? { network } : {}))
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.use('/mcp', mcpRoute)
	router.get('/api/health', healthRoute)
	router.post('/api/views', createViewRoute)
	router.put('/api/views/:id/spec', updateViewSpecRoute)
	router.get('/api/resources/:kind/:key', readResourceRoute)
	router.post('/api/reviews', createReviewRoute)
	router.post('/api/reviews/:id/resolve', resolveReviewRoute)
	router.post('/api/session/login', loginRoute)
	router.get('/api/session', sessionGetRoute)
	router.delete('/api/session', sessionDeleteRoute)
	router.get('/api/locks', locksRoute)
	router.delete('/api/locks/:kind/:key', lockDeleteRoute)
	router.get('/api/access/members', membersGetRoute)
	router.post('/api/access/members', membersPostRoute)
	router.patch('/api/access/members/:id', memberPatchRoute)
	router.delete('/api/access/members/:id', memberDeleteRoute)
	router.get('/api/access/tokens', tokensGetRoute)
	router.post('/api/access/tokens', tokensPostRoute)
	router.delete('/api/access/tokens/:id', tokenDeleteRoute)
	router.post('/api/access/invites', invitesPostRoute)
	router.get('/api/access/sessions', sessionsGetRoute)
	router.delete('/api/access/sessions/:id', sessionDeleteByIdRoute)
	router.get('/api/access/mcp-attempts', mcpAttemptsRoute)
	router.get('/login', () => '<!doctype html><title>Sign in</title>')
	app.use(router)
	return app
}

afterAll(async () => {
	await new Promise<void>(resolve => server.close(() => resolve()))
	await closeSelectedWorkspaceServerRuntime()
	for (const [name, value] of [['UIUX_WORKSPACE_ROOT', previous.root], ['UIUX_SERVER_ORIGIN', previous.origin]] as const) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await rm(root, { recursive: true, force: true })
})

const json = (body: unknown, headers: Record<string, string> = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const bearer = (token: string) => ({ authorization: `Bearer ${token}` })
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('first-run bootstrap and sign-in', () => {
	it('prints a one-time Owner sign-in link only once, and signs a browser in through the fragment invite', async () => {
		expect(inviteLink).toMatch(new RegExp(`^${origin}/login#uiux_i_[a-z2-7]{4}_`, 'u'))
		expect(await (await getSelectedWorkspaceServerRuntime().access()).bootstrap([origin])).toBeUndefined()
		const invite = inviteLink!.split('#')[1]!
		const login = await fetch(`${origin}/api/session/login`, json({ credential: invite }))
		expect(login.status).toBe(200)
		// Clause 01a11485-faa9: the session wire carries the keys and the label, not a role.
		const signedIn = await login.json() as { member: Record<string, unknown> }
		expect(signedIn).toEqual({ member: { id: expect.any(String), nickname: expect.any(String), kind: 'human', keys: [...PERMISSION_KEYS], label: { preset: { id: 'owner', name: 'Owner' } } } })
		const cookie = login.headers.get('set-cookie')!
		expect(cookie).toMatch(/^uiux_session_[a-z2-7]{4}=uiux_s_[a-z2-7]{4}_/u)
		expect(cookie).toContain('HttpOnly')
		expect(cookie).toContain('SameSite=Strict')
		expect(cookie).toContain('Path=/')
		expect(cookie).not.toContain('Secure')
		ownerCookie = cookie.split(';', 1)[0]!

		// Single use.
		const reused = await fetch(`${origin}/api/session/login`, json({ credential: invite }))
		expect(reused.status).toBe(401)
		expect(await reused.json()).toMatchObject({ code: 'auth.invalid_credential' })

		const me = await fetch(`${origin}/api/session`, { headers: { cookie: ownerCookie } })
		const current = await me.json() as { member: Record<string, unknown> }
		expect(current).toMatchObject({ member: { kind: 'human', keys: [...PERMISSION_KEYS], label: { preset: { id: 'owner', name: 'Owner' } } }, credential: 'session', workspaceRoot: root })
		expect(current.member).not.toHaveProperty('role')
		expect(current.member).toEqual(signedIn.member)
	})
})

describe('configured origins (Feature 01a12500-a0a0-74c0-b83b-3dbb628689e4)', () => {
	const LAN = 'http://uiux-lan.test:8080'
	const PROXIED = 'https://uiux.corp.example'
	let proxyServer: Server
	let proxyPort: number

	beforeAll(async () => {
		const resolved = resolveNetworkConfig({ host: '0.0.0.0', origins: [LAN, PROXIED], port: 3000 })
		if (!resolved.ok) throw new Error(resolved.message)
		// The /mcp route reads the server-wide configuration for the SDK's own host check.
		setServerNetwork(resolved.value)
		proxyServer = createServer(toNodeListener(buildApp(() => resolved.value)))
		await new Promise<void>(resolve => proxyServer.listen(0, '127.0.0.1', resolve))
		proxyPort = (proxyServer.address() as AddressInfo).port
	})

	afterAll(async () => {
		await new Promise<void>(resolve => proxyServer.close(() => resolve()))
		setServerNetwork(LOOPBACK_ONLY_NETWORK)
	})

	/** A request as a same-host reverse proxy forwards it: the client's `Host`, from a loopback peer. */
	function send(host: string, method: string, path: string, headers: OutgoingHttpHeaders = {}, body?: unknown) {
		const payload = body === undefined ? undefined : JSON.stringify(body)
		return new Promise<{ status: number; headers: IncomingHttpHeaders; json: () => Record<string, unknown> }>((resolve, reject) => {
			const req = httpRequest({ host: '127.0.0.1', port: proxyPort, method, path, headers: { host, ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...headers } }, (res) => {
				let text = ''
				res.setEncoding('utf8').on('data', chunk => text += chunk).on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: () => JSON.parse(text) as Record<string, unknown> }))
			})
			req.once('error', reject)
			req.end(payload)
		})
	}

	async function ownerInvite(): Promise<string> {
		const store = (await AccessStore.open({ workspaceRoot: root }))!
		const owner = store.data.members.find(member => member.kind === 'human' && member.keys.includes('members.manage'))!
		return (await store.update(file => createInvite(file, { nickname: owner.nickname }))).credential
	}

	async function signIn(host: string, headers: OutgoingHttpHeaders = {}) {
		const response = await send(host, 'POST', '/api/session/login', headers, { credential: await ownerInvite() })
		expect(response.status).toBe(200)
		const setCookie = String(response.headers['set-cookie'])
		return { setCookie, cookie: setCookie.split(';', 1)[0]! }
	}

	it('sets Secure on the session cookie only for an https origin, whatever X-Forwarded-Proto says', async () => {
		const secure = await signIn('uiux.corp.example', { 'x-forwarded-proto': 'http' })
		expect(secure.setCookie).toMatch(/; Secure$/u)
		expect(secure.setCookie).toContain('SameSite=Strict')
		const plain = await signIn('uiux-lan.test:8080', { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'uiux.corp.example' })
		expect(plain.setCookie).not.toContain('Secure')
		// Sign-out clears the cookie with the same attribute.
		const out = await send('uiux.corp.example', 'DELETE', '/api/session', { cookie: secure.cookie })
		expect(out.status).toBe(200)
		expect(String(out.headers['set-cookie'])).toMatch(/Max-Age=0; Secure$/u)
	})

	it('refuses roster administration on an http origin with access.admin_origin_rejected, before the permission check', async () => {
		const { cookie } = await signIn('uiux-lan.test:8080')
		// The member holds members.manage and is signed in on that origin, yet no Token is created.
		const store = (await AccessStore.open({ workspaceRoot: root }))!
		const before = store.data.tokens.length
		const claude = store.data.members.find(member => member.nickname === 'claude')!
		const created = await send('uiux-lan.test:8080', 'POST', '/api/access/tokens', { cookie, origin: LAN }, { memberId: claude.id })
		expect(created.status).toBe(403)
		expect(created.json()).toMatchObject({ code: 'access.admin_origin_rejected' })
		await store.refresh({ force: true })
		expect(store.data.tokens.length).toBe(before)
		for (const [method, path, body] of [['GET', '/api/access/members'], ['GET', '/api/access/tokens'], ['GET', '/api/access/sessions'], ['GET', '/api/access/mcp-attempts'], ['POST', '/api/access/invites', { memberId: claude.id }], ['POST', '/api/access/members', { nickname: 'x' }]] as const) {
			const refused = await send('uiux-lan.test:8080', method, path, { cookie, ...(method === 'POST' ? { origin: LAN } : {}) }, body)
			expect(refused.status, `${method} ${path}`).toBe(403)
			expect(refused.json()).toMatchObject({ code: 'access.admin_origin_rejected' })
		}
		// Precedence (Clause 01a12500-a619-7fa5-b7f6-797adaf52f34): an Agent's Token lacks members.manage
		// and would get auth.scope_denied anywhere else.
		const agent = await send('uiux-lan.test:8080', 'GET', '/api/access/members', bearer(agentToken))
		expect(agent.status).toBe(403)
		expect(agent.json()).toMatchObject({ code: 'access.admin_origin_rejected' })
		expect((await send('uiux.corp.example', 'GET', '/api/access/members', bearer(agentToken))).json()).toMatchObject({ code: 'auth.scope_denied' })
		// Everything else works there like on loopback (Rule 01a12500-af31-7c3e-b619-78c128f18a1d).
		expect((await send('uiux-lan.test:8080', 'GET', '/api/session', { cookie })).status).toBe(200)
		expect((await send('uiux-lan.test:8080', 'GET', '/api/resources/workspace/workspace', bearer(agentToken))).status).toBe(200)
	})

	it('serves roster administration on an https origin and names the matched origin in sign-in links', async () => {
		const { cookie } = await signIn('uiux.corp.example')
		expect((await send('uiux.corp.example', 'GET', '/api/access/members', { cookie })).status).toBe(200)
		const store = (await AccessStore.open({ workspaceRoot: root }))!
		const owner = store.data.members.find(member => member.kind === 'human' && member.keys.includes('members.manage'))!
		const invite = await send('uiux.corp.example', 'POST', '/api/access/invites', { cookie, origin: PROXIED, 'x-forwarded-host': 'evil.test', 'x-forwarded-proto': 'http' }, { memberId: owner.id })
		expect(invite.status).toBe(201)
		expect(invite.json().url).toMatch(/^https:\/\/uiux\.corp\.example\/login#uiux_i_/u)
		// The link's origin is the server's choice, never the client's.
		const chosen = await send('uiux.corp.example', 'POST', '/api/access/invites', { cookie, origin: PROXIED }, { memberId: owner.id, origin: 'https://attacker.test' })
		expect(chosen.status).toBe(400)
	})

	it('binds a session to its origin: a cookie replayed on another origin authenticates nothing', async () => {
		const lan = await signIn('uiux-lan.test:8080')
		const replayed = await send('uiux.corp.example', 'GET', '/api/access/members', { cookie: lan.cookie })
		expect(replayed.status).toBe(401)
		expect(replayed.json()).toMatchObject({ code: 'auth.invalid_credential' })
		// The cookie stays valid on its own origin.
		expect((await send('uiux-lan.test:8080', 'GET', '/api/session', { cookie: lan.cookie })).status).toBe(200)
		// A loopback session does not reach a configured origin either.
		expect((await send('uiux.corp.example', 'GET', '/api/session', { cookie: ownerCookie })).status).toBe(401)
	})

	it('checks Origin against the matched origin, scheme included, and records the origin of rejected /mcp attempts', async () => {
		const mismatched = await send('uiux.corp.example', 'POST', '/api/views', { ...bearer(agentToken), origin: 'http://uiux.corp.example' }, { name: 'x', spec })
		expect(mismatched.status).toBe(403)
		expect(mismatched.json()).toMatchObject({ code: 'request.origin_rejected' })
		expect((await send('uiux-lan.test:8080', 'POST', '/api/views', { ...bearer(agentToken), origin: PROXIED }, { name: 'x', spec })).status).toBe(403)
		const mcpHeaders = { accept: 'application/json, text/event-stream', 'user-agent': 'lan-agent/1.0' }
		const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }
		expect((await send('uiux-lan.test:8080', 'POST', '/mcp', mcpHeaders, initialize)).status).toBe(401)
		expect((await send('uiux-lan.test:8080', 'POST', '/mcp', { ...mcpHeaders, origin: PROXIED }, initialize)).status).toBe(403)
		expect((await send('uiux-lan.test:8080', 'POST', '/mcp', { ...mcpHeaders, ...bearer(agentToken), origin: LAN }, initialize)).status).toBe(200)
		const { cookie } = await signIn('uiux.corp.example')
		const attempts = (await send('uiux.corp.example', 'GET', '/api/access/mcp-attempts', { cookie })).json() as { recent: { userAgent: string; origin: string }[] }
		expect(attempts.recent.find(item => item.userAgent === 'lan-agent/1.0')).toMatchObject({ origin: LAN })
	})

	it('refuses a foreign Host and a configured host name on another port', async () => {
		expect((await send('rebind.attacker.test', 'GET', '/api/health')).status).toBe(421)
		expect((await send('uiux-lan.test', 'GET', '/api/health')).status).toBe(421)
		expect((await send('uiux.corp.example:8443', 'GET', '/api/health')).status).toBe(421)
		expect((await send('uiux.corp.example:443', 'GET', '/api/health')).status).toBe(200)
	})
})

describe('authentication on every surface', () => {
	it('keeps health, the SPA and /login public, answers /.well-known with a JSON 404 and requires a principal elsewhere', async () => {
		expect((await fetch(`${origin}/api/health`)).status).toBe(200)
		expect((await fetch(`${origin}/login`)).status).toBe(200)
		const wellKnown = await fetch(`${origin}/.well-known/oauth-protected-resource`)
		expect(wellKnown.status).toBe(404)
		expect(wellKnown.headers.get('content-type')).toContain('application/json')
		const missing = await fetch(`${origin}/api/resources/workspace/workspace`)
		expect(missing.status).toBe(401)
		expect(await missing.json()).toMatchObject({ status: 'rejected', code: 'auth.required' })
		const bad = await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer('nonsense') })
		expect(await bad.json()).toMatchObject({ code: 'auth.invalid_credential' })
		const scripted = await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(agentToken) })
		expect(scripted.status).toBe(200)
	})

	it('answers /mcp without a valid token with 401, WWW-Authenticate and the fix, and ignores cookies there', async () => {
		const initialize = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } })
		const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'user-agent': 'unconfigured-agent/1.0' }
		const none = await fetch(`${origin}/mcp`, { method: 'POST', headers, body: initialize })
		expect(none.status).toBe(401)
		expect(none.headers.get('www-authenticate')).toBe('Bearer realm="uiux"')
		const body = await none.json() as { code: string; message: string }
		expect(body.code).toBe('auth.required')
		expect(body.message).toContain('uiux token create --workspace')
		expect(body.message).toContain('Authorization: Bearer <token>')
		const cookieOnly = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...headers, cookie: ownerCookie }, body: initialize })
		expect(cookieOnly.status).toBe(401)
		const foreign = await fetch(`${origin}/mcp`, { method: 'POST', headers: { ...headers, ...bearer(generateCredential('token', 'zzzz').value) }, body: initialize })
		expect(foreign.status).toBe(401)
		const foreignBody = await foreign.json() as { code: string; message: string }
		expect(foreignBody.code).toBe('auth.invalid_credential')
		expect(foreignBody.message).toMatch(/belongs to roster zzzz; this server serves roster [a-z2-7]{4}/u)

		const client = new Client({ name: 'uiux-access-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: bearer(agentToken) } }))
			expect(client.getInstructions()).toMatch(/^Authenticated as claude \(agent, Editor\)\. Your effective permission keys: workspace\.read, history\.read, /u)
			const created = await client.callTool({ name: 'create_view', arguments: { id: VIEW_ID, name: 'Leased', spec } })
			expect(created.isError).not.toBe(true)
		}
		finally { await client.close() }

		// The Owner sees the rejected attempts.
		const attempts = await (await fetch(`${origin}/api/access/mcp-attempts`, { headers: { cookie: ownerCookie } })).json() as { total: number; recent: { userAgent: string; code: string }[] }
		expect(attempts.total).toBeGreaterThanOrEqual(3)
		expect(attempts.recent.some(item => item.userAgent === 'unconfigured-agent/1.0' && item.code === 'auth.required')).toBe(true)
	})

	it('maps the agent lease to 423 for a human write and lets the Owner force-release it over HTTP', async () => {
		const read = await (await fetch(`${origin}/api/resources/view/${VIEW_ID}`, { headers: { cookie: ownerCookie } })).json() as { revision: string }
		const locks = await (await fetch(`${origin}/api/locks`, { headers: { cookie: ownerCookie } })).json() as { locks: { kind: string; key: string; holder: { nickname: string } }[] }
		expect(locks.locks).toMatchObject([{ kind: 'view', key: VIEW_ID, holder: { nickname: 'claude', kind: 'agent' } }])
		const put = (headers: Record<string, string>) => fetch(`${origin}/api/views/${VIEW_ID}/spec`, { method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ expectedRevision: read.revision, spec: { ...spec, intent: 'human' } }) })
		const locked = await put({ cookie: ownerCookie })
		expect(locked.status).toBe(423)
		expect(await locked.json()).toMatchObject({ status: 'locked', code: 'resource.locked', lock: { holder: { nickname: 'claude' } } })
		// Force-release needs a human Owner on a cookie session: the agent's bearer token is refused.
		expect((await fetch(`${origin}/api/locks/view/${VIEW_ID}`, { method: 'DELETE', headers: bearer(agentToken) })).status).toBe(403)
		const released = await fetch(`${origin}/api/locks/view/${VIEW_ID}`, { method: 'DELETE', headers: { cookie: ownerCookie } })
		expect(released.status).toBe(200)
		expect((await put({ cookie: ownerCookie })).status).toBe(200)
	})

	it('refuses bearer tokens on resolve and on Owner administration', async () => {
		const review = await (await fetch(`${origin}/api/reviews`, json({ anchor: { viewId: VIEW_ID, widgetId: 'root' } }, bearer(agentToken)))).json() as { key: string; revision: string }
		const resolve = await fetch(`${origin}/api/reviews/${review.key}/resolve`, json({ expectedRevision: review.revision, resolution: 'answered' }, bearer(agentToken)))
		expect(await resolve.json()).toMatchObject({ code: 'review.resolve_requires_workbench' })
		const viaCookie = await fetch(`${origin}/api/reviews/${review.key}/resolve`, json({ expectedRevision: review.revision, resolution: 'answered' }, { cookie: ownerCookie }))
		expect(viaCookie.status).toBe(200)
		const admin = await fetch(`${origin}/api/access/members`, { headers: bearer(agentToken) })
		expect(admin.status).toBe(403)
		expect(await admin.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['members.manage'] })
		expect((await fetch(`${origin}/api/session`, { headers: bearer(agentToken) })).status).toBe(403)
	})

	it('refuses a human Owner\'s bearer Token a force-release, naming locks.force-release, and keeps the lease (Scenario 01a11c09-d861)', async () => {
		const members = (await AccessStore.open({ workspaceRoot: root }))!.data.members
		const owner = members.find(member => member.kind === 'human' && member.keys.includes('members.manage'))!
		const claude = members.find(member => member.nickname === 'claude')!
		// The signed-in Owner's own bearer Token.
		const leadToken = await provisionToken(root, { nickname: owner.nickname })
		const runtime = getSelectedWorkspaceServerRuntime()
		runtime.leases.acquire([{ kind: 'view', key: VIEW_ID }], { memberId: claude.id, nickname: 'claude', kind: 'agent' })
		const refused = await fetch(`${origin}/api/locks/view/${VIEW_ID}`, { method: 'DELETE', headers: bearer(leadToken) })
		expect(refused.status).toBe(403)
		const body = await refused.json() as { code: string; requiredKeys: string[]; message: string }
		expect(body).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['locks.force-release'] })
		expect(body.message).toContain('signed-in Workbench session')
		expect(runtime.leases.list()).toMatchObject([{ kind: 'view', key: VIEW_ID, holder: { nickname: 'claude' } }])
		// The same Owner on a cookie session releases it.
		expect((await fetch(`${origin}/api/locks/view/${VIEW_ID}`, { method: 'DELETE', headers: { cookie: ownerCookie } })).status).toBe(200)
		expect(runtime.leases.list()).toEqual([])
	})
})

describe('member keys over the administration wire (issue #142, P5)', () => {
	type WireMember = { id: string; nickname: string; kind: string; keys: string[]; label: unknown; role?: unknown }
	const headers = () => ({ cookie: ownerCookie })
	const patch = (id: string, body: unknown) => fetch(`${origin}/api/access/members/${id}`, { method: 'PATCH', headers: { ...headers(), 'content-type': 'application/json' }, body: JSON.stringify(body) })
	const listed = async () => await (await fetch(`${origin}/api/access/members`, { headers: headers() })).json() as { members: WireMember[]; presets: { id: string; name: string; keys: string[] }[] }
	async function add(body: unknown): Promise<Response> {
		return await fetch(`${origin}/api/access/members`, json(body, headers()))
	}
	/** Hand-edits a member's stored keys in the roster file, as a newer UIUX or a person might. */
	async function writeStoredKeys(nickname: string, keys: readonly string[]): Promise<void> {
		const { file } = accessStorePaths(resolveUiuxHome(), root)
		const roster = JSON.parse(await readFile(file, 'utf8')) as { members: { nickname: string; keys: string[] }[] }
		for (const member of roster.members) if (member.nickname === nickname) member.keys = [...keys]
		await writeFile(file, `${JSON.stringify(roster, null, 2)}\n`)
	}

	it('adds a member with an explicit key set and lists keys, labels and the presets, with no role (Rules 01a11c09-b85c and 01a11c09-ba13)', async () => {
		const response = await add({ nickname: 'kai', keys: ['views.write', 'workspace.read'] })
		expect(response.status).toBe(201)
		const { member } = await response.json() as { member: WireMember }
		expect(member).toMatchObject({ nickname: 'kai', kind: 'human', keys: ['workspace.read', 'views.write'], label: { custom: true } })
		expect(member).not.toHaveProperty('role')
		const roster = await listed()
		expect(roster.presets.map(preset => [preset.id, preset.name, preset.keys])).toEqual(BUILT_IN_ACCESS_PRESETS.map(preset => [preset.id, preset.name, preset.keys]))
		for (const item of roster.members) expect(item).not.toHaveProperty('role')
		expect(roster.members.find(item => item.nickname === 'kai')).toMatchObject({ keys: ['workspace.read', 'views.write'], label: { custom: true } })
		// The Editor preset applied on the page: the keys it lacks are granted, and the preset labels the member.
		const grant = keysForRole('human', 'editor').filter(key => !member.keys.includes(key))
		expect(await (await patch(member.id, { grant })).json()).toMatchObject({ member: { keys: keysForRole('human', 'editor'), label: { preset: { id: 'editor', name: 'Editor' } } } })
		expect((await fetch(`${origin}/api/access/members/${member.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	it('takes keys, not a role, and an edit takes keys to grant and revoke, not a whole key set', async () => {
		expect(await (await add({ nickname: 'old', role: 'viewer' })).json()).toMatchObject({ code: 'malformed_payload' })
		const owner = (await listed()).members.find(item => item.kind === 'human')!
		expect((await patch(owner.id, { role: 'viewer' })).status).toBe(400)
		expect(await (await patch(owner.id, { keys: [...PERMISSION_KEYS] })).json()).toMatchObject({ code: 'malformed_payload' })
		const both = await patch(owner.id, { grant: ['views.write'], revoke: ['views.write'] })
		expect(both.status).toBe(400)
		expect(await both.json()).toMatchObject({ code: 'access.invalid_keys', message: expect.stringContaining('`views.write`') })
		// At most 256 keys to grant or to revoke in one edit.
		const many = Array.from({ length: 257 }, (_, index) => `future.key${index}`)
		for (const change of [{ grant: many }, { revoke: many }]) {
			const refused = await patch(owner.id, change)
			expect(refused.status).toBe(400)
			expect(await refused.json()).toMatchObject({ code: 'malformed_payload' })
		}
		expect((await patch(owner.id, { revoke: many.slice(0, 256) })).status).toBe(200)
	})

	it('answers an edit that changes nothing with the member and leaves the roster unwritten', async () => {
		const owner = (await listed()).members.find(item => item.kind === 'human')!
		const { file } = accessStorePaths(resolveUiuxHome(), root)
		const before = await stat(file, { bigint: true })
		const text = await readFile(file, 'utf8')
		for (const body of [{}, { nickname: owner.nickname }, { kind: owner.kind }]) {
			const response = await patch(owner.id, body)
			expect(response.status).toBe(200)
			expect(await response.json()).toMatchObject({ member: { id: owner.id, nickname: owner.nickname, keys: owner.keys } })
		}
		const after = await stat(file, { bigint: true })
		expect([after.ino, after.mtimeNs]).toEqual([before.ino, before.mtimeNs])
		expect(await readFile(file, 'utf8')).toBe(text)
	})

	it('refuses a key outside the catalog, a humanOnly key for an Agent and a set lacking a requirement, naming the keys', async () => {
		const unknown = await add({ nickname: 'nova', keys: ['workspace.read', 'future.capability'] })
		expect(unknown.status).toBe(400)
		const unknownBody = await unknown.json() as { code: string; message: string }
		expect(unknownBody.code).toBe('access.unknown_key')
		expect(unknownBody.message).toContain('`future.capability`')

		const humanOnly = await add({ nickname: 'bot-admin', kind: 'agent', keys: ['workspace.read', 'members.manage'] })
		expect(humanOnly.status).toBe(400)
		const humanOnlyBody = await humanOnly.json() as { code: string; message: string }
		expect(humanOnlyBody.code).toBe('access.key_human_only')
		expect(humanOnlyBody.message).toContain('`members.manage`')

		const incomplete = await add({ nickname: 'nova', keys: ['views.write'] })
		expect(incomplete.status).toBe(400)
		expect(await incomplete.json()).toMatchObject({ code: 'access.key_requires', message: expect.stringContaining('`views.write` requires `workspace.read`') })
		expect((await listed()).members.map(item => item.nickname)).not.toContain('nova')

		// The same checks hold for the keys an edit grants and revokes.
		const { member: lena } = await (await add({ nickname: 'lena', keys: keysForRole('human', 'viewer') })).json() as { member: WireMember }
		expect(await (await patch(lena.id, { grant: ['future.capability'] })).json()).toMatchObject({ code: 'access.unknown_key', message: expect.stringContaining('`future.capability`') })
		expect(await (await patch(lena.id, { grant: ['reviews.submit'] })).json()).toMatchObject({ code: 'access.key_requires', message: expect.stringContaining('`reviews.submit` requires `reviews.write`') })
		const claude = (await listed()).members.find(item => item.nickname === 'claude')!
		expect(await (await patch(claude.id, { grant: ['members.manage'] })).json()).toMatchObject({ code: 'access.key_human_only', message: expect.stringContaining('`members.manage`') })
		expect((await listed()).members.find(item => item.id === lena.id)!.keys).toEqual(keysForRole('human', 'viewer'))
		expect((await fetch(`${origin}/api/access/members/${lena.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	it('refuses a change of kind with access.kind_immutable', async () => {
		const claude = (await listed()).members.find(item => item.nickname === 'claude')!
		const refused = await patch(claude.id, { kind: 'human', grant: ['members.manage'] })
		expect(refused.status).toBe(400)
		expect(await refused.json()).toMatchObject({ code: 'access.kind_immutable' })
		expect((await listed()).members.find(item => item.nickname === 'claude')).toMatchObject({ kind: 'agent', keys: keysForRole('agent', 'editor') })
	})

	it('keeps an unknown key the member holds when keys are granted, and refuses a new one (Rules 01a11c09-b7ec and 01a128be-99df)', async () => {
		const { member } = await (await add({ nickname: 'ivy', keys: keysForRole('human', 'viewer') })).json() as { member: WireMember }
		await writeStoredKeys('ivy', [...keysForRole('human', 'viewer'), 'future.capability'])
		expect((await listed()).members.find(item => item.nickname === 'ivy')).toMatchObject({ keys: [...keysForRole('human', 'viewer'), 'future.capability'], label: { custom: true } })
		// The Reviewer preset applied on the page grants the keys it adds; the unknown key the member holds stays.
		const grant = keysForRole('human', 'reviewer').filter(key => !keysForRole('human', 'viewer').includes(key))
		const applied = await patch(member.id, { grant })
		expect(applied.status).toBe(200)
		expect((await applied.json() as { member: WireMember }).member.keys).toEqual([...keysForRole('human', 'reviewer'), 'future.capability'])
		const added = await patch(member.id, { grant: ['future.other'] })
		expect(added.status).toBe(400)
		expect(await added.json()).toMatchObject({ code: 'access.unknown_key', message: expect.stringContaining('`future.other`') })
		// Unchecking a held unknown key revokes it.
		expect((await (await patch(member.id, { revoke: ['future.capability'] })).json() as { member: WireMember }).member.keys).toEqual(keysForRole('human', 'reviewer'))
		expect((await fetch(`${origin}/api/access/members/${member.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	it('lets a manager drop members.manage while another person holds it, and refuses the last one (Rule 01a11485-eae3)', async () => {
		const owner = (await listed()).members.find(item => item.kind === 'human' && item.keys.includes('members.manage'))!
		const { member: lead } = await (await add({ nickname: 'lead', keys: [...PERMISSION_KEYS] })).json() as { member: WireMember }
		const dropped = await patch(lead.id, { revoke: ['members.manage'] })
		expect(dropped.status).toBe(200)
		const last = await patch(owner.id, { revoke: ['members.manage'] })
		expect(last.status).toBe(409)
		expect(await last.json()).toMatchObject({ code: 'access.last_manager' })
		expect((await listed()).members.find(item => item.id === owner.id)!.keys).toContain('members.manage')
		expect((await fetch(`${origin}/api/access/members/${lead.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	/** `uiux member set` run in-process against the same Workspace and `UIUX_HOME` as the server. */
	async function cliMemberSet(...args: string[]): Promise<void> {
		const err: string[] = []
		const code = await runAccessCommand({ argv: ['member', 'set', ...args, '--workspace', root], env: { UIUX_HOME: resolveUiuxHome() }, stdout: () => {}, stderr: line => err.push(line) })
		expect(code, err.join('\n')).toBe(0)
	}

	it('does not revert a CLI revoke when a page loaded before it saves an unrelated change (owner ruling 1 of 2026-10-11 on PR #191)', async () => {
		const { member: lead } = await (await add({ nickname: 'lead2', keys: [...PERMISSION_KEYS] })).json() as { member: WireMember }
		// The page shows lead2 with every key; meanwhile the CLI takes members.manage away.
		const snapshot = (await listed()).members.find(item => item.id === lead.id)!
		expect(snapshot.keys).toContain('members.manage')
		await cliMemberSet('lead2', '--revoke', 'members.manage')
		// The stale page then unchecks an unrelated key and renames lead2: it sends only that change.
		const saved = await patch(lead.id, { revoke: ['locks.force-release'], nickname: 'lead-two' })
		expect(saved.status).toBe(200)
		const { member } = await saved.json() as { member: WireMember }
		expect(member.nickname).toBe('lead-two')
		expect(member.keys).not.toContain('members.manage')
		expect(member.keys).not.toContain('locks.force-release')
		expect(member.keys).toEqual(PERMISSION_KEYS.filter(key => key !== 'members.manage' && key !== 'locks.force-release'))
		expect((await listed()).members.find(item => item.id === lead.id)!.keys).not.toContain('members.manage')
		expect((await fetch(`${origin}/api/access/members/${lead.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	it('renames a member alone without rewriting a stored key set that lacks a requirement (Rule 01a11c33-24ab)', async () => {
		const { member } = await (await add({ nickname: 'gap', keys: keysForRole('human', 'viewer') })).json() as { member: WireMember }
		await writeStoredKeys('gap', ['views.write'])
		const renamed = await patch(member.id, { nickname: 'gap-2' })
		expect(renamed.status).toBe(200)
		expect((await renamed.json() as { member: WireMember }).member).toMatchObject({ nickname: 'gap-2', keys: ['views.write'] })
		// Any key change stores the set anew, so it is checked, as `uiux member set --grant` checks it.
		expect(await (await patch(member.id, { grant: ['views.write'] })).json()).toMatchObject({ code: 'access.key_requires' })
		expect((await fetch(`${origin}/api/access/members/${member.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})

	it('does not remove a CLI grant when a page loaded before it saves an unrelated change', async () => {
		const { member: rae } = await (await add({ nickname: 'rae', keys: keysForRole('human', 'viewer') })).json() as { member: WireMember }
		const snapshot = (await listed()).members.find(item => item.id === rae.id)!
		expect(snapshot.keys).not.toContain('views.write')
		await cliMemberSet('rae', '--grant', 'views.write')
		// The stale page grants reviews.write, or only renames rae: views.write stays either way.
		const granted = await patch(rae.id, { grant: ['reviews.write'] })
		expect(granted.status).toBe(200)
		expect((await granted.json() as { member: WireMember }).member.keys).toEqual(expect.arrayContaining(['views.write', 'reviews.write']))
		const renamed = await patch(rae.id, { nickname: 'rae-2' })
		expect(renamed.status).toBe(200)
		expect((await renamed.json() as { member: WireMember }).member).toMatchObject({ nickname: 'rae-2', keys: expect.arrayContaining(['views.write', 'reviews.write']) })
		expect((await fetch(`${origin}/api/access/members/${rae.id}`, { method: 'DELETE', headers: headers() })).status).toBe(200)
	})
})

describe('Owner administration over the loopback cookie session', () => {
	it('adds members, reveals a token once, creates invites, lists and revokes sessions', async () => {
		const headers = { cookie: ownerCookie }
		const roster = await (await fetch(`${origin}/api/access/members`, { headers })).json() as { workspaceRoot: string; hint: string; members: { nickname: string; id: string; kind: string; keys: string[]; label: unknown }[] }
		expect(roster.workspaceRoot).toBe(root)
		// Each listed member carries its stored keys and a label computed now (Clause 01a11c09-a49b). An Agent
		// holding the Editor keys it can hold is labeled Editor (Scenario 01a11c09-d61f).
		const claude = roster.members.find(member => member.nickname === 'claude')!
		expect(claude.keys).toEqual(keysForRole('agent', 'editor'))
		expect(claude.label).toEqual({ preset: { id: 'editor', name: 'Editor' } })
		expect(roster.members.find(member => member.kind === 'human')!.label).toEqual({ preset: { id: 'owner', name: 'Owner' } })
		const added = await fetch(`${origin}/api/access/members`, json({ nickname: 'mei', keys: keysForRole('human', 'reviewer') }, headers))
		expect(added.status).toBe(201)
		const mei = (await added.json() as { member: { id: string } }).member
		expect((await fetch(`${origin}/api/access/members`, json({ nickname: 'bot', keys: keysForRole('human', 'owner'), kind: 'agent' }, headers))).status).toBe(400)
		const owner = roster.members.find(member => member.nickname !== 'claude')!
		const demote = await fetch(`${origin}/api/access/members/${owner.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ revoke: ['members.manage'] }) })
		expect(demote.status).toBe(409)
		expect(await demote.json()).toMatchObject({ code: 'access.last_manager' })

		const token = await (await fetch(`${origin}/api/access/tokens`, json({ memberId: mei.id, label: 'browser' }, headers))).json() as { credential: string; token: { id: string; hash?: string } }
		expect(token.credential).toMatch(/^uiux_t_/u)
		expect(token.token).not.toHaveProperty('hash')
		const listed = await (await fetch(`${origin}/api/access/tokens`, { headers })).text()
		expect(listed).not.toContain(token.credential)
		expect(listed).not.toContain('sha256:')

		const invite = await (await fetch(`${origin}/api/access/invites`, json({ memberId: mei.id }, headers))).json() as { url: string }
		expect(invite.url).toMatch(new RegExp(`^${origin}/login#uiux_i_`, 'u'))
		const meiLogin = await fetch(`${origin}/api/session/login`, json({ credential: invite.url.split('#')[1] }))
		expect(await meiLogin.json()).toMatchObject({ member: { nickname: 'mei', kind: 'human', keys: keysForRole('human', 'reviewer'), label: { preset: { id: 'reviewer', name: 'Reviewer' } } } })
		const meiCookie = meiLogin.headers.get('set-cookie')!.split(';', 1)[0]!
		expect((await fetch(`${origin}/api/access/members`, { headers: { cookie: meiCookie } })).status).toBe(403)
		const sessions = await (await fetch(`${origin}/api/access/sessions`, { headers })).json() as { sessions: { id: string; member: string; current: boolean }[] }
		const meiSession = sessions.sessions.find(item => item.member === 'mei')!
		expect(sessions.sessions.some(item => item.current)).toBe(true)
		expect((await fetch(`${origin}/api/access/sessions/${meiSession.id}`, { method: 'DELETE', headers })).status).toBe(200)
		expect((await fetch(`${origin}/api/session`, { headers: { cookie: meiCookie } })).status).toBe(401)

		expect((await fetch(`${origin}/api/access/tokens/${token.token.id}`, { method: 'DELETE', headers })).status).toBe(200)
		expect((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(token.credential) })).status).toBe(401)
		expect((await fetch(`${origin}/api/access/members/${mei.id}`, { method: 'DELETE', headers })).status).toBe(200)
	})

	it('applies a CLI revoke on the running server without a restart', async () => {
		// A token the CLI just created works on the very next request, despite the throttled reload.
		expect((await fetch(`${origin}/api/health`)).status).toBe(200)
		const fresh = await provisionToken(root, { nickname: 'fresh-agent', kind: 'agent', role: 'viewer' })
		expect((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(fresh) })).status).toBe(200)
		const store = (await AccessStore.open({ workspaceRoot: root }))!
		const id = agentToken.split('_')[3]!
		expect((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(agentToken) })).status).toBe(200)
		await store.update(file => revokeToken(file, id))
		await sleep(1100)
		expect((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(agentToken) })).status).toBe(401)
	})

	it('signs out and rate-limits repeated failures per address', async () => {
		const out = await fetch(`${origin}/api/session`, { method: 'DELETE', headers: { cookie: ownerCookie } })
		expect(out.status).toBe(200)
		expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
		expect((await fetch(`${origin}/api/session`, { headers: { cookie: ownerCookie } })).status).toBe(401)
		// A stale credential retried does not count twice; ten distinct failures do.
		for (let index = 0; index < 12; index += 1) await fetch(`${origin}/api/session/login`, json({ credential: generateCredential('token', 'qqqq').value }))
		const limited = await fetch(`${origin}/api/session/login`, json({ credential: generateCredential('token', 'qqqq').value }))
		expect(limited.status).toBe(429)
		expect(limited.headers.get('retry-after')).toBe('60')
		expect(await limited.json()).toMatchObject({ code: 'auth.rate_limited' })
	})
})

describe('system principals', () => {
	it('accepts the in-memory capture credential as a cookie on read routes only, never on /mcp, and is never rate-limited', async () => {
		const access = await getSelectedWorkspaceServerRuntime().access()
		const cookie = `${access.cookieName}=${access.captureCredential}`
		expect((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: { cookie } })).status).toBe(200)
		const write = await fetch(`${origin}/api/views`, json({ name: 'x', spec }, { cookie }))
		expect(write.status).toBe(403)
		const mcp = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...bearer(access.captureCredential) }, body: '{}' })
		expect(mcp.status).toBe(401)
		expect((await fetch(`${origin}/api/session`, { headers: { cookie } })).status).toBe(403)
	})
})

describe('roster changes reach live leases', () => {
	it('drops a removed member\'s leases on the next store reload', async () => {
		const token = await provisionToken(root, { nickname: 'bot', kind: 'agent', role: 'editor' })
		const store = (await AccessStore.open({ workspaceRoot: root }))!
		const bot = store.data.members.find(member => member.nickname === 'bot')!
		const runtime = getSelectedWorkspaceServerRuntime()
		// The server knows bot (as after the request that would take this lease), so the lease stands.
		await (await runtime.access()).refresh(true)
		runtime.leases.acquire([{ kind: 'flow', key: 'f' }], { memberId: bot.id, nickname: 'bot', kind: 'agent' })
		expect(runtime.leases.list().some(lease => lease.holder.nickname === 'bot')).toBe(true)
		await store.update(file => removeMember(file, 'bot'))
		await sleep(1100)
		// Any authenticated request reloads the roster first (this address is still rate-limited from above).
		expect([401, 429]).toContain((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(token) })).status)
		expect(runtime.leases.list().some(lease => lease.holder.nickname === 'bot')).toBe(false)
	})
})
