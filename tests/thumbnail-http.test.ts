import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import eventsRoute from '../server/api/events.get'
import evidenceListRoute from '../server/api/evidence/list.get'
import thumbnailsRoute from '../server/api/thumbnails.get'
import requestThumbnailsRoute from '../server/api/thumbnails/request.post'
import loginRoute from '../server/api/session/login.post'
import thumbnailRoute from '../server/api/views/[id]/thumbnail.get'
import type { ThumbnailCapturer } from '../src/application/ports/thumbnails'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { thumbnailsDirectory } from '../src/server/thumbnail-store'
import { closeSelectedWorkspaceServerRuntime, configureSelectedWorkspaceRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The thumbnail operations end to end over the real routes, the request gates and the access guard,
 * with the real worker, digests and cache and a stand-in for the Chromium capture (Feature
 * 01a19b99-c9ee-7dcb-ae96-bbe31f12591c; Clauses 01a19bb9-8f1f-…, 01a19bb9-8e8a-… and 01a19b99-cf3c-…).
 */
const VIEW = '11111111-1111-4111-8111-111111111111'
const NOT_A_VIEW = '99999999-9999-4999-8999-999999999999'
const PNG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 1, 0xE0, 0, 0, 1, 0x2C, 8, 6, 0, 0, 0])
const spec = (intent: string) => ({ intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] })
const TIMING = { quietMs: 150, ceilingMs: 1000, failureIntervalMs: 400, pollMs: 25 }

let root: string
let server: Server
let origin: string
let ownerCookie: string
let readerToken: string
let noKeyToken: string
const capturesOf: string[] = []
let captureOutcome: { ok: true; png: Uint8Array } | { ok: false; reason: string } = { ok: true, png: PNG }
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

const capturer: ThumbnailCapturer = {
	capture: async ({ key }) => {
		capturesOf.push(key)
		return captureOutcome
	},
	close: async () => undefined,
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-thumbnail-http-')))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } }, themes: { light: { label: 'Light' } } })
	process.env.UIUX_WORKSPACE_ROOT = root
	configureSelectedWorkspaceRuntime({ thumbnailTiming: TIMING, thumbnailCapturer: capturer })
	const app = createApp()
	app.use(createLoopbackGuardHandler())
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.get('/api/events', eventsRoute)
	router.get('/api/evidence/list', evidenceListRoute)
	router.get('/api/thumbnails', thumbnailsRoute)
	router.post('/api/thumbnails/request', requestThumbnailsRoute)
	router.get('/api/views/:id/thumbnail', thumbnailRoute)
	router.post('/api/session/login', loginRoute)
	app.use(router)
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin
	const ownerToken = await provisionToken(root, { nickname: 'lead', kind: 'human', preset: 'owner' })
	const cookie = await sessionCookieFor(origin, ownerToken)
	ownerCookie = `${cookie.name}=${cookie.value}`
	readerToken = await provisionToken(root, { nickname: 'reader', kind: 'agent', keys: ['workspace.read'] })
	noKeyToken = await provisionToken(root, { nickname: 'nobody', kind: 'agent', keys: [] })

	const runtime = getSelectedWorkspaceServerRuntime()
	await runtime.persistence.locales.create('en-US', {})
	const created = await runtime.app.createView({ id: VIEW, name: 'Checkout', spec: spec('Pay') })
	if (created.status !== 'created') throw new Error('fixture')
	runtime.thumbnails.start()
})

afterAll(async () => {
	await closeSelectedWorkspaceServerRuntime()
	configureSelectedWorkspaceRuntime(undefined)
	server.closeAllConnections()
	await new Promise<void>(resolve => server.close(() => resolve()))
	for (const [name, value] of [['UIUX_WORKSPACE_ROOT', previous.root], ['UIUX_SERVER_ORIGIN', previous.origin]] as const) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await rm(root, { recursive: true, force: true })
})

const get = (path: string, headers: Record<string, string> = { cookie: ownerCookie }) => fetch(`${origin}${path}`, { headers })
const post = (path: string, body: unknown, headers: Record<string, string> = { cookie: ownerCookie }) => fetch(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })

async function until<T>(read: () => Promise<T | undefined> | T | undefined, what: string, timeoutMs = 5000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await read()
		if (value !== undefined && value !== false) return value as T
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
		await new Promise(resolve => setTimeout(resolve, 20))
	}
}

const stateOf = async (key = VIEW) => ((await (await get(`/api/thumbnails?keys=${key}`)).json()) as { items: Array<{ key: string; state: string; refreshing: boolean }> }).items[0]

describe('access (Clause 01a19bb9-8f1f-7482-b6fd-f131a284178e)', () => {
	it('needs a credential, and refuses a member without workspace.read on all three operations with no image', async () => {
		expect((await fetch(`${origin}/api/views/${VIEW}/thumbnail`)).status).toBe(401)
		for (const response of [
			await get(`/api/views/${VIEW}/thumbnail`, bearer(noKeyToken)),
			await get('/api/thumbnails', bearer(noKeyToken)),
			await post('/api/thumbnails/request', { keys: [VIEW] }, bearer(noKeyToken)),
		]) {
			expect(response.status).toBe(403)
			expect(response.headers.get('content-type')).not.toContain('image/')
			expect(await response.json()).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['workspace.read'] })
		}
		expect(capturesOf).toEqual([])
	})

	it('serves a member holding only workspace.read, on a bearer Token and on a cookie session', async () => {
		expect((await get('/api/thumbnails', bearer(readerToken))).status).toBe(200)
		expect((await get('/api/thumbnails', { cookie: ownerCookie })).status).toBe(200)
	})
})

describe('reading, listing and requesting', () => {
	it('reads nothing and captures nothing while a thumbnail is missing; the 404 carries no-store too', async () => {
		const response = await get(`/api/views/${VIEW}/thumbnail`)
		expect(response.status).toBe(404)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(await stateOf()).toEqual({ key: VIEW, state: 'missing', refreshing: false })
		await new Promise(resolve => setTimeout(resolve, 300))
		expect(capturesOf).toEqual([])
	})

	it('a request queues the missing thumbnail, the worker stores it, and the read returns the PNG with Cache-Control: no-store (Clause 01a19bb9-8e8a-7775-b19b-76e0b855095c)', async () => {
		const response = await post('/api/thumbnails/request', { keys: [VIEW, NOT_A_VIEW] })
		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(((await response.json()) as { items: unknown[] }).items).toEqual([{ key: VIEW, state: 'missing', refreshing: true }])
		await until(async () => (await stateOf())?.state === 'fresh' ? true : undefined, 'the thumbnail to be stored')
		expect(capturesOf).toEqual([VIEW])
		const read = await get(`/api/views/${VIEW}/thumbnail`)
		expect(read.status).toBe(200)
		expect(read.headers.get('content-type')).toBe('image/png')
		expect(read.headers.get('cache-control')).toBe('no-store')
		expect(new Uint8Array(await read.arrayBuffer())).toEqual(PNG)
		expect(await stateOf()).toEqual({ key: VIEW, state: 'fresh', refreshing: false })
	})

	it('is kept in the host-local cache and nowhere in the Workspace (Rules 01a19b99-d05d-… and 01a19b99-d0f0-…)', async () => {
		const cache = thumbnailsDirectory(process.env.UIUX_HOME!, root)
		expect(await readdir(join(cache, VIEW))).toHaveLength(1)
		const inWorkspace = (await readdir(root, { recursive: true })).filter(path => path.endsWith('.png'))
		expect(inWorkspace).toEqual([])
		// Not Evidence: the Evidence list, and with it readiness, holds no record of it.
		expect(((await (await get('/api/evidence/list')).json()) as { items: unknown[] }).items).toEqual([])
	})

	it('names a bad request with 400', async () => {
		expect((await post('/api/thumbnails/request', {})).status).toBe(400)
		expect((await post('/api/thumbnails/request', { keys: 'nope' })).status).toBe(400)
	})
})

describe('a write leads to a thumbnail after the quiet period (Rules 01a19b99-d2cb-… and 01a19b99-d383-…)', () => {
	it('captures the changed View once, announces thumbnail.changed with only the key, and a Spec-only edit captures nothing', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const seen: unknown[] = []
		const stop = runtime.events.subscribe(event => { if (event.type === 'thumbnail.changed') seen.push(event) })
		const before = capturesOf.length
		const read = (await runtime.persistence.views.read(VIEW))!

		// A Spec-only edit restarts the quiet period but leaves the thumbnail fresh: nothing is captured.
		const spec2 = await runtime.app.updateViewSpec({ key: VIEW, expectedRevision: read.revision, spec: spec('Pay now') })
		if (spec2.status !== 'updated') throw new Error(JSON.stringify(spec2))
		await new Promise(resolve => setTimeout(resolve, TIMING.quietMs * 3))
		expect(capturesOf.length).toBe(before)
		expect((await stateOf())?.state).toBe('fresh')

		// A structural edit makes it stale; after the quiet period the worker captures it once.
		const ir = { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'text-1', props: { value: 'Pay' }, bindings: {}, events: {} }] } }
		const structure = await runtime.app.updateViewStructure({ key: VIEW, expectedRevision: spec2.revision, ir: ir as never, variants: {} })
		if (structure.status !== 'updated') throw new Error(JSON.stringify(structure))
		expect((await stateOf())?.state).toBe('stale')
		await until(async () => (await stateOf())?.state === 'fresh' ? true : undefined, 'the changed View to be captured again')
		expect(capturesOf.length).toBe(before + 1)
		expect(seen.length).toBeGreaterThan(0)
		for (const event of seen) expect(event).toEqual({ type: 'thumbnail.changed', key: VIEW })
		stop()
	})

	it('deleting the cached file changes no Evidence, and the next request captures it again (Scenario 01a19b99-e418-7af5-936b-1c1285888dfe)', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const assessment = () => runtime.app.assessHandoffReadiness({ roots: [{ type: 'workspace' }] }).then(result => JSON.stringify(result))
		const evidenceBefore = JSON.stringify(await (await get('/api/evidence/list')).json())
		const assessmentBefore = await assessment()
		await rm(join(thumbnailsDirectory(process.env.UIUX_HOME!, root), VIEW), { recursive: true, force: true })
		expect((await stateOf())?.state).toBe('missing')
		expect(JSON.stringify(await (await get('/api/evidence/list')).json())).toBe(evidenceBefore)
		expect(await assessment()).toBe(assessmentBefore)
		const captured = capturesOf.length
		await post('/api/thumbnails/request', { keys: [VIEW] })
		await until(async () => (await stateOf())?.state === 'fresh' ? true : undefined, 'the thumbnail to be captured again')
		expect(capturesOf.length).toBe(captured + 1)
	})
})

describe('the event stream (Clause 01a19b99-cf3c-7a6b-8a2b-492c36c22cc7)', () => {
	it('sends thumbnail.changed with the field key and no other', async () => {
		const controller = new AbortController()
		const response = await fetch(`${origin}/api/events`, { headers: { cookie: ownerCookie, accept: 'text/event-stream' }, signal: controller.signal })
		const reader = response.body!.getReader()
		const decoder = new TextDecoder()
		let buffer = ''
		const frame = (async () => {
			for (;;) {
				const { value, done } = await reader.read()
				if (done) return undefined
				buffer += decoder.decode(value, { stream: true })
				const match = /event: thumbnail\.changed\ndata: (.*)\n\n/.exec(buffer)
				if (match) return JSON.parse(match[1]!) as unknown
			}
		})()
		await post('/api/thumbnails/request', { keys: [VIEW] }) // fresh already: no event
		getSelectedWorkspaceServerRuntime().events.publish({ type: 'thumbnail.changed', key: VIEW })
		expect(await frame).toEqual({ key: VIEW })
		controller.abort()
	})
})

describe('a failed capture (Rules 01a19b99-d6a9-… and 01a19b99-d760-…; Scenario 01a19b99-e250-79a9-b870-e9a9e79369f9)', () => {
	it('keeps the stored thumbnail, now stale, with no error, and a request within the failure interval queues nothing', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const read = (await runtime.persistence.views.read(VIEW))!
		captureOutcome = { ok: false, reason: 'the capture browser cannot be launched' }
		const stored = await (await get(`/api/views/${VIEW}/thumbnail`)).arrayBuffer()
		const ir = { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'text-9', props: { value: 'x' }, bindings: {}, events: {} }] } }
		const updated = await runtime.app.updateViewStructure({ key: VIEW, expectedRevision: read.revision, ir: ir as never, variants: {} })
		if (updated.status !== 'updated') throw new Error(JSON.stringify(updated))
		const before = capturesOf.length
		await until(() => capturesOf.length > before ? true : undefined, 'the failing capture')
		await until(async () => (await stateOf())?.refreshing === false ? true : undefined, 'the View to stop refreshing')
		expect(await stateOf()).toEqual({ key: VIEW, state: 'stale', refreshing: false })
		expect(new Uint8Array(await (await get(`/api/views/${VIEW}/thumbnail`)).arrayBuffer())).toEqual(new Uint8Array(stored))
		const afterFailure = capturesOf.length
		const requested = (await (await post('/api/thumbnails/request', { keys: [VIEW] })).json()) as { items: Array<{ refreshing: boolean }> }
		expect(requested.items[0]!.refreshing).toBe(false)
		await new Promise(resolve => setTimeout(resolve, 150))
		expect(capturesOf.length).toBe(afterFailure)
		// After the interval a request tries again.
		captureOutcome = { ok: true, png: PNG }
		await new Promise(resolve => setTimeout(resolve, TIMING.failureIntervalMs))
		await post('/api/thumbnails/request', { keys: [VIEW] })
		await until(async () => (await stateOf())?.state === 'fresh' ? true : undefined, 'the retry to be stored')
	})
})
