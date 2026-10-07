import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { provisionToken, sessionCookieFor } from './support/access'

/**
 * Overview and readiness (roadmap R9) against the built Workbench and a private copy of the
 * dogfood Workspace: the blocking versus advisory split of a View's Handoff assessment, role
 * gating of capture and export, and a capture failure rendered on its own row.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser

type Json = Record<string, unknown>

async function api(path: string, init: RequestInit & { cookie?: string } = {}): Promise<{ status: number; body: Json }> {
	const response = await fetch(`${server.origin}${path}`, {
		...init,
		headers: { 'content-type': 'application/json', cookie: init.cookie ?? server.headers.cookie!, ...(init.headers ?? {}) },
	})
	return { status: response.status, body: await response.json() as Json }
}

/** One open thread (blocking) and one resolved as won't fix (advisory), through the review API. */
async function authorReviews(): Promise<void> {
	const open = await api('/api/reviews', { method: 'POST', body: JSON.stringify({ anchor: { viewId: VIEW_ID, widgetId: 'root' } }) })
	expect(open.status, JSON.stringify(open.body)).toBeLessThan(300)
	const declined = await api('/api/reviews', { method: 'POST', body: JSON.stringify({ anchor: { viewId: VIEW_ID, widgetId: 'root' } }) })
	expect(declined.status, JSON.stringify(declined.body)).toBeLessThan(300)
	const resolved = await api(`/api/reviews/${String(declined.body.key)}/resolve`, {
		method: 'POST',
		body: JSON.stringify({ expectedRevision: declined.body.revision, resolution: 'wont-fix', reason: 'Out of scope for this release.' }),
	})
	expect(resolved.status, JSON.stringify(resolved.body)).toBeLessThan(300)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	await authorReviews()
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, options: Readonly<{ cookie?: { name: string; value: string }; width?: number; height?: number }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: options.width ?? 1920, height: options.height ?? 1080 } })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...(options.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

describe('Overview and readiness (R9)', () => {
	it('keeps Checks, Evidence and Handoff out of the top-level navigation', async () => {
		const { context, page } = await open('/')
		try {
			const nav = (await page.locator('[data-landmark="navigation"]').first().innerText()).toLowerCase()
			for (const word of ['checks', 'evidence', 'handoff']) expect(nav).not.toContain(word)
			const tabs = await page.locator('[role="tablist"] [role="tab"]').allInnerTexts()
			expect(tabs.map(text => text.trim().replace(/\s+\d+$/, ''))).toEqual(['Views', 'Checks', 'Activity'])
			await page.locator('[data-views-table] [data-readiness]').first().waitFor()
		}
		finally { await context.close() }
	}, 60_000)

	it('splits blocking from advisory: a declined Review never counts as a blocker', async () => {
		const assessed = await api('/api/handoff/assess', { method: 'POST', body: JSON.stringify({ roots: [{ type: 'view', viewId: VIEW_ID }] }) })
		const diagnostics = ((assessed.body.readiness as Json).blockingDiagnostics as { code: string; blocking: boolean }[])
		const blocking = diagnostics.filter(item => item.blocking !== false)
		const advisory = diagnostics.filter(item => item.blocking === false)
		expect(advisory.map(item => item.code)).toContain('handoff.review_declined')
		expect(blocking.map(item => item.code)).toContain('handoff.unresolved_review_thread')
		expect(blocking.map(item => item.code)).not.toContain('handoff.review_declined')

		const { context, page } = await open(`/views/${VIEW_ID}?panel=readiness`)
		try {
			const badge = page.locator('[data-readiness-badge="blocked"]')
			await badge.waitFor({ timeout: 30_000 })
			expect(Number(await badge.getAttribute('data-blocking-count'))).toBe(blocking.length)
			expect(await badge.innerText()).toContain(`Blocked by ${blocking.length}`)
			const handoff = page.locator('[data-facet="handoff"]')
			expect(await handoff.locator('[data-handoff-diagnostics="blocking"] [data-diagnostic-code="handoff.review_declined"]').count()).toBe(0)
			expect(await handoff.locator('[data-handoff-diagnostics="advisory"] [data-diagnostic-code="handoff.review_declined"]').count()).toBe(1)
			expect(await handoff.locator('[data-handoff-diagnostics="blocking"] li').count()).toBe(blocking.length)
			// Resolution counts come from coverage.review.resolved.
			expect(await page.locator('[data-facet="reviews"] [data-resolution="wont-fix"]').innerText()).toContain('1')

			// The export dialog shows the same split, and a non-ready snapshot is a diagnostic one, never green.
			await page.locator('[data-export-open]').click()
			const dialog = page.getByRole('dialog')
			await dialog.locator('[data-handoff-state]').waitFor({ timeout: 30_000 })
			expect(await dialog.locator('[data-handoff-state]').getAttribute('data-ready')).toBe('false')
			expect(await dialog.locator('[data-handoff-diagnostics="advisory"] [data-diagnostic-code="handoff.review_declined"]').count()).toBe(1)
			expect(await dialog.locator('[data-handoff-diagnostics="blocking"] [data-diagnostic-code="handoff.review_declined"]').count()).toBe(0)
			await dialog.locator('[data-handoff-export]').click()
			const claim = dialog.locator('[data-handoff-claim]')
			await claim.waitFor({ timeout: 30_000 })
			expect(await claim.getAttribute('data-handoff-claim')).toBe('diagnostic')
			expect(await claim.innerText()).toContain('Diagnostic snapshot')
			const color = await claim.evaluate(element => getComputedStyle(element).color)
			const success = await page.evaluate(() => {
				const probe = document.createElement('span')
				probe.style.color = 'var(--ui-success)'
				document.body.appendChild(probe)
				const value = getComputedStyle(probe).color
				probe.remove()
				return value
			})
			expect(color).not.toBe(success)
		}
		finally { await context.close() }
	}, 120_000)

	it('gates capture and export by role: a Viewer can read readiness but not capture or export', async () => {
		const token = await provisionToken(server.workspaceRoot, { nickname: 'r9viewer', kind: 'human', role: 'viewer' })
		const cookie = await sessionCookieFor(server.origin, token)
		const refused = await api('/api/evidence/capture', {
			method: 'POST',
			cookie: `${cookie.name}=${cookie.value}`,
			body: JSON.stringify({ contexts: [{ viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId: 'light' }] }),
		})
		expect(refused.status).toBe(403)

		const overview = await open('/', { cookie })
		try {
			await overview.page.locator('[data-views-table] [data-readiness]').first().waitFor()
			expect(await overview.page.locator('[data-export-open]').count()).toBe(0)
		}
		finally { await overview.context.close() }

		const { context, page } = await open(`/views/${VIEW_ID}?panel=readiness`, { cookie })
		try {
			await page.locator('[data-readiness-badge]').waitFor({ timeout: 30_000 })
			expect(await page.locator('[data-capture-open]').count()).toBe(0)
			expect(await page.locator('[data-capture-stale]').count()).toBe(0)
			expect(await page.locator('[data-export-open]').count()).toBe(0)
			expect(await page.locator('[data-access-notice="capture"]').innerText()).toContain('Editor')
			expect(await page.locator('[data-access-notice="export"]').innerText()).toContain('Editor')
		}
		finally { await context.close() }
	}, 90_000)

	it('renders a capture failure on its row with the server diagnostic, and captures only the listed contexts', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=readiness`)
		const requests: unknown[] = []
		try {
			await page.route('**/api/evidence/capture', async (route) => {
				requests.push(route.request().postDataJSON())
				await route.fulfill({
					status: 422,
					contentType: 'application/json',
					body: JSON.stringify({
						status: 'failed',
						results: [{ status: 'failed', error: 'Executable doesn\'t exist', diagnostics: [{ code: 'capture.browser_launch_failed', path: '/capture', message: 'Playwright browser could not be launched: Executable doesn\'t exist' }] }],
						summary: { total: 1, captured: 0, failed: 1 },
						executedAt: new Date().toISOString(),
					}),
				})
			})
			await page.locator('[data-capture-open]').click()
			const sheet = page.getByRole('dialog')
			await sheet.locator('[data-capture-row]').first().waitFor()
			// "All themes" expands the visible list first; nothing runs until Capture.
			await sheet.locator('[data-capture-expand="themes"]').click()
			const rows = await sheet.locator('[data-capture-row]').count()
			expect(rows).toBe(2)
			expect(requests).toHaveLength(0)
			await sheet.locator('[data-capture-run]').click()
			await sheet.locator('[data-capture-row="failed"]').nth(rows - 1).waitFor({ timeout: 30_000 })
			expect(requests).toHaveLength(rows)
			for (const body of requests) expect((body as { contexts: unknown[] }).contexts).toHaveLength(1)
			const error = sheet.locator('[data-capture-error]').first()
			expect(await error.innerText()).toContain('Playwright browser could not be launched')
			expect(await sheet.locator('[data-capture-row="captured"]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('Overview tabs in the URL', () => {
	const selectedTab = (page: Page) => page.locator('[role="tablist"] [role="tab"][aria-selected="true"]').innerText().then(text => text.trim().replace(/\s+\d+$/, ''))
	const tabParam = (page: Page) => new URL(page.url()).searchParams.get('tab')

	it('keeps ?tab= in step with the tab, so a link to the Views tab is never a no-op', async () => {
		const { context, page } = await open('/?tab=views')
		try {
			await page.locator('[data-views-table]').waitFor()
			const historyLength = await page.evaluate(() => history.length)
			await page.keyboard.press('2')
			await expect.poll(() => selectedTab(page)).toBe('Checks')
			expect(tabParam(page)).toBe('checks')
			await page.keyboard.press('3')
			await expect.poll(() => tabParam(page)).toBe('activity')
			// Switching tabs replaces the entry: Back leaves the Overview, not the last tab.
			expect(await page.evaluate(() => history.length)).toBe(historyLength)

			// G V from another tab (the location the View crumb, ⌘K "Views" and the Reviews empty
			// state also use) lands on the Views tab.
			await page.keyboard.press('g')
			await page.keyboard.press('v')
			await expect.poll(() => selectedTab(page)).toBe('Views')
			expect(tabParam(page)).toBe('views')

			// Views is the default: switching back to it drops the query.
			await page.keyboard.press('2')
			await expect.poll(() => tabParam(page)).toBe('checks')
			await page.keyboard.press('1')
			await expect.poll(() => new URL(page.url()).search).toBe('')
			expect(await selectedTab(page)).toBe('Views')

			// A bare `/` (G O, the sidebar's Overview) is the Views tab too.
			await page.keyboard.press('2')
			await expect.poll(() => tabParam(page)).toBe('checks')
			await page.keyboard.press('g')
			await page.keyboard.press('o')
			await expect.poll(() => new URL(page.url()).search).toBe('')
			await expect.poll(() => selectedTab(page)).toBe('Views')
		}
		finally { await context.close() }
	}, 60_000)

	it('still opens a phone cold load of a bare / on Reviews, and keeps an explicit tab', async () => {
		const bare = await open('/', { width: 390, height: 844 })
		try {
			await expect.poll(() => new URL(bare.page.url()).pathname).toBe('/reviews')
		}
		finally { await bare.context.close() }

		const checks = await open('/?tab=checks', { width: 390, height: 844 })
		try {
			await expect.poll(() => selectedTab(checks.page)).toBe('Checks')
			expect(new URL(checks.page.url()).pathname).toBe('/')
			expect(tabParam(checks.page)).toBe('checks')
		}
		finally { await checks.context.close() }
	}, 60_000)
})
