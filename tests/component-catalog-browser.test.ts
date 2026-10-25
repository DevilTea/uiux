import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Component Catalog (issue #116; Rules 01a17443-6b37-797e-963c-282f2ec400a7,
 * 01a17443-7bab-7b39-9c40-97216f67b582 and 01a17443-8e49-7ae2-905c-e13b9dcdddca) against a private copy
 * of the fixture Workspace whose Product Kit gains a second Adapter, `spare`, with one Widget type no
 * View uses:
 *
 * - the Components section of the Product Kit page lists one read-only row per Widget type of the
 *   active Adapters and opens its detail in place, on desktop, tablet and phone;
 * - a detail lists the Views that use the entry, and an entry no View uses says so;
 * - a Catalog problem of an unused entry shows there (a second server, whose `spare` Adapter has a
 *   broken i18n mapping), where Checks does not list it;
 * - the `?section=components#product-kit-catalog` deep link and the command palette reach the block,
 *   and no navigation entry of its own exists.
 */

const VIEW_NAME = 'UIUX Workbench — Workspace browser'

function spareAdapter(mapping: string): string {
	return `
import { createWidgetPlugin, createWidgetValueContract } from '@deviltea/widget-core';
import { defineComponent, h } from 'vue';

const TRANSLATION_RESULT = createWidgetValueContract('deviltea.uiux/translation-result@1');
const STRING = createWidgetValueContract('deviltea.uiux/string@1');

export const sparePlugin = createWidgetPlugin('Spare')
  .description('A Widget type no View uses')
  .interfaces()
  .config({
    description: 'What a Spare Widget is configured with',
    schema: { type: 'object', required: ['captionKey'], properties: { captionKey: { type: 'string', description: 'Shown under the image' }, image: { type: 'object' } }, additionalProperties: false },
    validate: (input) => input === null || (typeof input === 'object' && !Array.isArray(input)),
    resolve: (raw) => ({ captionKey: raw?.captionKey ?? null }),
  })
  .properties(p => p
    .captionResult({ valueContract: TRANSLATION_RESULT, compute: () => ({ text: 'Caption', warnings: [] }) })
    .caption({ valueContract: STRING, compute: () => 'Caption' }))
  .events(events => events.opened({ description: 'Opened by the reader' }))
  .done();

export const SpareRenderer = defineComponent({ name: 'SpareRenderer', setup: () => () => h('span', 'Spare') });

export const manifest = {
  id: 'spare-adapter',
  apiVersion: '1',
  widgetPlugins: [sparePlugin],
  catalog: { widgets: { Spare: { ${mapping}assetFields: { image: { acceptedMediaTypes: ['image/png', 'image/webp'], acceptedCategories: ['illustration'] } } } } },
  renderers: [{ type: 'Spare', component: SpareRenderer }],
  providers: [],
};
`
}

async function withSpare(root: string, mapping: string): Promise<void> {
	await mkdir(join(root, 'kit', 'adapters'), { recursive: true })
	await writeFile(join(root, 'kit', 'adapters', 'spare.mjs'), spareAdapter(mapping))
	const path = join(root, 'product-kit.json')
	const kit = JSON.parse(await readFile(path, 'utf8')) as { adapters: unknown[] }
	await writeFile(path, JSON.stringify({ ...kit, adapters: [...kit.adapters, { moduleSpecifier: './adapters/spare.mjs' }] }))
}

let valid: WorkbenchServer
let broken: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	valid = await startWorkbenchServer({ prepare: root => withSpare(root, 'i18n: { fields: { caption: { configField: \'captionKey\' } } }, ') })
	// The mapping names a Config field the plugin's schema does not prove a string: only the runtime check refuses it.
	broken = await startWorkbenchServer({ prepare: root => withSpare(root, 'i18n: { fields: { caption: { configField: \'missing\' } } }, ') })
	browser = await chromium.launch({ headless: true })
}, 120_000)

afterAll(async () => {
	await browser?.close()
	await valid?.close()
	await broken?.close()
})

async function open(server: WorkbenchServer, path: string, options: Readonly<{ width?: number; height?: number; locale?: string }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: options.width ?? 1440, height: options.height ?? 900 }, colorScheme: 'light' })
	await context.addInitScript((locale) => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', locale)
	}, options.locale ?? 'en-US')
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

const CATALOG_PATH = '/workspace/product-kit?section=components'

async function openRow(page: Page, type: string) {
	const toggle = page.locator(`[data-catalog-toggle="${type}"]`)
	await toggle.waitFor()
	if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click()
	const detail = page.locator(`[data-catalog-detail="${type}"]`)
	await detail.waitFor()
	return detail
}

describe('GET /api/preview/catalog', () => {
	it('lists the active Adapters\' Widget types, also for a set with a Catalog problem, and needs a credential', async () => {
		for (const server of [valid, broken]) {
			const response = await fetch(`${server.origin}/api/preview/catalog`, { headers: server.headers })
			expect(response.status).toBe(200)
			const body = await response.json() as { state: string; entries?: Array<{ adapterId: string; type: string }> }
			expect(body.state, JSON.stringify(body)).toBe('valid')
			expect(body.entries!.filter(entry => entry.adapterId === 'spare-adapter').map(entry => entry.type)).toEqual(['Spare'])
		}
		expect((await fetch(`${valid.origin}/api/preview/catalog`)).status).toBe(401)
	}, 60_000)
})

describe('Catalog block of the Product Kit page', () => {
	it('lists one row per Widget type of the active Adapters, read-only', async () => {
		const { context, page } = await open(valid, CATALOG_PATH)
		try {
			await page.locator('[data-catalog-list]').waitFor()
			const types = await page.locator('[data-catalog-row]').evaluateAll(rows => rows.map(row => row.getAttribute('data-catalog-row')))
			expect(types).toEqual(['Stack', 'Panel', 'Text', 'Button', 'Badge', 'TextInput', 'NavItem', 'Divider', 'Spare'])
			// Nothing in the block edits: its one field is the filter.
			expect(await page.locator('[data-product-kit-catalog] input, [data-product-kit-catalog] textarea, [data-product-kit-catalog] select').count()).toBe(1)
			// No navigation entry of its own (Rule 01a116f0-8b11-7eba-96eb-786ba7098589).
			expect(await page.locator('[data-landmark="navigation"]').getByRole('link', { name: 'Catalog' }).count()).toBe(0)
			expect(await page.getByRole('navigation', { name: 'Workspace pages' }).getByRole('link', { name: 'Catalog' }).count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('opens a detail with the Config schema, declared Events, i18n mapping and Asset fields', async () => {
		const { context, page } = await open(valid, CATALOG_PATH)
		try {
			const button = await openRow(page, 'Button')
			expect(await button.locator('[data-catalog-events]').innerText()).toContain('click')
			expect(await button.locator('[data-catalog-events]').innerText()).toContain('Fired on user button click')
			const mapping = await button.locator('[data-catalog-i18n]').innerText()
			expect(mapping).toContain('label')
			expect(mapping).toContain('labelResult')
			expect(await page.locator('[data-catalog-toggle="Button"]').getAttribute('aria-expanded')).toBe('true')

			const spare = await openRow(page, 'Spare')
			expect(await spare.locator('[data-catalog-config]').innerText()).toContain('caption')
			expect(await spare.locator('[data-catalog-config]').innerText()).toContain('Shown under the image')
			const assets = await spare.locator('[data-catalog-assets]').innerText()
			expect(assets).toContain('image')
			expect(assets).toContain('image/png, image/webp')
			expect(assets).toContain('illustration')
			expect(await spare.locator('[data-catalog-i18n]').innerText()).toContain('captionResult')
			expect(await spare.locator('[data-catalog-events]').innerText()).toContain('opened')
			expect(await spare.innerText()).toContain('spare-adapter')

			await page.locator('[data-catalog-toggle="Button"]').click()
			await page.locator('[data-catalog-detail="Button"]').waitFor({ state: 'detached' })
		}
		finally { await context.close() }
	}, 60_000)

	it('names the Views that use an entry, and says so when none does', async () => {
		const { context, page } = await open(valid, CATALOG_PATH)
		try {
			const text = await openRow(page, 'Text')
			await text.locator('[data-catalog-views] a').first().waitFor()
			expect(await text.locator('[data-catalog-views] a').first().innerText()).toBe(VIEW_NAME)
			expect(await text.locator('[data-catalog-views]').innerText()).toMatch(/\d+ Widgets?/)
			expect(await page.locator('[data-catalog-row="Text"] [data-catalog-usage]').innerText()).toBe('Used by 1 View')

			const spare = await openRow(page, 'Spare')
			await expect.poll(() => spare.locator('[data-catalog-views]').innerText()).toContain('No View uses this entry.')
			expect(await page.locator('[data-catalog-row="Spare"] [data-catalog-usage]').innerText()).toBe('No View uses it')
			expect(await spare.locator('[data-catalog-problems]').innerText()).toContain('No problems.')
		}
		finally { await context.close() }
	}, 60_000)

	it('filters the rows by type, Adapter or description', async () => {
		const { context, page } = await open(valid, CATALOG_PATH)
		try {
			await page.locator('[data-catalog-list]').waitFor()
			const filter = page.getByRole('searchbox', { name: 'Filter Catalog entries' })
			await filter.fill('spare-adapter')
			await expect.poll(() => page.locator('[data-catalog-row]').count()).toBe(1)
			await filter.fill('no-such-entry')
			await page.locator('[data-catalog-no-match]').waitFor()
		}
		finally { await context.close() }
	}, 60_000)

	it('shows a Catalog problem of an entry no View uses, which Checks does not list', async () => {
		const { context, page } = await open(broken, CATALOG_PATH)
		try {
			await page.locator('[data-catalog-list]').waitFor()
			expect(await page.locator('[data-catalog-row="Spare"] [data-catalog-problem-count]').count()).toBe(1)
			const spare = await openRow(page, 'Spare')
			await expect.poll(() => spare.locator('[data-catalog-problems]').innerText()).toContain('Checks doesn’t list these problems')
			expect(await spare.locator('[data-catalog-problems] li').count()).toBeGreaterThan(0)
			expect(await spare.locator('[data-catalog-problems] code').first().innerText()).toContain('/adapters/1/manifest/catalog/widgets/Spare/')
			// The valid Adapter's entries stay listed beside it, with no problem.
			expect(await page.locator('[data-catalog-row="Text"] [data-catalog-problem-count]').count()).toBe(0)

			// Checks lists no Catalog problem of an unused entry (Rule 01a115cd-be51-740b-8472-c08dc7138e3e).
			await page.goto(`${broken.origin}/?tab=checks`, { waitUntil: 'networkidle' })
			await page.locator('[data-run-checks]').click()
			await page.getByText(/Catalog problems? (is|are) outside the entries Views use/).waitFor({ timeout: 30_000 })
			expect(await page.getByText('widgets/Spare').count()).toBe(0)
			expect(await page.getByText('Spare', { exact: true }).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})

describe('Reaching the Catalog', () => {
	it('is the target of the ?section=components#product-kit-catalog deep link', async () => {
		const { context, page } = await open(valid, `${CATALOG_PATH}#product-kit-catalog`, { height: 500 })
		try {
			await page.locator('[data-catalog-list]').waitFor()
			await expect.poll(() => page.evaluate(() => {
				const block = document.querySelector('#product-kit-catalog')
				const scroller = block?.closest('[role="region"]')
				if (!block || !scroller) return false
				return scroller.scrollTop > 0 && block.getBoundingClientRect().top < scroller.getBoundingClientRect().bottom
			})).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('is a command-palette destination that opens it, with no navigation entry of its own', async () => {
		const { context, page } = await open(valid, '/')
		try {
			await page.keyboard.press('ControlOrMeta+k')
			const search = page.locator('[role="dialog"] input').first()
			await search.waitFor()
			await search.fill('Catalog')
			const option = page.locator('[role="option"]').filter({ hasText: 'Catalog' }).first()
			await option.waitFor()
			await option.click()
			await page.waitForURL(url => url.pathname === '/workspace/product-kit' && url.searchParams.get('section') === 'components' && url.hash === '#product-kit-catalog')
			await page.locator('[data-catalog-list]').waitFor()
			expect(await page.locator('#product-kit-catalog-title').isVisible()).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Catalog on tablet and phone', () => {
	for (const [name, width, height] of [['tablet', 820, 1180], ['phone', 390, 800]] as const) {
		it(`lists and opens entries read-only on a ${name}, without scrolling the page sideways`, async () => {
			const { context, page } = await open(valid, CATALOG_PATH, { width, height })
			try {
				await page.locator('[data-catalog-list]').waitFor()
				const detail = await openRow(page, 'Spare')
				await detail.locator('[data-catalog-assets]').waitFor()
				expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
				expect(await detail.isVisible()).toBe(true)
			}
			finally { await context.close() }
		}, 60_000)
	}
})

describe('Catalog copy', () => {
	it('is 「型錄」 in zh-TW, with domain nouns kept in English', async () => {
		const { context, page } = await open(valid, CATALOG_PATH, { locale: 'zh-TW' })
		try {
			await page.locator('[data-catalog-list]').waitFor()
			expect(await page.locator('#product-kit-catalog-title').innerText()).toBe('型錄')
			const detail = await openRow(page, 'Spare')
			expect(await detail.innerText()).toContain('設定結構')
			expect(await page.locator('[data-catalog-row="Spare"] [data-catalog-usage]').innerText()).toBe('沒有 View 使用')
		}
		finally { await context.close() }
	}, 60_000)
})
