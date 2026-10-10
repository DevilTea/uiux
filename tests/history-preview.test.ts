import { createHash } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import blobRoute from '../server/api/history/blobs/[digest].get'
import versionResourceRoute from '../server/api/history/versions/[id]/resources/[kind]/[key].get'
import listVersionsRoute from '../server/api/history/versions.get'
import readVersionRoute from '../server/api/history/versions/[id].get'
import updateLocaleRoute from '../server/api/locales/[locale].put'
import createViewRoute from '../server/api/views.post'
import loginRoute from '../server/api/session/login.post'
import type { VersionListing } from '../src/application/services/history-service'
import type { VersionRecord } from '../src/domain/history/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import { createAccessGuardHandler } from '../src/server/access/http'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, provisionToken, sessionCookieFor } from './support/access'

/**
 * The version reads for Preview and the version blob route (issue #132, B9): Rule
 * 01a11a5e-1232-777c-a76d-26a6d5cbcfc0 (a historical View renders that version's manifest, View and
 * Locales), Rule 01a11a5e-10df-795e-8fbc-a99de09694a5 (a version's image bytes by digest, including
 * one kept only in the host history store), and Access Clauses 01a11485-fa00-72da-bc46-98302a3c106e
 * (`history.read`) and 01a11485-f978-767a-b977-33028aee7ae7 (a cookie is accepted, a system
 * credential never).
 */

const VIEW_ID = '33333333-3333-4333-8333-333333333333'

let root: string
let server: Server
let origin: string
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }
let ownerToken: string
let agentToken: string
let viewerToken: string
/** The Owner's autosave, closed by the Agent's later write: its Locale blob is in the host store only. */
let hostOnly: VersionRecord

const json = { 'content-type': 'application/json' }

async function get(path: string, headers: Record<string, string>): Promise<Response> {
	return await fetch(`${origin}${path}`, { headers })
}

async function writeLocale(token: string, messages: Record<string, string>): Promise<void> {
	const runtime = getSelectedWorkspaceServerRuntime()
	const expectedRevision = (await runtime.persistence.locales.readRevision('en-US'))!
	const response = await fetch(`${origin}/api/locales/en-US`, { method: 'PUT', headers: { ...bearer(token), ...json }, body: JSON.stringify({ expectedRevision, messages }) })
	expect(response.status, await response.clone().text()).toBe(200)
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-preview-')))
	process.env.UIUX_WORKSPACE_ROOT = root
	const app = createApp()
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.post('/api/session/login', loginRoute)
	router.post('/api/views', createViewRoute)
	router.put('/api/locales/:locale', updateLocaleRoute)
	router.get('/api/history/versions', listVersionsRoute)
	router.get('/api/history/versions/:id', readVersionRoute)
	router.get('/api/history/versions/:id/resources/:kind/:key', versionResourceRoute)
	router.get('/api/history/blobs/:digest', blobRoute)
	app.use(router)
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin
	const runtime = getSelectedWorkspaceServerRuntime()
	await runtime.persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: { phone: { dimensions: { width: 390, height: 844 } } }, themes: {} })
	await runtime.persistence.locales.create('en-US', { greeting: 'Hello' })
	expect(await runtime.historyRecorder.start()).toMatchObject({ enabled: true, baseline: expect.any(String) })

	ownerToken = await provisionToken(root, { nickname: 'mei', kind: 'human', role: 'owner' })
	agentToken = await provisionToken(root, { nickname: 'claude', kind: 'agent', role: 'editor' })
	viewerToken = await provisionToken(root, { nickname: 'vera', kind: 'human', role: 'viewer' })

	const created = await fetch(`${origin}/api/views`, {
		method: 'POST',
		headers: { ...bearer(ownerToken), ...json },
		body: JSON.stringify({ id: VIEW_ID, name: 'Checkout', spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } }),
	})
	expect(created.status, await created.clone().text()).toBe(201)
	await writeLocale(ownerToken, { greeting: 'Hello from the first edit' })
	// Another actor's write closes the Owner's autosave (no Checkpoint copies its blobs to the artifact store).
	await writeLocale(agentToken, { greeting: 'Hello from the Agent' })
	const listing = await (await get('/api/history/versions?type=autosave', bearer(viewerToken))).json() as VersionListing
	const owners = listing.versions.find(version => version.actor.type === 'human')!
	hostOnly = (await (await get(`/api/history/versions/${owners.id}`, bearer(viewerToken))).json() as { version: VersionRecord }).version
})

afterAll(async () => {
	await new Promise<void>(resolve => server.close(() => resolve()))
	await closeSelectedWorkspaceServerRuntime()
	for (const [name, value] of [['UIUX_WORKSPACE_ROOT', previous.root], ['UIUX_SERVER_ORIGIN', previous.origin]] as const) {
		if (value === undefined) delete process.env[name]
		else process.env[name] = value
	}
	await rm(root, { recursive: true, force: true })
})

describe('GET /api/history/versions/:id/resources/:kind/:key', () => {
	it('answers the manifest, View and Locales as that version records them', async () => {
		const base = `/api/history/versions/${hostOnly.id}/resources`
		const locale = await get(`${base}/locale/en-US`, bearer(viewerToken))
		expect(locale.status).toBe(200)
		expect(locale.headers.get('cache-control')).toBe('no-store')
		expect(await locale.json()).toMatchObject({
			status: 'found',
			versionId: hostOnly.id,
			kind: 'locale',
			key: 'en-US',
			revision: hostOnly.resources.find(item => item.kind === 'locale')!.revision,
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			resource: { greeting: 'Hello from the first edit' },
		})
		expect(await (await get(`${base}/view/${VIEW_ID}`, bearer(viewerToken))).json()).toMatchObject({ status: 'found', resource: { id: VIEW_ID, name: 'Checkout' } })
		expect(await (await get(`${base}/workspace/workspace`, bearer(viewerToken))).json()).toMatchObject({ status: 'found', resource: { i18n: { defaultLocale: 'en-US' }, viewports: { phone: { dimensions: { width: 390 } } } } })
	})

	it('refuses what the version does not hold, kinds Preview does not read, and unknown versions', async () => {
		const base = `/api/history/versions/${hostOnly.id}/resources`
		const missing = await get(`${base}/locale/fr`, bearer(viewerToken))
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ status: 'not_found', code: 'history.resource_missing' })
		const flow = await get(`${base}/flow/${VIEW_ID}`, bearer(viewerToken))
		expect(flow.status).toBe(400)
		expect(await flow.json()).toMatchObject({ status: 'invalid', code: 'history.invalid_resource' })
		const unknown = await get(`/api/history/versions/44444444-4444-4444-8444-444444444444/resources/view/${VIEW_ID}`, bearer(viewerToken))
		expect(unknown.status).toBe(404)
		expect(await unknown.json()).toMatchObject({ code: 'history.record_missing' })
	})
})

describe('GET /api/history/blobs/:digest', () => {
	it('serves a blob kept only in the host history store (Rule 01a11a5e-10df-795e-8fbc-a99de09694a5)', async () => {
		const [path, digest] = Object.entries(hostOnly.resources.find(item => item.kind === 'locale')!.files)[0]!
		expect(path).toBe('i18n/en-US.json')
		// Not in the artifact store: only the host store keeps an autosave's blobs.
		expect(await getSelectedWorkspaceServerRuntime().persistence.artifacts.read(digest)).toBeUndefined()
		const response = await get(`/api/history/blobs/${encodeURIComponent(digest)}`, bearer(viewerToken))
		expect(response.status).toBe(200)
		expect(response.headers.get('content-type')).toBe('application/octet-stream')
		expect(response.headers.get('etag')).toBe(`"${digest}"`)
		const bytes = new Uint8Array(await response.arrayBuffer())
		expect(`sha256:${createHash('sha256').update(bytes).digest('hex')}`).toBe(digest)
		expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({ greeting: 'Hello from the first edit' })
	})

	it('serves a Checkpoint blob from the artifact store, and answers 404 for a digest no store keeps and 400 for a malformed one', async () => {
		const baseline = (await (await get('/api/history/versions?type=checkpoint', bearer(viewerToken))).json() as VersionListing).versions.at(-1)!
		const record = (await (await get(`/api/history/versions/${baseline.id}`, bearer(viewerToken))).json() as { version: VersionRecord }).version
		const digest = Object.values(record.resources.find(item => item.kind === 'locale')!.files)[0]!
		expect(await getSelectedWorkspaceServerRuntime().persistence.artifacts.read(digest)).toBeDefined()
		expect((await get(`/api/history/blobs/${encodeURIComponent(digest)}`, bearer(viewerToken))).status).toBe(200)

		const absent = `sha256:${'0'.repeat(64)}`
		const missing = await get(`/api/history/blobs/${encodeURIComponent(absent)}`, bearer(viewerToken))
		expect(missing.status).toBe(404)
		expect(missing.headers.get('cache-control')).toBe('no-store')
		expect(await missing.json()).toMatchObject({ status: 'not_found', code: 'history.blob_missing' })
		const malformed = await get('/api/history/blobs/not-a-digest', bearer(viewerToken))
		expect(malformed.status).toBe(400)
		expect(await malformed.json()).toMatchObject({ code: 'history.invalid_digest' })
	})
})

describe('access to the version reads for Preview (Clauses 01a11485-fa00 and f978)', () => {
	it('lets a Viewer read with a bearer Token or a Workbench cookie, and refuses no credential and the system credential', async () => {
		const digest = Object.values(hostOnly.resources.find(item => item.kind === 'locale')!.files)[0]!
		const paths = [`/api/history/versions/${hostOnly.id}/resources/view/${VIEW_ID}`, `/api/history/blobs/${encodeURIComponent(digest)}`]
		const cookie = await sessionCookieFor(origin, viewerToken)
		const access = await getSelectedWorkspaceServerRuntime().access()
		for (const path of paths) {
			expect((await get(path, bearer(viewerToken))).status, path).toBe(200)
			// The Preview document reads with the Workbench session cookie.
			expect((await get(path, { cookie: `${cookie.name}=${cookie.value}` })).status, path).toBe(200)
			expect((await get(path, {})).status, path).toBe(401)
			const system = await get(path, { cookie: `${access.cookieName}=${access.captureCredential}` })
			expect(system.status, path).toBe(403)
			expect(await system.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		}
	})
})
