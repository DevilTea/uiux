import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import kitFilesRoute from '../server/api/product-kit/files.get'
import kitFileRoute from '../server/api/product-kit/file.get'
import componentSourceRoute from '../server/api/product-kit/components/source.post'
import componentCompareRoute from '../server/api/product-kit/components/compare.post'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { MAX_KIT_FILE_BYTES } from '../src/adapters/kit-source-files'
import { bearer, provisionToken } from './support/access'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The kit source Workbench mirrors through the real h3 routes behind the request gate and the access
 * guard (Rule 01a11bb1-a184-…, Clause 01a11bb1-b35a-… for `product-kit.source.read`, and the read
 * limits of Clause 01a13d3e-c4b5-…): no credential is 401, a credential without the key is 403 before
 * any request body is read, and a kit file above 8 MiB is refused with `kit.file_too_large`.
 */

const BUTTON = '<template><button /></template>\n'

let root: string
let server: Server
let origin: string
let readerToken: string
let sourceToken: string
const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

async function write(path: string, content: string | Uint8Array): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

beforeAll(async () => {
	root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-source-http-')))
	await writeCurrentWorkspace(root, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await write(join(root, 'kit', 'package.json'), '{ "name": "kit", "private": true }\n')
	await write(join(root, 'kit', 'src', 'ds', 'Button.vue'), BUTTON)
	await write(join(root, 'kit', 'src', 'big.bin'), new Uint8Array(MAX_KIT_FILE_BYTES + 1))
	process.env.UIUX_WORKSPACE_ROOT = root

	const app = createApp()
	app.use(createLoopbackGuardHandler())
	app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
	const router = createRouter()
	router.get('/api/product-kit/files', kitFilesRoute)
	router.get('/api/product-kit/file', kitFileRoute)
	router.post('/api/product-kit/components/source', componentSourceRoute)
	router.post('/api/product-kit/components/compare', componentCompareRoute)
	app.use(router)
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
	process.env.UIUX_SERVER_ORIGIN = origin

	readerToken = await provisionToken(root, { nickname: 'reader', kind: 'agent', keys: ['workspace.read'] })
	sourceToken = await provisionToken(root, { nickname: 'source', kind: 'agent', keys: ['workspace.read', 'product-kit.source.read'] })
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

const ROUTES = [
	['GET', '/api/product-kit/files'],
	['GET', '/api/product-kit/file?path=src%2Fds%2FButton.vue'],
	['POST', '/api/product-kit/components/source'],
	['POST', '/api/product-kit/components/compare'],
] as const

function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Response> {
	return fetch(`${origin}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers }, ...(body === undefined ? {} : { body }) })
}

/**
 * Sends a POST whose body never ends and resolves with the response status: the route answers
 * only if it decides without reading the body.
 */
function statusWithUnfinishedBody(path: string, token: string): Promise<number> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(`${origin}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked', ...bearer(token) } }, (response) => {
			response.resume()
			resolve(response.statusCode ?? 0)
			request.destroy()
		})
		request.on('error', (error: NodeJS.ErrnoException) => {
			if (error.code !== 'ECONNRESET') reject(error)
		})
		request.write('{"name": "but')
		setTimeout(() => {
			request.destroy()
			reject(new Error(`${path} did not answer before its body ended`))
		}, 5000).unref()
	})
}

describe('the kit source routes behind the access guard', () => {
	it('answer 401 without a credential', async () => {
		for (const [method, path] of ROUTES) {
			const response = await send(method, path, {}, method === 'POST' ? '{}' : undefined)
			expect(response.status, path).toBe(401)
		}
	})

	it('answer 403 to a credential without product-kit.source.read, before reading the body', async () => {
		for (const [method, path] of ROUTES) {
			// A malformed body: a route that read it would answer 400.
			const response = await send(method, path, bearer(readerToken), method === 'POST' ? '{ not json' : undefined)
			expect(response.status, path).toBe(403)
			expect(await response.json(), path).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['product-kit.source.read'] })
		}
		expect(await statusWithUnfinishedBody('/api/product-kit/components/source', readerToken)).toBe(403)
		expect(await statusWithUnfinishedBody('/api/product-kit/components/compare', readerToken)).toBe(403)
	})

	it('serve the kit files with the key, and refuse a file above 8 MiB with kit.file_too_large', async () => {
		const listed = await send('GET', '/api/product-kit/files', bearer(sourceToken))
		expect(listed.status).toBe(200)
		expect(await listed.json()).toMatchObject({ status: 'listed', truncated: false, files: [{ path: 'package.json' }, { path: 'src/big.bin', size: MAX_KIT_FILE_BYTES + 1 }, { path: 'src/ds/Button.vue' }] })
		const file = await send('GET', '/api/product-kit/file?path=src%2Fds%2FButton.vue', bearer(sourceToken))
		expect(file.status).toBe(200)
		expect(await file.json()).toMatchObject({ status: 'found', content: BUTTON })
		const big = await send('GET', '/api/product-kit/file?path=src%2Fbig.bin', bearer(sourceToken))
		expect(big.status).toBe(422)
		const body = await big.json() as Record<string, unknown>
		expect(body).toMatchObject({ status: 'too_large', code: 'kit.file_too_large', path: 'src/big.bin', limit: MAX_KIT_FILE_BYTES })
		expect(JSON.stringify(body)).not.toContain(root)
		const nul = await send('GET', '/api/product-kit/file?path=src%2Fds%2FButton.vue%00', bearer(sourceToken))
		expect(nul.status).toBe(400)
	})
})
