import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workspace pages (Settings, Locales, Assets, Product Kit, Access presets) build their buttons, badges, icons,
 * skeletons and the key-change checkbox from the Kit components in `app/components/kit/` instead of Nuxt UI
 * primitives (Discussion #379 D1, issue #380). The test guards that the Kit renders them with the state the pages
 * relied on: pressed and expanded toggles, the joined layout toggle, the 44px icon-only target on touch, a skeleton
 * that names its region, and an icon whose meaning is its name.
 */

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

type Setup = Readonly<{ touch?: boolean; delayApi?: boolean }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: 1920, height: 1080 },
		colorScheme: 'light',
		...(setup.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	if (setup.delayApi) {
		await page.route('**/api/**', async (route) => {
			if (!route.request().url().includes('/api/health')) await new Promise(resolve => setTimeout(resolve, 3000))
			await route.continue()
		})
	}
	await page.goto(`${server.origin}${path}`, { waitUntil: setup.delayApi ? 'domcontentloaded' : 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const hasClass = (locator: Locator, name: string) => locator.evaluate((element, expected) => element.classList.contains(expected), name)

describe('Workspace pages use the Kit components (#380)', () => {
	it('Settings: Kit buttons and badges, a primary Save and an icon-only row menu', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			const add = page.getByRole('button', { name: 'Add viewport' })
			expect(await hasClass(add, 'kit-btn')).toBe(true)
			expect(await add.locator('svg.kit-icon').count()).toBe(1)
			await add.click()
			const bar = page.locator('#settings-viewports [data-save-bar]')
			await bar.waitFor()
			expect(await hasClass(bar.getByRole('button', { name: 'Save changes' }), 'kit-btn--primary')).toBe(true)
			expect(await hasClass(bar.getByRole('button', { name: 'Discard' }), 'kit-btn--ghost')).toBe(true)
			// The new row says so in a Kit outline badge.
			expect(await page.locator('#settings-viewports .kit-badge--outline').count()).toBeGreaterThan(0)
			const actions = page.locator('#settings-viewports button[aria-label^="Actions for"]').first()
			expect(await hasClass(actions, 'is-icon-only')).toBe(true)
			expect(await actions.getAttribute('aria-haspopup')).toBe('menu')
		}
		finally { await context.close() }
	}, 60_000)

	it('Settings: the rename confirmation is a Kit checkbox that enables the Kit confirm button', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			await page.getByRole('button', { name: 'Actions for desktop' }).click()
			await page.getByRole('menuitem', { name: 'Rename key…' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.getByRole('textbox', { name: /New key/ }).fill('fhd')
			const confirm = dialog.getByRole('button', { name: 'Rename', exact: true })
			expect(await hasClass(confirm, 'kit-btn--primary')).toBe(true)
			expect(await confirm.isDisabled()).toBe(true)
			const box = dialog.locator('.kit-checkbox input[type="checkbox"]')
			expect(await box.count()).toBe(1)
			await box.check()
			expect(await confirm.isDisabled()).toBe(false)
			await box.uncheck()
			expect(await confirm.isDisabled()).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('Assets: the layout switch is one Kit group of pressed toggles', async () => {
		const { context, page } = await open('/workspace/assets')
		try {
			const group = page.locator('.kit-btn-group')
			await group.waitFor()
			const grid = group.getByRole('button', { name: 'Grid', exact: true })
			const list = group.getByRole('button', { name: 'List', exact: true })
			expect(await grid.getAttribute('aria-pressed')).toBe('true')
			expect(await list.getAttribute('aria-pressed')).toBe('false')
			expect(await hasClass(grid, 'is-pressed')).toBe(true)
			expect(await hasClass(grid, 'is-icon-only')).toBe(true)
			await list.click()
			expect(await list.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(list, 'is-pressed')).toBe(true)
			expect(await grid.getAttribute('aria-pressed')).toBe('false')
			// The Nuxt UI tooltip names it, so the Kit's native title does not repeat it.
			expect(await grid.getAttribute('title')).toBe('')
			// The usage badges are Kit badges.
			expect(await page.locator('[data-asset-tile] .kit-badge, table .kit-badge').count()).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('Product Kit: the Config disclosure is a Kit button that reports and turns with its state', async () => {
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			const toggle = page.getByRole('button', { name: 'Config' })
			await toggle.waitFor()
			expect(await hasClass(toggle, 'kit-btn--link-muted')).toBe(true)
			expect(await toggle.getAttribute('aria-expanded')).toBe('false')
			expect(await hasClass(toggle, 'is-expanded')).toBe(false)
			await toggle.click()
			expect(await toggle.getAttribute('aria-expanded')).toBe('true')
			expect(await hasClass(toggle, 'is-expanded')).toBe(true)
			// The build state and each Adapter's status are Kit badges with an icon.
			expect(await page.locator('[data-kit-build-state] .kit-badge:has(svg.kit-icon)').count()).toBe(1)
			expect(await page.locator('[data-adapter-row] .kit-badge:has(svg.kit-icon)').count()).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('Locales: an edited cell carries a named marker (the Kit icon itself is decorative)', async () => {
		const { context, page } = await open('/workspace/locales')
		try {
			const read = await (await fetch(`${server.origin}/api/resources/locale/zh-TW`, { headers: server.headers })).json() as { resource: Record<string, string> }
			const key = Object.keys(read.resource)[0]!
			expect(await page.locator('[role="img"][aria-label="Edited"]').count()).toBe(0)
			await page.getByRole('button', { name: `Edit ${key} in zh-TW` }).click()
			const editor = page.getByRole('textbox', { name: `${key} in zh-TW` })
			await editor.fill('已更新')
			await editor.press('Enter')
			const marker = page.locator('[role="img"][aria-label="Edited"]')
			await marker.first().waitFor()
			expect(await marker.first().locator('svg.kit-icon[aria-hidden="true"]').count()).toBe(1)
			// The page's own buttons are Kit buttons too.
			expect(await hasClass(page.getByRole('button', { name: 'New Locale' }), 'kit-btn')).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('Access presets: the add button, row menu and key count are Kit buttons', async () => {
		const { context, page } = await open('/workspace/access-presets')
		try {
			const add = page.locator('[data-preset-add]')
			await add.waitFor()
			expect(await hasClass(add, 'kit-btn--primary')).toBe(true)
			expect(await hasClass(page.locator('[data-preset-actions]').first(), 'is-icon-only')).toBe(true)
			expect(await hasClass(page.locator('[data-preset-key-count]').first(), 'kit-btn--link-muted')).toBe(true)
			await add.click()
			const save = page.locator('[data-preset-editor-save]')
			await save.waitFor()
			expect(await hasClass(save, 'kit-btn--primary')).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('renders every Kit component it names (an unimported tag would render as an unknown element)', async () => {
		const unknown = 'kitbutton, kitbadge, kiticon, kitskeleton, kitbuttongroup, kitcheckbox, kitkbd'
		const routes = ['/workspace/settings', '/workspace/locales', '/workspace/assets', '/workspace/access-presets', '/workspace/product-kit?section=overview', '/workspace/product-kit?section=components', '/workspace/product-kit?section=styles', '/workspace/product-kit?section=files']
		for (const route of routes) {
			const { context, page } = await open(route)
			try {
				await page.waitForTimeout(500)
				expect(await page.locator(unknown).count(), route).toBe(0)
				expect(await page.locator('.kit-btn, .kit-badge, .kit-icon').count(), route).toBeGreaterThan(0)
			}
			finally { await context.close() }
		}
	}, 120_000)

	it('keeps every page inside a 390px phone (Kit buttons do not wrap their label, so tables scroll in their own box)', async () => {
		const routes = ['/workspace/settings', '/workspace/locales', '/workspace/assets', '/workspace/access-presets', '/workspace/product-kit?section=overview', '/workspace/product-kit?section=components', '/workspace/product-kit?section=styles', '/workspace/product-kit?section=files']
		for (const route of routes) {
			const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true })
			await context.addInitScript(() => { localStorage.setItem('uiux.workbench.locale', 'en-US') })
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			try {
				await page.goto(`${server.origin}${route}`, { waitUntil: 'networkidle' })
				await page.locator('main').first().waitFor()
				const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
				expect(overflow, route).toBeLessThanOrEqual(0)
			}
			finally { await context.close() }
		}
	}, 120_000)

	it('a loading page shows Kit skeletons that name their region and keep the reveal delay class', async () => {
		const { context, page } = await open('/workspace/settings', { delayApi: true })
		try {
			const skeleton = page.locator('.kit-skeleton').first()
			await skeleton.waitFor({ timeout: 10_000 })
			expect(await skeleton.getAttribute('aria-label')).toBe('Loading')
			expect(await hasClass(skeleton, 'wb-skeleton')).toBe(true)
			expect(await hasClass(skeleton, 'animate-pulse')).toBe(true)
			expect((await skeleton.boundingBox())?.height).toBe(20)
		}
		finally { await context.close() }
	}, 60_000)

	it('on a touch screen an icon-only Workspace button is as wide as the 44px target is high', async () => {
		const { context, page } = await open('/workspace/settings', { touch: true })
		try {
			const actions = page.locator('#settings-viewports button[aria-label^="Actions for"]').first()
			await actions.waitFor()
			expect(await hasClass(actions, 'is-icon-only')).toBe(true)
			expect((await actions.boundingBox())?.width).toBeGreaterThanOrEqual(44)
			expect((await actions.boundingBox())?.height).toBeGreaterThanOrEqual(44)
		}
		finally { await context.close() }
	}, 60_000)
})
