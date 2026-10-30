import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

import enUS from '../app/i18n/locales/en-US.json'
import zhTW from '../app/i18n/locales/zh-TW.json'

/**
 * Issue #408: the Workbench preferences menu shows each group's description once (as visible text,
 * the label of its group) and never clips it at the menu edge, in both chrome languages.
 */

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

const CASES = [
	{ locale: 'en-US', prefs: enUS.prefs },
	{ locale: 'zh-TW', prefs: zhTW.prefs },
] as const

describe('Workbench preferences menu (issue #408)', () => {
	for (const { locale, prefs } of CASES) {
		it(`shows each group description once and unclipped in ${locale}`, async () => {
			const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' })
			await context.addInitScript((chosen) => {
				localStorage.setItem('nuxt-color-mode', 'dark')
				localStorage.setItem('uiux.workbench.locale', chosen)
			}, locale)
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const page = await context.newPage()
			try {
				await page.goto(`${server.origin}/`, { waitUntil: 'networkidle' })
				await page.getByRole('button', { name: prefs.title }).click()
				const menu = page.getByRole('menu')
				await menu.waitFor()

				for (const text of [prefs.themeHint, prefs.languageHint])
					expect(await menu.getByText(text, { exact: true }).count(), text).toBe(1)

				const bounds = await menu.evaluate((element) => {
					const box = element.getBoundingClientRect()
					const clipped: string[] = []
					for (const node of element.querySelectorAll<HTMLElement>('[data-slot="label"], [data-slot="label"] *, [role="menuitemcheckbox"]')) {
						const rect = node.getBoundingClientRect()
						if (rect.width === 0) continue
						if (node.scrollWidth > node.clientWidth + 1 || rect.right > box.right + 0.5 || rect.left < box.left - 0.5) clipped.push(`${node.tagName}.${String(node.className).slice(0, 40)}: ${node.textContent?.trim().slice(0, 30)}`)
					}
					// A text line cut at the menu's edge: the visible text of each hint ends inside the menu.
					for (const node of element.querySelectorAll<HTMLElement>('[data-slot="itemDescription"]')) {
						const range = document.createRange()
						range.selectNodeContents(node)
						for (const rect of range.getClientRects()) {
							if (rect.right > box.right - 1) clipped.push(`description text reaches the menu edge: ${node.textContent?.trim().slice(0, 30)}`)
						}
					}
					return clipped
				})
				expect(bounds).toEqual([])

				// The description is visible text of the group label and is not repeated anywhere in the menu (no second copy for assistive technology either).
				const accessible = await menu.evaluate(element => element.textContent ?? '')
				expect(accessible.split(prefs.languageHint).length - 1).toBe(1)
				expect(accessible.split(prefs.themeHint).length - 1).toBe(1)
			}
			finally { await context.close() }
		}, 60_000)
	}
})
