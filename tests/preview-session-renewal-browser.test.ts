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
			// The renewal may come from an API response before the stream's next `hello`; that `hello` follows.
			await expect.poll(() => page.evaluate(() => (window as unknown as { __hellos: number }).__hellos), { timeout: 30_000 }).toBeGreaterThan(hellos)
			const renewedSession = await sessionParam(page)
			expect(renewedSession).toMatch(/^session-[0-9a-f]{32}$/)
			const renewedGeneration = await expectLive(page)
			expect(renewedGeneration).not.toBe(firstGeneration)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			// The restart was told by a response and by `hello` both, and renewed the session once.
			expect(await sessionParam(page)).toBe(renewedSession)

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

/**
 * Restart detection from the `X-UIUX-Server-Instance` header of every `/api/*` response (issue
 * #317, Clause 01a175ec-c8cb-7cf3-bc94-1168ed11e3a9): a restart is detected while the Workbench
 * polls in fallback and before the page's first `hello`, not only from the stream's `hello`.
 */
describe('Preview session renewal from the server instance header (issue #317)', () => {
	/** Opens the Workbench on the View with the Widget selected, after `init` ran in the page, and waits for a live session. */
	async function openLivePage(init?: () => void): Promise<{ page: Page; session: string; close: () => Promise<void> }> {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		if (init) await context.addInitScript(init)
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		await page.goto(`${server.origin}/views/${VIEW_ID}?widget=${WIDGET_ID}`, { waitUntil: 'networkidle' })
		await expectLive(page)
		return { page, session: await sessionParam(page), close: () => context.close() }
	}
	const instanceOf = (page: Page) => page.evaluate(async () => (await fetch('/api/health', { cache: 'no-store' })).headers.get('x-uiux-server-instance'))

	it('starts a new Preview session when the server restarted while the Workbench polls in fallback', async () => {
		// No event stream at all: the Workbench polls every 15 seconds.
		const opened = await openLivePage(() => { Reflect.deleteProperty(window, 'EventSource') })
		try {
			expect(await opened.page.evaluate(() => typeof EventSource)).toBe('undefined')
			await server.restart()
			await expect.poll(() => sessionParam(opened.page), { timeout: 45_000 }).not.toBe(opened.session)
			await expectLive(opened.page)
		}
		finally { await opened.close() }
	}, 120_000)

	it('starts a new Preview session when the server restarted before the page received a first hello', async () => {
		// A stream that never connects: no `hello` ever arrives. The page's first reads seeded the instance.
		const opened = await openLivePage(() => {
			window.EventSource = class {
				static readonly CONNECTING = 0
				static readonly OPEN = 1
				static readonly CLOSED = 2
				readyState = 0
				onerror: (() => void) | null = null
				addEventListener(): void {}
				close(): void {}
			} as unknown as typeof EventSource
		})
		try {
			const before = await instanceOf(opened.page)
			expect(before).toBeTruthy()
			await server.restart()
			// The next read of any kind names the new instance, with no `hello` involved.
			expect(await instanceOf(opened.page)).not.toBe(before)
			await expect.poll(() => sessionParam(opened.page), { timeout: 30_000 }).not.toBe(opened.session)
			await expectLive(opened.page)
		}
		finally { await opened.close() }
	}, 120_000)

	it('keeps the Preview session while the server instance stays the same, and names the instance on a refusal', async () => {
		const opened = await openLivePage()
		try {
			const first = await instanceOf(opened.page)
			expect(first).toMatch(/^[0-9a-f-]{36}$/)
			for (let read = 0; read < 3; read += 1) expect(await instanceOf(opened.page)).toBe(first)
			// An authentication refusal names the instance too.
			const refused = await fetch(`${server.origin}/api/session`)
			expect(refused.status).toBe(401)
			expect(refused.headers.get('x-uiux-server-instance')).toBe(first)
			await opened.page.waitForTimeout(2000)
			expect(await sessionParam(opened.page)).toBe(opened.session)
		}
		finally { await opened.close() }
	}, 120_000)
})
