import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import evidenceListRoute from '../server/api/evidence/list.get'
import { kitFileDigestCache } from '../src/adapters/kit-provenance'
import { digestKitFile } from '../src/adapters/kit-source-files'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, provisionToken } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * `GET /api/evidence/list` through the real h3 route behind the request gate and the access guard:
 * it needs `workspace.read`, carries the current Product Kit provenance its freshness is judged
 * against (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…), or `productKitUnavailable`, without a host
 * path, and concurrent requests share one digest of the kit.
 */

let root: string
let server: Server
let origin: string
let readerToken: string
let keylessToken: string
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-evidence-list-http-')))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await write(join(root, 'kit', 'package.json'), '{ "name": "kit", "private": true }\n')
	for (let index = 0; index < 40; index++) await write(join(root, 'kit', 'src', `f${index}.ts`), `export const v = ${index}\n`)
	process.env.UIUX_WORKSPACE_ROOT = root

	const app = createApp()
	app.use(createLoopbackGuardHandler())
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.get('/api/evidence/list', evidenceListRoute)
	app.use(router)
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin

	readerToken = await provisionToken(root, { nickname: 'reader', kind: 'agent', keys: ['workspace.read'] })
	keylessToken = await provisionToken(root, { nickname: 'keyless', kind: 'agent', keys: [] })
})

afterEach(() => {
	kitFileDigestCache.hashFile = digestKitFile
	kitFileDigestCache.clear()
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

function list(headers: Record<string, string> = {}): Promise<Response> {
	return fetch(`${origin}/api/evidence/list`, { headers })
}

describe('GET /api/evidence/list', () => {
	it('answers 401 without a credential and 403 without workspace.read', async () => {
		expect((await list()).status).toBe(401)
		const denied = await list(bearer(keylessToken))
		expect(denied.status).toBe(403)
		expect(await denied.json()).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['workspace.read'] })
	})

	it('carries the current Product Kit provenance without a host path, digesting the kit once for concurrent requests', async () => {
		const hashed: string[] = []
		kitFileDigestCache.hashFile = (kit, path) => {
			hashed.push(path)
			return digestKitFile(kit, path)
		}
		const responses = await Promise.all(Array.from({ length: 10 }, () => list(bearer(readerToken))))
		const bodies = await Promise.all(responses.map(async (response) => {
			expect(response.status).toBe(200)
			return await response.text()
		}))
		for (const body of bodies) {
			expect(body).not.toContain(root)
			const parsed = JSON.parse(body) as Record<string, unknown>
			expect(parsed).toMatchObject({ items: [], productKit: { dataDigest: expect.stringMatching(/^sha256:/), sourceDigest: expect.stringMatching(/^sha256:/), outputDigest: expect.stringMatching(/^sha256:/), designSystems: [] } })
			expect(parsed.productKitUnavailable).toBeUndefined()
			// The current Adapter provenance too (Rule 01a115cd-c6de-…): this Workspace's active set is empty.
			expect(parsed.adapters).toEqual([])
			expect(parsed.adaptersUnavailable).toBeUndefined()
		}
		// Each kit file was read once (41 files), whatever the number of requests.
		expect(hashed.length).toBe(41)
		expect(new Set(hashed).size).toBe(41)

		// A later request answers from the cache without reading a kit file.
		hashed.length = 0
		expect((await list(bearer(readerToken))).status).toBe(200)
		expect(hashed).toEqual([])
	})

	it('says productKitUnavailable, with no provenance, when a kit file cannot be read', async () => {
		kitFileDigestCache.hashFile = async (kit, path) => path === 'src/f7.ts' ? { status: 'not_found' } : digestKitFile(kit, path)
		const response = await list(bearer(readerToken))
		expect(response.status).toBe(200)
		const body = await response.json() as Record<string, unknown>
		expect(body.productKitUnavailable).toBe(true)
		expect(body.productKit).toBeUndefined()
	})

	it('skips a View file that is not valid JSON and still answers the other Views and the list', async () => {
		const good = '44444444-4444-4444-8444-444444444441'
		const bad = '44444444-4444-4444-8444-444444444442'
		const goodView = { id: good, name: 'Checkout', ir: { type: 'RootShell', id: 'root', slots: { content: [] } }, variants: {}, spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] } }
		await write(join(root, 'views', `${good}.view.json`), `${JSON.stringify(goodView)}\n`)
		await write(join(root, 'views', `${bad}.view.json`), '{ not json')
		try {
			const response = await list(bearer(readerToken))
			expect(response.status).toBe(200)
			const body = await response.json() as { items: unknown[]; views: { key: string }[] }
			expect(body.items).toEqual([])
			expect(body.views.map(view => view.key)).toEqual([good])
		}
		finally {
			await rm(join(root, 'views'), { recursive: true, force: true })
		}
	})
})
