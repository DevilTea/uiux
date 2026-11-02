import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Views list layouts and View thumbnails (Features 01a19b99-ca97-7aa7-b326-345c8a26caf3 and
 * 01a19b99-c9ee-7dcb-ae96-bbe31f12591c) against the built Workbench, the real Chromium capture and a
 * private copy of the frozen fixture Workspace.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const LAYOUT_KEY = 'uiux.workbench.viewsLayout'

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(options: Readonly<{ path?: string; width?: number; storageThrows?: boolean; context?: BrowserContext }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = options.context ?? await browser.newContext({ viewport: { width: options.width ?? 1440, height: 900 } })
	if (!options.context) {
		await context.addInitScript((throws: boolean) => {
			if (localStorage.getItem('nuxt-color-mode') === null) localStorage.setItem('nuxt-color-mode', 'light')
			if (localStorage.getItem('uiux.workbench.locale') === null) localStorage.setItem('uiux.workbench.locale', 'en-US')
			if (throws) {
				// A browser that keeps no choice: reads of the layout key fail.
				const original = Storage.prototype.getItem
				Storage.prototype.getItem = function (key: string) {
					if (key === 'uiux.workbench.viewsLayout') throw new Error('storage is unavailable')
					return original.call(this, key)
				}
			}
		}, options.storageThrows === true)
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	}
	const page = await context.newPage()
	await page.goto(`${server.origin}${options.path ?? '/'}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

describe('the layout of the Views tab (Scenario 01a19b99-e37d-7c6a-bd74-0ebd53ff635f)', () => {
	it('opens in the list, offers a grid of the same Views, and remembers the choice in this browser only', async () => {
		const { context, page } = await open()
		try {
			await page.locator('[data-views-table]').waitFor()
			expect(await page.locator('[data-views-grid]').count()).toBe(0)
			const listCount = await page.locator('[data-views-table] [data-view-row]').count()
			expect(listCount).toBeGreaterThan(0)
			expect(await page.locator('[data-views-layout="list"]').getAttribute('aria-pressed')).toBe('true')

			await page.locator('[data-views-layout="grid"]').click()
			await page.locator('[data-views-grid]').waitFor()
			expect(await page.locator('[data-views-table]').count()).toBe(0)
			expect(await page.locator('[data-views-grid] [data-view-card]').count()).toBe(listCount)
			expect(await page.locator('[data-views-layout="grid"]').getAttribute('aria-pressed')).toBe('true')
			expect(await page.evaluate(key => localStorage.getItem(key), LAYOUT_KEY)).toBe('grid')

			await page.reload({ waitUntil: 'networkidle' })
			await page.locator('[data-views-grid]').waitFor()

			// Another browser (a fresh profile) of the same member still opens the list.
			const other = await open()
			try {
				await other.page.locator('[data-views-table]').waitFor()
				expect(await other.page.locator('[data-views-grid]').count()).toBe(0)
			}
			finally { await other.context.close() }

			await page.locator('[data-views-layout="list"]').click()
			await page.locator('[data-views-table]').waitFor()
			expect(await page.evaluate(key => localStorage.getItem(key), LAYOUT_KEY)).toBe('list')
		}
		finally { await context.close() }
	}, 90_000)

	it('opens in the list and still toggles when the browser keeps no choice', async () => {
		const { context, page } = await open({ storageThrows: true })
		try {
			await page.locator('[data-views-table]').waitFor()
			await page.locator('[data-views-layout="grid"]').click()
			await page.locator('[data-views-grid]').waitFor()
		}
		finally { await context.close() }
	}, 60_000)

	it('shows the small thumbnail before the name in the phone list and one column of cards in the phone grid', async () => {
		const { context, page } = await open({ width: 390, path: '/?tab=views' })
		try {
			await page.locator('[data-views-list]').waitFor()
			expect(await page.locator('[data-views-list] [data-view-thumbnail][data-thumbnail-size="row"]').count()).toBeGreaterThan(0)
			await page.locator('[data-views-layout="grid"]').click()
			await page.locator('[data-views-grid]').waitFor()
			const card = page.locator('[data-views-grid] [data-view-card]').first()
			const box = (await card.boundingBox())!
			expect(box.width).toBeGreaterThan(300)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('thumbnails on the cards (Scenario 01a19b99-e2e7-7758-b94d-b440c87581cf)', () => {
	it('requests the thumbnails when the tab opens, shows a placeholder, then replaces it with the 480 px image in place, and the card stays a link named by its View', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
			localStorage.setItem('uiux.workbench.viewsLayout', 'grid')
		})
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			const requested = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/thumbnails/request'))
			await page.goto(`${server.origin}/`, { waitUntil: 'domcontentloaded' })
			const card = page.locator(`[data-view-card][data-view-row="${VIEW_ID}"]`)
			await card.waitFor()
			expect(JSON.parse((await requested).postData() ?? '{}')).toEqual({ keys: [VIEW_ID] })
			// The card is a link named by its View; its thumbnail is decorative.
			const name = await card.getAttribute('aria-label')
			expect(name).toBeTruthy()
			expect(await card.evaluate(element => element.tagName)).toBe('A')

			// Placeholder (never a broken image) until the server has stored the image, then the image itself.
			const image = card.locator('[data-thumbnail-image]')
			await image.waitFor({ timeout: 60_000 })
			expect(await image.getAttribute('alt')).toBe('')
			expect(await image.getAttribute('aria-hidden')).toBe('true')
			await page.waitForFunction(selector => {
				const element = document.querySelector<HTMLImageElement>(selector)
				return !!element && element.complete && element.naturalWidth > 0
			}, `[data-view-card][data-view-row="${VIEW_ID}"] [data-thumbnail-image]`, { timeout: 30_000 })
			expect(await image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBe(480)
			// The fixture's widest viewport is 1920 x 1080: 480 x 270.
			expect(await image.evaluate(element => (element as HTMLImageElement).naturalHeight)).toBe(270)
			expect(await card.locator('[data-thumbnail-placeholder]').count()).toBe(0)
			expect(await card.locator('[data-thumbnail-stale-indicator]').count()).toBe(0)

			// The response is `no-store` and needs the session (Rule 01a19bb9-9685-7bbf-ab29-a22032c91c64, Clause 01a19bb9-8e8a-7775-b19b-76e0b855095c).
			const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/thumbnail`, { headers: server.headers })
			expect(response.status).toBe(200)
			expect(response.headers.get('cache-control')).toBe('no-store')
			expect(response.headers.get('content-type')).toBe('image/png')
			expect((await fetch(`${server.origin}/api/views/${VIEW_ID}/thumbnail`)).status).toBe(401)
		}
		finally { await context.close() }
	}, 120_000)

	it('shows the stale indicator as soon as the View changes, then the new image replaces the old one without a reload', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
			localStorage.setItem('uiux.workbench.viewsLayout', 'grid')
		})
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/`, { waitUntil: 'domcontentloaded' })
			const card = page.locator(`[data-view-card][data-view-row="${VIEW_ID}"]`)
			await card.locator('[data-thumbnail-image]').waitFor({ timeout: 60_000 })
			await page.evaluate(() => { (window as unknown as { __noReload: boolean }).__noReload = true })
			const before = await card.locator('[data-thumbnail-image]').getAttribute('src')

			// Change what the View renders: its thumbnail is stale at once and refreshes after the quiet period.
			const read = await (await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })).json() as { revision: string; resource: { ir: { slots: { content: Array<{ config: Record<string, unknown> }> } }; variants: unknown } }
			const ir = structuredClone(read.resource.ir)
			ir.slots.content[0]!.config.gap = 7
			const changed = await fetch(`${server.origin}/api/views/${VIEW_ID}/structure`, {
				method: 'PUT',
				headers: { ...server.headers, 'content-type': 'application/json' },
				body: JSON.stringify({ expectedRevision: read.revision, ir, variants: read.resource.variants }),
			})
			expect(changed.status, await changed.clone().text()).toBeLessThan(300)

			await card.locator('[data-thumbnail-stale-indicator], [data-thumbnail-refreshing-indicator]').first().waitFor({ timeout: 15_000 })
			// The previous image stays, with no error marker, until the new one is stored.
			expect(await card.locator('[data-thumbnail-placeholder]').count()).toBe(0)
			await page.waitForFunction(selector => !document.querySelector(selector), `[data-view-card][data-view-row="${VIEW_ID}"] [data-thumbnail-stale-indicator]`, { timeout: 90_000 })
			await page.waitForFunction(selector => !document.querySelector(selector), `[data-view-card][data-view-row="${VIEW_ID}"] [data-thumbnail-refreshing-indicator]`, { timeout: 30_000 })
			expect(await card.locator('[data-thumbnail-image]').getAttribute('src')).not.toBe(before)
			expect(await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload)).toBe(true)
		}
		finally { await context.close() }
	}, 180_000)
})
