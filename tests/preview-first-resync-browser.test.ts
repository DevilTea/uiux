import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'

import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The first `hello` of a session resyncs every read (Rule 01a11485-f39f-7464-9f8f-608335ed9800, #281). When that resync
 * ran before the page's own first list reads had landed, the Locale revisions went from unknown to known and the
 * Workbench took that for a change of what the Preview renders from, so it replaced the Preview document (a second
 * generation) although nothing had changed. Whether the resync wins that race depends on timing alone (it came up under
 * load, #263); the test delays the page's own first list reads so that it always does.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

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

describe('Preview after the first resync of a session (issue #263)', () => {
	it('keeps its first document and generation when the resync lands before the page\'s own first list reads', async () => {
		const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addInitScript(PREVIEW_WIRE_RECORDER)
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		// The page's own first list reads (one per resource kind) are late; the resync after `hello` is not.
		let delayed = 0
		await context.route('**/api/resources/list', async (route) => {
			if (delayed < 5) {
				delayed++
				await new Promise(resolve => setTimeout(resolve, 1_500))
			}
			await route.continue()
		})
		const page = await context.newPage()
		const documents = new Set<string>()
		page.on('framenavigated', (frame) => {
			const url = new URL(frame.url(), server.origin)
			if (frame !== page.mainFrame() && url.pathname === '/preview') documents.add(url.searchParams.get('document') ?? '')
		})
		try {
			await page.goto(`${server.origin}/views/${VIEW_ID}`, { waitUntil: 'load' })
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 30_000 })
			// Past the delayed reads and the re-read they cause, if any.
			await page.waitForTimeout(3_000)
			expect(delayed).toBe(5)
			const declared = await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type === 'capability.declare').length)
			expect(declared).toBe(1)
			expect([...documents]).toHaveLength(1)
		}
		finally {
			await context.close()
		}
	}, 120_000)
})
