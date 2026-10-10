import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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
import { createInvite, removeMember, revokeToken } from '../src/server/access/roster'
import { AccessStore } from '../src/server/access/store'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { LOOPBACK_ONLY_NETWORK, resolveNetworkConfig, setServerNetwork, type NetworkConfig } from '../src/server/network-access'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import { provisionToken } from './support/access'

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
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), `${JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }, null, 2)}\n`)
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
		expect(await login.json()).toMatchObject({ member: { kind: 'human', role: 'owner' } })
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
		expect(await me.json()).toMatchObject({ member: { role: 'owner', kind: 'human' }, credential: 'session', workspaceRoot: root })
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
		const owner = store.data.members.find(member => member.kind === 'human' && member.role === 'owner')!
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
		const owner = store.data.members.find(member => member.kind === 'human' && member.role === 'owner')!
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
			expect(client.getInstructions()).toMatch(/^Authenticated as claude \(agent, editor\)\./u)
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
		const owner = members.find(member => member.kind === 'human' && member.role === 'owner')!
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

describe('Owner administration over the loopback cookie session', () => {
	it('adds members, reveals a token once, creates invites, lists and revokes sessions', async () => {
		const headers = { cookie: ownerCookie }
		const roster = await (await fetch(`${origin}/api/access/members`, { headers })).json() as { workspaceRoot: string; hint: string; members: { nickname: string; id: string }[] }
		expect(roster.workspaceRoot).toBe(root)
		const added = await fetch(`${origin}/api/access/members`, json({ nickname: 'mei', role: 'reviewer' }, headers))
		expect(added.status).toBe(201)
		const mei = (await added.json() as { member: { id: string } }).member
		expect((await fetch(`${origin}/api/access/members`, json({ nickname: 'bot', role: 'owner', kind: 'agent' }, headers))).status).toBe(400)
		const owner = roster.members.find(member => member.nickname !== 'claude')!
		const demote = await fetch(`${origin}/api/access/members/${owner.id}`, { method: 'PATCH', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ role: 'viewer' }) })
		expect(demote.status).toBe(409)
		expect(await demote.json()).toMatchObject({ code: 'auth.last_owner' })

		const token = await (await fetch(`${origin}/api/access/tokens`, json({ memberId: mei.id, label: 'browser' }, headers))).json() as { credential: string; token: { id: string; hash?: string } }
		expect(token.credential).toMatch(/^uiux_t_/u)
		expect(token.token).not.toHaveProperty('hash')
		const listed = await (await fetch(`${origin}/api/access/tokens`, { headers })).text()
		expect(listed).not.toContain(token.credential)
		expect(listed).not.toContain('sha256:')

		const invite = await (await fetch(`${origin}/api/access/invites`, json({ memberId: mei.id }, headers))).json() as { url: string }
		expect(invite.url).toMatch(new RegExp(`^${origin}/login#uiux_i_`, 'u'))
		const meiLogin = await fetch(`${origin}/api/session/login`, json({ credential: invite.url.split('#')[1] }))
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
		runtime.leases.acquire([{ kind: 'flow', key: 'f' }], { memberId: bot.id, nickname: 'bot', kind: 'agent' })
		expect(runtime.leases.list().some(lease => lease.holder.nickname === 'bot')).toBe(true)
		await store.update(file => removeMember(file, 'bot'))
		await sleep(1100)
		// Any authenticated request reloads the roster first (this address is still rate-limited from above).
		expect([401, 429]).toContain((await fetch(`${origin}/api/resources/workspace/workspace`, { headers: bearer(token) })).status)
		expect(runtime.leases.list().some(lease => lease.holder.nickname === 'bot')).toBe(false)
	})
})
