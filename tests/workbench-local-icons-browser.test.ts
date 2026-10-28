import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'

import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workbench draws its icons without a third party (issue #263). With `ssr: false` Nuxt Icon defaults to the
 * public Iconify API, so every page load made requests to it: not local-first, and when that API was slow or
 * unreachable (GitHub-hosted runners, 2026-10-28) a page never went idle, so
 * `page.goto(..., { waitUntil: 'networkidle' })` failed with `Timeout 30000ms exceeded`. Icons now come from the
 * client bundle (`icon.clientBundle.scan`) or, for one the scan does not find, from `/api/_nuxt_icon/:collection`
 * of the same server (Clause 01a11485-f958-7a99-9970-07cefeb5a51b).
 *
 * The test hangs every request that leaves the server's origin, as an unreachable third party would: a request
 * that goes out keeps the page from reaching idle, and is also recorded by URL.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const ROUTES = ['/', `/views/${VIEW_ID}`, `/views/${VIEW_ID}?panel=history`, '/flows', '/reviews', '/workspace/settings', '/workspace/product-kit', '/workspace/access-presets', '/workspace/locales', '/workspace/assets']

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

/** Icons whose mask (the icon's drawing, injected as a style once its data is loaded) is in place. */
async function drawnIcons(page: Page): Promise<number> {
	return await page.evaluate(() => [...document.querySelectorAll('span.iconify')].filter(icon => /url\(/.test(getComputedStyle(icon).maskImage || getComputedStyle(icon).webkitMaskImage)).length)
}

describe('Workbench icons', () => {
	it('loads every main route to network idle without a request to another origin, with its icons drawn', async () => {
		const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const foreign: string[] = []
		await context.route(url => !['data:', 'blob:', 'about:'].includes(url.protocol) && url.origin !== server.origin, () => new Promise<void>(() => {}))
		context.on('request', (request) => {
			const url = new URL(request.url())
			if (url.origin !== server.origin && !['data:', 'blob:', 'about:'].includes(url.protocol)) foreign.push(request.url())
		})
		const page = await context.newPage()
		for (const route of ROUTES) {
			await page.goto(`${server.origin}${route}`, { waitUntil: 'networkidle', timeout: 45_000 })
			await expect.poll(() => drawnIcons(page), { timeout: 15_000, message: route }).toBeGreaterThan(0)
		}
		await context.close()
		expect(foreign).toEqual([])
	}, 240_000)
})
