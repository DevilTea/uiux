import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Members page (list, add/edit drawer with its key checklist, token and invite dialogs, remove
 * dialog) and the Sign-in page build their buttons, badges and icons from the Kit components in
 * `app/components/kit/` instead of Nuxt UI primitives (Discussion #379 D1, issue #380). The test guards
 * that the Kit renders them with the state the area relied on: one primary action per region, the danger
 * confirm, an icon-only actions button that keeps its accessible name, the full-width Sign-in submit, and
 * that no Kit tag is left unresolved. The key checkboxes stay Nuxt UI (their label carries a badge).
 */

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer()
	await provisionToken(server.workspaceRoot, { nickname: 'alice', kind: 'human', preset: 'reviewer' })
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

const hasClass = (locator: Locator, name: string) => locator.evaluate((element, expected) => element.classList.contains(expected), name)
const UNKNOWN_KIT_TAGS = 'kitbutton, kitbadge, kiticon, kitskeleton, kitbuttongroup, kitcheckbox, kitkbd'

async function open(path: string, signedIn = true): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	if (signedIn) await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function openMembers(): Promise<{ context: BrowserContext; page: Page; alice: Locator }> {
	const { context, page } = await open('/members')
	const alice = page.locator('[data-members-table] tbody tr').filter({ hasText: 'alice' })
	await alice.waitFor({ timeout: 15_000 })
	return { context, page, alice }
}

describe('Members and Sign-in use the Kit components (#380)', () => {
	it('Members list: Kit primary Add member, soft badges, link-muted key count, icon-only actions and xs revoke', async () => {
		const { context, page, alice } = await openMembers()
		try {
			const add = page.locator('header').getByRole('button', { name: 'Add member' })
			expect(await hasClass(add, 'kit-btn--primary')).toBe(true)
			expect(await add.locator('svg.kit-icon').count()).toBe(1)

			expect(await hasClass(page.locator('header .kit-badge').first(), 'kit-badge--soft')).toBe(true)
			const label = alice.locator('[data-member-label]')
			expect(await hasClass(label, 'kit-badge')).toBe(true)
			expect(await hasClass(label, 'kit-badge--soft')).toBe(true)
			expect(await page.locator('[data-members-table] .kit-badge', { hasText: 'You' }).count()).toBe(1)

			const keys = alice.locator('[data-member-key-count]')
			expect(await hasClass(keys, 'kit-btn--link-muted')).toBe(true)
			expect(await keys.getAttribute('aria-label')).toBe('Edit the access of alice')

			const actions = alice.getByRole('button', { name: 'Actions for alice' })
			expect(await hasClass(actions, 'is-icon-only')).toBe(true)
			expect(await hasClass(actions, 'kit-btn--ghost')).toBe(true)
			expect(await actions.locator('svg.kit-icon').count()).toBe(1)

			const revoke = page.getByRole('button', { name: /^Revoke token / }).first()
			expect(await hasClass(revoke, 'kit-btn--xs')).toBe(true)
			expect(await hasClass(page.getByRole('button', { name: /^End the session of / }).first(), 'kit-btn--xs')).toBe(true)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Add/edit drawer: Kit primary save, outline cancel, Kit preset button and badges; key checkboxes stay accessible', async () => {
		const { context, page, alice } = await openMembers()
		try {
			await alice.locator('[data-member-key-count]').click()
			const drawer = page.getByRole('dialog')
			await drawer.waitFor()
			const save = drawer.locator('[data-member-editor-save]')
			expect(await hasClass(save, 'kit-btn--primary')).toBe(true)
			expect(await hasClass(drawer.getByRole('button', { name: 'Cancel' }), 'kit-btn--outline')).toBe(true)
			const preset = drawer.locator('[data-key-editor-preset]')
			expect(await hasClass(preset, 'kit-btn--outline')).toBe(true)
			expect(await hasClass(preset, 'kit-btn--sm')).toBe(true)
			expect(await preset.locator('svg.kit-icon').count()).toBe(1)
			expect(await hasClass(drawer.locator('[data-key-editor-label]'), 'kit-badge--soft')).toBe(true)
			const humanOnly = drawer.locator('[data-key-human-only]').first()
			expect(await hasClass(humanOnly, 'kit-badge--outline')).toBe(true)
			expect(await humanOnly.locator('svg.kit-icon').count()).toBe(1)
			// The checklist keeps the Nuxt UI checkbox: its name is the key and its Human-only badge.
			expect(await drawer.getByRole('checkbox', { name: /^workspace\.read/ }).count()).toBe(1)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Add member drawer: Kit primary Add member as the submit', async () => {
		const { context, page } = await openMembers()
		try {
			await page.locator('header').getByRole('button', { name: 'Add member' }).click()
			const drawer = page.getByRole('dialog')
			await drawer.waitFor()
			const submit = drawer.locator('[data-member-editor-save]')
			expect(await hasClass(submit, 'kit-btn--primary')).toBe(true)
			expect(await submit.isDisabled()).toBe(true)
			await drawer.locator('[data-member-editor-nickname]').fill('kit-newcomer')
			expect(await submit.isDisabled()).toBe(false)
		}
		finally { await context.close() }
	}, 90_000)

	it('Token dialogs: Kit primary create, then Kit copy with an icon after the secret is shown once', async () => {
		const { context, page, alice } = await openMembers()
		try {
			await alice.getByRole('button', { name: 'Actions for alice' }).click()
			await page.getByRole('menuitem', { name: 'Create token' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			expect(await hasClass(dialog.getByRole('button', { name: 'Cancel' }), 'kit-btn--outline')).toBe(true)
			const create = dialog.getByRole('button', { name: 'Create token' })
			expect(await hasClass(create, 'kit-btn--primary')).toBe(true)
			await create.click()
			await dialog.locator('[data-testid="revealed-token"]').waitFor()
			const copy = dialog.getByRole('button', { name: 'Copy' })
			expect(await hasClass(copy, 'kit-btn')).toBe(true)
			expect(await copy.locator('svg.kit-icon').count()).toBe(1)
			expect(await hasClass(dialog.getByRole('button', { name: 'Close' }).last(), 'kit-btn--outline')).toBe(true)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Invite and remove dialogs: Kit copy button, and a danger Remove confirm with its icon', async () => {
		const { context, page, alice } = await openMembers()
		try {
			await alice.getByRole('button', { name: 'Actions for alice' }).click()
			await page.getByRole('menuitem', { name: 'Sign-in link' }).click()
			const invite = page.getByRole('dialog')
			await invite.getByRole('button', { name: 'Copy' }).waitFor()
			expect(await hasClass(invite.getByRole('button', { name: 'Copy' }), 'kit-btn')).toBe(true)
			expect(await invite.getByRole('button', { name: 'Copy' }).locator('svg.kit-icon').count()).toBe(1)
			await page.keyboard.press('Escape')
			await invite.waitFor({ state: 'detached' })

			await alice.getByRole('button', { name: 'Actions for alice' }).click()
			await page.getByRole('menuitem', { name: 'Remove' }).click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			const confirm = dialog.getByRole('button', { name: 'Remove' })
			expect(await hasClass(confirm, 'kit-btn--danger')).toBe(true)
			expect(await confirm.locator('svg.kit-icon').count()).toBe(1)
			expect(await hasClass(dialog.getByRole('button', { name: 'Cancel' }), 'kit-btn--outline')).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('Sign-in: a full-width Kit primary submit that stays disabled until a token is typed', async () => {
		const { context, page } = await open('/login', false)
		try {
			const submit = page.getByRole('button', { name: 'Sign in' })
			await submit.waitFor()
			expect(await hasClass(submit, 'kit-btn--primary')).toBe(true)
			expect(await hasClass(submit, 'is-full-width')).toBe(true)
			expect(await submit.getAttribute('type')).toBe('submit')
			expect(await submit.isDisabled()).toBe(true)
			await page.locator('input[type="password"]').fill('uiux_t_not-a-token')
			expect(await submit.isDisabled()).toBe(false)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('a session that has ended (Rule 01a11544-08e0)', () => {
	it('returns the Workbench to /login with the page to come back to when its next request is refused', async () => {
		const listSessions = async () => (await (await fetch(`${server.origin}/api/access/sessions`, { headers: server.headers })).json() as { sessions: { id: string }[] }).sessions
		const known = new Set((await listSessions()).map(session => session.id))
		// The Workbench under test signs in with a session of its own, which the Owner's session then ends.
		const own = await sessionCookieFor(server.origin, server.token)
		const ended = (await listSessions()).filter(session => !known.has(session.id))
		expect(ended).toHaveLength(1)

		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addCookies([{ ...own, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
			await page.locator('[data-members-table] tbody tr').first().waitFor({ timeout: 15_000 })
			expect(new URL(page.url()).pathname).toBe('/members')

			const revoked = await fetch(`${server.origin}/api/access/sessions/${encodeURIComponent(ended[0]!.id)}`, { method: 'DELETE', headers: { ...server.headers, origin: server.origin } })
			expect(revoked.status).toBe(200)

			// The next request the Workbench makes is answered 401; it returns to the sign-in page, keeping the page it was on.
			await page.reload({ waitUntil: 'networkidle' })
			await page.waitForURL(url => url.pathname === '/login', { timeout: 15_000 })
			expect(new URL(page.url()).searchParams.get('next')).toBe('/members')
			await page.getByRole('button', { name: 'Sign in' }).waitFor()
		}
		finally { await context.close() }
	}, 90_000)

	it('returns to /login without a reload when a request of the open page is refused', async () => {
		const listSessions = async () => (await (await fetch(`${server.origin}/api/access/sessions`, { headers: server.headers })).json() as { sessions: { id: string }[] }).sessions
		const known = new Set((await listSessions()).map(session => session.id))
		const own = await sessionCookieFor(server.origin, server.token)
		const ended = (await listSessions()).filter(session => !known.has(session.id))
		expect(ended).toHaveLength(1)

		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
		})
		await context.addCookies([{ ...own, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/members`, { waitUntil: 'networkidle' })
			await page.locator('[data-members-table] tbody tr').first().waitFor({ timeout: 15_000 })
			const revoked = await fetch(`${server.origin}/api/access/sessions/${encodeURIComponent(ended[0]!.id)}`, { method: 'DELETE', headers: { ...server.headers, origin: server.origin } })
			expect(revoked.status).toBe(200)

			// A request of the open page (here the Workbench's own read of the roster), not a navigation.
			await page.evaluate(() => fetch('/api/access/members'))
			await page.waitForURL(url => url.pathname === '/login', { timeout: 15_000 })
			expect(new URL(page.url()).searchParams.get('next')).toBe('/members')
			expect(new URL(page.url()).searchParams.get('expired')).toBe('1')
		}
		finally { await context.close() }
	}, 90_000)
})
