import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
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
const liveText = (page: Page) => live(page).allTextContents().then(texts => texts.join(' '))

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
			const tip = async () => { const box = (await pin.boundingBox())!; return { x: box.x, y: box.y + box.height } }

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

	it('cancels with Escape or by leaving the pin, without a write and without closing anything else', async () => {
		const { viewId, threadId } = await seed()
		const { context, page } = await open(`/views/${viewId}`)
		try {
			const pin = page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
			await pin.waitFor({ timeout: 15_000 })
			const writes: string[] = []
			page.on('request', (request) => { if (request.url().includes('/display-hint')) writes.push(request.method()) })
			const tip = async () => { const box = (await pin.boundingBox())!; return { x: box.x, y: box.y + box.height } }
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
