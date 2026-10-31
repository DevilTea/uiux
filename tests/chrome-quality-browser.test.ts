import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Browser sweeps for three cross-cutting quality Rules of the Workbench chrome (issue #425):
 *
 * - 01a116f0-952d-7aa4-9a16-2648b1852daa: on touch, no action or information depends on hover.
 * - 01a116f0-9461-77fe-8ce2-ee89ba0d4ef0: interactive chrome targets are at least 24 by 24 CSS
 *   pixels, and at least 44 by 44 on touch layouts.
 * - 01a116f0-93d4-7787-a451-9613c16592f3: chrome layouts tolerate the length differences between
 *   English and Chinese labels without overlapping or cutting off essential text.
 *
 * The sweeps run on the built Workbench against a private copy of the frozen fixture Workspace
 * (temporary workspace and UIUX_HOME). The Preview iframe holds product content, not chrome, and is
 * never swept.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** Overview, a View page, Flows, Reviews, Members and the Workspace pages. */
const ROUTES = ['/', `/views/${VIEW_ID}`, '/flows', '/reviews', '/members', '/workspace/settings', '/workspace/access-presets', '/workspace/locales', '/workspace/assets', '/workspace/product-kit']

const DESKTOP = { width: 1440, height: 900, touch: false }
const TABLET = { width: 1024, height: 768, touch: false }
const PHONE = { width: 390, height: 844, touch: true }

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

type Viewport = Readonly<{ width: number; height: number; touch: boolean }>

async function open(path: string, viewport: Viewport, locale: 'en-US' | 'zh-TW'): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		colorScheme: 'light',
		...(viewport.touch ? { hasTouch: true, isMobile: true } : {}),
	})
	await context.addInitScript(([mode, chromeLocale]) => {
		localStorage.setItem('nuxt-color-mode', mode)
		localStorage.setItem('uiux.workbench.locale', chromeLocale)
	}, ['light', locale] as const)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	await page.waitForTimeout(500)
	return { context, page }
}

/** Runs `probe` on every main route and returns the offenders as `route: description`. */
async function sweep(viewport: Viewport, locale: 'en-US' | 'zh-TW', probe: (page: Page) => Promise<string[]>): Promise<string[]> {
	const offenders: string[] = []
	for (const route of ROUTES) {
		const { context, page } = await open(route, viewport, locale)
		try {
			if (viewport.touch) expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true)
			for (const found of await probe(page)) offenders.push(`${route}: ${found}`)
		}
		finally { await context.close() }
	}
	return offenders
}

const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="menuitem"], [role="switch"], [role="checkbox"], [role="radio"], [role="link"], [role="treeitem"], [role="option"], [tabindex]:not([tabindex="-1"])'

describe('On touch, no action or information depends on hover (Rule 01a116f0-952d-7aa4-9a16-2648b1852daa)', () => {
	it('reveals every hover-gated control and text without a pointer, and never leaves a control named by a tooltip alone', async () => {
		const offenders = await sweep(PHONE, 'en-US', page => page.evaluate((selector) => {
			const found: string[] = []
			const describe = (element: Element) => `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '').slice(0, 70)} "${(element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 30)}"`
			const effectiveOpacity = (element: Element) => {
				let opacity = 1
				for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number.parseFloat(getComputedStyle(node).opacity)
				return opacity
			}
			const rendered = (element: Element) => {
				const style = getComputedStyle(element)
				const rect = element.getBoundingClientRect()
				return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 1 && rect.height > 1
			}
			for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
				if (element.closest('iframe, svg, .sr-only')) continue
				const ownText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
				if (!element.matches(selector) && !ownText) continue
				if (!rendered(element)) continue
				// Information or an action sitting at opacity 0 waits for a hover (or focus) to appear.
				if (effectiveOpacity(element) < 0.5) found.push(`hidden until hover: ${describe(element)}`)
			}
			for (const element of Array.from(document.querySelectorAll<HTMLElement>(selector))) {
				if (element.closest('iframe') || !rendered(element)) continue
				const named = element.innerText?.trim() || element.getAttribute('aria-label')?.trim() || element.getAttribute('aria-labelledby') || (element as HTMLInputElement).labels?.length
				// `title` is a hover tooltip: it cannot be the only name.
				if (!named && element.getAttribute('title')) found.push(`named by a hover title only: ${describe(element)}`)
			}
			return found
		}, INTERACTIVE))
		expect(offenders).toEqual([])
	}, 180_000)

	it('keeps the Locales row action, hover-revealed on desktop, visible on touch', async () => {
		const { context, page } = await open('/workspace/locales', PHONE, 'en-US')
		try {
			const remove = page.locator('button[aria-label]').filter({ has: page.locator('svg, [class*="i-"]') }).first()
			await remove.waitFor({ state: 'attached' })
			expect(await remove.evaluate((element) => {
				let opacity = 1
				for (let node: Element | null = element; node; node = node.parentElement) opacity *= Number.parseFloat(getComputedStyle(node).opacity)
				return opacity
			})).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)
})

/**
 * The Rule counts the Workbench's interactive chrome; an inline link inside a running sentence is
 * exempt (WCAG 2.5.8 inline exception), so `isInline` is the one allowlist entry.
 */
const TARGET_PROBE = (minimum: number, selector: string) => (page: Page) => page.evaluate(([min, sel]) => {
	const found: string[] = []
	const describe = (element: Element) => `${element.tagName.toLowerCase()}${element.getAttribute('role') ? `[role=${element.getAttribute('role')}]` : ''}.${String(element.getAttribute('class') ?? '').slice(0, 70)} "${(element.textContent || element.getAttribute('aria-label') || '').trim().slice(0, 30)}"`
	const isInline = (element: Element) => {
		if (element.tagName !== 'A' || getComputedStyle(element).display !== 'inline') return false
		const parent = element.parentElement
		if (!parent) return false
		// An inline link is part of running text: its parent carries text of its own around it.
		return Array.from(parent.childNodes).some(node => node !== element && node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
	}
	for (const element of Array.from(document.querySelectorAll<HTMLElement>(sel as string))) {
		if (element.closest('iframe, [aria-hidden="true"]')) continue
		const style = getComputedStyle(element)
		if (style.display === 'none' || style.visibility === 'hidden' || (element as HTMLInputElement).disabled) continue
		const rect = element.getBoundingClientRect()
		// A visually hidden control is not a target: a skip link is `sr-only` until focus reveals it.
		if (rect.width <= 1 || rect.height <= 1 || element.matches('.sr-only')) continue
		if (isInline(element)) continue
		if (rect.width < (min as number) - 0.01 || rect.height < (min as number) - 0.01) found.push(`${Math.round(rect.width)}x${Math.round(rect.height)}: ${describe(element)}`)
	}
	return found
}, [minimum, selector] as const)

describe('Interactive chrome targets (Rule 01a116f0-9461-77fe-8ce2-ee89ba0d4ef0)', () => {
	it('are at least 24 by 24 CSS pixels on desktop', async () => {
		expect(await sweep(DESKTOP, 'en-US', TARGET_PROBE(24, INTERACTIVE))).toEqual([])
	}, 180_000)

	it('are at least 44 by 44 CSS pixels on touch layouts', async () => {
		expect(await sweep(PHONE, 'en-US', TARGET_PROBE(44, INTERACTIVE))).toEqual([])
	}, 180_000)
})

describe('zh-TW label length tolerance (Rule 01a116f0-93d4-7787-a451-9613c16592f3)', () => {
	for (const viewport of [TABLET, PHONE]) {
		it(`neither truncates nor overflows button, tab and navigation labels at ${viewport.width}px`, async () => {
			const offenders = await sweep(viewport, 'zh-TW', page => page.evaluate(() => {
				const found: string[] = []
				const describe = (element: Element) => `${element.tagName.toLowerCase()}.${String(element.getAttribute('class') ?? '').slice(0, 70)} "${(element.textContent ?? '').trim().slice(0, 30)}"`
				const labelled = 'button, [role="tab"], nav a, header a, aside a, [role="menuitem"], summary, [role="button"]'
				for (const element of Array.from(document.querySelectorAll<HTMLElement>(labelled))) {
					if (element.closest('iframe')) continue
					const style = getComputedStyle(element)
					if (style.display === 'none' || style.visibility === 'hidden') continue
					const box = element.getBoundingClientRect()
					if (box.width <= 1 || box.height <= 1) continue
					if (!(element.textContent ?? '').trim()) continue
					// Allowlist: an Asset tile truncates Asset data (the file name and media type) by design; its
					// accessible name and the detail panel carry the full text, and it clips in English as well.
					if (element.matches('[data-asset-tile]')) continue
					// Cut off: text clipped by the element or by a descendant that carries it.
					for (const node of [element, ...Array.from(element.querySelectorAll<HTMLElement>('*'))]) {
						const nodeStyle = getComputedStyle(node)
						if (nodeStyle.display === 'none' || node.clientWidth === 0) continue
						const clipsX = node.scrollWidth > node.clientWidth + 1 && nodeStyle.overflowX !== 'visible'
						const clipsY = node.scrollHeight > node.clientHeight + 1 && nodeStyle.overflowY !== 'visible'
						if (clipsX || clipsY) { found.push(`clipped: ${describe(element)}`); break }
					}
					// Overflow: label text spilling outside its element.
					const range = document.createRange()
					range.selectNodeContents(element)
					const textBox = range.getBoundingClientRect()
					if (textBox.width > 0 && (textBox.right > box.right + 1 || textBox.left < box.left - 1)) found.push(`text overflows its box: ${describe(element)}`)
				}
				return found
			}))
			expect(offenders).toEqual([])
		}, 180_000)
	}
})
