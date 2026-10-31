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
		spec: { intent: 'A View whose Widget is covered.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
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
			// A finding that names a Widget is never also shown as "Not linked to a Widget", with or without the marker.
			expect(await page.getByText('Not linked to a Widget').count()).toBe(0)
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

describe('the highlight follows the Widget (Rule 01a11658-1bda)', () => {
	/** The Widget's rectangle in Workbench pixels, and the bounding box of the outline the Workbench draws for it. */
	async function boxes(page: Page, frame: Frame) {
		const widget = (await frame.locator(`[data-widget-id="${WIDGET_ID}"]`).boundingBox())!
		const outline = (await highlight(page).locator('path.stroke-selection').first().boundingBox())!
		return { widget, outline }
	}
	const onWidget = ({ widget, outline }: Awaited<ReturnType<typeof boxes>>) => Math.max(
		Math.abs(outline.x - widget.x), Math.abs(outline.y - widget.y),
		Math.abs(outline.width - widget.width), Math.abs(outline.height - widget.height),
	)
	const responses = (page: Page) => page.evaluate(id => (window as unknown as WireRecorderWindow).__wire.messages
		.filter(message => message.type === 'geometry.acquire.response' && message.context.widgetId === id).length, WIDGET_ID)

	it('tracks a Widget that moves, resizes or reflows, one update per animation frame at most, and does nothing while it is still', async () => {
		const { context, page, frame } = await open('inspect')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			const resting = (await boxes(page, frame)).outline

			// Resizes.
			await frame.evaluate(id => { const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!; element.style.display = 'block'; element.style.width = '180px' }, WIDGET_ID)
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			expect((await boxes(page, frame)).outline.width).toBeLessThan(resting.width)

			// Moves: a layout offset, with no scroll and no resize.
			const xBefore = (await boxes(page, frame)).outline.x
			await frame.evaluate(id => { const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!; element.style.position = 'relative'; element.style.left = '120px' }, WIDGET_ID)
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			expect((await boxes(page, frame)).outline.x).toBeGreaterThan(xBefore + 20)

			// Reflows: content inserted above pushes it down, though nothing about the Widget itself changed.
			const yBefore = (await boxes(page, frame)).outline.y
			await frame.evaluate(() => { const spacer = document.createElement('div'); spacer.id = 'test-spacer'; spacer.style.height = '90px'; document.body.prepend(spacer) })
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			expect((await boxes(page, frame)).outline.y).toBeGreaterThan(yBefore + 20)

			// A burst of changes inside one frame is reported once, and a run of frames at most once per frame.
			await page.evaluate(() => {
				const win = window as unknown as { __frames: number; __sampling: boolean }
				win.__frames = 0
				win.__sampling = true
				const tick = () => { win.__frames++; if (win.__sampling) requestAnimationFrame(tick) }
				requestAnimationFrame(tick)
			})
			await page.waitForTimeout(200)
			const burstFrom = await responses(page)
			await frame.evaluate((id) => {
				const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
				for (let step = 0; step < 50; step++) element.style.left = `${step}px`
			}, WIDGET_ID)
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			await page.waitForTimeout(300)
			expect((await responses(page)) - burstFrom).toBeLessThanOrEqual(1)

			const runFrom = await responses(page)
			const framesFrom = await page.evaluate(() => (window as unknown as { __frames: number }).__frames)
			await frame.evaluate((id) => new Promise<void>((resolve) => {
				const element = document.querySelector<HTMLElement>(`[data-widget-id="${id}"]`)!
				let step = 0
				const move = () => { element.style.left = `${40 + (++step) * 3}px`; if (step < 30) requestAnimationFrame(move); else resolve() }
				requestAnimationFrame(move)
			}), WIDGET_ID)
			await expect.poll(async () => onWidget(await boxes(page, frame)), { timeout: 10_000 }).toBeLessThan(4)
			await page.waitForTimeout(300)
			const updates = (await responses(page)) - runFrom
			const frames = (await page.evaluate(() => (window as unknown as { __frames: number }).__frames)) - framesFrom
			expect(updates).toBeGreaterThan(1)
			expect(updates).toBeLessThanOrEqual(frames)

			// Still: no update arrives and the Preview runs no animation frame, which is neither frozen (above) nor polled.
			const stillResponses = await responses(page)
			const stillFrames = await frame.evaluate(() => (window as unknown as WireRecorderWindow).__rafCallbacks)
			await page.waitForTimeout(1_000)
			expect(await responses(page)).toBe(stillResponses)
			expect(await frame.evaluate(() => (window as unknown as WireRecorderWindow).__rafCallbacks)).toBe(stillFrames)
			await page.evaluate(() => { (window as unknown as { __sampling: boolean }).__sampling = false })
		}
		finally { await context.close() }
	}, 120_000)
})

describe('the highlight outline (Rules 01a11658-1ca4, 01a11658-1db1 and 01a11687-2d8d)', () => {
	/** The path data of every outline path the Workbench draws for the selection. */
	const outlinePaths = (page: Page) => highlight(page).locator('path').evaluateAll(paths => paths.map((path) => {
		const style = getComputedStyle(path)
		// The stroke width as drawn on screen: the attribute times the scale of every transform above the path.
		const screenScale = Math.hypot((path as SVGGraphicsElement).getScreenCTM()!.a, (path as SVGGraphicsElement).getScreenCTM()!.b)
		return { d: path.getAttribute('d') ?? '', fill: style.fill, fillAttr: path.closest('g')?.getAttribute('fill') ?? path.getAttribute('fill'), stroke: style.stroke, strokePx: Math.round(Number.parseFloat(path.getAttribute('stroke-width') ?? '0') * screenScale * 1000) / 1000 }
	}))

	it('outlines every reported region of a Widget split by an opaque band, as one selection (Rule 01a11658-1ca4)', async () => {
		const { context, page, frame } = await open('inspect')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			const widgetBox = (await frame.locator(`[data-widget-id="${WIDGET_ID}"]`).boundingBox())!
			// An opaque band across the middle of the Widget splits what is visible of it into two regions.
			await frame.evaluate((id) => {
				const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
				const band = document.createElement('div')
				band.id = 'test-band'
				band.style.cssText = `position:fixed;left:${rect.left + rect.width * 0.4}px;top:${rect.top - 10}px;width:${rect.width * 0.2}px;height:${rect.height + 20}px;background:#123456`
				document.body.append(band)
			}, WIDGET_ID)
			await expect.poll(async () => ((await reports(page)).at(-1)?.regions ?? 0), { timeout: 20_000 }).toBe(2)
			// One outline per reported region, still one selection: one highlight element, one selected Widget.
			await expect.poll(() => highlight(page).locator('path.stroke-selection').count(), { timeout: 10_000 }).toBe(2)
			expect(await highlight(page).count()).toBe(1)
			const boxesOfPaths = await highlight(page).locator('path.stroke-selection').evaluateAll(paths => paths.map((path) => { const box = (path as SVGGraphicsElement).getBoundingClientRect(); return { x: box.x, width: box.width } }))
			// The two regions lie on either side of the band: one path left of the Widget's middle and one right of it.
			const middle = widgetBox.x + widgetBox.width / 2
			expect(boxesOfPaths.some(box => box.x + box.width <= middle + 2)).toBe(true)
			expect(boxesOfPaths.some(box => box.x >= middle - 2)).toBe(true)
			expect(new URL(page.url()).searchParams.get('widget')).toBe(WIDGET_ID)
			expect(await page.locator('[data-blueprint="type"]').count()).toBeLessThanOrEqual(1)
		}
		finally { await context.close() }
	}, 120_000)

	it('strokes only the outer perimeter of a region that encloses a hidden area: no fill and no inner ring (Rule 01a11687-2d8d)', async () => {
		const { context, page, frame } = await open('inspect')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			const single = await outlinePaths(page)
			// An opaque block in the middle of the Widget: a hole in its visible part, enclosed by the region.
			await frame.evaluate((id) => {
				const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
				const block = document.createElement('div')
				block.id = 'test-hole'
				block.style.cssText = `position:fixed;left:${rect.left + rect.width * 0.35}px;top:${rect.top + rect.height * 0.25}px;width:${rect.width * 0.3}px;height:${rect.height * 0.5}px;background:#123456`
				document.body.append(block)
			}, WIDGET_ID)
			await expect.poll(async () => ((await reports(page)).at(-1)?.regions ?? 0), { timeout: 20_000 }).toBe(1)
			await page.waitForTimeout(500)
			const paths = await outlinePaths(page)
			expect(paths.length).toBeGreaterThan(0)
			for (const path of paths) {
				// Stroked, never filled.
				expect(path.stroke).not.toBe('none')
				expect(['none', 'rgba(0, 0, 0, 0)'].includes(path.fill) || path.fillAttr === 'none').toBe(true)
				// One closed ring per path: a single `M` and no ring for the hole inside.
				expect(path.d.match(/M/gu)?.length ?? 0).toBe(1)
			}
			// The ring is the outer perimeter: its bounding box stays the Widget's, as it was without the hole.
			const outer = (await highlight(page).locator('path.stroke-selection').first().boundingBox())!
			const widgetBox = (await frame.locator(`[data-widget-id="${WIDGET_ID}"]`).boundingBox())!
			expect(Math.abs(outer.width - widgetBox.width)).toBeLessThan(6)
			expect(Math.abs(outer.height - widgetBox.height)).toBeLessThan(6)
			expect(single.length).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('keeps the stroke width in final Workbench pixels when the Preview is zoomed (Rule 01a11658-1db1)', async () => {
		const { context, page } = await open('inspect')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			const strokes = async () => (await outlinePaths(page)).map(path => path.strokePx)
			const scale = async () => (await page.locator('iframe[src*="/preview"]').boundingBox())!.width
			const before = await strokes()
			expect(before.length).toBeGreaterThan(0)
			expect(before.every(px => px > 0)).toBe(true)
			let lastWidth = await scale()
			// Zoom the canvas: the Preview is scaled by the canvas, the stroke is not.
			for (const percent of ['200%', '50%']) {
				await page.locator('[data-zoom-percent]').click()
				await page.getByRole('menuitemcheckbox', { name: percent, exact: true }).click()
				await expect.poll(() => page.locator('[data-zoom-percent]').textContent()).toContain(percent)
				await expect.poll(scale, { timeout: 10_000 }).not.toBe(lastWidth)
				lastWidth = await scale()
				await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
				await page.waitForTimeout(500)
				expect(await strokes()).toEqual(before)
			}
		}
		finally { await context.close() }
	}, 120_000)
})

describe('the translucent-coverage marker lives only where the Preview is live (Rule 01a11a70-38db)', () => {
	it('appears on the Widget\'s Checks entry on its View page and never in Overview › Checks', async () => {
		const { context, page, frame } = await open('readiness')
		try {
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			await cover(frame)
			// On the View page, where the Preview is live, the Widget's Checks entry carries the marker.
			await marker(page).waitFor({ state: 'attached', timeout: 20_000 })
			expect(await page.locator('[data-facet="validation"] li', { hasText: `#${WIDGET_ID}` }).locator('[data-translucent-marker]').count()).toBe(1)

			// Overview › Checks, reached inside the same Workbench page while the coverage is still there: no Preview, no marker.
			await page.getByRole('link', { name: 'Overview', exact: true }).first().click()
			await page.getByRole('tab', { name: /^Checks/ }).click()
			await page.locator('[data-check-sources]').waitFor({ timeout: 20_000 })
			expect(await page.locator('iframe[src*="/preview"]').count()).toBe(0)
			await page.waitForTimeout(1_000)
			expect(await marker(page).count()).toBe(0)
			expect(await notice(page).count()).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)
})
