import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { composite, contrastRatio, parseCssColor } from './support/color'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'
import { provisionToken, sessionCookieFor } from './support/access'

/**
 * Browser checks against the built Workbench (`pnpm build` output) serving a copy of the
 * dogfood `design/` Workspace. They cover the DESIGN.md token, type and focus contracts and
 * the independence of the Workbench chrome from the Preview render context.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const THREAD_ID = '140f4e87-cc50-4768-a82b-56b663609321'
/** The main screens of the shell (brief a, section 5). */
const MAIN_ROUTES = ['/', `/views/${VIEW_ID}`, '/flows', '/reviews', '/workspace/settings', '/workspace/locales', '/workspace/assets']

let server: WorkbenchServer
let browser: Browser

/** Adds a Variant to the private Workspace copy through the authoring API (never by hand). */
async function authorVariant(name: string): Promise<void> {
	const read = await (await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })).json() as { revision: string; resource: { ir: unknown; variants: Record<string, unknown> } }
	const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/structure`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, ir: read.resource.ir, variants: { ...read.resource.variants, [name]: { state: {} } } }),
	})
	if (!response.ok) throw new Error(`Could not author the test Variant: ${response.status} ${await response.text()}`)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	await authorVariant('compact')
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type ChromeSetup = Readonly<{ mode: 'light' | 'dark'; os?: 'light' | 'dark'; locale?: 'en-US' | 'zh-TW'; width?: number; height?: number; recordWire?: boolean; cookie?: Readonly<{ name: string; value: string }> }>

async function openWorkbench(path: string, setup: ChromeSetup): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: setup.os ?? setup.mode,
	})
	await context.addInitScript(([mode, locale]) => {
		localStorage.setItem('nuxt-color-mode', mode)
		localStorage.setItem('uiux.workbench.locale', locale)
	}, [setup.mode, setup.locale ?? 'en-US'] as const)
	if (setup.recordWire) await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...(setup.cookie ?? server.cookie), url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.waitForFunction(() => document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark'))
	await page.locator('main').first().waitFor()
	return { context, page }
}

/** Phones open a View on its Spec (R13); the canvas lives behind the View tab. */
async function showCanvasOnPhone(page: Page) {
	if ((page.viewportSize()?.width ?? 1920) >= 768) return
	const tab = page.locator('[data-view-phone] [role="tab"]').nth(2)
	await tab.waitFor({ timeout: 15_000 })
	if (await tab.getAttribute('aria-selected') !== 'true') await tab.click()
}

async function previewFrame(page: Page) {
	if (new URL(page.url()).pathname.startsWith('/views/')) await showCanvasOnPhone(page)
	const handle = await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })
	const frame = await handle.contentFrame()
	if (!frame) throw new Error('Preview iframe has no content frame.')
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	return frame
}

/** Resolves CSS custom properties to computed colors through probe elements. */
async function resolveTokens(page: Page, tokens: readonly string[]): Promise<Record<string, string>> {
	return page.evaluate((names) => {
		const out: Record<string, string> = {}
		const probe = document.createElement('div')
		document.body.appendChild(probe)
		for (const name of names) {
			probe.style.color = `var(${name})`
			out[name] = getComputedStyle(probe).color
		}
		probe.remove()
		return out
	}, tokens)
}

describe('Workbench type floor', () => {
	for (const route of MAIN_ROUTES) {
		for (const locale of ['en-US', 'zh-TW'] as const) {
			it(`renders no chrome text below 12px on ${route} (${locale})`, async () => {
				const { context, page } = await openWorkbench(route, { mode: 'light', locale })
				try {
					await page.waitForTimeout(500)
					// The chrome language drives <html lang>, which selects the zh-TW type overrides.
					expect(await page.evaluate(() => document.documentElement.lang)).toBe(locale)
					const offenders = await page.evaluate(() => {
						const found: string[] = []
						for (const element of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
							if (element.closest('iframe')) continue
							const hasText = Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent?.trim())
							const isField = element.matches('input, textarea, select, button')
							if (!hasText && !isField) continue
							const size = Number.parseFloat(getComputedStyle(element).fontSize)
							if (size < 12) found.push(`${element.tagName.toLowerCase()}.${element.className?.toString().slice(0, 60)} = ${size}px "${element.textContent?.trim().slice(0, 30)}"`)
						}
						return found
					})
					expect(offenders).toEqual([])
				}
				finally { await context.close() }
			}, 60_000)
		}
	}
})

describe('Workbench theme independence', () => {
	for (const [mode, os] of [['dark', 'light'], ['light', 'dark']] as const) {
		it(`keeps every control in the Workbench ${mode} theme when the OS prefers ${os}`, async () => {
			const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode, os })
			try {
				const frame = await previewFrame(page)
				const report = await page.evaluate(() => {
					const html = document.documentElement
					const controls = Array.from(document.querySelectorAll<HTMLElement>('button, input, textarea, select, [role="combobox"], [role="tab"]'))
					return {
						htmlClass: html.className,
						htmlScheme: getComputedStyle(html).colorScheme,
						controlSchemes: [...new Set(controls.map(control => getComputedStyle(control).colorScheme))],
						bodyBackground: getComputedStyle(document.body).backgroundColor,
					}
				})
				expect(report.htmlClass).toContain(mode)
				expect(report.htmlScheme).toBe(mode)
				expect(report.controlSchemes).toEqual([mode])
				const bodyLuminanceIsDark = contrastRatio(report.bodyBackground, 'rgb(0, 0, 0)') < 3
				expect(bodyLuminanceIsDark).toBe(mode === 'dark')
				// The Preview document never follows the Workbench color mode.
				const previewHtmlClass = await frame.evaluate(() => document.documentElement.className)
				expect(previewHtmlClass).toContain('light')
				expect(previewHtmlClass).not.toContain('dark')
			}
			finally { await context.close() }
		}, 60_000)
	}
})

describe('Workbench contrast (DESIGN.md verified table)', () => {
	const PAIRS = {
		light: [
			['--ui-text', '--ui-bg', 14.81],
			['--ui-text-muted', '--ui-bg', 7.46],
			['--ui-text-dimmed', '--ui-bg', 4.78],
			['--ui-border-accented', '--ui-bg', 3.24],
			['--ui-primary', '--ui-bg', 5.91],
			['--ui-primary', '--wb-canvas', 5.37],
			['--ui-annotation', '--ui-bg', 6.37],
			['--ui-success', '--ui-bg', 5.82],
			['--ui-warning', '--ui-bg', 6.87],
			['--ui-error', '--ui-bg', 6.42],
			['--ui-info', '--ui-bg', 6.82],
		],
		dark: [
			['--ui-text', '--ui-bg', 14.09],
			['--ui-text-muted', '--ui-bg', 6.85],
			['--ui-text-dimmed', '--ui-bg', 5.45],
			['--ui-border-accented', '--ui-bg', 3.69],
			['--ui-primary', '--ui-bg', 6.49],
			['--ui-primary', '--wb-canvas', 7.14],
			['--ui-annotation', '--ui-bg', 7.0],
			['--ui-success', '--ui-bg', 8.69],
			['--ui-warning', '--ui-bg', 11.26],
			['--ui-error', '--ui-bg', 6.1],
			['--ui-info', '--ui-bg', 6.69],
		],
	} as const

	for (const mode of ['light', 'dark'] as const) {
		it(`matches the ${mode} contrast table within 0.05`, async () => {
			const { context, page } = await openWorkbench('/', { mode })
			try {
				const names = [...new Set(PAIRS[mode].flatMap(([fg, bg]) => [fg, bg]))]
				const colors = await resolveTokens(page, names)
				for (const [fg, bg, expected] of PAIRS[mode]) {
					const ratio = contrastRatio(colors[fg]!, colors[bg]!)
					expect(Math.abs(ratio - expected), `${fg} on ${bg}: ${ratio.toFixed(2)} (expected ${expected})`).toBeLessThan(0.05)
				}
			}
			finally { await context.close() }
		}, 60_000)
	}
})

/**
 * Focuses every visible, keyboard-focusable chrome control with `focusVisible` (as keyboard
 * focus would) and checks the indicator: a solid 2px Iris outline at 3:1 or better against
 * the surface behind the control.
 */
async function auditFocus(page: Page, mode: 'light' | 'dark', route: string): Promise<{ checked: number; failures: string[] }> {
	const primary = (await resolveTokens(page, ['--ui-primary']))['--ui-primary']!
	const count = await page.evaluate(() => {
		const selector = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"]), [role="tab"], [role="treeitem"]'
		const items = Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((element) => {
			const rect = element.getBoundingClientRect()
			const style = getComputedStyle(element)
			return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && element.tabIndex >= 0 && element.tagName !== 'IFRAME'
		})
		items.forEach((element, index) => element.setAttribute('data-focus-audit', String(index)))
		return items.length
	})
	const failures: string[] = []
	const fallbackBackground = parseCssColor(mode === 'dark' ? 'oklch(21.2% 0.007 286)' : 'rgb(255, 255, 255)')
	for (let index = 0; index < count; index++) {
		const info = await page.evaluate(async (target) => {
			const element = document.querySelector<HTMLElement>(`[data-focus-audit="${target}"]`)
			if (!element) return undefined
			element.focus({ focusVisible: true } as FocusOptions)
			if (document.activeElement !== element) return undefined
			// Let color transitions on the outline settle before reading it.
			await new Promise(resolve => setTimeout(resolve, 200))
			const style = getComputedStyle(element)
			let background = 'rgba(0, 0, 0, 0)'
			for (let node: HTMLElement | null = element.parentElement; node; node = node.parentElement) {
				const candidate = getComputedStyle(node).backgroundColor
				if (!/rgba\(0, 0, 0, 0\)|transparent/.test(candidate)) { background = candidate; break }
			}
			const label = element.getAttribute('aria-label') ?? element.textContent?.trim().slice(0, 24) ?? ''
			const result = { label: `${element.tagName.toLowerCase()}[${label}]`, outlineStyle: style.outlineStyle, outlineWidth: style.outlineWidth, outlineColor: style.outlineColor, background }
			element.blur()
			return result
		}, index)
		if (!info) continue
		if (info.outlineStyle !== 'solid' || info.outlineWidth !== '2px') {
			failures.push(`${route} ${info.label}: focus outline is ${info.outlineStyle} ${info.outlineWidth}`)
			continue
		}
		if (contrastRatio(info.outlineColor, primary) > 1.05) failures.push(`${route} ${info.label}: focus color ${info.outlineColor} is not Iris ${primary}`)
		const ratio = contrastRatio(info.outlineColor, composite(parseCssColor(info.background), fallbackBackground))
		if (ratio < 3) failures.push(`${route} ${info.label}: focus contrast ${ratio.toFixed(2)} < 3`)
	}
	return { checked: count, failures }
}

describe('Workbench focus', () => {
	for (const mode of ['light', 'dark'] as const) {
		it(`draws a 2px Iris focus outline of at least 3:1 on every focusable control (${mode})`, async () => {
			const failures: string[] = []
			let checked = 0
			for (const route of MAIN_ROUTES) {
				const { context, page } = await openWorkbench(route, { mode })
				try {
					await page.waitForTimeout(500)
					const result = await auditFocus(page, mode, route)
					checked += result.checked
					failures.push(...result.failures)
				}
				finally { await context.close() }
			}
			expect(checked).toBeGreaterThan(5)
			expect(failures).toEqual([])
		}, 180_000)
	}
})

type FrameContext = { locale: string | null; themeId: string | null; viewportId: string | null; variant: string | null }

async function iframeContext(page: Page): Promise<FrameContext> {
	return page.evaluate(() => {
		const src = document.querySelector('iframe')?.getAttribute('src') ?? ''
		const params = new URL(src, location.href).searchParams
		return { locale: params.get('locale'), themeId: params.get('themeId'), viewportId: params.get('viewportId'), variant: params.get('variant') }
	})
}

describe('Workbench shell (R3)', () => {
	it('replaces the nine-tab grid with three primary areas and one Workspace entry', async () => {
		const { context, page } = await openWorkbench('/', { mode: 'light' })
		try {
			const nav = page.locator('[data-landmark="navigation"]')
			for (const name of ['Overview', 'UX Flows', 'Reviews', 'Workspace'])
				expect(await nav.getByRole('link', { name: new RegExp(`^${name}`) }).count(), name).toBe(1)
			// The Overview's Views tab is the one View list: no second "Views" destination.
			expect(await nav.getByRole('link', { name: /^Views/ }).count()).toBe(0)
			const largestTablist = await page.evaluate(() => Math.max(0, ...Array.from(document.querySelectorAll('[role="tablist"]')).map(list => list.querySelectorAll('[role="tab"]').length)))
			expect(largestTablist).toBeLessThan(9)
			for (const role of ['banner', 'navigation', 'main'])
				expect(await page.locator(`[data-landmark="${role}"]`).count(), role).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)

	it('reproduces a deep-linked render context, Widget and thread after reload', async () => {
		const query = `?variant=compact&locale=zh-TW&viewport=tablet&theme=light&widget=root&thread=${THREAD_ID}`
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}${query}`, { mode: 'light' })
		try {
			const expected = { locale: 'zh-TW', themeId: 'light', viewportId: 'tablet', variant: 'compact' }
			await previewFrame(page)
			expect(await iframeContext(page)).toEqual(expected)
			await page.getByRole('tab', { name: /Comments/ }).and(page.locator('[aria-selected="true"]')).waitFor()
			await page.reload({ waitUntil: 'networkidle' })
			await previewFrame(page)
			expect(await iframeContext(page)).toEqual(expected)
			const url = new URL(page.url())
			expect(url.searchParams.get('thread')).toBe(THREAD_ID)
			expect(url.searchParams.get('variant')).toBe('compact')
			await page.getByRole('tab', { name: /Comments/ }).and(page.locator('[aria-selected="true"]')).waitFor()
			// The deep-linked thread opens its bubble on the canvas, even though resolved threads are filtered out.
			await page.waitForSelector(`[data-thread-bubble][data-thread-status="resolved"]`, { timeout: 15_000 })
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps the Workbench language and theme independent of the Preview Locale and theme', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?locale=en-US&theme=dark`, { mode: 'light', locale: 'en-US' })
		try {
			let frame = await previewFrame(page)
			const before = await iframeContext(page)
			const previewHostClass = () => frame.evaluate(() => document.querySelector('[data-preview-ready]')?.parentElement?.className ?? '')
			const hostBefore = await previewHostClass()
			expect(hostBefore).toContain('dark')

			// Workbench theme and language change: the Preview context does not.
			await page.getByRole('button', { name: 'Workbench preferences' }).click()
			await page.getByRole('menuitemcheckbox', { name: 'Dark' }).click()
			await page.keyboard.press('Escape')
			await page.waitForFunction(() => document.documentElement.classList.contains('dark'))
			await page.getByRole('button', { name: 'Workbench preferences' }).click()
			await page.getByRole('menuitemcheckbox', { name: '繁體中文' }).click()
			await page.keyboard.press('Escape')
			await page.waitForFunction(() => document.documentElement.lang === 'zh-TW')
			await page.waitForTimeout(300)
			expect(await iframeContext(page)).toEqual(before)
			frame = await previewFrame(page)
			expect(await previewHostClass()).toBe(hostBefore)
			expect(await frame.evaluate(() => document.documentElement.className)).not.toContain('dark')

			// Preview theme changes: the Workbench theme and language do not.
			await page.getByRole('combobox', { name: '預覽主題' }).click()
			await page.getByRole('option', { name: 'Light' }).click()
			// A theme change is a presentation change: the same document re-renders, it is not reloaded.
			await frame.waitForFunction(() => document.querySelector('[data-preview-ready]')?.parentElement?.classList.contains('light'))
			expect(await page.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), lang: document.documentElement.lang })))
				.toEqual({ dark: true, lang: 'zh-TW' })
			expect(new URL(page.url()).searchParams.get('theme')).toBe('light')
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps at least 60% of a 1920px window for the canvas with both panels open', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light' })
		try {
			await previewFrame(page)
			const widths = await page.evaluate(() => ({
				canvas: document.querySelector('#canvas')!.getBoundingClientRect().width,
				sidebar: document.querySelector('[data-landmark="navigation"]')!.getBoundingClientRect().width,
				panel: document.querySelector('[data-landmark="complementary"]')!.getBoundingClientRect().width,
			}))
			expect(widths.sidebar).toBeGreaterThan(200)
			expect(widths.panel).toBeGreaterThan(280)
			expect(widths.canvas / 1920).toBeGreaterThanOrEqual(0.6)
		}
		finally { await context.close() }
	}, 60_000)

	it('persists sidebar collapse and resize across reloads', async () => {
		const { context, page } = await openWorkbench('/', { mode: 'light' })
		try {
			const sidebarWidth = () => page.evaluate(() => document.querySelector('[data-landmark="navigation"]')!.closest('[data-slot="root"]')!.getBoundingClientRect().width)
			const handle = page.locator('[data-slot="handle"]').first()
			const box = (await handle.boundingBox())!
			await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
			await page.mouse.down()
			await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
			await page.mouse.up()
			const resized = await sidebarWidth()
			expect(resized).toBeGreaterThan(300)
			await page.reload({ waitUntil: 'networkidle' })
			expect(Math.abs(await sidebarWidth() - resized)).toBeLessThan(2)

			await page.getByRole('button', { name: 'Collapse sidebar' }).click()
			await page.waitForFunction(() => document.querySelector('[data-landmark="navigation"]')!.closest('[data-slot="root"]')!.getBoundingClientRect().width < 80)
			await page.reload({ waitUntil: 'networkidle' })
			expect(await sidebarWidth()).toBeLessThan(80)
		}
		finally { await context.close() }
	}, 60_000)

	for (const [width, height] of [[1024, 768], [390, 844]] as const) {
		it(`does not overflow horizontally at ${width}×${height}`, async () => {
			for (const route of MAIN_ROUTES) {
				const { context, page } = await openWorkbench(route, { mode: 'light', width, height })
				try {
					await page.waitForTimeout(300)
					const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
					expect(overflow, route).toBeLessThanOrEqual(0)
				}
				finally { await context.close() }
			}
		}, 120_000)
	}
})

/** The dogfood Workspace viewport presets (design/.uiux/workspace.json). */
const VIEWPORT_PRESETS = { desktop: [1920, 1080], tablet: [1024, 768], mobile: [390, 844] } as const

type CanvasMetrics = Readonly<{
	iframe: { styleWidth: string; styleHeight: string; clientWidth: number; clientHeight: number }
	scale: number
	frame: { left: number; top: number; width: number; height: number }
	stage: { left: number; top: number; width: number; height: number }
	percent: string
	fitted: boolean
}>

async function canvasMetrics(page: Page): Promise<CanvasMetrics> {
	return page.evaluate(() => {
		const iframe = document.querySelector<HTMLIFrameElement>('[data-canvas-frame] iframe')!
		const frame = document.querySelector<HTMLElement>('[data-canvas-frame]')!
		const box = (element: Element) => { const r = element.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height } }
		return {
			iframe: { styleWidth: iframe.style.width, styleHeight: iframe.style.height, clientWidth: iframe.clientWidth, clientHeight: iframe.clientHeight },
			scale: Number(/scale\(([^)]+)\)/.exec(frame.style.transform)?.[1] ?? Number.NaN),
			frame: box(document.querySelector('[data-canvas-frame-box]')!),
			stage: box(document.querySelector('[data-canvas-stage]')!),
			percent: document.querySelector('[data-zoom-percent]')!.textContent!.trim(),
			fitted: document.querySelector('[data-zoom-fit]')!.getAttribute('aria-pressed') === 'true',
		}
	})
}

async function waitForLivePreview(page: Page) {
	const frame = await previewFrame(page)
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	return frame
}

describe('Sign-in page (R12)', () => {
	it('treats a signed-out visitor as expected: no session probe, no console error', async () => {
		const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
		const page = await context.newPage()
		const errors: string[] = []
		const probes: string[] = []
		page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()) })
		page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/session') probes.push(request.method()) })
		try {
			await page.goto(`${server.origin}/login`, { waitUntil: 'networkidle' })
			await page.locator('main form').waitFor()
			expect(errors).toEqual([])
			expect(probes).toEqual([])
		}
		finally { await context.close() }
	}, 60_000)
})

describe('View canvas core (R4)', () => {
	for (const [windowWidth, windowHeight] of [[1920, 1080], [1024, 768], [390, 844]] as const) {
		it(`fits every Workspace viewport and scales only the frame in a ${windowWidth}×${windowHeight} window`, async () => {
			for (const [viewportId, [width, height]] of Object.entries(VIEWPORT_PRESETS)) {
				const { context, page } = await openWorkbench(`/views/${VIEW_ID}?viewport=${viewportId}`, { mode: 'light', width: windowWidth, height: windowHeight })
				try {
					await waitForLivePreview(page)
					await page.waitForTimeout(150)
					const fit = await canvasMetrics(page)
					// The iframe keeps the logical viewport size; only the outer frame scales.
					expect(fit.iframe, viewportId).toEqual({ styleWidth: `${width}px`, styleHeight: `${height}px`, clientWidth: width, clientHeight: height })
					expect(fit.fitted, viewportId).toBe(true)
					expect(fit.scale, viewportId).toBeGreaterThan(0)
					expect(fit.scale, viewportId).toBeLessThanOrEqual(1)
					expect(fit.frame.width, viewportId).toBeCloseTo(width * fit.scale, 0)
					expect(fit.frame.height, viewportId).toBeCloseTo(height * fit.scale, 0)
					expect(fit.percent, viewportId).toBe(`${Math.round(fit.scale * 100)}%`)
					// At Fit the whole frame is inside the stage, clear of the tool pill.
					expect(fit.frame.left, viewportId).toBeGreaterThanOrEqual(fit.stage.left + 11)
					expect(fit.frame.top, viewportId).toBeGreaterThanOrEqual(fit.stage.top + 11)
					expect(fit.frame.left + fit.frame.width, viewportId).toBeLessThanOrEqual(fit.stage.left + fit.stage.width - 11)
					expect(fit.frame.top + fit.frame.height, viewportId).toBeLessThanOrEqual(fit.stage.top + fit.stage.height - 60)

					// 100% from the zoom menu: the frame is the logical size, the stage scrolls.
					await page.locator('[data-zoom-percent]').click()
					await page.getByRole('menuitemcheckbox', { name: '100%' }).click()
					await page.waitForFunction(() => /scale\(1\)/.test(document.querySelector<HTMLElement>('[data-canvas-frame]')!.style.transform))
					const actual = await canvasMetrics(page)
					expect(actual.iframe.clientWidth, viewportId).toBe(width)
					expect(actual.frame.width, viewportId).toBeCloseTo(width, 0)
					expect(actual.fitted, viewportId).toBe(false)

					// Fit returns, and is remembered per View and viewport only for this session.
					await page.locator('[data-zoom-fit]').click()
					await page.waitForFunction(() => document.querySelector('[data-zoom-fit]')?.getAttribute('aria-pressed') === 'true')
					// Fit is pressed at once but the scale tweens back over animation frames; a fixed delay
					// read it mid-tween when frames were late (a loaded machine), so wait for it to land.
					await expect.poll(async () => (await canvasMetrics(page)).scale, { message: viewportId, timeout: 5_000 }).toBeCloseTo(fit.scale, 3)
				}
				finally { await context.close() }
			}
		}, 180_000)
	}

	it('never layers a transparent capture surface over the iframe', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?widget=btn-run-checks`, { mode: 'light', recordWire: true })
		try {
			await waitForLivePreview(page)
			await page.waitForSelector('[data-blueprint="type"]')
			const hits = await page.evaluate(() => {
				const frame = document.querySelector('[data-canvas-frame-box]')!.getBoundingClientRect()
				const result: string[] = []
				for (let i = 1; i < 20; i++) for (let j = 1; j < 20; j++) {
					const element = document.elementFromPoint(frame.left + frame.width * i / 20, frame.top + frame.height * j / 20)
					if (!element || element.closest('[data-blueprint], [role="toolbar"]')) continue
					result.push(element.tagName)
				}
				return result
			})
			expect(hits.length).toBeGreaterThan(300)
			expect(new Set(hits)).toEqual(new Set(['IFRAME']))
			// The overlay itself never takes input.
			expect(await page.evaluate(() => getComputedStyle(document.querySelector('[data-canvas-overlay]')!).pointerEvents)).toBe('none')
		}
		finally { await context.close() }
	}, 60_000)

	it('shares the selection between the Widget tree and the canvas', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			// Canvas → tree: the iframe hit-tests the click; the tree expands to and selects the Widget.
			await frame.click('[data-widget-id="btn-run-checks"]')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'btn-run-checks')
			await expect.poll(() => page.locator('[role="treeitem"][aria-selected="true"]').textContent()).toContain('btn-run-checks')
			await page.waitForFunction(() => document.querySelector('[data-blueprint="type"]')?.textContent?.includes('Button · #btn-run-checks'))
			expect(await page.locator('[data-blueprint="size"]').textContent()).toMatch(/^\d+ × \d+$/)

			// Tree → canvas: selecting a row highlights its Widget once the runtime reports it.
			await page.locator('[data-widget-row="mock-hero-title"]').scrollIntoViewIfNeeded()
			await page.locator('[data-widget-row="mock-hero-title"]').click()
			await page.waitForFunction(() => document.querySelector('[data-blueprint="type"]')?.textContent?.includes('#mock-hero-title'))
			expect(new URL(page.url()).searchParams.get('widget')).toBe('mock-hero-title')
		}
		finally { await context.close() }
	}, 60_000)

	it('keeps the selection across theme and locale changes and restores it after a Variant switch', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?widget=btn-run-checks`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			await page.waitForSelector('[data-blueprint="type"]')
			await frame.evaluate(() => { (window as unknown as { __sameDocument: boolean }).__sameDocument = true })

			await page.getByRole('combobox', { name: 'Preview theme' }).click()
			await page.getByRole('option', { name: 'Light' }).click()
			await frame.waitForFunction(() => document.querySelector('[data-preview-ready]')?.parentElement?.classList.contains('light'))
			await page.getByRole('combobox', { name: 'Locale' }).click()
			await page.getByRole('option', { name: /zh-TW/ }).click()
			await page.waitForFunction(() => new URL(location.href).searchParams.get('locale') === 'zh-TW')
			// Presentation changes keep the document (runtime state) and the selection.
			expect(await frame.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument)).toBe(true)
			expect(new URL(page.url()).searchParams.get('widget')).toBe('btn-run-checks')
			expect(await page.locator('[data-blueprint="type"]').textContent()).toContain('#btn-run-checks')

			// A Variant switch reopens geometry under the new runtime context and restores the selection.
			const requests = () => frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type === 'geometry.acquire.request'))
			const requestsBefore = (await requests()).length
			await page.locator('[data-context="variant"]').click()
			await page.getByRole('option', { name: 'compact' }).click()
			await page.waitForFunction(() => new URL(location.href).searchParams.get('variant') === 'compact')
			await expect.poll(async () => (await requests()).at(-1)?.context.variantId).toBe('compact')
			expect((await requests()).length).toBeGreaterThan(requestsBefore)
			await page.waitForSelector('[data-blueprint="type"]')
			expect(await page.locator('[data-blueprint="type"]').textContent()).toContain('#btn-run-checks')
			expect(new URL(page.url()).searchParams.get('widget')).toBe('btn-run-checks')
		}
		finally { await context.close() }
	}, 60_000)

	it('drives tools, zoom and tree walking from the keyboard', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light' })
		try {
			await waitForLivePreview(page)
			const pressed = (name: string) => page.getByRole('toolbar', { name: 'Canvas tools' }).getByRole('button', { name }).getAttribute('aria-pressed')
			await page.keyboard.press('i')
			await expect.poll(() => pressed('Interact')).toBe('true')
			await page.keyboard.press('v')
			await expect.poll(() => pressed('Select')).toBe('true')

			await page.keyboard.press('Shift+Digit0')
			await expect.poll(() => page.locator('[data-zoom-percent]').textContent()).toContain('100%')
			await page.keyboard.press('Shift+Digit1')
			await expect.poll(() => page.locator('[data-zoom-fit]').getAttribute('aria-pressed')).toBe('true')
			await page.keyboard.press('Control+Equal')
			await expect.poll(() => page.locator('[data-zoom-fit]').getAttribute('aria-pressed')).toBe('false')
			await page.keyboard.press('Control+Digit0')
			await expect.poll(() => page.locator('[data-zoom-fit]').getAttribute('aria-pressed')).toBe('true')

			await page.keyboard.press('Alt+ArrowDown')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'workbench-shell')
			await page.keyboard.press('Alt+ArrowDown')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'workbench-top-bar')
			await page.keyboard.press('Alt+ArrowRight')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'workbench-body-layout')
			await page.keyboard.press('Alt+ArrowUp')
			await page.waitForFunction(() => new URL(location.href).searchParams.get('widget') === 'workbench-shell')
		}
		finally { await context.close() }
	}, 60_000)
})

/** The selection outline's bounds in page px, and the Widget's rendered box mapped into the page. */
async function outlineAgainstWidget(page: Page, frame: Awaited<ReturnType<typeof previewFrame>>, widgetId: string) {
	const widget = await frame.evaluate((id) => {
		const r = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
		return { x: r.left, y: r.top, width: r.width, height: r.height, viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight } }
	}, widgetId)
	return page.evaluate((inner) => {
		const iframe = document.querySelector<HTMLIFrameElement>('[data-canvas-frame] iframe')!
		const box = iframe.getBoundingClientRect()
		const scale = box.width / iframe.offsetWidth
		const left = Math.max(0, inner.x)
		const top = Math.max(0, inner.y)
		const right = Math.min(inner.viewport.width, inner.x + inner.width)
		const bottom = Math.min(inner.viewport.height, inner.y + inner.height)
		const expected = { left: box.left + left * scale, top: box.top + top * scale, right: box.left + right * scale, bottom: box.top + bottom * scale }
		const paths = Array.from(document.querySelectorAll<SVGPathElement>('[data-overlay-selection] path.stroke-selection'))
		const rects = paths.map(path => path.getBoundingClientRect())
		const outline = rects.length
			? { left: Math.min(...rects.map(r => r.left)), top: Math.min(...rects.map(r => r.top)), right: Math.max(...rects.map(r => r.right)), bottom: Math.max(...rects.map(r => r.bottom)) }
			: undefined
		return { expected, outline }
	}, widget)
}

const geometryOf = (frame: Awaited<ReturnType<typeof previewFrame>>) => frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter((message: WireRecord) => message.type.startsWith('geometry.')))
const reportsOf = (page: Page) => page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter((message: WireRecord) => message.type === 'geometry.acquire.response'))

describe('Runtime geometry producer (multi-target streams)', () => {
	for (const mode of ['light', 'dark'] as const) {
		for (const [windowWidth, windowHeight] of [[1920, 1080], [1024, 768], [390, 844]] as const) {
			it(`draws the selection outline and blueprint label from the real producer at ${windowWidth}×${windowHeight} (${mode})`, async () => {
				const { context, page } = await openWorkbench(`/views/${VIEW_ID}?widget=btn-run-checks`, { mode, width: windowWidth, height: windowHeight, recordWire: true })
				try {
					const frame = await waitForLivePreview(page)
					await page.waitForFunction(() => document.querySelector('[data-blueprint="type"]')?.textContent?.includes('Button · #btn-run-checks'), undefined, { timeout: 15_000 })
					expect(await page.locator('[data-blueprint="size"]').textContent()).toMatch(/^\d+ × \d+$/)
					const { expected, outline } = await outlineAgainstWidget(page, frame, 'btn-run-checks')
					expect(outline).toBeDefined()
					for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(Math.abs(outline![side] - expected[side]), side).toBeLessThan(1.5)
					// The legacy in-iframe highlight is gone: the View document is never restyled.
					expect(await frame.evaluate(() => ({
						marked: document.querySelectorAll('[data-preview-highlighted]').length,
						outline: getComputedStyle(document.querySelector('[data-widget-id="btn-run-checks"]')!).outlineStyle,
					}))).toEqual({ marked: 0, outline: 'none' })
					// The runtime declared the optional multi-target feature, and each report is complete and small.
					const reports = await reportsOf(page)
					expect(reports.length).toBeGreaterThan(0)
					expect(reports.every(report => typeof report.context.geometryRevision === 'number' && 'rect' in report.payload && 'regions' in report.payload)).toBe(true)
					expect(Math.max(...reports.map(report => JSON.stringify(report).length))).toBeLessThan(2048)
				}
				finally { await context.close() }
			}, 60_000)
		}
	}

	it('declares geometry.multi-target and keeps one stream per Widget, releasing the old selection', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?widget=btn-run-checks`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			await page.waitForSelector('[data-blueprint="type"]')
			const declaration = await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.find((message: WireRecord) => message.type === 'capability.declare'))
			// `widget.events` ships with the mount factory (Widget Event reporting, decision 10); protocolVersion stays 1.
			expect(declaration?.payload).toEqual({ protocolVersion: 1, features: ['geometry', 'geometry.multi-target', 'widget.events'] })
			await page.locator('[data-widget-row="mock-hero-title"]').scrollIntoViewIfNeeded()
			await page.locator('[data-widget-row="mock-hero-title"]').click()
			await page.waitForFunction(() => document.querySelector('[data-blueprint="type"]')?.textContent?.includes('#mock-hero-title'))
			const messages = await geometryOf(frame)
			const firstRequest = messages.find(message => message.type === 'geometry.acquire.request' && message.context.widgetId === 'btn-run-checks')!
			expect(firstRequest).toBeDefined()
			expect(messages).toContainEqual(expect.objectContaining({ type: 'geometry.release', context: expect.objectContaining({ widgetId: 'btn-run-checks' }) }))
			const ids = messages.filter(message => message.type === 'geometry.acquire.request').map(message => message.context.navigationRequestId)
			expect(new Set(ids).size).toBe(ids.length)
		}
		finally { await context.close() }
	}, 60_000)

	it('draws the runtime hover candidate: Iris in Select, dashed Marker in Comment, none in Interact', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			await frame.locator('[data-widget-id="mock-hero-title"]').hover()
			await page.waitForSelector('[data-overlay-hover][data-hover-purpose="inspection"]', { timeout: 10_000 })
			expect(await page.locator('[data-hover-chip]').textContent()).toBe('Text')
			// The hover outline follows the candidate's own geometry stream.
			expect(await geometryOf(frame)).toContainEqual(expect.objectContaining({ type: 'geometry.acquire.request', context: expect.objectContaining({ widgetId: 'mock-hero-title' }) }))
			// Hover never restyles the View and never becomes the selection.
			expect(await frame.evaluate(() => document.querySelectorAll('[data-preview-highlighted]').length)).toBe(0)
			expect(new URL(page.url()).searchParams.get('widget')).not.toBe('mock-hero-title')

			await page.keyboard.press('c')
			await frame.locator('[data-widget-id="btn-run-checks"]').hover()
			await page.waitForSelector('[data-overlay-hover][data-hover-purpose="comment-range"]', { timeout: 10_000 })
			expect(await page.locator('[data-hover-chip]').textContent()).toBe('Comment on Button')
			expect(await page.locator('[data-overlay-hover] path').first().getAttribute('stroke-dasharray')).toBe('4 3')
			// The hover report travels in the protocol envelope with session, generation and interaction identity.
			const hover = (await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.targeting)).filter(message => message.type === 'targeting.hover').at(-1)!
			expect(hover).toMatchObject({
				context: { widgetId: 'btn-run-checks', previewSessionId: expect.any(String), runtimeGenerationId: expect.any(String), viewId: VIEW_ID },
				payload: { targetingInteractionId: expect.any(String) },
			})

			await page.keyboard.press('Escape')
			await page.keyboard.press('i')
			await frame.locator('[data-widget-id="mock-hero-title"]').hover()
			await page.waitForTimeout(300)
			expect(await page.locator('[data-overlay-hover]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('re-reports on scroll inside the View, then stays silent: no frames and no messages while idle', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?viewport=mobile&widget=metric-card-targeting`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			await page.waitForSelector('[data-blueprint="type"]')
			const before = await outlineAgainstWidget(page, frame, 'metric-card-targeting')
			const revisionsBefore = (await reportsOf(page)).length
			await frame.evaluate(() => window.scrollBy(0, 120))
			await expect.poll(async () => (await reportsOf(page)).length).toBeGreaterThan(revisionsBefore)
			await page.waitForTimeout(300)
			const after = await outlineAgainstWidget(page, frame, 'metric-card-targeting')
			expect(after.outline).toBeDefined()
			expect(Math.abs(after.outline!.top - after.expected.top)).toBeLessThan(1.5)
			expect(after.outline!.top).toBeLessThan(before.outline!.top - 10)
			const reports = await reportsOf(page)
			const revisions = reports.filter(report => report.context.widgetId === 'metric-card-targeting').map(report => report.context.geometryRevision as number)
			expect(revisions).toEqual([...revisions].sort((a, b) => a - b))

			// Idle: the runtime requests no animation frame and sends no message while nothing changes.
			await page.mouse.move(5, 5)
			await page.waitForTimeout(500)
			const snapshot = async () => ({
				runtimeFrames: await frame.evaluate(() => (window as unknown as WireRecorderWindow).__rafCallbacks),
				runtimeReceived: (await geometryOf(frame)).length,
				workbenchReceived: (await reportsOf(page)).length,
			})
			const idleStart = await snapshot()
			await page.waitForTimeout(1500)
			expect(await snapshot()).toEqual(idleStart)

			// A Widget without a rendered box at this viewport keeps its stream: zero-area rect, no regions.
			await page.locator('[data-widget-row="workspace-tag"]').scrollIntoViewIfNeeded()
			await page.locator('[data-widget-row="workspace-tag"]').click()
			await expect.poll(async () => (await reportsOf(page)).filter(report => report.context.widgetId === 'workspace-tag').at(-1)?.payload)
				.toMatchObject({ rect: { width: 0, height: 0 }, regions: [] })
			expect(await page.locator('[data-overlay-selection]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('shows no overlay and runs no Workbench frame loop while the RootShell is selected and idle', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light', recordWire: true })
		try {
			await waitForLivePreview(page)
			await page.mouse.move(5, 5)
			await page.waitForTimeout(800)
			const start = await page.evaluate(() => (window as unknown as WireRecorderWindow).__rafCallbacks)
			await page.waitForTimeout(1000)
			expect(await page.evaluate(() => (window as unknown as WireRecorderWindow).__rafCallbacks)).toBe(start)
			expect(await page.locator('[data-overlay-selection]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)
})

/** The screen point of an inner-viewport point of the Preview (the frame scales; the iframe keeps its logical size). */
async function screenPoint(page: Page, frame: Awaited<ReturnType<typeof previewFrame>>, inner: { x: number; y: number }) {
	const box = (await page.locator('iframe[src*="/preview"]').boundingBox())!
	const width = await frame.evaluate(() => window.innerWidth)
	const scale = box.width / width
	return { x: box.x + inner.x * scale, y: box.y + inner.y * scale, scale }
}

async function widgetRect(frame: Awaited<ReturnType<typeof previewFrame>>, widgetId: string) {
	return frame.evaluate((id) => {
		const rect = document.querySelector(`[data-widget-id="${id}"]`)!.getBoundingClientRect()
		return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
	}, widgetId)
}

/** The bottom-left tip of a pin: the exact anchor point (DESIGN.md "Comment pin"). */
async function pinTip(page: Page, threadId: string) {
	const box = (await page.locator(`[data-pin-thread="${threadId}"]`).boundingBox())!
	return { x: box.x, y: box.y + box.height }
}

async function api<T>(path: string, body?: unknown): Promise<T> {
	const response = await fetch(`${server.origin}${path}`, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { ...server.headers, 'content-type': 'application/json' },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`)
	return await response.json() as T
}

/** Seeds a thread through the Review authoring API (never by hand). */
async function seedThread(widgetId: string, message: string): Promise<string> {
	const created = await api<{ key: string; revision: string }>('/api/reviews', { anchor: { viewId: VIEW_ID, widgetId } })
	await api(`/api/reviews/${created.key}/messages`, { expectedRevision: created.revision, body: message })
	return created.key
}

describe('Canvas comments (R6 targeting and composer, R7a pins and bubble)', () => {
	it('comments with C, a click and Ctrl+Enter at the click point, keeps the pin there after reload, replies, resolves and filters', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light' })
		try {
			const frame = await waitForLivePreview(page)
			const posts: { url: string; body: Record<string, unknown> }[] = []
			page.on('request', (request) => {
				if (request.method() === 'POST' && new URL(request.url()).pathname.startsWith('/api/reviews'))
					posts.push({ url: new URL(request.url()).pathname, body: JSON.parse(request.postData() ?? '{}') as Record<string, unknown> })
			})

			// 1–2. C enters Comment mode; hovering a Widget names it.
			await page.keyboard.press('c')
			await frame.locator('[data-widget-id="btn-run-checks"]').hover()
			await page.waitForSelector('[data-overlay-hover][data-hover-purpose="comment-range"]', { timeout: 10_000 })
			expect(await page.locator('[data-hover-chip]').textContent()).toBe('Comment on Button')

			// 3. A click at a specific offset inside the Widget drops the pending pin and the composer there.
			const rect = await widgetRect(frame, 'btn-run-checks')
			const offset = { x: 0.3, y: 0.6 }
			const click = await screenPoint(page, frame, { x: rect.x + offset.x * rect.width, y: rect.y + offset.y * rect.height })
			// The click point the View actually received (input coordinates are rounded to device pixels).
			await frame.evaluate(() => {
				window.addEventListener('click', (event) => { (window as unknown as { __click: { x: number; y: number } }).__click = { x: event.clientX, y: event.clientY } }, { capture: true, once: true })
			})
			await page.mouse.click(click.x, click.y)
			const received = await frame.evaluate(() => (window as unknown as { __click: { x: number; y: number } }).__click)
			const clicked = { x: (received.x - rect.x) / rect.width, y: (received.y - rect.y) / rect.height }
			expect(Math.abs(clicked.x - offset.x)).toBeLessThan(0.02)
			expect(Math.abs(clicked.y - offset.y)).toBeLessThan(0.05)
			await page.waitForSelector('[data-comment-composer]', { timeout: 10_000 })
			const pending = await pinTip(page, 'pending')
			expect(Math.abs(pending.x - click.x)).toBeLessThan(2)
			expect(Math.abs(pending.y - click.y)).toBeLessThan(2)
			// The composer has focus: no other dialog, no form page.
			expect(await page.evaluate(() => document.activeElement?.hasAttribute('data-composer-text'))).toBe(true)
			await page.keyboard.type('Label should say Pay now')
			await page.keyboard.press('Control+Enter')
			await page.waitForSelector('[data-thread-bubble]', { timeout: 10_000 })

			// The persisted thread is the accepted model only: anchor, scope and the normalized hint; never an actor or raw px.
			const create = posts.find(post => post.url === '/api/reviews')!
			expect(Object.keys(create.body).sort()).toEqual(['anchor', 'displayHint', 'variantNames'])
			expect(create.body.anchor).toEqual({ viewId: VIEW_ID, widgetId: 'btn-run-checks' })
			expect(create.body.variantNames).toEqual([])
			const hint = (create.body.displayHint as { pin: { x: number; y: number } }).pin
			expect(Math.abs(hint.x - clicked.x)).toBeLessThan(1e-3)
			expect(Math.abs(hint.y - clicked.y)).toBeLessThan(1e-3)
			const message = posts.find(post => post.url.endsWith('/messages'))!
			expect(Object.keys(message.body).sort()).toEqual(['body', 'expectedRevision'])
			const threadId = message.url.split('/')[3]!
			const stored = await api<{ resource: { displayHint: { pin: { x: number; y: number } }; messages: { actor: { displayName?: string } }[] } }>(`/api/resources/review/${threadId}`)
			expect(Math.abs(stored.resource.displayHint.pin.x - clicked.x)).toBeLessThan(1e-3)
			expect(Math.abs(stored.resource.displayHint.pin.y - clicked.y)).toBeLessThan(1e-3)
			expect(stored.resource.messages[0]!.actor.displayName).toBe('tester')
			// The tool stays in Comment mode after commenting (Figma).
			expect(await page.locator('[role="toolbar"] button[aria-pressed="true"]').textContent()).toContain('Comment')

			// 4. After a reload the pin renders at the same spot, within 2px.
			await page.reload({ waitUntil: 'networkidle' })
			const reloaded = await waitForLivePreview(page)
			await page.waitForSelector(`[data-pin-thread="${threadId}"]`, { timeout: 15_000 })
			const after = await pinTip(page, threadId)
			const expectedTip = await screenPoint(page, reloaded, received)
			expect(Math.abs(after.x - expectedTip.x)).toBeLessThan(2)
			expect(Math.abs(after.y - expectedTip.y)).toBeLessThan(2)
			// No transparent layer over the iframe: away from the pin (and its bubble, on the right), the frame itself is hit.
			expect(await page.evaluate(([x, y]) => document.elementFromPoint(x!, y!)?.tagName, [expectedTip.x - 24, expectedTip.y + 16])).toBe('IFRAME')

			// 5. Reply from the bubble. The open thread rides in the URL, so the reload reopened it; a pin click toggles it.
			expect(new URL(page.url()).searchParams.get('thread')).toBe(threadId)
			await page.waitForSelector('[data-thread-bubble]')
			await page.locator(`[data-pin-thread="${threadId}"]`).click()
			await expect.poll(() => page.locator('[data-thread-bubble]').count()).toBe(0)
			await page.locator(`[data-pin-thread="${threadId}"]`).click()
			await page.waitForSelector('[data-thread-bubble]')
			await page.locator('textarea[data-thread-reply]').fill('Agreed, updating it.')
			await page.keyboard.press('Control+Enter')
			await expect.poll(() => page.locator('[data-timeline-kind="message"]').count(), { timeout: 10_000 }).toBe(2)

			// 6. One click on Resolve closes an open thread as answered.
			posts.length = 0
			await page.locator('[data-thread-resolve]').click()
			await expect.poll(() => posts.find(post => post.url.endsWith('/resolve'))?.body, { timeout: 10_000 })
				.toMatchObject({ resolution: 'answered', expectedRevision: expect.any(String) })
			expect(posts.find(post => post.url.endsWith('/resolve'))!.body).not.toHaveProperty('submissionId')

			// 7. The default filter hides resolved threads; turning Resolved on shows the graphite pin.
			await expect.poll(() => page.locator(`[data-pin-thread="${threadId}"]`).count(), { timeout: 10_000 }).toBe(0)
			await page.locator('[data-comment-filter="resolved"]').click()
			await page.waitForSelector(`[data-pin-thread="${threadId}"][data-pin-variant="resolved"]`, { timeout: 10_000 })
			await page.locator('[data-comment-filter="resolved"]').click()
			await expect.poll(() => page.locator(`[data-pin-thread="${threadId}"]`).count()).toBe(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('lists a thread whose Widget was deleted in the unplaced tray and never draws its pin', async () => {
		const threadId = await seedThread('promo-banner-removed', 'Is the promo banner gone on purpose?')
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light' })
		try {
			await waitForLivePreview(page)
			const tray = page.locator('[data-comment-tray]')
			await tray.waitFor({ timeout: 15_000 })
			expect(await tray.textContent()).toContain('1 comment can\'t be placed')
			expect(await page.locator(`[data-pin-thread="${threadId}"]`).count()).toBe(0)
			expect(await page.locator(`[data-comment-group="unplaced"] [data-comment-row="${threadId}"]`).count()).toBe(1)
			await tray.click()
			await page.waitForSelector('[data-thread-bubble] [data-thread-missing]', { timeout: 10_000 })
			await page.locator('[data-thread-close]').click()
			// Resolve it so later checks see a clean View.
			const read = await api<{ revision: string }>(`/api/resources/review/${threadId}`)
			await api(`/api/reviews/${threadId}/resolve`, { expectedRevision: read.revision, resolution: 'obsolete' })
		}
		finally { await context.close() }
	}, 60_000)

	it('shows an edge indicator for a Widget scrolled out of the View and opens its thread without scrolling the iframe', async () => {
		const threadId = await seedThread('spec-pill-badge', 'Badge contrast looks low.')
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}?viewport=mobile`, { mode: 'light' })
		try {
			const frame = await waitForLivePreview(page)
			const edge = page.locator(`[data-edge-threads~="${threadId}"]`)
			await edge.waitFor({ timeout: 15_000 })
			expect(await edge.getAttribute('data-edge-side')).toBe('bottom')
			expect(await page.locator(`.pin-anchor:not([hidden]) [data-pin-thread="${threadId}"]`).count()).toBe(0)
			await edge.click()
			await page.waitForSelector('[data-thread-bubble]', { timeout: 10_000 })
			expect(await page.locator('[data-thread-placement]').textContent()).toContain('Scrolled out of view')
			expect(await frame.evaluate(() => window.scrollY)).toBe(0)
			const read = await api<{ revision: string }>(`/api/resources/review/${threadId}`)
			await api(`/api/reviews/${threadId}/resolve`, { expectedRevision: read.revision, resolution: 'answered' })
		}
		finally { await context.close() }
	}, 60_000)

	it('gives the Viewer role a disabled comment tool that says why', async () => {
		const token = await provisionToken(server.workspaceRoot, { nickname: 'viewer', kind: 'human', role: 'viewer' })
		const cookie = await sessionCookieFor(server.origin, token)
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light', cookie })
		try {
			const frame = await waitForLivePreview(page)
			const tools = await page.locator('[role="toolbar"] button').allTextContents()
			expect(tools.some(text => text.includes('Select'))).toBe(true)
			// Never silently missing (review feedback 8dd59d25): present, aria-disabled, with the reason.
			const comment = page.locator('[role="toolbar"] [data-tool="comment"]')
			expect(await comment.getAttribute('aria-disabled')).toBe('true')
			expect(await comment.getAttribute('aria-description')).toContain('Reviewer role')
			await page.keyboard.press('c')
			// The key says why, in a toast, instead of doing nothing.
			await expect.poll(() => page.locator('li', { hasText: 'commenting requires the Reviewer role' }).count()).toBeGreaterThan(0)
			await frame.locator('[data-widget-id="btn-run-checks"]').hover()
			await page.waitForTimeout(400)
			expect(await page.locator('[data-overlay-hover][data-hover-purpose="comment-range"]').count()).toBe(0)
			expect(await page.locator('[data-comment-composer]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('rejects legacy, incomplete and superseded targeting messages', async () => {
		const { context, page } = await openWorkbench(`/views/${VIEW_ID}`, { mode: 'light', recordWire: true })
		try {
			const frame = await waitForLivePreview(page)
			await page.keyboard.press('c')
			const enter = async () => {
				await expect.poll(async () => (await frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.targeting))
					.filter(message => message.type === 'targeting.enter' && message.payload.purpose === 'comment-range').length).toBeGreaterThan(0)
				return (await frame.evaluate(() => (window as unknown as WireRecorderWindow).__wire.targeting)).filter(message => message.type === 'targeting.enter').at(-1)!
			}
			const superseded = await enter()
			// Leave and re-enter Comment mode: the earlier interaction is superseded.
			await page.keyboard.press('Escape')
			await page.keyboard.press('c')
			await expect.poll(async () => (await enter()).payload.targetingInteractionId).not.toBe(superseded.payload.targetingInteractionId)
			const context_ = superseded.context
			const forged = [
				// The retired ad hoc channel.
				{ channel: 'uiux:preview:targeting', payload: { type: 'select', widgetId: 'btn-run-checks', viewId: VIEW_ID } },
				// No targetingInteractionId.
				{ channel: 'uiux:preview:wire', message: { type: 'targeting.select', context: { ...context_, widgetId: 'btn-run-checks' }, payload: {} } },
				// No session identity.
				{ channel: 'uiux:preview:wire', message: { type: 'targeting.select', context: { runtimeGenerationId: context_.runtimeGenerationId, viewId: VIEW_ID, widgetId: 'btn-run-checks' }, payload: { targetingInteractionId: superseded.payload.targetingInteractionId } } },
				// A late event of the superseded interaction.
				{ channel: 'uiux:preview:wire', message: { type: 'targeting.select', context: { ...context_, widgetId: 'btn-run-checks' }, payload: { targetingInteractionId: superseded.payload.targetingInteractionId, point: { x: 10, y: 10 } } } },
				{ channel: 'uiux:preview:wire', message: { type: 'targeting.escape', context: context_, payload: { targetingInteractionId: superseded.payload.targetingInteractionId } } },
			]
			await frame.evaluate((messages) => { for (const message of messages) window.parent.postMessage(message, window.location.origin) }, forged)
			// The same well-formed message from the Workbench document itself fails the source check.
			const current = await enter()
			await page.evaluate((message) => { window.postMessage({ channel: 'uiux:preview:wire', message }, window.location.origin) }, { type: 'targeting.select', context: { ...current.context, widgetId: 'btn-run-checks' }, payload: { targetingInteractionId: current.payload.targetingInteractionId, point: { x: 10, y: 10 } } })
			await page.waitForTimeout(600)
			expect(await page.locator('[data-comment-composer]').count()).toBe(0)
			expect(await page.locator('[role="toolbar"] button[aria-pressed="true"]').textContent()).toContain('Comment')
			// The Interact tool holds no interaction: View clicks never cross the boundary.
			await page.keyboard.press('Escape')
			await page.keyboard.press('i')
			const before = (await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.targeting)).length
			await frame.locator('[data-widget-id="btn-run-checks"]').click()
			await page.waitForTimeout(400)
			expect((await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.targeting)).slice(before).filter(message => message.type === 'targeting.select')).toEqual([])
		}
		finally { await context.close() }
	}, 60_000)
})
