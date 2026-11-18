import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'

import { commitAll, initGit } from './support/git'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The read-only changes since the Git base in the Workbench (Feature 01a1ece7-8d4e-763c-8897-2c35ef129a4d;
 * Rules 01a11a5e-1946-7217-aff5-db13df3a2977 and 01a11a5e-1aa5-7d13-939a-8d99245f7906): the Workspace is
 * a Git work tree with its fixture committed, one View is then renamed without a commit, and the
 * Activity tab and the View's History panel list that change against HEAD with its semantic difference,
 * offer the base toggle, and offer no action that writes, restores or reverts.
 */
const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			initGit(root)
			commitAll(root, 'base')
		},
	})
	browser = await chromium.launch({ headless: true })
	await renameView(server)
}, 120_000)

/** Renames the fixture View through the Workbench's own API: an uncommitted change of the Workspace. */
async function renameView(target: WorkbenchServer): Promise<void> {
	const read = await fetch(`${target.origin}/api/resources/view/${VIEW_ID}`, { headers: target.headers })
	const { revision } = await read.json() as { revision: string }
	const renamed = await fetch(`${target.origin}/api/views/${VIEW_ID}/metadata`, {
		method: 'PUT',
		headers: { ...target.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: revision, name: 'Renamed since the Git base' }),
	})
	if (!renamed.ok) throw new Error(`Renaming the View failed: ${renamed.status} ${await renamed.text()}`)
}

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, target: WorkbenchServer = server): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...target.cookie, url: target.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${target.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

describe('the changes since the Git base', () => {
	it('lists the uncommitted rename against HEAD in Activity, shows its semantic difference, and offers no write action', async () => {
		const { context, page } = await open('/?tab=activity')
		try {
			const panel = page.locator('[data-changes-since]')
			await panel.waitFor({ timeout: 20_000 })
			const row = panel.locator(`[data-summary-row="view:${VIEW_ID}"]`)
			await row.waitFor({ timeout: 20_000 })
			expect(await row.getAttribute('data-status')).toBe('modified')
			const diff = panel.locator(`[data-resource-diff="view:${VIEW_ID}"]`)
			await diff.waitFor({ timeout: 20_000 })
			const text = await diff.innerText()
			expect(text).toContain('Renamed since the Git base')
			expect(text).toContain('Name')
			// HEAD is the default base.
			expect(await panel.locator('[data-changes-base-option="head"]').getAttribute('aria-pressed')).toBe('true')
			// Nothing here writes, restores or reverts.
			for (const name of [/restore/iu, /revert/iu, /checkpoint/iu, /delete/iu])
				expect(await panel.getByRole('button', { name }).count(), String(name)).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('moves the base to the merge base with the default branch on the toggle, and the change is still listed', async () => {
		const { context, page } = await open('/?tab=activity')
		try {
			const panel = page.locator('[data-changes-since]')
			const toggle = panel.locator('[data-changes-base-option="merge-base"]')
			await toggle.waitFor({ timeout: 20_000 })
			await expect.poll(async () => await toggle.isDisabled(), { timeout: 20_000 }).toBe(false)
			expect(await toggle.innerText()).toContain('main')
			await toggle.click()
			await expect.poll(async () => await toggle.getAttribute('aria-pressed'), { timeout: 20_000 }).toBe('true')
			await panel.locator(`[data-summary-row="view:${VIEW_ID}"]`).waitFor({ timeout: 20_000 })
			expect(await panel.locator('[data-changes-base-note]').innerText()).toContain('merge base')
		}
		finally { await context.close() }
	}, 90_000)

	it('shows only the View\'s own change in its History panel', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history`)
		try {
			const panel = page.locator('[data-view-history] [data-changes-since]')
			await panel.locator(`[data-summary-row="view:${VIEW_ID}"]`).waitFor({ timeout: 20_000 })
			expect(await panel.locator('[data-summary-row]').count()).toBe(1)
			await panel.locator(`[data-resource-diff="view:${VIEW_ID}"]`).waitFor({ timeout: 20_000 })
		}
		finally { await context.close() }
	}, 90_000)
})

/** Rule 01a1ece7-9239-7a3f-931f-cbe92f83561f: without a default branch the toggle is unavailable and HEAD stays the base. */
describe('a repository with no default branch', () => {
	it('disables the toggle to the merge base, says why, and still lists the changes against HEAD', async () => {
		const noDefault = await startWorkbenchServer({
			prepare: async (root) => {
				initGit(root, 'topic-no-default-branch')
				commitAll(root, 'base')
			},
		})
		try {
			await renameView(noDefault)
			const { context, page } = await open('/?tab=activity', noDefault)
			try {
				const panel = page.locator('[data-changes-since]')
				await panel.locator('[data-changes-no-default-branch]').waitFor({ timeout: 20_000 })
				expect(await panel.locator('[data-changes-base-option="merge-base"]').isDisabled()).toBe(true)
				expect(await panel.locator('[data-changes-base-option="head"]').getAttribute('aria-pressed')).toBe('true')
				await panel.locator(`[data-summary-row="view:${VIEW_ID}"]`).waitFor({ timeout: 20_000 })
			}
			finally { await context.close() }
		}
		finally { await noDefault.close() }
	}, 120_000)
})

/** Rule 01a1ece7-92cf-79d6-b7d0-1d907da0045b: when git cannot supply the base the view says so and the rest keeps working. */
describe('a repository whose Git cannot supply the base', () => {
	it('says so in the changes view, lists nothing, and leaves the rest of the Activity tab working', async () => {
		// A work tree with no commit yet: Git is there, but `HEAD` names nothing.
		const noCommit = await startWorkbenchServer({ prepare: async (root) => { initGit(root) } })
		try {
			const { context, page } = await open('/?tab=activity', noCommit)
			try {
				const panel = page.locator('[data-changes-since]')
				const alert = panel.locator('[data-changes-unavailable]')
				await alert.waitFor({ timeout: 20_000 })
				expect(await alert.innerText()).toMatch(/no commit/iu)
				expect(await panel.locator('[data-summary-row]').count()).toBe(0)
				// The Review events below it, and the Workbench around it, are unaffected.
				await page.locator('[data-review-activity]').waitFor({ timeout: 20_000 })
				expect(await page.locator('[data-changes-failed]').count()).toBe(0)
			}
			finally { await context.close() }
		}
		finally { await noCommit.close() }
	}, 120_000)
})
