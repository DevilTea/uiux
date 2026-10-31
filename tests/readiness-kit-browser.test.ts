import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The readiness area (Overview Checks and Activity, a View's Readiness tab, the Evidence sheet, the Capture
 * slide-over and the Handoff export dialog) builds its buttons, badges, icons and skeletons from the Kit
 * components in `app/components/kit/` instead of Nuxt UI primitives (Discussion #379 D1, issue #380). The test
 * guards that the Kit renders them with the state the area relied on: pressed and expanded toggles, a primary
 * action per region, icon-only buttons that keep their accessible name and the 44px touch target, and that no
 * Kit tag is left unresolved.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

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

type Setup = Readonly<{ touch?: boolean; width?: number; height?: number }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: 'light',
		...(setup.touch ? { hasTouch: true } : {}),
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

async function openReadiness(setup: Setup = {}): Promise<{ context: BrowserContext; page: Page; tab: Locator }> {
	const { context, page } = await open(`/views/${VIEW_ID}?panel=readiness`, setup)
	const tab = page.locator('[data-readiness-tab]')
	await tab.locator('[data-readiness-badge]').waitFor({ timeout: 30_000 })
	return { context, page, tab }
}

describe('The readiness area uses the Kit components (#380)', () => {
	it('Readiness tab: Kit status badge, icon-only recheck, expanded-state toggle and xs actions', async () => {
		const { context, tab } = await openReadiness()
		try {
			const badge = tab.locator('[data-readiness-badge]')
			expect(await hasClass(badge, 'kit-badge')).toBe(true)
			expect(await hasClass(badge, 'kit-badge--tone-danger')).toBe(true)

			const recheck = tab.getByRole('button', { name: 'Recheck' })
			expect(await hasClass(recheck, 'is-icon-only')).toBe(true)
			expect(await hasClass(recheck, 'kit-btn--xs')).toBe(true)
			expect(await recheck.locator('svg.kit-icon').count()).toBe(1)

			for (const selector of ['[data-capture-open]', '[data-export-open]']) {
				const action = tab.locator(selector).first()
				expect(await hasClass(action, 'kit-btn--xs'), selector).toBe(true)
				expect(await action.locator('svg.kit-icon').count(), selector).toBe(1)
			}

			// The facet and diagnostic icons are Kit icons too.
			expect(await tab.locator('[data-facet] > svg.kit-icon').count()).toBe(4)
			expect(await tab.locator('[data-handoff-diagnostics="blocking"] li svg.kit-icon').count()).toBeGreaterThan(0)

			// The "needs a fresh run" list collapses behind a disclosure with aria-expanded (no chevron to turn).
			const more = tab.locator('[data-evidence-stale-list] button[aria-expanded]')
			expect(await hasClass(more, 'kit-btn--link-muted')).toBe(true)
			expect(await more.getAttribute('aria-expanded')).toBe('false')
			await more.click()
			expect(await more.getAttribute('aria-expanded')).toBe('true')
			expect(await hasClass(more, 'is-expanded')).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('Readiness tab: the Evidence sheet badges are Kit badges and the viewer toggles are pressed and expanded', async () => {
		const { context, page, tab } = await openReadiness()
		try {
			const tile = tab.locator('[data-evidence-tile]').first()
			await tile.scrollIntoViewIfNeeded()
			expect(await tile.locator('.kit-badge').count()).toBe(1)
			await tile.getByRole('button').click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()

			const details = dialog.getByRole('button', { name: 'Details' })
			expect(await hasClass(details, 'kit-btn--ghost')).toBe(true)
			expect(await details.getAttribute('aria-expanded')).toBe('false')
			await details.click()
			expect(await details.getAttribute('aria-expanded')).toBe('true')
			expect(await hasClass(details, 'is-expanded')).toBe(true)
			const copy = dialog.getByRole('button', { name: 'Copy Evidence ID' })
			expect(await hasClass(copy, 'is-icon-only')).toBe(true)

			const size = dialog.getByRole('button', { name: 'Actual size' })
			expect(await size.getAttribute('aria-pressed')).toBe('false')
			await size.click()
			const fit = dialog.getByRole('button', { name: 'Fit' })
			expect(await fit.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(fit, 'is-pressed')).toBe(true)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Capture slide-over: Kit buttons with a primary Capture, and rows keep an icon-only remove', async () => {
		const { context, page, tab } = await openReadiness()
		try {
			await tab.locator('[data-capture-open]').click()
			const sheet = page.getByRole('dialog')
			await sheet.locator('[data-capture-row]').first().waitFor()
			expect(await hasClass(sheet.locator('[data-capture-add]'), 'kit-btn--sm')).toBe(true)
			expect(await hasClass(sheet.locator('[data-capture-run]'), 'kit-btn--primary')).toBe(true)
			const expand = sheet.locator('[data-capture-expand="themes"]')
			expect(await hasClass(expand, 'kit-btn--ghost')).toBe(true)
			await expand.click()
			const remove = sheet.locator('[data-capture-row] button.is-icon-only').first()
			expect(await hasClass(remove, 'kit-btn--xs')).toBe(true)
			expect(await remove.getAttribute('aria-label')).toMatch(/^Remove /)
			// The row checkboxes keep their accessible name (the Kit Checkbox takes it from visible text only).
			expect(await sheet.getByRole('checkbox', { name: /^Capture / }).count()).toBeGreaterThan(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Handoff export dialog: Kit primary export, Kit recheck and a Kit badge on the result', async () => {
		const { context, page, tab } = await openReadiness()
		try {
			await tab.locator('[data-export-open]').click()
			const dialog = page.getByRole('dialog')
			await dialog.locator('[data-handoff-state]').waitFor({ timeout: 30_000 })
			const run = dialog.locator('[data-handoff-export]')
			expect(await hasClass(run, 'kit-btn--primary')).toBe(true)
			expect(await hasClass(dialog.getByRole('button', { name: 'Recheck' }), 'kit-btn--xs')).toBe(true)
			expect(await dialog.locator('[data-handoff-state] svg.kit-icon').count()).toBe(1)
			await run.click()
			const claim = dialog.locator('[data-handoff-claim]')
			await claim.waitFor({ timeout: 30_000 })
			expect(await hasClass(claim, 'kit-badge')).toBe(true)
			expect(await dialog.locator('button.kit-btn--primary', { hasText: 'Close' }).count()).toBe(1)
			expect(await hasClass(dialog.getByRole('button', { name: 'Copy bundle ID' }), 'is-icon-only')).toBe(true)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('Overview Checks: a primary Run checks and Kit state icons on every source', async () => {
		const { context, page } = await open('/?tab=checks')
		try {
			const run = page.locator('[data-run-checks]')
			await run.waitFor()
			expect(await hasClass(run, 'kit-btn--primary')).toBe(true)
			expect(await page.locator('[data-check-source] > svg.kit-icon').count()).toBeGreaterThan(0)
			await run.click()
			// The fixture has no findings, so the run ends in the empty state; its sources keep their Kit icons.
			await page.locator('[data-check-source="validation"][data-check-source-state="completed"]').waitFor({ timeout: 60_000 })
			expect(await page.locator('[data-kit-check] > svg.kit-icon').count()).toBeGreaterThan(0)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('renders every Kit component it names on Overview Checks, Activity and the Readiness tab', async () => {
		for (const route of ['/?tab=checks', '/?tab=activity', `/views/${VIEW_ID}?panel=readiness`]) {
			const { context, page } = await open(route)
			try {
				await page.waitForTimeout(800)
				expect(await page.locator(UNKNOWN_KIT_TAGS).count(), route).toBe(0)
				expect(await page.locator('main .kit-btn, main .kit-icon, main .kit-badge, [data-readiness-tab] .kit-icon').count(), route).toBeGreaterThan(0)
			}
			finally { await context.close() }
		}
	}, 120_000)

	it('on a touch screen an icon-only readiness button is as wide as the 44px target is high', async () => {
		const { context, tab } = await openReadiness({ touch: true })
		try {
			const recheck = tab.getByRole('button', { name: 'Recheck' })
			expect(await hasClass(recheck, 'is-icon-only')).toBe(true)
			const box = await recheck.boundingBox()
			expect(box?.width).toBeGreaterThanOrEqual(44)
			expect(box?.height).toBeGreaterThanOrEqual(44)
		}
		finally { await context.close() }
	}, 90_000)
})
