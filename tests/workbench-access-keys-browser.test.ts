import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { keysForRole, type PermissionKey } from '../src/application/access/keys'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Per-key Workbench gating (issue #142, P4) against the built Workbench and a private copy of the
 * frozen fixture Workspace. Members are given custom key sets, so each test shows that a gate
 * follows its own key rather than a role rank:
 *
 * - the header shows the label, a preset name or Custom (Rules 01a11485-ed98 and 01a11c09-cef3);
 * - the Members entry and page follow `members.manage` alone (Rule 01a116f0-8caf), so a member
 *   holding it without the rest of the Owner set reaches them (P2 review note F5);
 * - an authoring page follows its own write key and names the missing one (Rule 01a11485-eba3);
 * - "Release lock" follows `locks.force-release` (Rule 01a11485-f118);
 * - the Activity timeline and the View history panel follow `history.read`, and Resolve, Submit
 *   for review and Reopen follow `reviews.resolve` and `reviews.submit`, in the Reviews inbox and in
 *   the canvas thread bubble alike (Rule 01a116f0-8fd3).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser

const unique = () => randomUUID().slice(0, 8)

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Cookie = Readonly<{ name: string; value: string }>

/** A human member holding exactly `keys`, signed in to the Workbench. */
async function memberCookie(keys: readonly PermissionKey[], nickname = `p4-${unique()}`): Promise<Cookie> {
	return await sessionCookieFor(server.origin, await provisionToken(server.workspaceRoot, { nickname, kind: 'human', keys }))
}

async function open(path: string, cookie: Cookie): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

/** The member chip's badge and the entries of its menu. */
async function chip(page: Page): Promise<{ badge: string; ariaLabel: string; entries: string[] }> {
	const button = page.locator('[data-testid="member-chip"]')
	await button.waitFor()
	const badge = (await button.locator('[data-member-label]').innerText()).trim()
	const ariaLabel = await button.getAttribute('aria-label') ?? ''
	await button.click()
	const menu = page.locator('[role="menu"]')
	await menu.waitFor()
	const entries = (await menu.locator('[role="menuitem"]').allInnerTexts()).map(text => text.trim())
	await page.keyboard.press('Escape')
	await menu.waitFor({ state: 'detached' })
	return { badge, ariaLabel, entries }
}

async function owner<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...server.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

/** An open thread on the fixture View's RootShell with its first message, as the owner. */
async function seedThread(body: string): Promise<string> {
	const created = await owner<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	await owner(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
	return created.key
}

async function resolveThread(key: string): Promise<void> {
	const read = await owner<{ revision: string }>(`/api/resources/review/${key}`)
	await owner(`/api/reviews/${key}/resolve`, { expectedRevision: read.revision, resolution: 'answered' })
}

const OWNER = keysForRole('human', 'owner')
const EDITOR = keysForRole('human', 'editor')
const VIEWER = keysForRole('human', 'viewer')

describe('the header and the Members page follow `members.manage`', () => {
	it('lets a member holding `members.manage` without the full Owner set open Members, labeled Custom', async () => {
		const nickname = `p4-manager-${unique()}`
		const { context, page } = await open('/', await memberCookie([...EDITOR, 'members.manage'], nickname))
		try {
			const seen = await chip(page)
			expect(seen.badge).toBe('Custom')
			expect(seen.ariaLabel).toBe(`Signed in as ${nickname}, Human, Custom`)
			expect(seen.entries).toContain('Members')
			await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
			expect(new URL(page.url()).pathname).toBe('/members')
			await page.locator('table').first().getByText(nickname).first().waitFor({ timeout: 15_000 })
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps the built-in presets\' header and Members access: Owner sees Members, Editor and Viewer do not', async () => {
		const owner = await open('/', server.cookie)
		try {
			const seen = await chip(owner.page)
			expect(seen.badge).toBe('Owner')
			expect(seen.entries).toContain('Members')
		}
		finally { await owner.context.close() }

		for (const [name, keys] of [['Editor', EDITOR], ['Viewer', VIEWER]] as const) {
			const { context, page } = await open('/', await memberCookie(keys))
			try {
				const seen = await chip(page)
				expect(seen.badge, name).toBe(name)
				expect(seen.entries, name).not.toContain('Members')
				await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
				await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
			}
			finally { await context.close() }
		}
	}, 90_000)

	it('keeps Members away from a member holding every key but `members.manage`', async () => {
		const { context, page } = await open('/', await memberCookie(OWNER.filter(key => key !== 'members.manage')))
		try {
			const seen = await chip(page)
			expect(seen.badge).toBe('Custom')
			expect(seen.entries).not.toContain('Members')
			await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
			await page.waitForURL(url => url.pathname === '/', { timeout: 15_000 })
		}
		finally { await context.close() }
	}, 60_000)
})

describe('authoring pages follow their own write key', () => {
	it('lets a translator edit Locales while Settings and Assets name the key it lacks', async () => {
		const cookie = await memberCookie(['workspace.read', 'reviews.write', 'locales.write'])
		const locales = await open('/workspace/locales', cookie)
		try {
			await locales.page.locator('[data-locale-diff-row]').first().waitFor({ timeout: 15_000 })
			expect(await locales.page.locator('[data-access-notice]').count()).toBe(0)
			expect(await locales.page.getByRole('button', { name: 'New Locale', exact: true }).count()).toBe(1)
		}
		finally { await locales.context.close() }

		for (const [path, key] of [['/workspace/settings', 'settings.write'], ['/workspace/assets', 'assets.write']] as const) {
			const { context, page } = await open(path, cookie)
			try {
				const notice = page.locator(`[data-access-notice][data-missing-key="${key}"]`)
				await notice.waitFor({ timeout: 15_000 })
				expect(await notice.getAttribute('data-missing-key'), path).toBe(key)
				expect(await notice.innerText(), path).toContain(`Requires the permission key ${key}.`)
				expect(await page.getByRole('button', { name: 'Upload', exact: true }).count(), path).toBe(0)
				expect(await page.getByRole('button', { name: 'Add adapter', exact: true }).count(), path).toBe(0)
			}
			finally { await context.close() }
		}
	}, 90_000)

	it('offers Adapter config but not composition without `product-kit.compose`', async () => {
		const { context, page } = await open('/workspace/settings?section=adapters', await memberCookie(['workspace.read', 'settings.write']))
		try {
			const notice = page.locator('[data-access-notice="compose"]')
			await notice.waitFor({ timeout: 15_000 })
			expect(await notice.innerText()).toContain('Requires the permission key product-kit.compose.')
			expect(await page.locator('[data-access-notice][data-missing-key="settings.write"]').count()).toBe(0)
			await page.locator('[data-adapter-row]').first().waitFor()
			expect(await page.getByRole('button', { name: 'Add adapter', exact: true }).count()).toBe(0)
			expect(await page.locator('[data-adapter-specifier]').count()).toBe(0)
			expect(await page.locator('[data-adapter-move]').count()).toBe(0)
		}
		finally { await context.close() }

		// With the key, the same page composes, as for an Editor.
		const composer = await open('/workspace/settings?section=adapters', await memberCookie(['workspace.read', 'settings.write', 'product-kit.source.read', 'product-kit.write', 'product-kit.compose']))
		try {
			await composer.page.getByRole('button', { name: 'Add adapter', exact: true }).waitFor({ timeout: 15_000 })
			expect(await composer.page.locator('[data-access-notice="compose"]').count()).toBe(0)
		}
		finally { await composer.context.close() }
	}, 90_000)
})

describe('lock release follows `locks.force-release`', () => {
	it('offers Release lock to a holder of the key alone and not to an Editor', async () => {
		const agent = await provisionToken(server.workspaceRoot, { nickname: `p4-agent-${unique()}`, kind: 'agent', role: 'editor' })
		const locale = 'fr'
		const created = await fetch(`${server.origin}/api/locales`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(agent) }, body: JSON.stringify({ locale, messages: { greeting: 'Hi' } }) })
		expect(created.status, await created.clone().text()).toBeLessThan(300)

		const releaser = await open('/workspace/locales', await memberCookie(['workspace.read', 'locks.force-release']))
		try {
			await releaser.page.locator('[data-testid="lock-badge"]').first().waitFor({ timeout: 15_000 })
			await releaser.page.getByRole('button', { name: 'Release lock' }).first().waitFor()
		}
		finally { await releaser.context.close() }

		const editor = await open('/workspace/locales', await memberCookie(EDITOR))
		try {
			await editor.page.locator('[data-testid="lock-badge"]').first().waitFor({ timeout: 15_000 })
			expect(await editor.page.getByRole('button', { name: 'Release lock' }).count()).toBe(0)
		}
		finally { await editor.context.close() }
	}, 90_000)
})

describe('history and Review actions follow their keys', () => {
	it('names `history.read` instead of the timeline for a member without it', async () => {
		const { context, page } = await open('/?tab=activity', await memberCookie(['workspace.read', 'reviews.write']))
		try {
			const notice = page.locator('[data-access-notice="history"]')
			await notice.waitFor({ timeout: 15_000 })
			expect(await notice.innerText()).toContain('Requires the permission key history.read.')
			expect(await page.locator('[data-version-timeline]').count()).toBe(0)
		}
		finally { await context.close() }

		const reader = await open('/?tab=activity', await memberCookie(VIEWER))
		try {
			await reader.page.locator('[data-version-timeline]').waitFor({ timeout: 15_000 })
			expect(await reader.page.locator('[data-access-notice="history"]').count()).toBe(0)
		}
		finally { await reader.context.close() }
	}, 60_000)

	it('names `history.read` instead of the View history panel for a member without it', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=history`, await memberCookie(['workspace.read', 'reviews.write']))
		try {
			const notice = page.locator('[data-view-history] [data-access-notice="history"]')
			await notice.waitFor({ timeout: 15_000 })
			expect(await notice.innerText()).toContain('Requires the permission key history.read.')
			expect(await page.locator('[data-view-history] [data-version-timeline]').count()).toBe(0)
		}
		finally { await context.close() }

		const reader = await open(`/views/${VIEW_ID}?panel=history`, await memberCookie(VIEWER))
		try {
			await reader.page.locator('[data-view-history] [data-version-timeline]').waitFor({ timeout: 15_000 })
			expect(await reader.page.locator('[data-view-history] [data-access-notice="history"]').count()).toBe(0)
		}
		finally { await reader.context.close() }
	}, 60_000)

	it('offers the canvas bubble\'s Resolve only with `reviews.resolve`, and Submit and Reopen only with `reviews.submit`', async () => {
		const thread = await seedThread('P4 canvas gating thread.')
		/** The bubble of the thread, opened through the address, and whether its menu offers Submit for review. */
		async function bubbleFor(keys: readonly PermissionKey[]) {
			const opened = await open(`/views/${VIEW_ID}?thread=${thread}`, await memberCookie(keys))
			const bubble = opened.page.locator('[data-thread-bubble]')
			await bubble.locator('[data-timeline-kind="message"]').first().waitFor({ timeout: 20_000 })
			return { ...opened, bubble }
		}
		async function offersSubmit(page: Page, bubble: ReturnType<Page['locator']>): Promise<boolean> {
			await bubble.getByRole('button', { name: 'More', exact: true }).click()
			const menu = page.locator('[role="menu"]')
			await menu.waitFor()
			const offered = (await menu.locator('[role="menuitem"]').allInnerTexts()).some(text => text.includes('Submit for review'))
			await page.keyboard.press('Escape')
			await menu.waitFor({ state: 'detached' })
			return offered
		}

		// Commenting alone: no Resolve and the key named, no Submit.
		const commenter = await bubbleFor(['workspace.read', 'reviews.write'])
		try {
			expect(await commenter.bubble.locator('[data-thread-resolve]').count()).toBe(0)
			await commenter.bubble.getByText('Requires the permission key reviews.resolve.').waitFor()
			expect(await offersSubmit(commenter.page, commenter.bubble)).toBe(false)
		}
		finally { await commenter.context.close() }

		// `reviews.resolve` alone adds Resolve; `reviews.submit` alone adds Submit for review.
		const resolver = await bubbleFor(['workspace.read', 'reviews.write', 'reviews.resolve'])
		try {
			await resolver.bubble.locator('[data-thread-resolve]').waitFor()
			expect(await offersSubmit(resolver.page, resolver.bubble)).toBe(false)
		}
		finally { await resolver.context.close() }
		const submitter = await bubbleFor(['workspace.read', 'reviews.write', 'reviews.submit'])
		try {
			expect(await submitter.bubble.locator('[data-thread-resolve]').count()).toBe(0)
			expect(await offersSubmit(submitter.page, submitter.bubble)).toBe(true)
		}
		finally { await submitter.context.close() }

		// Resolved: Reopen needs `reviews.submit`, not `reviews.resolve`.
		await resolveThread(thread)
		const reopener = await bubbleFor(['workspace.read', 'reviews.write', 'reviews.submit'])
		try {
			await reopener.bubble.locator('[data-thread-reopen]').waitFor({ timeout: 15_000 })
		}
		finally { await reopener.context.close() }
		const nonReopener = await bubbleFor(['workspace.read', 'reviews.write', 'reviews.resolve'])
		try {
			expect(await nonReopener.bubble.locator('[data-thread-reopen]').count()).toBe(0)
		}
		finally { await nonReopener.context.close() }
	}, 120_000)

	it('offers Resolve only with `reviews.resolve` and Reopen only with `reviews.submit`, naming the missing key', async () => {
		const created = await (await fetch(`${server.origin}/api/reviews`, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ anchor: { viewId: VIEW_ID, widgetId: 'root' } }) })).json() as { key: string; revision: string }
		await fetch(`${server.origin}/api/reviews/${created.key}/messages`, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ expectedRevision: created.revision, body: 'P4 gating thread.' }) })
		const detail = (page: Page) => page.locator(`[data-review-detail][data-thread-id="${created.key}"]`)

		// A commenter without `reviews.resolve`: replies, but Resolve is not offered and the hint names the key.
		const commenter = await open(`/reviews?thread=${created.key}`, await memberCookie(['workspace.read', 'reviews.write']))
		try {
			await detail(commenter.page).locator('[data-timeline-kind="message"]').first().waitFor({ timeout: 15_000 })
			expect(await commenter.page.locator('[data-review-reply]').count()).toBe(1)
			expect(await commenter.page.locator('[data-review-resolve]').count()).toBe(0)
			await detail(commenter.page).getByText('Requires the permission key reviews.resolve.').waitFor()
		}
		finally { await commenter.context.close() }

		// A Reviewer is offered Resolve, as before keys.
		const reviewer = await open(`/reviews?thread=${created.key}`, await memberCookie(keysForRole('human', 'reviewer')))
		try {
			await detail(reviewer.page).locator('[data-review-resolve]').waitFor({ timeout: 15_000 })
		}
		finally { await reviewer.context.close() }

		// Resolved: Reopen needs `reviews.submit`, which a Reviewer holds.
		const read = await (await fetch(`${server.origin}/api/resources/review/${created.key}`, { headers: server.headers })).json() as { revision: string }
		const resolved = await fetch(`${server.origin}/api/reviews/${created.key}/resolve`, { method: 'POST', headers: { 'content-type': 'application/json', ...server.headers }, body: JSON.stringify({ expectedRevision: read.revision, resolution: 'answered' }) })
		expect(resolved.status, await resolved.clone().text()).toBeLessThan(300)
		const submitter = await open(`/reviews?status=resolved&thread=${created.key}`, await memberCookie(keysForRole('human', 'reviewer')))
		try {
			await detail(submitter.page).locator('[data-review-reopen]').waitFor({ timeout: 15_000 })
		}
		finally { await submitter.context.close() }
		const resolver = await open(`/reviews?status=resolved&thread=${created.key}`, await memberCookie(['workspace.read', 'reviews.write', 'reviews.resolve']))
		try {
			await detail(resolver.page).locator('[data-timeline-kind="message"]').first().waitFor({ timeout: 15_000 })
			expect(await resolver.page.locator('[data-review-reopen]').count()).toBe(0)
		}
		finally { await resolver.context.close() }
	}, 90_000)
})
