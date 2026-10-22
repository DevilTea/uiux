import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Request } from 'playwright'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { bearer, provisionToken } from './support/access'

/**
 * "Updated by others" while drafting a reply (Rule 01a11485-f434-75ed-ab0a-e321468c8407, issue
 * #80): an Agent replies over MCP while the user writes; live refresh shows the reply, the draft is
 * kept and a notice above the composer names one new reply. The draft stays aimed at the revision it
 * started on until the notice is acknowledged: acknowledged, the reply lands on the fresh revision;
 * sent without it, the reply is refused as a conflict and the draft is kept
 * (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb). The same in the canvas thread bubble and the Reviews detail.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const FIRST = 'The empty state needs a call to action.'
const AGENT_REPLY = 'Added a Create button to the empty state.'
const REPLY = 'Thanks, the button reads well.'

let server: WorkbenchServer
let browser: Browser
let agent: string
let mcp: Client

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

async function seedThread(): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } }, bearer(agent))
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: FIRST }, bearer(agent))
	return created.key
}

/** The Agent replies over MCP while the Workbench user is drafting. */
async function agentReplies(id: string): Promise<void> {
	const result = await mcp.callTool({ name: 'append_review_message', arguments: { reviewId: id, expectedRevision: await revision(id), body: AGENT_REPLY } })
	expect(result.isError).not.toBe(true)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	agent = await provisionToken(server.workspaceRoot, { nickname: 'claude', kind: 'agent', preset: 'editor' })
	mcp = new Client({ name: 'uiux-updated-by-others-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	await mcp.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), { requestInit: { headers: bearer(agent) } }))
}, 60_000)

afterAll(async () => {
	await mcp?.close()
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

type Surface = Readonly<{ path: (id: string) => string; scope: (id: string) => string; reply: string; send: string }>

const SURFACES: Readonly<Record<string, Surface>> = {
	'the Reviews detail': { path: id => `/reviews?thread=${id}`, scope: id => `[data-review-detail][data-thread-id="${id}"]`, reply: '[data-review-reply]', send: '[data-review-send]' },
	'the canvas thread bubble': { path: id => `/views/${VIEW_ID}?thread=${id}`, scope: () => '[data-thread-bubble]', reply: '[data-thread-reply]', send: '[data-thread-send]' },
}

/** Opens the thread, drafts the reply, and lets the Agent reply; returns once the notice is shown. */
async function draftWhileAgentReplies(surface: Surface): Promise<{ context: BrowserContext; page: Page; id: string; scope: Locator; notice: Locator; posts: number[]; sent: () => number }> {
	const id = await seedThread()
	const { context, page } = await open(surface.path(id))
	const scope = page.locator(surface.scope(id))
	await scope.waitFor({ timeout: 15_000 })
	const messages = scope.locator('[data-timeline-kind="message"]')
	await expect.poll(() => messages.count(), { timeout: 15_000 }).toBe(1)

	const isReply = (request: Request) => request.method() === 'POST' && new URL(request.url()).pathname === `/api/reviews/${id}/messages`
	let sent = 0
	const posts: number[] = []
	page.on('request', (request) => { if (isReply(request)) sent++ })
	page.on('response', (response) => { if (isReply(response.request())) posts.push(response.status()) })

	await scope.locator(surface.reply).fill(REPLY)
	const notice = scope.locator('[data-reply-updated]')
	expect(await notice.count()).toBe(0)
	await agentReplies(id)
	await expect.poll(() => messages.count(), { timeout: 10_000 }).toBe(2)
	await notice.waitFor({ timeout: 10_000 })
	expect(await notice.getAttribute('role')).toBe('status')
	expect(await notice.getAttribute('data-new-replies')).toBe('1')
	expect(await notice.innerText()).toContain('Updated by others — 1 new reply')
	// The notice sits above the composer, and the draft is kept.
	const [noticeBox, replyBox] = await Promise.all([notice.boundingBox(), scope.locator(surface.reply).boundingBox()])
	expect(noticeBox!.y).toBeLessThan(replyBox!.y)
	expect(await scope.locator(surface.reply).inputValue()).toBe(REPLY)
	// Nothing is sent by itself.
	expect(sent).toBe(0)
	return { context, page, id, scope, notice, posts, sent: () => sent }
}

describe('"Updated by others" while drafting a reply (issue #80)', () => {
	for (const [name, surface] of Object.entries(SURFACES)) {
		it(`in ${name}: acknowledging moves the draft to the fresh revision`, async () => {
			const { context, id, scope, notice, posts, page } = await draftWhileAgentReplies(surface)
			try {
				// Keyboard: the acknowledge button is reachable and gives focus back to the reply box.
				await notice.locator('[data-reply-acknowledge]').focus()
				await page.keyboard.press('Enter')
				await notice.waitFor({ state: 'detached', timeout: 10_000 })
				await expect.poll(() => scope.locator(surface.reply).evaluate(element => element === document.activeElement), { timeout: 10_000 }).toBe(true)
				expect(await scope.locator(surface.reply).inputValue()).toBe(REPLY)

				await scope.locator(surface.send).click()
				await expect.poll(() => posts.length, { timeout: 10_000 }).toBe(1)
				expect(posts[0]).toBeLessThan(300)
				await expect.poll(() => scope.locator(surface.reply).inputValue(), { timeout: 10_000 }).toBe('')
				expect(await scope.locator('[data-reply-conflict]').count()).toBe(0)
				expect(await notice.count()).toBe(0)
				const read = await api<{ resource: { messages: { body: string }[] } }>(`/api/resources/review/${id}`)
				expect(read.resource.messages.map(message => message.body)).toEqual([FIRST, AGENT_REPLY, REPLY])
			}
			finally { await context.close() }
		}, 90_000)

		it(`in ${name}: sending without acknowledging is refused and keeps the draft`, async () => {
			const { context, id, scope, notice, posts, sent } = await draftWhileAgentReplies(surface)
			try {
				await scope.locator(surface.send).click()
				const alert = scope.locator('[data-reply-conflict]')
				await alert.waitFor({ timeout: 10_000 })
				expect(posts).toEqual([409])
				expect(await alert.getAttribute('data-new-replies')).toBe('1')
				expect(await scope.locator(surface.reply).inputValue()).toBe(REPLY)
				// The conflict alert takes over from the notice; nothing was resent.
				await notice.waitFor({ state: 'detached', timeout: 10_000 })
				expect(sent()).toBe(1)
				const read = await api<{ resource: { messages: { body: string }[] } }>(`/api/resources/review/${id}`)
				expect(read.resource.messages.map(message => message.body)).toEqual([FIRST, AGENT_REPLY])
			}
			finally { await context.close() }
		}, 90_000)
	}
})
