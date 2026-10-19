import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Renaming a View and setting or clearing its `feature` tag in place from the View page header, on
 * every device tier (Rule 01a1537a-333f-7246-b39c-5feca6f4b3c7), through `PUT
 * /api/views/:id/metadata` (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85), with the revision conflict
 * handling of the View's other Workbench edits.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const SIZES = {
	desktop: { width: 1440, height: 900 },
	tablet: { width: 1024, height: 768 },
	phone: { width: 390, height: 844 },
} as const

let server: WorkbenchServer
let browser: Browser

const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 15_000 })

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { 'content-type': 'application/json', ...server.headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const result = await response.json() as T
	if (response.status >= 400) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(result)}`)
	return result
}

type ViewRead = { revision: string; resource: { name: string; feature?: string } }
const readView = () => api<ViewRead>(`/api/resources/view/${VIEW_ID}`)

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(size: keyof typeof SIZES): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: SIZES[size], colorScheme: 'light', hasTouch: size !== 'desktop' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/views/${VIEW_ID}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function startRename(page: Page): Promise<void> {
	const header = page.locator('[data-view-header]')
	const name = (await readView()).resource.name
	await header.locator('[data-view-name]').filter({ hasText: name }).waitFor({ timeout: 20_000 })
	await header.getByRole('button', { name: `Rename ${name} or change its feature tag` }).click()
	await header.locator('[data-view-metadata-form]').waitFor()
}

describe('View rename in the View page header (Rule 01a1537a-333f)', () => {
	it('renames the View and changes its feature tag on desktop, with the keyboard', async () => {
		const { context, page } = await open('desktop')
		try {
			await startRename(page)
			const header = page.locator('[data-view-header]')
			const nameInput = header.getByRole('textbox', { name: 'Name' })
			// The form opens with the name field focused and the current values filled in.
			await poll(() => nameInput.evaluate(element => element === document.activeElement)).toBe(true)
			expect(await header.getByRole('textbox', { name: 'Feature' }).inputValue()).toBe('workbench')

			// Escape leaves without saving.
			await nameInput.fill('Not saved')
			await page.keyboard.press('Escape')
			await header.locator('[data-view-metadata-form]').waitFor({ state: 'detached' })
			expect((await readView()).resource.name).toBe('UIUX Workbench — Workspace browser')

			await startRename(page)
			await header.getByRole('textbox', { name: 'Name' }).fill('  Workspace browser  ')
			await header.getByRole('textbox', { name: 'Feature' }).fill('browsing')
			await page.keyboard.press('Enter')
			await poll(async () => (await readView()).resource).toMatchObject({ name: 'Workspace browser', feature: 'browsing' })
			await poll(() => header.locator('[data-view-name]').innerText()).toBe('Workspace browser')
			await poll(() => header.locator('[data-view-feature]').innerText()).toContain('browsing')
			// The breadcrumb follows, and focus returns to the rename button.
			await poll(() => page.getByRole('navigation', { name: 'Location' }).innerText()).toContain('Workspace browser')
			await poll(() => page.evaluate(() => document.activeElement?.hasAttribute('data-view-rename') ?? false)).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('renames the View and clears its feature tag on a tablet', async () => {
		const { context, page } = await open('tablet')
		try {
			await startRename(page)
			const header = page.locator('[data-view-header]')
			await header.getByRole('textbox', { name: 'Name' }).fill('Workspace browser (tablet)')
			await header.getByRole('textbox', { name: 'Feature' }).fill('')
			await header.getByRole('button', { name: 'Save' }).click()
			await poll(async () => (await readView()).resource.name).toBe('Workspace browser (tablet)')
			expect((await readView()).resource.feature).toBeUndefined()
			await poll(() => header.locator('[data-view-name]').innerText()).toBe('Workspace browser (tablet)')
			expect(await header.locator('[data-view-feature]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('renames the View on a phone', async () => {
		const { context, page } = await open('phone')
		try {
			await startRename(page)
			const header = page.locator('[data-view-header]')
			await header.getByRole('textbox', { name: 'Name' }).fill('Workspace browser (phone)')
			await header.getByRole('textbox', { name: 'Feature' }).fill('workbench')
			await header.getByRole('button', { name: 'Save' }).click()
			await poll(async () => (await readView()).resource).toMatchObject({ name: 'Workspace browser (phone)', feature: 'workbench' })
		}
		finally { await context.close() }
	}, 90_000)

	it('keeps the draft on a revision conflict and saves it only when asked again', async () => {
		const { context, page } = await open('desktop')
		try {
			const currentName = (await readView()).resource.name
			await startRename(page)
			let writes = 0
			await page.route('**/api/views/*/metadata', async (route) => {
				writes += 1
				// Someone else edits the View's Spec while the first save is on its way.
				if (writes === 1) {
					const view = await api<ViewRead & { resource: { spec: Record<string, unknown> } }>(`/api/resources/view/${VIEW_ID}`)
					const { intent, entryConditions, interactionRules, constraints, accessibility, references } = view.resource.spec
					await api(`/api/views/${VIEW_ID}/spec`, { expectedRevision: view.revision, spec: { intent: `${intent} (edited)`, entryConditions, interactionRules, constraints, accessibility, references } }, 'PUT')
				}
				await route.continue()
			})
			const header = page.locator('[data-view-header]')
			await header.getByRole('textbox', { name: 'Name' }).fill('Renamed after a conflict')
			await header.getByRole('button', { name: 'Save' }).click()
			const alert = header.locator('[data-view-metadata-conflict]')
			await alert.waitFor()
			expect(await alert.textContent()).toContain('The View changed since you started editing.')
			expect(await header.getByRole('textbox', { name: 'Name' }).inputValue()).toBe('Renamed after a conflict')
			expect((await readView()).resource.name).toBe(currentName)
			expect(writes).toBe(1)

			await alert.getByRole('button', { name: 'Keep editing mine' }).click()
			await alert.waitFor({ state: 'detached' })
			await header.getByRole('button', { name: 'Save' }).click()
			await poll(async () => (await readView()).resource.name).toBe('Renamed after a conflict')
			expect(writes).toBe(2)
		}
		finally { await context.close() }
	}, 90_000)

	it('shows the lease holder and a visible reason when another member holds the View, and names it on a 423', async () => {
		const agent = await provisionToken(server.workspaceRoot, { nickname: 'lease-agent', kind: 'agent', preset: 'editor' })
		const agentWrite = async (name: string) => {
			const view = await readView()
			const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/metadata`, {
				method: 'PUT',
				headers: { 'content-type': 'application/json', ...bearer(agent) },
				body: JSON.stringify({ expectedRevision: view.revision, name }),
			})
			expect(response.status, await response.clone().text()).toBe(200)
		}
		const { context, page } = await open('desktop')
		try {
			await startRename(page)
			const header = page.locator('[data-view-header]')
			// The agent takes the lease while the save is on its way: the save is refused as 423 and the draft kept.
			let tripped = false
			await page.route('**/api/views/*/metadata', async (route) => {
				if (!tripped) {
					tripped = true
					await agentWrite('Agent rename')
				}
				await route.continue()
			})
			await header.getByRole('textbox', { name: 'Name' }).fill('Human rename')
			await header.getByRole('button', { name: 'Save' }).click()
			await poll(() => page.locator('[data-view-header] [role="alert"]').count()).toBeGreaterThan(0)
			expect(await header.getByRole('textbox', { name: 'Name' }).inputValue()).toBe('Human rename')
			// The lease shows in the editing form, Save is disabled and the reason is visible text.
			await header.locator('[data-testid="lock-badge"]').waitFor({ timeout: 15_000 })
			expect(await header.locator('[data-testid="lock-badge"]').innerText()).toContain('lease-agent')
			await header.locator('[data-view-locked-hint]').waitFor()
			expect(await header.locator('[data-view-locked-hint]').innerText()).toBe('Someone else is editing this View.')
			expect(await header.locator('[data-view-metadata-save]').isDisabled()).toBe(true)
			expect((await readView()).resource.name).toBe('Agent rename')
			await header.getByRole('button', { name: 'Cancel' }).click()
			// Outside the form the rename button is disabled while the lease lasts.
			expect(await header.locator('[data-view-rename]').isDisabled()).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('hides the rename button from a member without views.write', async () => {
		const cookie = await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname: 'viewer-only', kind: 'human', keys: ['workspace.read'] }))
		const context = await browser.newContext({ viewport: SIZES.desktop, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addCookies([{ ...cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		try {
			const page = await context.newPage()
			await page.goto(`${server.origin}/views/${VIEW_ID}`, { waitUntil: 'networkidle' })
			const header = page.locator('[data-view-header]')
			await header.locator('[data-view-name]').waitFor({ timeout: 20_000 })
			expect(await header.locator('[data-view-rename]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})
