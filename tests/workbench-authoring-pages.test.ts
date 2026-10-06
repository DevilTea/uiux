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
	for (const route of ['/workspace/settings', '/workspace/locales', '/workspace/assets']) {
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
