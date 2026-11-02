import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * The Inspector's Base cell against the built Workbench (issue #52; Rule
 * 01a19a9d-a01a-72bd-9ea0-cad4e90ae7fc; Clauses 01a19a9b-3c4d-74cb-9695-ce20087e2188 and
 * 01a19ab9-d028-7bb9-a370-4736992852f5): for each State member the open Variant overrides on the
 * selected Widget the cell shows the base value the Preview read from its separate base Runtime, a
 * pending state while the request is outstanding, or Unavailable, never an authored default.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const WIDGET_ID = 'btn-export-handoff'
const VARIANT = 'error-state'

let server: WorkbenchServer
let browser: Browser

type ViewRead = { revision: string; resource: { ir: unknown; variants: Record<string, unknown> } }

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	const read = await (await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })).json() as ViewRead
	// The Button's `disabled` State member defaults to false; the Variant overrides it to true.
	const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/structure`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, ir: read.resource.ir, variants: { ...read.resource.variants, [VARIANT]: { state: { [WIDGET_ID]: { disabled: true } } } } }),
	})
	if (!response.ok) throw new Error(`Could not author the test Variant: ${response.status}`)
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

/** Swallows every `inspection.base-state.response` before the Workbench reads it: the Preview never answers. */
const DROP_BASE_STATE_RESPONSES = `(() => {
	window.addEventListener('message', (event) => {
		const data = event.data
		if (!data || typeof data !== 'object' || data.channel !== 'uiux:preview:wire') return
		const messages = Array.isArray(data.messages) ? data.messages : [data.message]
		if (messages.some(message => message && message.type === 'inspection.base-state.response')) event.stopImmediatePropagation()
	}, true)
})()`

async function open(path: string, options: Readonly<{ dropResponses?: boolean }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
		localStorage.setItem('uiux.workbench.rightPanelHidden', '0')
	})
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	if (options.dropResponses) await context.addInitScript(DROP_BASE_STATE_RESPONSES)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const baseCell = (page: Page) => page.locator('[data-inspector-variant] [data-base-state]')
const wire = (page: Page) => page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages.filter(message => message.type.startsWith('inspection.base-state.')))

describe('Inspector Base cell (issue #52)', () => {
	it('shows the base value the Preview read for a State member the Variant overrides', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?variant=${VARIANT}&widget=${WIDGET_ID}&panel=inspect`)
		try {
			const inspector = page.locator('[data-inspector]')
			await inspector.locator('[data-inspector-variant] table').waitFor()
			// The override column carries the authored value; the Base column the value of the View with no Variant.
			await expect.poll(() => baseCell(page).first().getAttribute('data-base-state'), { timeout: 30_000 }).toBe('value')
			expect((await baseCell(page).first().textContent())?.trim()).toBe('false')
			const row = inspector.locator('[data-inspector-variant] tbody tr').first()
			expect((await row.locator('td').allTextContents()).map(cell => cell.replace(/\s+/g, ' ').trim())).toEqual(['disabled', 'false', 'true changed'])
			expect(await inspector.innerText()).not.toContain('Widget default')

			// The Preview answered one request, naming the Widget and its overridden key, for the Workbench's own render context.
			const responses = (await wire(page)).filter(message => message.type === 'inspection.base-state.response')
			expect(responses).toHaveLength(1)
			expect(responses[0]?.payload).toMatchObject({ widgetId: WIDGET_ID, values: { disabled: { value: false } }, renderContext: { locale: 'en-US' } })
		}
		finally { await context.close() }
	}, 90_000)

	it('reads again for a changed render context and still shows the base value', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?variant=${VARIANT}&widget=${WIDGET_ID}&panel=inspect&locale=zh-TW`)
		try {
			await expect.poll(() => baseCell(page).first().getAttribute('data-base-state'), { timeout: 30_000 }).toBe('value')
			expect((await baseCell(page).first().textContent())?.trim()).toBe('false')
			const responses = (await page.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages)).filter(message => message.type === 'inspection.base-state.response')
			expect(responses.at(-1)?.payload.renderContext).toMatchObject({ locale: 'zh-TW' })
		}
		finally { await context.close() }
	}, 90_000)

	it('reads the base value after the Variant is opened from the Workbench, not only from a link', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}&panel=inspect`)
		try {
			await page.locator('[data-context="variant"]').click()
			await page.getByRole('option', { name: VARIANT }).click()
			await expect.poll(() => baseCell(page).first().getAttribute('data-base-state'), { timeout: 30_000 }).toBe('value')
			expect((await baseCell(page).first().textContent())?.trim()).toBe('false')
		}
		finally { await context.close() }
	}, 90_000)

	it('shows pending while the request is outstanding, then Unavailable when the Preview never answers', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?variant=${VARIANT}&widget=${WIDGET_ID}&panel=inspect`, { dropResponses: true })
		try {
			await expect.poll(() => baseCell(page).first().getAttribute('data-base-state'), { timeout: 30_000 }).toBe('pending')
			expect((await baseCell(page).first().textContent())?.trim()).toBe('Reading…')
			// The request left, was never answered, and the wait of 5000 ms ended it.
			await expect.poll(() => baseCell(page).first().getAttribute('data-base-state'), { timeout: 30_000 }).toBe('unavailable')
			expect((await baseCell(page).first().textContent())?.trim()).toBe('Unavailable')
			expect(await page.locator('[data-inspector]').innerText()).not.toContain('Widget default')
		}
		finally { await context.close() }
	}, 90_000)
})
