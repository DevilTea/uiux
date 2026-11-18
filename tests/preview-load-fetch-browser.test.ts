import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * How one Preview document loads (Features 01a111e4-0230-7cd4-8870-cb5c4e7139e3 and
 * 01a111e4-0265-…, Translation runtime 01a111e4-0163-…), against the built server. The reads that do
 * not depend on one another (the Workspace, the View, the Locale the URL names and the Adapter plan)
 * are issued together and the bundle is imported as soon as the plan names it, while every outcome
 * stays the one the sequential load had: the first stage that fails decides what the document shows
 * (the View, the default Locale, a missing default Locale, the Adapter plan or the bundle).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const PATH = `/preview?viewId=${VIEW_ID}&locale=en-US&viewportId=desktop&themeId=light`

const READS = {
	workspace: '**/api/resources/workspace/workspace',
	view: `**/api/resources/view/${VIEW_ID}`,
	locale: '**/api/resources/locale/en-US',
	adapters: '**/api/preview/adapters',
	bundle: '**/api/preview/runtime/*/runtime.js',
} as const
type Read = keyof typeof READS

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => localStorage.setItem('nuxt-color-mode', 'light'))
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	return { context, page: await context.newPage() }
}

/** The status the document settled on, with the text it shows. */
async function settled(page: Page): Promise<{ status: string | null; text: string }> {
	const element = await page.waitForSelector('[data-preview-status]:not([data-preview-status="loading"])', { timeout: 20_000 })
	return { status: await element.getAttribute('data-preview-status'), text: (await element.textContent()) ?? '' }
}

/** Answers each of `reads` with `status` instead of the server's answer. */
async function failReads(page: Page, reads: readonly Read[], status = 500): Promise<void> {
	for (const read of reads) await page.route(READS[read], route => route.fulfill({ status, contentType: 'application/json', body: '{}' }))
}

/** Holds the answers of `reads` until `release()`, recording which of them were asked for. */
async function holdReads(page: Page, reads: readonly Read[]): Promise<{ asked: () => Read[]; release: () => Promise<void> }> {
	const asked = new Set<Read>()
	const held: Route[] = []
	let released = false
	for (const read of reads) {
		await page.route(READS[read], async (route) => {
			asked.add(read)
			if (released) await route.continue()
			else held.push(route)
		})
	}
	return {
		asked: () => [...asked].sort(),
		release: async () => {
			released = true
			await Promise.all(held.splice(0).map(route => route.continue()))
		},
	}
}

describe('the reads of one Preview document load', () => {
	it('issues the Workspace, View, Locale and Adapter plan reads before any of them is answered', async () => {
		const { context, page } = await newPage()
		try {
			const held = await holdReads(page, ['workspace', 'view', 'locale', 'adapters'])
			await page.goto(`${server.origin}${PATH}`, { waitUntil: 'commit' })
			await expect.poll(held.asked, { timeout: 10_000 }).toEqual(['adapters', 'locale', 'view', 'workspace'])
			await held.release()
			expect((await settled(page)).status).toBe('ready')
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('imports the bundle as soon as the Adapter plan names it, without waiting for the Locale', async () => {
		const { context, page } = await newPage()
		try {
			const held = await holdReads(page, ['locale'])
			const imported = new Promise<string>(resolve => page.on('request', (request) => {
				if (/\/api\/preview\/runtime\/[^/]+\/runtime\.js$/.test(request.url())) resolve(request.url())
			}))
			await page.goto(`${server.origin}${PATH}`, { waitUntil: 'commit' })
			// The Locale read is still held when the bundle is asked for.
			await expect(Promise.race([imported, new Promise(resolve => setTimeout(() => resolve('not imported'), 10_000))])).resolves.toMatch(/runtime\.js$/)
			expect(held.asked()).toEqual(['locale'])
			await held.release()
			expect((await settled(page)).status).toBe('ready')
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('serves the bundle with an immutable cache header, so a second document load takes it from the browser cache', async () => {
		const { context, page } = await newPage()
		try {
			const bundleTransfer = () => page.evaluate(() => performance.getEntriesByType('resource')
				.filter(entry => /\/api\/preview\/runtime\/[^/]+\/runtime\.js$/.test(entry.name))
				.map(entry => ({ transferSize: (entry as PerformanceResourceTiming).transferSize, bodySize: (entry as PerformanceResourceTiming).encodedBodySize })))
			let bundleUrl: string | undefined
			page.on('response', (response) => {
				if (/\/api\/preview\/runtime\/[^/]+\/runtime\.js$/.test(response.url())) bundleUrl = response.url()
			})
			await page.goto(`${server.origin}${PATH}`)
			expect((await settled(page)).status).toBe('ready')
			expect(bundleUrl).toBeDefined()
			const response = await page.request.get(bundleUrl!)
			expect(response.headers()['cache-control']).toBe('private, max-age=31536000, immutable')
			expect(await bundleTransfer()).toEqual([{ transferSize: expect.any(Number), bodySize: expect.any(Number) }])
			expect((await bundleTransfer())[0]!.transferSize).toBeGreaterThan(0)
			await page.reload()
			expect((await settled(page)).status).toBe('ready')
			// Served from the browser's cache: no bytes crossed the network, and no revalidation either.
			expect(await bundleTransfer()).toEqual([{ transferSize: 0, bodySize: expect.any(Number) }])
		}
		finally {
			await context.close()
		}
	}, 60_000)

	// Several reads failing at once: the first stage of the sequential load that fails decides.
	it.each([
		{ name: 'the View alone', failing: ['view'], status: 'error', text: 'Could not load the View.' },
		{ name: 'the default Locale alone', failing: ['locale'], status: 'error', text: 'Could not load the primary Locale.' },
		{ name: 'the Adapter plan alone', failing: ['adapters'], status: 'invalid', text: '[adapter.bundle_load_failed]' },
		{ name: 'the bundle alone', failing: ['bundle'], status: 'invalid', text: '[adapter.bundle_load_failed]' },
		{ name: 'the Workspace alone, which the document ignores', failing: ['workspace'], status: 'ready', text: '' },
		{ name: 'the View and the Adapter plan, which the View decides', failing: ['view', 'adapters'], status: 'error', text: 'Could not load the View.' },
		{ name: 'the View and the Locale, which the View decides', failing: ['view', 'locale'], status: 'error', text: 'Could not load the View.' },
		{ name: 'the Locale and the Adapter plan, which the Locale decides', failing: ['locale', 'adapters'], status: 'error', text: 'Could not load the primary Locale.' },
		{ name: 'everything, which the View decides', failing: ['workspace', 'view', 'locale', 'adapters', 'bundle'], status: 'error', text: 'Could not load the View.' },
	] satisfies { name: string; failing: Read[]; status: string; text: string }[])('shows the sequential load\'s outcome when $name fails', async ({ failing, status, text }) => {
		const { context, page } = await newPage()
		try {
			await failReads(page, failing)
			await page.goto(`${server.origin}${PATH}`)
			const result = await settled(page)
			expect(result.status).toBe(status)
			expect(result.text).toContain(text)
		}
		finally {
			await context.close()
		}
	}, 60_000)

	it('blocks on a missing default Locale before an Adapter plan failure is considered', async () => {
		const { context, page } = await newPage()
		try {
			await failReads(page, ['locale'], 404)
			await failReads(page, ['adapters'])
			await page.goto(`${server.origin}${PATH}`)
			expect((await settled(page)).status).toBe('blocked')
		}
		finally {
			await context.close()
		}
	}, 60_000)
})
