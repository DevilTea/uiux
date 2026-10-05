import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * R5 acceptance (brief e) against the built Workbench and a private copy of the dogfood
 * Workspace: the Inspector keeps ids and revisions behind Details, a Spec save conflict never
 * overwrites, and mobile reads the Spec with no edit affordances.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const WIDGET_ID = 'btn-export-handoff'

let server: WorkbenchServer
let browser: Browser

type ViewRead = { revision: string; resource: { ir: unknown; variants: Record<string, unknown>; spec: Record<string, unknown> } }

async function readView(): Promise<ViewRead> {
	return await (await fetch(`${server.origin}/api/resources/view/${VIEW_ID}`, { headers: server.headers })).json() as ViewRead
}

/** Writes through `update_view_spec` over HTTP, as another reviewer or agent would. */
async function writeIntent(intent: string): Promise<void> {
	const read = await readView()
	// Decisions are not part of the update_view_spec payload; the server preserves them.
	const content = Object.fromEntries(Object.entries(read.resource.spec).filter(([key]) => key !== 'decisions'))
	const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/spec`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, spec: { ...content, intent } }),
	})
	if (!response.ok) throw new Error(`Could not write the Spec: ${response.status} ${await response.text()}`)
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	const read = await readView()
	const response = await fetch(`${server.origin}/api/views/${VIEW_ID}/structure`, {
		method: 'PUT',
		headers: { ...server.headers, 'content-type': 'application/json' },
		body: JSON.stringify({ expectedRevision: read.revision, ir: read.resource.ir, variants: { ...read.resource.variants, 'error-state': { state: { [WIDGET_ID]: { disabled: true } } } } }),
	})
	if (!response.ok) throw new Error(`Could not author the test Variant: ${response.status}`)
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

async function open(path: string, width = 1920, height = 1080): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width, height }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
		localStorage.setItem('uiux.workbench.rightPanelHidden', '0')
	})
	await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: server.origin })
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

describe('Inspector (R5)', () => {
	it('answers what, where and how this Variant differs, with ids and revisions one click away', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?variant=error-state&widget=${WIDGET_ID}&panel=inspect`)
		try {
			const inspector = page.locator('[data-inspector]')
			await inspector.locator('[data-inspector-properties]').waitFor()
			await expect.poll(() => page.getByRole('tab', { name: /Inspect/ }).getAttribute('aria-selected')).toBe('true')
			const view = await readView()
			const text = await inspector.innerText()
			expect(text).toContain('Button')
			expect(text).toContain(`#${WIDGET_ID}`)
			expect(text).toContain('In this Variant')
			expect(await inspector.locator('[data-inspector-variant] table caption').textContent()).toContain('error-state')
			expect((await inspector.locator('[data-inspector-variant] td').allTextContents()).map(cell => cell.replace(/\s+/g, ' ').trim())).toContain('true changed')
			// Default view: no View id, no revision.
			expect(text).not.toContain(VIEW_ID)
			expect(text).not.toContain(view.revision.slice(0, 8))
			expect(await inspector.locator('[data-inspector-details]').count()).toBe(0)

			await inspector.locator('[data-inspector-details-toggle]').click()
			const details = inspector.locator('[data-inspector-details]')
			await details.waitFor()
			expect(await details.locator(`[title="${view.revision}"]`).count()).toBe(1)
			expect(await details.locator(`[title="${VIEW_ID}"]`).count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)

	it('switches panel tabs with ⌥1–⌥4 and copies the Widget id', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?widget=${WIDGET_ID}`)
		try {
			await page.locator('body').click({ position: { x: 5, y: 300 } })
			await page.keyboard.press('Alt+3')
			await expect.poll(() => page.getByRole('tab', { name: /^Spec/ }).getAttribute('aria-selected')).toBe('true')
			await page.keyboard.press('Alt+2')
			await expect.poll(() => page.getByRole('tab', { name: /Inspect/ }).getAttribute('aria-selected')).toBe('true')
			await page.locator('[data-inspector-copy]').click()
			await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(`#${WIDGET_ID}`)
		}
		finally { await context.close() }
	}, 60_000)
})

describe('Spec document (R5)', () => {
	it('shows the conflict and never overwrites when the Spec changed during editing', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`)
		try {
			const intent = page.locator('[data-spec-section="intent"]')
			await intent.locator('[data-spec-edit]').click()
			const field = intent.locator('[data-spec-editor] textarea').first()
			await field.fill('My draft intent.')
			await writeIntent('Their intent, saved first.')

			await intent.locator('[data-spec-save]').click()
			await intent.locator('[data-spec-conflict]').waitFor()
			expect(await intent.locator('[data-spec-conflict]').innerText()).toContain('The Spec changed since you started editing.')
			expect((await readView()).resource.spec.intent).toBe('Their intent, saved first.')
			expect(await field.inputValue()).toBe('My draft intent.')
			expect(await intent.locator('[data-spec-save]').isDisabled()).toBe(true)

			await intent.getByRole('button', { name: 'Compare versions' }).click()
			await expect.poll(() => intent.locator('[data-spec-theirs]').innerText()).toContain('Their intent, saved first.')

			await intent.getByRole('button', { name: 'Discard mine' }).click()
			await expect.poll(() => intent.innerText()).toContain('Their intent, saved first.')
			expect(await intent.locator('[data-spec-editor]').count()).toBe(0)
			expect((await readView()).resource.spec.intent).toBe('Their intent, saved first.')
		}
		finally { await context.close() }
	}, 60_000)

	it('saves one section with the revision it was read at and keeps the Decisions', async () => {
		const before = await readView()
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`)
		try {
			const constraints = page.locator('[data-spec-section="constraints"]')
			await constraints.locator('[data-spec-edit]').click()
			await constraints.getByRole('button', { name: 'Add item' }).click()
			await constraints.locator('[data-spec-editor] textarea').last().fill('Saved from the Spec tab.')
			await constraints.locator('[data-spec-editor] textarea').last().press('ControlOrMeta+Enter')
			await expect.poll(async () => (await readView()).resource.spec.constraints).toContain('Saved from the Spec tab.')
			const after = await readView()
			expect(after.resource.spec.decisions).toEqual(before.resource.spec.decisions)
			expect(after.resource.spec.intent).toBe(before.resource.spec.intent)
			await expect.poll(() => constraints.innerText()).toContain('Saved from the Spec tab.')
		}
		finally { await context.close() }
	}, 60_000)

	it('reads on mobile: a 68ch column, §1 open, the rest folded, and no edit affordances', async () => {
		const { context, page } = await open(`/views/${VIEW_ID}?panel=spec`, 390, 844)
		try {
			await page.getByRole('button', { name: 'Open panel' }).click()
			const spec = page.locator('[data-spec-document]')
			await spec.waitFor()
			expect(await spec.locator('[data-spec-edit], [data-spec-editor], [data-spec-edit-on-desktop]').count()).toBe(0)
			expect(await spec.locator('textarea, input').count()).toBe(0)
			const toggles = spec.locator('h3 button[aria-expanded]')
			expect(await toggles.count()).toBe(7)
			expect(await toggles.first().getAttribute('aria-expanded')).toBe('true')
			expect(await toggles.nth(1).getAttribute('aria-expanded')).toBe('false')
			const measure = await spec.locator('#spec-body-intent').evaluate((element) => {
				const probe = document.createElement('span')
				probe.textContent = '0'.repeat(68)
				probe.style.whiteSpace = 'nowrap'
				element.appendChild(probe)
				const width = probe.getBoundingClientRect().width
				probe.remove()
				return { maxWidth: Number.parseFloat(getComputedStyle(element).maxWidth), width }
			})
			expect(Math.abs(measure.maxWidth - measure.width)).toBeLessThan(1)
		}
		finally { await context.close() }
	}, 60_000)
})
