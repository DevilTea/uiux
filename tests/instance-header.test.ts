import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { createApp, defineEventHandler, setResponseStatus, toNodeListener } from 'h3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createServerInstanceHeaderHandler, SERVER_INSTANCE_HEADER } from '../src/server/instance-header'

/** The server instance header (Clause 01a175ec-c8cb-7cf3-bc94-1168ed11e3a9): on every `/api/*` response, errors included, and nowhere else. */
let server: Server
let base = ''

beforeAll(async () => {
	const app = createApp()
	app.use(createServerInstanceHeaderHandler(() => 'instance-1'))
	app.use('/api/refused', defineEventHandler((event) => { setResponseStatus(event, 401); return { code: 'auth.required' } }))
	app.use(defineEventHandler(() => 'ok'))
	server = createServer(toNodeListener(app))
	await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
	await new Promise(resolve => server.close(resolve))
})

describe('server instance header', () => {
	it('names the server instance on API responses, a refusal included', async () => {
		for (const path of ['/api/health', '/api/refused', '/api/resources/list?x=1', '//api//views']) {
			const response = await fetch(`${base}${path}`)
			expect(response.headers.get(SERVER_INSTANCE_HEADER), path).toBe('instance-1')
		}
		expect((await fetch(`${base}/api/refused`)).status).toBe(401)
	})

	it('leaves other responses without it', async () => {
		for (const path of ['/', '/mcp', '/apiary', '/_nuxt/x.js']) {
			expect((await fetch(`${base}${path}`)).headers.has(SERVER_INSTANCE_HEADER), path).toBe(false)
		}
	})
})
