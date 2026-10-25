import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Decision lifecycle in the Workbench (issue #86): defer, decide and reopen a Decision on the
 * View's Spec tab, deciding only for a member holding the human-only `decisions.decide`, the
 * cross-View list of pending Decisions on the Overview, and another Decision from an already
 * promoted thread. Rules 01a11544-5e99-789d-bfed-dda22a98776f, 01a11544-5f18-77ac-b89e-56ced4056f19
 * and 01a11544-6084-7f2c-848d-cc4319e66134.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const REVIEW_ID = '140f4e87-cc50-4768-a82b-56b663609321'
const QUESTION = 'Keep the Pay button in the footer?'

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

type Decision = { id: string; question: string; status: string; outcome?: { summary: string; rationale: string }; history: unknown[] }
type ViewRead = { revision: string; resource: { spec: { decisions: Decision[] } } }
const readView = () => api<ViewRead>(`/api/resources/view/${VIEW_ID}`)
const decisionNamed = async (question: string) => (await readView()).resource.spec.decisions.find(item => item.question === question)

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	// A pending Decision from the fixture's thread: another Decision beside its decided one.
	const review = await api<{ revision: string }>(`/api/resources/review/${REVIEW_ID}`)
	await api(`/api/reviews/${REVIEW_ID}/decisions`, {
		decisionId: randomUUID(),
		expectedReviewRevision: review.revision,
		viewId: VIEW_ID,
		expectedViewRevision: (await readView()).revision,
		question: QUESTION,
	})
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, cookie: { name: string; value: string } = server.cookie): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

describe('Decision lifecycle in the Workbench', () => {
	it('defers, decides and reopens a Decision on the Spec tab, keeping its place and recording history', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`)
		try {
			const item = page.locator('[data-spec-decision]').filter({ hasText: QUESTION })
			await item.waitFor({ timeout: 20_000 })
			const id = (await decisionNamed(QUESTION))!.id
			const order = (await readView()).resource.spec.decisions.map(decision => decision.id)

			await item.getByRole('button', { name: `Defer: ${QUESTION}` }).click()
			await poll(async () => (await decisionNamed(QUESTION))!.status).toBe('deferred')
			await poll(() => item.innerText()).toContain('Deferred')

			await item.getByRole('button', { name: `Decide: ${QUESTION}` }).click()
			const dialog = page.getByRole('dialog', { name: 'Decide' })
			await dialog.waitFor()
			// The outcome summary is required.
			expect(await dialog.getByRole('button', { name: 'Decide', exact: true }).isDisabled()).toBe(true)
			await dialog.getByRole('textbox', { name: /Outcome/ }).fill('Keep it in the footer')
			await dialog.getByRole('textbox', { name: 'Rationale' }).fill('It stays reachable on phones.')
			await dialog.getByRole('button', { name: 'Decide', exact: true }).click()
			await dialog.waitFor({ state: 'detached' })
			await poll(async () => (await decisionNamed(QUESTION))!).toMatchObject({ status: 'decided', outcome: { summary: 'Keep it in the footer', rationale: 'It stays reachable on phones.' } })
			await poll(() => item.innerText()).toContain('Keep it in the footer')
			expect(await item.getByRole('button', { name: /^Defer/ }).count()).toBe(0)

			await item.getByRole('button', { name: `Reopen: ${QUESTION}` }).click()
			await poll(async () => (await decisionNamed(QUESTION))!.status).toBe('pending')
			const reopened = (await decisionNamed(QUESTION))!
			expect(reopened.outcome).toBeUndefined()
			expect(reopened.history).toHaveLength(3)
			expect((await readView()).resource.spec.decisions.map(decision => decision.id)).toEqual(order)
			expect(reopened.id).toBe(id)
			await poll(() => item.innerText()).not.toContain('Keep it in the footer')
		}
		finally { await context.close() }
	}, 120_000)

	it('lists the pending Decision on the Overview and opens its View on the Spec tab', async () => {
		const { context, page } = await open('/?tab=decisions')
		try {
			const entry = page.locator('[data-pending-decision]').filter({ hasText: QUESTION })
			await entry.waitFor({ timeout: 20_000 })
			expect(await entry.innerText()).toContain('UIUX Workbench')
			// The decided Decision of the same View is not pending, so it is not listed.
			expect(await page.locator('[data-pending-decision]').filter({ hasText: 'top navigation bar' }).count()).toBe(0)
			await entry.getByRole('link').click()
			await page.waitForURL(`**/views/${VIEW_ID}?*panel=spec*`)
			await page.locator('[data-spec-decision]').filter({ hasText: QUESTION }).waitFor()
		}
		finally { await context.close() }
	}, 90_000)

	it('shows an error with Try again, not an empty list, when the pending Decisions cannot be loaded', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			// The expanded listing the pending list reads fails; the Views themselves still load.
			await page.route('**/api/resources/list', async (route) => {
				if ((route.request().postData() ?? '').includes('expanded')) await route.abort()
				else await route.continue()
			})
			await page.goto(`${server.origin}/?tab=decisions`, { waitUntil: 'networkidle' })
			await page.locator('[data-pending-decisions-error]').waitFor({ timeout: 20_000 })
			expect(await page.locator('[data-pending-decisions-empty]').count()).toBe(0)
			expect(await page.locator('[data-pending-decision]').count()).toBe(0)
			await page.unroute('**/api/resources/list')
			await page.getByRole('button', { name: 'Try again' }).click()
			await page.locator('[data-pending-decision]').filter({ hasText: QUESTION }).waitFor({ timeout: 20_000 })
			expect(await page.locator('[data-pending-decisions-error]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('offers Decide only to a member whose session holds decisions.decide', async () => {
		const token = await provisionToken(server.workspaceRoot, { nickname: 'edith', kind: 'human', preset: 'editor' })
		const cookie = await sessionCookieFor(server.origin, token)
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`, cookie)
		try {
			const item = page.locator('[data-spec-decision]').filter({ hasText: QUESTION })
			await item.waitFor({ timeout: 20_000 })
			// An Editor defers (views.write) but cannot decide (decisions.decide is human-only, Owner only).
			await item.getByRole('button', { name: `Defer: ${QUESTION}` }).waitFor()
			expect(await item.getByRole('button', { name: /^Decide/ }).count()).toBe(0)
			const refused = await fetch(`${server.origin}/api/views/${VIEW_ID}/decisions/${(await decisionNamed(QUESTION))!.id}/decide`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', cookie: `${cookie.name}=${cookie.value}` },
				body: JSON.stringify({ expectedRevision: (await readView()).revision, outcome: { summary: 'x', rationale: 'y' } }),
			})
			expect(refused.status).toBe(403)
			expect(await refused.json()).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['decisions.decide'] })
			expect((await decisionNamed(QUESTION))!.status).toBe('pending')
		}
		finally { await context.close() }
	}, 90_000)

	it('creates another Decision from an already promoted thread in the Reviews detail', async () => {
		const before = (await readView()).resource.spec.decisions.length
		const { context, page } = await open(`/reviews?thread=${REVIEW_ID}`)
		try {
			await page.locator('[aria-label="More"]').first().click({ timeout: 20_000 })
			await page.getByRole('menuitem', { name: 'Create another Decision' }).click()
			const dialog = page.getByRole('dialog', { name: 'Create another Decision' })
			await dialog.waitFor()
			await dialog.getByRole('textbox', { name: /Question/ }).fill('Should Pay also appear in the header?')
			await dialog.getByRole('textbox', { name: /Outcome/ }).fill('No, footer only')
			await dialog.getByRole('button', { name: 'Create Decision' }).click()
			await dialog.waitFor({ state: 'detached' })
			await poll(async () => (await readView()).resource.spec.decisions.length).toBe(before + 1)
			const created = await decisionNamed('Should Pay also appear in the header?')
			expect(created).toMatchObject({ status: 'decided', outcome: { summary: 'No, footer only' } })
		}
		finally { await context.close() }
	}, 90_000)
})
