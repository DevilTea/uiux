import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium, type Browser, type BrowserContext, type Page, type Response } from 'playwright'

import { canonicalJsonBytes } from '../src/persistence'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Product Kit stylesheet in the built Preview page (issue #141, Part 14 decision 6), against a
 * private copy of the fixture Workspace whose kit uses `fake-ui`, a component library that imports
 * its CSS and a font from JavaScript (Scenario 01a11bb1-c318-76ba-b849-1a9050d129c9):
 *
 * - the Preview renders with the library's styles from the Product Kit stylesheet, which the
 *   construction links and waits for (Rules 01a11bb1-acdc-799f-aed7-c85ddbaf0d28,
 *   01a11bb1-ad41-761c-ad47-a0e7ed5b8240, 01a11a5a-4d38-7f2c-98be-755d8c404d98), so a formal capture,
 *   which waits for the ready status, waits for it too;
 * - the font is served from the bundle's files, and the theme's root attributes are set
 *   (Rule 01a11bb1-ada4-7dd7-b3da-733de7a85df4);
 * - a stylesheet that fails to load makes the Preview invalid (Rules 01a11be8-6078-7669-8e6d-6005d42c16dd,
 *   01a11a5a-5059-716e-b0a5-d178395be034) and leaves no link (Rule 01a11a5a-4e44-77e0-bdf6-49ab11f5f3a5).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const PREVIEW_PATH = `/preview?viewId=${VIEW_ID}&locale=en-US&viewportId=desktop&viewportWidth=1280&viewportHeight=800&themeId=dark&harness=formal`

let server: WorkbenchServer
let browser: Browser

async function write(path: string, content: string | Uint8Array): Promise<void> {
	await mkdir(join(path, '..'), { recursive: true })
	await writeFile(path, content)
}

/** Adds `fake-ui` to the kit, makes the reference Adapter import it, and sets the Product Kit styles and themes. */
async function prepareKit(root: string): Promise<void> {
	const kit = join(root, 'kit')
	const library = join(kit, 'node_modules', 'fake-ui')
	await write(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module', dependencies: { 'fake-ui': '1.0.0' } }))
	await write(join(library, 'package.json'), JSON.stringify({ name: 'fake-ui', version: '1.0.0', type: 'module', exports: { '.': './index.js', './theme.css': './theme.css' } }))
	await write(join(library, 'index.js'), `import './button.css';\nexport const loaded = true;\n`)
	await write(join(library, 'button.css'), [
		`@font-face { font-family: FakeUiBrowser; src: url('./fake-ui.woff2') format('woff2'); }`,
		`.uiux-preview-materialized-root { border-top: 1px solid rgb(10, 20, 30); font-family: FakeUiBrowser, sans-serif; }`,
		'',
	].join('\n'))
	await write(join(library, 'fake-ui.woff2'), 'not a real font, served as the bundle asset')
	await write(join(library, 'theme.css'), ':root { --fui-accent: rgb(1, 2, 3); }\n')
	const adapter = join(kit, 'adapters', 'reference.ts')
	await writeFile(adapter, `import 'fake-ui'\n${await readFile(adapter, 'utf8')}`)
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	await writeFile(productKitPath, canonicalJsonBytes({ ...productKit, styles: ['fake-ui/theme.css'], themes: { dark: { 'data-kit-theme': 'dark' } } }))
}

beforeAll(async () => {
	server = await startWorkbenchServer({ prepare: prepareKit })
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	return { context, page: await context.newPage() }
}

describe('Product Kit stylesheet in the Preview page', () => {
	it('renders the component library styled once its stylesheet has loaded, with its font served and the theme attributes set', async () => {
		const { context, page } = await open()
		// The stylesheet is held back until the page has been seen not ready.
		let release!: () => void
		const held = new Promise<void>((resolve) => { release = resolve })
		await page.route('**/api/preview/runtime/*/runtime.css', async (route) => {
			await held
			await route.continue()
		})
		const fonts: Response[] = []
		page.on('response', (response) => {
			if (/\/api\/preview\/runtime\/[0-9a-f]+\/assets\/fake-ui-[^/]+\.woff2$/.test(response.url())) fonts.push(response)
		})
		try {
			await page.goto(`${server.origin}${PREVIEW_PATH}`, { waitUntil: 'load' })
			await page.waitForSelector('link[data-uiux-product-kit-stylesheet]', { state: 'attached', timeout: 15_000 })
			// The first render waits for the stylesheet, so the ready status a formal capture waits for does too.
			expect(await page.locator('[data-preview-status="ready"]').isVisible()).toBe(false)
			expect(await page.locator('.uiux-preview-materialized-root').count()).toBe(0)
			release()

			await page.waitForSelector('[data-preview-status="ready"]', { state: 'visible', timeout: 15_000 })
			const styled = await page.evaluate(() => {
				const root = document.querySelector('.uiux-preview-materialized-root')!
				const links = [...document.head.querySelectorAll('link[rel="stylesheet"]')]
				const kitLink = document.head.querySelector('link[data-uiux-product-kit-stylesheet]')!
				return {
					border: getComputedStyle(root).borderTopColor,
					accent: getComputedStyle(document.documentElement).getPropertyValue('--fui-accent').trim(),
					theme: document.documentElement.getAttribute('data-kit-theme'),
					// After UIUX's own Preview stylesheets.
					kitLinkAfterOwn: links.length > 1 && links.at(-1) === kitLink,
				}
			})
			expect(styled).toEqual({ border: 'rgb(10, 20, 30)', accent: 'rgb(1, 2, 3)', theme: 'dark', kitLinkAfterOwn: true })

			// The browser fetches the font the stylesheet declares from the bundle's files.
			await page.evaluate(() => document.fonts.load('16px FakeUiBrowser').catch(() => undefined))
			await expect.poll(() => fonts.length, { timeout: 10_000 }).toBeGreaterThan(0)
			expect(fonts[0]!.status()).toBe(200)
			expect(fonts[0]!.headers()['content-type']).toBe('font/woff2')
		}
		finally {
			release()
			await context.close()
		}
	}, 60_000)

	it('reports the Preview invalid, naming the stylesheet, when the stylesheet does not load', async () => {
		const { context, page } = await open()
		await page.route('**/api/preview/runtime/*/runtime.css', route => route.fulfill({ status: 500, body: 'broken' }))
		try {
			await page.goto(`${server.origin}${PREVIEW_PATH}`, { waitUntil: 'load' })
			const invalid = page.locator('[data-preview-status="invalid"]')
			await invalid.waitFor({ timeout: 15_000 })
			expect(await invalid.textContent()).toContain('preview.stylesheet_load_failed')
			expect(await invalid.textContent()).toMatch(/\/api\/preview\/runtime\/[0-9a-f]+\/runtime\.css/)
			expect(await page.locator('link[data-uiux-product-kit-stylesheet]').count()).toBe(0)
			expect(await page.evaluate(() => document.documentElement.hasAttribute('data-kit-theme'))).toBe(false)
		}
		finally {
			await context.close()
		}
	}, 60_000)
})
