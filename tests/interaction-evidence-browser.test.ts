import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { bearer } from './support/access'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Replayable interaction Evidence against the built server and a real Playwright replay (Rules
 * 01a115cd-c507-738d-abd7-7a4194761319 and 01a11544-66d9-7fcd-8400-93516ddf2857, Clause
 * 01a17762-b85b-77d6-a399-e26843475501): real browser actions are dispatched in the Preview of the formal
 * capture harness, and each assertion is decided from the declared Widget Event or State the Runtime
 * observed. The View is authored through the authoring API, never by editing canonical files.
 */

let server: WorkbenchServer
let viewId = ''
let agent: Client

const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }

type Outcome = { status: string; viewId: string; evidenceDigest?: string; evidence?: { coverage: { complete: boolean }; executionContext: Record<string, unknown>; data: { steps: unknown[]; assertions: { expect: unknown; result: string }[]; captures: string[] }; evidenceRefs: unknown[]; artifactRefs: unknown[] }; captures?: { viewId: string; variantName?: string; evidenceDigest: string; screenshotDigest: string }[]; diagnostics?: { code: string }[] }

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json', origin: server.origin },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await response.text()
	return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
}

const post = (body: unknown) => api<Outcome>('POST', '/api/evidence/interactions', body)

beforeAll(async () => {
	server = await startWorkbenchServer()
	const spec = { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const view = await api<{ key: string }>('POST', '/api/views', { name: 'Pay', spec })
	viewId = view.body.key
	const read = await api<{ revision: string }>('GET', `/api/resources/view/${viewId}`)
	const structure = await api('PUT', `/api/views/${viewId}/structure`, {
		expectedRevision: read.body.revision,
		ir: {
			id: 'root',
			type: 'RootShell',
			slots: {
				content: [
					{ id: 'name-input', type: 'TextInput', config: { label: 'Name' } },
					{ id: 'pay-button', type: 'Button', config: { label: 'Pay now' } },
				],
			},
		},
		variants: { error: { state: {} }, blocked: { state: { 'pay-button': { disabled: true } } } },
	})
	expect(structure.status, JSON.stringify(structure.body)).toBe(200)
	agent = new Client({ name: 'uiux-interaction-evidence-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	await agent.connect(new StreamableHTTPClientTransport(new URL(`${server.origin}/mcp`), { requestInit: { headers: bearer(server.token) } }))
}, 90_000)

afterAll(async () => {
	await agent?.close()
	await server?.close()
})

const target = (widgetId: string, variant?: string) => ({ viewId, ...(variant ? { variant } : {}), widgetId })

describe('replayable interaction Evidence over a real replay', () => {
	it('clicks the real Button and records that the declared Widget Event was observed, with its capture', async () => {
		const response = await post({
			viewId,
			renderContext,
			steps: [{ action: 'click', target: target('pay-button') }],
			assertions: [
				{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } },
				// The Button emits click with no argument.
				{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: [] } } },
				{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: [1] } } },
				// An Event the Button does not declare is never observed.
				{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'press' } } },
				{ expect: { state: { widgetId: 'pay-button', key: 'disabled', value: false } } },
			],
		})
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		const { evidence, evidenceDigest, captures } = response.body
		expect(evidence!.data.assertions.map(assertion => assertion.result)).toEqual(['pass', 'pass', 'fail', 'fail', 'pass'])
		expect(validateFormalEvidenceRecord(evidence).diagnostics).toEqual([])
		expect(evidence).toMatchObject({ kind: 'interaction_replay', schemaVersion: 1, coverage: { complete: true }, executionContext: { viewId, ...renderContext }, artifactRefs: [] })
		expect(evidence!.data.steps).toEqual([{ action: 'click', target: { viewId, widgetId: 'pay-button' } }])

		// The record references the formal capture of the View in the render context, which is stored with its screenshot.
		expect(captures).toHaveLength(1)
		expect(evidence!.data.captures).toEqual([captures![0]!.evidenceDigest])
		expect(evidence!.evidenceRefs).toEqual([{ kind: 'formal_capture', evidence: captures![0]!.evidenceDigest }])
		const capture = await api<{ kind: string; artifactRefs: string[] }>('GET', `/api/artifacts/${captures![0]!.evidenceDigest}`)
		expect(capture.status).toBe(200)
		expect(capture.body).toMatchObject({ kind: 'formal_capture', artifactRefs: [captures![0]!.screenshotDigest] })
		const record = await api<{ kind: string }>('GET', `/api/artifacts/${evidenceDigest}`)
		expect(record.body).toMatchObject({ kind: 'interaction_replay' })

		// MCP and HTTP report the same result: the replay and the formal capture are deterministic.
		const viaMcp = await agent.callTool({
			name: 'capture_interaction_evidence',
			arguments: {
				viewId,
				renderContext,
				steps: [{ action: 'click', target: target('pay-button') }],
				assertions: [
					{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } },
					{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: [] } } },
					{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: [1] } } },
					{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'press' } } },
					{ expect: { state: { widgetId: 'pay-button', key: 'disabled', value: false } } },
				],
			},
		})
		expect(viaMcp.isError).toBeUndefined()
		expect(viaMcp.structuredContent).toEqual(JSON.parse(JSON.stringify(response.body)))
	}, 120_000)

	it('records result fail, with the capture, when the actions do not cause the asserted Event', async () => {
		const response = await post({
			viewId,
			renderContext,
			steps: [{ action: 'hover', target: target('pay-button') }],
			assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } }],
		})
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		expect(response.body.evidence!.data.assertions).toEqual([{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } }, result: 'fail' }])
		expect(response.body.evidence!.data.captures).toEqual([response.body.captures![0]!.evidenceDigest])
		expect(response.body.evidence!.coverage.complete).toBe(true)
	}, 120_000)

	it('types into a TextInput and presses a key, and reads the Widget State afterwards', async () => {
		const response = await post({
			viewId,
			variant: 'error',
			renderContext,
			steps: [
				{ action: 'type', target: target('name-input', 'error'), text: 'hello' },
				{ action: 'press', target: target('name-input', 'error'), key: 'Backspace' },
				{ action: 'click', target: target('pay-button', 'error') },
			],
			assertions: [
				{ expect: { state: { widgetId: 'name-input', key: 'value', value: 'hell' } } },
				{ expect: { state: { widgetId: 'name-input', key: 'value', value: 'hello' } } },
				{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } },
			],
		})
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		expect(response.body.evidence!.data.assertions.map(assertion => assertion.result)).toEqual(['pass', 'fail', 'pass'])
		expect(response.body.evidence!.executionContext).toMatchObject({ viewId, variantName: 'error' })
		expect(response.body.captures![0]).toMatchObject({ viewId, variantName: 'error' })
	}, 120_000)

	it('reads State of a disabled Button, and fails the run, keeping the capture, when a step cannot be performed', async () => {
		const state = await post({
			viewId,
			variant: 'blocked',
			renderContext,
			steps: [{ action: 'hover', target: target('pay-button', 'blocked') }],
			assertions: [{ expect: { state: { widgetId: 'pay-button', key: 'disabled', value: true } } }],
		})
		expect(state.status, JSON.stringify(state.body)).toBe(200)
		expect(state.body.evidence!.data.assertions.map(assertion => assertion.result)).toEqual(['pass'])

		// A disabled Button cannot be clicked: the step times out, nothing but the formal capture is stored.
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const before = await persistence.artifacts.listIdentities()
		const failed = await post({
			viewId,
			variant: 'blocked',
			renderContext,
			steps: [{ action: 'click', target: target('pay-button', 'blocked') }],
			assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } }],
		})
		expect(failed.status).toBe(422)
		expect(failed.body).toMatchObject({ status: 'failed', viewId, diagnostics: [{ code: 'interaction.step_failed' }] })
		const kinds = await Promise.all((await persistence.artifacts.listIdentities()).filter(identity => !before.includes(identity))
			.map(async identity => (await persistence.artifacts.readCandidateJson(identity) as { kind?: string } | undefined)?.kind))
		expect(kinds).not.toContain('interaction_replay')
	}, 120_000)

	it('refuses an input the Clauses refuse over HTTP without launching a browser', async () => {
		const response = await post({ viewId, renderContext: { ...renderContext, viewportId: 'tv' }, steps: [{ action: 'click', target: target('pay-button') }], assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } }] })
		expect(response.status).toBe(422)
		expect(response.body).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'render_context.unknown_viewport' }] })
		expect((await post({ viewId, renderContext, steps: [{ action: 'click', target: target('ghost') }], assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } }] })).body)
			.toMatchObject({ status: 'invalid', diagnostics: [{ code: 'interaction.unknown_widget', path: '/steps/0/target/widgetId' }] })
		// widgetId is required on every expectation: there is no default to the last step's Widget.
		expect((await post({ viewId, renderContext, steps: [{ action: 'click', target: target('pay-button') }], assertions: [{ expect: { widgetEvent: { name: 'click' } } }] })).body)
			.toMatchObject({ status: 'invalid', diagnostics: [{ code: 'interaction.invalid_recipe', path: '/assertions/0/expect/widgetEvent/widgetId' }] })
	}, 60_000)

	it('counts matching occurrences exactly with count, and passes on any matching occurrence without it', async () => {
		const click = { widgetId: 'pay-button', name: 'click' }
		const response = await post({
			viewId,
			renderContext,
			steps: [{ action: 'click', target: target('pay-button') }, { action: 'click', target: target('pay-button') }],
			assertions: [
				{ expect: { widgetEvent: click } },
				{ expect: { widgetEvent: { ...click, count: 2 } } },
				{ expect: { widgetEvent: { ...click, count: 1 } } },
				{ expect: { widgetEvent: { ...click, payload: [], count: 2 } } },
				{ expect: { widgetEvent: { ...click, payload: [1], count: 0 } } },
			],
		})
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		expect(response.body.evidence!.data.assertions.map(assertion => assertion.result)).toEqual(['pass', 'pass', 'fail', 'pass', 'pass'])
	}, 120_000)

	it('installs the capture harness hooks, including the interaction probe, only when harness is formal', async () => {
		const browser = await chromium.launch({ headless: true })
		try {
			const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })
			await context.addCookies([{ ...server.cookie, url: server.origin, httpOnly: true, sameSite: 'Strict' }])
			const hookNames = async (harness: boolean) => {
				const page = await context.newPage()
				const url = new URL(`${server.origin}/preview`)
				for (const [key, value] of Object.entries({ viewId, locale: 'en-US', viewportId: 'desktop', viewportWidth: '1280', viewportHeight: '800', themeId: 'light' })) url.searchParams.set(key, value)
				if (harness) url.searchParams.set('harness', 'formal')
				await page.goto(url.href, { waitUntil: 'load' })
				await page.waitForSelector('[data-preview-status]:not([data-preview-status="loading"])', { timeout: 15_000 })
				const names = await page.evaluate(() => {
					const hooks = (window as unknown as Record<string, Record<string, unknown> | undefined>).__UIUX_CAPTURE_HARNESS__
					return hooks ? Object.keys(hooks).sort() : null
				})
				await page.close()
				return names
			}
			expect(await hookNames(false)).toBeNull()
			expect(await hookNames(true)).toEqual(['applyVariantStateLive', 'evaluateTranslations', 'readWidgetState', 'watchWidgetEvent', 'widgetEventOccurrences'])
		}
		finally { await browser.close() }
	}, 60_000)
})
