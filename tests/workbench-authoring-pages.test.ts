import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Roadmap R10 acceptance against the built Workbench and a private copy of the dogfood
 * Workspace: every save goes through the existing domain operation with `expectedRevision`,
 * a concurrent (simulated agent) write raises the conflict alert, a registry key rename shows
 * the reference-impact acknowledgement, and tablet widths are read-only.
 */

let server: WorkbenchServer
let browser: Browser

type WorkspaceRead = { revision: string; resource: { i18n: Record<string, unknown>; adapters: unknown[]; viewports: Record<string, { label?: string; dimensions: { width: number; height: number } }>; themes: Record<string, unknown> } }
type LocaleRead = { revision: string; resource: Record<string, string> }
type AssetRead = { revision: string; resource: { metadata: { name: string; contentFilename: string; mediaType: string }; content: { digest: string } } }

async function api<T>(path: string): Promise<T> {
	return await (await fetch(`${server.origin}${path}`, { headers: server.headers })).json() as T
}

async function readWorkspace(): Promise<WorkspaceRead> {
	return api<WorkspaceRead>('/api/resources/workspace/workspace')
}

/** An agent-side write through the same authoring route, outside the page. */
async function agentPut(path: string, body: unknown): Promise<void> {
	const response = await fetch(`${server.origin}${path}`, { method: 'PUT', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
	if (!response.ok) throw new Error(`Agent write failed: ${response.status} ${await response.text()}`)
}

async function open(path: string, width = 1920, height = 1080): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width, height } })
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

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('Workspace settings page (R10)', () => {
	it('saves one section with expectedRevision and resends the others unchanged', async () => {
		const before = await readWorkspace()
		const { context, page } = await open('/workspace/settings')
		try {
			const requests: unknown[] = []
			page.on('request', (request) => { if (request.url().endsWith('/api/workspace/settings')) requests.push(request.postDataJSON()) })
			const label = page.getByRole('textbox', { name: 'Label for tablet' })
			await label.fill('Tablet landscape')
			await page.locator('#settings-viewports').getByRole('button', { name: 'Save changes' }).click()
			await page.locator('#settings-viewports [data-save-bar]').waitFor({ state: 'detached' })
			const after = await readWorkspace()
			expect(after.revision).not.toBe(before.revision)
			expect(after.resource.viewports.tablet!.label).toBe('Tablet landscape')
			expect(after.resource.themes).toEqual(before.resource.themes)
			expect(after.resource.adapters).toEqual(before.resource.adapters)
			expect(requests).toHaveLength(1)
			expect((requests[0] as { expectedRevision: string }).expectedRevision).toBe(before.revision)
			// A schemaVersion 5 manifest holds no adapters, so the full replace sends none.
			expect((requests[0] as { settings: Record<string, unknown> }).settings).not.toHaveProperty('adapters')
		}
		finally { await context.close() }
	}, 60_000)

	it('shows the conflict alert on a concurrent agent write and keeps the draft', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			const label = page.getByRole('textbox', { name: 'Label for mobile' })
			await label.fill('Phone (mine)')
			const read = await readWorkspace()
			await agentPut('/api/workspace/settings', {
				expectedRevision: read.revision,
				settings: { ...read.resource, schemaVersion: undefined, viewports: { ...read.resource.viewports, mobile: { ...read.resource.viewports.mobile, label: 'Phone (agent)' } } },
			})
			await page.locator('#settings-viewports').getByRole('button', { name: 'Save changes' }).click()
			const alert = page.locator('#settings-viewports [data-conflict-alert]')
			await alert.waitFor()
			expect(await alert.textContent()).toContain('Settings changed since you opened them.')
			expect(await label.inputValue()).toBe('Phone (mine)')
			expect((await readWorkspace()).resource.viewports.mobile!.label).toBe('Phone (agent)')
			await alert.getByRole('button', { name: 'Reload theirs' }).click()
			await alert.waitFor({ state: 'detached' })
			expect(await label.inputValue()).toBe('Phone (agent)')
		}
		finally { await context.close() }
	}, 60_000)

	it('requires the reference-impact acknowledgement before renaming a registry key', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			await page.getByRole('button', { name: 'Actions for desktop' }).click()
			await page.getByRole('menuitem', { name: 'Rename key…' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.getByRole('heading', { name: 'References' }).waitFor()
			await dialog.getByText(/Evidence was captured with|Evidence records? w/).waitFor()
			await dialog.getByRole('textbox', { name: /New key/ }).fill('fhd')
			const confirm = dialog.getByRole('button', { name: 'Rename', exact: true })
			expect(await confirm.isDisabled()).toBe(true)
			await dialog.getByRole('checkbox').check()
			expect(await confirm.isDisabled()).toBe(false)
			await confirm.click()
			await page.locator('#settings-viewports').getByText('Was desktop').waitFor()
			// The rename is only a draft until it is saved.
			expect(Object.keys((await readWorkspace()).resource.viewports)).toContain('desktop')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Locales page (R10)', () => {
	it('saves one Locale with its revision and raises the conflict alert on a concurrent write', async () => {
		const before = await api<LocaleRead>('/api/resources/locale/zh-TW')
		const key = Object.keys(before.resource)[0]!
		const { context, page } = await open('/workspace/locales')
		try {
			await page.getByRole('button', { name: `Edit ${key} in zh-TW` }).click()
			const editor = page.getByRole('textbox', { name: `${key} in zh-TW` })
			await editor.fill('已更新')
			await editor.press('Enter')
			await page.getByRole('button', { name: 'Save zh-TW' }).click()
			await page.getByRole('button', { name: 'Save zh-TW' }).waitFor({ state: 'detached' })
			const saved = await api<LocaleRead>('/api/resources/locale/zh-TW')
			expect(saved.revision).not.toBe(before.revision)
			expect(saved.resource[key]).toBe('已更新')

			// A concurrent agent write while a draft exists.
			await page.getByRole('button', { name: `Edit ${key} in zh-TW` }).click()
			await page.getByRole('textbox', { name: `${key} in zh-TW` }).fill('我的版本')
			await page.getByRole('textbox', { name: `${key} in zh-TW` }).press('Enter')
			await agentPut('/api/locales/zh-TW', { expectedRevision: saved.revision, messages: { ...saved.resource, [key]: 'agent 版本' } })
			await page.getByRole('button', { name: 'Save zh-TW' }).click()
			const alert = page.locator('[data-conflict-alert]')
			await alert.waitFor()
			expect(await alert.textContent()).toContain('zh-TW changed since you opened it.')
			expect((await api<LocaleRead>('/api/resources/locale/zh-TW')).resource[key]).toBe('agent 版本')
		}
		finally { await context.close() }
	}, 60_000)

	it('reports missing and extra keys against the primary Locale', async () => {
		const zh = await api<LocaleRead>('/api/resources/locale/zh-TW')
		const [dropped, ...rest] = Object.keys(zh.resource)
		const messages = Object.fromEntries([...rest.map(key => [key, zh.resource[key]!]), ['only.in.zh', '只在 zh-TW']])
		await agentPut('/api/locales/zh-TW', { expectedRevision: zh.revision, messages })
		const { context, page } = await open('/workspace/locales')
		try {
			const row = page.locator('[data-locale-diff-row="zh-TW"]')
			await row.waitFor()
			expect(await row.textContent()).toContain('1 missing')
			expect(await row.textContent()).toContain('1 extra')
			expect(await row.textContent()).toContain(dropped)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Assets page (R10)', () => {
	it('edits metadata through the Asset replace operation and keeps the content bytes', async () => {
		const list = await (await fetch(`${server.origin}/api/resources/list`, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ kinds: ['asset'], limit: 10 }) })).json() as { items: { key: string }[] }
		const id = list.items[0]!.key
		const before = await api<AssetRead>(`/api/resources/asset/${id}`)
		const { context, page } = await open('/workspace/assets')
		try {
			await page.locator('[data-asset-tile]').first().click()
			const dialog = page.getByRole('dialog')
			await dialog.getByRole('textbox', { name: /^Name/ }).fill('Renamed icon')
			await dialog.getByRole('button', { name: 'Save changes' }).click()
			await dialog.getByRole('button', { name: 'Save changes' }).waitFor({ state: 'detached' })
			const after = await api<AssetRead>(`/api/resources/asset/${id}`)
			expect(after.revision).not.toBe(before.revision)
			expect(after.resource.metadata.name).toBe('Renamed icon')
			expect(after.resource.content.digest).toBe(before.resource.content.digest)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Tablet is read-only (R10)', () => {
	for (const route of ['/workspace/settings', '/workspace/product-kit', '/workspace/locales', '/workspace/assets']) {
		it(`shows "Edit on desktop" and no editable fields on ${route} at 1024×768`, async () => {
			const { context, page } = await open(route, 1024, 768)
			try {
				await page.locator('[data-access-notice]').waitFor()
				expect(await page.locator('[data-access-notice]').textContent()).toContain('Edit on desktop')
				const main = page.locator('main').first()
				// Search and filter inputs are reading aids, not authoring fields.
				const editable = await main.locator('input:not([type="search"]):not([disabled]):not([readonly]):not([placeholder^="Filter"]), textarea:not([disabled]):not([readonly])').count()
				expect(editable).toBe(0)
				for (const name of ['Save changes', 'Add viewport', 'Add adapter', 'New Locale', 'Add key', 'Upload'])
					expect(await main.getByRole('button', { name, exact: true }).count(), name).toBe(0)
				expect(await main.locator('[data-locale-cell]').count()).toBe(0)
			}
			finally { await context.close() }
		}, 60_000)
	}
})

describe('Workspace pages navigation', () => {
	it('reaches Settings, Product Kit, Access presets, Locales and Assets from one sidebar entry and the pages\' own sub-navigation', async () => {
		const { context, page } = await open('/')
		try {
			const sidebar = page.locator('[data-landmark="navigation"]')
			for (const name of ['Settings', 'Product Kit', 'Locales', 'Assets', 'Adapters'])
				expect(await sidebar.getByRole('link', { name, exact: true }).count(), name).toBe(0)
			await sidebar.getByRole('link', { name: 'Workspace', exact: true }).click()
			await page.waitForURL(url => url.pathname === '/workspace/settings')
			const subnav = page.getByRole('navigation', { name: 'Workspace pages' })
			// Rule 01a116f0-8a01-7cd2-807d-cc26f7bf8b16: the sub-navigation, in this order.
			expect((await subnav.getByRole('link').allInnerTexts()).map(text => text.trim())).toEqual(['Settings', 'Product Kit', 'Access presets', 'Locales', 'Assets'])
			await subnav.getByRole('link', { name: 'Product Kit' }).click()
			await page.waitForURL(url => url.pathname === '/workspace/product-kit')
			await page.locator('#product-kit-overview').waitFor()
			expect(await page.getByRole('heading', { level: 1 }).innerText()).toBe('Product Kit')
			await subnav.getByRole('link', { name: 'Locales' }).click()
			await page.waitForURL(url => url.pathname === '/workspace/locales')
			// The one sidebar entry stays marked on every Workspace page.
			expect(await sidebar.getByRole('link', { name: 'Workspace', exact: true }).getAttribute('aria-current')).toBe('page')
		}
		finally { await context.close() }
	}, 60_000)

	it('has no Adapters section in Settings (Rule 01a116f0-8a46-76bc-a29f-affaa302c44c)', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			await page.locator('#settings-themes').waitFor()
			expect(await page.locator('#settings-adapters').count()).toBe(0)
			expect(await page.locator('[data-adapter-row]').count()).toBe(0)
			const index = page.getByRole('navigation', { name: 'Settings sections' })
			expect((await index.locator('a, button').allInnerTexts()).map(text => text.trim())).toEqual(['General', 'Viewports', 'Themes'])
		}
		finally { await context.close() }
	}, 60_000)

	for (const retired of ['/workspace/adapters', '/workspace/settings?section=adapters']) {
		it(`redirects ${retired} to the Overview section of the Product Kit page`, async () => {
			const { context, page } = await open(retired)
			try {
				await page.waitForURL(url => url.pathname === '/workspace/product-kit' && url.searchParams.get('section') === 'overview')
				await page.locator('#product-kit-overview #product-kit-adapters').waitFor()
			}
			finally { await context.close() }
		}, 60_000)
	}

	it('opens Settings at the section `?section=` names (Clause 01a116f0-9782-7640-865e-c340df7b06b0)', async () => {
		const { context, page } = await open('/workspace/settings?section=themes')
		try {
			await page.locator('#settings-themes').waitFor()
			await page.waitForFunction(() => (document.querySelector('#settings-themes')?.closest('[role="region"]')?.scrollTop ?? 0) > 0)
		}
		finally { await context.close() }
	}, 60_000)

	it('opens the Product Kit page from ⌘K "Adapters"', async () => {
		const { context, page } = await open('/workspace/settings')
		try {
			await page.locator('#settings-general').waitFor()
			await page.keyboard.press('ControlOrMeta+k')
			const search = page.locator('[role="dialog"] input').first()
			await search.waitFor()
			await search.fill('Adapters')
			const option = page.locator('[role="option"]').filter({ hasText: 'Adapters' }).first()
			await option.waitFor()
			await option.click()
			await page.waitForURL(url => url.pathname === '/workspace/product-kit' && url.searchParams.get('section') === 'overview')
			await page.locator('#product-kit-adapters').waitFor()
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit › Adapters on a schemaVersion 5 Workspace', () => {
	type ProductKitRead = { revision: string; resource: { adapters: { moduleSpecifier: string; config?: unknown }[] } }

	/**
	 * Discussion #139 owner ruling 6: the section reads and writes the Product Kit file through the
	 * Product Kit operations, never the manifest's `adapters`, which a schemaVersion 5 manifest refuses.
	 */
	it('saves an Adapter config through update_product_kit and sends no adapters to the Workspace settings', async () => {
		const before = await api<ProductKitRead>('/api/product-kit')
		const workspaceBefore = await readWorkspace()
		expect(workspaceBefore.resource).not.toHaveProperty('adapters')
		expect(before.resource.adapters.map(adapter => adapter.moduleSpecifier)).toEqual(['./adapters/reference.ts'])
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			const requests: { url: string; body: unknown }[] = []
			page.on('request', (request) => {
				if (request.method() === 'PUT') requests.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() })
			})
			const section = page.locator('#product-kit-adapters')
			await section.getByText('Packages or kit/ modules that supply Widgets').waitFor()
			await section.getByRole('button', { name: 'Config', exact: true }).click()
			const config = section.getByRole('textbox', { name: 'Config for ./adapters/reference.ts' })
			await config.fill('{"note":"kit"}')
			await section.getByRole('button', { name: 'Save changes' }).click()
			await section.locator('[data-save-bar]').waitFor({ state: 'detached' })
			const after = await api<ProductKitRead>('/api/product-kit')
			expect(after.revision).not.toBe(before.revision)
			expect(after.resource.adapters).toEqual([{ moduleSpecifier: './adapters/reference.ts', config: { note: 'kit' } }])
			expect(requests.map(request => request.url)).toEqual(['/api/product-kit/settings'])
			expect(requests[0]!.body).toMatchObject({ expectedRevision: before.revision, adapters: [{ moduleSpecifier: './adapters/reference.ts', config: { note: 'kit' } }] })
			expect((await readWorkspace()).revision).toBe(workspaceBefore.revision)

			// Clearing the config stores the entry without one.
			await config.fill('')
			await section.getByRole('button', { name: 'Save changes' }).click()
			await section.locator('[data-save-bar]').waitFor({ state: 'detached' })
			expect((await api<ProductKitRead>('/api/product-kit')).resource.adapters).toEqual([{ moduleSpecifier: './adapters/reference.ts' }])
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Product Kit › Adapters when the config write fails after the specifiers are saved', () => {
	type ProductKitRead = { revision: string; resource: { adapters: { moduleSpecifier: string; config?: unknown }[] } }

	/**
	 * The section saves in two writes, `compose` then `settings`. When `compose` lands and `settings`
	 * fails, the section reloads the Product Kit file and carries the draft onto it (keep mine), says
	 * the specifiers were saved and the config was not, and raises no conflict over its own write.
	 */
	it('keeps the unsaved config on the composed revision and saves it on the next try', async () => {
		const before = await api<ProductKitRead>('/api/product-kit')
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			const requests: { url: string; body: unknown }[] = []
			page.on('request', (request) => {
				if (request.method() === 'PUT') requests.push({ url: new URL(request.url()).pathname, body: request.postDataJSON() })
			})
			await page.route('**/api/product-kit/settings', route => route.fulfill({
				status: 500,
				contentType: 'application/json',
				body: JSON.stringify({ statusCode: 500, statusMessage: 'Server Error', message: 'The config write failed.' }),
			}))
			const section = page.locator('#product-kit-adapters')
			await section.getByText('Packages or kit/ modules that supply Widgets').waitFor()
			await section.locator('[data-adapter-specifier]').fill('./adapters/second.ts')
			await section.getByRole('button', { name: 'Config', exact: true }).click()
			const config = section.getByRole('textbox', { name: /^Config for / })
			await config.fill('{"note":"second"}')
			await section.getByRole('button', { name: 'Save changes' }).click()

			await section.getByText('Specifiers saved, config not saved').waitFor()
			const composed = await api<ProductKitRead>('/api/product-kit')
			expect(composed.revision).not.toBe(before.revision)
			expect(composed.resource.adapters).toEqual([{ moduleSpecifier: './adapters/second.ts' }])
			expect(requests.map(request => request.url)).toEqual(['/api/product-kit/compose', '/api/product-kit/settings'])
			expect(await section.getByText('The Product Kit changed since you opened it.').count()).toBe(0)
			expect(await config.inputValue()).toBe('{"note":"second"}')
			await section.locator('[data-save-bar]').waitFor()

			// The next save sends only the config, against the composed revision.
			await page.unroute('**/api/product-kit/settings')
			requests.length = 0
			await section.getByRole('button', { name: 'Save changes' }).click()
			await section.locator('[data-save-bar]').waitFor({ state: 'detached' })
			expect(requests.map(request => request.url)).toEqual(['/api/product-kit/settings'])
			expect(requests[0]!.body).toMatchObject({ expectedRevision: composed.revision })
			expect((await api<ProductKitRead>('/api/product-kit')).resource.adapters).toEqual([{ moduleSpecifier: './adapters/second.ts', config: { note: 'second' } }])
		}
		finally {
			await context.close()
			const current = await api<ProductKitRead>('/api/product-kit')
			await agentPut('/api/product-kit/compose', { expectedRevision: current.revision, designSystems: [], adapters: ['./adapters/reference.ts'] })
		}
	}, 60_000)

	it('raises the conflict instead when someone else wrote the Product Kit after the compose', async () => {
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			// Another writer changes the file between this save's compose and its failed settings write.
			await page.route('**/api/product-kit/settings', async (route) => {
				const current = await api<ProductKitRead>('/api/product-kit')
				await agentPut('/api/product-kit/compose', { expectedRevision: current.revision, designSystems: [], adapters: ['./adapters/third.ts'] })
				await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ statusCode: 500, statusMessage: 'Server Error', message: 'The config write failed.' }) })
			})
			const section = page.locator('#product-kit-adapters')
			await section.getByText('Packages or kit/ modules that supply Widgets').waitFor()
			await section.locator('[data-adapter-specifier]').fill('./adapters/second.ts')
			await section.getByRole('button', { name: 'Config', exact: true }).click()
			await section.getByRole('textbox', { name: /^Config for / }).fill('{"note":"second"}')
			await section.getByRole('button', { name: 'Save changes' }).click()

			await section.getByText('The Product Kit changed since you opened it.').waitFor()
			expect(await section.getByText('Specifiers saved, config not saved').count()).toBe(0)
			expect((await api<ProductKitRead>('/api/product-kit')).resource.adapters).toEqual([{ moduleSpecifier: './adapters/third.ts' }])
		}
		finally {
			await context.close()
			const current = await api<ProductKitRead>('/api/product-kit')
			await agentPut('/api/product-kit/compose', { expectedRevision: current.revision, designSystems: [], adapters: ['./adapters/reference.ts'] })
		}
	}, 60_000)
})
