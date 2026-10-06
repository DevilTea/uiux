import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { untranslatedWords } from './support/i18n-allowlist.mjs'

/**
 * Walks the Workbench in zh-TW against the built server and fails on English chrome: visible text
 * and accessible names (aria-label, title, placeholder, alt, aria-description, roledescription,
 * document.title) that hold an English word outside the shared allowlist
 * (tests/support/i18n-allowlist.mjs). Workspace content (View names, comments, ids, member names,
 * the session's user agent) is English in the fixture and is set aside by matching it against the
 * Workspace files and the access API; `translate="no"`, `lang="en"`, code and keyboard keys are
 * literal by markup. The static half of this guard is tests/workbench-i18n-guard.test.ts.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const THREAD_ID = '140f4e87-cc50-4768-a82b-56b663609321'

/** Stands for the open thread seeded in `beforeAll` in a step's path. */
const OPEN_THREAD = '{open-thread}'

let server: WorkbenchServer
let browser: Browser
let corpus: string[] = []
let openThread = ''

async function post<T>(path: string, body: unknown): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry)
		return statSync(path).isDirectory() ? walk(path) : [path]
	})
}

/** Every string a Workspace file or the access API holds: content, not chrome. */
function collectStrings(value: unknown, out: Set<string>): void {
	if (typeof value === 'string') { if (value.trim().length >= 2) out.add(value.trim()) }
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out)
	else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { out.add(key); collectStrings(item, out) }
}

async function buildCorpus(): Promise<string[]> {
	const strings = new Set<string>([server.workspaceRoot])
	for (const file of walk(server.workspaceRoot).filter(path => path.endsWith('.json'))) {
		try { collectStrings(JSON.parse(readFileSync(file, 'utf8')), strings) }
		catch { /* not JSON content */ }
	}
	for (const path of ['/api/access/members', '/api/access/tokens', '/api/access/sessions']) {
		const response = await fetch(`${server.origin}${path}`, { headers: server.headers })
		if (response.ok) collectStrings(await response.json(), strings)
	}
	strings.add(await browser.version())
	return [...strings].sort((left, right) => right.length - left.length)
}

type Item = Readonly<{ kind: string; text: string; where: string }>

/** Visible text nodes and accessible-name attributes of the Workbench document (not the Preview iframe). */
async function collect(page: Page): Promise<Item[]> {
	return page.evaluate(() => {
		const items: { kind: string; text: string; where: string }[] = []
		const literal = 'script, style, code, kbd, pre, samp, svg, iframe, [translate="no"], [lang="en"]'
		const visible = (element: Element) => {
			const style = getComputedStyle(element)
			return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0
		}
		const where = (element: Element) => {
			const parts: string[] = []
			for (let node: Element | null = element, depth = 0; node && depth < 3; node = node.parentElement, depth++)
				parts.unshift(node.tagName.toLowerCase() + [...node.attributes].filter(attr => attr.name.startsWith('data-')).slice(0, 1).map(attr => `[${attr.name}]`).join(''))
			return parts.join(' > ')
		}
		const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
		for (let node = walker.nextNode(); node; node = walker.nextNode()) {
			const text = node.textContent?.replace(/\s+/g, ' ').trim() ?? ''
			const parent = node.parentElement
			if (!text || !/[A-Za-z]/.test(text) || !parent || parent.closest(literal) || !visible(parent)) continue
			items.push({ kind: 'text', text, where: where(parent) })
		}
		const attributes = ['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-roledescription', 'aria-valuetext']
		for (const element of Array.from(document.querySelectorAll(attributes.map(name => `[${name}]`).join(', ')))) {
			if (element.closest('iframe, [translate="no"], [lang="en"]') || !visible(element)) continue
			for (const name of attributes) {
				const value = element.getAttribute(name)?.replace(/\s+/g, ' ').trim()
				if (value && /[A-Za-z]/.test(value)) items.push({ kind: name, text: value, where: where(element) })
			}
		}
		items.push({ kind: 'document.title', text: document.title, where: 'head' })
		return items
	})
}

/** The English words of one text once Workspace content is set aside. */
function englishIn(text: string): string[] {
	const bare = text.replace(/…$/, '').trim()
	// A truncated or partial rendering of one content string (a long comment, a View name).
	if (bare.length >= 12 && corpus.some(item => item.includes(bare))) return []
	let rest = ` ${text} `
	for (const item of corpus) {
		if (item.length < 3 || !rest.includes(item)) continue
		const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		rest = rest.replace(new RegExp(`(?<![A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_-])`, 'g'), ' ')
	}
	return untranslatedWords(rest)
}

type Step = Readonly<{ name: string; path: string; signedOut?: boolean; before?: (page: Page) => Promise<void>; act?: (page: Page) => Promise<void> }>

/** Answers matching requests the way the server refuses them: an English message and coded diagnostics. */
function refuse(pattern: string, status: number, body: Record<string, unknown>) {
	return (page: Page) => page.route(pattern, route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }))
}

const pause = (page: Page, ms = 600) => page.waitForTimeout(ms)

const STEPS: readonly Step[] = [
	{ name: 'Overview · Views', path: '/' },
	{ name: 'Overview · Checks', path: '/', act: async (page) => { await page.getByRole('tab').nth(1).click(); await page.locator('[data-run-checks]').click(); await page.waitForSelector('[data-run-checks]:not([disabled])', { timeout: 20_000 }) } },
	{ name: 'Overview · Activity', path: '/', act: async (page) => { await page.getByRole('tab').nth(2).click() } },
	{ name: 'Views', path: '/views' },
	{ name: 'View · Comments', path: `/views/${VIEW_ID}?panel=comments` },
	{ name: 'View · Inspect', path: `/views/${VIEW_ID}?panel=inspect&widget=root` },
	{ name: 'View · Spec', path: `/views/${VIEW_ID}?panel=spec` },
	{ name: 'View · Readiness', path: `/views/${VIEW_ID}?panel=readiness` },
	{ name: 'View · thread bubble', path: `/views/${VIEW_ID}?thread=${THREAD_ID}`, act: async (page) => { await page.waitForSelector('[data-thread-bubble]', { timeout: 15_000 }) } },
	{ name: 'UX Flows', path: '/flows' },
	{ name: 'Reviews', path: '/reviews' },
	{ name: 'Reviews · thread', path: `/reviews?thread=${THREAD_ID}`, act: async (page) => { await page.waitForSelector('[data-review-detail]', { timeout: 15_000 }) } },
	{ name: 'Reviews · filters', path: '/reviews', act: async (page) => { await page.locator('[data-review-filters-toggle]').click() } },
	{ name: 'Reviews · open thread', path: `/reviews?thread=${OPEN_THREAD}`, act: async (page) => { await page.waitForSelector('[data-review-detail]', { timeout: 15_000 }) } },
	{ name: 'Reviews · resolve menu', path: `/reviews?thread=${OPEN_THREAD}`, act: async (page) => { await page.locator('[data-review-resolve-menu]').click() } },
	{ name: 'Reviews · message menu', path: `/reviews?thread=${OPEN_THREAD}`, act: async (page) => { await page.locator('[data-message-menu]').first().click() } },
	{ name: 'Reviews · submit for review', path: `/reviews?thread=${OPEN_THREAD}`, act: async (page) => { await page.locator('[data-review-submit]').first().click(); await page.locator('[data-submit-domains]').waitFor() } },
	{ name: 'Workspace settings', path: '/workspace/settings' },
	{ name: 'Adapters', path: '/workspace/adapters' },
	{ name: 'Locales', path: '/workspace/locales' },
	{ name: 'Assets', path: '/workspace/assets' },
	{ name: 'Members', path: '/members' },
	{ name: 'Command palette', path: '/', act: async (page) => { await page.keyboard.press('ControlOrMeta+k') } },
	{ name: 'Keyboard shortcuts', path: '/', act: async (page) => { await page.keyboard.press('Shift+?'); await page.getByRole('dialog').waitFor() } },
	{ name: 'Unknown page', path: '/no-such-page' },
	{
		name: 'View · load failure',
		path: `/views/${VIEW_ID}`,
		before: refuse('**/api/resources/view/**', 500, { status: 'failed', message: 'The View file is not valid JSON.', diagnostics: [{ code: 'persistence.invalid_json', path: '/views/x.view.json', message: 'Unexpected token in JSON at position 12.' }] }),
	},
	{
		name: 'Assets · load failure',
		path: '/workspace/assets',
		before: refuse('**/api/resources/list', 500, { status: 'failed', message: 'Assets could not be listed.', code: 'persistence.lock_busy' }),
	},
	{ name: 'Sign-in', path: '/login', signedOut: true },
]

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	// One open thread by the signed-in Owner, so its menus and the submit form can be walked.
	const created = await post<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	await post(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: 'Seeded for the zh-TW walk.' })
	openThread = created.key
	corpus = await buildCorpus()
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

describe('Workbench in zh-TW', () => {
	it('shows no English chrome on any main screen', async () => {
		const findings: string[] = []
		for (const step of STEPS) {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
			await context.addInitScript(() => { localStorage.setItem('uiux.workbench.locale', 'zh-TW') })
			if (!step.signedOut) await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			try {
				await step.before?.(page)
				await page.goto(`${server.origin}${step.path.replace(OPEN_THREAD, openThread)}`, { waitUntil: 'networkidle' })
				await pause(page)
				if (step.act) { await step.act(page); await pause(page) }
				expect(await page.evaluate(() => document.documentElement.lang), step.name).toBe('zh-TW')
				const seen = new Set<string>()
				for (const item of await collect(page)) {
					const words = englishIn(item.text)
					const key = `${item.kind}|${item.text}`
					if (!words.length || seen.has(key)) continue
					seen.add(key)
					findings.push(`${step.name} · ${item.kind} "${item.text.slice(0, 120)}" (${words.join(', ')}) at ${item.where}`)
				}
			}
			finally { await context.close() }
		}
		expect(findings).toEqual([])
	}, 240_000)
})
