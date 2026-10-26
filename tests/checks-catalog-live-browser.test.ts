import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { bearer, provisionToken } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Overview › Checks (issue #95, Rule 01a115cd-beb7-7024-9e44-0b5fe9ecf9af): the affected Views and
 * Widgets of a Catalog problem follow the Views as they are edited, without another Run Checks and
 * without asking for the Adapter set's report again. The report is answered by the test, so a
 * Catalog problem needs no broken Adapter on disk, and the test counts how often it was asked.
 */
const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const CATALOG_PROBLEM = { code: 'adapter.i18n_mapping_collision', path: '/adapters/0/manifest/catalog/widgets/Button/i18n/fields/label/text', message: 'Mapped runtime member text conflicts with another.' }

let server: WorkbenchServer
let browser: Browser
let agent: Client

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	const token = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', preset: 'editor' })
	agent = new Client({ name: 'uiux-checks-catalog-live-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), { requestInit: { headers: bearer(token) } }))
}, 60_000)

afterAll(async () => {
	await agent?.close()
	await browser?.close()
	await server?.close()
})

async function viewRevision(): Promise<string> {
	const response = await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })
	return (await response.json() as { revision: string }).revision
}

async function setButtons(count: number): Promise<void> {
	const content = Array.from({ length: count }, (_, index) => ({ type: 'Button', id: `live-button-${index + 1}` }))
	const result = await agent.callTool({
		name: 'update_view_structure',
		arguments: { viewId: VIEW_ID, expectedRevision: await viewRevision(), ir: { type: 'RootShell', id: 'root', slots: { content } }, variants: {} },
	})
	if (result.isError) throw new Error(JSON.stringify(result.structuredContent ?? result.content))
}

async function openChecks(): Promise<{ context: BrowserContext; page: Page; adapterReads: () => number }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	let adapterReads = 0
	await page.route(url => url.pathname === '/api/preview/adapters', (route) => {
		adapterReads += 1
		return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ state: 'invalid', diagnostics: [CATALOG_PROBLEM], summaries: [] }) })
	})
	await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'networkidle' })
	return { context, page, adapterReads: () => adapterReads }
}

describe('A Catalog problem follows the Views without a new run (Rule 01a115cd-beb7-7024-9e44-0b5fe9ecf9af)', () => {
	it('recounts the affected Widgets and drops the problem when no View uses its entry, without asking for the Adapter report again', async () => {
		await setButtons(3)
		const { context, page, adapterReads } = await openChecks()
		try {
			await page.locator('[data-run-checks]').click()
			await page.locator('[data-checks-tree]').waitFor({ timeout: 30_000 })
			const tree = page.locator('[data-checks-tree]')
			const count = (text: string) => tree.locator('[data-check-count]').filter({ hasText: text }).count()
			await expect.poll(() => count('3 Widgets'), { timeout: 30_000 }).toBe(1)
			expect(await page.locator('[data-check-problem="adapter.i18n_mapping_collision"]').count()).toBe(1)
			const reads = adapterReads()
			expect(reads).toBeGreaterThan(0)

			// An edit to the View, without Run Checks: the affected Widgets are counted again.
			await setButtons(2)
			await expect.poll(() => count('2 Widgets'), { timeout: 30_000 }).toBe(1)
			expect(await count('3 Widgets')).toBe(0)

			// No View uses the entry any more: the problem leaves the list and is counted aside.
			await setButtons(0)
			await expect.poll(() => page.locator('[data-check-problem="adapter.i18n_mapping_collision"]').count(), { timeout: 30_000 }).toBe(0)
			expect(await page.locator('[data-check-source="catalog"]').textContent()).toContain('1 Catalog problem is outside the entries Views use')

			// A View that uses the entry again brings it back.
			await setButtons(1)
			await expect.poll(() => page.locator('[data-check-problem="adapter.i18n_mapping_collision"]').count(), { timeout: 30_000 }).toBe(1)

			// The Catalog itself was never validated again.
			expect(adapterReads()).toBe(reads)
		}
		finally { await context.close() }
	}, 180_000)
})
