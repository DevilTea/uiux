import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * The inline Preview diagnostic and Retry Preview (issue #111) against the built Workbench. A test
 * shim in the Workbench page rewrites the first capability declaration to an unsupported protocol
 * version, forcing a capability failure (Clause 01a11687-4114-728a-9d58-d69eaf786e5d), and can hold
 * the next declaration so the retry's handshake stays open while the test looks at the action.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const WIDGET_ID = 'btn-run-checks'

type DeclarationShim = { incompatible: number; hold: boolean; held: unknown[]; rewritten: string[] }
type ShimWindow = Window & { __declarationShim: DeclarationShim; __releaseDeclarations: () => void }

/**
 * Runs in the Workbench page before any of its scripts, ahead of the wire recorder: a capturing
 * listener sees each Preview post first. It replaces a declaration post with a rewritten copy, or
 * holds it, and stops the original from reaching the Workbench. A re-dispatched copy keeps the
 * Preview window as its source, so the Workbench's peer checks still apply to it.
 */
const DECLARATION_SHIM = `(() => {
	if (window.top !== window) return
	const shim = window.__declarationShim = { incompatible: 1, hold: false, held: [], rewritten: [] }
	const replayed = new WeakSet()
	const replay = (data, origin, source) => {
		const event = new MessageEvent('message', { data, origin, source })
		replayed.add(event)
		window.dispatchEvent(event)
	}
	window.__releaseDeclarations = () => {
		shim.hold = false
		for (const post of shim.held.splice(0)) replay(post.data, post.origin, post.source)
	}
	window.addEventListener('message', (event) => {
		const data = event.data
		if (replayed.has(event) || !data || data.channel !== 'uiux:preview:wire') return
		const messages = Array.isArray(data.messages) ? data.messages : [data.message]
		if (!messages.some(message => message && message.type === 'capability.declare')) return
		event.stopImmediatePropagation()
		if (shim.incompatible > 0) {
			shim.incompatible--
			const rewrite = message => message && message.type === 'capability.declare'
				? (shim.rewritten.push(message.context.runtimeGenerationId), { ...message, payload: { ...message.payload, protocolVersion: 2 } })
				: message
			replay(Array.isArray(data.messages) ? { ...data, messages: data.messages.map(rewrite) } : { ...data, message: rewrite(data.message) }, event.origin, event.source)
		}
		else if (shim.hold) shim.held.push({ data, origin: event.origin, source: event.source })
		else replay(data, event.origin, event.source)
	}, true)
})()`

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

async function open(path: string): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(DECLARATION_SHIM)
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const iframe = (page: Page) => page.locator('iframe[src*="/preview"]')
const documentParam = async (page: Page) => new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('document')
const shim = (page: Page) => page.evaluate(() => {
	const { incompatible, hold, held, rewritten } = (window as unknown as ShimWindow).__declarationShim
	return { incompatible, hold, held: held.length, rewritten: [...rewritten] }
})

describe('Inline Preview diagnostic and Retry Preview (issue #111)', () => {
	it('shows a capability failure inline, and Retry Preview recovers through one explicit retry', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			// The forced capability failure: the session stays, Preview stops, and the diagnostic appears.
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			await expect.poll(async () => (await shim(page)).rewritten.length).toBe(1)
			const failedGeneration = (await shim(page)).rewritten[0]!
			expect(await diagnostic.getAttribute('data-category')).toBe('capability')
			expect(await diagnostic.getAttribute('data-reason')).toBe('capability.unsupported_protocol_version')
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')
			// Title from the category, body from the reason; announced once, never modal.
			const alert = diagnostic.getByRole('alert')
			expect(await alert.locator('[data-preview-failure-title]').textContent()).toContain('Preview is not compatible')
			expect(await alert.locator('[data-preview-failure-body]').textContent()).toContain('protocol version this Workbench does not support')
			expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0)

			// The reason and the correlation identities are in the collapsed details only.
			const reason = diagnostic.locator('[data-preview-failure-reason]')
			expect(await reason.isVisible()).toBe(false)
			expect(await diagnostic.textContent()).not.toContain('capability.unsupported_protocol_version')
			await diagnostic.getByRole('button', { name: 'Technical details' }).click()
			await reason.waitFor({ state: 'visible' })
			expect((await reason.textContent())?.trim()).toBe('capability.unsupported_protocol_version')
			const sessionId = new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session')
			expect((await diagnostic.locator('[data-preview-failure-identity="previewSessionId"]').textContent())?.trim()).toBe(sessionId)
			expect((await diagnostic.locator('[data-preview-failure-identity="runtimeGenerationId"]').textContent())?.trim()).toBe(failedGeneration)
			expect(await diagnostic.textContent()).not.toMatch(/\bat \S+:\d+|Error:|stack/i)

			// Retry Preview, from the keyboard. The retry's declaration is held, so its handshake stays open.
			await page.evaluate(() => { (window as unknown as ShimWindow).__declarationShim.hold = true } )
			const before = Number(await documentParam(page))
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await retry.focus()
			expect(await retry.evaluate(element => element === document.activeElement)).toBe(true)
			await page.keyboard.press('Enter')
			await expect.poll(() => documentParam(page)).toBe(String(before + 1))
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)

			// While that retry's generation is in its handshake the action is disabled but stays
			// focusable, the diagnostic stays, and another press (here or on the chip) loads nothing.
			expect(await retry.getAttribute('aria-disabled')).toBe('true')
			expect(await retry.evaluate(element => element === document.activeElement)).toBe(true)
			expect(await diagnostic.getByRole('status').textContent()).toContain('Starting a fresh preview')
			await retry.click({ force: true })
			await page.keyboard.press('Enter')
			await page.locator('[data-session-status]').click()
			const chipRetry = page.locator('[data-session-retry]')
			expect(await chipRetry.getAttribute('aria-disabled')).toBe('true')
			await chipRetry.click({ force: true })
			await page.keyboard.press('Escape')
			expect(await documentParam(page)).toBe(String(before + 1))
			expect((await shim(page)).held).toBe(1)

			// The held declaration arrives: recovery is exhausted, so only the explicit retry admits it.
			await page.evaluate(() => (window as unknown as ShimWindow).__releaseDeclarations())
			await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
			const recovered = await iframe(page).getAttribute('data-runtime-generation')
			expect(recovered).toMatch(/^gen-[0-9a-f]{32}$/)
			expect(recovered).not.toBe(failedGeneration)
			await diagnostic.waitFor({ state: 'detached' })
			const frame = await (await iframe(page).elementHandle())!.contentFrame()
			const acks = (await frame!.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages))
				.filter(message => message.type === 'capability.ack')
			expect(acks.map(message => message.context.runtimeGenerationId)).toEqual([recovered])
			expect(await documentParam(page)).toBe(String(before + 1))
		}
		finally { await context.close() }
	}, 90_000)
})
