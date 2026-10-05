import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { composite, contrastRatio, parseCssColor } from './support/color'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Browser checks against the built Workbench (`pnpm build` output) serving a copy of the
 * dogfood `design/` Workspace. They cover the DESIGN.md token, type and focus contracts and
 * the independence of the Workbench chrome from the Preview render context.
 */

const MAIN_ROUTES = ['/']

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

type ChromeSetup = Readonly<{ mode: 'light' | 'dark'; os?: 'light' | 'dark'; locale?: 'en-US' | 'zh-TW'; width?: number; height?: number }>

async function openWorkbench(path: string, setup: ChromeSetup): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: setup.os ?? setup.mode,
	})
	await context.addInitScript(([mode, locale]) => {
		localStorage.setItem('nuxt-color-mode', mode)
		localStorage.setItem('uiux.workbench.locale', locale)
	}, [setup.mode, setup.locale ?? 'en-US'] as const)
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.waitForFunction(() => document.documentElement.classList.contains('light') || document.documentElement.classList.contains('dark'))
	return { context, page }
}

async function previewFrame(page: Page) {
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
			const { context, page } = await openWorkbench('/', { mode, os })
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
