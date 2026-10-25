import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
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

/**
 * `incompatible` declarations are rewritten to an unsupported protocol version, then `invalid` ones
 * to an undecodable payload (issue #101); `rewritten` lists the generations either touched.
 */
type DeclarationShim = { incompatible: number; invalid: number; hold: boolean; held: unknown[]; rewritten: string[] }
type ShimWindow = Window & { __declarationShim: DeclarationShim; __releaseDeclarations: () => void }

/**
 * Runs in the Workbench page before any of its scripts, ahead of the wire recorder: a capturing
 * listener sees each Preview post first. It replaces a declaration post with a rewritten copy, or
 * holds it, and stops the original from reaching the Workbench. A re-dispatched copy keeps the
 * Preview window as its source, so the Workbench's peer checks still apply to it. A post marked
 * `passThrough` (a message the test itself injects) goes on untouched.
 */
function declarationShim(incompatible: number): string {
	return `(() => {
	if (window.top !== window) return
	const shim = window.__declarationShim = { incompatible: ${incompatible}, invalid: 0, hold: false, held: [], rewritten: [] }
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
		if (replayed.has(event) || !data || data.channel !== 'uiux:preview:wire' || data.passThrough) return
		const messages = Array.isArray(data.messages) ? data.messages : [data.message]
		if (!messages.some(message => message && message.type === 'capability.declare')) return
		event.stopImmediatePropagation()
		if (shim.hold) shim.held.push({ data, origin: event.origin, source: event.source })
		else if (shim.incompatible > 0 || shim.invalid > 0) {
			const payload = shim.incompatible > 0 ? { protocolVersion: 2 } : { protocolVersion: 'one' }
			if (shim.incompatible > 0) shim.incompatible--
			else shim.invalid--
			const rewrite = message => message && message.type === 'capability.declare'
				? (shim.rewritten.push(message.context.runtimeGenerationId), { ...message, payload: { ...message.payload, ...payload } })
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

/** A grace period no in-flight assertion can outlast; the stall test sets a short one. */
const LONG_GRACE_MS = 120_000
const SHORT_GRACE_MS = 300

async function open(path: string, incompatible: number, graceMs = LONG_GRACE_MS): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript((value) => { (window as unknown as { __uiuxRetryStallGraceMs: number }).__uiuxRetryStallGraceMs = value }, graceMs)
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
	const { incompatible, invalid, hold, held, rewritten } = (window as unknown as ShimWindow).__declarationShim
	return { incompatible, invalid, hold, held: held.length, rewritten: [...rewritten] }
})
/** The open generation's runtime declares a different capability set: a capability conflict. */
async function declareConflict(page: Page, runtimeGenerationId: string): Promise<void> {
	const previewSessionId = new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session')
	const frame = await (await iframe(page).elementHandle())!.contentFrame()
	await frame!.evaluate(([session, generation]) => {
		parent.postMessage({ channel: 'uiux:preview:wire', passThrough: true, message: {
			type: 'capability.declare',
			context: { previewSessionId: session, runtimeGenerationId: generation },
			payload: { protocolVersion: 1, features: ['geometry'] },
		} }, location.origin)
	}, [previewSessionId, runtimeGenerationId] as const)
}
const setInvalid = (page: Page, count: number) => page.evaluate((value) => { (window as unknown as ShimWindow).__declarationShim.invalid = value }, count)
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

			// The declaration arrives: recovery is exhausted, so only the pending explicit retry admits it.
			await retry.focus()
			await release(page)
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

	it('offers Retry Preview again when the retry stalls, even on an unreadable error page, and reloads under the same authorization', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 1, SHORT_GRACE_MS)
		try {
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			const status = diagnostic.locator('[data-preview-retry-status]')
			const before = await documentParam(page)

			// The retry's document loads but its declaration never arrives (owner ruling 1).
			await setHold(page, true)
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => await retry.getAttribute('aria-disabled'), { timeout: 15_000 }).toBeNull()
			expect(await status.textContent()).toContain('has not answered')
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).not.toBe('live')

			// Pressing again reloads; this time the document fails to load at all. The error page cannot
			// be read, and Retry Preview still comes back.
			await dropHeld(page)
			await setHold(page, false)
			await page.route(url => url.pathname === '/preview' && url.searchParams.get('document') === String(before + 2), route => route.abort())
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 2)
			await expect.poll(async () => await retry.getAttribute('aria-disabled'), { timeout: 15_000 }).toBeNull()
			expect(await status.textContent()).toContain('has not answered')

			// The next document loads and declares: the same pending authorization admits it.
			await page.unrouteAll()
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 3)
			await expectLive(page)
			expect(await declaredGenerations(page)).toHaveLength(2)
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

	it('after a capability conflict, the Workbench starts one automatic recovery attempt with the in-flight state of Retry Preview (issue #101)', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			// The attempt's declaration is held, so the attempt stays in flight.
			await setHold(page, true)
			await declareConflict(page, live)

			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-category')).toBe('protocol')
			expect(await diagnostic.getAttribute('data-reason')).toBe('protocol.capability_conflict')
			expect(await diagnostic.getByRole('alert').locator('[data-preview-failure-title]').textContent()).toContain('Preview sent an unexpected message')
			await openDetails(diagnostic)
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(live)

			// Nobody pressed anything: exactly one fresh document is requested in the same session.
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)
			await expectInFlight(page, diagnostic)
			expect(await documentParam(page)).toBe(before + 1)

			// The new generation is the automatic recovery attempt; no authorization was needed.
			await release(page)
			const recovered = await expectLive(page)
			expect(recovered).not.toBe(live)
			expect(await documentParam(page)).toBe(before + 1)
		}
		finally { await context.close() }
	}, 90_000)

	it('never charges the automatic attempt for a malformed envelope the failed document sends after its conflict (issue #101)', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			const previewSessionId = new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session')
			// One transport batch: the conflicting declaration, then an undecodable envelope. The
			// conflict replaces the document, so the rest of the batch comes from a replaced document.
			const frame = await (await iframe(page).elementHandle())!.contentFrame()
			await frame!.evaluate(([session, generation]) => {
				parent.postMessage({ channel: 'uiux:preview:wire', messages: [
					{ type: 'capability.declare', context: { previewSessionId: session, runtimeGenerationId: generation }, payload: { protocolVersion: 1, features: ['geometry'] } },
					{ type: 'bogus' },
				] }, location.origin)
			}, [previewSessionId, live] as const)

			// The automatic attempt is not spent by the stray envelope: its document recovers Preview.
			await expect.poll(() => documentParam(page), { timeout: 15_000 }).toBe(before + 1)
			expect(await expectLive(page)).not.toBe(live)
			expect(await documentParam(page)).toBe(before + 1)
		}
		finally { await context.close() }
	}, 90_000)

	it('stops after the automatic attempt fails too: Preview stays unavailable with the selection kept, until Retry Preview (issue #101)', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			// The automatic attempt's document sends an undecodable declaration: a second protocol failure.
			await setInvalid(page, 1)
			await declareConflict(page, live)

			const diagnostic = page.locator('[data-preview-failure]')
			await expect.poll(async () => await diagnostic.getAttribute('data-reason'), { timeout: 15_000 }).toBe('protocol.invalid_message')
			expect((await shim(page)).invalid).toBe(0)
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await expect.poll(async () => await retry.getAttribute('aria-disabled')).toBeNull()
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')
			// The structural selection stays, and no further document starts on its own.
			expect(new URL(page.url()).searchParams.get('widget')).toBe(WIDGET_ID)
			await page.waitForTimeout(1_000)
			expect(await documentParam(page)).toBe(before + 1)
			// The live generation (declared twice, the second time conflicting) and the attempt's.
			expect(new Set(await declaredGenerations(page)).size).toBe(2)

			// Retry Preview is the explicit retry that admits the next generation.
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 2)
			expect(await expectLive(page)).not.toBe(live)
			expect(new URL(page.url()).searchParams.get('widget')).toBe(WIDGET_ID)
		}
		finally { await context.close() }
	}, 90_000)

	it('turns a press after a stalled automatic attempt into an explicit retry (issue #101)', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0, SHORT_GRACE_MS)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			await setHold(page, true)
			await declareConflict(page, live)

			// The attempt's document loads and never declares: Retry Preview is offered again.
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => await retry.getAttribute('aria-disabled'), { timeout: 15_000 }).toBeNull()

			// The press replaces the stalled document; its declaration is admitted as the explicit retry.
			await dropHeld(page)
			await setHold(page, false)
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 2)
			expect(await expectLive(page)).not.toBe(live)
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

/**
 * Runtime-reported failures (issue #312): `failure.report` under the `failure.reports` feature,
 * Scenario 01a11a5b-61a6-74d4-a9a5-ae54f38cded7 and Clauses 01a11a59-dd69-78ed-9181-d8beb5f4cb7b,
 * 01a11a59-def9-797a-8d08-5e4b02ecd900 and 01a11a70-4261-7155-8aed-28bed7a89064. The Preview
 * document's runtime declares the feature itself; a report is posted from inside its frame, like the
 * conflicting declaration above, and an invalid Workbench envelope is posted into it from the page.
 */
describe('Runtime-reported Preview failures (issue #312)', () => {
	const sessionOf = async (page: Page) => new URL(await iframe(page).getAttribute('src') ?? '', server.origin).searchParams.get('session')!
	/** The runtime frame sends one `failure.report` for `generation`, with this payload. */
	async function report(page: Page, generation: string, payload: Record<string, unknown>): Promise<void> {
		const session = await sessionOf(page)
		const frame = await (await iframe(page).elementHandle())!.contentFrame()
		await frame!.evaluate(([previewSessionId, runtimeGenerationId, body]) => {
			parent.postMessage({ channel: 'uiux:preview:wire', message: {
				type: 'failure.report',
				context: { previewSessionId, runtimeGenerationId },
				payload: body,
			} }, location.origin)
		}, [session, generation, payload] as const)
	}
	/** The Workbench page sends one envelope into the runtime frame. */
	const sendIntoRuntime = (page: Page, message: Record<string, unknown>) => page.evaluate((body) => {
		const frame = document.querySelector<HTMLIFrameElement>('iframe[src*="/preview"]')!
		frame.contentWindow!.postMessage({ channel: 'uiux:preview:wire', message: body }, location.origin)
	}, message)
	const failureReports = async (page: Page) => (await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages))
		.filter(message => message.type === 'failure.report')
	const RUNTIME_UNAVAILABLE = { category: 'runtime', reason: 'runtime.unavailable', detail: 'The geometry worker stopped.' }
	const NEVER_ADMITTED = 'gen-00000000000000000000000000000000'

	it('ends the generation for a generation-scoped runtime failure, starts no recovery, and Retry Preview recovers (Scenario 01a11a5b-61a6-74d4-a9a5-ae54f38cded7)', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)

			await report(page, live, RUNTIME_UNAVAILABLE)
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-category')).toBe('runtime')
			expect(await diagnostic.getAttribute('data-reason')).toBe('runtime.unavailable')
			expect(await diagnostic.getByRole('alert').locator('[data-preview-failure-title]').textContent()).toContain('Preview runtime stopped')
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('stopped')
			await openDetails(diagnostic)
			expect(await identity(diagnostic, 'runtimeGenerationId')).toBe(live)
			expect(await diagnostic.textContent()).toContain('The geometry worker stopped.')

			// No automatic recovery: no new document, no new generation, and Retry Preview is ready.
			await page.waitForTimeout(1_500)
			expect(await documentParam(page)).toBe(before)
			expect(await declaredGenerations(page)).toEqual([live])
			const retry = diagnostic.getByRole('button', { name: 'Retry Preview' })
			expect(await retry.getAttribute('aria-disabled')).toBeNull()
			expect(await diagnostic.locator('[data-preview-retry-status]').textContent()).not.toContain('Starting a fresh preview')

			// The explicit retry starts the next generation.
			await retry.click()
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			expect(await expectLive(page)).not.toBe(live)
		}
		finally { await context.close() }
	}, 90_000)

	it('ignores a report naming a retired or never-admitted generation, and still ends the current one', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const first = await expectLive(page)
			await report(page, first, RUNTIME_UNAVAILABLE)
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			await diagnostic.getByRole('button', { name: 'Retry Preview' }).click()
			const current = await expectLive(page)
			expect(current).not.toBe(first)
			const before = await documentParam(page)

			// Late reports of the retired generation, and one of a generation that was never admitted.
			await report(page, first, { category: 'protocol', reason: 'protocol.invalid_message' })
			await report(page, first, RUNTIME_UNAVAILABLE)
			await report(page, NEVER_ADMITTED, RUNTIME_UNAVAILABLE)
			await page.waitForTimeout(1_500)
			expect(await diagnostic.count()).toBe(0)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
			expect(await iframe(page).getAttribute('data-runtime-generation')).toBe(current)
			expect(await documentParam(page)).toBe(before)

			// The same report for the current generation does end it.
			await report(page, current, RUNTIME_UNAVAILABLE)
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-reason')).toBe('runtime.unavailable')
		}
		finally { await context.close() }
	}, 90_000)

	it('uses the automatic recovery allowance for a protocol report, which a runtime failure never does', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			await setHold(page, true)
			await report(page, live, { category: 'protocol', reason: 'protocol.invalid_state' })
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-category')).toBe('protocol')
			expect(await diagnostic.getAttribute('data-reason')).toBe('protocol.invalid_state')

			// Nobody pressed anything: one fresh document is requested and stays in flight until it declares.
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)
			await expectInFlight(page, diagnostic)
			await release(page)
			expect(await expectLive(page)).not.toBe(live)
			expect(await documentParam(page)).toBe(before + 1)
		}
		finally { await context.close() }
	}, 90_000)

	it('drops a report of a category or reason a runtime may not report, or with an oversized detail', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			await report(page, live, { category: 'transport', reason: 'transport.channel_unavailable' })
			await report(page, live, { category: 'protocol', reason: 'protocol.identity_reuse' })
			await report(page, live, { category: 'runtime', reason: 'runtime.unavailable', detail: 'x'.repeat(501) })
			await page.waitForTimeout(1_000)
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
		}
		finally { await context.close() }
	}, 90_000)

	it('keeps the generation live when the Workbench sends an unknown additive message type after the ACK', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			const session = await sessionOf(page)
			await sendIntoRuntime(page, { type: 'geometry.reveal', context: { previewSessionId: session, runtimeGenerationId: live, viewId: VIEW_ID, widgetId: WIDGET_ID }, payload: {} })
			await page.waitForTimeout(1_500)
			expect(await failureReports(page)).toEqual([])
			expect(await page.locator('[data-preview-failure]').count()).toBe(0)
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')
			expect(await iframe(page).getAttribute('data-runtime-generation')).toBe(live)
			expect(await documentParam(page)).toBe(before)
		}
		finally { await context.close() }
	}, 90_000)

	it('has the runtime report an invalid Workbench envelope of its own generation once, never one of stale traffic', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`, 0)
		try {
			const live = await expectLive(page)
			const before = await documentParam(page)
			const session = await sessionOf(page)
			const invalid = (generation: string) => ({
				type: 'geometry.acquire.request',
				context: { previewSessionId: session, runtimeGenerationId: generation, viewId: VIEW_ID },
				payload: { secret: 'token-123' },
			})

			// Stale traffic (another generation) is discarded without a report.
			await sendIntoRuntime(page, invalid(NEVER_ADMITTED))
			await page.waitForTimeout(1_000)
			expect(await failureReports(page)).toEqual([])
			expect(await page.locator('[data-session-status]').getAttribute('data-status')).toBe('live')

			// An established violation in the current generation's traffic ends it with one report.
			await setHold(page, true)
			await sendIntoRuntime(page, invalid(live))
			const diagnostic = page.locator('[data-preview-failure]')
			await diagnostic.waitFor({ timeout: 15_000 })
			expect(await diagnostic.getAttribute('data-reason')).toBe('protocol.invalid_message')
			const reports = await failureReports(page)
			expect(reports).toHaveLength(1)
			expect(reports[0]).toMatchObject({ context: { previewSessionId: session, runtimeGenerationId: live }, payload: { category: 'protocol', reason: 'protocol.invalid_message' } })
			expect(Object.keys(reports[0]!.context).sort()).toEqual(['previewSessionId', 'runtimeGenerationId'])
			expect(JSON.stringify(reports[0])).not.toContain('token-123')
			await openDetails(diagnostic)
			expect(await diagnostic.textContent()).toContain('protocol.missing_context_identity')

			// A protocol report uses the automatic recovery attempt.
			await expect.poll(() => documentParam(page)).toBe(before + 1)
			await expect.poll(async () => (await shim(page)).held, { timeout: 15_000 }).toBe(1)
			await release(page)
			expect(await expectLive(page)).not.toBe(live)
		}
		finally { await context.close() }
	}, 90_000)
})
