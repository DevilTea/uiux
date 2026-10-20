import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import mcpRoute from '../server/routes/mcp'
import eventsRoute from '../server/api/events.get'
import createViewRoute from '../server/api/views.post'
import updateViewSpecRoute from '../server/api/views/[id]/spec.put'
import createReviewRoute from '../server/api/reviews.post'
import appendReviewMessageRoute from '../server/api/reviews/[id]/messages.post'
import retractReviewRoute from '../server/api/reviews/[id].delete'
import sessionDeleteRoute from '../server/api/session.delete'
import loginRoute from '../server/api/session/login.post'
import lockDeleteRoute from '../server/api/locks/[kind]/[key].delete'
import memberPatchRoute from '../server/api/access/members/[id].patch'
import accessPresetsGetRoute from '../server/api/access-presets/index.get'
import accessPresetsPutRoute from '../server/api/access-presets/index.put'
import { createAccessGuardHandler } from '../src/server/access/http'
import { parseCredential } from '../src/server/access/credentials'
import { removeMember, revokeToken } from '../src/server/access/roster'
import { AccessStore } from '../src/server/access/store'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The change-event stream end to end over the real routes, the request gates and the access guard
 * (Feature "Live refresh" 01a111e4-0315-7755-b867-e3c7b50d22e6, Clause 01a114ec-e839-7b11-957c-41c88b692e12).
 */
const VIEW_ID = '22222222-2222-4222-8222-222222222222'
const MCP_VIEW_ID = '33333333-3333-4333-8333-333333333333'
const spec = { intent: 'x', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
const SECRET_INTENT = 'a-secret-intent-that-must-not-leak'
const SECRET_BODY = 'a-secret-review-body-that-must-not-leak'

let root: string
let server: Server
let origin: string
let ownerToken: string
let ownerCookie: string
let agentToken: string
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-live-events-')))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	process.env.UIUX_WORKSPACE_ROOT = root
	const app = createApp()
	app.use(createLoopbackGuardHandler())
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.use('/mcp', mcpRoute)
	router.get('/api/events', eventsRoute)
	router.post('/api/views', createViewRoute)
	router.put('/api/views/:id/spec', updateViewSpecRoute)
	router.post('/api/reviews', createReviewRoute)
	router.post('/api/reviews/:id/messages', appendReviewMessageRoute)
	router.delete('/api/reviews/:id', retractReviewRoute)
	router.delete('/api/session', sessionDeleteRoute)
	router.post('/api/session/login', loginRoute)
	router.delete('/api/locks/:kind/:key', lockDeleteRoute)
	router.patch('/api/access/members/:id', memberPatchRoute)
	router.get('/api/access-presets', accessPresetsGetRoute)
	router.put('/api/access-presets', accessPresetsPutRoute)
	app.use(router)
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin
	ownerToken = await provisionToken(root, { nickname: 'lead', kind: 'human', preset: 'owner' })
	agentToken = await provisionToken(root, { nickname: 'claude', kind: 'agent', preset: 'editor' })
	const cookie = await sessionCookieFor(origin, ownerToken)
	ownerCookie = `${cookie.name}=${cookie.value}`
})

afterAll(async () => {
	await closeSelectedWorkspaceServerRuntime()
	server.closeAllConnections()
	await new Promise<void>(resolve => server.close(() => resolve()))
	for (const [name, value] of [['UIUX_WORKSPACE_ROOT', previous.root], ['UIUX_SERVER_ORIGIN', previous.origin]] as const) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await rm(root, { recursive: true, force: true })
})

type Frame = Readonly<{ event?: string; data?: unknown; comment?: string; retry?: number; id?: string; raw: string }>

/** A minimal server-sent events reader over `fetch`, keeping every frame it parsed. */
async function openStream(headers: Record<string, string>) {
	const controller = new AbortController()
	const response = await fetch(`${origin}/api/events`, { headers: { accept: 'text/event-stream', ...headers }, signal: controller.signal })
	const frames: Frame[] = []
	let ended = false
	const waiters = new Set<() => void>()
	const notify = () => { for (const waiter of [...waiters]) waiter() }
	if (response.status === 200) {
		const reader = response.body!.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		void (async () => {
			try {
				for (;;) {
					const { value, done } = await reader.read()
					if (done) break
					buffer += decoder.decode(value, { stream: true })
					let index: number
					while ((index = buffer.indexOf('\n\n')) >= 0) {
						const raw = buffer.slice(0, index)
						buffer = buffer.slice(index + 2)
						frames.push(parseFrame(raw))
					}
					notify()
				}
			}
			catch { /* aborted */ }
			ended = true
			notify()
		})()
	}
	return {
		response,
		frames,
		get ended() { return ended },
		async next(predicate: (frame: Frame) => boolean, timeoutMs = 5000): Promise<Frame> {
			const deadline = Date.now() + timeoutMs
			for (;;) {
				const found = frames.find(predicate)
				if (found) return found
				if (ended) throw new Error(`stream ended without a matching frame: ${JSON.stringify(frames)}`)
				if (Date.now() > deadline) throw new Error(`no matching frame within ${timeoutMs} ms: ${JSON.stringify(frames)}`)
				await new Promise<void>((resolve) => {
					const timer = setTimeout(done, 100)
					function done() { clearTimeout(timer); waiters.delete(done); resolve() }
					waiters.add(done)
				})
			}
		},
		async waitEnded(timeoutMs = 5000): Promise<void> {
			const deadline = Date.now() + timeoutMs
			while (!ended) {
				if (Date.now() > deadline) throw new Error('the stream did not end')
				await new Promise(resolve => setTimeout(resolve, 25))
			}
		},
		close() { controller.abort() },
	}
}

function parseFrame(raw: string): Frame {
	let event: string | undefined
	let data: unknown
	let comment: string | undefined
	let retry: number | undefined
	let id: string | undefined
	for (const line of raw.split('\n')) {
		if (line.startsWith(':')) comment = line.slice(1).trim()
		else if (line.startsWith('event: ')) event = line.slice(7)
		else if (line.startsWith('data: ')) data = JSON.parse(line.slice(6))
		else if (line.startsWith('retry: ')) retry = Number(line.slice(7))
		else if (line.startsWith('id:')) id = line.slice(3)
	}
	return { raw, ...(event ? { event } : {}), ...(data !== undefined ? { data } : {}), ...(comment !== undefined ? { comment } : {}), ...(retry !== undefined ? { retry } : {}), ...(id !== undefined ? { id } : {}) }
}

const json = (method: string, body: unknown, headers: Record<string, string>) => ({ method, headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const isEvent = (name: string, data?: Record<string, unknown>) => (frame: Frame) => frame.event === name && (!data || Object.entries(data).every(([key, value]) => (frame.data as Record<string, unknown> | undefined)?.[key] === value))

describe('GET /api/events (Rule 01a11485-f34a-7c7e-a69c-fba14914d62d)', () => {
	it('needs a credential: no credential gets 401, like every /api/* route', async () => {
		const response = await fetch(`${origin}/api/events`, { headers: { accept: 'text/event-stream' } })
		expect(response.status).toBe(401)
		expect(await response.json()).toMatchObject({ code: 'auth.required' })
	})

	it('refuses a member without workspace.read with 403 naming the key', async () => {
		const noRead = await provisionToken(root, { nickname: 'no-read', kind: 'human', keys: [] })
		const response = await fetch(`${origin}/api/events`, { headers: bearer(noRead) })
		expect(response.status).toBe(403)
		expect(await response.json()).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['workspace.read'] })
	})

	it('opens text/event-stream for a cookie session and a bearer Token, sends hello with the server instance ID, and no event id', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		for (const headers of [{ cookie: ownerCookie }, bearer(agentToken)]) {
			const stream = await openStream(headers)
			try {
				expect(stream.response.status).toBe(200)
				expect(stream.response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
				expect(stream.response.headers.get('cache-control')).toBe('no-store')
				const hello = await stream.next(isEvent('hello'))
				expect(hello.data).toEqual({ serverInstanceId: runtime.events.serverInstanceId })
				expect(stream.frames[0]!.retry).toBeGreaterThan(0)
				expect(stream.frames.some(frame => frame.id !== undefined)).toBe(false)
			}
			finally { stream.close() }
		}
	})

	it('ignores Last-Event-ID: a reconnect gets a fresh hello and nothing replayed', async () => {
		const stream = await openStream({ cookie: ownerCookie, 'last-event-id': '42' })
		try {
			await stream.next(isEvent('hello'))
			await new Promise(resolve => setTimeout(resolve, 150))
			expect(stream.frames.map(frame => frame.event ?? (frame.retry !== undefined ? 'retry' : frame.raw))).toEqual(['retry', 'hello'])
		}
		finally { stream.close() }
	})
})

describe('change events after commits (Rules 01a11485-f365-70ce-82d9-43ea3f5ea5bb, 01a11485-f3bb-760b-9132-0e8c2f6bbf43, 01a11485-f382-7307-b0c1-a1947715cf03)', () => {
	it('sends resource.changed with the new revision for an HTTP write, and no canonical content', async () => {
		const stream = await openStream({ cookie: ownerCookie })
		try {
			await stream.next(isEvent('hello'))
			const created = await fetch(`${origin}/api/views`, json('POST', { id: VIEW_ID, name: 'Live', spec: { ...spec, intent: SECRET_INTENT } }, { cookie: ownerCookie }))
			expect(created.status).toBe(201)
			const result = await created.json() as { revision: string }
			const event = await stream.next(isEvent('resource.changed', { kind: 'view', key: VIEW_ID }))
			expect(event.data).toEqual({ kind: 'view', key: VIEW_ID, revision: result.revision })

			const updated = await fetch(`${origin}/api/views/${VIEW_ID}/spec`, json('PUT', { expectedRevision: result.revision, spec: { ...spec, intent: `${SECRET_INTENT}-2` } }, { cookie: ownerCookie }))
			expect(updated.status).toBe(200)
			const next = await updated.json() as { revision: string }
			await stream.next(isEvent('resource.changed', { kind: 'view', key: VIEW_ID, revision: next.revision }))

			// A refused write (a stale expectedRevision) commits nothing and emits nothing.
			const stale = await fetch(`${origin}/api/views/${VIEW_ID}/spec`, json('PUT', { expectedRevision: result.revision, spec }, { cookie: ownerCookie }))
			expect(stale.status).toBe(409)
			await new Promise(resolve => setTimeout(resolve, 150))
			expect(stream.frames.filter(frame => frame.event === 'resource.changed')).toHaveLength(2)
			expect(stream.frames.map(frame => frame.raw).join('\n')).not.toContain(SECRET_INTENT)
		}
		finally { stream.close() }
	})

	it('sends resource.changed for an MCP write to every open stream, and lock.changed for its lease', async () => {
		const human = await openStream({ cookie: ownerCookie })
		const agent = await openStream(bearer(agentToken))
		const client = new Client({ name: 'uiux-live-events-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
		try {
			await human.next(isEvent('hello'))
			await agent.next(isEvent('hello'))
			await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: bearer(agentToken) } }))
			const created = await client.callTool({ name: 'create_view', arguments: { id: MCP_VIEW_ID, name: 'From MCP', spec: { ...spec, intent: SECRET_INTENT } } })
			expect(created.isError).not.toBe(true)
			const revision = (created.structuredContent as { revision: string }).revision
			for (const stream of [human, agent]) {
				expect((await stream.next(isEvent('resource.changed', { kind: 'view', key: MCP_VIEW_ID }))).data).toEqual({ kind: 'view', key: MCP_VIEW_ID, revision })
				// The Agent's first write took a lease on the View (Rule 01a114ec-e706-7c39-84a6-2e4a536daed2).
				expect((await stream.next(isEvent('lock.changed', { kind: 'view', key: MCP_VIEW_ID }))).data).toEqual({ kind: 'view', key: MCP_VIEW_ID })
			}
			const before = human.frames.filter(isEvent('lock.changed')).length
			const released = await client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.isError).not.toBe(true)
			await human.next(frame => frame.event === 'lock.changed' && human.frames.filter(isEvent('lock.changed')).length > before)
			// No frame names who acted or what was written.
			const wire = human.frames.map(frame => frame.raw).join('\n')
			expect(wire).not.toContain(SECRET_INTENT)
			expect(wire).not.toContain('claude')
		}
		finally {
			await client.close()
			human.close()
			agent.close()
		}
	})

	it('sends Review events without the message body: a new thread, a reply, and resource.removed for a retract', async () => {
		const stream = await openStream({ cookie: ownerCookie })
		try {
			await stream.next(isEvent('hello'))
			const created = await fetch(`${origin}/api/reviews`, json('POST', { anchor: { viewId: VIEW_ID, widgetId: 'root' } }, bearer(agentToken)))
			expect(created.status).toBe(201)
			const thread = await created.json() as { key: string; revision: string }
			await stream.next(isEvent('resource.changed', { kind: 'review', key: thread.key, revision: thread.revision }))
			const replied = await fetch(`${origin}/api/reviews/${thread.key}/messages`, json('POST', { expectedRevision: thread.revision, body: SECRET_BODY }, bearer(agentToken)))
			expect(replied.status).toBe(200)
			const reply = await replied.json() as { revision: string }
			await stream.next(isEvent('resource.changed', { kind: 'review', key: thread.key, revision: reply.revision }))

			const unanswered = await (await fetch(`${origin}/api/reviews`, json('POST', { anchor: { scope: 'workspace' } }, bearer(agentToken)))).json() as { key: string; revision: string }
			const retracted = await fetch(`${origin}/api/reviews/${unanswered.key}`, json('DELETE', { expectedRevision: unanswered.revision }, bearer(agentToken)))
			expect(retracted.status).toBe(200)
			expect((await stream.next(isEvent('resource.removed', { kind: 'review', key: unanswered.key }))).data).toEqual({ kind: 'review', key: unanswered.key })
			expect(stream.frames.map(frame => frame.raw).join('\n')).not.toContain(SECRET_BODY)
		}
		finally { stream.close() }
	})

	it('sends resource.changed for the Access presets (Clause 01a114ec-e839-7b11-957c-41c88b692e12)', async () => {
		const stream = await openStream({ cookie: ownerCookie })
		try {
			await stream.next(isEvent('hello'))
			const read = await (await fetch(`${origin}/api/access-presets`, { headers: { cookie: ownerCookie } })).json() as { revision: string; resource: { presets: unknown[] } }
			const written = await fetch(`${origin}/api/access-presets`, json('PUT', { expectedRevision: read.revision, presets: read.resource.presets.slice(0, 2) }, { cookie: ownerCookie }))
			expect(written.status).toBe(200)
			const result = await written.json() as { revision: string }
			expect((await stream.next(isEvent('resource.changed', { kind: 'access-presets' }))).data).toEqual({ kind: 'access-presets', key: 'access-presets', revision: result.revision })
		}
		finally { stream.close() }
	})

	it('sends lock.changed when the Owner force-releases a lease', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const claude = (await AccessStore.open({ workspaceRoot: root }))!.data.members.find(member => member.nickname === 'claude')!
		runtime.leases.acquire([{ kind: 'view', key: VIEW_ID }], { memberId: claude.id, nickname: 'claude', kind: 'agent' })
		const stream = await openStream({ cookie: ownerCookie })
		try {
			await stream.next(isEvent('hello'))
			expect((await fetch(`${origin}/api/locks/view/${VIEW_ID}`, { method: 'DELETE', headers: { cookie: ownerCookie } })).status).toBe(200)
			await stream.next(isEvent('lock.changed', { kind: 'view', key: VIEW_ID }))
		}
		finally { stream.close() }
	})
})

describe('access changes and stream lifetime (Rules 01a114ec-e706-7c39-84a6-2e4a536daed2, 01a11485-f3f6-72df-b43a-91905eb4970c)', () => {
	it('sends access.changed {} when a member\'s keys change, and closes the stream of a member who lost workspace.read', async () => {
		const reader = await provisionToken(root, { nickname: 'reader', kind: 'human', keys: ['workspace.read'] })
		const owner = await openStream({ cookie: ownerCookie })
		const readerStream = await openStream(bearer(reader))
		try {
			await owner.next(isEvent('hello'))
			await readerStream.next(isEvent('hello'))
			const member = (await AccessStore.open({ workspaceRoot: root }))!.data.members.find(item => item.nickname === 'reader')!
			const patched = await fetch(`${origin}/api/access/members/${member.id}`, json('PATCH', { revoke: ['workspace.read'] }, { cookie: ownerCookie }))
			expect(patched.status).toBe(200)
			const event = await owner.next(isEvent('access.changed'))
			expect(event.data).toEqual({})
			await readerStream.waitEnded()
			expect(owner.ended).toBe(false)
		}
		finally {
			owner.close()
			readerStream.close()
		}
	})

	it('closes a session\'s stream when the session ends, and a Token\'s when it is revoked or its member removed', async () => {
		const token = await provisionToken(root, { nickname: 'leaving', kind: 'human', preset: 'reviewer' })
		const cookie = await sessionCookieFor(origin, token)
		const sessionStream = await openStream({ cookie: `${cookie.name}=${cookie.value}` })
		const tokenStream = await openStream(bearer(token))
		const second = await provisionToken(root, { nickname: 'leaving' })
		const secondStream = await openStream(bearer(second))
		try {
			await sessionStream.next(isEvent('hello'))
			await tokenStream.next(isEvent('hello'))
			await secondStream.next(isEvent('hello'))
			expect((await fetch(`${origin}/api/session`, { method: 'DELETE', headers: { cookie: `${cookie.name}=${cookie.value}` } })).status).toBe(200)
			await sessionStream.waitEnded()
			expect(tokenStream.ended).toBe(false)

			// A revoke made outside this server (the CLI writes the roster on disk) is found on the next heartbeat or access check.
			const store = (await AccessStore.open({ workspaceRoot: root }))!
			await store.update(file => revokeToken(file, parseCredential(token)!.id))
			const access = await getSelectedWorkspaceServerRuntime().access()
			await access.refresh(true)
			await tokenStream.waitEnded()
			expect(secondStream.ended).toBe(false)

			await store.update(file => removeMember(file, 'leaving'))
			await access.refresh(true)
			await secondStream.waitEnded()
		}
		finally {
			sessionStream.close()
			tokenStream.close()
			secondStream.close()
		}
	})

	it('caps the open streams per credential with 429, and frees a place when a stream closes', async () => {
		const token = await provisionToken(root, { nickname: 'many-tabs', kind: 'human', preset: 'viewer' })
		const open = []
		try {
			for (let index = 0; index < 4; index++) {
				const stream = await openStream(bearer(token))
				expect(stream.response.status).toBe(200)
				await stream.next(isEvent('hello'))
				open.push(stream)
			}
			const refused = await fetch(`${origin}/api/events`, { headers: bearer(token) })
			expect(refused.status).toBe(429)
			expect(await refused.json()).toMatchObject({ code: 'events.stream_limit' })
			// Another credential is not affected.
			const other = await openStream({ cookie: ownerCookie })
			expect(other.response.status).toBe(200)
			other.close()
			open.shift()!.close()
			// The server notices the closed connection shortly after.
			let again = await openStream(bearer(token))
			for (let attempt = 0; again.response.status !== 200 && attempt < 40; attempt++) {
				await new Promise(resolve => setTimeout(resolve, 50))
				again = await openStream(bearer(token))
			}
			expect(again.response.status).toBe(200)
			open.push(again)
		}
		finally {
			for (const stream of open) stream.close()
		}
	})
})
