import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { assertSameScreenshot } from './support/screenshot-diff'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * Formal UX Flow Evidence against the built server and a real Playwright capture and replay (Clause
 * 01a172cc-e195-711b-bfa9-5de6c1c8ff87, Rule 01a11544-66d9-7fcd-8400-93516ddf2857): a two-step Flow is
 * traced, each entered View and Variant is formally captured, each trigger is replayed as a real browser
 * action on the rendered Widget and asserted to emit its Event exactly once, and the stored `flow_trace`
 * record references the captures. The Views and Flows are authored through the authoring API.
 */

const STEP_A = '44444444-4444-4444-8444-444444444444'
const STEP_B = '55555555-5555-4555-8555-555555555555'
const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
const click = { action: 'click' }

let server: WorkbenchServer
let viewA = ''
let viewB = ''
let clickFlow = ''
let pressFlow = ''
let blockedFlow = ''
let changeFlow = ''

type Trace = {
	kind: string
	coverage: { complete: boolean }
	artifactRefs: unknown[]
	evidenceRefs: unknown[]
	executionContext: Record<string, unknown>
	provenance: { resources: { identity: unknown }[] }
	data: { recipe: { actions: { type: string; stepId: string; perform?: unknown }[] }; steps: Record<string, unknown>[] }
}
type Outcome = {
	status: string
	flowId: string
	evidenceDigest: string
	evidence: Trace
	captures: { viewId: string; variantName?: string; evidenceDigest: string; screenshotDigest: string }[]
	diagnostics?: { code: string; path: string }[]
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
	const response = await fetch(`${server.origin}${path}`, {
		method,
		headers: { ...server.headers, 'content-type': 'application/json', origin: server.origin },
		...(body === undefined ? {} : { body: JSON.stringify(body) }),
	})
	const text = await response.text()
	return { status: response.status, body: (text ? JSON.parse(text) : undefined) as T }
}

const trace = (flowId: string, recipe?: unknown) => api<Outcome>('POST', `/api/flows/${flowId}/evidence`, { renderContext, ...(recipe === undefined ? {} : { recipe }) })

async function authorView(name: string, widgetId: string, variants: Record<string, unknown>): Promise<string> {
	const spec = { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
	const created = await api<{ key: string }>('POST', '/api/views', { name, spec })
	const read = await api<{ revision: string }>('GET', `/api/resources/view/${created.body.key}`)
	const structure = await api('PUT', `/api/views/${created.body.key}/structure`, {
		expectedRevision: read.body.revision,
		ir: { id: 'root', type: 'RootShell', slots: { content: [{ id: widgetId, type: 'Button', config: { label: name } }] } },
		variants,
	})
	expect(structure.status, JSON.stringify(structure.body)).toBe(200)
	return created.body.key
}

async function authorFlow(name: string, event: string, variantName?: string): Promise<string> {
	const flow = await api<{ key: string }>('POST', '/api/flows', {
		name,
		entryStepId: STEP_A,
		steps: {
			[STEP_A]: { target: { viewId: viewA, ...(variantName ? { variantName } : {}) }, transitions: [{ trigger: { widgetId: 'pay-button', event }, targetStepId: STEP_B }] },
			[STEP_B]: { target: { viewId: viewB, variantName: 'done' }, transitions: [] },
		},
	})
	expect(flow.status, JSON.stringify(flow.body)).toBe(201)
	return flow.body.key
}

beforeAll(async () => {
	server = await startWorkbenchServer()
	viewA = await authorView('Pay', 'pay-button', { blocked: { state: { 'pay-button': { disabled: true } } } })
	viewB = await authorView('Done', 'done-button', { done: { state: {} } })
	// The reference Adapter's Button declares `click`, not `press`.
	clickFlow = await authorFlow('Pay by click', 'click')
	pressFlow = await authorFlow('Pay by press', 'press')
	// A disabled Button cannot be clicked.
	blockedFlow = await authorFlow('Pay while blocked', 'click', 'blocked')
	changeFlow = await authorFlow('Pay by change', 'change')
}, 90_000)

afterAll(async () => {
	await server?.close()
})

describe('formal UX Flow Evidence over a real capture and replay', () => {
	it('derives a click for a click trigger, captures each entered View and Variant, replays it as a real click, and stores a trace that references the captures', async () => {
		const recipe = { actions: [
			{ type: 'enter', stepId: STEP_A, expect: { viewId: viewA } },
			{ type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'pay-button', event: 'click' }, perform: click, expect: { resultStepId: STEP_B } },
			{ type: 'enter', stepId: STEP_B, expect: { viewId: viewB, variantName: 'done' } },
		] }
		const response = await trace(clickFlow)
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		const outcome = response.body
		expect(outcome.status).toBe('captured')

		// One formal capture per distinct View and Variant the recipe enters.
		expect(outcome.captures.map(capture => [capture.viewId, capture.variantName])).toEqual([[viewA, undefined], [viewB, 'done']])
		const stored = await api<Trace>('GET', `/api/artifacts/${outcome.evidenceDigest}`)
		expect(stored.body).toEqual(JSON.parse(JSON.stringify(outcome.evidence)))
		expect(validateFormalEvidenceRecord(stored.body).diagnostics).toEqual([])
		expect(stored.body).toMatchObject({
			schemaVersion: 1,
			kind: 'flow_trace',
			executionContext: { flowId: clickFlow, ...renderContext },
			coverage: { complete: true },
			artifactRefs: [],
		})
		// The Button's Event click occurred exactly once when the Button was really clicked: the step is valid.
		expect(stored.body.data.steps).toEqual([
			{ stepId: STEP_A, viewId: viewA, trigger: { widgetId: 'pay-button', event: 'click' }, resultStepId: STEP_B, valid: true, captureRef: outcome.captures[0]!.evidenceDigest },
			{ stepId: STEP_B, viewId: viewB, variantName: 'done', valid: true, captureRef: outcome.captures[1]!.evidenceDigest },
		])
		expect(stored.body.data.recipe).toEqual(recipe)
		expect(stored.body.evidenceRefs).toEqual(outcome.captures.map(capture => ({ kind: 'formal_capture', evidence: capture.evidenceDigest })).sort((a, b) => a.evidence.localeCompare(b.evidence)))
		expect(stored.body.provenance.resources).toEqual(expect.arrayContaining([
			expect.objectContaining({ identity: { type: 'flow', id: clickFlow } }),
			expect.objectContaining({ identity: { type: 'view', id: viewA } }),
			expect.objectContaining({ identity: { type: 'view', id: viewB } }),
		]))
		// Each referenced capture is a stored formal capture of that View and Variant, with its screenshot.
		for (const capture of outcome.captures) {
			const formal = await api<{ kind: string; artifactRefs: string[] }>('GET', `/api/artifacts/${capture.evidenceDigest}`)
			expect(formal.body).toMatchObject({ kind: 'formal_capture', artifactRefs: [capture.screenshotDigest] })
		}

		// The stored recipe replays to the same trace: formal captures are deterministic (issue #344), so the captures' identities and the trace's own identity match.
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const again = (await trace(clickFlow, stored.body.data.recipe)).body
		expect(again.status).toBe('captured')
		for (const [index, capture] of again.captures.entries()) await assertSameScreenshot(`flow-replay-${index}`, digest => persistence.artifacts.read(digest), outcome.captures[index]!, capture)
		expect(again.evidence.data.steps).toEqual(stored.body.data.steps)
		expect(again.captures).toEqual(outcome.captures)
		expect(again.evidenceDigest).toBe(outcome.evidenceDigest)

		// An unknown Locale is the caller's render context, refused before anything is recorded.
		const unknown = await api<Outcome>('POST', `/api/flows/${clickFlow}/evidence`, { renderContext: { ...renderContext, locale: 'fr-FR' } })
		expect(unknown.body.status).toBe('invalid')
	}, 180_000)

	it('records a trigger whose Event the Widget does not emit as valid false, not as a held transition', async () => {
		// Derivation defaults a press trigger to a click; the Button is clicked, but it declares no press Event.
		const response = await trace(pressFlow)
		expect(response.status, JSON.stringify(response.body)).toBe(200)
		expect(response.body.status).toBe('captured')
		expect(response.body.evidence.data.recipe.actions.map(action => [action.type, action.perform])).toEqual([['enter', undefined], ['trigger', click], ['enter', undefined]])
		expect(response.body.evidence.data.steps.map(step => step.valid)).toEqual([false, true])
	}, 180_000)

	it('refuses a derived recipe whose trigger Event is neither press nor click, before a browser runs, and records nothing', async () => {
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const before = await persistence.artifacts.listIdentities()
		const response = await trace(changeFlow)
		expect(response.status).toBe(422)
		expect(response.body).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_perform_required', path: '/recipe/actions/1/perform' }] })
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	}, 60_000)

	it('fails the run, keeping the formal captures and recording no trace, when the action cannot be performed', async () => {
		const persistence = new FileNativePersistence({ root: server.workspaceRoot, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const before = await persistence.artifacts.listIdentities()
		// A disabled Button cannot be clicked: the step times out.
		const response = await trace(blockedFlow, { actions: [
			{ type: 'enter', stepId: STEP_A, expect: { viewId: viewA, variantName: 'blocked' } },
			{ type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'pay-button', event: 'click' }, perform: click, expect: { resultStepId: STEP_B } },
			{ type: 'enter', stepId: STEP_B, expect: { viewId: viewB, variantName: 'done' } },
		] })
		expect(response.status).toBe(422)
		expect(response.body).toMatchObject({ status: 'failed', flowId: blockedFlow, diagnostics: [{ code: 'interaction.step_failed' }] })
		const kinds = await Promise.all((await persistence.artifacts.listIdentities()).filter(identity => !before.includes(identity))
			.map(async identity => (await persistence.artifacts.readCandidateJson(identity) as { kind?: string } | undefined)?.kind))
		expect(kinds).toContain('formal_capture')
		expect(kinds).not.toContain('flow_trace')
	}, 120_000)
})
