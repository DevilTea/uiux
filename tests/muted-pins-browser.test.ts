import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Muted pins and bubbles (Part 7, issue #144) against the built Workbench and a private copy of the
 * frozen fixture Workspace (Locale files en-US and zh-TW; viewports desktop, tablet and mobile;
 * themes dark and light):
 *
 * - a thread recorded in another render context keeps its pin, muted and labeled with that context
 *   (Rule 01a1170f-c1ae), with the context in its accessible name (Rule 01a1170f-c352); members it
 *   does not record never mute it, and a thread without a record is never muted (Rule 01a1170f-c23d);
 * - activating it switches the Preview to the recorded members only and opens the thread, keeping
 *   the Variant and the chrome (Rule 01a1170f-c1f7, Scenario 01a11e0e-44bc; Rule 01a118a1-9e11), and
 *   "Open in current context" brings the reader's context back (Rule 01a1170f-c11d);
 * - muting never shows a hidden pin and never moves one (Rule 01a1170f-c282); a cluster is muted
 *   only when all its pins are (Rule 01a11e0d-d4a0);
 * - a recorded viewport removed after the page loaded falls back to the default with a notice when
 *   the pin is activated (Rule 01a1170f-c165; owner ruling 2026-10-09, Discussion #7).
 *
 * Each test creates its own View and threads through the Review API, so they run in any order.
 */

let server: WorkbenchServer
let browser: Browser

type ReviewRead = { revision: string; resource: { renderContext?: Record<string, string> } }
type WorkspaceRead = { revision: string; resource: Record<string, unknown> & { viewports: Record<string, unknown> } }

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

/** A View of three Buttons spaced well apart (so their pins never cluster), with an `error` Variant. */
async function seedView(name: string): Promise<string> {
	const spec = { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('/api/views', { name, spec })
	const read = await api<{ revision: string }>(`/api/resources/view/${view.key}`)
	const buttons = ['first', 'second', 'third'].map(id => ({ type: 'Button', id, config: { label: `The ${id} action` } }))
	await api(`/api/views/${view.key}/structure`, {
		expectedRevision: read.revision,
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Stack', id: 'page', config: { direction: 'vertical', gap: 64, padding: 32 }, slots: { content: buttons } }] } },
		variants: { error: { state: {} } },
	}, 'PUT')
	return view.key
}

type Seed = Readonly<{ widgetId: string; body: string; renderContext?: Record<string, string>; variantNames?: string[]; displayHint?: unknown }>
/** A Widget thread with its first message, created through the Review API. */
async function seedThread(viewId: string, seed: Seed): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', {
		anchor: { viewId, widgetId: seed.widgetId },
		...(seed.renderContext ? { renderContext: seed.renderContext } : {}),
		...(seed.variantNames ? { variantNames: seed.variantNames } : {}),
		...(seed.displayHint ? { displayHint: seed.displayHint } : {}),
	})
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: seed.body })
	return created.key
}

/** Replaces the manifest's viewports through Workspace settings (the Settings page's operation). */
async function setViewports(edit: (viewports: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
	const workspace = await api<WorkspaceRead>('/api/resources/workspace/workspace')
	const { i18n, adapters, themes } = workspace.resource
	await api('/api/workspace/settings', { expectedRevision: workspace.revision, settings: { i18n, adapters, viewports: edit(workspace.resource.viewports), themes } }, 'PUT')
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

/** A desktop browser whose Workbench chrome is en-US and light, whatever the Preview shows. */
async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function livePreview(page: Page, viewId: string): Promise<Frame> {
	const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${viewId}"]`, { timeout: 15_000 })
	const frame = (await handle.contentFrame())!
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return frame
}

/** The chrome's own language and theme, which a thread's context must never touch (Rule 01a118a1-9e11). */
async function chrome(page: Page) {
	return await page.evaluate(() => ({
		lang: document.documentElement.lang,
		dark: document.documentElement.classList.contains('dark'),
		savedLocale: localStorage.getItem('uiux.workbench.locale'),
		savedMode: localStorage.getItem('nuxt-color-mode'),
	}))
}
const LIGHT_EN_US = { lang: 'en-US', dark: false, savedLocale: 'en-US', savedMode: 'light' }

const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)
const previewWidth = (frame: Frame) => frame.evaluate(() => window.innerWidth)
const previewTitle = (page: Page) => page.locator('iframe[src*="/preview"]').getAttribute('title')
const pin = (page: Page, threadId: string) => page.locator(`[data-comment-pins] [data-pin-thread="${threadId}"]`)
/** Whether the thread's pin is drawn: mounted, and its anchor not `hidden`. */
const drawn = (page: Page, threadId: string) => page.evaluate((id) => {
	const element = document.querySelector(`[data-comment-pins] [data-pin-thread="${CSS.escape(id)}"]`)
	return !!element && !element.closest('[hidden]')
}, threadId)
const muted = (page: Page, threadId: string) => pin(page, threadId).evaluate(element => element.hasAttribute('data-pin-muted'))
/** The pin tip's anchor position as the layer wrote it (overlay px). */
const anchorTransform = (page: Page, selector: string) => page.locator(selector).evaluate(element => (element.closest('.pin-anchor') as HTMLElement).style.transform)

describe('Muted pins and bubbles (Part 7)', () => {
	it('mutes only a pin whose recorded members differ, labeled with that context in its text and accessible name', async () => {
		const viewId = await seedView('Muted labels')
		const other = await seedThread(viewId, { widgetId: 'first', body: 'Recorded in zh-TW and dark.', renderContext: { locale: 'zh-TW', themeId: 'dark' } })
		const unrecorded = await seedThread(viewId, { widgetId: 'second', body: 'No render context recorded.' })
		const same = await seedThread(viewId, { widgetId: 'third', body: 'Recorded on mobile only.', renderContext: { viewportId: 'mobile' } })
		const { context, page } = await open(`/views/${viewId}?locale=en-US&viewport=mobile&theme=dark`)
		try {
			await livePreview(page, viewId)
			for (const id of [other, unrecorded, same]) await expect.poll(() => drawn(page, id), { timeout: 15_000 }).toBe(true)
			// Differs in its recorded Locale (its theme matches): muted, never hidden.
			expect(await muted(page, other)).toBe(true)
			expect(await pin(page, other).locator('[data-pin-context]').textContent()).toBe('zh-TW · dark')
			expect(await pin(page, other).getAttribute('aria-label')).toContain('recorded in another Preview context: zh-TW · dark')
			await expect.poll(() => pin(page, other).isVisible()).toBe(true)
			// No record, and a record whose only member matches: not muted, no label.
			expect(await muted(page, unrecorded)).toBe(false)
			expect(await muted(page, same)).toBe(false)
			expect(await pin(page, same).locator('[data-pin-context]').count()).toBe(0)
			expect(await pin(page, same).getAttribute('aria-label')).not.toContain('Preview context')

			// The bubble of a muted thread opened from the Comments list says so and offers the recorded context.
			await page.locator(`[data-comment-row="${other}"]`).click()
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor()
			expect(await bubble.getAttribute('data-thread-muted')).toBe('')
			expect(await bubble.locator('[data-thread-muted-note]').textContent()).toBe('Recorded in another Preview context')
			expect(await bubble.locator('[data-thread-open-recorded]').count()).toBe(1)
			// Opening it from the list switched nothing.
			expect(query(page)).toMatchObject({ locale: 'en-US', viewport: 'mobile', theme: 'dark' })
		}
		finally { await context.close() }
	}, 90_000)

	it('activating a muted pin switches the Preview to the recorded members only and opens the thread; "Open in current context" brings the reader\'s back', async () => {
		// Scenario 01a11e0e-44bc: the thread records only the Locale zh-TW.
		const viewId = await seedView('Muted activation')
		const threadId = await seedThread(viewId, { widgetId: 'second', body: 'The label is cut off in zh-TW.', renderContext: { locale: 'zh-TW' } })
		const { context, page } = await open(`/views/${viewId}?variant=error&locale=en-US&viewport=mobile&theme=dark`)
		try {
			const frame = await livePreview(page, viewId)
			expect(await previewWidth(frame)).toBe(390)
			await expect.poll(() => drawn(page, threadId), { timeout: 15_000 }).toBe(true)
			expect(await muted(page, threadId)).toBe(true)

			await pin(page, threadId).click()
			// zh-TW in the same Variant, the mobile viewport and the dark theme; the thread open.
			await expect.poll(() => query(page)).toMatchObject({ variant: 'error', locale: 'zh-TW', viewport: 'mobile', theme: 'dark', thread: threadId })
			await expect.poll(() => previewTitle(page)).toContain('zh-TW')
			expect(await previewWidth(frame)).toBe(390)
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor()
			expect(await bubble.getAttribute('data-thread-muted')).toBeNull()
			await expect.poll(() => muted(page, threadId)).toBe(false)
			// The chrome keeps its language and theme.
			expect(await chrome(page)).toEqual(LIGHT_EN_US)

			// "Open in current context": the reader's own context, the thread still open, the pin muted again.
			await bubble.locator('[data-thread-open-current]').click()
			await expect.poll(() => query(page)).toMatchObject({ variant: 'error', locale: 'en-US', viewport: 'mobile', theme: 'dark', thread: threadId })
			await expect.poll(() => previewTitle(page)).toContain('en-US')
			await expect.poll(() => muted(page, threadId)).toBe(true)
			await expect.poll(() => bubble.getAttribute('data-thread-muted')).toBe('')
			expect(await bubble.locator('[data-thread-open-current]').count()).toBe(0)
			expect(await chrome(page)).toEqual(LIGHT_EN_US)
			// The thread still records its own context.
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual({ locale: 'zh-TW' })
		}
		finally { await context.close() }
	}, 90_000)

	it('never shows a pin another rule hides: another Variant\'s thread, a resolved thread and hidden pins stay hidden', async () => {
		const viewId = await seedView('Muted hidden')
		const visibleId = await seedThread(viewId, { widgetId: 'first', body: 'Muted and visible.', renderContext: { locale: 'zh-TW' } })
		const otherVariant = await seedThread(viewId, { widgetId: 'second', body: 'Only in the error Variant.', renderContext: { locale: 'zh-TW' }, variantNames: ['error'] })
		const resolvedId = await seedThread(viewId, { widgetId: 'third', body: 'Resolved already.', renderContext: { locale: 'zh-TW' } })
		const current = await api<{ revision: string }>(`/api/resources/review/${resolvedId}`)
		await api(`/api/reviews/${resolvedId}/resolve`, { expectedRevision: current.revision, resolution: 'answered' })
		const { context, page } = await open(`/views/${viewId}?locale=en-US&viewport=mobile&theme=dark`)
		try {
			await livePreview(page, viewId)
			await expect.poll(() => drawn(page, visibleId), { timeout: 15_000 }).toBe(true)
			expect(await muted(page, visibleId)).toBe(true)
			// Another Variant's thread and a resolved one (filtered out) get no pin, muted or not.
			expect(await drawn(page, otherVariant)).toBe(false)
			expect(await drawn(page, resolvedId)).toBe(false)
			// Shift C hides every pin, the muted one included.
			await page.locator('body').click({ position: { x: 5, y: 5 } })
			await page.keyboard.press('Shift+C')
			await expect.poll(() => drawn(page, visibleId)).toBe(false)
			await page.keyboard.press('Shift+C')
			await expect.poll(() => drawn(page, visibleId)).toBe(true)
			// In its own Variant the scoped thread's pin is drawn, and muted.
			await page.goto(`${server.origin}/views/${viewId}?variant=error&locale=en-US&viewport=mobile&theme=dark`, { waitUntil: 'networkidle' })
			await livePreview(page, viewId)
			await expect.poll(() => drawn(page, otherVariant), { timeout: 15_000 }).toBe(true)
			expect(await muted(page, otherVariant)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('keeps a muted pin exactly where the same pin unmuted is, and mutes a cluster only when all its pins are', async () => {
		const viewId = await seedView('Muted position')
		const hint = { pin: { x: 0.5, y: 0.5 } }
		const mutedId = await seedThread(viewId, { widgetId: 'second', body: 'Muted twin.', renderContext: { themeId: 'light' }, displayHint: hint })
		const plainId = await seedThread(viewId, { widgetId: 'second', body: 'Plain twin.', displayHint: hint })
		const { context, page } = await open(`/views/${viewId}?locale=en-US&viewport=mobile&theme=dark`)
		try {
			await livePreview(page, viewId)
			// Both pins share one point: one cluster, unmuted because one member is not muted.
			const cluster = page.locator('[data-comment-pins] [data-pin-cluster]')
			await cluster.waitFor({ timeout: 15_000 })
			expect((await cluster.getAttribute('data-pin-cluster-threads'))!.split(' ').sort()).toEqual([mutedId, plainId].sort())
			expect(await cluster.getAttribute('data-pin-muted')).toBeNull()
			expect(await cluster.getAttribute('aria-label')).not.toContain('Preview context')

			// Opening the plain thread draws both on their own: the muted pin sits on the plain pin's point.
			await cluster.click()
			await page.getByRole('menu').getByRole('menuitem', { name: /Plain twin/ }).click()
			await page.locator('[data-thread-bubble]').waitFor()
			await expect.poll(() => drawn(page, mutedId)).toBe(true)
			await expect.poll(() => drawn(page, plainId)).toBe(true)
			expect(await muted(page, mutedId)).toBe(true)
			expect(await muted(page, plainId)).toBe(false)
			const mutedAt = await anchorTransform(page, `[data-comment-pins] [data-pin-thread="${mutedId}"]`)
			expect(mutedAt).toMatch(/^translate\(/)
			expect(mutedAt).toBe(await anchorTransform(page, `[data-comment-pins] [data-pin-thread="${plainId}"]`))
			const [mutedBox, plainBox] = await Promise.all([pin(page, mutedId).boundingBox(), pin(page, plainId).boundingBox()])
			expect(mutedBox!.x).toBeCloseTo(plainBox!.x, 1)
			expect(mutedBox!.y + mutedBox!.height).toBeCloseTo(plainBox!.y + plainBox!.height, 1)
		}
		finally { await context.close() }
	}, 90_000)

	it('checks the recorded viewport at activation: one removed after the page loaded opens with the default and a notice', async () => {
		await setViewports(viewports => ({ ...viewports, watch: { dimensions: { width: 200, height: 400 }, label: 'Watch' } }))
		const viewId = await seedView('Muted stale')
		const threadId = await seedThread(viewId, { widgetId: 'first', body: 'Cut off on the watch.', renderContext: { locale: 'zh-TW', viewportId: 'watch' } })
		const { context, page } = await open(`/views/${viewId}?locale=en-US&viewport=tablet&theme=dark`)
		try {
			const frame = await livePreview(page, viewId)
			expect(await previewWidth(frame)).toBe(1024)
			await expect.poll(() => drawn(page, threadId), { timeout: 15_000 }).toBe(true)
			expect(await muted(page, threadId)).toBe(true)
			// The viewport goes away after the page read the settings.
			await setViewports(viewports => Object.fromEntries(Object.entries(viewports).filter(([id]) => id !== 'watch')))

			await pin(page, threadId).click()
			await page.getByText('Viewport watch no longer exists, so the default viewport is shown.').first().waitFor({ timeout: 10_000 })
			await page.getByText('Part of this thread’s context no longer exists').first().waitFor()
			// The Locale applies; the viewport is the default (the widest preset); the theme was not recorded and stays.
			await expect.poll(() => query(page)).toMatchObject({ locale: 'zh-TW', theme: 'dark', thread: threadId })
			expect(query(page)).not.toHaveProperty('viewport')
			await expect.poll(() => previewWidth(frame)).toBe(1920)
			await expect.poll(() => previewTitle(page)).toContain('zh-TW')
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor()
			// The stale key is never rebound: the thread records it, and the header marks it as gone.
			await expect.poll(() => bubble.locator('[data-context-member="viewportId"]').getAttribute('data-context-missing')).toBe('')
			expect((await api<ReviewRead>(`/api/resources/review/${threadId}`)).resource.renderContext).toEqual({ locale: 'zh-TW', viewportId: 'watch' })
			// The reader's context stays on offer.
			expect(await bubble.locator('[data-thread-open-current]').count()).toBe(1)
			expect(await chrome(page)).toEqual(LIGHT_EN_US)
		}
		finally { await context.close() }
	}, 90_000)
})
