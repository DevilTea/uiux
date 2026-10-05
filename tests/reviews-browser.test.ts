import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { bearer, provisionToken } from './support/access'

/**
 * The Reviews inbox (brief d; roadmap R8) against the built Workbench and a private copy of the
 * dogfood Workspace. Threads are seeded through the Review authoring API as several members
 * (three humans and one agent), never by hand.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** The dogfood thread: resolved (verified) by legacy actors before identity existed. */
const DOGFOOD_THREAD = '140f4e87-cc50-4768-a82b-56b663609321'
const EVIDENCE = 'sha256:db5e9c30b897238d4541488ed363d4ecf65e113a9c71133c479cc871ab95a3f7'

let server: WorkbenchServer
let browser: Browser
const tokens: Record<string, string> = {}
const seeded: Record<string, string> = {}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
/** `expect.poll` with room for a loaded machine: a mutation plus the summary reload can take seconds. */
const poll = <T>(read: () => T | Promise<T>, options: Readonly<{ timeout?: number }> = {}) => expect.poll(read, { timeout: 10_000, ...options })

async function api<T>(who: string, path: string, body?: unknown): Promise<T> {
	const headers = { 'content-type': 'application/json', ...(who === 'tester' ? server.headers : bearer(tokens[who]!)) }
	const response = await fetch(`${server.origin}${path}`, { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
	if (!response.ok) throw new Error(`${who} ${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}
const revision = async (id: string) => (await api<{ revision: string }>('tester', `/api/resources/review/${id}`)).revision

async function seedThread(who: string, widgetId: string, body: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>(who, '/api/reviews', { anchor: { viewId: VIEW_ID, widgetId } })
	await api(who, `/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
	await pause(15)
	return created.key
}
async function reply(who: string, id: string, body: string): Promise<void> {
	await api(who, `/api/reviews/${id}/messages`, { expectedRevision: await revision(id), body })
	await pause(15)
}
async function submit(id: string): Promise<void> {
	const view = await api<{ revision: string }>('tester', `/api/resources/view/${VIEW_ID}`)
	await api('claude', `/api/reviews/${id}/ready`, {
		expectedRevision: await revision(id),
		changeDomains: ['views', 'i18n'],
		resources: [{ identity: { kind: 'view', key: VIEW_ID }, revision: view.revision }],
		evidenceRefs: [{ kind: 'visual', evidence: EVIDENCE }],
	})
	await pause(15)
}
async function resolve(id: string, resolution: string, reason?: string): Promise<void> {
	await api('tester', `/api/reviews/${id}/resolve`, { expectedRevision: await revision(id), resolution, ...(reason ? { reason } : {}) })
	await pause(15)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	for (const nickname of ['mei', 'jun', 'ana']) tokens[nickname] = await provisionToken(server.workspaceRoot, { nickname, kind: 'human', role: 'reviewer' })
	tokens.claude = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', role: 'editor' })

	// Activity order (oldest first) is the creation order below, so 10a's expected order is known.
	seeded.openOld = await seedThread('mei', 'btn-run-checks', 'Run checks reads like a destructive action.')
	seeded.readyOld = await seedThread('jun', 'app-title', 'Title truncates at 1024px.')
	await submit(seeded.readyOld)
	seeded.missing = await seedThread('ana', 'promo-banner-removed', 'Is the promo banner gone on purpose?')
	seeded.declined = await seedThread('jun', 'header-tab-flows', 'Flows tab should come before Locales.')
	await submit(seeded.declined)
	await resolve(seeded.declined, 'wont-fix', 'We keep the authoring order.')
	seeded.readyNew = await seedThread('claude', 'views-search-box', 'The search box has no visible label in zh-TW.')
	await submit(seeded.readyNew)
	seeded.openNew = await seedThread('ana', 'workspace-tag', 'Workspace tag contrast looks low.')
	seeded.answered = await seedThread('mei', 'btn-theme-toggle', 'Why is the theme toggle secondary?')
	await reply('tester', seeded.answered, 'Secondary by design.')
	await resolve(seeded.answered, 'answered')
	// A reply moves an old open thread to the top of its group.
	await reply('jun', seeded.openOld, 'Also: the icon reads like "play".')
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Setup = Readonly<{ width?: number; height?: number; mode?: 'light' | 'dark'; locale?: 'en-US' | 'zh-TW'; touch?: boolean }>

async function openInbox(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: setup.mode ?? 'light',
		...(setup.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	await context.addInitScript(([mode, locale]) => {
		localStorage.setItem('nuxt-color-mode', mode)
		localStorage.setItem('uiux.workbench.locale', locale)
	}, [setup.mode ?? 'light', setup.locale ?? 'en-US'] as const)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('[data-review-inbox]').waitFor()
	await page.locator('[data-review-row]').first().waitFor({ timeout: 15_000 }).catch(() => undefined)
	return { context, page }
}

const rowIds = (page: Page) => page.locator('[data-review-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-review-row')))
const groups = (page: Page) => page.locator('[data-review-group]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-review-group')))

describe('Reviews inbox (R8)', () => {
	it('orders the default queue as Part 7 10a: resolved hidden, ready before open, latest activity first', async () => {
		const { context, page } = await openInbox('/reviews')
		try {
			expect(await groups(page)).toEqual(['ready-for-review', 'open'])
			expect(await rowIds(page)).toEqual([seeded.readyNew, seeded.readyOld, seeded.openOld, seeded.openNew, seeded.missing])
			// Author identity without color: initials for people, a bot glyph for the agent, plus the name.
			const agentRow = page.locator(`[data-review-row="${seeded.readyNew}"]`)
			expect(await agentRow.getAttribute('aria-label')).toContain('claude')
			expect(await agentRow.locator('[class*="i-lucide:bot"]').count()).toBeGreaterThan(0)
			// The lost Widget is flagged in its row, never hidden.
			expect(await page.locator(`[data-review-row="${seeded.missing}"] [data-review-anchor-warning]`).textContent()).toContain('Widget missing')

			// Resolved threads are reachable through the explicit tab, in their own group.
			await page.locator('[data-review-tabs] [role="tab"]', { hasText: 'Resolved' }).click()
			await poll(() => groups(page)).toEqual(['resolved'])
			expect(new URL(page.url()).searchParams.get('status')).toBe('resolved')
			expect(await rowIds(page)).toEqual([seeded.answered, seeded.declined, DOGFOOD_THREAD])
		}
		finally { await context.close() }
	}, 60_000)

	it('renders one chronological typed timeline with the declined submission marked Not accepted', async () => {
		const { context, page } = await openInbox(`/reviews?status=resolved&thread=${seeded.declined}`)
		try {
			const detail = page.locator(`[data-review-detail][data-thread-id="${seeded.declined}"]`)
			await detail.waitFor()
			await poll(() => detail.locator('[data-timeline-kind]').evaluateAll(items => items.map(item => item.getAttribute('data-timeline-kind'))))
				.toEqual(['message', 'submission', 'resolved'])
			expect(await detail.locator('[data-submission-not-accepted]').textContent()).toBe('Not accepted')
			expect(await detail.locator('[data-resolution="wont-fix"]').textContent()).toContain('Won\'t fix')
			expect(await detail.locator('[data-timeline-kind="resolved"]').textContent()).toContain('We keep the authoring order.')
			// Submissions expand to their evidence references.
			await detail.locator('[data-submission-evidence-toggle]').click()
			await poll(() => detail.locator('[data-timeline-kind="submission"]').textContent()).toContain('sha256:db5e…a3f7')

			// The dogfood thread: two verified submissions, a reopen between them, all in time order.
			await page.goto(`${server.origin}/reviews?status=resolved&thread=${DOGFOOD_THREAD}`, { waitUntil: 'networkidle' })
			const dogfood = page.locator(`[data-review-detail][data-thread-id="${DOGFOOD_THREAD}"]`)
			await poll(() => dogfood.locator('[data-timeline-kind]').evaluateAll(items => items.map(item => item.getAttribute('data-timeline-kind'))), { timeout: 10_000 })
				.toEqual(['message', 'message', 'submission', 'resolved', 'reopened', 'submission', 'resolved'])
			expect(await dogfood.locator('[data-resolution="verified"]').first().textContent()).toContain('Verified · submission')
		}
		finally { await context.close() }
	}, 60_000)

	it('filters by author, Mine, resolution and search, and keeps the filter in the URL', async () => {
		const { context, page } = await openInbox('/reviews')
		try {
			// Author is a client-side filter over the loaded threads.
			const mei = (await api<{ resource: { messages: { actor: { id: string } }[] } }>('tester', `/api/resources/review/${seeded.openOld}`)).resource.messages[0]!.actor.id
			await page.goto(`${server.origin}/reviews?author=${encodeURIComponent(mei)}`, { waitUntil: 'networkidle' })
			await poll(() => rowIds(page)).toEqual([seeded.openOld])
			expect(await page.locator('[data-review-chip]').textContent()).toContain('Author: mei')
			await page.locator('[data-review-chip]').click()
			await poll(() => new URL(page.url()).searchParams.has('author')).toBe(false)
			await poll(async () => (await rowIds(page)).length).toBe(5)

			// Mine: threads the signed-in member started or took part in (tester replied on and resolved "answered").
			await page.locator('[data-review-toggle="mine"]').click()
			await poll(() => new URL(page.url()).searchParams.get('mine')).toBe('1')
			await poll(() => page.locator('[data-review-empty="no-match"]').count()).toBe(1)
			await page.locator('[data-review-tabs] [role="tab"]', { hasText: 'Resolved' }).click()
			await poll(() => rowIds(page)).toEqual([seeded.answered, seeded.declined])

			// Resolution narrows resolved threads.
			await page.locator('[data-review-resolution-filter="answered"]').click()
			await poll(() => rowIds(page)).toEqual([seeded.answered])
			await poll(() => new URL(page.url()).searchParams.get('resolution')).toBe('answered')

			// A filtered inbox is a shareable link.
			await page.reload({ waitUntil: 'networkidle' })
			await poll(() => rowIds(page)).toEqual([seeded.answered])
			await page.locator('[data-review-clear]').click()
			await poll(() => [...new URL(page.url()).searchParams.keys()]).toEqual(['status'])

			// Search narrows without reordering; `/` focuses it.
			await page.locator('[data-review-tabs] [role="tab"]', { hasText: 'Inbox' }).click()
			await page.locator('[data-review-list]').focus()
			await page.keyboard.press('/')
			expect(await page.evaluate(() => document.activeElement?.closest('[data-review-search]') !== null)).toBe(true)
			await page.keyboard.type('title')
			await poll(() => rowIds(page)).toEqual([seeded.readyOld])
		}
		finally { await context.close() }
	}, 60_000)

	it('triages from the keyboard: J/K move, E resolves an open thread as answered in one keystroke and moves on', async () => {
		const target = await seedThread('mei', 'header-tab-assets', 'Assets tab icon is unclear.')
		const { context, page } = await openInbox('/reviews')
		try {
			const posts: { url: string; body: Record<string, unknown> }[] = []
			page.on('request', (request) => {
				if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/reviews'))
					posts.push({ url: new URL(request.url()).pathname, body: JSON.parse(request.postData() ?? '{}') as Record<string, unknown> })
			})
			const order = await rowIds(page)
			expect(order[2]).toBe(target)
			await page.locator('[data-review-list]').focus()
			await page.keyboard.press('j')
			await poll(() => new URL(page.url()).searchParams.get('thread')).toBe(order[0])
			await page.keyboard.press('j')
			await page.keyboard.press('j')
			await page.keyboard.press('k')
			await page.keyboard.press('j')
			await poll(() => new URL(page.url()).searchParams.get('thread')).toBe(target)
			await page.locator(`[data-review-detail][data-thread-id="${target}"] [data-review-resolve]`).waitFor()
			expect(await page.locator('[data-review-resolve]').textContent()).toContain('Resolve')

			const queue = await rowIds(page)
			const next = queue[queue.indexOf(target) + 1]
			await page.keyboard.press('e')
			await poll(() => posts.find(post => post.url.endsWith('/resolve'))?.body, { timeout: 10_000 })
				.toMatchObject({ resolution: 'answered', expectedRevision: expect.any(String) })
			expect(posts.find(post => post.url.endsWith('/resolve'))!.body).not.toHaveProperty('submissionId')
			expect(posts.find(post => post.url.endsWith('/resolve'))!.body).not.toHaveProperty('actor')
			// The resolved thread leaves the default queue and the next one opens.
			await poll(() => new URL(page.url()).searchParams.get('thread')).toBe(next)
			await poll(() => rowIds(page)).not.toContain(target)
			const stored = await api<{ resource: { status: string; history: { resolution?: string; actor: { displayName: string } }[] } }>('tester', `/api/resources/review/${target}`)
			expect(stored.resource.status).toBe('resolved')
			expect(stored.resource.history.at(-1)).toMatchObject({ resolution: 'answered', actor: { displayName: 'tester' } })

			// R focuses the reply; Ctrl+Enter sends it.
			await page.keyboard.press('r')
			expect(await page.evaluate(() => document.activeElement?.closest('[data-review-reply]') !== null)).toBe(true)
			await page.keyboard.type('Looking at it.')
			await page.keyboard.press('Control+Enter')
			await poll(() => posts.some(post => post.url.endsWith('/messages') && post.body.body === 'Looking at it.')).toBe(true)

			// Shift+E opens the other ways to resolve.
			await page.locator('[data-review-list]').focus()
			await page.keyboard.press('Shift+E')
			await poll(() => page.locator('[role="menu"]').count()).toBe(1)
			expect(await page.locator('[role="menu"]').textContent()).toContain('Won\'t fix')
			await page.keyboard.press('Escape')
		}
		finally { await context.close() }
	}, 60_000)

	it('deep-links a thread, opens it on the canvas with O, and explains a link to a missing thread', async () => {
		const { context, page } = await openInbox(`/reviews?thread=${seeded.readyOld}`)
		try {
			const detail = page.locator(`[data-review-detail][data-thread-id="${seeded.readyOld}"]`)
			await detail.waitFor()
			expect(await page.locator(`[data-review-row="${seeded.readyOld}"]`).getAttribute('aria-selected')).toBe('true')
			// Ready: Accept and resolve names the submission it accepts.
			expect(await detail.locator('[data-review-resolve]').textContent()).toContain('Accept and resolve')
			expect(await detail.locator('[data-submission-current]').count()).toBe(1)

			await page.locator('[data-review-list]').focus()
			await page.keyboard.press('o')
			await page.waitForURL(url => url.pathname === `/views/${VIEW_ID}`, { timeout: 10_000 })
			const url = new URL(page.url())
			expect(url.searchParams.get('thread')).toBe(seeded.readyOld)
			expect(url.searchParams.get('widget')).toBe('app-title')

			await page.goto(`${server.origin}/reviews?thread=00000000-0000-4000-8000-000000000000`, { waitUntil: 'networkidle' })
			await page.locator('[data-review-thread-missing]').waitFor({ timeout: 10_000 })
		}
		finally { await context.close() }
	}, 60_000)

	it('is the phone home: read, reply and resolve in a bottom sheet', async () => {
		const target = await seedThread('jun', 'header-tab-locales', 'Locales tab label wraps in zh-TW.')
		const { context, page } = await openInbox('/reviews', { width: 390, height: 844, touch: true, locale: 'zh-TW' })
		try {
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
			await page.locator(`[data-review-row="${target}"]`).click()
			const sheet = page.locator('[role="dialog"] [data-review-detail]')
			await sheet.waitFor()
			await sheet.locator('[data-review-reply]').fill('收到，我來看。')
			await sheet.locator('[data-review-send]').click()
			await poll(() => sheet.locator('[data-timeline-kind="message"]').count(), { timeout: 10_000 }).toBe(2)
			await sheet.locator('[data-review-resolve]').click()
			// Resolving returns to the list, where the thread has left the queue.
			await poll(() => page.locator('[role="dialog"] [data-review-detail]').count(), { timeout: 10_000 }).toBe(0)
			await poll(() => rowIds(page)).not.toContain(target)
			// No structural editing on a phone: no Re-anchor or Promote in the sheet's menu.
			await page.locator('[data-review-row]').first().click()
			await sheet.locator('button[aria-label="更多"]').click()
			const menu = await page.locator('[role="menu"]').textContent()
			expect(menu).not.toContain('重新錨定')
			expect(menu).not.toContain('Decision')
		}
		finally { await context.close() }
	}, 60_000)

	it('gives the Viewer role a read-only inbox', async () => {
		const token = await provisionToken(server.workspaceRoot, { nickname: 'viewer', kind: 'human', role: 'viewer' })
		const { sessionCookieFor } = await import('./support/access')
		const cookie = await sessionCookieFor(server.origin, token)
		const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } })
		await context.addCookies([{ ...cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/reviews?thread=${seeded.openOld}`, { waitUntil: 'networkidle' })
			await page.locator(`[data-review-detail][data-thread-id="${seeded.openOld}"] [data-timeline-kind="message"]`).first().waitFor({ timeout: 15_000 })
			expect(await page.locator('[data-review-reply]').count()).toBe(0)
			expect(await page.locator('[data-review-resolve]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})
