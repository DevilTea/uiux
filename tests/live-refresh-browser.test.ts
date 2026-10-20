import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bearer, provisionToken } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Live refresh in the Workbench (Feature 01a111e4-0315-7755-b867-e3c7b50d22e6): an Agent's MCP
 * writes reach an open page through `GET /api/events` and are re-read and shown without a reload
 * (Rule 01a11485-f414-7882-b94f-cd4236c26d89), and its lease shows up from `lock.changed`.
 */
const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser
let agent: Client

const poll = <T>(read: () => T | Promise<T>, timeout = 10_000) => expect.poll(read, { timeout })

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const result = await agent.callTool({ name, arguments: args })
	if (result.isError) throw new Error(`${name}: ${JSON.stringify(result.structuredContent ?? result.content)}`)
	return result.structuredContent as T
}

async function readRevision(kind: string, key: string): Promise<string> {
	const response = await fetch(`${server.origin}/api/resources/${kind}/${key}`, { headers: server.headers })
	return (await response.json() as { revision: string }).revision
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	const token = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', preset: 'editor' })
	agent = new Client({ name: 'uiux-live-refresh-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), { requestInit: { headers: bearer(token) } }))
}, 60_000)

afterAll(async () => {
	await agent?.close()
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page; streams: () => number }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	let opened = 0
	page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/events') opened += 1 })
	await page.goto(`${server.origin}${path}`, { waitUntil: 'domcontentloaded' })
	// The page is never reloaded: this marker would be gone after a reload.
	await page.evaluate(() => { (window as unknown as { liveMarker: number }).liveMarker = 1 })
	return { context, page, streams: () => opened }
}

const marker = (page: Page) => page.evaluate(() => (window as unknown as { liveMarker?: number }).liveMarker)

describe('Live refresh in the Workbench (Rules 01a11485-f414-7882-b94f-cd4236c26d89, 01a114ec-e706-7c39-84a6-2e4a536daed2)', () => {
	it('shows an Agent\'s MCP rename and its lease on an open View page without a reload, over one stream', async () => {
		const { context, page, streams } = await open(`/views/${VIEW_ID}`)
		try {
			const header = page.locator('[data-view-header]')
			await header.locator('[data-view-name]').first().waitFor({ timeout: 20_000 })
			await poll(streams).toBe(1)
			// Let the stream's hello arrive before the write.
			await page.waitForTimeout(500)

			await call('update_view_metadata', { viewId: VIEW_ID, expectedRevision: await readRevision('view', VIEW_ID), name: 'Renamed by the Agent' })
			await poll(() => header.locator('[data-view-name]').first().textContent()).toContain('Renamed by the Agent')
			// The Agent's write took the View's edit lease: the badge follows `lock.changed`.
			await poll(() => page.getByText(/Locked by claude/u).count()).toBeGreaterThan(0)
			await call('release_lock', {})
			await poll(() => page.getByText(/Locked by claude/u).count()).toBe(0)

			expect(await marker(page)).toBe(1)
			expect(streams()).toBe(1)
		}
		finally { await context.close() }
	})

	it('lists a Review thread an Agent opens through MCP in the open Reviews inbox, and highlights its reply', async () => {
		const { context, page } = await open('/reviews')
		try {
			await page.locator('[data-review-inbox]').waitFor({ timeout: 20_000 })
			await page.waitForTimeout(500)
			const created = await call<{ key: string; revision: string }>('create_review_thread', { anchor: { scope: 'workspace' } })
			await call('append_review_message', { reviewId: created.key, expectedRevision: created.revision, body: 'Pushed live from the Agent' })
			const row = page.locator('[data-review-row]').filter({ hasText: 'Pushed live from the Agent' })
			await poll(() => row.count()).toBe(1)

			// With the thread open, a new reply appears on its own and is highlighted briefly.
			await row.first().click()
			await page.locator('[data-review-timeline]').getByText('Pushed live from the Agent').waitFor()
			await call('append_review_message', { reviewId: created.key, expectedRevision: await readRevision('review', created.key), body: 'A second live reply' })
			const reply = page.locator('[data-review-timeline] li').filter({ hasText: 'A second live reply' })
			await poll(() => reply.count()).toBe(1)
			expect(await reply.first().getAttribute('data-timeline-new')).toBe('true')
			await poll(() => reply.first().getAttribute('data-timeline-new'), 6000).toBeNull()
			expect(await marker(page)).toBe(1)
		}
		finally { await context.close() }
	})
})
