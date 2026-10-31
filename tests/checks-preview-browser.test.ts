import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Overview › Checks gathers what the live Preview reports (issue #347; owner ruling 1 of 2026-10-26,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19186750): the translation
 * warnings of the Properties its Runtime evaluated, attributed to View, Variant, Widget and Property,
 * and its current load and Runtime errors. A source with no Preview shows not checked, and a change
 * of Variant or Locale replaces what was reported.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** The key this suite removes from zh-TW, so that the Button `btn-run-checks` falls back to en-US there. */
const MISSING_KEY = 'header.action.checks'
const WIDGET_ID = 'btn-run-checks'

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			const zhPath = join(root, 'i18n', 'zh-TW.json')
			const zh = JSON.parse(await readFile(zhPath, 'utf8')) as Record<string, string>
			delete zh[MISSING_KEY]
			await writeFile(zhPath, `${JSON.stringify(zh)}\n`)
			const viewPath = join(root, 'views', `${VIEW_ID}.view.json`)
			const view = JSON.parse(await readFile(viewPath, 'utf8')) as Record<string, unknown>
			await writeFile(viewPath, `${JSON.stringify({ ...view, variants: { Quiet: { state: {} } } })}\n`)
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type OpenOptions = Readonly<{ adaptersAnswer?: unknown }>

async function open(path: string, options: OpenOptions = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	if (options.adaptersAnswer) {
		// Only the Preview document sees the broken Adapter set; the Workbench's own reads stay as they are.
		await page.route(url => url.pathname === '/api/preview/adapters', route => route.request().frame()?.parentFrame()
			? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(options.adaptersAnswer) })
			: route.continue())
	}
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

/** The `checks.report` messages the Workbench received so far, oldest first. */
const reports = (page: Page) => page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type === 'checks.report'))
type Warning = Readonly<{ widgetId: string; resultProperty: string; warning: Record<string, unknown> }>
const warningsOf = (message: WireRecord | undefined) => (message?.payload.translationWarnings ?? []) as readonly Warning[]

async function lastReport(page: Page, accept: (message: WireRecord) => boolean): Promise<WireRecord> {
	let found: WireRecord | undefined
	await expect.poll(async () => {
		found = (await reports(page)).filter(accept).at(-1)
		return !!found
	}, { timeout: 30_000 }).toBe(true)
	return found!
}

/** Leaves the View for Overview › Checks inside the same Workbench page, as a person does. */
async function goToChecks(page: Page): Promise<void> {
	await page.getByRole('link', { name: 'Overview', exact: true }).first().click()
	await page.getByRole('tab', { name: /^Checks/ }).click()
	await page.locator('[data-check-sources]').waitFor()
}

const stateOf = (page: Page, source: string) => page.locator(`[data-check-source="${source}"]`).getAttribute('data-check-source-state')
const countOf = async (page: Page, source: string) => Number((await page.locator(`[data-check-source="${source}"] [data-check-source-count]`).textContent())?.match(/\d+/)?.[0] ?? 'NaN')

async function choose(page: Page, context: 'variant' | 'locale', option: RegExp | string): Promise<void> {
	await page.locator(`[data-context="${context}"]`).click()
	await page.getByRole('option', { name: option }).click()
}

describe('Checks gathers the live Preview (issue #347)', () => {
	it('lists a missing-key warning with its View, Widget and Property, and follows it to the Widget', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?locale=zh-TW`)
		try {
			const report = await lastReport(page, message => warningsOf(message).length > 0)
			// Only the Properties the Runtime evaluated are reported, and each names its Widget and Property.
			expect(warningsOf(report)).toContainEqual({
				widgetId: WIDGET_ID,
				resultProperty: 'labelResult',
				warning: { code: 'missing-translation', key: MISSING_KEY, requestedLocale: 'zh-TW', fallbackLocale: 'en-US' },
			})
			expect(warningsOf(report).every(entry => entry.warning.requestedLocale === 'zh-TW')).toBe(true)
			// The report also says which declared Properties it did not evaluate (issue #95), never forcing one to evaluate.
			const coverage = report.payload.coverage as { complete: boolean; unevaluated: readonly Record<string, unknown>[] }
			expect(coverage).toEqual({ complete: true, unevaluated: [] })

			await goToChecks(page)
			// The Preview was left with the View: its last report is kept, labeled, and never shown as completed.
			expect(await stateOf(page, 'preview-translation')).toBe('incomplete')
			expect(await stateOf(page, 'runtime')).toBe('incomplete')
			const note = await page.locator('[data-check-source="preview-translation"]').textContent()
			expect(note).toContain('From the last Preview')
			expect(note).toContain('may be out of date')
			expect(note).toContain('zh-TW')
			expect(note).toContain('UIUX Workbench')
			// Its coverage was complete, so no Property is named as unevaluated.
			expect(note).not.toContain('not evaluated')
			expect(await countOf(page, 'preview-translation')).toBeGreaterThanOrEqual(1)
			// A run was never asked for, and the Preview's findings are listed all the same, as live ones.
			const problem = page.locator('[data-check-problem="i18n.missing_translation"]')
			await problem.first().waitFor()
			expect(await problem.first().getAttribute('data-check-severity')).toBe('warning')
			const finding = page.locator(`[data-finding-source="preview-translation"]`, { hasText: WIDGET_ID })
			expect(await finding.count()).toBe(1)
			const text = await finding.textContent()
			expect(text).toContain('Property labelResult')
			// Rule 01a115cd-b91d-7230-9041-b56ff70b814b: the row names the Catalog field (the authoring field) the result Property derives from.
			expect(text).toContain('Authoring field label')
			expect(text).toContain('Warning')
			expect(text).toContain('Preview translation warnings')
			expect(await finding.getAttribute('data-finding-state')).toBe('incomplete')

			// Selecting it opens its exact context: the View with the Widget selected.
			await finding.click()
			await page.waitForFunction(id => new URL(location.href).searchParams.get('widget') === id, WIDGET_ID)
			expect(new URL(page.url()).pathname).toBe(`/views/${VIEW_ID}`)
		}
		finally { await context.close() }
	}, 90_000)

	it('shows both Preview sources as not checked when no Preview is open, never as zero findings', async () => {
		const { context, page } = await open('/?tab=checks')
		try {
			await page.locator('[data-check-sources]').waitFor()
			expect(await stateOf(page, 'preview-translation')).toBe('not_checked')
			expect(await stateOf(page, 'runtime')).toBe('not_checked')
			expect(await page.locator('[data-check-source="preview-translation"] [data-check-source-count]').count()).toBe(0)
			expect(await page.locator('[data-check-source="runtime"] [data-check-source-count]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('lists a load error of the Adapters as a current Runtime error', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?variant=Quiet`, {
			adaptersAnswer: { state: 'invalid', diagnostics: [{ code: 'adapter.bundle_invalid', path: '/adapters', message: 'The Adapter bundle has no mount function.' }], summaries: [] },
		})
		try {
			const report = await lastReport(page, message => ((message.payload.runtimeErrors ?? []) as unknown[]).length > 0)
			expect(report.payload.runtimeErrors).toEqual([
				{ reason: 'runtime.adapter_invalid', detail: 'adapter.bundle_invalid /adapters: The Adapter bundle has no mount function.' },
			])
			expect(warningsOf(report)).toEqual([])

			await goToChecks(page)
			expect(await stateOf(page, 'runtime')).toBe('incomplete')
			expect(await countOf(page, 'runtime')).toBe(1)
			const problem = page.locator('[data-check-problem="runtime.adapter_invalid"]')
			await problem.first().waitFor()
			expect(await problem.first().getAttribute('data-check-severity')).toBe('error')
			const finding = page.locator('[data-finding-source="runtime"]')
			expect(await finding.textContent()).toContain('The Adapter bundle has no mount function.')
			// A Runtime error of a Variant names the Variant.
			expect(await finding.textContent()).toContain('Variant Quiet')
		}
		finally { await context.close() }
	}, 90_000)

	it('replaces what was reported when the Variant changes', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?locale=zh-TW`)
		try {
			const base = await lastReport(page, message => warningsOf(message).length > 0 && message.context.variantId === undefined)
			await choose(page, 'variant', 'Quiet')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('variant') === 'Quiet')
			const quiet = await lastReport(page, message => message.context.variantId === 'Quiet' && warningsOf(message).length > 0)
			// The Variant's report is a later one of a later runtime context, and replaces the base state's.
			expect(Number(quiet.payload.sequence)).toBeGreaterThan(Number(base.payload.sequence))
			expect(Number(quiet.context.runtimeContextVersion)).toBeGreaterThan(Number(base.context.runtimeContextVersion))

			await goToChecks(page)
			const finding = page.locator('[data-finding-source="preview-translation"]', { hasText: WIDGET_ID })
			await finding.first().waitFor()
			expect(await finding.count()).toBe(1)
			expect(await finding.textContent()).toContain('Variant Quiet')
			// Nothing of the base state is still listed as current.
			expect(await page.locator('[data-finding-source="preview-translation"]').evaluateAll(nodes => nodes.every(node => node.textContent?.includes('Variant Quiet')))).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('replaces what was reported when the Locale changes, and lists nothing of the earlier Locale', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?locale=zh-TW`)
		try {
			const zh = await lastReport(page, message => warningsOf(message).length > 0)
			await choose(page, 'locale', /en-US/)
			await page.waitForFunction(() => new URL(location.href).searchParams.get('locale') === 'en-US')
			// The report of en-US replaces it: the missing key has its text there, so nothing of zh-TW remains.
			const en = await lastReport(page, message => Number(message.payload.sequence) > Number(zh.payload.sequence) && warningsOf(message).every(entry => entry.warning.requestedLocale === 'en-US'))
			expect(warningsOf(en).some(entry => entry.warning.key === MISSING_KEY)).toBe(false)

			await goToChecks(page)
			expect(await stateOf(page, 'preview-translation')).toBe('incomplete')
			expect(await page.locator('[data-finding-source="preview-translation"]', { hasText: WIDGET_ID }).count()).toBe(0)
			expect(await page.locator('[data-check-problem="i18n.missing_translation"]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})
