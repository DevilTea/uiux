import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Checks navigation to a View that no longer exists (Rule 01a11658-1fde-7b27-ba6d-6de27224b90c,
 * issue #107): Checks stays where it is and says so in a non-blocking notice, instead of routing to
 * the missing View and then landing on the View list.
 *
 * UIUX has no operation that deletes a View, so the View goes away the way it does in practice:
 * out of band (a checkout or a restore by another hand). The private Workspace copy is changed on
 * disk; nothing under `.uiux/` is touched.
 */

const GONE_VIEW_ID = 'c0000000-0000-4000-8000-000000000107'
const GONE_VIEW_NAME = 'Soon-gone View'
const KEPT_VIEW_ID = 'c0000000-0000-4000-8000-000000000108'
const KEPT_VIEW_NAME = 'Kept View'

let server: WorkbenchServer
let browser: Browser

/** A View whose file carries an unknown member, so Run Checks reports a finding on it. */
function viewWithFinding(id: string, name: string): string {
	return `${JSON.stringify({
		id,
		name,
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: 'A View with a Checks finding.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] },
		legacyNote: 'not part of the View schema',
	}, null, '\t')}\n`
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			await writeFile(join(root, 'views', `${GONE_VIEW_ID}.view.json`), viewWithFinding(GONE_VIEW_ID, GONE_VIEW_NAME))
			await writeFile(join(root, 'views', `${KEPT_VIEW_ID}.view.json`), viewWithFinding(KEPT_VIEW_ID, KEPT_VIEW_NAME))
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

/** The first finding of one View in the Checks tree (its id names the resource). */
function findingOf(page: Page, viewId: string) {
	return page.locator(`[data-checks-tree] [data-check-finding*=":view:${viewId}:"]`).first()
}

/** A page on Checks, after Run Checks has listed findings on both Views. */
async function openChecks(): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'networkidle' })
	await page.locator('[data-run-checks]').click()
	await page.locator('[data-checks-tree]').waitFor({ timeout: 30_000 })
	await findingOf(page, GONE_VIEW_ID).waitFor({ timeout: 15_000 })
	await findingOf(page, KEPT_VIEW_ID).waitFor({ timeout: 15_000 })
	return { context, page }
}

describe('Checks navigation to a deleted View (issue #107)', () => {
	it('stays on Checks with a notice when the View was removed after Run Checks, and still opens a View that exists', async () => {
		const { context, page } = await openChecks()
		try {
			const tree = page.locator('[data-checks-tree]')
			const gone = findingOf(page, GONE_VIEW_ID)

			await rm(join(server.workspaceRoot, 'views', `${GONE_VIEW_ID}.view.json`))
			const routes: string[] = []
			page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) routes.push(frame.url()) })
			await gone.click()

			await page.locator('[data-slot="title"]', { hasText: 'This View no longer exists' }).waitFor({ timeout: 10_000 })
			await page.locator('[data-slot="description"]', { hasText: `${GONE_VIEW_NAME} wasn't opened, so you're still on Checks.` }).first().waitFor()
			// The notice comes after the decision not to navigate: no route change, the results stay.
			expect(routes).toEqual([])
			const url = new URL(page.url())
			expect(url.pathname).toBe('/')
			expect(url.searchParams.get('tab')).toBe('checks')
			expect(await tree.isVisible()).toBe(true)
			expect(await gone.isVisible()).toBe(true)

			// A finding on a View that still exists opens it as before.
			await findingOf(page, KEPT_VIEW_ID).click()
			await page.waitForURL(next => next.pathname === `/views/${KEPT_VIEW_ID}`, { timeout: 10_000 })
			expect(new URL(page.url()).searchParams.get('panel')).toBe('readiness')
		}
		finally { await context.close() }
	}, 90_000)

	it('follows only the latest of two quick clicks', async () => {
		await writeFile(join(server.workspaceRoot, 'views', `${GONE_VIEW_ID}.view.json`), viewWithFinding(GONE_VIEW_ID, GONE_VIEW_NAME))
		const { context, page } = await openChecks()
		try {
			await rm(join(server.workspaceRoot, 'views', `${GONE_VIEW_ID}.view.json`))
			// Each View read is held until released, so the older click's answer arrives first.
			const held = new Map<string, Route>()
			await page.route(url => /^\/api\/resources\/view\//.test(url.pathname), (route) => { held.set(new URL(route.request().url()).pathname, route) })
			const release = async (viewId: string): Promise<void> => {
				const path = `/api/resources/view/${viewId}`
				await expect.poll(() => held.has(path), { timeout: 10_000 }).toBe(true)
				const finished = page.waitForEvent('requestfinished', request => new URL(request.url()).pathname === path)
				const route = held.get(path)!
				held.delete(path)
				await route.continue()
				await finished
			}
			const routes: string[] = []
			page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) routes.push(frame.url()) })

			// The existing View first, then the deleted one: the existing View's answer is stale.
			await findingOf(page, KEPT_VIEW_ID).click()
			await findingOf(page, GONE_VIEW_ID).click()
			await release(KEPT_VIEW_ID)
			await release(GONE_VIEW_ID)
			await page.locator('[data-slot="description"]', { hasText: `${GONE_VIEW_NAME} wasn't opened, so you're still on Checks.` }).first().waitFor({ timeout: 10_000 })
			expect(routes).toEqual([])
			const url = new URL(page.url())
			expect(url.pathname).toBe('/')
			expect(url.searchParams.get('tab')).toBe('checks')

			// The deleted View first, then the existing one: only the existing View opens.
			await findingOf(page, GONE_VIEW_ID).click()
			await findingOf(page, KEPT_VIEW_ID).click()
			await release(GONE_VIEW_ID)
			await release(KEPT_VIEW_ID)
			await page.waitForURL(next => next.pathname === `/views/${KEPT_VIEW_ID}`, { timeout: 10_000 })
		}
		finally { await context.close() }
	}, 90_000)
})
