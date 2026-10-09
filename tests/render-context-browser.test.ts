import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * A Review thread's recorded render context in the Workbench (Part 7, schemaVersion 4; issue #144)
 * against the built Workbench and a private copy of the frozen fixture Workspace (Locale files
 * en-US and zh-TW; viewports desktop, tablet and mobile; themes dark and light):
 *
 * - a canvas comment records the Preview's Locale, viewport and theme (Rule 01a1170f-c0ce,
 *   Scenario 01a11e0e-42a3), and a Workbench re-anchor keeps it (Rule 01a11e0d-d3f8);
 * - the inbox link opens the thread in that context (Rule 01a116f0-8ec3, Scenario 01a11e0e-435a),
 *   the header shows it and offers the current context instead (Rule 01a1170f-c11d);
 * - a removed viewport opens with the default and a notice (Rule 01a1170f-c165, Scenario
 *   01a11e0e-4409);
 * - the chrome language and theme never change (Rule 01a118a1-9e11).
 *
 * The tests share one thread and run in order.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const ZH_MOBILE_DARK = { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }

let server: WorkbenchServer
let browser: Browser
let threadId: string

type Posted = { path: string; body: Record<string, unknown> }
type ReviewRead = { revision: string; resource: { anchor: { viewId: string; widgetId: string }; renderContext?: Record<string, string> } }

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
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

/** A desktop browser whose Workbench chrome is en-US and light, whatever the Preview shows. */
async function open(path: string): Promise<{ context: BrowserContext; page: Page; posts: Posted[] }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	const posts: Posted[] = []
	page.on('request', (request) => {
		const path = new URL(request.url()).pathname
		if (request.method() === 'POST' && path.startsWith('/api/reviews'))
			posts.push({ path, body: JSON.parse(request.postData() ?? '{}') as Record<string, unknown> })
	})
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page, posts }
}

async function livePreview(page: Page): Promise<Frame> {
	const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${VIEW_ID}"]`, { timeout: 15_000 })
	const frame = (await handle.contentFrame())!
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return frame
}

/** The chrome's own language and theme, which a thread's context must never touch (Rule 01a118a1-9e11). */
async function chrome(page: Page) {
	return await page.evaluate(() => ({
		lang: document.documentElement.lang,
		dark: document.documentElement.classList.contains('dark'),
		savedLocale: localStorage.getItem('uiux.workbench.locale'),
		savedMode: localStorage.getItem('nuxt-color-mode'),
	}))
}
const LIGHT_EN_US = { lang: 'en-US', dark: false, savedLocale: 'en-US', savedMode: 'light' }

const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)
const previewWidth = (frame: Frame) => frame.evaluate(() => window.innerWidth)

describe('Review render context in the Workbench (Part 7)', () => {
	it('records the Preview\'s Locale, viewport and theme on a comment on the whole View, and a Workbench re-anchor keeps it', async () => {
		const { context, page, posts } = await open(`/views/${VIEW_ID}?locale=zh-TW&viewport=mobile&theme=dark`)
		try {
			const frame = await livePreview(page)
			expect(await previewWidth(frame)).toBe(390)
			await page.locator('[data-comment-on-view="pill"]').click()
			await page.locator('[data-comment-composer]').waitFor()
			await page.keyboard.type('The zh-TW title wraps on mobile.')
			await page.keyboard.press('ControlOrMeta+Enter')
			await page.locator('[data-thread-bubble]').waitFor({ timeout: 10_000 })

			const create = posts.find(post => post.path === '/api/reviews')!
			expect(create.body.anchor).toEqual({ viewId: VIEW_ID, widgetId: 'root' })
			expect(create.body.renderContext).toEqual(ZH_MOBILE_DARK)
			threadId = posts.find(post => post.path.endsWith('/messages'))!.path.split('/')[3]!
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual(ZH_MOBILE_DARK)

			// The bubble header shows what the thread records.
			await expect.poll(() => page.locator('[data-thread-bubble] [data-thread-context]').getAttribute('data-context')).toBe('zh-TW · mobile · dark')
			// Opened in place, the thread is already in the reader's context: nothing to offer instead.
			expect(await page.locator('[data-thread-bubble] [data-thread-open-current]').count()).toBe(0)

			// Re-anchor from the bubble to a Widget: the body sends no renderContext and the thread keeps it.
			await page.locator('[data-thread-bubble]').getByRole('button', { name: 'More', exact: true }).click()
			await page.getByRole('menuitem', { name: 'Re-anchor' }).click()
			await frame.locator('[data-widget-id="app-title"]').click()
			await expect.poll(async () => (await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.anchor.widgetId, { timeout: 10_000 }).toBe('app-title')
			const reanchor = posts.find(post => post.path.endsWith('/reanchor'))!
			expect(reanchor.body).not.toHaveProperty('renderContext')
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual(ZH_MOBILE_DARK)
			expect(await chrome(page)).toEqual(LIGHT_EN_US)
		}
		finally { await context.close() }
	}, 90_000)

	it('opens the thread from the inbox in its recorded context, offers the reader\'s own context instead, and never changes the chrome', async () => {
		// The reader last previewed the View in its defaults: en-US, the widest viewport (desktop) and dark.
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			let frame = await livePreview(page)
			expect(await previewWidth(frame)).toBe(1920)
			await page.locator('a[href="/reviews"]').first().click()
			await page.waitForURL(url => url.pathname === '/reviews')
			await page.locator(`[data-review-row="${threadId}"]`).click()
			const detail = page.locator(`[data-review-detail][data-thread-id="${threadId}"]`)
			await detail.waitFor()
			expect(await detail.locator('[data-thread-context]').getAttribute('data-context')).toBe('zh-TW · mobile · dark')
			expect(await detail.locator('[data-thread-open-current]').textContent()).toContain('Open in current context')

			await detail.locator('[data-review-open-canvas]').click()
			await page.waitForURL(url => url.pathname === `/views/${VIEW_ID}`)
			expect(query(page)).toMatchObject({ thread: threadId, locale: 'zh-TW', viewport: 'mobile', theme: 'dark', widget: 'app-title' })
			frame = await livePreview(page)
			await expect.poll(() => previewWidth(frame)).toBe(390)
			expect(await page.locator(`iframe[src*="/preview"]`).getAttribute('title')).toContain('zh-TW')
			await page.locator('[data-thread-bubble]').waitFor()
			expect(await chrome(page)).toEqual(LIGHT_EN_US)

			// "Open in current context": back to the reader's own Preview context, the thread still open.
			await page.locator('[data-thread-bubble] [data-thread-open-current]').click()
			await expect.poll(() => query(page).locale).toBeUndefined()
			expect(query(page)).not.toHaveProperty('viewport')
			expect(query(page)).not.toHaveProperty('theme')
			expect(query(page).thread).toBe(threadId)
			await expect.poll(() => previewWidth(frame)).toBe(1920)
			await expect.poll(() => page.locator('[data-thread-bubble] [data-thread-open-current]').count()).toBe(0)
			expect(await chrome(page)).toEqual(LIGHT_EN_US)
			// The thread still records its own context.
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual(ZH_MOBILE_DARK)
		}
		finally { await context.close() }
	}, 90_000)

	it('opens with the default viewport and a notice naming it once the recorded viewport is removed from the settings', async () => {
		const workspace = await api<{ revision: string; resource: Record<string, unknown> & { viewports: Record<string, unknown> } }>('/api/resources/workspace/workspace')
		const viewports = Object.fromEntries(Object.entries(workspace.resource.viewports).filter(([id]) => id !== 'mobile'))
		const { i18n, adapters, themes } = workspace.resource
		await api('/api/workspace/settings', { expectedRevision: workspace.revision, settings: { i18n, adapters, viewports, themes } }, 'PUT')

		const { context, page } = await open(`/reviews?thread=${threadId}`)
		try {
			const detail = page.locator(`[data-review-detail][data-thread-id="${threadId}"]`)
			await detail.waitFor({ timeout: 15_000 })
			// The header still names the recorded viewport, marked as no longer existing.
			await expect.poll(() => detail.locator('[data-thread-context] [data-context-member="viewportId"]').getAttribute('data-context-missing')).toBe('')
			await detail.locator('[data-review-open-canvas]').click()
			await page.waitForURL(url => url.pathname === `/views/${VIEW_ID}`)
			expect(query(page)).toMatchObject({ thread: threadId, locale: 'zh-TW', theme: 'dark' })
			expect(query(page)).not.toHaveProperty('viewport')
			// A non-blocking toast names the missing viewport.
			await page.getByText('Viewport mobile no longer exists, so the default viewport is shown.').first().waitFor({ timeout: 10_000 })
			await page.getByText('Part of this thread’s context no longer exists').first().waitFor()
			const frame = await livePreview(page)
			// The default viewport is the widest remaining preset.
			await expect.poll(() => previewWidth(frame)).toBe(1920)
			expect(await page.locator(`iframe[src*="/preview"]`).getAttribute('title')).toContain('zh-TW')
			expect(await chrome(page)).toEqual(LIGHT_EN_US)
			// The stale key is never rebound: the thread still records it.
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual(ZH_MOBILE_DARK)
		}
		finally { await context.close() }
	}, 90_000)
})
