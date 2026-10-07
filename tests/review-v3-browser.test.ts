import { randomUUID } from 'node:crypto'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { bearer, provisionToken } from './support/access'

/**
 * The accepted Part 7 groups in the built Workbench, against a private (migrated) copy of the
 * frozen fixture Workspace: Workspace comments from the inbox and the command palette, inline
 * message edits with "· edited" and the Edit history, the frozen state, author retract with its
 * inline confirm and focus handling, the Resolve / Dismiss grouping and Dismissed filter, and
 * stale deep links. Threads are seeded through the Review API as real members, never by hand.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const EVIDENCE = 'sha256:db5e9c30b897238d4541488ed363d4ecf65e113a9c71133c479cc871ab95a3f7'

let server: WorkbenchServer
let browser: Browser
const tokens: Record<string, string> = {}

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const poll = <T>(read: () => T | Promise<T>, options: Readonly<{ timeout?: number }> = {}) => expect.poll(read, { timeout: 10_000, ...options })

async function call<T>(who: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST'): Promise<{ status: number; body: T }> {
	const headers = { 'content-type': 'application/json', ...(who === 'tester' ? server.headers : bearer(tokens[who]!)) }
	const response = await fetch(`${server.origin}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
	return { status: response.status, body: await response.json() as T }
}
async function api<T>(who: string, path: string, body?: unknown, method?: string): Promise<T> {
	const result = await call<T>(who, path, body, method)
	if (result.status >= 400) throw new Error(`${who} ${path}: ${result.status} ${JSON.stringify(result.body)}`)
	return result.body
}
type ThreadRead = { revision: string; resource: { anchor: Record<string, unknown>; status: string; messages: { id: string; body: string; edits?: { previousBody: string }[] }[] } }
const read = (id: string) => api<ThreadRead>('tester', `/api/resources/review/${id}`)

async function seed(who: string, anchor: Record<string, unknown>, body: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>(who, '/api/reviews', { anchor })
	await api(who, `/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body })
	await pause(15)
	return created.key
}
async function reply(who: string, id: string, body: string): Promise<void> {
	await api(who, `/api/reviews/${id}/messages`, { expectedRevision: (await read(id)).revision, body })
	await pause(15)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	tokens.mei = await provisionToken(server.workspaceRoot, { nickname: 'mei', kind: 'human', role: 'reviewer' })
	tokens.claude = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', role: 'editor' })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Setup = Readonly<{ width?: number; height?: number; locale?: 'en-US' | 'zh-TW' }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 }, colorScheme: 'light' })
	await context.addInitScript((locale) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', locale)
	}, setup.locale ?? 'en-US')
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

const detail = (page: Page, id: string) => page.locator(`[data-review-detail][data-thread-id="${id}"]`)
const activeMatches = (page: Page, selector: string) => page.evaluate(s => !!document.activeElement?.closest(s), selector)

describe('Workspace comments (scope/edit decision 8)', () => {
	it('creates a Workspace comment from the inbox: New comment, ⌘↵, then the row and detail say "Workspace"', async () => {
		const { context, page } = await open('/reviews')
		try {
			await page.locator('[data-review-new-comment]').click()
			const form = page.locator('[data-new-comment]')
			await form.waitFor()
			// Without a View to come from, the Workspace is the only place.
			expect(await form.locator('[data-new-comment-where]').textContent()).toContain('Workspace comment')
			await poll(() => activeMatches(page, '[data-new-comment-text]')).toBe(true)
			await page.keyboard.type('Use one date format everywhere.')
			await page.keyboard.press('ControlOrMeta+Enter')
			await poll(() => new URL(page.url()).searchParams.get('thread')).not.toBeNull()
			const id = new URL(page.url()).searchParams.get('thread')!
			expect((await read(id)).resource.anchor).toEqual({ scope: 'workspace' })
			const row = page.locator(`[data-review-row="${id}"]`)
			await poll(() => row.getAttribute('data-review-scope')).toBe('workspace')
			expect(await row.locator('[data-review-workspace-icon]').count()).toBe(1)
			expect(await row.textContent()).toContain('Workspace')
			await poll(() => detail(page, id).locator('[data-review-workspace]').textContent()).toContain('Workspace comment')
			// No canvas link for a Workspace thread.
			expect(await detail(page, id).locator('[data-review-open-canvas]').count()).toBe(0)
			// The View facet's Workspace option is a deep link: `view=workspace`.
			await page.goto(`${server.origin}/reviews?view=workspace`, { waitUntil: 'networkidle' })
			await poll(() => page.locator('[data-review-row]').evaluateAll(rows => rows.map(item => item.getAttribute('data-review-scope')))).toEqual(['workspace'])
		}
		finally { await context.close() }
	}, 60_000)

	it('offers "Comment on Workspace" in the command palette, with the View the reviewer is on as the other choice', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			await page.keyboard.press('ControlOrMeta+k')
			const search = page.locator('[role="dialog"] input').first()
			await search.waitFor()
			await search.fill('Comment on Workspace')
			await poll(() => page.locator('[role="option"]').first().textContent()).toContain('Comment on Workspace')
			await page.locator('[role="option"]').first().click()
			await poll(() => new URL(page.url()).pathname).toBe('/reviews')
			expect(new URL(page.url()).searchParams.get('compose')).toBe('workspace')
			expect(new URL(page.url()).searchParams.get('from')).toBe(VIEW_ID)
			const form = page.locator('[data-new-comment]')
			await form.waitFor()
			const choices = form.locator('[data-new-comment-where] [role="radio"]')
			await poll(() => choices.count()).toBe(2)
			await form.locator('[data-new-comment-where]').getByText('This View:').click()
			await form.locator('textarea[data-new-comment-text], [data-new-comment-text] textarea').fill('The whole View needs a calmer header.')
			await form.locator('[data-new-comment-submit]').click()
			await poll(() => new URL(page.url()).searchParams.get('thread')).not.toBeNull()
			const id = new URL(page.url()).searchParams.get('thread')!
			expect((await read(id)).resource.anchor).toEqual({ viewId: VIEW_ID, widgetId: 'root' })
			// The one-shot compose keys are gone from the URL.
			expect(new URL(page.url()).searchParams.has('compose')).toBe(false)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Editing a message (scope/edit decisions 11–16)', () => {
	it('edits inline with ⌘↵, cancels with Esc, reaches the editor with ↑, and shows "· edited" with its history', async () => {
		const id = await seed('tester', { scope: 'workspace' }, 'Use one date fromat.')
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const thread = detail(page, id)
			const message = thread.locator('[data-message-id]').first()
			await message.waitFor()
			expect(await message.getAttribute('data-message-editable')).toBe('')
			await message.hover()
			await message.locator('[data-message-menu]').click()
			await page.getByRole('menuitem', { name: 'Edit' }).click()
			const editor = message.locator('[data-message-editor] textarea')
			await poll(() => activeMatches(page, '[data-message-editor]')).toBe(true)
			// Esc cancels and keeps the text.
			await editor.fill('Something else')
			await page.keyboard.press('Escape')
			await poll(() => message.locator('[data-message-editor]').count()).toBe(0)
			expect(await thread.count()).toBe(1)
			expect((await read(id)).resource.messages[0]!.body).toBe('Use one date fromat.')

			// ↑ in the empty reply box opens the editor on the viewer's latest editable message.
			await thread.locator('textarea[data-review-reply], [data-review-reply] textarea').focus()
			await page.keyboard.press('ArrowUp')
			await poll(() => activeMatches(page, '[data-message-editor]')).toBe(true)
			await editor.fill('Use one date format everywhere.')
			await page.keyboard.press('ControlOrMeta+Enter')
			await poll(async () => (await read(id)).resource.messages[0]!.body).toBe('Use one date format everywhere.')
			expect((await read(id)).resource.messages[0]!.edits?.[0]?.previousBody).toBe('Use one date fromat.')
			await poll(() => message.getAttribute('data-message-edited')).toBe('')
			// The title follows the current text; the editor hands focus back to the reply box.
			await poll(() => thread.locator('h2').textContent()).toContain('Use one date format everywhere.')
			await poll(() => activeMatches(page, '[data-review-reply]')).toBe(true)

			const toggle = message.locator('[data-message-edited-toggle]')
			expect(await toggle.textContent()).toContain('edited')
			expect(await toggle.getAttribute('aria-label')).toMatch(/^Edited .+\. Show earlier versions$/u)
			await toggle.click()
			const history = page.locator('[data-edit-history]')
			await history.waitFor()
			expect(await history.locator('[data-edit-version]').evaluateAll(items => items.map(item => item.querySelector('p')?.textContent))).toEqual(['Use one date format everywhere.', 'Use one date fromat.'])
			expect(await history.textContent()).toContain('Current')
		}
		finally { await context.close() }
	}, 60_000)

	it('shows Edit disabled with the reason once a submission came after the message, and no Edit on others\' messages', async () => {
		const id = await seed('tester', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Title truncates.')
		await reply('mei', id, 'Agreed.')
		const view = await api<{ revision: string }>('tester', `/api/resources/view/${VIEW_ID}`)
		await api('claude', `/api/reviews/${id}/ready`, {
			expectedRevision: (await read(id)).revision,
			changeDomains: ['views'],
			resources: [{ identity: { kind: 'view', key: VIEW_ID }, revision: view.revision }],
			evidenceRefs: [{ kind: 'visual', evidence: EVIDENCE }],
		})
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const thread = detail(page, id)
			const mine = thread.locator('[data-message-id]').first()
			await mine.waitFor()
			expect(await mine.getAttribute('data-message-frozen')).toBe('')
			await mine.hover()
			await mine.locator('[data-message-menu]').click()
			const edit = page.getByRole('menuitem', { name: /Edit/u })
			expect(await edit.getAttribute('aria-disabled')).toBe('true')
			expect(await edit.textContent()).toContain('Can\'t edit: a submission came after this message. Reply instead.')
			await page.keyboard.press('Escape')
			// Another member's message has no Edit at all.
			expect(await thread.locator('[data-message-id]').nth(1).locator('[data-message-menu]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Author retract (retract addendum decision 8)', () => {
	it('deletes an eligible thread after an inline confirm that starts on Cancel, then moves focus and announces it', async () => {
		const id = await seed('tester', { scope: 'workspace' }, 'Half-typed thought, sorry.')
		const { context, page } = await open(`/reviews?thread=${id}`)
		try {
			const thread = detail(page, id)
			await thread.waitFor()
			await thread.locator('[aria-label="More"]').first().click()
			await page.getByRole('menuitem', { name: 'Delete comment' }).click()
			const confirm = thread.locator('[data-retract-confirm]')
			await confirm.waitFor()
			expect(await confirm.textContent()).toContain('Delete this comment?')
			expect(await confirm.textContent()).toContain('It will be removed for everyone and can\'t be restored.')
			await poll(() => activeMatches(page, '[data-retract-cancel]')).toBe(true)
			// Esc cancels; nothing was deleted.
			await page.keyboard.press('Escape')
			await poll(() => confirm.count()).toBe(0)
			expect((await call('tester', `/api/resources/review/${id}`)).status).toBe(200)

			const deletes: string[] = []
			page.on('request', (request) => { if (request.method() === 'DELETE') deletes.push(new URL(request.url()).pathname) })
			await thread.locator('[aria-label="More"]').first().click()
			await page.getByRole('menuitem', { name: 'Delete comment' }).click()
			await confirm.waitFor()
			await confirm.locator('[data-retract-delete]').click()
			await poll(() => deletes).toEqual([`/api/reviews/${id}`])
			await poll(async () => (await call('tester', `/api/resources/review/${id}`)).status).toBe(404)
			// The deleted id leaves the URL: desktop moves on to the next row (as after a resolve), else none.
			await poll(() => new URL(page.url()).searchParams.get('thread')).not.toBe(id)
			await poll(() => page.locator('[role="status"][aria-live="polite"]').first().textContent()).toContain('Comment deleted.')
			await poll(() => page.locator(`[data-review-row="${id}"]`).count()).toBe(0)
			await poll(() => activeMatches(page, '[data-review-list], [data-review-heading]')).toBe(true)
			// It stays there once the overflow menu finished closing: the menu unmounts after its close
			// animation (late under load) and must not hand focus back to its trigger, which by then
			// belongs to the next thread. Its trigger refocus would run in a task after the unmount.
			await poll(() => page.locator('[role="menu"]').count()).toBe(0)
			await page.evaluate(() => new Promise(resolve => setTimeout(() => requestAnimationFrame(resolve), 0)))
			expect(await activeMatches(page, '[data-review-list], [data-review-heading]')).toBe(true)
			const next = new URL(page.url()).searchParams.get('thread')
			if (next) expect(await page.locator('[data-review-list]').getAttribute('aria-activedescendant')).toBe(`review-row-${next}`)
		}
		finally { await context.close() }
	}, 60_000)

	it('deletes from the canvas bubble: the bubble and pin go, and focus returns to the canvas region', async () => {
		const id = await seed('tester', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Wrong Widget, sorry.')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${id}&panel=comments`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 15_000 })
			await bubble.locator('[aria-label="More"]').click()
			await page.getByRole('menuitem', { name: 'Delete comment' }).click()
			await bubble.locator('[data-retract-confirm]').waitFor()
			await poll(() => activeMatches(page, '[data-retract-cancel]')).toBe(true)
			await bubble.locator('[data-retract-delete]').click()
			await poll(async () => (await call('tester', `/api/resources/review/${id}`)).status).toBe(404)
			await poll(() => bubble.count()).toBe(0)
			await poll(() => page.locator(`[data-pin-thread="${id}"]`).count()).toBe(0)
			await poll(() => activeMatches(page, '[data-canvas]')).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('hides Delete once anyone engaged, and on someone else\'s thread', async () => {
		const engaged = await seed('tester', { scope: 'workspace' }, 'Engaged thread.')
		await reply('mei', engaged, 'I have thoughts.')
		const others = await seed('mei', { scope: 'workspace' }, 'Mei\'s own thread.')
		const { context, page } = await open(`/reviews?thread=${engaged}`)
		try {
			for (const id of [engaged, others]) {
				await page.goto(`${server.origin}/reviews?thread=${id}`, { waitUntil: 'networkidle' })
				const thread = detail(page, id)
				await thread.locator('[data-message-id]').first().waitFor()
				await thread.locator('[aria-label="More"]').first().click()
				await page.getByRole('menuitem', { name: 'Copy thread ID' }).waitFor()
				expect(await page.getByRole('menuitem', { name: 'Delete comment' }).count()).toBe(0)
				await page.keyboard.press('Escape')
			}
		}
		finally { await context.close() }
	}, 60_000)

	it('explains a stale deep link: the inbox says it may have been deleted, the canvas shows a toast', async () => {
		const gone = randomUUID()
		const { context, page } = await open(`/reviews?thread=${gone}`)
		try {
			const missing = page.locator('[data-review-thread-missing]').first()
			await missing.waitFor()
			expect(await missing.textContent()).toContain('It may have been deleted by its author')

			await page.goto(`${server.origin}/views/${VIEW_ID}?thread=${gone}`, { waitUntil: 'networkidle' })
			await poll(() => page.getByText('That comment no longer exists.').count()).toBeGreaterThan(0)
			await poll(() => new URL(page.url()).searchParams.has('thread')).toBe(false)
			expect(await page.locator('[data-thread-bubble]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Dismiss presentation (retract addendum decision 11)', () => {
	it('groups the bubble\'s resolve menu, files a dismissal under Dismissed, and never draws its pin', async () => {
		const id = await seed('mei', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Duplicate of an older thread?')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${id}&panel=comments`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 15_000 })
			await bubble.locator('[data-thread-resolve-menu]').click()
			const menu = page.locator('[role="menu"]')
			await menu.waitFor()
			expect(await menu.textContent()).toMatch(/Resolve.*Answered.*Dismiss.*No longer relevant.*Duplicate….*Won't do/u)
			await page.getByRole('menuitem', { name: 'No longer relevant' }).click()
			await poll(async () => (await read(id)).resource.status).toBe('resolved')
			await poll(() => bubble.count()).toBe(0)
			// Even with resolved threads shown, a dismissed thread has no pin; it is listed as Dismissed.
			const resolvedFilter = page.locator('[data-comment-filter="resolved"]')
			if (await resolvedFilter.getAttribute('aria-pressed') !== 'true') await resolvedFilter.click()
			await poll(() => page.locator('[data-comment-group="dismissed"]').count()).toBe(1)
			expect(await page.locator(`[data-pin-thread="${id}"]`).count()).toBe(0)

			// In the inbox it is under Dismissed (「已捨棄」 in zh-TW), not Resolved.
			await page.goto(`${server.origin}/reviews?status=dismissed`, { waitUntil: 'networkidle' })
			await poll(() => page.locator(`[data-review-row="${id}"]`).getAttribute('data-review-inbox-status')).toBe('dismissed')
			await page.goto(`${server.origin}/reviews?status=resolved`, { waitUntil: 'networkidle' })
			await page.locator('[data-review-list]').waitFor()
			await pause(300)
			expect(await page.locator(`[data-review-row="${id}"]`).count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('reads the timeline chip as 「已捨棄・不再適用」 in zh-TW', async () => {
		const id = await seed('mei', { scope: 'workspace' }, 'Old idea.')
		await api('tester', `/api/reviews/${id}/resolve`, { expectedRevision: (await read(id)).revision, resolution: 'obsolete' })
		const { context, page } = await open(`/reviews?status=dismissed&thread=${id}`, { locale: 'zh-TW' })
		try {
			const chip = detail(page, id).locator('[data-resolution="obsolete"]')
			await chip.waitFor()
			expect(await chip.textContent()).toContain('已捨棄・不再適用')
			expect(await page.locator('[data-review-tabs]').textContent()).toContain('已捨棄')
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Shared thread actions (bubble and inbox detail)', () => {
	/** The resolution is derived from the last lifecycle event entering `resolved`. */
	const resolutionOf = async (id: string) => ((await read(id)).resource as { history?: { kind: string; to?: string; resolution?: string }[] }).history
		?.filter(event => event.kind === 'lifecycle' && event.to === 'resolved').at(-1)?.resolution

	it('asks for Duplicate\'s reason first, on the canvas bubble and in the inbox detail', async () => {
		const onCanvas = await seed('mei', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Same as the header thread.')
		const inInbox = await seed('mei', { scope: 'workspace' }, 'Same as the date-format thread.')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${onCanvas}&panel=comments`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 15_000 })
			await bubble.locator('[data-thread-resolve-menu]').click()
			await page.getByRole('menuitem', { name: 'Duplicate…' }).click()
			await poll(() => activeMatches(page, '[data-thread-reason] input')).toBe(true)
			expect(await bubble.locator('[data-thread-reason-confirm]').isDisabled()).toBe(true)
			await page.keyboard.type('See the header thread.')
			await page.keyboard.press('Enter')
			await poll(() => resolutionOf(onCanvas)).toBe('duplicate')

			await page.goto(`${server.origin}/reviews?thread=${inInbox}`, { waitUntil: 'networkidle' })
			const thread = detail(page, inInbox)
			await thread.locator('[data-message-id]').first().waitFor()
			await thread.locator('[data-review-resolve-menu]').click()
			await page.getByRole('menuitem', { name: 'Duplicate…' }).click()
			await poll(() => activeMatches(page, '[data-thread-reason] input')).toBe(true)
			await page.keyboard.type('See the date-format thread.')
			await thread.locator('[data-thread-reason-confirm]').click()
			await poll(() => resolutionOf(inInbox)).toBe('duplicate')
		}
		finally { await context.close() }
	}, 90_000)

	it('opens Promote to Decision on the thread title from both surfaces', async () => {
		const id = await seed('mei', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Should the title wrap or truncate?')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${id}&panel=comments`)
		try {
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 20_000 })
			const bubble = page.locator('[data-thread-bubble]')
			await bubble.waitFor({ timeout: 15_000 })
			for (const surface of ['bubble', 'detail'] as const) {
				if (surface === 'detail') {
					await page.goto(`${server.origin}/reviews?thread=${id}`, { waitUntil: 'networkidle' })
					await detail(page, id).locator('[data-message-id]').first().waitFor()
				}
				const root = surface === 'bubble' ? bubble : detail(page, id)
				await root.locator('[aria-label="More"]').first().click()
				await page.getByRole('menuitem', { name: 'Promote to Decision' }).click()
				const dialog = page.getByRole('dialog', { name: 'Promote to Decision' })
				await dialog.waitFor()
				expect(await dialog.getByRole('textbox').first().inputValue(), surface).toContain('Should the title wrap or truncate?')
				await dialog.getByRole('button', { name: 'Cancel' }).click()
				await poll(() => dialog.count()).toBe(0)
			}
			expect((await read(id)).resource.status).toBe('open')
		}
		finally { await context.close() }
	}, 90_000)

	it('sends one write when Enter is pressed again while Reopen or Promote is still in flight', async () => {
		const reopened = await seed('mei', { scope: 'workspace' }, 'Use sentence case in buttons.')
		await api('tester', `/api/reviews/${reopened}/resolve`, { expectedRevision: (await read(reopened)).revision, resolution: 'answered' })
		const promoted = await seed('mei', { viewId: VIEW_ID, widgetId: 'app-title' }, 'Wrap or truncate long titles?')
		const { context, page } = await open(`/reviews?status=resolved&thread=${reopened}`)
		try {
			// Hold each write long enough for the repeated Enter to land while it is in flight.
			const writes = { reopen: 0, promote: 0 }
			for (const action of ['reopen', 'promote'] as const) {
				await page.route(`**/api/reviews/*/${action}`, async (route) => {
					writes[action] += 1
					await pause(800)
					await route.continue()
				})
			}

			const thread = detail(page, reopened)
			await thread.locator('[data-message-id]').first().waitFor()
			await thread.locator('[data-review-reopen]').click()
			await poll(() => activeMatches(page, '[data-thread-reason] input')).toBe(true)
			await page.keyboard.type('Came back in QA.')
			await page.keyboard.press('Enter')
			await poll(() => thread.locator('[data-thread-reason-confirm]').isDisabled()).toBe(true)
			await page.keyboard.press('Enter')
			await page.keyboard.press('Enter')
			await poll(() => read(reopened).then(value => value.resource.status)).toBe('open')
			await pause(300)
			expect(writes.reopen).toBe(1)

			await page.goto(`${server.origin}/reviews?thread=${promoted}`, { waitUntil: 'networkidle' })
			await detail(page, promoted).locator('[data-message-id]').first().waitFor()
			await detail(page, promoted).locator('[aria-label="More"]').first().click()
			await page.getByRole('menuitem', { name: 'Promote to Decision' }).click()
			const dialog = page.getByRole('dialog', { name: 'Promote to Decision' })
			await dialog.waitFor()
			const summary = dialog.getByRole('textbox').nth(1)
			await summary.fill('Truncate with a tooltip.')
			await summary.press('Enter')
			await poll(() => writes.promote).toBe(1)
			await summary.press('Enter')
			await summary.press('Enter')
			await poll(() => dialog.count()).toBe(0)
			await pause(300)
			expect(writes.promote).toBe(1)
		}
		finally { await context.close() }
	}, 90_000)
})
