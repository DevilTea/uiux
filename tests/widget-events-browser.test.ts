import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Frame, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'
import { PREVIEW_WIRE_RECORDER, type WireRecord, type WireRecorderWindow } from './support/preview-wire-recorder'

/**
 * Widget Event reporting in the Prototype player (Part 2 decision group "Widget Event reporting",
 * with its Part 6 and Part 3 companions) against the built Workbench and a private Workspace copy.
 * The Flow and its Views are authored through the authoring API, never by editing canonical files.
 */

let server: WorkbenchServer
let browser: Browser
let payViewId = ''
let receiptViewId = ''
let flowId = ''
const steps = { pay: crypto.randomUUID(), retry: crypto.randomUUID(), receipt: crypto.randomUUID() }

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json', origin: server.origin },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await response.text()
	return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
}

async function createView(name: string, buttons: ReadonlyArray<[string, string]>, variants: Record<string, unknown> = {}): Promise<string> {
	const spec = { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('POST', '/api/views', { name, spec })
	const read = await api<{ revision: string }>('GET', `/api/resources/view/${view.body.key}`)
	const structure = await api('PUT', `/api/views/${view.body.key}/structure`, {
		expectedRevision: read.body.revision,
		ir: { id: 'root', type: 'RootShell', slots: { content: buttons.map(([id, label]) => ({ id, type: 'Button', config: { label } })) } },
		variants,
	})
	expect(structure.status).toBe(200)
	return view.body.key
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })
	payViewId = await createView('Pay step', [['pay-button', 'Pay now'], ['done-button', 'Finish']], { error: { state: {} } })
	receiptViewId = await createView('Receipt', [['again-button', 'Pay again']])
	const flow = await api<{ key: string }>('POST', '/api/flows', {
		name: 'Pay with real Events',
		entryStepId: steps.pay,
		steps: {
			[steps.pay]: { target: { viewId: payViewId }, transitions: [{ trigger: { widgetId: 'pay-button', event: 'click' }, targetStepId: steps.retry }] },
			[steps.retry]: {
				target: { viewId: payViewId, variantName: 'error' },
				transitions: [
					{ trigger: { widgetId: 'pay-button', event: 'click' }, targetStepId: steps.retry },
					{ trigger: { widgetId: 'done-button', event: 'click' }, targetStepId: steps.receipt },
				],
			},
			// `press` is not an Event the Button declares: it stays as authored, labelled, never rebound.
			[steps.receipt]: { target: { viewId: receiptViewId }, transitions: [{ trigger: { widgetId: 'again-button', event: 'press' }, targetStepId: steps.pay }] },
		},
	})
	expect(flow.status).toBe(201)
	flowId = flow.body.key
}, 90_000)

afterAll(async () => {
	await browser?.close()
	await server?.close()
})

/** Strips `widget.events` from every capability declaration the Workbench receives: a runtime build without the feature. */
const WITHOUT_WIDGET_EVENTS = `(() => {
	if (window.top !== window) return
	window.addEventListener('message', (event) => {
		const message = event.data && event.data.message
		if (message && message.type === 'capability.declare' && Array.isArray(message.payload && message.payload.features))
			message.payload.features = message.payload.features.filter((feature) => feature !== 'widget.events')
	}, true)
})()`

async function open(path: string, options: Readonly<{ width?: number; height?: number; withoutFeature?: boolean }> = {}): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: { width: options.width ?? 1920, height: options.height ?? 1080 }, colorScheme: 'light' })
	await context.addInitScript(() => {
		localStorage.setItem('nuxt-color-mode', 'light')
		localStorage.setItem('uiux.workbench.locale', 'en-US')
	})
	await context.addInitScript(PREVIEW_WIRE_RECORDER)
	if (options.withoutFeature) await context.addInitScript(WITHOUT_WIDGET_EVENTS)
	await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
	const page = await context.newPage()
	await page.goto(`${server.origin}${path}`, { waitUntil: 'networkidle' })
	await page.locator('main').first().waitFor()
	return { context, page }
}

async function generation(page: Page): Promise<string> {
	const src = await page.locator('iframe[src*="/preview"]').getAttribute('src')
	return new URL(src ?? '', server.origin).searchParams.get('generation') ?? ''
}

async function frameOf(page: Page): Promise<Frame> {
	const handle = await page.waitForSelector('iframe[src*="/preview"]', { timeout: 15_000 })
	const frame = await handle.contentFrame()
	if (!frame) throw new Error('Preview iframe has no content frame.')
	await frame.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	return frame
}

async function waitForGenerationChange(page: Page, previous: string): Promise<string> {
	await expect.poll(() => generation(page), { timeout: 15_000 }).not.toBe(previous)
	await frameOf(page)
	return generation(page)
}

const received = (target: Page | Frame) => target.evaluate(() => (window as unknown as WireRecorderWindow).__wire.messages)
const eventTraffic = async (target: Page | Frame): Promise<WireRecord[]> => (await received(target)).filter(message => message.type.startsWith('widget.event.'))
const armsOf = async (frame: Frame) => (await received(frame)).filter(message => message.type === 'widget.event.arm')
const occurrencesOf = async (page: Page) => (await received(page)).filter(message => message.type === 'widget.event.occurrence')

/** Waits until the current Preview document holds a non-empty arm, and returns it. */
async function waitArmed(page: Page): Promise<WireRecord> {
	const frame = await frameOf(page)
	await expect.poll(async () => ((await armsOf(frame)).at(-1)?.payload.triggers as unknown[] | undefined)?.length ?? 0, { timeout: 15_000 }).toBeGreaterThan(0)
	return (await armsOf(frame)).at(-1)!
}

const stepStatus = (page: Page) => page.locator('[data-flow-player] > p[role="status"]').textContent()

async function play(page: Page): Promise<string> {
	await page.locator('[data-flow-play]').click()
	await page.locator('[data-flow-player]').waitFor()
	return await waitForGenerationChange(page, '')
}

describe('Widget Event reporting in the Prototype player', () => {
	it('advances on a click of the real Button, once per double click, and never sends an argument', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			const first = await play(page)
			const arm = await waitArmed(page)
			expect(arm.payload.triggers).toEqual([{ widgetId: 'pay-button', event: 'click' }])
			expect(arm.context).toMatchObject({ viewId: payViewId, runtimeGenerationId: first })
			expect(arm.context.variantId).toBeUndefined()

			await (await frameOf(page)).locator('[data-widget-id="pay-button"]').click()
			const second = await waitForGenerationChange(page, first)
			await expect.poll(() => stepStatus(page)).toContain('Step 2:')
			const [occurrence] = await occurrencesOf(page)
			expect(occurrence).toMatchObject({ context: { widgetId: 'pay-button', viewId: payViewId, runtimeGenerationId: first }, payload: { armId: arm.payload.armId, event: 'click' } })
			expect(Object.keys(occurrence!.payload).sort()).toEqual(['armId', 'event'])
			// A real Event is not a Workbench-driven advance.
			expect(await page.locator('[data-flow-player-advanced]').count()).toBe(0)

			// The next step targets the error Variant: its arm carries the Variant name.
			const retryArm = await waitArmed(page)
			expect(retryArm.context).toMatchObject({ runtimeGenerationId: second, variantId: 'error' })
			expect(retryArm.payload.triggers).toEqual([{ widgetId: 'pay-button', event: 'click' }, { widgetId: 'done-button', event: 'click' }])

			// A double click on a self-loop trigger advances exactly once.
			await (await frameOf(page)).locator('[data-widget-id="pay-button"]').dblclick()
			const third = await waitForGenerationChange(page, second)
			await waitArmed(page)
			await page.waitForTimeout(1_000)
			expect(await generation(page)).toBe(third)
			await expect.poll(() => stepStatus(page)).toContain('Step 3:')
			expect(await occurrencesOf(page)).toHaveLength(2)
		}
		finally { await context.close() }
	}, 120_000)

	it('disarms for comment mode during playback, drops what happens there, and re-arms on exit', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			const first = await play(page)
			const arm = await waitArmed(page)
			const frame = await frameOf(page)
			const before = (await received(frame)).length

			await page.locator('[data-flow-player-restart]').focus()
			await page.keyboard.press('c')
			await expect.poll(async () => (await received(frame)).slice(before).map(message => message.type)).toContain('targeting.enter')
			const sequence = (await received(frame)).slice(before)
			// Disarm (an empty arm with a fresh armId) strictly before targeting.enter.
			const disarmIndex = sequence.findIndex(message => message.type === 'widget.event.arm')
			const enterIndex = sequence.findIndex(message => message.type === 'targeting.enter')
			expect(disarmIndex).toBeGreaterThanOrEqual(0)
			expect(disarmIndex).toBeLessThan(enterIndex)
			expect(sequence[disarmIndex]!.payload).toMatchObject({ triggers: [] })
			expect(sequence[disarmIndex]!.payload.armId).not.toBe(arm.payload.armId)
			expect(sequence[enterIndex]!.payload.purpose).toBe('comment-range')

			// A click in comment mode points at the Button; it does not navigate.
			await frame.locator('[data-widget-id="pay-button"]').click()
			await page.waitForTimeout(800)
			expect(await generation(page)).toBe(first)
			expect(await occurrencesOf(page)).toHaveLength(0)

			// Esc closes the composer, then leaves comment mode; nothing is replayed.
			for (let attempt = 0; attempt < 3; attempt++) {
				const last = (await received(frame)).filter(message => message.type.startsWith('targeting.')).at(-1)
				if (last?.type === 'targeting.exit') break
				await page.keyboard.press('Escape')
				await page.waitForTimeout(300)
			}
			await expect.poll(async () => (await received(frame)).filter(message => message.type.startsWith('targeting.')).at(-1)?.type).toBe('targeting.exit')
			const rearm = (await armsOf(frame)).at(-1)!
			expect(rearm.payload.triggers).toEqual(arm.payload.triggers)
			expect(new Set([arm.payload.armId, sequence[disarmIndex]!.payload.armId, rearm.payload.armId]).size).toBe(3)
			await page.waitForTimeout(500)
			expect(await generation(page)).toBe(first)
			expect(await page.locator('[data-flow-player]').count()).toBe(1)

			// A fresh click after the exit advances.
			await frame.locator('[data-widget-id="pay-button"]').click()
			await waitForGenerationChange(page, first)
			const [occurrence] = await occurrencesOf(page)
			expect(occurrence!.payload.armId).toBe(rearm.payload.armId)
		}
		finally { await context.close() }
	}, 120_000)

	it('keeps the dock and digits as keyboard-only Workbench advances, marked and never sent to the runtime', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			const first = await play(page)
			await waitArmed(page)
			await page.locator('[data-flow-player-next]').first().focus()
			await page.keyboard.press('Enter')
			const second = await waitForGenerationChange(page, first)
			await expect.poll(() => stepStatus(page)).toContain('Step 2:')
			const marked = page.locator('[data-flow-player-path] [data-flow-player-advanced="workbench"]')
			expect(await marked.count()).toBe(1)
			expect(await marked.textContent()).toContain('(advanced from the Workbench)')

			// Digit 2 follows the second listed transition (done-button → Receipt).
			expect(await page.locator('[data-flow-player-next]').nth(1).getAttribute('aria-keyshortcuts')).toBe('2')
			await page.keyboard.press('2')
			const third = await waitForGenerationChange(page, second)
			await expect.poll(() => stepStatus(page)).toContain('Step 3:')
			expect(await marked.count()).toBe(2)
			// A Workbench-driven advance posts nothing to the runtime and is no occurrence.
			expect(await occurrencesOf(page)).toHaveLength(0)

			// Only armed pairs are observed: the Receipt step arms `press`, so a click reports nothing.
			const arm = await waitArmed(page)
			expect(arm.payload.triggers).toEqual([{ widgetId: 'again-button', event: 'press' }])
			await (await frameOf(page)).locator('[data-widget-id="again-button"]').click()
			await page.waitForTimeout(800)
			expect(await generation(page)).toBe(third)
			expect(await occurrencesOf(page)).toHaveLength(0)
		}
		finally { await context.close() }
	}, 120_000)

	it('falls back to the dock with a notice when the runtime lacks widget.events', async () => {
		const { context, page } = await open(`/flows/${flowId}`, { withoutFeature: true })
		try {
			const first = await play(page)
			await page.locator('[data-flow-player-events-unavailable]').waitFor()
			expect(await page.locator('[data-flow-player-events-unavailable]').textContent()).toContain('This Preview can\'t report Widget Events. Use the Next controls to follow transitions.')
			const frame = await frameOf(page)
			await frame.locator('[data-widget-id="pay-button"]').click()
			await page.waitForTimeout(800)
			expect(await generation(page)).toBe(first)
			expect(await eventTraffic(frame)).toEqual([])
			await page.locator('[data-flow-player-next]').first().click()
			await waitForGenerationChange(page, first)
			await expect.poll(() => stepStatus(page)).toContain('Step 2:')
			expect(await eventTraffic(page)).toEqual([])
		}
		finally { await context.close() }
	}, 120_000)

	it('sends no widget.event.* message at all on the normal View canvas', async () => {
		const { context, page } = await open(`/views/${payViewId}`)
		try {
			const frame = await frameOf(page)
			await frame.locator('[data-widget-id="pay-button"]').click()
			await page.locator('[data-canvas-stage]').click({ position: { x: 8, y: 8 } })
			await page.keyboard.press('i')
			await frame.locator('[data-widget-id="pay-button"]').click()
			await frame.locator('[data-widget-id="done-button"]').dblclick()
			await page.waitForTimeout(800)
			expect(await eventTraffic(page)).toEqual([])
			expect(await eventTraffic(frame)).toEqual([])
		}
		finally { await context.close() }
	}, 90_000)

	it('picks a trigger\'s Event from the Widget\'s declared Events and keeps an undeclared value labelled', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator('[data-flow-edge]', { hasText: 'again-button.press' }).click()
			const inspector = page.locator('[data-flow-inspector]')
			const picker = inspector.locator('[data-flow-event-picker]')
			await picker.waitFor()
			expect(await picker.textContent()).toContain('press (not declared by this Widget)')
			await picker.click()
			const options = page.getByRole('option')
			await expect.poll(() => options.allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('click'), expect.stringContaining('press (not declared by this Widget)')]))
			await page.keyboard.press('Escape')
			// Nothing was rebound: the draft still holds the authored value.
			expect(await page.getByText('Unsaved changes').count()).toBe(0)
		}
		finally { await context.close() }
	}, 90_000)
})
