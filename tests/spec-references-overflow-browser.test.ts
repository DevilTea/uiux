import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Issue #405: the Spec editor's References editor (the View page's right panel, Spec tab) fits the
 * panel width, with no horizontal clipping, for an external and a View reference at the panel's
 * default width (340px).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

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

describe('Spec editor References (issue #405)', () => {
	it('keeps every field of a reference row inside the right panel at 340px', async () => {
		const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
		await context.addInitScript(() => {
			localStorage.setItem('nuxt-color-mode', 'light')
			localStorage.setItem('uiux.workbench.locale', 'en-US')
			localStorage.setItem('uiux.workbench.rightPanelHidden', '0')
		})
		await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
		const page = await context.newPage()
		try {
			await page.goto(`${server.origin}/views/${VIEW_ID}?panel=spec`, { waitUntil: 'networkidle' })
			const section = page.locator('[data-spec-section="references"]')
			await section.locator('[data-spec-edit]').click()
			await section.getByRole('button', { name: 'Add reference' }).click()
			await section.locator('[data-reference-row]').first().waitFor()

			const panel = page.locator('aside[data-landmark="complementary"]')
			const panelWidth = await panel.evaluate(element => element.getBoundingClientRect().width)
			expect(panelWidth).toBeGreaterThan(0)
			expect(panelWidth).toBeLessThanOrEqual(340)

			// Every row, of either type, is checked: a Link reference and a View reference.
			await section.getByRole('button', { name: 'Add reference' }).click()
			const second = section.locator('[data-reference-row]').nth(1)
			await second.getByRole('combobox').first().click()
			await page.getByRole('option', { name: 'View', exact: true }).click()
			await second.getByRole('combobox').nth(1).waitFor()

			const measured = await section.evaluate((element) => {
				const aside = element.closest('aside')!.getBoundingClientRect()
				const outside: string[] = []
				const narrow: string[] = []
				for (const row of element.querySelectorAll<HTMLElement>('[data-reference-row]')) {
					const controls = [...row.querySelectorAll<HTMLElement>('input, button, [role="combobox"]')]
					for (const control of controls) {
						const box = control.getBoundingClientRect()
						if (box.left < aside.left - 0.5 || box.right > aside.right + 0.5) outside.push(`${control.tagName} ${Math.round(box.left)}-${Math.round(box.right)} outside ${Math.round(aside.left)}-${Math.round(aside.right)}`)
					}
					// The text fields and the View select (not the Type select, the first control) take the row's width.
					for (const control of controls.slice(1).filter(node => node.tagName === 'INPUT' || node.getAttribute('role') === 'combobox')) {
						const width = control.getBoundingClientRect().width
						if (width < 240) narrow.push(`${control.getAttribute('type') ?? control.getAttribute('role') ?? control.tagName}: ${Math.round(width)}px`)
					}
				}
				// Containers that clip or scroll a row sideways (inputs scroll their own text).
				const chain = [...element.querySelectorAll<HTMLElement>('*'), element]
				for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) chain.push(node)
				const sideways = chain
					.filter(node => !['INPUT', 'TEXTAREA'].includes(node.tagName) && !node.classList.contains('sr-only') && node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX !== 'visible')
					.map(node => `${node.tagName}.${String(node.className).slice(0, 60)}`)
				return { outside, narrow, sideways }
			})
			expect(measured.outside).toEqual([])
			expect(measured.sideways).toEqual([])
			// The fields stack instead of sharing a line: each is nearly as wide as the panel (340px less its padding).
			expect(measured.narrow).toEqual([])
		}
		finally { await context.close() }
	}, 60_000)
})
