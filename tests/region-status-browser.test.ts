import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * The Workbench against a Preview that reports `regionStatus` (issue #106; Clause
 * 01a11a59-dbda-79e5-9337-307bb9c1798b): one translucent-obstruction notice beside the highlight and a
 * matching marker on the Widget's Checks entry while proven translucent coverage lies over it, gone with
 * the coverage and hidden in comment mode, adding no finding; and "precise highlighting unavailable",
 * said apart from "not visible", for a Widget whose region cannot be established.
 *
 * The Widget is a real Text Widget of a private Workspace copy. The coverage and the unprovable chain are
 * put into the Preview document by the test, which the real runtime then measures and reports.
 */

const VIEW_ID = 'c0000000-0000-4000-8000-000000000106'
const WIDGET_ID = 'bad-text'

let server: WorkbenchServer
let browser: Browser

/** A valid View with one Text Widget. */
function view(): string {
	return `${JSON.stringify({
		id: VIEW_ID,
		name: 'Region status',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: WIDGET_ID, config: { text: 'A Widget that gets covered', variant: 'h3' } }] } },
		variants: {},
		spec: { intent: 'A View whose Widget is covered.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}, null, '\t')}\n`
}

beforeAll(async () => {
	server = await startWorkbenchServer({ prepare: async (root) => { await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), view()) } })
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(panel: 'readiness' | 'inspect'): Promise<{ context: BrowserContext; page: Page; frame: Frame }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	// The Workbench's own read of the View carries one finding on the Widget, so that its Checks panel lists an entry for it. A finding that the Preview's own read of the View shared would stop the View from rendering.
	await page.route(`**/api/resources/view/${VIEW_ID}`, async (route) => {
		if (route.request().frame() !== page.mainFrame()) return route.continue()
		const response = await route.fetch()
		const body = await response.json() as { diagnostics?: unknown[] }
		await route.fulfill({ response, json: { ...body, diagnostics: [...(body.diagnostics ?? []), { code: 'test.widget_finding', path: '/ir/slots/content/0', message: 'A finding on the Widget.' }] } })
	})
	await page.goto(`${server.origin}/views/${VIEW_ID}?panel=${panel}&widget=${WIDGET_ID}`, { waitUntil: 'networkidle' })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 30_000 })
	const frame = (await (await page.locator('iframe[src*="/preview"]').elementHandle())!.contentFrame())!
	await frame.waitForSelector(`[data-widget-id="${WIDGET_ID}"]`, { state: 'attached', timeout: 20_000 })
	return { context, page, frame }
}

const highlight = (page: Page) => page.locator('[data-overlay-selection]')
const notice = (page: Page) => page.locator('[data-translucent-notice]')
const marker = (page: Page) => page.locator('[data-translucent-marker]')
const unavailableChip = (page: Page) => page.locator('[data-precision-unavailable]')
const liveRegion = (page: Page) => page.locator('[role="status"][aria-live="polite"]', { hasText: /\S/ })

/** A translucent layer over the Widget, in the Preview document. */
function cover(frame: Frame): Promise<void> {
	return frame.evaluate((id) => {
		const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
		const layer = document.createElement('div')
		layer.id = 'test-cover'
		layer.style.cssText = `position:fixed;left:${rect.left - 8}px;top:${rect.top - 8}px;width:${rect.width + 16}px;height:${rect.height + 16}px;background:rgba(0,0,0,0.3)`
		document.body.append(layer)
	}, WIDGET_ID)
}

const uncover = (frame: Frame) => frame.evaluate(() => document.getElementById('test-cover')?.remove())

/** The region status reports that the Preview sent for the Widget, newest last. */
const reports = (page: Page) => page.evaluate(id => (window as unknown as WireRecorderWindow).__wire.messages
	.filter(message => message.type === 'geometry.acquire.response' && message.context.widgetId === id)
	.map(message => ({ regions: (message.payload.regions as unknown[]).length, status: message.payload.regionStatus ?? null })), WIDGET_ID)

describe('translucent coverage in the Workbench (issue #106)', () => {
	it('shows one notice beside the highlight and one marker on the Checks entry, follows the coverage, and adds no finding', async () => {
		const { context, page, frame } = await open('readiness')
		try {
			const entry = page.locator('[data-facet="validation"] button', { hasText: `#${WIDGET_ID}` }).first()
			await entry.waitFor({ timeout: 20_000 })
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			expect(await notice(page).count()).toBe(0)
			expect(await marker(page).count()).toBe(0)
			const findings = await page.locator('[data-facet="validation"] dd').first().innerText()

			await cover(frame)
			await notice(page).waitFor({ state: 'attached', timeout: 20_000 })
			await marker(page).waitFor({ state: 'attached', timeout: 20_000 })
			// One notice and one marker; the highlight keeps the covered Widget, which is still discernible.
			expect(await notice(page).count()).toBe(1)
			expect(await marker(page).count()).toBe(1)
			expect(await highlight(page).count()).toBe(1)
			expect(await notice(page).innerText()).toContain('Under a translucent layer')
			expect(await marker(page).innerText()).toContain('Under a translucent layer')
			// Beside the highlight, on the top-right of the aggregate bounds of its regions.
			const outline = (await highlight(page).locator('path').last().boundingBox())!
			const chip = (await notice(page).boundingBox())!
			expect(Math.abs(chip.x + chip.width - (outline.x + outline.width))).toBeLessThanOrEqual(4)
			expect(chip.y).toBeLessThan(outline.y + outline.height)
			// The wire carries the status with its regions, for the same report that moved the highlight.
			expect((await reports(page)).at(-1)).toEqual({ regions: 1, status: 'translucent' })
			// Said to assistive technology: the overlay is aria-hidden, a polite status region is not.
			expect(await notice(page).evaluate(element => !!element.closest('[aria-hidden="true"]'))).toBe(true)
			await expect.poll(async () => (await liveRegion(page).allInnerTexts()).join(' '), { timeout: 10_000 }).toContain('under a translucent layer')
			// The notice describes a state: it adds no finding and changes no count.
			expect(await page.locator('[data-facet="validation"] dd').first().innerText()).toBe(findings)

			// The coverage goes away without the Widget moving or resizing: both follow it.
			await uncover(frame)
			await expect.poll(() => notice(page).count(), { timeout: 20_000 }).toBe(0)
			expect(await marker(page).count()).toBe(0)
			expect((await reports(page)).at(-1)).toEqual({ regions: 1, status: null })
			expect(await highlight(page).count()).toBe(1)
		}
		finally { await context.close() }
	}, 120_000)

	it('hides the notice and the marker in comment mode and shows them again from fresh geometry', async () => {
		const { context, page, frame } = await open('readiness')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			await cover(frame)
			await notice(page).waitFor({ state: 'attached', timeout: 20_000 })
			await marker(page).waitFor({ state: 'attached', timeout: 20_000 })
			await page.keyboard.press('c')
			await expect.poll(() => notice(page).count(), { timeout: 10_000 }).toBe(0)
			expect(await marker(page).count()).toBe(0)
			expect(await highlight(page).count()).toBe(0)
			await page.keyboard.press('Escape')
			await notice(page).waitFor({ state: 'attached', timeout: 20_000 })
			await marker(page).waitFor({ state: 'attached', timeout: 20_000 })
			expect(await notice(page).count()).toBe(1)
		}
		finally { await context.close() }
	}, 120_000)
})

describe('unavailable precision in the Workbench (issue #106)', () => {
	it('says that precise highlighting is unavailable for a region that cannot be established, and not that the Widget is not visible', async () => {
		const { context, page, frame } = await open('inspect')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			await frame.evaluate(id => { document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!.style.filter = 'blur(1px)' }, WIDGET_ID)
			await page.locator('[data-widget-precision-unavailable]').waitFor({ timeout: 20_000 })
			expect((await reports(page)).at(-1)).toEqual({ regions: 0, status: 'unavailable' })
			// Selected and not highlighted, with the notice on the Widget's rectangle.
			expect(await highlight(page).count()).toBe(0)
			await unavailableChip(page).waitFor({ state: 'attached', timeout: 10_000 })
			expect(await page.locator('[data-widget-not-visible]').count()).toBe(0)
			await expect.poll(async () => (await liveRegion(page).allInnerTexts()).join(' '), { timeout: 10_000 }).toContain('Precise highlighting is unavailable')

			// A Widget with no visible part is a different state, with its own text.
			await frame.evaluate(id => {
				const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
				element.style.filter = ''
				element.style.visibility = 'hidden'
			}, WIDGET_ID)
			await page.locator('[data-widget-not-visible]').waitFor({ timeout: 20_000 })
			expect(await page.locator('[data-widget-precision-unavailable]').count()).toBe(0)
			expect(await unavailableChip(page).count()).toBe(0)
			expect((await reports(page)).at(-1)).toEqual({ regions: 0, status: null })
		}
		finally { await context.close() }
	}, 120_000)
})
