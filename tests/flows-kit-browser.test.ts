import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The Flows area (the Flows list, the Flow editor with its graph, list and inspector, the create and add-step
 * dialogs, and the Prototype player) builds its buttons, badges and icons from the Kit components in
 * `app/components/kit/` instead of Nuxt UI primitives (Discussion #379 D1, issue #380). The test guards that the
 * Kit renders them with the state the area relied on: pressed and expanded toggles, a primary action per region,
 * icon-only buttons that keep their accessible name and the 44px touch target, and that no Kit tag is left
 * unresolved. Links (`Open View`) and Nuxt UI overlays, selects and alerts stay Nuxt UI.
 */

const WORKBENCH_VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const MISSING_VIEW = '00000000-0000-4000-8000-00000000dead'

let server: WorkbenchServer
let browser: Browser
let flowId = ''
let brokenFlowId = ''
const steps = { entry: crypto.randomUUID(), payment: crypto.randomUUID(), done: crypto.randomUUID() }

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json', origin: server.origin },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await response.text()
	return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })

	const spec = { intent: 'Payment failed.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('POST', '/api/views', { name: 'Payment error', spec })
	const paymentViewId = view.body.key
	const read = await api<{ revision: string }>('GET', `/api/resources/view/${paymentViewId}`)
	const button = (id: string, label: string) => ({ id, type: 'Button', config: { label } })
	const structure = await api('PUT', `/api/views/${paymentViewId}/structure`, {
		expectedRevision: read.body.revision,
		ir: { id: 'root', type: 'RootShell', slots: { content: [button('retry-button', 'Try again'), button('done-button', 'Finish')] } },
		variants: { error: { state: {} } },
	})
	expect(structure.status).toBe(200)

	const flow = await api<{ key: string }>('POST', '/api/flows', {
		name: 'Checkout recovery',
		entryStepId: steps.entry,
		steps: {
			[steps.entry]: { target: { viewId: WORKBENCH_VIEW }, transitions: [{ trigger: { widgetId: 'btn-run-checks', event: 'click' }, targetStepId: steps.payment }] },
			[steps.payment]: {
				target: { viewId: paymentViewId, variantName: 'error' },
				transitions: [
					{ trigger: { widgetId: 'retry-button', event: 'click' }, targetStepId: steps.payment },
					{ trigger: { widgetId: 'done-button', event: 'click' }, targetStepId: steps.done },
				],
			},
			[steps.done]: { target: { viewId: WORKBENCH_VIEW }, transitions: [] },
		},
	})
	expect(flow.status).toBe(201)
	flowId = flow.body.key

	const brokenEntry = crypto.randomUUID()
	const broken = await api<{ key: string }>('POST', '/api/flows', {
		name: 'Broken reference',
		entryStepId: brokenEntry,
		steps: { [brokenEntry]: { target: { viewId: MISSING_VIEW }, transitions: [] } },
	})
	expect(broken.status).toBe(201)
	brokenFlowId = broken.body.key
}, 60_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

type Setup = Readonly<{ touch?: boolean; width?: number; height?: number }>

async function open(path: string, setup: Setup = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({
		viewport: { width: setup.width ?? 1920, height: setup.height ?? 1080 },
		colorScheme: 'light',
		...(setup.touch ? { hasTouch: true } : {}),
	})
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

const hasClass = (locator: Locator, name: string) => locator.evaluate((element, expected) => element.classList.contains(expected), name)
const UNKNOWN_KIT_TAGS = 'kitbutton, kitbadge, kiticon, kitskeleton, kitbuttongroup, kitcheckbox, kitkbd'

describe('The Flows area uses the Kit components (#380)', () => {
	it('Flows list: a Kit New Flow button, Kit row icons and a Kit problems badge', async () => {
		const { context, page } = await open('/flows')
		try {
			const create = page.getByRole('button', { name: 'New Flow' })
			expect(await hasClass(create, 'kit-btn--sm')).toBe(true)
			expect(await create.locator('svg.kit-icon').count()).toBe(1)

			const rows = page.locator('ul[aria-label] > li')
			expect(await rows.count()).toBeGreaterThanOrEqual(2)
			expect(await rows.filter({ hasText: 'Checkout recovery' }).locator('svg.kit-icon').count()).toBe(2)
			const problems = rows.filter({ hasText: 'Broken reference' }).locator('.kit-badge')
			expect(await hasClass(problems, 'kit-badge--tone-danger')).toBe(true)
			expect(await problems.locator('svg.kit-icon').count()).toBe(1)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)

			await create.click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			expect(await hasClass(dialog.getByRole('button', { name: 'Cancel' }), 'kit-btn--ghost')).toBe(true)
			expect(await dialog.locator('button[type="submit"].kit-btn--primary').count()).toBe(1)
		}
		finally { await context.close() }
	}, 90_000)

	it('Editor toolbar: the layout switch is a Kit group of pressed toggles, Add step and Play are Kit buttons', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator('[data-flow-node]').first().waitFor()
			const group = page.getByRole('group', { name: 'Show the Flow as' })
			expect(await hasClass(group, 'kit-btn-group')).toBe(true)
			const graph = group.getByRole('button', { name: 'Graph' })
			const list = group.getByRole('button', { name: 'List' })
			expect(await graph.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(graph, 'is-pressed')).toBe(true)
			expect(await list.getAttribute('aria-pressed')).toBe('false')
			await list.click()
			await page.locator('[data-flow-list]').waitFor()
			expect(await list.getAttribute('aria-pressed')).toBe('true')
			expect(await hasClass(list, 'is-pressed')).toBe(true)
			expect(await hasClass(graph, 'is-pressed')).toBe(false)

			expect(await hasClass(page.locator('[data-flow-add-step]'), 'kit-btn')).toBe(true)
			expect(await hasClass(page.locator('[data-flow-play]'), 'kit-btn--primary')).toBe(true)

			// An edit makes Save the primary action and Play a secondary one.
			await page.getByRole('button', { name: 'Graph' }).click()
			await page.locator('[data-flow-graph]').click({ position: { x: 40, y: 40 } })
			await page.getByRole('textbox', { name: /^Name/ }).fill('Checkout recovery, edited')
			const save = page.locator('[data-flow-save]')
			expect(await hasClass(save, 'kit-btn--primary')).toBe(true)
			expect(await hasClass(save, 'kit-btn--sm')).toBe(true)
			expect(await hasClass(page.locator('[data-flow-play]'), 'kit-btn--secondary')).toBe(true)
			expect(await hasClass(page.getByRole('button', { name: 'Discard' }), 'kit-btn--ghost')).toBe(true)
		}
		finally { await context.close() }
	}, 90_000)

	it('Graph and List: the entry flag and problem and Variant badges are Kit components', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator('[data-flow-node]').first().waitFor()
			const entry = page.locator(`[data-step-id="${steps.entry}"]`)
			expect(await entry.locator('svg.kit-icon').count()).toBe(1)
			const payment = page.locator(`[data-step-id="${steps.payment}"]`)
			const variant = payment.locator('.kit-badge')
			expect(await variant.textContent()).toContain('error')
			expect(await hasClass(variant, 'kit-badge--soft')).toBe(true)

			await page.getByRole('button', { name: 'List' }).click()
			const rows = page.locator('[data-flow-list]')
			await rows.waitFor()
			expect(await rows.locator('.kit-badge', { hasText: 'Entry' }).count()).toBe(1)
			expect(await rows.locator('.kit-badge--soft', { hasText: 'error' }).count()).toBe(1)
			expect(await rows.locator('svg.kit-icon').count()).toBeGreaterThan(2)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }

		const broken = await open(`/flows/${brokenFlowId}`)
		try {
			await broken.page.locator('[data-flow-node]').first().waitFor()
			const badge = broken.page.locator('[data-flow-node] .kit-badge--tone-danger')
			expect(await badge.count()).toBe(1)
			expect(await badge.locator('svg.kit-icon').count()).toBe(1)
		}
		finally { await broken.context.close() }
	}, 90_000)

	it('Inspector: Kit step actions, an expanded-state Details toggle and a danger remove, while Open View stays a link', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator(`[data-step-id="${steps.payment}"]`).click()
			const inspector = page.locator('[data-flow-inspector]')
			const back = inspector.getByRole('button', { name: 'Flow', exact: true })
			expect(await hasClass(back, 'kit-btn--ghost')).toBe(true)
			expect(await back.locator('svg.kit-icon').count()).toBe(1)
			expect(await hasClass(inspector.getByRole('button', { name: 'Add transition' }), 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(inspector.getByRole('button', { name: 'Make entry step' }), 'kit-btn--sm')).toBe(true)
			// A navigation link keeps Nuxt UI: the Kit Button renders a <button>.
			const openView = inspector.getByRole('link', { name: 'Open View' })
			expect(await openView.count()).toBe(1)

			const details = inspector.getByRole('button', { name: 'Details' })
			expect(await hasClass(details, 'kit-btn--ghost')).toBe(true)
			expect(await details.getAttribute('aria-expanded')).toBe('false')
			await details.click()
			expect(await details.getAttribute('aria-expanded')).toBe('true')
			expect(await hasClass(details, 'is-expanded')).toBe(true)

			await inspector.getByRole('button', { name: 'Remove step' }).click()
			const confirm = inspector.getByRole('button', { name: 'Remove step' })
			expect(await hasClass(confirm, 'kit-btn--danger')).toBe(true)

			await page.locator(`[data-step-id="${steps.entry}"]`).click()
			await inspector.getByRole('button', { name: /btn-run-checks\.click/ }).click()
			const target = inspector.getByRole('button', { name: 'Select target step' })
			expect(await hasClass(target, 'kit-btn--sm')).toBe(true)
			const stepBack = inspector.locator('button.kit-btn--ghost.is-truncate').first()
			expect(await stepBack.count()).toBe(1)
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('Add step dialog: a primary Kit Add step button', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator('[data-flow-add-step]').click()
			const dialog = page.getByRole('dialog')
			await dialog.waitFor()
			expect(await dialog.locator('button[type="submit"].kit-btn--primary').count()).toBe(1)
			expect(await hasClass(dialog.getByRole('button', { name: 'Cancel' }), 'kit-btn--ghost')).toBe(true)
		}
		finally { await context.close() }
	}, 60_000)

	it('Player: Kit toolbar buttons with a pressed Comment toggle and Kit next-step buttons', async () => {
		const { context, page } = await open(`/flows/${flowId}?play=1`)
		try {
			await page.locator('[data-flow-player]').waitFor()
			const comment = page.locator('[data-flow-player-comment]')
			expect(await hasClass(comment, 'kit-btn--ghost')).toBe(true)
			expect(await comment.getAttribute('aria-pressed')).toBe('false')
			expect(await hasClass(page.locator('[data-flow-player-restart]'), 'kit-btn--sm')).toBe(true)
			expect(await hasClass(page.locator('[data-flow-player-exit]'), 'kit-btn--ghost')).toBe(true)

			const next = page.locator('[data-flow-player-next]').first()
			expect(await hasClass(next, 'kit-btn--ghost')).toBe(true)
			expect(await hasClass(next, 'is-truncate')).toBe(true)
			expect(await next.locator('svg.kit-icon').count()).toBe(1)
			await next.click()
			await page.locator('[data-flow-player-next]').first().waitFor()
			expect(await page.locator(UNKNOWN_KIT_TAGS).count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)

	it('on a phone the player toolbar buttons show only their icon and keep their accessible name', async () => {
		const { context, page } = await open(`/flows/${flowId}?play=1`, { touch: true, width: 390, height: 844 })
		try {
			await page.locator('[data-flow-player]').waitFor()
			for (const [selector, name] of [['[data-flow-player-restart]', 'Restart'], ['[data-flow-player-exit]', 'Exit'], ['[data-flow-player-comment]', 'Comment']] as const) {
				const control = page.locator(selector)
				expect(await hasClass(control, 'kit-btn'), selector).toBe(true)
				expect(await page.getByRole('button', { name, exact: true }).count(), selector).toBeGreaterThan(0)
				// The label is visually hidden, so the button is icon wide, not label wide.
				expect((await control.boundingBox())?.width, selector).toBeLessThan(60)
				expect((await control.boundingBox())?.height, selector).toBeGreaterThanOrEqual(44)
			}
		}
		finally { await context.close() }
	}, 90_000)

	it('renders every Kit component it names on the Flows list, the editor and the player', async () => {
		for (const route of ['/flows', `/flows/${flowId}`, `/flows/${flowId}?play=1`, `/flows/${brokenFlowId}`]) {
			const { context, page } = await open(route)
			try {
				await page.waitForTimeout(800)
				expect(await page.locator(UNKNOWN_KIT_TAGS).count(), route).toBe(0)
				expect(await page.locator('main .kit-btn, main .kit-icon, main .kit-badge, .kit-btn').count(), route).toBeGreaterThan(0)
			}
			finally { await context.close() }
		}
	}, 120_000)

	it('on a touch tablet the icon-only Open panel button is as wide as the 44px target is high', async () => {
		const { context, page } = await open(`/flows/${flowId}`, { touch: true, width: 1024, height: 768 })
		try {
			const panel = page.getByRole('button', { name: 'Open panel' })
			await panel.waitFor()
			expect(await hasClass(panel, 'is-icon-only')).toBe(true)
			expect(await panel.getAttribute('aria-expanded')).toBe('false')
			const box = await panel.boundingBox()
			expect(box?.width).toBeGreaterThanOrEqual(44)
			expect(box?.height).toBeGreaterThanOrEqual(44)
		}
		finally { await context.close() }
	}, 90_000)
})
