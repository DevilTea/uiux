import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The History area (the version timeline, the comparison and its resource diffs, the canvas comparison, and the
 * Create Checkpoint, Delete Checkpoint and Restore dialogs) builds its buttons, badges, icons and skeletons from
 * the Kit components in `app/components/kit/` instead of Nuxt UI primitives (Discussion #379 D1, issue #380). The
 * test guards that the Kit renders them with the state the area relied on: expanded disclosure toggles, icon-only
 * buttons that keep their accessible name, one primary action per dialog, and that no Kit tag or icon name is left
 * unresolved (an icon name the Kit does not know renders as literal text). Router links (Compare, the canvas modes
 * and close buttons) and Nuxt UI overlays, selects, alerts and tooltips stay Nuxt UI.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser
const seeded = { early: '', checkpointName: '', autosave: '', viewAutosave: '' }

type Widget = { id: string; type: string; config?: Record<string, unknown>; slots?: Record<string, Widget[]> }

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

const checkpoint = async (name: string, note?: string): Promise<string> =>
	(await api<{ versionId: string }>('/api/history/checkpoints', { name, ...(note ? { note } : {}) })).versionId

function find(node: Widget, id: string): Widget | undefined {
	if (node.id === id) return node
	for (const children of Object.values(node.slots ?? {})) {
		for (const child of children) {
			const found = find(child, id)
			if (found) return found
		}
	}
	return undefined
}

async function editStructure(edit: (ir: Widget) => void): Promise<void> {
	const read = await api<{ revision: string; resource: { ir: Widget; variants: Record<string, unknown> } }>(`/api/resources/view/${VIEW_ID}`)
	const ir = structuredClone(read.resource.ir)
	edit(ir)
	await api(`/api/views/${VIEW_ID}/structure`, { expectedRevision: read.revision, ir, variants: read.resource.variants ?? {} }, 'PUT')
}

async function editLocale(key: string, value: string | undefined): Promise<void> {
	const read = await api<{ revision: string; resource: Record<string, string> }>('/api/resources/locale/en-US')
	const messages = { ...read.resource }
	if (value === undefined) delete messages[key]
	else messages[key] = value
	await api('/api/locales/en-US', { expectedRevision: read.revision, messages }, 'PUT')
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	const tag = randomUUID().slice(0, 8)
	seeded.early = await checkpoint(`kit-early-${tag}`, 'State before the changes')
	await editLocale(`kit.${tag}`, 'A value')
	seeded.checkpointName = `kit-locale-${tag}`
	await checkpoint(seeded.checkpointName, 'Added a message')
	await editLocale(`kit.quiet.${tag}`, 'Added, then removed')
	await editLocale(`kit.quiet.${tag}`, undefined)
	await checkpoint(`kit-quiet-${tag}`)
	await editStructure((ir) => { find(ir, 'mock-card-body')!.slots!.content!.unshift({ id: `kit-${tag}`, type: 'Text', config: { text: `Added ${tag}`, variant: 'body' } }) })
	await checkpoint(`kit-structure-${tag}`)
	const listed = await api<{ versions: { id: string; type: string; summary: { kind: string; key: string }[] }[] }>('/api/history/versions?limit=30')
	seeded.autosave = listed.versions.find(version => version.type === 'autosave' && version.summary.some(row => row.kind === 'locale'))!.id
	seeded.viewAutosave = listed.versions.find(version => version.type === 'autosave' && version.summary.some(row => row.kind === 'view'))!.id
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Setup = Readonly<{ touch?: boolean; width?: number; height?: number }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1440, height: setup.height ?? 900 },
		colorScheme: 'light',
		...(setup.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const hasClass = (locator: Locator, name: string) => locator.evaluate((element, expected) => element.classList.contains(expected), name)
const UNKNOWN_KIT_TAGS = 'kitbutton, kitbadge, kiticon, kitskeleton, kitbuttongroup, kitcheckbox, kitkbd'
/** A Kit icon whose name the Kit does not know renders as literal text in a `.kit-glyph`. */
const GLYPHS = '.kit-glyph'

describe('The History area uses the Kit components (#380)', () => {
	it('timeline: a Kit Checkpoint badge, icon-only Kit row actions with their names, Kit icons, Compare stays a link', async () => {
		const { context, page } = await open('/?tab=activity')
		try {
			const timeline = page.locator('[data-version-timeline]')
			const row = timeline.locator('[data-version-row]').filter({ hasText: seeded.checkpointName }).first()
			await row.waitFor({ timeout: 15_000 })

			const badge = row.locator('.kit-badge')
			expect(await hasClass(badge, 'kit-badge--soft')).toBe(true)
			expect(await badge.locator('svg.kit-icon').count()).toBe(1)
			expect(await badge.textContent()).toContain('Checkpoint')
			// The type and the actor marks are Kit icons, none a literal icon name.
			expect(await row.locator('svg.kit-icon').count()).toBeGreaterThanOrEqual(3)
			expect(await timeline.locator(GLYPHS).count()).toBe(0)
			expect(await timeline.getByText(/i-lucide/).count()).toBe(0)

			// Compare is a router link: a Kit Button link (KitLinkButton).
			const compare = row.locator('[data-version-compare]')
			expect(await compare.evaluate(element => element.tagName)).toBe('A')
			expect(await hasClass(compare, 'kit-btn')).toBe(true)

			const remove = row.locator('[data-version-delete]')
			expect(await hasClass(remove, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(remove, 'kit-btn--xs')).toBe(true)
			expect(await hasClass(remove, 'is-icon-only')).toBe(true)
			expect(await remove.getAttribute('aria-label')).toContain(seeded.checkpointName)

			const expand = row.locator('[data-version-expand]')
			expect(await hasClass(expand, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(expand, 'is-icon-only')).toBe(true)
			expect(await expand.getAttribute('aria-expanded')).toBe('false')
			expect(await expand.getAttribute('aria-label')).toMatch(/^Show what/)
			await expand.click()
			expect(await expand.getAttribute('aria-expanded')).toBe('true')
			expect(await hasClass(expand, 'is-expanded')).toBe(true)
			expect(await expand.getAttribute('aria-label')).toMatch(/^Hide what/)
			expect(await expand.getAttribute('aria-controls')).toBeTruthy()
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('timeline: the quiet group toggle keeps its expanded state with Kit icons', async () => {
		const { context, page } = await open('/?tab=activity')
		try {
			const toggle = page.locator('[data-quiet-toggle]').first()
			await toggle.waitFor({ timeout: 15_000 })
			expect(await toggle.getAttribute('aria-expanded')).toBe('false')
			expect(await toggle.locator('svg.kit-icon').count()).toBe(2)
			await toggle.click()
			expect(await toggle.getAttribute('aria-expanded')).toBe('true')
			expect(await page.locator(GLYPHS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('comparison: resource diffs and their change marks are Kit icons', async () => {
		const { context, page } = await open(`/?tab=activity&version=${seeded.autosave}`)
		try {
			const comparison = page.locator('[data-version-comparison]')
			await comparison.waitFor({ timeout: 15_000 })
			const block = comparison.locator('[data-resource-diff="locale:en-US"]')
			await block.waitFor({ timeout: 15_000 })
			if (await block.getAttribute('data-open') === null) await block.locator('[data-resource-diff-toggle]').click()
			await block.locator('[data-diff-section]').first().waitFor({ timeout: 15_000 })
			expect(await block.locator('[data-resource-diff-toggle] svg.kit-icon').count()).toBe(2)
			expect(await block.locator('[data-diff-item] svg.kit-icon').count()).toBeGreaterThan(0)
			expect(await comparison.locator('[data-compare-target]').first().evaluate(element => element.tagName)).toBe('A')
			expect(await page.locator(GLYPHS).count()).toBe(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Restore: a Kit outline trigger that keeps its long accessible name, and a Kit dialog with Cancel first and a primary Restore', async () => {
		const { context, page } = await open(`/?tab=activity&version=${seeded.early}&compare=current&resource=view:${VIEW_ID}`)
		try {
			const block = page.locator(`[data-version-comparison] [data-resource-diff="view:${VIEW_ID}"]`)
			await block.waitFor({ timeout: 15_000 })
			if (await block.getAttribute('data-open') === null) await block.locator('[data-resource-diff-toggle]').click()
			const trigger = block.locator('[data-restore-version]')
			expect(await hasClass(trigger, 'kit-btn--outline')).toBe(true)
			expect(await hasClass(trigger, 'kit-btn--xs')).toBe(true)
			expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
			expect(await trigger.getAttribute('aria-label')).toMatch(/^Restore/)
			expect(await trigger.getAttribute('aria-label')).not.toBe((await trigger.textContent())?.trim())
			await trigger.click()
			const dialog = page.locator('[data-restore-dialog]')
			await dialog.waitFor()
			const confirm = page.locator('[data-restore-confirm]')
			await expect.poll(() => confirm.isEnabled(), { timeout: 10_000 }).toBe(true)
			expect(await hasClass(confirm, 'kit-btn--primary')).toBe(true)
			expect(await confirm.locator('svg.kit-icon').count()).toBe(1)
			const cancel = page.locator('[data-restore-cancel]')
			expect(await hasClass(cancel, 'kit-btn--outline')).toBe(true)
			expect(await cancel.evaluate(element => element === document.activeElement)).toBe(true)
			expect(await page.locator(GLYPHS).count()).toBe(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Create and Delete Checkpoint dialogs: Kit outline Cancel, a primary Create and a danger Delete with focus on Cancel', async () => {
		const { context, page } = await open('/?tab=activity')
		try {
			await page.locator('[data-version-row]').first().waitFor({ timeout: 15_000 })
			await page.getByRole('button', { name: 'Create Checkpoint' }).click()
			const create = page.locator('[data-checkpoint-dialog]')
			await create.waitFor()
			const dialog = page.getByRole('dialog')
			const submit = dialog.locator('[data-checkpoint-submit]')
			expect(await hasClass(submit, 'kit-btn--primary')).toBe(true)
			expect(await submit.locator('svg.kit-icon').count()).toBe(1)
			expect(await hasClass(dialog.getByRole('button', { name: 'Cancel' }), 'kit-btn--outline')).toBe(true)
			await dialog.getByRole('button', { name: 'Cancel' }).click()
			await dialog.waitFor({ state: 'detached' })

			await page.locator('[data-version-delete]').first().click()
			const remove = page.locator('[data-delete-checkpoint-dialog]')
			await remove.waitFor()
			const cancel = page.locator('[data-delete-cancel]')
			expect(await hasClass(cancel, 'kit-btn--outline')).toBe(true)
			await expect.poll(() => cancel.evaluate(element => element === document.activeElement)).toBe(true)
			const confirm = page.locator('[data-delete-confirm]')
			expect(await hasClass(confirm, 'kit-btn--danger')).toBe(true)
			expect(await confirm.locator('svg.kit-icon').count()).toBe(1)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('View history panel: an outline Kit Create Checkpoint button and Kit timeline controls', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history`)
		try {
			const create = page.locator('[data-create-checkpoint]')
			await create.waitFor({ timeout: 15_000 })
			expect(await hasClass(create, 'kit-btn--outline')).toBe(true)
			expect(await hasClass(create, 'kit-btn--sm')).toBe(true)
			expect(await create.locator('svg.kit-icon').count()).toBe(1)
			await page.locator('[data-version-row]').first().waitFor({ timeout: 15_000 })
			expect(await hasClass(page.locator('[data-version-expand]').first(), 'kit-btn--ghost')).toBe(true)
			expect(await page.locator(GLYPHS).count()).toBe(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('canvas comparison: the mode and close controls are links and stay Nuxt UI, the rest renders Kit icons', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.viewAutosave}&canvas=side`)
		try {
			const canvas = page.locator('[data-version-canvas]')
			await canvas.waitFor({ timeout: 20_000 })
			const modes = page.locator('[data-canvas-toolbar-mode]')
			expect(await modes.count()).toBe(2)
			expect(await modes.first().evaluate(element => element.tagName)).toBe('A')
			const close = page.locator('[data-canvas-close]')
			expect(await close.evaluate(element => element.tagName)).toBe('A')
			await page.locator('[data-version-frame="after"][data-frame-phase="open"]').waitFor({ timeout: 20_000 })
			expect(await page.locator(GLYPHS).count()).toBe(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('canvas comparison on a tablet: the render context summary is a Kit button that keeps its name and a popover trigger', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history&version=${seeded.viewAutosave}&canvas=side`, { width: 1024, height: 768 })
		try {
			const summary = page.locator('[data-context-summary]')
			await summary.waitFor({ timeout: 20_000 })
			expect(await hasClass(summary, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(summary, 'is-truncate')).toBe(true)
			expect(await summary.locator('svg.kit-icon').count()).toBe(2)
			expect(await summary.getAttribute('aria-label')).toBeTruthy()
			expect(await summary.getAttribute('aria-expanded')).toBe('false')
			await summary.click()
			await expect.poll(() => summary.getAttribute('aria-expanded')).toBe('true')
		}
		finally { await context.close() }
	}, 90_000)

	it('on a phone the timeline row actions keep their names and render no literal icon name', async () => {
		const { context, page } = await open('/?tab=activity', { touch: true, width: 390, height: 844 })
		try {
			const expand = page.locator('[data-version-expand]').first()
			await expand.waitFor({ timeout: 15_000 })
			expect(await hasClass(expand, 'kit-btn')).toBe(true)
			expect(await page.getByRole('button', { name: /^Show what/ }).count()).toBeGreaterThan(0)
			expect(await page.locator(GLYPHS).count()).toBe(0)
			const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
			expect(overflow).toBe(false)
		}
		finally { await context.close() }
	}, 90_000)
})
