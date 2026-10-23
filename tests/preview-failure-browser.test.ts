import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { RETRY_STALL_GRACE_MS } from '../src/preview/failure-diagnostic'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * The inline Preview diagnostic and Retry Preview (issue #111; owner rulings of 2026-10-23,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19138451) against the built
 * Workbench. A test shim in the Workbench page can rewrite capability declarations to an
 * unsupported protocol version, forcing a capability failure (Clause
 * 01a11687-4114-728a-9d58-d69eaf786e5d), and can hold declarations so a retry stays in flight.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
/** A copy of the fixture View under another ID, to switch Views within one Preview session. */
const OTHER_VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c2'
const WIDGET_ID = 'btn-run-checks'

type DeclarationShim = { incompatible: number; hold: boolean; held: unknown[]; rewritten: string[] }
type ShimWindow = Window & { __declarationShim: DeclarationShim; __releaseDeclarations: () => void }

/**
 * Runs in the Workbench page before any of its scripts, ahead of the wire recorder: a capturing
 * listener sees each Preview post first. It replaces a declaration post with a rewritten copy, or
 * holds it, and stops the original from reaching the Workbench. A re-dispatched copy keeps the
 * Preview window as its source, so the Workbench's peer checks still apply to it.
 */
function declarationShim(incompatible: number): string {
	return `(() => {
	if (window.top !== window) return
	const shim = window.__declarationShim = { incompatible: ${incompatible}, hold: false, held: [], rewritten: [] }
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
		if (shim.hold) shim.held.push({ data, origin: event.origin, source: event.source })
		else if (shim.incompatible > 0) {
			shim.incompatible--
			const rewrite = message => message && message.type === 'capability.declare'
				? (shim.rewritten.push(message.context.runtimeGenerationId), { ...message, payload: { ...message.payload, protocolVersion: 2 } })
				: message
			replay(Array.isArray(data.messages) ? { ...data, messages: data.messages.map(rewrite) } : { ...data, message: rewrite(data.message) }, event.origin, event.source)
		}
		else replay(data, event.origin, event.source)
	}, true)
})()`
}

let server: WorkbenchServer
let browser: Browser

beforeAll(async () => {
	server = await startWorkbenchServer({
		prepare: async (root) => {
			const view = JSON.parse(await readFile(join(root, 'views', `${VIEW_ID}.view.json`), 'utf8')) as Record<string, unknown>
			await writeFile(join(root, 'views', `${OTHER_VIEW_ID}.view.json`), `${JSON.stringify({ ...view, id: OTHER_VIEW_ID, name: 'Second View' })}\n`)
		},
	})
	browser = await chromium.launch({ headless: true })
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, incompatible: number): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(declarationShim(incompatible))
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const iframe = (page: Page) => page.locator('iframe[src*="/preview"]')
const documentParam = async (page: Page) => Number(new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('document'))
const shim = (page: Page) => page.evaluate(() => {
	const { incompatible, hold, held, rewritten } = (window as unknown as ShimWindow).__declarationShim
	return { incompatible, hold, held: held.length, rewritten: [...rewritten] }
})
const setHold = (page: Page, hold: boolean) => page.evaluate((value) => { (window as unknown as ShimWindow).__declarationShim.hold = value }, hold)
/** Drops held declarations without delivering them: their document was replaced. */
const dropHeld = (page: Page) => page.evaluate(() => { (window as unknown as ShimWindow).__declarationShim.held.length = 0 })
const release = (page: Page) => page.evaluate(() => (window as unknown as ShimWindow).__releaseDeclarations())
const declaredGenerations = async (page: Page) => (await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages))
	.filter(message => message.type === 'capability.declare').map(message => String(message.context.runtimeGenerationId))
const identity = async (diagnostic: Locator, key: string) => (await diagnostic.locator(`[data-preview-failure-identity="${key}"]`).textContent())?.trim()
const isFocused = (locator: Locator) => locator.evaluate(element => element === document.activeElement)

async function openDetails(diagnostic: Locator): Promise<void> {
	if (await diagnostic.locator('[data-preview-failure-reason]').isVisible()) return
	await diagnostic.getByRole('button', { name: 'Technical details' }).click()
	await diagnostic.locator('[data-preview-failure-reason]').waitFor({ state: 'visible' })
}

async function expectInFlight(page: Page, diagnostic: Locator): Promise<void> {
	expect(await diagnostic.getByRole('button', { name: 'Retry Preview' }).getAttribute('aria-disabled')).toBe('true')
	expect(await diagnostic.locator('[data-preview-retry-status]').textContent()).toContain('Starting a fresh preview')
	await page.locator('[data-session-status]').click()
	expect(await page.locator('[data-session-retry]').getAttribute('aria-disabled')).toBe('true')
	await page.locator('[data-session-retry]').click({ force: true })
	await page.keyboard.press('Escape')
}

async function expectLive(page: Page): Promise<string> {
	await page.waitForSelector('[data-session-status][data-status="live"]', { timeout: 15_000 })
	await page.locator('[data-preview-failure]').waitFor({ state: 'detached' })
	return await iframe(page).getAttribute('data-runtime-generation') ?? ''
}

describe('Inline Preview diagnostic and Retry Preview (issue #111)', () => {
	it('shows a capability failure inline, and Retry Preview recovers through one explicit retry', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 1)
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
			expect(await alert.locator('[data-preview-failure-body]').textContent()).toContain('update or restart UIUX, then reload')
			expect(await page.locator('[role="dialog"], [role="alertdialog"]').count()).toBe(0)
			// The status region exists before anything is announced in it.
			expect(await diagnostic.locator('[data-preview-retry-status]').getAttribute('role')).toBe('status')

			// The reason and the correlation identities are in the collapsed details only.
			expect(await diagnostic.locator('[data-preview-failure-reason]').isVisible()).toBe(false)
			expect(await diagnostic.textContent()).not.toContain('capability.unsupported_protocol_version')
			await openDetails(diagnostic)
			expect((await diagnostic.locator('[data-preview-failure-reason]').textContent())?.trim()).toBe('capability.unsupported_protocol_version')
			const sessionId = new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session')
			expect(await identity(diagnostic, 'previewSessionId')).toBe(sessionId)
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(failedGeneration)
			expect(await diagnostic.textContent()).not.toMatch(/\bat \S+:\d+|Error:|stack/i)

			// Retry Preview, from the keyboard. The retry's declaration is held, so it stays in flight.
			await setHold(page, true)
			const before = await documentParam(page)
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await retry.focus()
			await page.keyboard.press('Enter')
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)

			// While it is in flight the action is disabled but keeps focus, the diagnostic stays, and
			// another press (here or on the chip) loads nothing.
			expect(await isFocused(retry)).toBe(true)
			await retry.click({ force: true })
			await expectInFlight(page, diagnostic)
			expect(await documentParam(page)).toBe(before + 1)
			expect((await shim(page)).held).toBe(1)

			// The document loaded and declared nothing: after the grace period Retry Preview is offered
			// again (owner ruling 1), and pressing it reloads under the same pending authorization.
			await expect.poll(async () => await retry.getAttribute('aria-disabled'), { timeout: RETRY_STALL_GRACE_MS + 10_000 }).toBeNull()
			expect(await diagnostic.locator('[data-preview-retry-status]').textContent()).toContain('has not answered')
			await dropHeld(page)
			await setHold(page, false)
			await retry.focus()
			await page.keyboard.press('Enter')
			await expect.poll(() => documentParam(page)).toBe(before + 2)

			// Recovery is exhausted, so only the pending explicit retry admits the new generation.
			const recovered = await expectLive(page)
			expect(recovered).toMatch(/^gen-[0-9a-f]{32}$/)
			expect(recovered).not.toBe(failedGeneration)
			// Focus was inside the diagnostic when it went away: it moves to the canvas region.
			expect(await isFocused(page.locator('[data-canvas]'))).toBe(true)
			const frame = await (await iframe(page).elementHandle())!.contentFrame()
			const acks = (await frame!.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages))
				.filter(message => message.type === 'capability.ack')
			expect(acks.map(message => message.context.runtimeGenerationId)).toEqual([recovered])
		}
		finally { await context.close() }
	}, 90_000)

	it('replaces the diagnostic when the retry fails again, and offers Retry Preview again', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 2)
		try {
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			await openDetails(diagnostic)
			const first = (await shim(page)).rewritten[0]!
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(first)

			// The retry's generation is incompatible too: the retry has run its course.
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await retry.click()
			await expect.poll(async () => (await shim(page)).rewritten.length, { timeout: 15_000 }).toBe(2)
			const second = (await shim(page)).rewritten[1]!
			await expect.poll(() => identity(diagnostic, 'runtimeGenerationId'), { timeout: 15_000 }).toBe(second)
			expect(await diagnostic.getAttribute('data-reason')).toBe('capability.unsupported_protocol_version')
			expect(await retry.getAttribute('aria-disabled')).toBeNull()
			expect((await diagnostic.locator('[data-preview-retry-status]').textContent())?.trim()).toBe('')
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')

			// A new authorization recovers.
			await retry.click()
			expect(await expectLive(page)).not.toBe(second)
		}
		finally { await context.close() }
	}, 90_000)

	it('after a capability conflict, Retry Preview spends the automatic recovery allowance with the same in-flight state', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const frame = await (await iframe(page).elementHandle())!.contentFrame()
			// The runtime declares a different capability set for the same generation.
			await frame!.evaluate(([previewSessionId, runtimeGenerationId]) => {
				parent.postMessage({ channel: 'uiux:preview:wire', message: {
					type: 'capability.declare',
					context: { previewSessionId, runtimeGenerationId },
					payload: { protocolVersion: 1, features: ['geometry'] },
				} }, location.origin)
			}, [new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session'), live] as const)

			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-category')).toBe('protocol')
			expect(await diagnostic.getAttribute('data-reason')).toBe('protocol.capability_conflict')
			expect(await diagnostic.getByRole('alert').locator('[data-preview-failure-title]').textContent()).toContain('Preview sent an unexpected message')
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')
			await openDetails(diagnostic)
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(live)

			// Retry Preview: in flight until the next declaration's outcome, exactly as on the explicit path.
			await setHold(page, true)
			const before = await documentParam(page)
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)
			await retry.click({ force: true })
			await expectInFlight(page, diagnostic)
			expect(await documentParam(page)).toBe(before + 1)

			// The new generation is the automatic recovery attempt; no authorization was needed.
			await release(page)
			const recovered = await expectLive(page)
			expect(recovered).not.toBe(live)
		}
		finally { await context.close() }
	}, 90_000)

	it('clears the diagnostic when another View replaces the context, and shows it again for a refused document', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 1)
		try {
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			const failed = (await shim(page)).rewritten[0]!

			// Switch Views in the app; the new View's declaration is held for now.
			await setHold(page, true)
			await page.getByRole('button', { name: 'All Views' }).click()
			await page.locator(`a[href^="/views/${OTHER_VIEW_ID}"]`).click()
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)
			expect(await diagnostic.count()).toBe(0)

			// Recovery stays exhausted across navigation: the new document is refused, and the failure
			// that exhausted it is shown again under the refused generation.
			await release(page)
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-reason')).toBe('capability.unsupported_protocol_version')
			await openDetails(diagnostic)
			const refused = (await declaredGenerations(page)).at(-1)!
			expect(refused).not.toBe(failed)
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(refused)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')
		}
		finally { await context.close() }
	}, 90_000)
})
