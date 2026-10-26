import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Contour precision and refinement in the built Workbench (issue #110): the display tolerance
 * under the canvas zoom, refinement against the real runtime, cancellation, escalation of rejected
 * responses, and the latch. A test shim in the Workbench page holds or corrupts the runtime's contour
 * responses, and a work-scoped `failure.report` is posted as the Preview window.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** A pill: its radius is half its height, so its contour is curved and its bound is a few tenths of a pixel. */
const WIDGET_ID = 'workspace-tag'

type ContourShim = { mode: 'pass' | 'hold' | 'miss'; held: unknown[] }
type ShimWindow = Window & { __contourShim: ContourShim; __releaseContour: () => void }

/**
 * Runs in the Workbench page before its scripts: a capturing listener sees each Preview post first.
 * It splits the contour responses out of a post, holds them or raises their `maxError` (a precision
 * miss), and lets everything else through; a re-dispatched copy keeps the Preview window as its source.
 */
const CONTOUR_SHIM = `(() => {
	if (window.top !== window) return
	const shim = window.__contourShim = { mode: 'pass', held: [] }
	const replayed = new WeakSet()
	const isContour = message => message && (message.type === 'contour.full.response' || message.type === 'contour.partial.response')
	const replay = (data, origin, source) => {
		const event = new MessageEvent('message', { data, origin, source })
		replayed.add(event)
		window.dispatchEvent(event)
	}
	window.__releaseContour = () => {
		shim.mode = 'pass'
		for (const post of shim.held.splice(0)) replay(post.data, post.origin, post.source)
	}
	window.addEventListener('message', (event) => {
		const data = event.data
		if (replayed.has(event) || !data || data.channel !== 'uiux:preview:wire' || data.passThrough || shim.mode === 'pass') return
		const batch = Array.isArray(data.messages)
		const messages = batch ? data.messages : [data.message]
		if (!messages.some(isContour)) return
		event.stopImmediatePropagation()
		const others = messages.filter(message => !isContour(message))
		const contours = messages.filter(isContour)
		if (others.length) replay(batch ? { channel: data.channel, messages: others } : { channel: data.channel, message: others[0] }, event.origin, event.source)
		if (shim.mode === 'hold') shim.held.push({ data: { channel: data.channel, messages: contours }, origin: event.origin, source: event.source })
		else for (const message of contours) {
			const missed = { ...message, payload: { ...message.payload, regions: message.payload.regions.map(region => ({ ...region, maxError: 9 })) } }
			replay({ channel: data.channel, messages: [missed] }, event.origin, event.source)
		}
	}, true)
})()`

let server: WorkbenchServer
let browser: Browser

async function authorVariant(name: string): Promise<void> {
	const read = await (await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })).json() as { revision: string; resource: { ir: unknown; variants: Record<string, unknown> } }
	const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/structure`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, ir: read.resource.ir, variants: { ...read.resource.variants, [name]: { state: {} } } }),
	})
	if (!response.ok) throw new Error(`Could not author the test Variant: ${response.status} ${await response.text()}`)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	await authorVariant('compact')
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page; frame: Frame }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(CONTOUR_SHIM)
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	const handle = await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })
	const frame = await handle.contentFrame()
	if (!frame) throw new Error('Preview iframe has no content frame.')
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return { context, page, frame }
}

/** Contour traffic the Preview received (requests, cancellations) or the Workbench received (responses). */
const received = (target: Page | Frame, prefix = 'contour.') => target.evaluate(
	(wanted) => (window as unknown as WireRecorderWindow).__wire.messages.filter((message: WireRecord) => message.type.startsWith(wanted)),
	prefix,
)
const requestsOf = async (frame: Frame) => (await received(frame)).filter(message => message.type.endsWith('.request'))
const setMode = (page: Page, mode: ContourShim['mode']) => page.evaluate((value) => { (window as unknown as ShimWindow).__contourShim.mode = value }, mode)
const heldCount = (page: Page) => page.evaluate(() => (window as unknown as ShimWindow).__contourShim.held.length)
const release = (page: Page) => page.evaluate(() => (window as unknown as ShimWindow).__releaseContour())

async function zoomTo(page: Page, percent: string): Promise<void> {
	await page.locator('[data-zoom-percent]').click()
	await page.getByRole('menuitemcheckbox', { name: percent, exact: true }).click()
	await expect.poll(() => page.locator('[data-zoom-percent]').textContent()).toContain(percent)
}


/** Waits until the contour requests the Preview received stop changing, and returns them. */
async function settledRequests(frame: Frame): Promise<WireRecord[]> {
	let previous = -1
	for (let attempt = 0; attempt < 40; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 250))
		const current = (await requestsOf(frame)).length
		if (current === previous && current > 0) return requestsOf(frame)
		previous = current
	}
	throw new Error('Contour requests never settled.')
}

/** Posts a `failure.report` as the Preview window, naming the work of a request. */
function reportWorkFailure(frame: Frame, request: WireRecord): Promise<void> {
	return frame.evaluate((work) => {
		parent.postMessage({ channel: 'uiux:preview:wire', passThrough: true, message: {
			type: 'failure.report',
			context: work.context,
			payload: {
				category: 'runtime',
				reason: 'runtime.unavailable',
				sequence: work.payload.sequence,
				...(work.payload.baseSnapshotVersion !== undefined ? { baseSnapshotVersion: work.payload.baseSnapshotVersion } : {}),
			},
		} }, location.origin)
	}, request)
}

describe('Contour precision and refinement in the Workbench', () => {
	it('draws at the fit scale without contour work, refines when a zoom makes a contour miss the tolerance, and restores on scale-down', async () => {
		const { context, page, frame } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			expect(await requestsOf(frame)).toEqual([])
			expect(await page.locator('[data-precision-unavailable]').count()).toBe(0)

			await zoomTo(page, '200%')
			// The zoom tweens, so requests for the scales on the way are superseded by finer ones.
			await expect.poll(async () => ((await requestsOf(frame)).at(-1)?.payload.targetMaxError as number | undefined) ?? 1, { timeout: 15_000 }).toBeLessThanOrEqual(0.25)
			const [first] = await requestsOf(frame)
			expect(first!.type).toBe('contour.partial.request')
			expect(first!.context).toMatchObject({ widgetId: WIDGET_ID })
			expect(first!.context).not.toHaveProperty('navigationRequestId')
			// The highlight comes back only from a result that meets the tolerance.
			await page.waitForSelector('[data-overlay-selection]', { timeout: 15_000 })
			expect((await received(page)).map(message => message.type)).toContain('contour.partial.response')
			const settled = await settledRequests(frame)

			await zoomTo(page, '50%')
			await page.waitForSelector('[data-overlay-selection]')
			expect((await requestsOf(frame)).length).toBe(settled.length)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('cancels pending work on a Variant switch and never commits its late response', async () => {
		const { context, page, frame } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			await setMode(page, 'hold')
			await zoomTo(page, '200%')
			const pending = (await settledRequests(frame)).at(-1)!
			expect(await page.locator('[data-overlay-selection]').count()).toBe(0)
			await expect.poll(() => heldCount(page)).toBeGreaterThan(0)

			await page.locator('[data-context="variant"]').click()
			await page.getByRole('option', { name: 'compact' }).click()
			await page.waitForFunction(() => new URL(location.href).searchParams.get('variant') === 'compact')
			await expect.poll(async () => (await received(frame, 'contour.cancel')).some(message => message.payload.sequence === pending.payload.sequence)).toBe(true)
			const cancel = (await received(frame, 'contour.cancel')).find(message => message.payload.sequence === pending.payload.sequence)!
			expect(cancel.context).toEqual(pending.context)

			// The late response of the replaced context is stale; the new context refines for itself.
			await setMode(page, 'pass')
			await release(page)
			await page.waitForSelector('[data-overlay-selection]', { timeout: 15_000 })
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			const variantRequests = (await settledRequests(frame)).filter(message => message.context.variantId === 'compact')
			expect(variantRequests.length).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('retries a rejected refinement once, then regenerates, then stops without latching or flooding', async () => {
		const { context, page, frame } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			await setMode(page, 'miss')
			await zoomTo(page, '200%')
			const requests = await settledRequests(frame)
			expect(requests.slice(-3).map(message => message.type)).toEqual(['contour.partial.request', 'contour.partial.request', 'contour.full.request'])
			const [firstTry, retry] = requests.slice(-3)
			expect(retry!.payload).toMatchObject({ regionIds: firstTry!.payload.regionIds, baseSnapshotVersion: firstTry!.payload.baseSnapshotVersion })
			expect(retry!.payload.sequence as number).toBeGreaterThan(firstTry!.payload.sequence as number)
			// The cache is still too coarse: the highlight stays hidden, says so, and shows no failure diagnostic.
			await page.waitForSelector('[data-precision-unavailable]', { timeout: 10_000 })
			expect(await page.locator('[data-overlay-selection]').count()).toBe(0)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			await new Promise(resolve => setTimeout(resolve, 1000))
			expect((await requestsOf(frame)).length).toBe(requests.length)

			// Scale-down brings the accurate cache back, and nothing is asked for at the final scale. The
			// tween passes scales that still miss it, which the rejected refinements may answer on the way.
			await zoomTo(page, '50%')
			await page.waitForSelector('[data-overlay-selection]')
			expect(await page.locator('[data-precision-unavailable]').count()).toBe(0)
			const restored = (await settledRequests(frame)).length
			await new Promise(resolve => setTimeout(resolve, 800))
			expect((await requestsOf(frame)).length).toBe(restored)
		}
		finally { await context.close() }
	}, 90_000)

	it('ends work on a work-scoped failure report and latches until the geometry or the context changes', async () => {
		const { context, page, frame } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			await setMode(page, 'hold')
			await zoomTo(page, '200%')
			const requests = await settledRequests(frame)
			const work = requests.at(-1)!
			const declarations = (await received(page, 'capability.declare')).length

			await reportWorkFailure(frame, work)
			// The refinement failure shows the diagnostic and the unavailable notice; the selection stays.
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 10_000 })
			expect(await diagnostic.getAttribute('data-category')).toBe('runtime')
			expect(await diagnostic.getAttribute('data-reason')).toBe('runtime.unavailable')
			await page.waitForSelector('[data-precision-unavailable]')
			expect(await page.locator('[data-overlay-selection]').count()).toBe(0)
			expect(new URL(page.url()).searchParams.get('widget')).toBe(WIDGET_ID)
			// The generation and its stream stay live, and the late response of the ended work is stale.
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
			expect((await received(page, 'capability.declare')).length).toBe(declarations)
			await setMode(page, 'pass')
			await release(page)

			// Scale changes alone neither clear it nor start a refinement; a cache that meets the tolerance still draws.
			await zoomTo(page, '150%')
			await zoomTo(page, '200%')
			await new Promise(resolve => setTimeout(resolve, 800))
			expect((await requestsOf(frame)).length).toBe(requests.length)
			expect(await diagnostic.count()).toBe(1)
			await zoomTo(page, '50%')
			await page.waitForSelector('[data-overlay-selection]')
			expect(await diagnostic.count()).toBe(1)

			// Another context ends the latch.
			await page.locator('[data-context="variant"]').click()
			await page.getByRole('option', { name: 'compact' }).click()
			await page.waitForFunction(() => new URL(location.href).searchParams.get('variant') === 'compact')
			await expect.poll(() => diagnostic.count()).toBe(0)
			await zoomTo(page, '200%')
			await page.waitForSelector('[data-overlay-selection]', { timeout: 15_000 })
			expect((await requestsOf(frame)).length).toBeGreaterThan(requests.length)
		}
		finally { await context.close() }
	}, 90_000)

	it('clears the latch with an explicit Retry Preview, which starts a new generation', async () => {
		const { context, page, frame } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			await setMode(page, 'hold')
			await zoomTo(page, '200%')
			const work = (await settledRequests(frame)).at(-1)!
			await reportWorkFailure(frame, work)
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 10_000 })
			const declarations = (await received(page, 'capability.declare')).length
			await page.locator('[data-preview-retry]').click()
			await expect.poll(async () => (await received(page, 'capability.declare')).length, { timeout: 15_000 }).toBeGreaterThan(declarations)
			await expect.poll(() => diagnostic.count(), { timeout: 15_000 }).toBe(0)
			await setMode(page, 'pass')
			await page.waitForSelector('[data-overlay-selection]', { timeout: 15_000 })
		}
		finally { await context.close() }
	}, 90_000)
})
