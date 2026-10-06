import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { provisionToken, bearer } from './support/access'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'
import { MAIN_THREAD_WORK, binFrames, percentile, type MainThreadWorkWindow } from './support/main-thread-work'
import { ENFORCE_PERF_BUDGETS } from './support/perf-budgets'

/**
 * R7b: every pin at once (multi-target geometry decision group, decisions 6–9; brief c §6–11).
 *
 * A private Workspace copy gets a "Pin stress" View three viewports tall (24 cards of a Text and a
 * Button, 72 Widgets in all) and 50 threads on 42 of its Widgets from four authors, authored only
 * through the Review and View APIs. The checks cover clusters and per-side edge indicators with
 * their menus, the pin filter and Shift C on the canvas, the J / K keyboard path, pins that follow
 * their Widgets while the View scrolls, the over-cap listing, and the frame budget.
 *
 * The budget run scrolls the View continuously and bins main-thread work per Workbench frame. It
 * measures the desktop column on the machine that runs it and enforces it with
 * `UIUX_PERF_BUDGETS=1` (`pnpm perf`); `PIN_PERF_THROTTLE=1,2,4` adds CPU throttling (Chrome
 * DevTools Protocol) to approximate the weaker reference devices, and `PIN_PERF_REPORT=<dir>`
 * writes the numbers as JSON.
 */

const VIEW_ID = 'a7b00000-0000-4000-8000-000000000050'
const SCROLL_FRAMES = 240
/**
 * Decision 9, desktop column (the mainstream Windows laptop): Workbench pin work p95 and pin tracking
 * p99, in ms, and at most 1 % dropped frames. These hold for the reference devices, not shared CI
 * runners: they are enforced only with `UIUX_PERF_BUDGETS=1` (`pnpm perf`). The default run prints the
 * measurements and gates on the speed-independent checks (idle, pins on their Widgets, reports per frame).
 */
const DESKTOP_BUDGET = { pinWorkP95: 2, combinedP99: 8, droppedFrameShare: 0.01 } as const

let server: WorkbenchServer
let browser: Browser
const authors: Record<string, Record<string, string>> = {}
/** Thread ids in creation order, with their Widget and whether they carry a display hint. */
const seeded: { id: string; widgetId: string; hinted: boolean; resolved: boolean }[] = []

async function api<T>(path: string, body: unknown, headers: Record<string, string> = server.headers, method = 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

/** Adds threads through the Review API, as different authors (never by hand). */
async function seedThreads(widgetIds: readonly string[], options: Readonly<{ hintEvery?: number }> = {}): Promise<void> {
	const names = Object.keys(authors)
	for (const widgetId of widgetIds) {
		const index = seeded.length
		const hinted = options.hintEvery !== undefined && index % options.hintEvery === 1
		const who = authors[names[index % names.length]!]!
		const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId }, ...(hinted ? { displayHint: { pin: { x: 0.25, y: 0.5 } } } : {}) }, who)
		await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: `Comment ${index + 1} on #${widgetId}: check the spacing and the copy.` }, who)
		seeded.push({ id: created.key, widgetId, hinted, resolved: false })
	}
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	for (const [nickname, kind, role] of [['mei', 'human', 'reviewer'], ['jun', 'human', 'reviewer'], ['claude', 'agent', 'editor']] as const)
		authors[nickname] = bearer(await provisionToken(server.workspaceRoot, { nickname, kind, role }))
	authors.tester = { ...server.headers }

	await api('/api/views', { id: VIEW_ID, name: 'Pin stress', spec: { intent: 'Fifty comment threads across forty-two Widgets, three viewports tall.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] } })
	const cards = Array.from({ length: 24 }, (_, index) => ({
		type: 'Panel',
		id: `card-${index}`,
		config: { variant: 'card', padding: 16, width: '46%', height: '232px', title: `Section ${index + 1}` },
		slots: { content: [
			{ type: 'Text', id: `text-${index}`, config: { text: `Body copy for section ${index + 1}. It wraps to a second line so the card keeps some height.` } },
			{ type: 'Button', id: `button-${index}`, config: { label: `Action ${index + 1}`, size: 'sm', variant: index % 3 ? 'secondary' : 'primary' } },
		] },
	}))
	const ir = { type: 'RootShell', id: 'root', slots: { content: [
		{ type: 'Stack', id: 'page', config: { direction: 'vertical', gap: 16, padding: 24, surface: 'app' }, slots: { content: [
			{ type: 'Text', id: 'page-title', config: { text: 'Pin stress', variant: 'h2', weight: 'bold' } },
			{ type: 'Stack', id: 'grid', config: { direction: 'horizontal', gap: 16, wrap: true }, slots: { content: cards } },
		] } },
	] } }
	const read = await api<{ revision: string }>(`/api/resources/view/${VIEW_ID}`, undefined, server.headers, 'GET')
	await api(`/api/views/${VIEW_ID}/structure`, { expectedRevision: read.revision, ir, variants: {} }, server.headers, 'PUT')

	// 50 threads on 42 Widgets: the card, Text and Button of sections 1–14, and a second thread on 8 of them.
	const widgets = Array.from({ length: 14 }, (_, index) => [`card-${index}`, `text-${index}`, `button-${index}`]).flat()
	await seedThreads([...widgets, ...Array.from({ length: 8 }, (_, index) => widgets[index * 5]!)], { hintEvery: 3 })
	// Four are resolved: the default filter (open + ready) keeps them off the canvas.
	for (const thread of seeded.slice(44, 48)) {
		const current = await api<{ revision: string }>(`/api/resources/review/${thread.id}`, undefined, server.headers, 'GET')
		await api(`/api/reviews/${thread.id}/resolve`, { expectedRevision: current.revision, resolution: 'answered' })
		thread.resolved = true
	}
}, 120_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function openView(setup: Readonly<{ width?: number; height?: number; recordWire?: boolean; instrument?: boolean }> = {}): Promise<{ context: BrowserContext; page: Page; frame: Frame }> {
	const context = await browser.newContext({ viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	if (setup.recordWire) await context.addInitScript(PREVIEW_WIRE_RECORDER)
	if (setup.instrument) await context.addInitScript(MAIN_THREAD_WORK)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/views/${VIEW_ID}`, { waitUntil: 'networkidle' })
	const handle = await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })
	const frame = (await handle.contentFrame())!
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	await page.waitForSelector('[data-comment-pins] .pin-anchor:not([hidden]) [data-pin-thread]', { timeout: 15_000 })
	await page.mouse.move(2, 600)
	return { context, page, frame }
}

type CanvasPins = Readonly<{ drawn: string[]; clustered: string[][]; edges: Record<string, string[]> }>

/** What the pin layer draws: single pins, clusters (their threads) and edge indicators per side. */
async function canvasPins(page: Page): Promise<CanvasPins> {
	return page.evaluate(() => {
		const layer = document.querySelector('[data-comment-pins]')
		if (!layer) return { drawn: [], clustered: [], edges: {} }
		const drawn = [...layer.querySelectorAll<HTMLElement>('.pin-anchor:not([hidden]) [data-pin-thread]')].map(pin => pin.dataset.pinThread!).filter(id => id !== 'pending')
		const clustered = [...layer.querySelectorAll<HTMLElement>('[data-pin-cluster-threads]')].map(cluster => cluster.dataset.pinClusterThreads!.split(' '))
		const edges: Record<string, string[]> = {}
		for (const edge of layer.querySelectorAll<HTMLElement>('[data-edge-side]')) edges[edge.dataset.edgeSide!] = edge.dataset.edgeThreads!.split(' ')
		return { drawn, clustered, edges }
	})
}

/** Settles: no geometry report for a few frames. */
async function settle(page: Page): Promise<void> {
	await page.waitForTimeout(400)
}

/** The screen point of an inner-viewport point of the Preview (the frame scales; the iframe keeps its logical size). */
async function screenPoint(page: Page, frame: Frame, inner: { x: number; y: number }) {
	const box = (await page.locator('iframe[src*="/preview"]').boundingBox())!
	const width = await frame.evaluate(() => window.innerWidth)
	const scale = box.width / width
	return { x: box.x + inner.x * scale, y: box.y + inner.y * scale }
}

/** Hinted pins sit at 25 % / 50 % of their Widget: check each drawn one against the live DOM. */
async function hintedPinErrors(page: Page, frame: Frame): Promise<number[]> {
	const { drawn } = await canvasPins(page)
	const errors: number[] = []
	for (const thread of seeded.filter(item => item.hinted && drawn.includes(item.id))) {
		const rect = await frame.evaluate(id => {
			const box = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
			return { x: box.x, y: box.y, width: box.width, height: box.height }
		}, thread.widgetId)
		const expected = await screenPoint(page, frame, { x: rect.x + 0.25 * rect.width, y: rect.y + 0.5 * rect.height })
		const box = (await page.locator(`[data-pin-thread="${thread.id}"]`).boundingBox())!
		errors.push(Math.hypot(box.x - expected.x, box.y + box.height - expected.y))
	}
	return errors
}

describe('All pins at once (R7b)', () => {
	it('accounts for every in-filter thread as a pin, a cluster member or an edge indicator, and keeps pins on their Widgets while the View scrolls', async () => {
		const { context, page, frame } = await openView()
		try {
			await settle(page)
			const open = seeded.filter(thread => !thread.resolved).map(thread => thread.id).sort()
			const first = await canvasPins(page)
			const accounted = [...first.drawn, ...first.clustered.flat(), ...Object.values(first.edges).flat()]
			expect([...accounted].sort()).toEqual(open)
			expect(new Set(accounted).size).toBe(accounted.length)
			// The View is three viewports tall: the lower sections sit behind one aggregated bottom indicator with a count.
			expect(first.edges.bottom?.length).toBeGreaterThan(5)
			expect(await page.locator('[data-edge-side="bottom"]').textContent()).toContain(String(first.edges.bottom!.length))
			expect(first.drawn.length).toBeGreaterThan(15)
			// Resolved threads are hidden by the default filter.
			expect(accounted.filter(id => seeded.find(thread => thread.id === id)?.resolved)).toEqual([])
			for (const error of await hintedPinErrors(page, frame)) expect(error).toBeLessThan(2)

			// Scroll the View: pins follow their Widgets from current reports, and the indicators trade sides.
			await frame.evaluate(() => window.scrollTo(0, 1200))
			await settle(page)
			const scrolled = await canvasPins(page)
			// A Widget cut by the viewport edge can hide its pin point (decision 7: no clamping); the list says so.
			const pointHidden = await page.locator('[data-comment-row][data-comment-canvas="hidden"]').evaluateAll(rows => rows.map(row => row.getAttribute('data-comment-row')!))
			expect([...scrolled.drawn, ...scrolled.clustered.flat(), ...Object.values(scrolled.edges).flat(), ...pointHidden].sort()).toEqual(open)
			expect(scrolled.edges.top?.length).toBeGreaterThan(5)
			const errors = await hintedPinErrors(page, frame)
			expect(errors.length).toBeGreaterThan(0)
			for (const error of errors) expect(error).toBeLessThan(2)
			// A pin is never drawn for a Widget wholly outside the content viewport.
			const outside = await frame.evaluate((ids) => ids.filter((id) => {
				const box = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
				return box.bottom <= 0 || box.top >= window.innerHeight
			}), seeded.filter(thread => scrolled.drawn.includes(thread.id)).map(thread => thread.widgetId))
			expect(outside).toEqual([])
		}
		finally { await context.close() }
	}, 90_000)

	it('opens a cluster or an edge indicator as a menu of its threads; a pick opens the bubble on that thread\'s own pin', async () => {
		const { context, page } = await openView()
		try {
			await settle(page)
			const { clustered, edges } = await canvasPins(page)
			expect(clustered.length).toBeGreaterThan(0)
			const cluster = clustered[0]!
			await page.locator(`[data-pin-cluster-threads="${cluster.join(' ')}"]`).click()
			const menu = page.getByRole('menu')
			await menu.waitFor()
			expect(await menu.getByRole('menuitem').count()).toBe(cluster.length)
			expect(await menu.textContent()).toContain(`${cluster.length} comments here`)
			await menu.getByRole('menuitem').first().click()
			await page.waitForSelector('[data-thread-bubble]')
			// The open thread leaves the cluster and is drawn on its own, with focus on it.
			await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-pin-thread'))).toBe(cluster[0])
			await page.keyboard.press('Escape')
			await expect.poll(() => page.locator('[data-thread-bubble]').count()).toBe(0)

			const bottom = edges.bottom!
			await page.locator('[data-edge-side="bottom"]').click()
			await menu.waitFor()
			expect(await menu.getByRole('menuitem').count()).toBe(bottom.length)
			expect(await menu.textContent()).toContain(`${bottom.length} comments below, out of view`)
			await page.keyboard.press('Escape')
			await expect.poll(() => menu.count()).toBe(0)
			await page.locator('[data-edge-side="bottom"]').click()
			await menu.getByRole('menuitem').nth(1).click()
			await page.waitForSelector('[data-thread-bubble]')
			expect(await page.locator('[data-thread-placement]').textContent()).toContain('Scrolled out of view')
		}
		finally { await context.close() }
	}, 60_000)

	it('applies the pin filter and Shift C to the canvas, releasing streams; J and K cycle the pins in reading order', async () => {
		const { context, page, frame } = await openView({ recordWire: true })
		try {
			await settle(page)
			const before = await canvasPins(page)
			// Open off: no open thread is tracked or drawn, and every pin stream is released.
			await page.locator('[data-comment-filter="open"]').click()
			await expect.poll(async () => (await canvasPins(page)).drawn.length).toBe(0)
			expect(Object.keys((await canvasPins(page)).edges)).toEqual([])
			await expect.poll(() => frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type === 'geometry.release').length)).toBeGreaterThanOrEqual(42)
			await page.locator('[data-comment-filter="open"]').click()
			await expect.poll(async () => (await canvasPins(page)).drawn.length).toBe(before.drawn.length)

			// Shift C hides the layer (the toggle says so) and shows it again.
			await page.keyboard.press('Shift+C')
			await expect.poll(async () => (await canvasPins(page)).drawn.length).toBe(0)
			expect(await page.locator('[data-pins-toggle]').getAttribute('aria-pressed')).toBe('false')
			await page.locator('[data-pins-toggle]').click()
			await expect.poll(async () => (await canvasPins(page)).drawn.length).toBe(before.drawn.length)

			// Tab reaches the pins in reading order; J opens the next one and moves focus to it, K goes back.
			const order = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[data-comment-pins] .pin-anchor:not([hidden]) :is([data-pin-thread], [data-pin-cluster])')]
				.map((pin) => { const box = pin.getBoundingClientRect(); return { id: pin.dataset.pinThread ?? pin.dataset.pinClusterThreads!.split(' ')[0]!, x: box.left, y: box.bottom } }))
			for (let index = 1; index < order.length; index++) {
				const [a, b] = [order[index - 1]!, order[index]!]
				expect(b.y - a.y > -4 && (Math.abs(b.y - a.y) > 4 || b.x >= a.x), `${a.id} before ${b.id}`).toBe(true)
			}
			const firstPin = page.locator('[data-comment-pins] .pin-anchor:not([hidden]) [data-pin-thread]').first()
			const firstId = await firstPin.getAttribute('data-pin-thread')
			await firstPin.focus()
			await page.keyboard.press('j')
			await page.waitForSelector('[data-thread-bubble]')
			const next = await page.evaluate(() => document.activeElement?.getAttribute('data-pin-thread'))
			expect(next).toBeTruthy()
			expect(next).not.toBe(firstId)
			// The URL follows the open thread through `router.replace`, which lands a few tasks after the bubble and the focus.
			await expect.poll(() => new URL(page.url()).searchParams.get('thread')).toBe(next)
			await page.keyboard.press('k')
			await expect.poll(() => new URL(page.url()).searchParams.get('thread')).toBe(firstId)
			await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-pin-thread'))).toBe(firstId)
			// J then K before J's replace lands: that replace must not land late and reopen the thread just left.
			await page.evaluate(() => {
				const win = window as unknown as { __settledThreads: (string | null)[] }
				win.__settledThreads = []
				const app = (document.querySelector('[data-v-app]') as unknown as { __vue_app__: { config: { globalProperties: { $router: { afterEach: (hook: (to: { query: Record<string, unknown> }) => void) => void } } } } }).__vue_app__
				app.config.globalProperties.$router.afterEach((to) => { win.__settledThreads.push(typeof to.query.thread === 'string' ? to.query.thread : null) })
			})
			await page.keyboard.press('j')
			await page.keyboard.press('k')
			// Every navigation reports to `afterEach` when it settles (committed, cancelled or a duplicate).
			await expect.poll(() => page.evaluate(() => (window as unknown as { __settledThreads: (string | null)[] }).__settledThreads)).toContain(next)
			expect(new URL(page.url()).searchParams.get('thread')).toBe(firstId)
			await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-pin-thread'))).toBe(firstId)
			// Enter on the open thread's pin moves into its conversation; Escape closes it and returns to the pin.
			await page.keyboard.press('Enter')
			await expect.poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-thread-reply'))).toBe(true)
			await page.keyboard.press('Escape')
			await expect.poll(() => page.locator('[data-thread-bubble]').count()).toBe(0)
			await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-pin-thread'))).toBe(firstId)
		}
		finally { await context.close() }
	}, 60_000)

	it('scrolls 50 pins on 42 Widgets: one coalesced update per frame, transforms only, pins on their Widgets, idle when still (frame budget with UIUX_PERF_BUDGETS=1)', async () => {
		const throttles = (process.env.PIN_PERF_THROTTLE ?? '1').split(',').map(Number).filter(rate => rate >= 1)
		const results: Record<string, unknown>[] = []
		for (const throttle of throttles) {
			const { context, page, frame } = await openView({ instrument: true })
			try {
				const cdp = await context.newCDPSession(page)
				if (throttle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle })
				await settle(page)
				const pinCount = (await canvasPins(page)).drawn.length
				// Workbench frame marks, then a continuous scroll down and back up, one step per Preview frame.
				await page.evaluate(() => {
					const win = window as unknown as MainThreadWorkWindow & { __marks: number[]; __marking: boolean }
					win.__marks = []
					win.__marking = true
					const mark = () => {
						win.__marks.push(performance.timeOrigin + performance.now())
						if (win.__marking) win.__rawRequestAnimationFrame(mark)
					}
					win.__rawRequestAnimationFrame(mark)
					win.__work.length = 0
				})
				await frame.evaluate(() => { (window as unknown as MainThreadWorkWindow).__work.length = 0 })
				await frame.evaluate(frames => new Promise<void>((resolve) => {
					const win = window as unknown as MainThreadWorkWindow
					let step = 0
					const scroll = () => {
						step++
						window.scrollTo(0, step <= frames / 2 ? step * 10 : (frames - step) * 10)
						if (step < frames) win.__rawRequestAnimationFrame(scroll)
						else resolve()
					}
					win.__rawRequestAnimationFrame(scroll)
				}), SCROLL_FRAMES)
				await page.waitForTimeout(200)
				const marks = await page.evaluate(() => {
					const win = window as unknown as { __marks: number[]; __marking: boolean }
					win.__marking = false
					return win.__marks
				})
				const workbench = await page.evaluate(() => (window as unknown as MainThreadWorkWindow).__work)
				const runtime = await frame.evaluate(() => (window as unknown as MainThreadWorkWindow).__work)
				const frames = binFrames(marks, workbench, runtime)
				const vsync = percentile(frames.intervals, 0.5)
				const dropped = frames.intervals.filter(interval => interval > vsync * 1.5).length
				// Geometry reports the Workbench received per Workbench frame (the runtime coalesces a frame's reports into one message).
				const messagesPerFrame = marks.slice(1).map((end, index) => workbench.filter(([start, , kind]) => kind === 'message' && start >= marks[index]! && start < end).length)

				// Idle: with pins shown and nothing changing, no animation frames run and no reports arrive.
				const idleStart = { workbench: await page.evaluate(() => (window as unknown as MainThreadWorkWindow).__work.length), runtime: await frame.evaluate(() => (window as unknown as MainThreadWorkWindow).__work.length) }
				await page.waitForTimeout(1000)
				const idle = {
					workbench: await page.evaluate(() => (window as unknown as MainThreadWorkWindow).__work.length) - idleStart.workbench,
					runtime: await frame.evaluate(() => (window as unknown as MainThreadWorkWindow).__work.length) - idleStart.runtime,
				}

				const round = (value: number) => Math.round(value * 100) / 100
				const stats = (values: readonly number[]) => ({ p50: round(percentile(values, 0.5)), p95: round(percentile(values, 0.95)), p99: round(percentile(values, 0.99)), max: round(Math.max(...values)) })
				const result = {
					throttle,
					frames: frames.intervals.length,
					pins: pinCount,
					frameInterval: stats(frames.intervals),
					droppedFrames: dropped,
					pinWork: stats(frames.pinWork),
					messages: stats(frames.messages),
					messagesPerFrame: stats(messagesPerFrame),
					runtime: stats(frames.runtime),
					combined: stats(frames.combined),
					idle,
				}
				results.push(result)
				console.info(`[pins perf] ${JSON.stringify(result)}`)

				expect(frames.intervals.length).toBeGreaterThan(SCROLL_FRAMES * 0.9)
				expect(idle).toEqual({ workbench: 0, runtime: 0 })
				// Coalesced: no more report messages than frames (one per stream per frame would be dozens per frame).
				expect(messagesPerFrame.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(frames.intervals.length)
				// Back at the top after the scroll: every hinted pin sits on its Widget's current geometry.
				const errors = await hintedPinErrors(page, frame)
				expect(errors.length).toBeGreaterThan(0)
				for (const error of errors) expect(error).toBeLessThan(2)
				if (ENFORCE_PERF_BUDGETS && throttle === 1) {
					expect(dropped).toBeLessThanOrEqual(Math.ceil(frames.intervals.length * DESKTOP_BUDGET.droppedFrameShare))
					expect(percentile(frames.pinWork, 0.95)).toBeLessThanOrEqual(DESKTOP_BUDGET.pinWorkP95)
					expect(percentile(frames.combined, 0.99)).toBeLessThanOrEqual(DESKTOP_BUDGET.combinedP99)
				}
			}
			finally { await context.close() }
		}
		if (process.env.PIN_PERF_REPORT) {
			await mkdir(process.env.PIN_PERF_REPORT, { recursive: true })
			await writeFile(join(process.env.PIN_PERF_REPORT, 'pins-perf.json'), `${JSON.stringify(results, null, 2)}\n`)
		}
	}, 600_000)

	it('lists threads beyond the 64-Widget cap as "not shown on canvas" and draws no pin for them', async () => {
		// 30 more threads on the remaining sections: 72 Widgets with threads, 8 more than the cap.
		const more = Array.from({ length: 10 }, (_, index) => [`card-${index + 14}`, `text-${index + 14}`, `button-${index + 14}`]).flat()
		await seedThreads(more)
		const { context, page } = await openView()
		try {
			await settle(page)
			const chip = page.locator('[data-pins-overcap]')
			await chip.waitFor({ timeout: 15_000 })
			const count = Number((await chip.textContent())!.match(/\d+/)![0])
			expect(count).toBeGreaterThanOrEqual(8)
			await chip.click()
			const group = page.locator('[data-comment-group="overcap"]')
			await group.waitFor()
			expect(await group.locator('[data-comment-row]').count()).toBe(count)
			expect(await group.locator('[data-comment-overcap-hint]').textContent()).toContain('64 Widgets')
			const listed = await group.locator('[data-comment-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-comment-row')!))
			const { drawn, clustered, edges } = await canvasPins(page)
			const onCanvas = new Set([...drawn, ...clustered.flat(), ...Object.values(edges).flat()])
			expect(listed.filter(id => onCanvas.has(id))).toEqual([])
			// Focus moved to the first listed thread.
			await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-comment-row'))).toBe(listed[0])
		}
		finally { await context.close() }
	}, 120_000)
})
