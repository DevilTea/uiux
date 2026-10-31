import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workbench canvas and shell (the View page: canvas chrome, right panel tabs, Inspector, Spec and comments;
 * the navbar, sidebar, bottom navigation, preferences and shortcuts; the Overview) build their buttons, badges,
 * icons, skeletons and shortcut hints from the Kit components in `app/components/kit/` instead of Nuxt UI
 * primitives (Discussion #379 D1, issue #380). The test guards that the Kit renders them with the state the area
 * relied on (a pressed and an active tool, an expanded disclosure, icon-only buttons that keep their accessible
 * name and the touch target), that no icon name leaks as literal text (`.kit-glyph`) and that no Kit tag is left
 * unresolved. Nuxt UI overlays, inputs, alerts, tables, trees and links stay Nuxt UI.
 */

const VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const THREAD_ID = '140f4e87-cc50-4768-a82b-56b663609321'

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
})

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Setup = Readonly<{ touch?: boolean; width?: number; height?: number; mode?: 'light' | 'dark' }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const mode = setup.mode ?? 'light'
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: mode,
		...(setup.touch ? { hasTouch: true } : {}),
	})
	await context.addInitScript((value) => {
		localStorage.setItem('nuxt-color-mode', value)
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	}, mode)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const hasClass = (locator: Locator, name: string) => locator.evaluate((element, expected) => element.classList.contains(expected), name)
const UNKNOWN_KIT_TAGS = 'kitbutton, kitbadge, kiticon, kitskeleton, kitbuttongroup, kitcheckbox, kitkbd'

/** No icon name rendered as text, and no Kit tag left unresolved. */
async function expectClean(page: Page, label: string): Promise<void> {
	expect(await page.locator('.kit-glyph').count(), `${label}: literal icon names`).toBe(0)
	expect(await page.locator(UNKNOWN_KIT_TAGS).count(), `${label}: unresolved Kit tags`).toBe(0)
	expect(await page.getByText(/i-lucide-/).count(), `${label}: prefixed icon names as text`).toBe(0)
}

const live = (page: Page) => page.locator('[data-session-status][data-status="live"]').waitFor({ timeout: 30_000 })

describe('The Workbench canvas and shell use the Kit components (#380)', () => {
	it('canvas tool pill: the active tool is a solid Kit button, the others are quiet, and Comment takes the annotation look', async () => {
		const { context, page } = await open(`/views/${VIEW}`)
		try {
			await live(page)
			const select = page.locator('[data-tool="select"]')
			const comment = page.locator('[data-tool="comment"]')
			expect(await hasClass(select, 'kit-btn--primary')).toBe(true)
			expect(await select.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(comment, 'kit-btn--ghost')).toBe(true)
			expect(await comment.getAttribute('aria-pressed')).toBe('false')
			expect(await select.locator('svg.kit-icon').count()).toBe(1)
			expect(await select.locator('.kit-btn__kbd').textContent()).toBe('V')
			expect(await select.getAttribute('aria-keyshortcuts')).toBe('V')

			await comment.click()
			expect(await comment.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(comment, 'kit-btn--annotation')).toBe(true)
			expect(await hasClass(select, 'kit-btn--ghost')).toBe(true)

			const pins = page.locator('[data-pins-toggle]')
			expect(await hasClass(pins, 'is-icon-only')).toBe(true)
			expect(await pins.getAttribute('aria-label')).toBeTruthy()
			expect(await pins.getAttribute('aria-pressed')).toBe('true')
			const onView = page.locator('[data-comment-on-view="pill"]')
			expect(await hasClass(onView, 'is-icon-only')).toBe(true)
			expect(await onView.getAttribute('aria-label')).toBe('Comment on this View')
			await expectClean(page, 'canvas')
		}
		finally { await context.close() }
	}, 90_000)

	it('canvas: zoom controls, the session chip and the View header are Kit components', async () => {
		const { context, page } = await open(`/views/${VIEW}`)
		try {
			await live(page)
			expect(await hasClass(page.locator('[data-zoom-percent]'), 'kit-btn--ghost')).toBe(true)
			expect(await page.locator('[data-zoom-percent] svg.kit-icon').count()).toBe(1)
			const fit = page.locator('[data-zoom-fit]')
			expect(await hasClass(fit, 'kit-btn--ghost')).toBe(true)
			expect(await fit.getAttribute('aria-pressed')).not.toBeNull()
			const zoomIn = page.getByRole('button', { name: 'Zoom in' })
			expect(await hasClass(zoomIn, 'is-icon-only')).toBe(true)
			expect(await hasClass(page.getByRole('button', { name: 'Zoom out' }), 'is-icon-only')).toBe(true)
			expect(await hasClass(page.locator('[data-session-status]'), 'kit-btn--ghost')).toBe(true)

			expect(await hasClass(page.locator('[data-view-feature]'), 'kit-badge')).toBe(true)
			expect(await page.locator('[data-view-feature] svg.kit-icon').count()).toBe(1)
			const rename = page.locator('[data-view-rename]')
			expect(await hasClass(rename, 'is-icon-only')).toBe(true)
			expect(await hasClass(rename, 'kit-btn--xs')).toBe(true)
			await rename.click()
			expect(await hasClass(page.locator('[data-view-metadata-save]'), 'kit-btn--primary')).toBe(true)
			expect(await hasClass(page.locator('[data-view-metadata-cancel]'), 'kit-btn--outline')).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('Inspector: a Kit comment action, an icon-only copy, mono identity badge and an expanded Details toggle', async () => {
		const { context, page } = await open(`/views/${VIEW}?widget=btn-run-checks&panel=inspect`)
		try {
			const comment = page.locator('[data-inspector-comment]')
			await comment.waitFor()
			expect(await hasClass(comment, 'kit-btn--annotation')).toBe(true)
			expect(await comment.locator('svg.kit-icon').count()).toBe(1)
			const copy = page.locator('[data-inspector-copy]')
			expect(await hasClass(copy, 'is-icon-only')).toBe(true)
			expect(await copy.getAttribute('aria-label')).toBe('Copy Widget id')
			const properties = page.locator('[data-inspector-properties]')
			expect(await hasClass(properties.locator('.kit-badge').first(), 'kit-badge--mono')).toBe(true)
			expect(await properties.locator('.kit-badge').first().textContent()).toContain('#btn-run-checks')

			const details = page.locator('[data-inspector-details-toggle]')
			expect(await hasClass(details, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(details, 'is-full-width')).toBe(true)
			expect(await details.locator('svg.kit-icon').count()).toBe(1)
			await details.click()
			await page.locator('[data-inspector-details]').waitFor()
			expect(await page.locator('[data-inspector-details] .kit-btn.is-icon-only').count()).toBeGreaterThan(0)
			// The widget type icon in the header is a Kit icon.
			expect(await page.locator('.kit-icon').count()).toBeGreaterThan(3)
			await expectClean(page, 'inspector')
		}
		finally { await context.close() }
	}, 90_000)

	it('Spec: Kit edit buttons and Kit count and decision badges; the editor has a primary Save and an outline Cancel', async () => {
		const { context, page } = await open(`/views/${VIEW}?panel=spec`)
		try {
			const edit = page.locator('[data-spec-edit]').first()
			await edit.waitFor()
			expect(await hasClass(edit, 'kit-btn')).toBe(true)
			expect(await page.locator('[data-spec-section] .kit-badge').count()).toBeGreaterThan(0)
			await edit.click()
			expect(await hasClass(page.locator('[data-spec-save]'), 'kit-btn--primary')).toBe(true)
			expect(await page.locator('[data-spec-save]').getAttribute('type')).toBe('submit')
			expect(await hasClass(page.locator('[data-spec-cancel]'), 'kit-btn--outline')).toBe(true)
			await expectClean(page, 'spec')
		}
		finally { await context.close() }
	}, 90_000)

	it('comments: filter toggles are pressed Kit buttons, the thread bubble has a Kit status badge and an icon-only close', async () => {
		const { context, page } = await open(`/views/${VIEW}?panel=comments&thread=${THREAD_ID}`)
		try {
			const open = page.locator('[data-comment-filter="open"]')
			await open.waitFor()
			expect(await hasClass(open, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(open, 'kit-btn--xs')).toBe(true)
			expect(await open.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(open, 'is-pressed')).toBe(true)
			expect(await open.locator('svg.kit-icon').count()).toBe(1)
			await page.locator('[data-comment-filter="resolved"]').click()
			expect(await page.locator('[data-comment-filter="resolved"]').getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(page.locator('[data-comment-on-view="tab"]'), 'kit-btn--outline')).toBe(true)
			expect(await page.locator('[data-comment-row] svg.kit-icon').count()).toBeGreaterThan(0)

			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 30_000 })
			expect(await bubble.locator('.kit-badge--soft').count()).toBeGreaterThan(0)
			const close = bubble.locator('[data-thread-close]')
			expect(await hasClass(close, 'is-icon-only')).toBe(true)
			expect(await close.getAttribute('aria-label')).toBe('Close')
			expect(await bubble.locator('[data-thread-send]').count()).toBeLessThanOrEqual(1)
			await expectClean(page, 'comments')
		}
		finally { await context.close() }
	}, 90_000)

	it('thread bubble reply keeps a Kit send button with a shortcut hint', async () => {
		const { context, page } = await open(`/views/${VIEW}?panel=comments&thread=${THREAD_ID}`)
		try {
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 30_000 })
			const send = bubble.locator('[data-thread-send]')
			if (await send.count()) {
				expect(await hasClass(send, 'kit-btn--outline')).toBe(true)
				expect(await send.locator('.kit-btn__kbd').count()).toBe(1)
				expect(await send.isDisabled()).toBe(true)
			}
		}
		finally { await context.close() }
	}, 90_000)

	it('shell: Kit icon-only Preferences and Workspace menu triggers, Kit sidebar icons, and a Kit Kbd list in the shortcuts dialog', async () => {
		const { context, page } = await open(`/views/${VIEW}`)
		try {
			await live(page)
			const prefs = page.getByRole('button', { name: 'Preferences' })
			expect(await hasClass(prefs, 'is-icon-only')).toBe(true)
			expect(await hasClass(prefs, 'kit-btn--ghost')).toBe(true)
			const workspace = page.locator('header button.kit-btn--ghost[aria-haspopup="menu"]').first()
			expect(await workspace.locator('svg.kit-icon').count()).toBeGreaterThan(0)
			expect(await page.locator('aside .kit-icon, nav .kit-icon').count()).toBeGreaterThan(0)
			// A Kit button keeps its children in one row: the Workspace mark sits beside its name, and the session chip keeps its dot.
			const mark = await workspace.locator('svg:not(.kit-icon)').boundingBox()
			const name = await workspace.getByText('Workspace', { exact: true }).boundingBox()
			expect(Math.abs((mark!.y + mark!.height / 2) - (name!.y + name!.height / 2))).toBeLessThan(4)
			const dot = await page.locator('[data-session-status] [aria-hidden="true"].rounded-full').boundingBox()
			expect(dot?.width).toBeGreaterThanOrEqual(7)

			await page.keyboard.press('?')
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			expect(await dialog.locator('kbd.kit-kbd').count()).toBeGreaterThan(10)
			expect(await dialog.locator('kbd:not(.kit-kbd)').count()).toBe(0)
			// `meta` resolves to the platform key instead of the word.
			expect(await dialog.locator('kbd.kit-kbd', { hasText: /^meta$/i }).count()).toBe(0)
			await expectClean(page, 'shortcuts')
		}
		finally { await context.close() }
	}, 90_000)

	it('Overview: an outline Kit Export button, Kit readiness badges and sort buttons', async () => {
		const { context, page } = await open('/')
		try {
			const exportButton = page.locator('[data-export-open]')
			await exportButton.waitFor()
			expect(await hasClass(exportButton, 'kit-btn--outline')).toBe(true)
			expect(await exportButton.locator('svg.kit-icon').count()).toBe(1)
			const readiness = page.locator('[data-readiness]').first()
			await readiness.waitFor()
			expect(await hasClass(readiness, 'kit-badge')).toBe(true)
			expect(await readiness.locator('svg.kit-icon').count()).toBe(1)
			expect(await page.locator('table thead .kit-btn--ghost').count()).toBeGreaterThan(0)
			await expectClean(page, 'overview')
		}
		finally { await context.close() }
	}, 90_000)

	it('on a phone the navbar menu button is a 44px Kit button and the bottom navigation has Kit icons', async () => {
		const { context, page } = await open(`/views/${VIEW}`, { touch: true, width: 390, height: 844 })
		try {
			const menu = page.getByRole('button', { name: 'Toggle sidebar' })
			await menu.waitFor()
			expect(await hasClass(menu, 'is-icon-only')).toBe(true)
			const box = await menu.boundingBox()
			expect(box?.width).toBeGreaterThanOrEqual(44)
			expect(box?.height).toBeGreaterThanOrEqual(44)
			expect(await page.locator('nav .kit-icon').count()).toBeGreaterThanOrEqual(3)
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
			await expectClean(page, 'phone')
		}
		finally { await context.close() }
	}, 90_000)

	it('on a phone the canvas tool buttons and the zoom Fit button show only their icon', async () => {
		const { context, page } = await open(`/views/${VIEW}`, { touch: true, width: 390, height: 844 })
		try {
			// A phone opens the Spec; the canvas is behind the View tab.
			await page.getByRole('tab', { name: 'View', exact: true }).click()
			await page.locator('[data-tool="select"]').waitFor()
			for (const selector of ['[data-tool="select"]', '[data-tool="interact"]', '[data-zoom-fit]']) {
				const control = page.locator(selector)
				expect(await hasClass(control, 'kit-btn'), selector).toBe(true)
				// The label is visually hidden, so the button is icon wide, not label wide, and the shortcut hint is gone.
				expect((await control.boundingBox())?.width, selector).toBeLessThan(70)
				expect(await control.locator('.kit-btn__kbd').count() === 0 || !(await control.locator('.kit-btn__kbd').isVisible()), selector).toBe(true)
			}
			expect(await page.getByRole('button', { name: 'Select', exact: true }).count()).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('on a touch tablet the icon-only Open panel button is a 44px Kit button that reports its expanded state', async () => {
		const { context, page } = await open(`/views/${VIEW}`, { touch: true, width: 1024, height: 768 })
		try {
			const panel = page.getByRole('button', { name: 'Open panel' })
			await panel.waitFor()
			expect(await hasClass(panel, 'is-icon-only')).toBe(true)
			expect(await panel.getAttribute('aria-expanded')).toBe('false')
			const box = await panel.boundingBox()
			expect(box?.width).toBeGreaterThanOrEqual(44)
			expect(box?.height).toBeGreaterThanOrEqual(44)
		}
		finally { await context.close() }
	}, 90_000)

	it('renders every route of the area without literal icon names or unresolved tags, in light and dark', async () => {
		for (const mode of ['light', 'dark'] as const) {
			for (const route of ['/', `/views/${VIEW}`, `/views/${VIEW}?panel=spec`, `/views/${VIEW}?panel=comments&thread=${THREAD_ID}`, `/views/${VIEW}?widget=btn-run-checks&panel=inspect`, `/views/${VIEW}?panel=flows`]) {
				const { context, page } = await open(route, { mode })
				try {
					await page.waitForTimeout(800)
					await expectClean(page, `${mode} ${route}`)
					expect(await page.locator('.kit-btn').count(), route).toBeGreaterThan(0)
				}
				finally { await context.close() }
			}
		}
	}, 240_000)
})
