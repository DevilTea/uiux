import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Adapter theme support (issue #99) against the built server and a private copy of the fixture
 * Workspace, whose theme registry gains `contrast` and whose Product Kit gains a second Adapter,
 * `theme-gate`, that declares `themeSupport` and rejects `contrast`:
 *
 * - live Preview shows `render_context.incompatible_theme` in place of a View whose theme the active
 *   Adapters do not support, renders it again on a live switch to a supported theme, and never renders
 *   the unsupported context with another theme (Rules 01a115cd-c27d-78ba-b95d-bf1aa50adec7 and
 *   01a11a5a-566b-70b1-b000-2918519c0d19; Scenario 01a11a5b-1af9-7359-bb53-add13edeb3be);
 * - formal capture refuses that context, while a supported theme captures (same Rules; Rule
 *   01a11add-f46d-7e92-8f5a-9d10dba6473d) and the Adapter set stays valid (Rule 01a11a5a-56e8-71c8-905a-62ed0476fd8f);
 * - the Product Kit page lists the themes each Adapter does not support (Rule 01a11a5a-5769-721b-ad33-d068c7edeb41).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

const THEME_GATE_ADAPTER = [
	'export const manifest = {',
	'  id: \'theme-gate\',',
	'  apiVersion: \'1\',',
	'  widgetPlugins: [],',
	'  catalog: { widgets: {} },',
	'  renderers: [],',
	'  providers: [],',
	'  themeSupport: { supports: themeId => themeId !== \'contrast\' },',
	'}',
	'',
].join('\n')

let server: WorkbenchServer
let browser: Browser

async function editJson(path: string, edit: (value: Record<string, unknown>) => Record<string, unknown>): Promise<void> {
	await writeFile(path, JSON.stringify(edit(JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>)))
}

beforeAll(async () => {
	server = await startWorkbenchServer({
		async prepare(root) {
			await editJson(join(root, 'workspace.json'), manifest => ({ ...manifest, themes: { ...(manifest.themes as object), contrast: { label: 'Contrast' } } }))
			await writeFile(join(root, 'kit', 'adapters', 'theme-gate.mjs'), THEME_GATE_ADAPTER)
			await editJson(join(root, 'product-kit.json'), productKit => ({ ...productKit, adapters: [...(productKit.adapters as unknown[]), { moduleSpecifier: './adapters/theme-gate.mjs' }] }))
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	return { context, page }
}

async function previewFrame(page: Page): Promise<Frame> {
	const handle = await page.waitForSelector(`iframe[src*="/preview"][src*="viewId=${VIEW_ID}"]`, { timeout: 15_000 })
	return (await handle.contentFrame())!
}

async function chooseTheme(page: Page, label: string): Promise<void> {
	await page.locator('[data-context="theme"]').click()
	await page.getByRole('option', { name: label }).click()
	await page.locator('[data-slot="content"][role="listbox"]').waitFor({ state: 'detached' })
}

function capture(themeId: string): Promise<Response> {
	return fetch(`${server.origin}/api/evidence/capture`, {
		method: 'POST',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ contexts: [{ viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1920, height: 1080 }, themeId }] }),
	})
}

describe('a theme the active Adapters do not support (issue #99)', () => {
	it('is reported by the adapters route while the Adapter set stays valid', async () => {
		const response = await fetch(`${server.origin}/api/preview/adapters`, { headers: server.headers })
		expect(response.status).toBe(200)
		const body = await response.json() as { state: string; themeSupport: unknown; summaries: Array<{ adapterId?: string; unsupportedThemeIds?: string[] }> }
		expect(body.state).toBe('valid')
		expect(body.themeSupport).toEqual({ unsupportedThemeIds: ['contrast'], diagnostics: [] })
		expect(body.summaries.map(summary => [summary.adapterId, summary.unsupportedThemeIds])).toEqual([
			['uiux-reference-adapter', undefined],
			['theme-gate', ['contrast']],
		])
	})

	it('shows the render-context diagnostic in the Preview in place of the View, and renders again on a supported theme', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?locale=en-US&viewport=desktop&theme=contrast`)
		try {
			const frame = await previewFrame(page)
			const diagnostic = frame.locator('[data-preview-theme-unsupported]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.textContent()).toContain('render_context.incompatible_theme')
			expect(await diagnostic.textContent()).toContain('contrast')
			// Nothing is rendered for the context, under this theme or another one.
			expect(await frame.locator('[data-preview-ready="true"]').isVisible()).toBe(false)
			expect(await frame.locator('.preview-runtime-host').evaluate(element => element.childElementCount)).toBe(0)

			// A live switch to a supported theme renders the View.
			await chooseTheme(page, 'Light')
			await frame.locator('[data-preview-ready="true"]').waitFor({ state: 'visible', timeout: 15_000 })
			expect(await frame.locator('[data-preview-theme-unsupported]').count()).toBe(0)
			expect(await frame.locator('.preview-runtime-host').evaluate(element => element.childElementCount)).toBeGreaterThan(0)

			// Back to the unsupported theme: the construction is gone and the diagnostic is back.
			await chooseTheme(page, 'Contrast')
			await frame.locator('[data-preview-theme-unsupported]').waitFor({ timeout: 15_000 })
			expect(await frame.locator('[data-preview-ready="true"]').isVisible()).toBe(false)
			expect(await frame.locator('.preview-runtime-host').evaluate(element => element.childElementCount)).toBe(0)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('is refused by formal capture, while a supported theme captures', async () => {
		const refused = await capture('contrast')
		expect(refused.status).toBe(422)
		expect(await refused.json()).toMatchObject({
			status: 'failed',
			results: [{ status: 'failed', diagnostics: [{ code: 'render_context.incompatible_theme', path: '/0/themeId' }] }],
		})

		const captured = await capture('light')
		expect(captured.status).toBe(200)
		expect(await captured.json()).toMatchObject({ status: 'ok', results: [{ status: 'captured' }] })
	}, 60_000)

	it('is listed for the Adapter that does not support it on the Product Kit page', async () => {
		const { context, page } = await open('/workspace/product-kit?section=overview')
		try {
			const rows = page.locator('#product-kit-adapters [data-adapter-row]')
			await rows.nth(1).locator('[data-adapter-unsupported-themes]').waitFor({ timeout: 15_000 })
			expect(await rows.nth(1).locator('[data-adapter-unsupported-themes]').textContent()).toContain('contrast')
			// The reference Adapter declares no theme support, so it supports every theme and lists none.
			expect(await rows.nth(0).locator('[data-adapter-unsupported-themes]').count()).toBe(0)
		}
		finally {
			await context.close()
		}
	}, 60_000)
})
