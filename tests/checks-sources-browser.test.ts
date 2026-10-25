import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { startWorkbenchServer, WORKBENCH_FIXTURE_WORKSPACE, type WorkbenchServer } from './support/workbench-server'

/**
 * Overview › Checks sources (issue #95): translation reminders by Locale, key and type that open
 * their translation-table cell, Catalog problems of used entries grouped problem → View → Widget,
 * the per-source check states, filters and grouping, and the default order (severity → code →
 * location). The Adapter set's report is answered by the test (`GET /api/preview/adapters`), so a
 * Catalog problem needs no broken Adapter on disk.
 */

const VIEW_NAME = 'UIUX Workbench — Workspace browser'
const FIXTURE_VIEW = JSON.parse(readFileSync(join(WORKBENCH_FIXTURE_WORKSPACE, 'views', '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1.view.json'), 'utf8')) as { ir: unknown }

function countWidgets(node: unknown, type: string): number {
	const { type: own, slots } = node as { type: string; slots?: Record<string, unknown[]> }
	return (own === type ? 1 : 0) + Object.values(slots ?? {}).flat().reduce<number>((sum, child) => sum + countWidgets(child, type), 0)
}
const BUTTONS = countWidgets(FIXTURE_VIEW.ir, 'Button')

const CATALOG_PROBLEM = { code: 'adapter.i18n_mapping_collision', path: '/adapters/0/manifest/catalog/widgets/Button/i18n/fields/label/text', message: 'Mapped runtime member text conflicts with another.' }
const UNUSED_PROBLEM = { code: 'adapter.i18n_mapping_collision', path: '/adapters/0/manifest/catalog/widgets/NotUsedByAnyView/i18n/fields/label/text', message: 'Another entry no View uses.' }
const SET_PROBLEM = { code: 'adapter.duplicate_id', path: '/adapters/1/manifest/id', message: 'Two Adapters share an id.' }

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			await writeFile(join(root, 'i18n', 'ja-JP.json'), `${JSON.stringify({ 'cta/label': '', 'hero.badge': '   ', 'app.title': 'UIUX' })}\n`)
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type AdaptersAnswer = Readonly<{ status?: number; body?: unknown }>

async function openChecks(answer: AdaptersAnswer): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.route(url => url.pathname === '/api/preview/adapters', (route: Route) => route.fulfill({
		status: answer.status ?? 200,
		contentType: 'application/json',
		body: JSON.stringify(answer.body ?? { state: 'valid', diagnostics: [], summaries: [] }),
	}))
	await page.goto(`${server.origin}/?tab=checks`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function run(page: Page): Promise<void> {
	await page.locator('[data-run-checks]').click()
	await page.locator('[data-checks-tree]').waitFor({ timeout: 30_000 })
	await page.waitForSelector('[data-run-checks]:not([disabled]):not([data-loading])', { timeout: 30_000 }).catch(() => undefined)
}

const stateOf = (page: Page, source: string) => page.locator(`[data-check-source="${source}"]`).getAttribute('data-check-source-state')
const problems = (page: Page) => page.locator('[data-check-problem]')

async function choose(page: Page, filter: string, option: string): Promise<void> {
	await page.locator(`[data-check-filter="${filter}"]`).click()
	await page.getByRole('option', { name: option, exact: true }).click()
}

describe('Checks sources and check states (issue #95)', () => {
	it('shows every source as not checked before Run Checks, never as zero findings', async () => {
		const { context, page } = await openChecks({})
		try {
			await page.locator('[data-check-sources]').waitFor()
			for (const source of ['validation', 'translation', 'catalog', 'product-kit', 'preview-translation', 'runtime'])
				expect(await stateOf(page, source)).toBe('not_checked')
			expect(await page.locator('[data-check-source-count]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('lists reminders and Catalog problems with their origin, scope, state and severity, errors first', async () => {
		const { context, page } = await openChecks({ body: { state: 'invalid', diagnostics: [CATALOG_PROBLEM, UNUSED_PROBLEM, SET_PROBLEM], summaries: [] } })
		try {
			await run(page)
			expect(await stateOf(page, 'validation')).toBe('completed')
			expect(await stateOf(page, 'translation')).toBe('completed')
			expect(await stateOf(page, 'catalog')).toBe('completed')
			// The Preview's translation warnings and Runtime errors are not gathered yet, and say so.
			expect(await stateOf(page, 'preview-translation')).toBe('not_checked')
			expect(await stateOf(page, 'runtime')).toBe('not_checked')

			// Default order: severity, then code. The error group leads the warning groups.
			const order = await problems(page).evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-check-severity'), node.getAttribute('data-check-problem')]))
			expect(order).toEqual([
				['error', 'adapter.i18n_mapping_collision'],
				['warning', 'i18n.empty_translation'],
				['warning', 'i18n.whitespace_only_translation'],
			])

			// One Catalog problem, once: its Views with a count, then its Widgets with a count. The unused
			// entry and the Adapter set's own problem stay out of Checks and are counted aside.
			const catalog = page.locator('[data-check-problem="adapter.i18n_mapping_collision"]')
			expect(await catalog.count()).toBe(1)
			expect(await catalog.textContent()).toContain('Button:')
			const tree = page.locator('[data-checks-tree]')
			expect(await tree.locator('[data-check-count]').filter({ hasText: '1 View' }).count()).toBe(1)
			expect(await tree.locator('[data-check-count]').filter({ hasText: `${BUTTONS} Widget` }).count()).toBe(1)
			expect(await tree.getByText(VIEW_NAME).count()).toBeGreaterThan(0)
			expect(await page.locator('[data-check-source="catalog"]').textContent()).toContain('2 Catalog problems are outside the entries Views use')
			expect(await tree.getByText('NotUsedByAnyView').count()).toBe(0)

			const widget = tree.locator('[data-finding-source="catalog"]').first()
			expect(await widget.getAttribute('data-finding-severity')).toBe('error')
			expect(await widget.getAttribute('data-finding-state')).toBe('completed')
			expect(await widget.locator('[data-check-finding-meta]').textContent()).toBe('Error · Catalog · View · Completed')

			// Reminders by Locale, key and type, each with its origin, scope, state and severity.
			const reminder = tree.locator('[data-finding-source="translation"]').first()
			expect(await reminder.getAttribute('data-finding-severity')).toBe('warning')
			expect(await reminder.locator('[data-check-finding-meta]').textContent()).toBe('Warning · Translation reminders · Locale · Completed')
			const reminderTexts = await tree.locator('[data-finding-source="translation"]').evaluateAll(nodes => nodes.map(node => node.textContent ?? ''))
			expect(reminderTexts.some(text => text.includes('cta/label') && text.includes('intentionally blank'))).toBe(true)
			expect(reminderTexts.some(text => text.includes('hero.badge') && text.includes('only ECMAScript-trimmable whitespace'))).toBe(true)
			expect(await tree.getByText('ja-JP').count()).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('opens the translation-table cell of a reminder', async () => {
		const { context, page } = await openChecks({})
		try {
			await run(page)
			await page.locator('[data-finding-source="translation"]', { hasText: 'cta/label' }).click()
			await page.waitForURL(url => url.pathname === '/workspace/locales', { timeout: 15_000 })
			const url = new URL(page.url())
			expect(url.searchParams.get('locale')).toBe('ja-JP')
			expect(url.searchParams.get('key')).toBe('cta/label')
			await page.waitForFunction(() => {
				const active = document.activeElement as HTMLElement | null
				return active?.dataset.localeCellKey === 'cta/label' && active.dataset.locale === 'ja-JP'
			}, undefined, { timeout: 15_000 })
			expect(await page.locator('[data-locale-cell-revealed]').count()).toBe(1)
		}
		finally { await context.close() }
	}, 90_000)

	it('filters by source, category, severity and View, groups by source, and clears the filters', async () => {
		const { context, page } = await openChecks({ body: { state: 'invalid', diagnostics: [CATALOG_PROBLEM], summaries: [] } })
		try {
			await run(page)
			expect(await problems(page).count()).toBe(3)

			await choose(page, 'severity', 'Warning')
			expect(await problems(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-check-severity')))).toEqual(['warning', 'warning'])

			await page.locator('[data-check-clear-filters]').click()
			await choose(page, 'source', 'Catalog')
			expect(await problems(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-check-problem')))).toEqual(['adapter.i18n_mapping_collision'])

			await page.locator('[data-check-clear-filters]').click()
			await choose(page, 'category', 'i18n')
			expect(await problems(page).count()).toBe(2)

			await page.locator('[data-check-clear-filters]').click()
			await choose(page, 'view', VIEW_NAME)
			expect(await problems(page).evaluateAll(nodes => nodes.map(node => node.getAttribute('data-check-problem')))).toEqual(['adapter.i18n_mapping_collision'])

			// Filters that match nothing say so and offer to clear.
			await choose(page, 'severity', 'Warning')
			await page.locator('[data-checks-no-matches]').waitFor()
			await page.locator('[data-checks-no-matches]').getByRole('button', { name: 'Clear filters' }).click()
			expect(await problems(page).count()).toBe(3)

			// Grouping by source puts each source's problems under its own heading, errors still first within it.
			await page.locator('[data-check-group-by]').click()
			await page.getByRole('option', { name: 'Source', exact: true }).click()
			const tree = page.locator('[data-checks-tree]')
			await tree.getByText('Translation reminders', { exact: true }).first().waitFor()
			expect(await tree.getByText('Catalog', { exact: true }).count()).toBeGreaterThan(0)
			expect(await problems(page).count()).toBe(3)
		}
		finally { await context.close() }
	}, 120_000)

	it('says a Catalog source that failed or did not finish is not a clean result', async () => {
		const failed = await openChecks({ status: 500, body: { statusCode: 500, message: 'adapter set unavailable' } })
		try {
			await run(failed.page)
			expect(await stateOf(failed.page, 'catalog')).toBe('failed')
			// The other sources still report.
			expect(await stateOf(failed.page, 'translation')).toBe('completed')
			expect(await failed.page.locator('[data-check-source="catalog"]').locator('[data-check-source-count]').count()).toBe(0)
			expect(await failed.page.locator('[data-overview-checks] [role="status"]').textContent()).toContain('Some checks did not finish')
		}
		finally { await failed.context.close() }

		const unchecked = await openChecks({ body: { state: 'valid', diagnostics: [], summaries: [], warnings: [{ code: 'preview.bundle_failed', path: '/product-kit', message: 'could not run' }] } })
		try {
			await run(unchecked.page)
			expect(await stateOf(unchecked.page, 'catalog')).toBe('incomplete')
		}
		finally { await unchecked.context.close() }
	}, 120_000)
})
