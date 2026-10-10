import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The canvas before/after comparison (Part 11, issue #132, B9) against the built Workbench and a
 * private copy of the frozen fixture Workspace:
 *
 * - Preview's read-only version mode renders a version's View with that version's manifest, View
 *   and Locales (Rule 01a11a5e-1232-777c-a76d-26a6d5cbcfc0); the frames are never targeted and carry
 *   no pins (Rule 01a11a5e-13d6-7a24-92e9-9a5de720ca27);
 * - `canvas=side` shows two frames in the same render context (Rules 01a11a5e-1288 and 1331), on one
 *   stage whose scrolling moves both while a frame's own content scrolls alone (Rule 01a11e45-6bbc);
 * - `canvas=highlight` outlines added, modified and moved Widgets on the after frame and removed ones
 *   on the before frame (Rule 01a11a5e-12dc);
 * - the Adapters-changed caveat always shows (Rule 01a11a5e-1385, owner ruling 5 of 2026-10-09);
 * - the canvas comparison is offered on desktop and tablet, never on a phone (Rule 01a11a5e-1ba5),
 *   and its `canvas` key round-trips through the address (Clause 01a11e0d-d7f5).
 *
 * Every test seeds its own versions through the API, so the tests run in any order.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser

type WidgetNode = { id: string; type: string; config?: Record<string, unknown>; slots?: Record<string, WidgetNode[]> }
type ViewRead = { revision: string; resource: { ir: WidgetNode; variants: Record<string, unknown> } }

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

const unique = () => randomUUID().slice(0, 8)

async function checkpoint(name: string): Promise<string> {
	return (await api<{ versionId: string }>('/api/history/checkpoints', { name })).versionId
}

function find(node: WidgetNode, id: string): WidgetNode | undefined {
	if (node.id === id) return node
	for (const children of Object.values(node.slots ?? {}))
		for (const child of children) {
			const found = find(child, id)
			if (found) return found
		}
	return undefined
}

function detach(node: WidgetNode, id: string): WidgetNode | undefined {
	for (const children of Object.values(node.slots ?? {})) {
		const index = children.findIndex(child => child.id === id)
		if (index >= 0) return children.splice(index, 1)[0]
		for (const child of children) {
			const found = detach(child, id)
			if (found) return found
		}
	}
	return undefined
}

/** Rewrites the View's structure as the Owner. */
async function editStructure(edit: (ir: WidgetNode, variants: Record<string, unknown>) => void): Promise<void> {
	const read = await api<ViewRead>(`/api/resources/view/${VIEW_ID}`)
	const ir = structuredClone(read.resource.ir)
	const variants = structuredClone(read.resource.variants ?? {})
	edit(ir, variants)
	await api(`/api/views/${VIEW_ID}/structure`, { expectedRevision: read.revision, ir, variants }, 'PUT')
}

const text = (id: string, value: string): WidgetNode => ({ id, type: 'Text', config: { text: value, variant: 'body' } })

type Seeded = Readonly<{ before: string; after: string; ids: Readonly<{ added: string; removed: string; modified: string; moved: string }> }>

/**
 * Two versions of the View: `before` (a Checkpoint) has three seeded Widgets at the top of the card;
 * `after` (the autosave that follows) adds one, removes one, changes one and moves one into another
 * parent. Comparing `after` with its parent compares exactly these.
 */
async function seedStructureChange(): Promise<Seeded> {
	const tag = unique()
	const ids = { added: `b9-add-${tag}`, removed: `b9-rm-${tag}`, modified: `b9-mod-${tag}`, moved: `b9-mv-${tag}` }
	await checkpoint(`b9-start-${tag}`)
	await editStructure((ir) => {
		find(ir, 'mock-card-body')!.slots!.content!.unshift(text(ids.removed, `Removed ${tag}`), text(ids.modified, `Before ${tag}`), text(ids.moved, `Moved ${tag}`))
	})
	const before = await checkpoint(`b9-before-${tag}`)
	await editStructure((ir) => {
		const body = find(ir, 'mock-card-body')!.slots!.content!
		detach(ir, ids.removed)
		find(ir, ids.modified)!.config!.text = `After ${tag}`
		const moved = detach(ir, ids.moved)!
		find(ir, 'mock-hero-text-block')!.slots!.content!.unshift(moved)
		body.unshift(text(ids.added, `Added ${tag}`))
	})
	await checkpoint(`b9-after-${tag}`)
	const listed = await api<{ versions: { id: string; type: string }[] }>(`/api/history/versions?resource=view:${VIEW_ID}&limit=5`)
	const after = listed.versions.find(version => version.type === 'autosave')!.id
	return { before, after, ids }
}

type Device = 'desktop' | 'tablet' | 'phone' | 'landscape'
const VIEWPORTS: Record<Device, { width: number; height: number }> = {
	desktop: { width: 1440, height: 900 },
	tablet: { width: 1024, height: 768 },
	phone: { width: 390, height: 844 },
	landscape: { width: 844, height: 390 },
}

async function open(path: string, device: Device = 'desktop'): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: VIEWPORTS[device], colorScheme: 'light', ...(device === 'phone' || device === 'landscape' ? { hasTouch: true, isMobile: true } : {}) })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

const query = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)
const frameLocator = (page: Page, side: 'before' | 'after') => page.locator(`[data-version-canvas] [data-version-frame="${side}"]`)

/** The frame's Preview document, once it rendered. */
async function frameDocument(page: Page, side: 'before' | 'after'): Promise<Frame> {
	const element = frameLocator(page, side)
	await element.and(page.locator('[data-frame-phase="open"]')).waitFor({ timeout: 20_000 })
	const frame = await (await element.locator('iframe').elementHandle())!.contentFrame()
	await frame!.locator('[data-preview-status="ready"]').waitFor({ state: 'attached', timeout: 20_000 })
	return frame!
}

/** Picks an option of a Nuxt UI select, then waits for its own list to go so focus is back (PR #162, #163). */
async function choose(page: Page, trigger: string, option: string): Promise<void> {
	await page.locator(trigger).click()
	const listbox = page.locator('[data-slot="content"][role="listbox"]')
	await listbox.getByRole('option', { name: option, exact: true }).click()
	await listbox.waitFor({ state: 'detached' })
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('Preview read-only version mode', () => {
	it('renders the version\'s View with the current runtime and Adapters', async () => {
		const seeded = await seedStructureChange()
		const { context, page } = await open(`/preview?version=${seeded.before}&viewId=${VIEW_ID}`)
		try {
			await page.locator('[data-preview-status="ready"]').waitFor({ state: 'attached', timeout: 20_000 })
			expect(await page.locator('[data-preview-version]').getAttribute('data-preview-version')).toBe(seeded.before)
			// The version's Widgets, not the current ones.
			await page.locator(`[data-widget-id="${seeded.ids.removed}"]`).waitFor({ state: 'attached' })
			expect(await page.locator(`[data-widget-id="${seeded.ids.added}"]`).count()).toBe(0)
			expect(await page.locator(`[data-widget-id="${seeded.ids.modified}"]`).textContent()).toContain('Before')
			// A View the version does not hold is said to be missing, not shown from the current files.
			const missing = await context.newPage()
			await missing.goto(`${server.origin}/preview?version=${seeded.before}&viewId=${randomUUID()}`, { waitUntil: 'networkidle' })
			await missing.locator('[data-preview-status="error"]').getByText('This View doesn\'t exist in this version.').waitFor({ timeout: 20_000 })
		}
		finally { await context.close() }
	}, 90_000)
})

describe('canvas comparison', () => {
	it('opens side by side from the View diff, shares the render context, shows the caveat and no pins, and round-trips the address', async () => {
		const seeded = await seedStructureChange()
		const thread = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'app-title' } })
		await api(`/api/reviews/${thread.key}/messages`, { expectedRevision: thread.revision, body: 'Check the title on both versions.' })
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.after}`)
		try {
			// The live canvas carries this View's pins; the comparison carries none.
			await page.locator(`[data-pin-thread="${thread.key}"]`).waitFor({ state: 'attached', timeout: 20_000 })
			const modes = page.locator('[data-view-history] [data-canvas-modes]')
			await modes.waitFor({ timeout: 20_000 })
			// Omitted `canvas` is the change list only.
			expect(await modes.locator('[data-canvas-mode="list"]').getAttribute('aria-current')).toBe('true')
			expect(await page.locator('[data-version-canvas]').count()).toBe(0)

			await modes.locator('[data-canvas-mode="side"]').click()
			await page.waitForURL(url => new URL(url).searchParams.get('canvas') === 'side')
			expect(query(page)).toMatchObject({ panel: 'history', version: seeded.after, canvas: 'side' })
			expect(query(page)).not.toHaveProperty('compare')
			const canvas = page.locator('[data-version-canvas]')
			await canvas.waitFor()
			await expect.poll(() => canvas.getAttribute('data-from')).toBe(seeded.before)
			expect(await canvas.getAttribute('data-to')).toBe(seeded.after)

			const before = await frameDocument(page, 'before')
			const after = await frameDocument(page, 'after')
			expect(new URL(before.url()).searchParams.get('version')).toBe(seeded.before)
			expect(new URL(after.url()).searchParams.get('version')).toBe(seeded.after)
			await before.locator(`[data-widget-id="${seeded.ids.removed}"]`).waitFor({ state: 'attached' })
			expect(await after.locator(`[data-widget-id="${seeded.ids.removed}"]`).count()).toBe(0)
			await after.locator(`[data-widget-id="${seeded.ids.added}"]`).waitFor({ state: 'attached' })

			// One render context for both frames.
			const contexts = async () => [await frameLocator(page, 'before').getAttribute('data-frame-context'), await frameLocator(page, 'after').getAttribute('data-frame-context')]
			const [first, second] = await contexts()
			expect(first).toBe(second)
			expect(first).toContain('|en-US|')
			// The canvas's own render-context bar (collapsed into its summary popover when the toolbar is narrow).
			const summary = page.locator('[data-version-canvas] [data-context-summary]')
			if (await summary.count()) await summary.click()
			await choose(page, '[data-context="locale"]', 'zh-TW')
			await expect.poll(async () => (await contexts()).every(value => value?.includes('|zh-TW|'))).toBe(true)
			expect(query(page)).toMatchObject({ locale: 'zh-TW', canvas: 'side' })

			// The Adapters-changed caveat always shows; there are no pins and no canvas tools.
			await canvas.locator('[data-adapters-caveat]').getByText('Shown with today\'s Widget Runtime and Adapters').waitFor()
			expect(await page.locator('[data-pin-thread]').count()).toBe(0)
			expect(await page.locator('[data-tool]').count()).toBe(0)

			// Read-only: a click on a historical Widget selects nothing.
			const beforeWidget = (await frameDocument(page, 'before')).locator(`[data-widget-id="${seeded.ids.removed}"]`)
			await beforeWidget.click()
			expect(query(page)).not.toHaveProperty('widget')

			// A copied address reopens the same comparison; the toolbar switches the mode; close goes back.
			const copied = page.url()
			const reopened = await context.newPage()
			await reopened.goto(copied, { waitUntil: 'networkidle' })
			await reopened.locator('[data-version-canvas][data-canvas-mode="side"] [data-version-frame="before"]').waitFor({ timeout: 20_000 })
			expect(query(reopened)).toEqual(query(page))
			await reopened.locator('[data-canvas-toolbar-mode="highlight"]').click()
			await reopened.waitForURL(url => new URL(url).searchParams.get('canvas') === 'highlight')
			await reopened.locator('[data-version-canvas][data-canvas-mode="highlight"]').waitFor()
			await reopened.locator('[data-canvas-close]').click()
			await reopened.waitForURL(url => !new URL(url).searchParams.has('canvas'))
			await reopened.locator('[data-canvas]').waitFor()
			expect(await reopened.locator('[data-version-canvas]').count()).toBe(0)
			expect(query(reopened)).toMatchObject({ panel: 'history', version: seeded.after })
		}
		finally { await context.close() }
	}, 120_000)

	it('scrolls both frames with the outer stage, and a frame\'s own content alone', async () => {
		const seeded = await seedStructureChange()
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.after}&canvas=side&viewport=mobile`)
		try {
			const before = await frameDocument(page, 'before')
			const after = await frameDocument(page, 'after')
			// At 200% the pair is larger than the stage, so the stage scrolls.
			await page.locator('[data-version-canvas] [data-zoom-percent]').click()
			await page.getByRole('menuitemcheckbox', { name: '200%' }).click()
			const stage = page.locator('[data-version-stage]')
			await expect.poll(() => stage.evaluate(element => element.scrollHeight > element.clientHeight && element.scrollWidth > element.clientWidth)).toBe(true)
			const boxes = async () => Promise.all((['before', 'after'] as const).map(side => frameLocator(page, side).evaluate(element => element.getBoundingClientRect().toJSON() as DOMRect)))
			const [beforeBox, afterBox] = await boxes()
			await stage.evaluate((element) => { element.scrollTo({ left: 120, top: 160, behavior: 'instant' }) })
			const [beforeMoved, afterMoved] = await boxes()
			expect(beforeMoved!.x - beforeBox!.x).toBeCloseTo(-120, 0)
			expect(beforeMoved!.y - beforeBox!.y).toBeCloseTo(-160, 0)
			expect(afterMoved!.x - afterBox!.x).toBeCloseTo(beforeMoved!.x - beforeBox!.x, 0)
			expect(afterMoved!.y - afterBox!.y).toBeCloseTo(beforeMoved!.y - beforeBox!.y, 0)

			// Scrolling inside one frame's document scrolls that frame only.
			const scrollable = await before.evaluate(() => document.scrollingElement!.scrollHeight > window.innerHeight)
			expect(scrollable).toBe(true)
			await before.evaluate(() => window.scrollTo(0, 200))
			await expect.poll(() => before.evaluate(() => window.scrollY)).toBeGreaterThan(0)
			expect(await after.evaluate(() => window.scrollY)).toBe(0)
			expect(await stage.evaluate(element => [element.scrollLeft, element.scrollTop])).toEqual([120, 160])
		}
		finally { await context.close() }
	}, 120_000)

	it('outlines added, modified and moved Widgets after and removed Widgets before', async () => {
		const seeded = await seedStructureChange()
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.after}&canvas=highlight`)
		try {
			await frameDocument(page, 'before')
			await frameDocument(page, 'after')
			const outline = (side: 'before' | 'after', id: string) => frameLocator(page, side).locator(`[data-highlight-widget="${id}"]`)
			await outline('after', seeded.ids.added).waitFor({ timeout: 20_000 })
			expect(await outline('after', seeded.ids.added).getAttribute('data-highlight')).toBe('added')
			await outline('after', seeded.ids.modified).waitFor()
			expect(await outline('after', seeded.ids.modified).getAttribute('data-highlight')).toBe('modified')
			await outline('after', seeded.ids.moved).waitFor()
			expect(await outline('after', seeded.ids.moved).getAttribute('data-highlight')).toBe('moved')
			await outline('before', seeded.ids.removed).waitFor()
			expect(await outline('before', seeded.ids.removed).getAttribute('data-highlight')).toBe('removed')
			// Each side outlines only its own: nothing removed after, nothing added before.
			expect(await outline('after', seeded.ids.removed).count()).toBe(0)
			expect(await outline('before', seeded.ids.added).count()).toBe(0)
			// Widgets that only shifted beside the added one are not outlined.
			expect(await frameLocator(page, 'after').locator('[data-highlight-widget="mock-hero-banner"]').count()).toBe(0)

			// The outline sits on the Widget the runtime measured.
			const after = await frameDocument(page, 'after')
			const widget = await after.locator(`[data-widget-id="${seeded.ids.added}"]`).boundingBox()
			const box = await outline('after', seeded.ids.added).boundingBox()
			expect(Math.abs(box!.x + box!.width / 2 - (widget!.x + widget!.width / 2))).toBeLessThan(3)
			expect(Math.abs(box!.y + box!.height / 2 - (widget!.y + widget!.height / 2))).toBeLessThan(3)
			await page.locator('[data-highlight-legend]').getByText('Moved', { exact: true }).waitFor()
			await page.locator('[data-adapters-caveat]').waitFor()
		}
		finally { await context.close() }
	}, 120_000)

	it('shows the base state with a notice when the selected Variant is missing from a version', async () => {
		const seeded = await seedStructureChange()
		const variant = `b9-variant-${unique()}`
		await editStructure((_ir, variants) => { variants[variant] = { state: {} } })
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.after}&compare=current&canvas=side&variant=${variant}`)
		try {
			await page.locator('[data-frame-notice="before:variant"]').waitFor({ timeout: 20_000 })
			expect(await page.locator('[data-frame-notice="before:variant"]').textContent()).toContain(variant)
			expect(await page.locator('[data-frame-notice^="after:"]').count()).toBe(0)
			await frameDocument(page, 'before')
			await frameDocument(page, 'after')
			expect(await frameLocator(page, 'before').getAttribute('data-frame-context')).toMatch(/^\|en-US\|/)
			expect(await frameLocator(page, 'after').getAttribute('data-frame-context')).toMatch(new RegExp(`^${variant}\\|`))
			expect(await frameLocator(page, 'after').getAttribute('data-frame-version')).toBe('current')
		}
		finally {
			await context.close()
			await editStructure((_ir, variants) => { delete variants[variant] })
		}
	}, 120_000)
})

describe('device tiers', () => {
	it('offers the canvas comparison on desktop and tablet, never on a phone', async () => {
		const seeded = await seedStructureChange()
		const path = `/views/${VIEW_ID}?panel=history&version=${seeded.after}&canvas=side`

		const tablet = await open(path, 'tablet')
		try {
			await tablet.page.locator('[data-version-canvas] [data-version-frame="after"]').waitFor({ timeout: 20_000 })
			await tablet.page.locator('[data-adapters-caveat]').waitFor()
		}
		finally { await tablet.context.close() }

		for (const device of ['phone', 'landscape'] as const) {
			const phone = await open(path, device)
			try {
				// A phone's history tab still shows the comparison's change list; a phone in landscape keeps the live canvas.
				if (device === 'phone') await phone.page.locator('[data-view-history] [data-version-comparison] [data-resource-diff]').first().waitFor({ timeout: 20_000 })
				else await phone.page.locator('[data-canvas] iframe').waitFor({ timeout: 20_000 })
				expect(await phone.page.locator('[data-version-canvas]').count(), device).toBe(0)
				expect(await phone.page.locator('[data-canvas-modes]').count(), device).toBe(0)
				// The key stays in the address, inert.
				expect(query(phone.page).canvas, device).toBe('side')
			}
			finally { await phone.context.close() }
		}
	}, 120_000)
})
