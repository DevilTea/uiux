import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Preview session renewal after a server restart (issue #101, Rule
 * 01a1161c-3b51-7ebd-bff2-987863a7c1cb) against the built Workbench: the open page learns of the
 * restart from the change-event stream's `hello`, whose `serverInstanceId` changed, and starts a new
 * Preview session with a fresh document and generation before any geometry traffic resumes.
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

const iframe = (page: Page) => page.locator('iframe[src*="/preview"]')
const sessionParam = async (page: Page) => new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session') ?? ''
const recorded = (target: Page | Frame) => target.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages)

async function previewFrame(page: Page): Promise<Frame> {
	const frame = await (await iframe(page).elementHandle())!.contentFrame()
	if (!frame) throw new Error('The Preview iframe has no document.')
	return frame
}

async function expectLive(page: Page): Promise<string> {
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 30_000 })
	return await iframe(page).getAttribute('data-runtime-generation') ?? ''
}

describe('Preview session renewal after a server restart (issue #101)', () => {
	it('starts a new Preview session, with a fresh generation and newly acquired geometry, when the server restarted', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		try {
			await context.addInitScript(() => {
				localStorage.setItem('nuxt-color-mode', 'light')
				localStorage.setItem('uiux.workbench.locale', 'en-US')
			})
			await context.addInitScript(PREVIEW_WIRE_RECORDER)
			// Counts the `hello` events the page's change-event stream receives.
			await context.addInitScript(() => {
				const Native = window.EventSource
				const scope = window as unknown as { __hellos: number }
				scope.__hellos = 0
				window.EventSource = class extends Native {
					constructor(url: string | URL, init?: EventSourceInit) {
						super(url, init)
						this.addEventListener('hello', () => { scope.__hellos += 1 })
					}
				}
			})
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			await page.goto(`${server.origin}/views/${VIEW_ID}?widget=${WIDGET_ID}`, { waitUntil: 'networkidle' })

			const firstGeneration = await expectLive(page)
			const firstSession = await sessionParam(page)
			expect(firstSession).toMatch(/^session-[0-9a-f]{32}$/)
			// The change-event stream delivered its first `hello`, so the next one names the restarted server.
			await page.waitForFunction(() => (window as unknown as { __hellos: number }).__hellos > 0, undefined, { timeout: 15_000 })
			const hellos = await page.evaluate(() => (window as unknown as { __hellos: number }).__hellos)

			await server.restart()

			// The page reconnects and starts a new session under a fresh ID, with a fresh document.
			await expect.poll(() => sessionParam(page), { timeout: 30_000 }).not.toBe(firstSession)
			expect(await page.evaluate(() => (window as unknown as { __hellos: number }).__hellos)).toBeGreaterThan(hellos)
			const renewedSession = await sessionParam(page)
			expect(renewedSession).toMatch(/^session-[0-9a-f]{32}$/)
			const renewedGeneration = await expectLive(page)
			expect(renewedGeneration).not.toBe(firstGeneration)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)

			// The new document's first protocol message is its ACK; every geometry request it receives
			// belongs to the new session and generation, and the selection's geometry is acquired anew.
			const frame = await previewFrame(page)
			await expect.poll(async () => (await recorded(frame)).some(message => message.type === 'geometry.acquire.request' && message.context.widgetId === WIDGET_ID), { timeout: 15_000 }).toBe(true)
			const inbound = await recorded(frame)
			const protocol = inbound.filter(message => message.type.startsWith('capability.') || message.type.startsWith('geometry.'))
			expect(protocol[0]).toMatchObject({ type: 'capability.ack', context: { previewSessionId: renewedSession, runtimeGenerationId: renewedGeneration } })
			const requests = protocol.filter(message => message.type === 'geometry.acquire.request')
			for (const request of requests) expect(request.context).toMatchObject({ previewSessionId: renewedSession, runtimeGenerationId: renewedGeneration })

			// The Workbench receives the selection's geometry again, under the new session.
			const renewedReport = (message: WireRecord) => message.type === 'geometry.acquire.response'
				&& message.context.previewSessionId === renewedSession && message.context.widgetId === WIDGET_ID
			await expect.poll(async () => (await recorded(page)).some(renewedReport), { timeout: 15_000 }).toBe(true)
			expect(new URL(page.url()).searchParams.get('widget')).toBe(WIDGET_ID)
		}
		finally { await context.close() }
	}, 120_000)
})
