import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Review feedback 8dd59d25 (dogfooding the real Workbench):
 *
 * 1. The parent crumb ("Views", "UX Flows") led back to the View or Flow the reviewer was on: the
 *    index pages redirected into the most recent View / first Flow on tablet and desktop.
 * 2. Comments sometimes could not be started. Real causes, each pinned here: after moving between
 *    Views in the app the previous page's late teardown unregistered the new page's comment
 *    handlers (a Comment click did nothing, Esc and the palette's canvas actions were gone); a
 *    Select click left keyboard focus in the iframe, which swallowed `C`; and a role, snapshot or
 *    phone hid the Comment tool without a word.
 * 3. A comment on the View as a whole, without picking a Widget (the RootShell anchor).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const FLOW_ID = 'de4668fc-aa5b-4a1d-ac44-ab134f858a55'
const SECOND_VIEW_ID = 'b0000000-0000-4000-8000-0000000008dd'
const SPEC = { intent: 'A second View to move to.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }

let server: WorkbenchServer
let browser: Browser

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	// A second View, authored through the View API (never by hand).
	await api('/api/views', { id: SECOND_VIEW_ID, name: 'Second View', spec: SPEC })
	const read = await api<{ revision: string }>(`/api/resources/view/${SECOND_VIEW_ID}`)
	await api(`/api/views/${SECOND_VIEW_ID}/structure`, {
		expectedRevision: read.revision,
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'second-title', config: { text: 'Second View', variant: 'h2' } }] } },
		variants: {},
	}, 'PUT')
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, setup: Readonly<{ width?: number; height?: number }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: setup.width ?? 1440, height: setup.height ?? 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

/** The live Preview of `viewId` (after an in-app move the previous document is replaced). */
async function livePreview(page: Page, viewId = VIEW_ID): Promise<Frame> {
	const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${viewId}"]`, { timeout: 15_000 })
	const frame = (await handle.contentFrame())!
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return frame
}

const pressedTool = (page: Page) => page.locator('[role="toolbar"] button[aria-pressed="true"]').getAttribute('data-tool')

describe('Parent crumbs land on the index (feedback 1)', () => {
	it('goes from a View to the list of every View, and stays there', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			await livePreview(page)
			// The one View list is the Overview's Views tab.
			await page.getByRole('navigation', { name: 'Location' }).getByRole('link', { name: 'Overview' }).click()
			await page.waitForURL(url => url.pathname === '/')
			await page.locator('[data-views-table] [data-view-row]').first().waitFor()
			// The index used to redirect straight back to the most recent View on tablet and desktop.
			await page.waitForTimeout(800)
			expect(new URL(page.url()).pathname).toBe('/')
			expect(await page.locator('[data-views-table] [data-view-row]').count()).toBe(2)
			const opened = page.locator('[data-views-table] tr').filter({ has: page.locator(`[data-view-row="${VIEW_ID}"]`) })
			expect(await opened.textContent()).toContain('Last opened')
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps the old /views address on the View list', async () => {
		const { context, page } = await open('/views')
		try {
			await page.waitForURL(url => url.pathname === '/' && url.searchParams.get('tab') === 'views')
			await page.locator('[data-views-table] [data-view-row]').first().waitFor()
		}
		finally { await context.close() }
	}, 60_000)

	it('goes from a Flow to the list of every Flow', async () => {
		const { context, page } = await open(`/flows/${FLOW_ID}`)
		try {
			await page.getByRole('navigation', { name: 'Location' }).getByRole('link', { name: 'UX Flows' }).click()
			await page.waitForURL(url => url.pathname === '/flows')
			await page.waitForTimeout(800)
			expect(new URL(page.url()).pathname).toBe('/flows')
			expect(await page.getByRole('list', { name: /Flows/ }).getByRole('link').count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Comments can always be started, or say why not (feedback 2)', () => {
	it('keeps C working after a Select click puts focus in the iframe', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			const frame = await livePreview(page)
			await frame.locator('[data-widget-id="btn-run-checks"]').click()
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'btn-run-checks')
			// The Workbench took keyboard focus back from the View's document.
			expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe('IFRAME')
			await page.keyboard.press('c')
			await expect.poll(() => pressedTool(page)).toBe('comment')
			await frame.locator('[data-widget-id="btn-run-checks"]').click()
			await page.locator('[data-comment-composer]').waitFor({ timeout: 10_000 })
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps comment targeting, Escape, pins and the palette after moving between Views in the app', async () => {
		const thread = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: SECOND_VIEW_ID, widgetId: 'second-title' } })
		await api(`/api/reviews/${thread.key}/messages`, { expectedRevision: thread.revision, body: 'Title weight.' })
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			await livePreview(page)
			// In-app navigation: the next page is set up before the previous one is torn down.
			await page.getByRole('button', { name: 'All Views' }).click()
			await page.locator(`a[href^="/views/${SECOND_VIEW_ID}"]`).first().click()
			const frame = await livePreview(page, SECOND_VIEW_ID)
			// The new page's pins survive the previous page's teardown.
			await page.locator(`.pin-anchor:not([hidden]) [data-pin-thread="${thread.key}"]`).waitFor({ timeout: 15_000 })
			await page.mouse.move(2, 600)
			await page.keyboard.press('c')
			await expect.poll(() => pressedTool(page)).toBe('comment')
			await frame.locator('[data-widget-id="second-title"]').click()
			await page.locator('[data-comment-composer]').waitFor({ timeout: 10_000 })
			await page.keyboard.press('Escape')
			await expect.poll(() => page.locator('[data-comment-composer]').count()).toBe(0)
			await page.keyboard.press('Escape')
			await expect.poll(() => pressedTool(page)).toBe('select')
			// The canvas still offers its commands in the palette.
			await page.keyboard.press('ControlOrMeta+k')
			await page.getByRole('option', { name: /Comment on this View/ }).waitFor({ timeout: 10_000 })
		}
		finally { await context.close() }
	}, 90_000)

	it('shows a disabled Comment tool with its reason on a phone-width window', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`, { width: 700, height: 900 })
		try {
			await page.locator('[data-view-phone] [role="tab"]').nth(2).click()
			await livePreview(page)
			const comment = page.locator('[role="toolbar"] [data-tool="comment"]')
			expect(await comment.getAttribute('aria-disabled')).toBe('true')
			expect(await comment.getAttribute('aria-description')).toContain('Not available on phones')
			await comment.click({ force: true })
			await expect.poll(() => page.locator('li', { hasText: 'Not available on phones' }).count()).toBeGreaterThan(0)
			expect(await pressedTool(page)).toBe('select')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Comments on the View as a whole (feedback 3)', () => {
	it('opens the composer without a Widget and anchors the thread to the RootShell', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			await livePreview(page)
			await page.locator('[data-comment-on-view="pill"]').click()
			const composer = page.locator('[data-comment-composer]')
			await composer.waitFor()
			expect(await page.locator('[data-composer-target="view"]').textContent()).toContain('Whole View')
			// The pending pin and its composer sit at the frame's top-left, not at the stage's corner.
			const frameBox = (await page.locator('[data-canvas-frame-box]').boundingBox())!
			const pendingBox = (await page.locator('[data-pin-thread="pending"]').boundingBox())!
			expect(Math.abs(pendingBox.x - frameBox.x)).toBeLessThan(40)
			expect(Math.abs(pendingBox.y + pendingBox.height - frameBox.y)).toBeLessThan(40)
			await page.keyboard.type('The rhythm between sections feels uneven overall.')
			await page.keyboard.press('ControlOrMeta+Enter')
			await page.locator('[data-thread-bubble]').waitFor({ timeout: 10_000 })

			const reviews = await api<{ items: { key: string; summary: { anchor?: { viewId: string; widgetId: string } } }[] }>('/api/resources/list', { kinds: ['review'], limit: 100 })
			const onView = reviews.items.filter(item => item.summary.anchor?.viewId === VIEW_ID && item.summary.anchor.widgetId === 'root')
			expect(onView.length).toBeGreaterThan(0)

			const row = page.locator('[data-comment-group="view"] [data-comment-row]')
			await row.first().waitFor()
			expect(await row.first().textContent()).toContain('Whole View')
			const pin = page.locator(`.pin-anchor:not([hidden]) [data-pin-thread="${onView.at(-1)!.key}"]`)
			expect(await pin.getAttribute('aria-label')).toContain('on this View')
		}
		finally { await context.close() }
	}, 60_000)

	it('is offered by the Comments tab and the command palette', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			await livePreview(page)
			await page.locator('[data-comment-on-view="tab"]').click()
			await page.locator('[data-composer-target="view"]').waitFor()
			await page.keyboard.press('Escape')
			await expect.poll(() => page.locator('[data-comment-composer]').count()).toBe(0)
			await page.keyboard.press('ControlOrMeta+k')
			await page.getByRole('option', { name: /Comment on this View/ }).click()
			await page.locator('[data-composer-target="view"]').waitFor()
			await expect.poll(() => page.evaluate(() => !!document.activeElement?.closest('[data-comment-composer]'))).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)
})
