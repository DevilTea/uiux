import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * UX Flows graph editor and Prototype player (roadmap R11, brief g; Discussion #6) against the built
 * Workbench and a private copy of the dogfood Workspace. Every fixture is authored through the
 * authoring API, never by editing canonical files.
 */

const WORKBENCH_VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const MISSING_VIEW = '00000000-0000-4000-8000-00000000dead'

let server: WorkbenchServer
let browser: Browser
let paymentViewId = ''
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

async function readFlow(id: string) {
	return (await api<{ revision: string; resource: { name: string; entryStepId: string; steps: Record<string, unknown> } }>('GET', `/api/resources/flow/${id}`)).body
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	browser = await chromium.launch({ headless: true })

	const spec = { intent: 'Payment failed.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('POST', '/api/views', { name: 'Payment error', spec })
	paymentViewId = view.body.key
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

	// A Flow whose step targets a View that is not in the Workspace: valid in shape, not executable.
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

async function open(path: string, size: { width: number; height: number } = { width: 1920, height: 1080 }): Promise<{ context: BrowserContext; page: Page }> {
	const context = await browser.newContext({ viewport: size, colorScheme: 'light' })
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

async function generation(page: Page): Promise<string> {
	const src = await page.locator('iframe[src*="/preview"]').getAttribute('src')
	return new URL(src ?? '', server.origin).searchParams.get('generation') ?? ''
}

async function waitForGenerationChange(page: Page, previous: string): Promise<string> {
	await expect.poll(() => generation(page), { timeout: 15_000 }).not.toBe(previous)
	const frame = await (await page.waitForSelector('iframe[src*="/preview"]')).contentFrame()
	await frame?.waitForSelector('[data-preview-ready="true"]', { state: 'attached', timeout: 15_000 })
	return generation(page)
}

describe('UX Flow graph editor (R11)', () => {
	it('projects the keyed steps as a graph and an ordered list', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.waitForSelector('[data-flow-node]')
			expect(await page.locator('[data-flow-node]').count()).toBe(3)
			expect(await page.locator('[data-flow-edge]').allTextContents()).toEqual(['btn-run-checks.click', 'retry-button.click', 'done-button.click'])
			await page.getByRole('button', { name: 'List' }).click()
			const list = page.locator('[data-flow-list]')
			await list.waitFor()
			expect(await list.locator(':scope > li').count()).toBe(3)
			expect(await list.textContent()).toContain('retry-button.click')
			await page.getByRole('button', { name: 'Graph' }).click()
		}
		finally { await context.close() }
	}, 60_000)

	it('moves keyboard focus along transitions', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator(`[data-step-id="${steps.entry}"]`).focus()
			await page.keyboard.press('ArrowRight')
			expect(await page.evaluate(() => document.activeElement?.getAttribute('data-step-id'))).toBe(steps.payment)
			await page.keyboard.press('ArrowRight')
			expect(await page.evaluate(() => document.activeElement?.getAttribute('data-step-id'))).toBe(steps.done)
			await page.keyboard.press('ArrowLeft')
			expect(await page.evaluate(() => document.activeElement?.getAttribute('data-step-id'))).toBe(steps.payment)
			// Only one node is in the tab order.
			expect(await page.locator('[data-flow-node][tabindex="0"]').count()).toBe(1)
		}
		finally { await context.close() }
	}, 60_000)

	it('saves every edit in one update_flow with expectedRevision and keeps the draft on a conflict', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		const writes: Array<{ method: string; body: Record<string, unknown> }> = []
		await page.route('**/api/flows/**', async (route) => {
			const request = route.request()
			if (request.method() !== 'GET') writes.push({ method: request.method(), body: request.postDataJSON() as Record<string, unknown> })
			await route.continue()
		})
		try {
			const before = await readFlow(flowId)
			// Two edits: a new terminal transition target and a renamed Flow.
			await page.locator(`[data-step-id="${steps.done}"]`).click()
			await page.locator('[data-flow-inspector]').getByRole('button', { name: 'Add transition' }).click()
			await page.locator('[data-flow-inspector]').getByRole('button', { name: /^Widget/ }).click()
			await page.getByRole('option', { name: /#btn-export-handoff/ }).click()
			await page.waitForTimeout(300)
			// The Event is picked from the Widget's declared Events; a Button declares only `click`.
			await expect.poll(() => page.locator('[data-flow-inspector] [data-flow-event-picker]').textContent()).toContain('click')
			await page.locator('[data-flow-inspector]').getByRole('button', { name: 'Add', exact: true }).click()
			// The new transition is selected; the graph now draws a back edge to the entry step.
			expect(await page.locator('[data-flow-edge]', { hasText: 'btn-export-handoff.click' }).getAttribute('aria-pressed')).toBe('true')
			await page.locator('[data-flow-graph]').click({ position: { x: 40, y: 40 } })
			await page.getByRole('textbox', { name: /^Name/ }).fill('Checkout recovery, edited')
			expect(await page.getByText('Unsaved changes').count()).toBe(1)
			await page.locator('[data-flow-save]').click()
			await expect.poll(() => page.getByText('Unsaved changes').count()).toBe(0)

			expect(writes).toHaveLength(1)
			expect(writes[0]!.method).toBe('PUT')
			expect(writes[0]!.body.expectedRevision).toBe(before.revision)
			const after = await readFlow(flowId)
			expect(after.resource.name).toBe('Checkout recovery, edited')
			expect(JSON.stringify(after.resource.steps[steps.done])).toContain('btn-export-handoff')

			// An agent writes concurrently; the human's next save conflicts and keeps the draft.
			const agent = await api('PUT', `/api/flows/${flowId}`, { expectedRevision: after.revision, name: 'Checkout recovery (agent)', entryStepId: after.resource.entryStepId, steps: after.resource.steps })
			expect(agent.status).toBe(200)
			await page.getByRole('textbox', { name: /^Name/ }).fill('Human rename')
			await page.locator('[data-flow-save]').click()
			await page.locator('[data-flow-conflict]').waitFor()
			expect(await page.getByRole('textbox', { name: /^Name/ }).inputValue()).toBe('Human rename')
			expect((await readFlow(flowId)).resource.name).toBe('Checkout recovery (agent)')
			await page.getByRole('button', { name: 'Reload theirs' }).click()
			await expect.poll(() => page.getByRole('textbox', { name: /^Name/ }).inputValue()).toBe('Checkout recovery (agent)')
		}
		finally { await context.close() }
	}, 90_000)

	it('blocks Save on a structural problem and names it inline', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator(`[data-step-id="${steps.payment}"]`).click()
			await page.locator('[data-flow-inspector]').getByRole('button', { name: /done-button\.click/ }).click()
			await page.locator('[data-flow-inspector]').getByRole('button', { name: 'Remove transition' }).click()
			const problems = page.locator('[data-flow-problems]')
			await problems.waitFor()
			expect(await problems.textContent()).toContain('is unreachable from the entry step')
			expect(await page.locator('[data-flow-save]').isDisabled()).toBe(true)
			expect(await page.locator('[data-flow-play]').isDisabled()).toBe(true)
			expect(await page.locator(`[data-step-id="${steps.done}"]`).textContent()).toContain('Unreachable step')
			await page.getByRole('button', { name: 'Discard' }).click()
			await expect.poll(() => page.locator('[data-flow-problems]').count()).toBe(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('still renders an invalid Flow and blocks Play with the reason', async () => {
		const { context, page } = await open(`/flows/${brokenFlowId}?play=1`)
		try {
			await page.waitForSelector('[data-flow-node]')
			expect(await page.locator('[data-flow-player]').count()).toBe(0)
			expect(await page.locator('[data-flow-problems]').textContent()).toContain(`The View ${MISSING_VIEW} isn't in this Workspace.`)
			expect(await page.locator('[data-flow-play]').isDisabled()).toBe(true)
			expect(await page.getByText('Fix 1 problem to play this Flow.').count()).toBeGreaterThan(0)
		}
		finally { await context.close() }
	}, 60_000)

	it('is read-only on a tablet and a phone, where it still plays', async () => {
		for (const size of [{ width: 1024, height: 768 }, { width: 390, height: 844 }]) {
			const { context, page } = await open(`/flows/${flowId}`, size)
			try {
				await page.locator('[data-flow-play]').waitFor()
				expect(await page.locator('[data-flow-add-step]').count(), `${size.width}`).toBe(0)
				expect(await page.locator('[data-flow-play]').isDisabled(), `${size.width}`).toBe(false)
				if (size.width < 768) expect(await page.locator('[data-flow-list]').count()).toBe(1)
				else {
					await page.locator(`[data-step-id="${steps.payment}"]`).click()
					const inspector = page.locator('[role="dialog"] [data-flow-inspector]')
					await inspector.waitFor()
					expect(await inspector.locator('input, [role="combobox"]').count()).toBe(0)
				}
			}
			finally { await context.close() }
		}
	}, 90_000)
})

describe('Prototype player (R11, Discussion #6 item 6)', () => {
	it('starts at the entry step and creates a fresh runtime on every step entry', async () => {
		const { context, page } = await open(`/flows/${flowId}`)
		try {
			await page.locator('[data-flow-play]').click()
			await page.locator('[data-flow-player]').waitFor()
			const seen = [await waitForGenerationChange(page, '')]
			expect(await page.locator('[data-flow-player-path]').textContent()).toContain('UIUX Workbench')

			// Entering the next step, re-entering the same step through a self-loop, and restarting each
			// start a new runtime generation: no interaction state from an earlier entry survives.
			for (const trigger of ['btn-run-checks', 'retry-button', 'retry-button']) {
				await page.locator('[data-flow-player-next]', { hasText: trigger }).click()
				seen.push(await waitForGenerationChange(page, seen.at(-1)!))
			}
			expect(await page.locator('[data-flow-player-path] li').count()).toBeGreaterThanOrEqual(4)
			await page.locator('[data-flow-player-restart]').click()
			seen.push(await waitForGenerationChange(page, seen.at(-1)!))
			expect(new Set(seen).size).toBe(seen.length)
			expect(await page.locator('[data-flow-player-next]').textContent()).toContain('#btn-run-checks')

			// The step's Variant is fixed by the Flow and is not selectable in the player.
			await page.locator('[data-flow-player-next]').click()
			await waitForGenerationChange(page, seen.at(-1)!)
			expect(new URL(await page.locator('iframe[src*="/preview"]').getAttribute('src') ?? '', server.origin).searchParams.get('variant')).toBe('error')
			expect(await page.locator('[data-context="variant"]').isDisabled()).toBe(true)

			await page.keyboard.press('Escape')
			await expect.poll(() => new URL(page.url()).searchParams.get('play')).toBeNull()
			await page.locator('[data-flow-node]').first().waitFor()
		}
		finally { await context.close() }
	}, 120_000)
})
