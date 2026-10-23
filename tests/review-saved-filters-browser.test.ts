import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Per-browser saved filters of the Reviews inbox (issue #62) against the built Workbench and a
 * private copy of the dogfood Workspace: save, reload, apply, rename, delete, a filter whose View
 * is gone, and an inbox whose storage refuses writes.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const GONE_VIEW_ID = '00000000-0000-4000-8000-000000000000'
const STORAGE_PREFIX = 'uiux.reviews.savedFilters:'

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

const poll = <T>(read: () => T | Promise<T>) => expect.poll(read, { timeout: 10_000 })

async function openInbox(path: string, options: Readonly<{ locale?: 'en-US' | 'zh-TW'; touch?: boolean; blockWrites?: boolean; context?: BrowserContext }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = options.context ?? await browser.newContext({
		viewport: { width: options.touch ? 390 : 1440, height: options.touch ? 844 : 900 },
		...(options.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	if (!options.context) {
		await context.addInitScript(([locale, block]) => {
			localStorage.setItem('uiux.workbench.locale', locale!)
			if (block) Storage.prototype.setItem = () => { throw new DOMException('blocked', 'QuotaExceededError') }
		}, [options.locale ?? 'en-US', options.blockWrites ? '1' : ''] as const)
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	}
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('[data-review-inbox]').waitFor()
	return { context, page }
}

const trigger = (page: Page) => page.locator('[data-review-saved-trigger]')
const items = (page: Page) => page.locator('[data-review-saved-item]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-review-saved-item')))
async function openMenu(page: Page): Promise<void> {
	await trigger(page).click()
	await page.locator('[data-review-saved]').waitFor()
}
// The popover content enters with Nuxt UI's `scale-in` (scale .95 to 1, 100ms, frame-driven), and
// `boundingBox()` includes that transform: a target measured near the end of the animation reads
// slightly under its layout size (43.86 px for a 44 px `min-h-11`). Wait for finite animations to end.
// The animation runs on an ancestor of the content, so read the document timeline.
const settled = (page: Page) => page.evaluate(() => Promise.all(document.getAnimations()
	.filter(animation => Number.isFinite(animation.effect?.getComputedTiming().endTime))
	.map(animation => animation.finished.catch(() => undefined))))
const stored = (page: Page) => page.evaluate((prefix) => {
	const key = Object.keys(localStorage).find(item => item.startsWith(prefix))
	return key ? { key, value: JSON.parse(localStorage.getItem(key)!) as { id: string; name: string; query: Record<string, string> }[] } : undefined
}, STORAGE_PREFIX)
const search = (page: Page) => Object.fromEntries(new URL(page.url()).searchParams)

describe('Reviews inbox saved filters (#62)', () => {
	it('saves, reloads, applies, renames and deletes a saved filter', async () => {
		const { context, page } = await openInbox(`/reviews?status=open,resolved&view=${VIEW_ID}&anchor=valid`)
		try {
			await openMenu(page)
			await page.locator('[data-review-saved-save]').click()
			// An empty name is refused in place; the form stays.
			await page.locator('[data-review-saved-submit]').click()
			expect(await page.locator('[data-review-saved-form]').textContent()).toContain('Enter a name.')
			await page.locator('[data-review-saved-name]').fill('Open in my View')
			await page.keyboard.press('Enter')
			await poll(() => items(page)).toEqual(['Open in my View'])
			// The filter is the current one, so it reads as applied.
			await expect.poll(() => page.locator('[data-review-saved-apply]').getAttribute('aria-pressed')).toBe('true')
			const saved = await stored(page)
			expect(saved?.key).toMatch(/^uiux\.reviews\.savedFilters:.+:.+/)
			expect(saved?.value).toHaveLength(1)
			expect(saved?.value[0]?.query).toEqual({ status: 'open,resolved', view: VIEW_ID, anchor: 'valid' })
			// A duplicate name is refused.
			await page.locator('[data-review-saved-save]').click()
			await page.locator('[data-review-saved-name]').fill('open in my view')
			await page.keyboard.press('Enter')
			expect(await page.locator('[data-review-saved-form]').textContent()).toContain('already has this name')
			await page.keyboard.press('Escape')
			// Escape cancels the form: the save button is back and no second filter exists.
			await page.locator('[data-review-saved-save]').waitFor()
			expect(await items(page)).toEqual(['Open in my View'])
			// A second filter, then renaming it to the first one's name (differently cased) is refused.
			await page.locator('[data-review-saved-save]').click()
			await page.locator('[data-review-saved-name]').fill('Second')
			await page.keyboard.press('Enter')
			await poll(() => items(page)).toEqual(['Open in my View', 'Second'])
			await page.locator('[data-review-saved-rename]').nth(1).click()
			await page.locator('[data-review-saved-name]').fill('OPEN IN MY VIEW')
			await page.keyboard.press('Enter')
			expect(await page.locator('[data-review-saved-form]').textContent()).toContain('already has this name')
			// Typing clears the error.
			await page.locator('[data-review-saved-name]').fill('Second!')
			expect(await page.locator('[data-review-saved-form]').textContent()).not.toContain('already has this name')
			await page.keyboard.press('Escape')
			await page.locator('[data-review-saved-delete]').nth(1).click()
			await poll(() => items(page)).toEqual(['Open in my View'])
		}
		finally { await page.close() }

		// A fresh load of the plain inbox keeps the saved filter; applying it restores the query.
		const reopened = await openInbox('/reviews', { context })
		try {
			expect(search(reopened.page)).toEqual({})
			await openMenu(reopened.page)
			expect(await items(reopened.page)).toEqual(['Open in my View'])
			expect(await reopened.page.locator('[data-review-saved-apply]').getAttribute('aria-pressed')).toBe('false')
			await reopened.page.locator('[data-review-saved-apply]').click()
			await poll(() => search(reopened.page)).toMatchObject({ status: 'open,resolved', view: VIEW_ID, anchor: 'valid' })
			await expect.poll(() => trigger(reopened.page).textContent()).toContain('Open in my View')

			// Rename.
			await openMenu(reopened.page)
			await reopened.page.locator('[data-review-saved-rename]').click()
			expect(await reopened.page.locator('[data-review-saved-name]').inputValue()).toBe('Open in my View')
			await reopened.page.locator('[data-review-saved-name]').fill('Renamed filter')
			await reopened.page.keyboard.press('Enter')
			await poll(() => items(reopened.page)).toEqual(['Renamed filter'])
			await poll(async () => (await stored(reopened.page))?.value[0]?.name).toBe('Renamed filter')
			// Escape cancels an edit without closing the menu or changing the name.
			await reopened.page.locator('[data-review-saved-rename]').click()
			await reopened.page.locator('[data-review-saved-name]').fill('Never saved')
			await reopened.page.keyboard.press('Escape')
			await reopened.page.locator('[data-review-saved-save]').waitFor()
			expect(await items(reopened.page)).toEqual(['Renamed filter'])
		}
		finally { await reopened.page.close() }

		// The rename survived a reload; delete empties the list and the storage entry.
		const again = await openInbox('/reviews', { context })
		try {
			await openMenu(again.page)
			expect(await items(again.page)).toEqual(['Renamed filter'])
			await again.page.locator('[data-review-saved-delete]').click()
			await poll(() => items(again.page)).toEqual([])
			await poll(async () => (await stored(again.page))?.value).toEqual([])
			expect(await again.page.locator('[data-review-saved]').textContent()).toContain('No saved filters yet')
		}
		finally { await context.close() }
	}, 90_000)

	it('drops a View that no longer exists on apply, says so, and ignores malformed storage', async () => {
		const { context, page } = await openInbox('/reviews?status=open')
		try {
			await openMenu(page)
			await page.locator('[data-review-saved-save]').click()
			await page.locator('[data-review-saved-name]').fill('Seed')
			await page.keyboard.press('Enter')
			await poll(() => items(page)).toEqual(['Seed'])
			const key = (await stored(page))!.key
			await page.evaluate(([storageKey, view]) => {
				localStorage.setItem(storageKey!, JSON.stringify([
					{ id: 'gone', name: 'Gone view', query: { status: 'open', view, anchor: 'stale' } },
					{ id: 42, name: 'malformed' },
				]))
			}, [key, GONE_VIEW_ID] as const)
			await page.close()

			const reloaded = await openInbox('/reviews', { context })
			await openMenu(reloaded.page)
			expect(await items(reloaded.page)).toEqual(['Gone view'])
			await reloaded.page.locator('[data-review-saved-apply]').click()
			await poll(() => search(reloaded.page)).toEqual({ status: 'open', anchor: 'stale' })
			await reloaded.page.locator('[data-review-saved-changed]').waitFor()
			expect(await reloaded.page.locator('[data-review-saved-changed]').textContent()).toContain('1 View that no longer exists')
			// A filter that lost a facet is not shown as the active one: it no longer equals what was saved.
			expect(await reloaded.page.locator('[data-review-saved-trigger]').textContent()).not.toContain('Gone view')
			// The notice goes away once the filter is changed by hand.
			await reloaded.page.locator('[data-review-toggle="unread"]').click()
			await poll(() => reloaded.page.locator('[data-review-saved-changed]').count()).toBe(0)

			// Corrupt JSON is ignored; the inbox still works.
			await reloaded.page.evaluate(storageKey => localStorage.setItem(storageKey, '{not json'), key)
			await reloaded.page.close()
			const corrupt = await openInbox('/reviews', { context })
			await openMenu(corrupt.page)
			expect(await items(corrupt.page)).toEqual([])
		}
		finally { await context.close() }
	}, 90_000)

	it('works when storage refuses writes, in zh-TW, with 44px targets on touch', async () => {
		const { context, page } = await openInbox('/reviews?status=open', { locale: 'zh-TW', touch: true, blockWrites: true })
		try {
			expect(await trigger(page).textContent()).toContain('已儲存的篩選')
			await openMenu(page)
			await page.locator('[data-review-saved-save]').click()
			await page.locator('[data-review-saved-name]').fill('只在此分頁')
			await page.keyboard.press('Enter')
			await poll(() => items(page)).toEqual(['只在此分頁'])
			await page.locator('[data-review-saved]').waitFor()
			await settled(page)
			for (const selector of ['[data-review-saved-apply]', '[data-review-saved-rename]', '[data-review-saved-delete]', '[data-review-saved-save]']) {
				const box = await page.locator(selector).first().boundingBox()
				expect(box?.height, selector).toBeGreaterThanOrEqual(44)
			}
			for (const selector of ['[data-review-saved-rename]', '[data-review-saved-delete]']) {
				const box = await page.locator(selector).first().boundingBox()
				expect(box?.width, selector).toBeGreaterThanOrEqual(44)
			}
		}
		finally { await context.close() }
	}, 60_000)
})
