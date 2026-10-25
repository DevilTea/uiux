import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Workbench confirmation of the reference-impact acknowledgement (issue #75; Rules
 * 01a1144e-50dd-7b92-aa5e-e175e34bf424 and 01a172ce-31eb-7b81-afd6-ddd6855cc30e) against the built
 * Workbench and a private copy of the frozen fixture Workspace:
 *
 * - deleting a View lists the Review threads anchored in it and deletes only after "Delete anyway",
 *   leaving the threads untouched;
 * - deleting an Asset nothing binds needs no acknowledgement;
 * - saving a Workspace settings change that removes a viewport key lists the threads whose render
 *   context names it and saves only after "Save anyway".
 *
 * Every test seeds its own resources through the API, so the tests run in any order.
 */

let server: WorkbenchServer
let browser: Browser

async function api<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

async function status(path: string): Promise<number> {
	return (await fetch(`${server.origin}${path}`, { headers: server.headers })).status
}

const unique = () => randomUUID().slice(0, 8)
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

async function seedView(name: string): Promise<string> {
	const spec = { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	return (await api<{ key: string }>('/api/views', { name, spec })).key
}

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

const deleteDialog = (page: Page) => page.locator('[data-delete-dialog]')

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('deleting a View from its page', () => {
	it('lists the impact, deletes nothing on Cancel, and deletes only after "Delete anyway", leaving the thread untouched', async () => {
		const viewId = await seedView(`Doomed ${unique()}`)
		const thread = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId, widgetId: 'root' } })
		const { context, page } = await open(`/views/${viewId}`)
		try {
			await page.locator('[data-delete-resource]').click()
			const dialog = deleteDialog(page)
			await dialog.waitFor()
			expect(await dialog.getAttribute('data-stage')).toBe('confirm')
			await expect.poll(() => page.locator('[data-delete-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			// Focus starts on Cancel, the safe choice.
			await expect.poll(() => page.evaluate(() => !!document.activeElement?.matches('[data-delete-cancel]'))).toBe(true)

			await page.locator('[data-delete-confirm]').click()
			await page.locator('[data-delete-dialog][data-stage="impact"]').waitFor()
			expect(await page.getByRole('dialog').getByText('Delete anyway?').count()).toBeGreaterThan(0)
			const items = page.locator('[data-delete-dialog] [data-impact-item][data-category="review_anchor_invalidated"]')
			expect(await items.count()).toBe(1)
			// Nothing was deleted by the first request.
			expect(await status(`/api/resources/view/${viewId}`)).toBe(200)

			await page.locator('[data-delete-cancel]').click()
			await deleteDialog(page).waitFor({ state: 'detached' })
			expect(await status(`/api/resources/view/${viewId}`)).toBe(200)

			await page.locator('[data-delete-resource]').click()
			await expect.poll(() => page.locator('[data-delete-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			await page.locator('[data-delete-confirm]').click()
			await page.locator('[data-delete-acknowledge]').click()
			await deleteDialog(page).waitFor({ state: 'detached' })
			await expect.poll(() => status(`/api/resources/view/${viewId}`)).toBe(404)
			// The thread keeps its anchor: nothing cascades.
			const kept = await api<{ resource: { anchor: { viewId: string } } }>(`/api/resources/review/${thread.key}`)
			expect(kept.resource.anchor.viewId).toBe(viewId)
			expect(new URL(page.url()).pathname).not.toBe(`/views/${viewId}`)
		}
		finally { await context.close() }
	}, 90_000)

	it('deletes a View nothing refers to straight after the confirmation, and names a conflict instead of deleting over it', async () => {
		const viewId = await seedView(`Quiet ${unique()}`)
		const { context, page } = await open(`/views/${viewId}`)
		try {
			await page.locator('[data-delete-resource]').click()
			await expect.poll(() => page.locator('[data-delete-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			// Someone else saves the View after the dialog opened: the delete conflicts.
			const read = await api<{ revision: string; resource: { spec: Record<string, unknown> } }>(`/api/resources/view/${viewId}`)
			const spec = { ...read.resource.spec, intent: 'Changed meanwhile' }
			delete spec.decisions
			await api(`/api/views/${viewId}/spec`, { expectedRevision: read.revision, spec }, 'PUT')
			await page.locator('[data-delete-confirm]').click()
			await page.locator('[data-delete-dialog][data-stage="conflict"]').waitFor()
			expect(await status(`/api/resources/view/${viewId}`)).toBe(200)

			await page.locator('[data-delete-reload]').click()
			await page.locator('[data-delete-dialog][data-stage="confirm"]').waitFor()
			await expect.poll(() => page.locator('[data-delete-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			await page.locator('[data-delete-confirm]').click()
			await deleteDialog(page).waitFor({ state: 'detached' })
			await expect.poll(() => status(`/api/resources/view/${viewId}`)).toBe(404)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('deleting an Asset from its detail', () => {
	it('deletes an Asset no View binds after one confirmation', async () => {
		const name = `Loose ${unique()}`
		const asset = await api<{ key: string }>('/api/assets', { name, contentFilename: 'loose.png', mediaType: 'image/png', contentBase64: PNG })
		const { context, page } = await open('/workspace/assets')
		try {
			await page.getByRole('button', { name: `Open ${name}` }).click()
			await page.locator('[data-delete-resource]').click()
			await expect.poll(() => page.locator('[data-delete-confirm]').isEnabled(), { timeout: 10_000 }).toBe(true)
			await page.locator('[data-delete-confirm]').click()
			await deleteDialog(page).waitFor({ state: 'detached' })
			await expect.poll(() => status(`/api/resources/asset/${asset.key}`)).toBe(404)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('saving Workspace settings that remove a viewport key', () => {
	it('lists the threads that name the key and saves only after "Save anyway"', async () => {
		const viewId = await seedView(`Pinned ${unique()}`)
		const thread = await api<{ key: string }>('/api/reviews', { anchor: { viewId, widgetId: 'root' }, renderContext: { viewportId: 'tablet' } })
		const before = await api<{ revision: string; resource: { viewports: Record<string, unknown> } }>('/api/resources/workspace/workspace')
		const { context, page } = await open('/workspace/settings')
		try {
			await page.getByRole('button', { name: 'Actions for tablet' }).click()
			await page.getByRole('menuitem', { name: 'Remove' }).click()
			const registry = page.getByRole('dialog')
			await registry.getByRole('checkbox').check()
			await registry.getByRole('button', { name: 'Remove', exact: true }).click()
			await page.locator('#settings-viewports').getByRole('button', { name: 'Save changes' }).click()

			const dialog = page.locator('[data-impact-dialog]')
			await dialog.waitFor()
			const item = dialog.locator('[data-impact-item][data-category="render_key_removed"]')
			expect(await item.count()).toBe(1)
			expect(await item.textContent()).toContain('tablet')
			// The first request wrote nothing.
			expect((await api<{ revision: string }>('/api/resources/workspace/workspace')).revision).toBe(before.revision)

			await page.locator('[data-impact-cancel]').click()
			await dialog.waitFor({ state: 'detached' })
			expect((await api<{ revision: string }>('/api/resources/workspace/workspace')).revision).toBe(before.revision)

			await page.locator('#settings-viewports').getByRole('button', { name: 'Save changes' }).click()
			await page.locator('[data-impact-dialog]').waitFor()
			await page.locator('[data-impact-acknowledge]').click()
			await page.locator('[data-impact-dialog]').waitFor({ state: 'detached' })
			await expect.poll(async () => Object.keys((await api<{ resource: { viewports: Record<string, unknown> } }>('/api/resources/workspace/workspace')).resource.viewports)).not.toContain('tablet')
			// The thread keeps recording the key it was raised in.
			const kept = await api<{ resource: { renderContext?: { viewportId?: string } } }>(`/api/resources/review/${thread.key}`)
			expect(kept.resource.renderContext?.viewportId).toBe('tablet')
		}
		finally { await context.close() }
	}, 90_000)
})
