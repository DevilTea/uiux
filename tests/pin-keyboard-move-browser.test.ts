import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Moving a comment pin without a pointer (issue #118; Rule 01a116f0-94a5-775a-aa3d-da41c3521555):
 * M on a focused pin starts a move, the arrow keys move it by 1 % of its Widget (Shift: 10 %),
 * Enter writes the hint once, Escape (or leaving the pin) cancels without a write, and every
 * state is announced in the polite live region.
 */

let server: WorkbenchServer
let browser: Browser

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

async function seed(): Promise<{ viewId: string; threadId: string }> {
	const spec = { intent: 'Keyboard pin move', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('/api/views', { name: 'Keyboard pin move', spec })
	const read = await api<{ revision: string }>(`/api/resources/view/${view.key}`)
	await api(`/api/views/${view.key}/structure`, {
		expectedRevision: read.revision,
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Stack', id: 'page', config: { direction: 'vertical', gap: 16, padding: 32 }, slots: { content: [
			{ type: 'Panel', id: 'card', config: { variant: 'card', padding: 16, width: '400px', height: '200px', title: 'Card' }, slots: { content: [] } },
		] } }] } },
		variants: {},
	}, 'PUT')
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: view.key, widgetId: 'card' }, displayHint: { pin: { x: 0.5, y: 0.5 } } })
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: 'Move me.' })
	return { viewId: view.key, threadId: created.key }
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
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
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	const handle = await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })
	const frame = (await handle.contentFrame())!
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return { context, page, frame }
}

type Review = { resource: { displayHint?: { pin: { x: number; y: number } } } }
const hintOf = async (threadId: string) => (await api<Review>(`/api/resources/review/${threadId}`)).resource.displayHint?.pin
const live = (page: Page) => page.locator('[role="status"][aria-live="polite"]')
/**
 * The box of an element once it has one. `boundingBox()` answers null while the element is detached or
 * not laid out, as a pin is for a moment whenever the pin layer re-renders (a live refresh after the hint
 * is written, a Preview geometry report under load): the read waits for the box instead of dereferencing
 * null (issue #263).
 */
async function boxOf(locator: Locator): Promise<{ x: number; y: number; width: number; height: number }> {
	let box: { x: number; y: number; width: number; height: number } | null = null
	await expect.poll(async () => { box = await locator.boundingBox(); return box !== null }, { timeout: 15_000 }).toBe(true)
	return box!
}
const liveText = (page: Page) =>live(page).allTextContents().then(texts => texts.join(' '))

describe('Keyboard pin move (issue #118)', () => {
	it('moves a pin with M and the arrows, writes once on Enter, and announces each state', async () => {
		const { viewId, threadId } = await seed()
		const { context, page } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			expect(await pin.getAttribute('aria-keyshortcuts')).toBe('M')
			const describedBy = (await pin.getAttribute('aria-describedby'))!
			expect(await page.locator(`#${describedBy}`).textContent()).toContain('Press M to move this pin')
			const writes: string[] = []
			page.on('request', (request) => { if (request.url().includes('/display-hint')) writes.push(request.method()) })
			const tip = async () => { const box = await boxOf(pin); return { x: box.x, y: box.y + box.height } }

			await pin.focus()
			const before = await tip()
			await page.keyboard.press('m')
			await expect.poll(() => pin.getAttribute('data-pin-moving')).toBe('')
			await expect.poll(() => liveText(page)).toContain('Moving the pin.')
			expect(await liveText(page)).toContain('50% across, 50% down the Widget.')

			// Fine step: 1 % of a 400 by 200 px Widget (scaled with the canvas); Shift: 10 %.
			await page.keyboard.press('ArrowRight')
			await page.keyboard.press('ArrowRight')
			await page.keyboard.press('Shift+ArrowDown')
			await expect.poll(() => liveText(page)).toContain('52% across, 60% down the Widget.')
			const moved = await tip()
			expect(moved.x).toBeGreaterThan(before.x)
			expect(moved.y).toBeGreaterThan(before.y)
			// Nothing is written while the move is in progress.
			expect(writes).toEqual([])
			expect((await hintOf(threadId))).toEqual({ x: 0.5, y: 0.5 })

			await page.keyboard.press('Enter')
			await expect.poll(() => hintOf(threadId)).toEqual({ x: 0.52, y: 0.6 })
			expect(writes).toHaveLength(1)
			await expect.poll(() => liveText(page)).toContain('Pin moved.')
			expect(await pin.getAttribute('data-pin-moving')).toBeNull()
			// Enter committed the move; it did not also open the thread.
			expect(await page.locator('[data-thread-bubble]').count()).toBe(0)
			const settled = await tip()
			expect(Math.abs(settled.x - moved.x)).toBeLessThan(1.5)
			expect(Math.abs(settled.y - moved.y)).toBeLessThan(1.5)
		}
		finally { await context.close() }
	}, 90_000)

	it('commits with Space without opening the thread, and writes nothing when the pin did not move', async () => {
		const { viewId, threadId } = await seed()
		const { context, page } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			const writes: string[] = []
			page.on('request', (request) => { if (request.url().includes('/display-hint')) writes.push(request.method()) })
			await pin.focus()

			await page.keyboard.press('m')
			await page.keyboard.press('ArrowLeft')
			await page.keyboard.press('Space')
			await expect.poll(() => hintOf(threadId)).toEqual({ x: 0.49, y: 0.5 })
			await page.waitForTimeout(300)
			expect(await page.locator('[data-thread-bubble]').count()).toBe(0)
			expect(writes).toHaveLength(1)

			// Back to where it started: Enter saves nothing and says so.
			await expect.poll(() => liveText(page)).toContain('Pin moved.')
			await page.keyboard.press('m')
			await page.keyboard.press('ArrowRight')
			await page.keyboard.press('ArrowLeft')
			await page.keyboard.press('Enter')
			await expect.poll(() => liveText(page)).toContain('Pin not moved.')
			expect(writes).toHaveLength(1)
		}
		finally { await context.close() }
	}, 90_000)

	it('cancels with Escape or by leaving the pin, without a write and without closing anything else', async () => {
		const { viewId, threadId } = await seed()
		const { context, page } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			const writes: string[] = []
			page.on('request', (request) => { if (request.url().includes('/display-hint')) writes.push(request.method()) })
			const tip = async () => { const box = await boxOf(pin); return { x: box.x, y: box.y + box.height } }
			await pin.focus()
			const before = await tip()

			await page.keyboard.press('m')
			await page.keyboard.press('Shift+ArrowLeft')
			await page.keyboard.press('Escape')
			await expect.poll(() => liveText(page)).toContain('Pin move canceled.')
			expect(await pin.getAttribute('data-pin-moving')).toBeNull()
			await expect.poll(async () => (await tip()).x).toBeCloseTo(before.x, 0)

			// Moving focus away cancels as well.
			await page.keyboard.press('m')
			await page.keyboard.press('ArrowUp')
			await page.keyboard.press('Tab')
			await expect.poll(() => pin.getAttribute('data-pin-moving')).toBeNull()
			await expect.poll(async () => (await tip()).y).toBeCloseTo(before.y, 0)
			expect(writes).toEqual([])
			expect(await hintOf(threadId)).toEqual({ x: 0.5, y: 0.5 })
		}
		finally { await context.close() }
	}, 90_000)
})

describe('Pointer pin move and physical hints', () => {
	it('writes a dragged pin once, when the drag ends, and never streams intermediate positions (Rule 01a11544-5c53)', async () => {
		const { viewId, threadId } = await seed()
		const { context, page } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			// Every request that could write the pin: any non-read request on the Review API.
			const writes: { method: string; url: string }[] = []
			page.on('request', (request) => {
				if (request.method() !== 'GET' && new URL(request.url()).pathname.startsWith('/api/reviews')) writes.push({ method: request.method(), url: new URL(request.url()).pathname })
			})
			const box = await boxOf(pin)
			const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
			await page.mouse.move(from.x, from.y)
			await page.mouse.down()
			// A long drag in many small moves, with pauses so that any streamed write would have been sent.
			for (let step = 1; step <= 20; step++) {
				await page.mouse.move(from.x + step * 4, from.y + step * 1.5)
				if (step % 5 === 0) await page.waitForTimeout(60)
			}
			await expect.poll(() => pin.evaluate(element => element.classList.contains('is-dragging'))).toBe(true)
			await page.waitForTimeout(300)
			// Moving, not yet released: nothing was written and the stored hint is where it was.
			expect(writes).toEqual([])
			expect(await hintOf(threadId)).toEqual({ x: 0.5, y: 0.5 })

			await page.mouse.up()
			await expect.poll(async () => (await hintOf(threadId))?.x).toBeGreaterThan(0.5)
			await page.waitForTimeout(300)
			// Exactly one write, the one at the end of the drag.
			expect(writes).toHaveLength(1)
			expect(writes[0]!.url).toBe(`/api/reviews/${threadId}/display-hint`)
		}
		finally { await context.close() }
	}, 90_000)

	it('keeps a hinted pin on the same physical side of its Widget in a right-to-left Locale (Rule 01a11544-5cec)', async () => {
		const { viewId, threadId } = await seed()
		// A hint on the left of the Widget: x is measured from its physical left edge.
		const thread = await api<{ revision: string }>(`/api/resources/review/${threadId}`)
		await api(`/api/reviews/${threadId}/display-hint`, { expectedRevision: thread.revision, displayHint: { pin: { x: 0.2, y: 0.5 } } })
		await api('/api/locales', { locale: 'ar-SA', messages: {} })
		const { context, page, frame } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			const card = frame.locator('[data-widget-id="card"]')
			// The pin's tip is the bottom-left corner of its box.
			const tipError = async () => {
				const rect = await boxOf(card)
				const pinBox = await boxOf(pin)
				return { error: Math.hypot(pinBox.x - (rect.x + 0.2 * rect.width), pinBox.y + pinBox.height - (rect.y + 0.5 * rect.height)), left: pinBox.x < rect.x + rect.width / 2 }
			}
			const cardLtr = await boxOf(card)
			expect(await tipError()).toMatchObject({ left: true })

			// The right-to-left Locale is chosen, and the Preview lays its content out right to left.
			await page.locator('[data-context="locale"]').click()
			await page.getByRole('option', { name: 'ar-SA' }).click()
			await expect.poll(() => new URL(page.url()).searchParams.get('locale')).toBe('ar-SA')
			await frame.evaluate(() => { document.documentElement.setAttribute('dir', 'rtl'); document.body.setAttribute('dir', 'rtl') })
			await expect.poll(async () => (await boxOf(card)).x, { timeout: 15_000 }).toBeGreaterThan(cardLtr.x + 50)

			// The pin follows the Widget's physical box: 20 % from its left edge, however far right the Widget now lies.
			await expect.poll(async () => (await tipError()).error, { timeout: 15_000 }).toBeLessThan(2)
			expect(await tipError()).toMatchObject({ left: true })
		}
		finally { await context.close() }
	}, 90_000)
})
