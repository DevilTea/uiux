import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { bearer, provisionToken } from './support/access'

/**
 * Send again after a reply conflict (Rule 01a116f0-95fc-77c6-a7ab-1318cb6d19af, issue #117): the
 * reply is refused because others replied meanwhile; the Workbench keeps the text, says what
 * changed and sends it again only when asked, exactly once, against the re-read revision
 * (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb). The same in the canvas thread bubble and in the
 * Reviews detail and phone sheet.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const REPLY = 'Agreed, the label should say what it checks.'

let server: WorkbenchServer
let browser: Browser
let agent: string

async function api<T>(path: string, body?: unknown, headers: Record<string, string> = server.headers): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'content-type': 'application/json', ...headers },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}
const revision = async (id: string) => (await api<{ revision: string }>(`/api/resources/review/${id}`)).revision

/** A thread with one message, by the agent. */
async function seedThread(body: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } }, bearer(agent))
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body }, bearer(agent))
	return created.key
}
/** Someone else replies while the Workbench still shows the earlier revision. */
async function replyElsewhere(id: string, body: string): Promise<void> {
	await api(`/api/reviews/${id}/messages`, { expectedRevision: await revision(id), body }, bearer(agent))
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	agent = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', preset: 'editor' })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, setup: Readonly<{ width?: number; height?: number; touch?: boolean }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1440, height: setup.height ?? 900 },
		colorScheme: 'light',
		...(setup.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

type Surface = Readonly<{ scope: Locator; reply: string; send: string }>

/**
 * Drives one conflict in `surface`: two replies land elsewhere, the user's reply is refused, the
 * alert names the two new replies and keeps the text, nothing is resent until Send again, and Send
 * again sends exactly one more request, which lands.
 */
async function driveConflict(page: Page, threadId: string, surface: Surface): Promise<void> {
	const { scope } = surface
	const messages = scope.locator('[data-timeline-kind="message"]')
	await expect.poll(() => messages.count(), { timeout: 15_000 }).toBe(1)

	// Replies sent (counted when the request leaves) and their answers: equal counts mean none is in flight.
	const isReply = (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/reviews/${threadId}/messages`
	let sent = 0
	const posts: number[] = []
	page.on('request', (request) => { if (isReply(request)) sent++ })
	page.on('response', (response) => { if (isReply(response.request())) posts.push(response.status()) })
	const settled = () => expect.poll(() => sent - posts.length, { timeout: 10_000 }).toBe(0)
	await replyElsewhere(threadId, 'First reply from elsewhere.')
	await replyElsewhere(threadId, 'Second reply from elsewhere.')

	await scope.locator(surface.reply).fill(REPLY)
	await scope.locator(surface.send).click()

	const alert = scope.locator('[data-reply-conflict]')
	await alert.waitFor({ timeout: 10_000 })
	expect(await alert.getAttribute('role')).toBe('alert')
	await expect.poll(() => alert.getAttribute('data-new-replies'), { timeout: 10_000 }).toBe('2')
	expect(await alert.innerText()).toContain('2 new replies.')
	expect(await alert.innerText()).toContain('This thread changed before your reply was sent.')
	await expect.poll(() => messages.count(), { timeout: 10_000 }).toBe(3)
	expect(await scope.locator(surface.reply).inputValue()).toBe(REPLY)
	// Never resent by itself: the re-read has landed, and no second reply was sent.
	await settled()
	expect(sent).toBe(1)
	expect(posts).toEqual([409])

	await alert.locator('[data-reply-send-again]').click()
	await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(2)
	expect(posts[1]).toBeLessThan(300)
	await expect.poll(() => messages.count(), { timeout: 10_000 }).toBe(4)
	await alert.waitFor({ state: 'detached', timeout: 10_000 })
	expect(await scope.locator(surface.reply).inputValue()).toBe('')
	// The alert held focus; focus returns to the reply box, not the body.
	await expect.poll(() => scope.locator(surface.reply).evaluate(element => element === document.activeElement), { timeout: 10_000 }).toBe(true)
	await settled()
	expect(sent).toBe(2)
	expect(posts).toHaveLength(2)
	const read = await api<{ resource: { messages: { body: string }[] } }>(`/api/resources/review/${threadId}`)
	expect(read.resource.messages.map(message => message.body)).toEqual(['Run checks reads like a destructive action.', 'First reply from elsewhere.', 'Second reply from elsewhere.', REPLY])
}

describe('Send again after a reply conflict (issue #117)', () => {
	it('in the Reviews detail', async () => {
		const id = await seedThread('Run checks reads like a destructive action.')
		const { context, page } = await open(`/reviews?thread=${id}`, { width: 1920, height: 1080 })
		try {
			const scope = page.locator(`[data-review-detail][data-thread-id="${id}"]`)
			await scope.waitFor({ timeout: 15_000 })
			await driveConflict(page, id, { scope, reply: '[data-review-reply]', send: '[data-review-send]' })
		}
		finally { await context.close() }
	}, 90_000)

	it('in the Reviews sheet on a phone', async () => {
		const id = await seedThread('Run checks reads like a destructive action.')
		const { context, page } = await open('/reviews', { width: 390, height: 844, touch: true })
		try {
			await page.locator(`[data-review-row="${id}"]`).click()
			const scope = page.locator('[role="dialog"] [data-review-detail]')
			await scope.waitFor({ timeout: 15_000 })
			await driveConflict(page, id, { scope, reply: '[data-review-reply]', send: '[data-review-send]' })
		}
		finally { await context.close() }
	}, 90_000)

	it('in the canvas thread bubble', async () => {
		const id = await seedThread('Run checks reads like a destructive action.')
		const { context, page } = await open(`/views/${VIEW_ID}?thread=${id}`)
		try {
			const scope = page.locator('[data-thread-bubble]')
			await scope.waitFor({ timeout: 15_000 })
			await driveConflict(page, id, { scope, reply: '[data-thread-reply]', send: '[data-thread-send]' })
		}
		finally { await context.close() }
	}, 90_000)
})
