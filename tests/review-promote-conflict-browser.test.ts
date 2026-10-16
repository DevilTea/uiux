import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * A promotion that conflicts names which resource moved, the thread or the View, keeps the form,
 * re-reads, and waits for the user to confirm again (Rule 01a11544-611c-73e0-990b-c094b48b3eb6;
 * the server lists the moved resources per Clause 01a11544-6d0a-70f4-b6b7-76e42f95d42e). The
 * competing write lands while the Workbench's promotion request is held, so the conflict is real.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

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

type Read<T> = { revision: string; resource: T }
type ViewSpec = { intent: string; entryConditions: string[]; interactionRules: string[]; constraints: string[]; accessibility: string[]; references: unknown[]; decisions?: { provenance?: { reviewId?: string } }[] }
const readThread = (id: string) => api<Read<{ messages: unknown[] }>>(`/api/resources/review/${id}`)
const readView = () => api<Read<{ spec: ViewSpec }>>(`/api/resources/view/${VIEW_ID}`)

async function seed(body: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'app-title' } })
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
	return created.key
}

/** Someone else replies: the thread's revision moves. */
async function moveThread(id: string): Promise<void> {
	await api(`/api/reviews/${id}/messages`, { expectedRevision: (await readThread(id)).revision, body: 'A reply that lands meanwhile.' })
}

/** Someone else edits the View's Spec: the View's revision moves. */
async function moveView(): Promise<void> {
	const view = await readView()
	const { intent, entryConditions, interactionRules, constraints, accessibility, references } = view.resource.spec
	const spec = { intent: `${intent} (edited)`, entryConditions, interactionRules, constraints, accessibility, references }
	await api(`/api/views/${VIEW_ID}/spec`, { expectedRevision: view.revision, spec }, 'PUT')
}

async function promotedInto(id: string): Promise<boolean> {
	return (await readView()).resource.spec.decisions?.some(decision => decision.provenance?.reviewId === id) ?? false
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
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

/** Holds the first promotion request until the competing write is in; counts every request. */
async function interceptPromote(page: Page, competingWrite: () => Promise<void>): Promise<{ count: () => number }> {
	let count = 0
	await page.route('**/api/reviews/*/promote', async (route) => {
		count += 1
		if (count === 1) await competingWrite()
		await route.continue()
	})
	return { count: () => count }
}

async function openPromote(page: Page, root: Locator): Promise<Locator> {
	await root.locator('[aria-label="More"]').first().click()
	await page.getByRole('menuitem', { name: 'Promote to Decision' }).click()
	const dialog = page.getByRole('dialog', { name: 'Promote to Decision' })
	await dialog.waitFor()
	await dialog.getByRole('textbox').nth(1).fill('Truncate with a tooltip.')
	await dialog.getByRole('textbox').nth(2).fill('Long titles break the header.')
	return dialog
}

/** The dialog names what moved, keeps the form, and sent exactly one request; the user confirms again. */
async function expectConflictThenConfirm(page: Page, dialog: Locator, id: string, writes: { count: () => number }, moved: string, title: string): Promise<void> {
	await dialog.getByRole('button', { name: 'Promote', exact: true }).click()
	const alert = dialog.locator('[data-promote-error]')
	await poll(() => alert.getAttribute('data-promote-moved')).toBe(moved)
	expect(await alert.textContent()).toContain(title)
	expect(await alert.textContent()).toContain('select Promote again')
	expect(await dialog.getByRole('textbox').nth(0).inputValue()).toContain('Should the title wrap')
	expect(await dialog.getByRole('textbox').nth(1).inputValue()).toBe('Truncate with a tooltip.')
	expect(await dialog.getByRole('textbox').nth(2).inputValue()).toBe('Long titles break the header.')
	// Nothing was promoted and nothing was retried on the user's behalf.
	await poll(() => dialog.getByRole('button', { name: 'Promote', exact: true }).isEnabled()).toBe(true)
	expect(writes.count()).toBe(1)
	expect(await promotedInto(id)).toBe(false)

	await dialog.getByRole('button', { name: 'Promote', exact: true }).click()
	await poll(() => dialog.count()).toBe(0)
	expect(writes.count()).toBe(2)
	expect(await promotedInto(id)).toBe(true)
}

describe('Promotion conflicts (Rule 01a11544-611c)', () => {
	it('names the thread when only the thread moved, in the Reviews detail', async () => {
		const id = await seed('Should the title wrap or truncate?')
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const detail = page.locator(`[data-review-detail][data-thread-id="${id}"]`)
			await detail.locator('[data-message-id]').first().waitFor()
			const writes = await interceptPromote(page, () => moveThread(id))
			const dialog = await openPromote(page, detail)
			await expectConflictThenConfirm(page, dialog, id, writes, 'review', 'This thread changed while you were promoting it.')
		}
		finally { await context.close() }
	}, 90_000)

	it('names the View when only the View moved, in the canvas bubble, and re-reads the View', async () => {
		const id = await seed('Should the title wrap or truncate here?')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${id}&panel=comments`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 15_000 })
			const writes = await interceptPromote(page, moveView)
			const dialog = await openPromote(page, bubble)
			await expectConflictThenConfirm(page, dialog, id, writes, 'view', 'This View changed while you were promoting the thread.')
		}
		finally { await context.close() }
	}, 90_000)

	it('names both when the thread and the View moved, in the Reviews detail', async () => {
		const id = await seed('Should the title wrap or truncate everywhere?')
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const detail = page.locator(`[data-review-detail][data-thread-id="${id}"]`)
			await detail.locator('[data-message-id]').first().waitFor()
			const writes = await interceptPromote(page, async () => {
				await moveThread(id)
				await moveView()
			})
			const dialog = await openPromote(page, detail)
			await expectConflictThenConfirm(page, dialog, id, writes, 'review view', 'This thread and its View both changed while you were promoting.')
		}
		finally { await context.close() }
	}, 90_000)
})
