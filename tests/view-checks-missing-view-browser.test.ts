import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * A finding in a View's own Checks panel when the open View was removed since it was read
 * (Rule 01a11658-1fde-7b27-ba6d-6de27224b90c, issue #107): the Workbench stays on the current
 * screen, hides the previous highlight and shows a non-blocking notice, for an immediate request
 * and for one deferred by Comment mode. The View goes away out of band, in the private Workspace
 * copy only; nothing under `.uiux/` is touched.
 */

const VIEW_ID = 'c0000000-0000-4000-8000-000000000207'
const VIEW_NAME = 'Panel View'

let server: WorkbenchServer
let browser: Browser

/** A View whose Text Widget carries a Variant state entry with an empty member key, so its Checks panel lists a Widget finding. */
function viewWithWidgetFinding(): string {
	return `${JSON.stringify({
		id: VIEW_ID,
		name: VIEW_NAME,
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Text', id: 'bad-text', config: {} }] } },
		variants: { broken: { state: { 'bad-text': { '': 1 } } } },
		spec: { intent: 'A View with a Widget finding.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}, null, '\t')}\n`
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => { await writeFile(join(root, 'views', `${VIEW_ID}.view.json`), viewWithWidgetFinding()) },
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function openPanel(): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/views/${VIEW_ID}?panel=readiness`, { waitUntil: 'networkidle' })
	await page.locator('[data-facet="validation"]').waitFor({ timeout: 30_000 })
	return { context, page }
}

const findingButton = (page: Page) => page.locator('[data-facet="validation"] button', { hasText: '#bad-text' }).first()
const goneNotice = (page: Page) => page.locator('[data-slot="title"]', { hasText: 'This View no longer exists' })

describe('View Checks panel finding for a removed View (issue #107)', () => {
	it('keeps the screen and shows the notice for an immediate request', async () => {
		await writeFile(join(server.workspaceRoot, 'views', `${VIEW_ID}.view.json`), viewWithWidgetFinding())
		const { context, page } = await openPanel()
		try {
			await findingButton(page).waitFor({ timeout: 15_000 })
			const before = page.url()
			await rm(join(server.workspaceRoot, 'views', `${VIEW_ID}.view.json`))
			await findingButton(page).click()
			await goneNotice(page).waitFor({ timeout: 10_000 })
			expect(page.url()).toBe(before)
			expect(await page.locator('[data-readiness-tab]').isVisible()).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('shows the same notice when the request was deferred by Comment mode', async () => {
		await writeFile(join(server.workspaceRoot, 'views', `${VIEW_ID}.view.json`), viewWithWidgetFinding())
		const { context, page } = await openPanel()
		try {
			await findingButton(page).waitFor({ timeout: 15_000 })
			const before = page.url()
			// The Comment tool is blocked until the Preview session is live (`commentToolBlock`); a `c` pressed
			// earlier only toasts the reason, so the click would follow the finding at once and defer no notice.
			await page.locator('[data-session-status][data-status="live"]').waitFor({ timeout: 30_000 })
			await page.keyboard.press('c')
			await page.locator('[role="toolbar"] [data-tool="comment"][aria-pressed="true"]').waitFor({ timeout: 10_000 })
			await findingButton(page).click()
			await page.locator('[data-facet="validation"] [role="status"]').waitFor()
			await rm(join(server.workspaceRoot, 'views', `${VIEW_ID}.view.json`))
			await page.keyboard.press('Escape')
			await goneNotice(page).waitFor({ timeout: 10_000 })
			expect(page.url()).toBe(before)
		}
		finally { await context.close() }
	}, 90_000)
})
