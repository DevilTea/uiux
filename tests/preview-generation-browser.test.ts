import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Runtime-minted generation IDs (issue #102) against the built Workbench and a private copy of the
 * Workspace snapshot: the Preview runtime mints its generation (Clause
 * 01a1161c-4119-712d-8785-7d8155c0ceee), so a reloaded Preview document is a new generation and the
 * retired one is never revived (Clauses 01a1161c-4339-7614-ba65-6f21e37cd1a0 and
 * 01a1161c-4154-7de9-9dc5-622d21438a47), and geometry is acquired again under the new one (Clause
 * 01a1161c-4379-76a7-b15e-984a9b7e3309).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const WIDGET_ID = 'btn-run-checks'

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

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
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
/** The generation the Workbench admitted; '' while it has none. */
const admitted = async (page: Page) => await iframe(page).getAttribute('data-runtime-generation') ?? ''
const received = (target: Page | Frame): Promise<WireRecord[]> => target.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages)

async function liveFrame(page: Page): Promise<Frame> {
	const frame = await (await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })).contentFrame()
	if (!frame) throw new Error('Preview iframe has no content frame.')
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return frame
}

describe('Preview runtime generation identity (issue #102)', () => {
	it('mints no generation in the Preview URL, and a reloaded document gets a new one, never reviving the old', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			let frame = await liveFrame(page)
			await page.waitForSelector('[data-blueprint="type"]')
			const src = await iframe(page).getAttribute('src') ?? ''
			const url = new URL(src, server.origin)
			// Nothing in the Preview URL fixes the generation.
			expect(url.searchParams.has('generation')).toBe(false)
			const sessionId = url.searchParams.get('session') ?? ''
			const first = await admitted(page)
			expect(first).toMatch(/^gen-[0-9a-f]{32}$/)
			// The runtime named it: its declaration carries the ID, and the ACK echoes it.
			expect((await received(page)).filter(message => message.type === 'capability.declare').map(message => message.context.runtimeGenerationId)).toEqual([first])
			expect(await received(frame)).toContainEqual(expect.objectContaining({ type: 'capability.ack', context: { previewSessionId: sessionId, runtimeGenerationId: first } }))

			// The document reloads on its own: same URL, same Preview session.
			await frame.evaluate(() => { setTimeout(() => location.reload(), 0) })
			await expect.poll(async () => { const current = await admitted(page); return !!current && current !== first }, { timeout: 15_000 }).toBe(true)
			const second = await admitted(page)
			frame = await liveFrame(page)
			expect(await iframe(page).getAttribute('src')).toBe(src)

			// The new document declared a generation of its own and got its own ACK; nothing it received
			// names the old generation.
			const declarations = (await received(page)).filter(message => message.type === 'capability.declare')
			expect(declarations.map(message => message.context.runtimeGenerationId)).toEqual([first, second])
			expect(declarations.every(message => message.context.previewSessionId === sessionId)).toBe(true)
			const afterReload = await received(frame)
			expect(afterReload.filter(message => message.type === 'capability.ack').map(message => message.context.runtimeGenerationId)).toEqual([second])
			expect(afterReload.some(message => message.context.runtimeGenerationId === first)).toBe(false)

			// Geometry is acquired again under the new generation, and the selection is drawn from it.
			await expect.poll(async () => (await received(frame)).some(message => message.type === 'geometry.acquire.request'
				&& message.context.widgetId === WIDGET_ID && message.context.runtimeGenerationId === second), { timeout: 15_000 }).toBe(true)
			await page.waitForSelector('[data-blueprint="type"]', { timeout: 15_000 })
			expect(await page.locator('[data-blueprint="type"]').textContent()).toContain(`#${WIDGET_ID}`)

			// A declaration naming the retired generation is never acknowledged. A duplicate of the
			// current declaration follows it on the same ordered channel: once its ACK arrives, the
			// Workbench has handled the retired one too.
			const current = declarations.at(-1)!
			await frame.evaluate(([retired, duplicate]) => {
				parent.postMessage({ channel: 'uiux:preview:wire', message: retired }, location.origin)
				parent.postMessage({ channel: 'uiux:preview:wire', message: duplicate }, location.origin)
			}, [{ ...current, context: { previewSessionId: sessionId, runtimeGenerationId: first } }, current] as const)
			await expect.poll(async () => (await received(frame)).filter(message => message.type === 'capability.ack' && message.context.runtimeGenerationId === second).length, { timeout: 15_000 }).toBe(2)
			expect((await received(frame)).some(message => message.context.runtimeGenerationId === first)).toBe(false)
			expect(await admitted(page)).toBe(second)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
		}
		finally { await context.close() }
	}, 90_000)
})
