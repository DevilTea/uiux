import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { bearer, provisionToken } from './support/access'

/**
 * An open thread step keeps the revision it was started on under live refresh (issue #69 review,
 * Rule 01a11485-f451-72eb-81ad-686aeec7b3eb): the Duplicate reason step and a message edit are
 * sent against the thread as it was when they opened, so a reply that lands elsewhere meanwhile,
 * and that live refresh shows, refuses them as a conflict instead of letting them silently apply to
 * the newer thread. The user then acts again, on the thread now shown.
 */
const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser
let agent: string

async function api<T>(path: string, body?: unknown, headers: Record<string, string> = server.headers): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}
type ThreadRead = { revision: string; resource: { status: string; messages: { id: string; body: string }[] } }
const readThread = (id: string) => api<ThreadRead>(`/api/resources/review/${id}`)

/** A thread with one message by `headers`' member (the Owner's session by default). */
async function seedThread(body: string, headers: Record<string, string> = server.headers): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } }, headers)
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body }, headers)
	return created.key
}
async function replyElsewhere(id: string, body: string): Promise<void> {
	await api(`/api/reviews/${id}/messages`, { expectedRevision: (await readThread(id)).revision, body }, bearer(agent))
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	agent = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', preset: 'editor' })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

const responseTo = (page: Page, method: string, path: string) => page.waitForResponse(response => response.request().method() === method && new URL(response.url()).pathname === path)

describe('open thread steps keep their revision under live refresh (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb)', () => {
	it('refuses Duplicate from a reason step opened before a reply landed, then resolves on the user\'s next confirm', async () => {
		const id = await seedThread('This duplicates another thread.', bearer(agent))
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const scope = page.locator(`[data-review-detail][data-thread-id="${id}"]`)
			const messages = scope.locator('[data-timeline-kind="message"]')
			await expect.poll(() => messages.count(), { timeout: 15_000 }).toBe(1)
			await scope.locator('[data-review-resolve-menu]').click()
			await page.getByRole('menuitem', { name: 'Duplicate…' }).click()
			await scope.locator('[data-thread-reason] input').fill('Same as the other thread.')
			// A reply lands elsewhere while the step is open; live refresh shows it.
			await replyElsewhere(id, 'Not quite: this one is about the label.')
			await expect.poll(() => messages.count(), { timeout: 10_000 }).toBe(2)

			const refused = responseTo(page, 'POST', `/api/reviews/${id}/resolve`)
			await scope.locator('[data-thread-reason-confirm]').click()
			expect((await refused).status()).toBe(409)
			await scope.locator('[data-review-conflict]').waitFor({ timeout: 10_000 })
			expect((await readThread(id)).resource.status).toBe('open')

			// The step stays open with its reason; confirming again acts on the thread now shown.
			expect(await scope.locator('[data-thread-reason] input').inputValue()).toBe('Same as the other thread.')
			const resolved = responseTo(page, 'POST', `/api/reviews/${id}/resolve`)
			await scope.locator('[data-thread-reason-confirm]').click()
			expect((await resolved).status()).toBeLessThan(300)
			await expect.poll(async () => (await readThread(id)).resource.status, { timeout: 10_000 }).toBe('resolved')
		}
		finally { await context.close() }
	}, 90_000)

	it('refuses a message edit started before a reply landed, keeps the text, then saves it on the user\'s next Save', async () => {
		const id = await seedThread('My first take on the label.')
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const scope = page.locator(`[data-review-detail][data-thread-id="${id}"]`)
			const messages = scope.locator('[data-timeline-kind="message"]')
			await expect.poll(() => messages.count(), { timeout: 15_000 }).toBe(1)
			const mine = scope.locator('[data-message-id]').first()
			await mine.hover()
			await mine.locator('[data-message-menu]').click()
			await page.getByRole('menuitem', { name: 'Edit' }).click()
			const editor = mine.locator('[data-message-editor] textarea')
			await editor.fill('My second take on the label.')
			await replyElsewhere(id, 'A reply that lands while the edit is open.')
			await expect.poll(() => messages.count(), { timeout: 10_000 }).toBe(2)

			const refused = responseTo(page, 'PUT', `/api/reviews/${id}/messages/${(await readThread(id)).resource.messages[0]!.id}`)
			await mine.locator('[data-message-edit-save]').click()
			expect((await refused).status()).toBe(409)
			await scope.locator('[data-review-conflict]').waitFor({ timeout: 10_000 })
			expect((await readThread(id)).resource.messages[0]!.body).toBe('My first take on the label.')
			expect(await editor.inputValue()).toBe('My second take on the label.')

			const saved = responseTo(page, 'PUT', `/api/reviews/${id}/messages/${(await readThread(id)).resource.messages[0]!.id}`)
			await mine.locator('[data-message-edit-save]').click()
			expect((await saved).status()).toBeLessThan(300)
			await expect.poll(async () => (await readThread(id)).resource.messages[0]!.body, { timeout: 10_000 }).toBe('My second take on the label.')
		}
		finally { await context.close() }
	}, 90_000)
})
