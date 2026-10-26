import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Checks navigation to a Widget that is rendered and visible but scrolled out of the Preview viewport
 * (issue #105; Discussion #131 decision 2): the Workbench asks once with `geometry.reveal`, the
 * Preview scrolls its own content to it, and the highlight lands on the geometry that follows.
 *
 * The fixture View is opened at the Mobile viewport (390 × 844), where its Checks area lies below
 * the fold. Two Text keys are missing from zh-TW, so the Preview reports a translation warning for
 * a Widget below the fold and one at the top, and Overview › Checks offers each as a Widget navigation.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** Rendered at the Mobile viewport, far below its fold; its label key is missing from zh-TW. */
const WIDGET_ID = 'chk-lint-label'
const WIDGET_KEY = 'inspector.checks.rules.label'
/** Rendered at the top of the View; its label key is missing from zh-TW too. */
const NEAR_WIDGET_ID = 'btn-run-checks'
const NEAR_KEY = 'header.action.checks'
/** Rendered at the top of the View, with its key present. */
const OTHER_WIDGET_ID = 'app-title'
const MOBILE_HEIGHT = 844
const VIEW_PATH = `/views/${VIEW_ID}?locale=zh-TW`

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			const zhPath = join(root, 'i18n', 'zh-TW.json')
			const zh = JSON.parse(await readFile(zhPath, 'utf8')) as Record<string, string>
			delete zh[WIDGET_KEY]
			delete zh[NEAR_KEY]
			await writeFile(zhPath, `${JSON.stringify(zh)}\n`)
			// Mobile is the only Viewport, so it stays selected when Overview › Checks opens the View by its address.
			const manifestPath = join(root, 'workspace.json')
			const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { viewports: Record<string, unknown> }
			await writeFile(manifestPath, `${JSON.stringify({ ...manifest, viewports: { mobile: manifest.viewports.mobile } })}\n`)
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const iframe = (page: Page) => page.locator('iframe[src*="/preview"]')

/** The Preview document, once its runtime generation is live and it renders the Widget. */
async function livePreview(page: Page, widgetId = WIDGET_ID): Promise<Frame> {
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
	const frame = (await (await iframe(page).elementHandle())!.contentFrame())!
	await frame.waitForSelector(`[data-widget-id="${widgetId}"]`, { state: 'attached', timeout: 20_000 })
	return frame
}

const scrollTopOf = (frame: Frame) => frame.evaluate(() => Math.round(document.scrollingElement!.scrollTop))
const viewportBox = (frame: Frame, widgetId: string) => frame.evaluate((id) => {
	const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
	return { top: Math.round(rect.top), bottom: Math.round(rect.bottom), height: document.documentElement.clientHeight }
}, widgetId)
/** The wire messages the Preview document received, of one type. */
const received = (frame: Frame, type: string) => frame.evaluate(t => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type === t), type)
const requestsFor = async (frame: Frame, widgetId: string) => (await received(frame, 'geometry.acquire.request')).filter(message => message.context.widgetId === widgetId)
const revealsFor = async (frame: Frame, widgetId: string) => (await received(frame, 'geometry.reveal')).filter(message => message.context.widgetId === widgetId)
const highlight = (page: Page) => page.locator('[data-overlay-selection]')

/** The Preview reported a translation warning for the Widget, so that Overview › Checks lists it. */
async function warned(page: Page, widgetId: string): Promise<void> {
	await expect.poll(() => page.evaluate(id => (window as unknown as WireRecorderWindow).__wire.messages
		.some(message => message.type === 'checks.report' && JSON.stringify(message.payload.translationWarnings ?? []).includes(`"${id}"`)), widgetId), { timeout: 30_000 }).toBe(true)
}

/** Leaves the View for Overview › Checks inside the same Workbench page, as a person does, and follows the Widget's finding. */
async function followFinding(page: Page, widgetId: string): Promise<void> {
	await page.getByRole('link', { name: 'Overview', exact: true }).first().click()
	await page.getByRole('tab', { name: /^Checks/ }).click()
	await page.locator('[data-check-sources]').waitFor()
	const finding = page.locator('[data-finding-source="preview-translation"]', { hasText: widgetId })
	await finding.first().waitFor()
	await finding.first().click()
	await page.waitForFunction(id => new URL(location.href).searchParams.get('widget') === id, widgetId)
}

async function expectRevealed(page: Page, frame: Frame, widgetId: string): Promise<void> {
	await expect.poll(async () => (await scrollTopOf(frame)) > 0, { timeout: 20_000 }).toBe(true)
	const box = await viewportBox(frame, widgetId)
	expect(box.top).toBeGreaterThanOrEqual(0)
	expect(box.bottom).toBeLessThanOrEqual(box.height)
	// The highlight lands on the geometry that the scroll produced.
	await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
}

describe('a Checks navigation reveals an offscreen Widget (issue #105)', () => {
	it('scrolls the Preview to it, highlights it, and asks once on the stream it opened (Rule 01a11a59-e876-780b-832c-0a139baabc95)', async () => {
		const { context, page } = await open(VIEW_PATH)
		try {
			const first = await livePreview(page)
			// Rendered and visible, but below the Preview viewport; opening the View reveals nothing.
			expect((await viewportBox(first, WIDGET_ID)).top).toBeGreaterThan(MOBILE_HEIGHT)
			expect(await scrollTopOf(first)).toBe(0)
			await warned(page, WIDGET_ID)
			expect(await received(first, 'geometry.reveal')).toEqual([])

			await followFinding(page, WIDGET_ID)
			// The Checks navigation opens the View in a new Preview document and generation.
			const frame = await livePreview(page)
			expect(frame).not.toBe(first)
			await expectRevealed(page, frame, WIDGET_ID)

			// One reveal, on the open stream of the Widget, right after the request that opened it.
			// The stream that the acknowledged generation opened is the latest request: an earlier one reached the document before its runtime was acknowledged and was dropped.
			const request = (await requestsFor(frame, WIDGET_ID)).at(-1)
			const reveals = await revealsFor(frame, WIDGET_ID)
			expect(reveals).toHaveLength(1)
			expect(reveals[0]!.payload).toEqual({})
			expect(reveals[0]!.context.navigationRequestId).toBe(request!.context.navigationRequestId)
			expect(reveals[0]!.context).not.toHaveProperty('geometryRevision')
			const messages = await frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.map(message => `${message.type}:${message.context.widgetId ?? ''}`))
			expect(messages.indexOf(`geometry.reveal:${WIDGET_ID}`)).toBe(messages.lastIndexOf(`geometry.acquire.request:${WIDGET_ID}`) + 1)
			// No other stream is revealed.
			expect(await received(frame, 'geometry.reveal')).toHaveLength(1)
		}
		finally { await context.close() }
	}, 120_000)

	it('asks for a Widget that is already in view too, and the Preview leaves its scroll position alone', async () => {
		const { context, page } = await open(VIEW_PATH)
		try {
			await livePreview(page, NEAR_WIDGET_ID)
			await warned(page, NEAR_WIDGET_ID)
			await followFinding(page, NEAR_WIDGET_ID)
			const frame = await livePreview(page, NEAR_WIDGET_ID)
			await expect.poll(async () => (await revealsFor(frame, NEAR_WIDGET_ID)).length, { timeout: 20_000 }).toBe(1)
			await highlight(page).first().waitFor({ state: 'attached', timeout: 20_000 })
			expect(await scrollTopOf(frame)).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)
})

describe('only a Checks navigation reveals (Rule 01a11a59-ea08-74ff-8a88-6e70b4fa3a84)', () => {
	it('does not scroll for a Widget selected by the address, and says that it is outside the visible area', async () => {
		const { context, page } = await open(`${VIEW_PATH}&widget=${WIDGET_ID}&panel=inspect`)
		try {
			const frame = await livePreview(page)
			await expect.poll(async () => (await requestsFor(frame, WIDGET_ID)).length, { timeout: 20_000 }).toBeGreaterThan(0)
			await page.waitForTimeout(800)
			expect(await received(frame, 'geometry.reveal')).toEqual([])
			expect(await scrollTopOf(frame)).toBe(0)
			// Rendered, but wholly outside the viewport: offscreen, not hidden, and nothing is highlighted.
			await page.getByText('Outside the visible area of the View.').first().waitFor({ timeout: 20_000 })
			expect(await highlight(page).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('does not scroll for a selection in the Widget tree after a Checks navigation', async () => {
		const { context, page } = await open(VIEW_PATH)
		try {
			await livePreview(page)
			await warned(page, WIDGET_ID)
			await followFinding(page, WIDGET_ID)
			const frame = await livePreview(page, OTHER_WIDGET_ID)
			await expectRevealed(page, frame, WIDGET_ID)
			expect(await revealsFor(frame, WIDGET_ID)).toHaveLength(1)
			await frame.evaluate(() => { document.scrollingElement!.scrollTop = 0 })
			await page.getByRole('treeitem', { name: new RegExp(OTHER_WIDGET_ID) }).first().click()
			await page.waitForFunction(id => new URL(location.href).searchParams.get('widget') === id, OTHER_WIDGET_ID)
			await page.waitForTimeout(800)
			expect(await received(frame, 'geometry.reveal')).toHaveLength(1)
			expect(await scrollTopOf(frame)).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)
})

describe('the Preview ignores a reveal that does not name an open stream', () => {
	const sendIntoRuntime = (page: Page, message: Record<string, unknown>) => page.evaluate((body) => {
		document.querySelector<HTMLIFrameElement>('iframe[src*="/preview"]')!.contentWindow!.postMessage({ channel: 'uiux:preview:wire', message: body }, location.origin)
	}, message)

	it('leaves the Preview where it is and the generation live for an unknown stream, a Widget without a stream and a superseded stream', async () => {
		const { context, page } = await open(`${VIEW_PATH}&widget=${WIDGET_ID}`)
		try {
			const frame = await livePreview(page)
			await expect.poll(async () => (await requestsFor(frame, WIDGET_ID)).length, { timeout: 20_000 }).toBeGreaterThan(0)
			const generation = (await iframe(page).getAttribute('data-runtime-generation')) ?? ''
			const session = new URL((await iframe(page).getAttribute('src')) ?? '', server.origin).searchParams.get('session')!
			const base = { previewSessionId: session, runtimeGenerationId: generation, viewId: VIEW_ID }
			const [open] = await requestsFor(frame, WIDGET_ID)
			await sendIntoRuntime(page, { type: 'geometry.reveal', context: { ...base, widgetId: WIDGET_ID, navigationRequestId: 'never-opened' }, payload: {} })
			await sendIntoRuntime(page, { type: 'geometry.reveal', context: { ...base, widgetId: 'no-such-widget', navigationRequestId: open!.context.navigationRequestId }, payload: {} })
			await sendIntoRuntime(page, { type: 'geometry.reveal', context: { ...base, widgetId: WIDGET_ID, navigationRequestId: open!.context.navigationRequestId, viewId: '22222222-2222-4222-8222-222222222222' }, payload: {} })
			await page.waitForTimeout(1_000)
			expect(await scrollTopOf(frame)).toBe(0)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			expect(await iframe(page).getAttribute('data-runtime-generation')).toBe(generation)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')

			// The same message on the open stream scrolls, which shows that the Preview accepts it at all.
			await sendIntoRuntime(page, { type: 'geometry.reveal', context: { ...base, widgetId: WIDGET_ID, navigationRequestId: open!.context.navigationRequestId }, payload: {} })
			await expect.poll(() => scrollTopOf(frame), { timeout: 20_000 }).toBeGreaterThan(0)
			const box = await viewportBox(frame, WIDGET_ID)
			expect(box.bottom).toBeLessThanOrEqual(box.height)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
		}
		finally { await context.close() }
	}, 90_000)

	it('declares geometry.reveal in a Workbench Preview', async () => {
		const { context, page } = await open(VIEW_PATH)
		try {
			await livePreview(page, OTHER_WIDGET_ID)
			const features = await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.find(message => message.type === 'capability.declare')?.payload.features)
			expect(features).toContain('geometry.reveal')
		}
		finally { await context.close() }
	}, 60_000)
})
