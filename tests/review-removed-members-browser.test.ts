import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { bearer, provisionToken, sessionCookieFor } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Review history from removed members (issue #79, Rule 01a11485-f185-7c23-8f2a-e045a279cd27): a
 * record whose `member:<uuid>` is no longer on the roster keeps its recorded display name and the
 * Workbench marks it "(removed)", in the thread messages, the timeline, the inbox row and the
 * author filter. A current member is never marked. Only a holder of `members.manage` can read the
 * roster, so any other viewer sees the recorded name unmarked.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

let server: WorkbenchServer
let browser: Browser

const unique = () => randomUUID().slice(0, 8)
const gone = `gone-${unique()}`
const stays = `stays-${unique()}`
let threadKey = ''

type Cookie = Readonly<{ name: string; value: string }>

async function call<T>(path: string, init: Readonly<{ method?: string; headers: Record<string, string>; body?: unknown }>): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
		headers: { 'content-type': 'application/json', ...init.headers },
		...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

async function reply(key: string, headers: Record<string, string>, body: string): Promise<void> {
	const read = await call<{ revision: string }>(`/api/resources/review/${key}`, { headers })
	await call(`/api/reviews/${key}/messages`, { headers, body: { expectedRevision: read.revision, body } })
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })

	const goneToken = await provisionToken(server.workspaceRoot, { nickname: gone, kind: 'human', preset: 'owner' })
	const staysToken = await provisionToken(server.workspaceRoot, { nickname: stays, kind: 'human', preset: 'reviewer' })
	const goneCookie = await sessionCookieFor(server.origin, goneToken)

	// The member that will be removed opens the thread; a current member replies; the removed
	// member resolves it, so the timeline has a lifecycle entry of theirs too.
	const created = await call<{ key: string }>('/api/reviews', { headers: bearer(goneToken), body: { anchor: { viewId: VIEW_ID, widgetId: 'root' } } })
	threadKey = created.key
	await reply(threadKey, bearer(goneToken), 'first note from the member who will leave')
	await reply(threadKey, bearer(staysToken), 'reply from a current member')
	const read = await call<{ revision: string }>(`/api/resources/review/${threadKey}`, { headers: bearer(goneToken) })
	await call(`/api/reviews/${threadKey}/resolve`, { headers: { cookie: `${goneCookie.name}=${goneCookie.value}` }, body: { expectedRevision: read.revision, resolution: 'answered' } })

	// Remove the member from the roster (Owner), keeping its records.
	const roster = await call<{ members: { id: string; nickname: string }[] }>('/api/access/members', { headers: server.headers })
	const member = roster.members.find(entry => entry.nickname === gone)
	if (!member) throw new Error('member was not provisioned')
	await call(`/api/access/members/${encodeURIComponent(member.id)}`, { method: 'DELETE', headers: server.headers })
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(cookie: Cookie, locale: 'en-US' | 'zh-TW' = 'en-US'): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript((value) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', value)
	}, locale)
	await context.addCookies([{ ...cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}/reviews?thread=${threadKey}&status=resolved`, { waitUntil: 'networkidle' })
	return { context, page }
}

const detail = (page: Page) => page.locator(`[data-review-detail][data-thread-id="${threadKey}"]`)

describe('Review history from a removed member', () => {
	it('marks the removed member\'s message and timeline entry, and not a current member, for a holder of `members.manage`', async () => {
		const { context, page } = await open(server.cookie)
		try {
			const pane = detail(page)
			await pane.waitFor({ timeout: 15_000 })
			await pane.getByText(`${gone} (removed)`).first().waitFor({ timeout: 15_000 })
			// The message header and the "resolved" timeline entry both name the removed member.
			expect(await pane.getByText(`${gone} (removed)`).count()).toBeGreaterThanOrEqual(2)
			expect(await pane.getByText(stays).count()).toBeGreaterThanOrEqual(1)
			expect(await pane.getByText(`${stays} (removed)`).count()).toBe(0)
			// The recorded name is kept, and the inbox row marks the author too.
			const row = page.locator(`[data-thread-id="${threadKey}"]`).first()
			expect(await row.count()).toBeGreaterThan(0)
			expect(await page.getByText(`${gone} (removed)`).count()).toBeGreaterThanOrEqual(3)
		}
		finally { await context.close() }
	}, 60_000)

	it('reads in Taiwan Traditional Chinese', async () => {
		const { context, page } = await open(server.cookie, 'zh-TW')
		try {
			await detail(page).getByText(`${gone}（已移除）`).first().waitFor({ timeout: 15_000 })
			expect(await detail(page).getByText(`${stays}（已移除）`).count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('shows the recorded name unmarked to a member without `members.manage`, who cannot read the roster', async () => {
		const token = await provisionToken(server.workspaceRoot, { nickname: `viewer-${unique()}`, kind: 'human', preset: 'viewer' })
		const { context, page } = await open(await sessionCookieFor(server.origin, token))
		try {
			await detail(page).getByText(gone).first().waitFor({ timeout: 15_000 })
			expect(await page.getByText('(removed)').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})
