import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, normalize } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'

import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'

/**
 * The Assets page of a built static publication (`uiux publish`), served by a plain static file
 * server on one origin, the way a static host serves it:
 *
 * - an SVG Asset is shown and downloaded without any `<img>` or link pointing at its raw `.svg`
 *   file on the published site's origin, so opening the image or the link on its own never runs
 *   a script inside the SVG there;
 * - an HTML or XHTML Asset downloads the same way and is never linked by its raw file;
 * - a PNG Asset keeps its static file for display and download.
 */

const REPOSITORY_ROOT = join(import.meta.dirname, '..')
const SVG_ID = '33333333-3333-4333-8333-333333333333'
const PNG_ID = '44444444-4444-4444-8444-444444444444'
const HTML_ID = '55555555-5555-4555-8555-555555555555'
const XHTML_ID = '66666666-6666-4666-8666-666666666666'
const SENTINEL = 'uiux.test.asset-script-ran'
/** A script that appends which Asset ran it, and on which origin. */
const mark = (source: string) => `localStorage.setItem('${SENTINEL}', (localStorage.getItem('${SENTINEL}') || '') + '${source} ' + location.origin + ';')`
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="teal"/><script>${mark('svg')}</script></svg>`
const HTML = `<!doctype html><title>Page</title><script>${mark('html')}</script>`
const XHTML = `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page</title><script>${mark('xhtml')}</script></head><body/></html>`
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
const RAW_SVG_PATH = `/uiux/_uiux/assets/${SVG_ID}/scripted.svg`
const RAW_PNG_PATH = `/uiux/_uiux/assets/${PNG_ID}/pixel.png`

let tempRoot = ''
let server: Server | undefined
let origin = ''
let browser: Browser | undefined

function contentType(path: string): string {
	const types: Record<string, string> = {
		'.css': 'text/css; charset=utf-8',
		'.html': 'text/html; charset=utf-8',
		'.js': 'text/javascript; charset=utf-8',
		'.json': 'application/json; charset=utf-8',
		'.mjs': 'text/javascript; charset=utf-8',
		'.png': 'image/png',
		'.svg': 'image/svg+xml',
		'.xhtml': 'application/xhtml+xml',
	}
	return types[extname(path)] ?? 'application/octet-stream'
}

/** A static host: files by extension, a missing path gets the site's 404.html (which boots the SPA). */
async function serve(siteRoot: string, fallback: string): Promise<Server> {
	const httpServer = createServer((request, response) => {
		void (async () => {
			const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname)
			const relative = normalize(pathname).replace(/^[/\\]+/u, '')
			if (relative.startsWith('..')) {
				response.writeHead(400).end()
				return
			}
			let filePath = join(siteRoot, relative)
			try {
				if ((await stat(filePath)).isDirectory()) filePath = join(filePath, 'index.html')
				const bytes = await readFile(filePath)
				response.writeHead(200, { 'content-type': contentType(filePath), 'cache-control': 'no-store' }).end(bytes)
			}
			catch {
				response.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(await readFile(fallback))
			}
		})()
	})
	await new Promise<void>((resolve, reject) => {
		httpServer.once('error', reject)
		httpServer.listen(0, '127.0.0.1', resolve)
	})
	return httpServer
}

beforeAll(async () => {
	tempRoot = await mkdtemp(join(tmpdir(), 'uiux-publication-assets-'))
	const workspace = join(tempRoot, 'workspace')
	const siteRoot = join(tempRoot, 'site')
	const out = join(siteRoot, 'uiux')
	await mkdir(join(workspace, '.uiux'), { recursive: true })
	await writeFile(join(workspace, '.uiux', 'workspace.json'), JSON.stringify({
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } },
		themes: { light: { label: 'Light' } },
	}))
	const persistence = new FileNativePersistence({ root: workspace, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.locales.create('en-US', { 'app.title': 'Published Assets' })
	await persistence.assets.create(SVG_ID, {
		metadata: { id: SVG_ID, name: 'Scripted', contentFilename: 'scripted.svg', mediaType: 'image/svg+xml' },
		content: new TextEncoder().encode(SVG),
	})
	await persistence.assets.create(PNG_ID, {
		metadata: { id: PNG_ID, name: 'Pixel', contentFilename: 'pixel.png', mediaType: 'image/png' },
		content: PNG,
	})
	await persistence.assets.create(HTML_ID, {
		metadata: { id: HTML_ID, name: 'Page', contentFilename: 'page.html', mediaType: 'text/html' },
		content: new TextEncoder().encode(HTML),
	})
	await persistence.assets.create(XHTML_ID, {
		metadata: { id: XHTML_ID, name: 'Strict page', contentFilename: 'page.xhtml', mediaType: 'application/xhtml+xml' },
		content: new TextEncoder().encode(XHTML),
	})
	// The CLI reads the built Workbench (`pnpm build`, which `pnpm test` runs first).
	execFileSync(process.execPath, [join(REPOSITORY_ROOT, 'bin', 'uiux.mjs'), 'publish', '--workspace', workspace, '--out', out, '--base', '/uiux/'], { stdio: 'pipe', timeout: 120_000 })
	expect(await readFile(join(siteRoot, RAW_SVG_PATH), 'utf8')).toBe(SVG)

	server = await serve(siteRoot, join(out, '404.html'))
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('The static server has no port.')
	origin = `http://127.0.0.1:${address.port}`
	browser = await chromium.launch({ headless: true })
}, 180_000)

afterAll(async () => {
	await browser?.close()
	if (server) await new Promise(resolve => server!.close(resolve))
	if (tempRoot) await rm(tempRoot, { recursive: true, force: true })
})

async function openAssets(layout: 'grid' | 'list'): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser!.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } })
	await context.addInitScript((value) => {
		try {
			localStorage.setItem('uiux.workbench.locale', 'en-US')
			localStorage.setItem('uiux.workbench.assetsLayout', value)
		}
		catch { /* an opaque-origin document has no storage */ }
	}, layout)
	const page = await context.newPage()
	await page.goto(`${origin}/uiux/workspace/assets`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

/** Whether a script ran with the publication's origin: each Asset's script writes this storage key. */
async function sentinel(page: Page): Promise<string | null> {
	return await page.evaluate(key => localStorage.getItem(key), SENTINEL)
}

/** Every address on the page a reader can open on its own: link targets and image sources. */
async function addresses(page: Page): Promise<string[]> {
	return await page.evaluate(() => [
		...[...document.querySelectorAll('a[href]')].map(element => (element as HTMLAnchorElement).href),
		...[...document.querySelectorAll('img[src]')].map(element => (element as HTMLImageElement).src),
	])
}

/** Opens an address in its own tab, as "Open link (or image) in new tab" would. */
async function openOnItsOwn(context: BrowserContext, address: string): Promise<void> {
	const tab = await context.newPage()
	try {
		await tab.goto(address, { waitUntil: 'load' })
	}
	catch {
		// A browser may refuse a top-level `data:` navigation outright; nothing ran then either.
	}
	finally {
		await tab.close()
	}
}

async function downloadFrom(page: Page, link: Locator): Promise<{ filename: string; bytes: Buffer }> {
	const [download] = await Promise.all([page.waitForEvent('download'), link.click()])
	const path = await download.path()
	return { filename: download.suggestedFilename(), bytes: await readFile(path) }
}

/** Waits for an `<img>` to decode; its source and natural width. */
async function imageLoaded(image: Locator): Promise<{ src: string; width: number }> {
	await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).complete && (element as HTMLImageElement).naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0)
	return await image.evaluate(element => ({ src: (element as HTMLImageElement).src, width: (element as HTMLImageElement).naturalWidth }))
}

/** Opens every Asset address on the page on its own and reports whether the SVG's script ran here. */
async function openEveryAssetAddress(context: BrowserContext, page: Page): Promise<string | null> {
	for (const address of await addresses(page))
		if (address.includes('/_uiux/assets/') || address.startsWith('data:')) await openOnItsOwn(context, address)
	return await sentinel(page)
}

describe('Published document-capable Assets open without the raw file on the publication origin', () => {
	it('shows and downloads the SVG from the grid and the detail, and no address on the page runs its script', async () => {
		const { context, page } = await openAssets('grid')
		try {
			const svgDownload = page.locator('main').getByRole('link', { name: 'Download Scripted' })
			await svgDownload.waitFor()
			// The tile still shows the SVG as an image (an `<img>` never runs SVG script).
			expect((await imageLoaded(page.getByRole('button', { name: 'Open Scripted' }).locator('img'))).width).toBe(40)

			// Opening any link or image on its own, as a new tab would, never runs the SVG's script here.
			expect(await openEveryAssetAddress(context, page)).toBeNull()
			expect(await svgDownload.getAttribute('href')).toMatch(/^data:application\/octet-stream;base64,/u)
			expect(await page.getByRole('button', { name: 'Open Scripted' }).locator('img').getAttribute('src')).toMatch(/^data:image\/svg\+xml;base64,/u)

			// Download saves the authored bytes under the authored filename and leaves the page in place.
			const saved = await downloadFrom(page, svgDownload)
			expect(saved.filename).toBe('scripted.svg')
			expect(saved.bytes.toString('utf8')).toBe(SVG)
			expect(new URL(page.url()).pathname).toBe('/uiux/workspace/assets')

			// The detail shows the same full-size image and Download, with no raw file either.
			await page.getByRole('button', { name: 'Open Scripted' }).click()
			expect((await imageLoaded(page.getByRole('img', { name: 'Preview of Scripted' }))).width).toBe(40)
			const detailDownload = page.getByRole('dialog').getByRole('link', { name: 'Download' })
			expect((await downloadFrom(page, detailDownload)).bytes.toString('utf8')).toBe(SVG)
			expect(await openEveryAssetAddress(context, page)).toBeNull()
			expect((await addresses(page)).filter(address => address.startsWith(`${origin}/`) && address.endsWith('.svg'))).toEqual([])
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('downloads the SVG from the list without its raw file', async () => {
		const { context, page } = await openAssets('list')
		try {
			const svgDownload = page.locator('[data-asset-list]').getByRole('link', { name: 'Download Scripted' })
			await svgDownload.waitFor()
			expect(await openEveryAssetAddress(context, page)).toBeNull()
			expect(await svgDownload.getAttribute('href')).not.toContain(RAW_SVG_PATH)
			expect((await downloadFrom(page, svgDownload)).bytes.toString('utf8')).toBe(SVG)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('downloads HTML and XHTML Assets without their raw files, and no address on the page runs their scripts', async () => {
		const { context, page } = await openAssets('grid')
		try {
			const htmlDownload = page.locator('main').getByRole('link', { name: 'Download Page' })
			const xhtmlDownload = page.locator('main').getByRole('link', { name: 'Download Strict page' })
			await htmlDownload.waitFor()
			await xhtmlDownload.waitFor()
			expect(await openEveryAssetAddress(context, page)).toBeNull()
			for (const link of [htmlDownload, xhtmlDownload])
				expect(await link.getAttribute('href')).toMatch(/^data:application\/octet-stream;base64,/u)
			// Neither is shown as an image.
			expect(await page.getByRole('button', { name: 'Open Page' }).locator('img').count()).toBe(0)

			const html = await downloadFrom(page, htmlDownload)
			expect(html.filename).toBe('page.html')
			expect(html.bytes.toString('utf8')).toBe(HTML)
			const xhtml = await downloadFrom(page, xhtmlDownload)
			expect(xhtml.filename).toBe('page.xhtml')
			expect(xhtml.bytes.toString('utf8')).toBe(XHTML)
			expect(new URL(page.url()).pathname).toBe('/uiux/workspace/assets')

			await page.getByRole('button', { name: 'Open Page' }).click()
			const detailDownload = page.getByRole('dialog').getByRole('link', { name: 'Download' })
			expect(await detailDownload.getAttribute('href')).toMatch(/^data:application\/octet-stream;base64,/u)
			expect(await openEveryAssetAddress(context, page)).toBeNull()
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('keeps a PNG Asset on its static file for display and download', async () => {
		const { context, page } = await openAssets('grid')
		try {
			const pngDownload = page.locator('main').getByRole('link', { name: 'Download Pixel' })
			await pngDownload.waitFor()
			expect(await pngDownload.getAttribute('href')).toBe(RAW_PNG_PATH)
			const tile = await imageLoaded(page.getByRole('button', { name: 'Open Pixel' }).locator('img'))
			expect(new URL(tile.src).pathname).toBe(RAW_PNG_PATH)
			expect(tile.width).toBe(1)
			const saved = await downloadFrom(page, pngDownload)
			expect(saved.filename).toBe('pixel.png')
			expect(saved.bytes.equals(PNG)).toBe(true)
		}
		finally {
			await context.close()
		}
	}, 60_000)
})
