import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import { deriveFlowRecipe, flowRecipeEntries, validateFlowRecipe } from '../src/domain/flows/recipe'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { captureFlowEvidenceForHttp, validateFlowForHttp } from '../src/server/flows-http'
import { AGENT_EDITOR } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_A = '11111111-1111-4111-8111-111111111111'
const VIEW_B = '33333333-3333-4333-8333-333333333333'
const GONE_VIEW = '99999999-9999-4999-8999-999999999999'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const STEP_A = '44444444-4444-4444-8444-444444444444'
const STEP_B = '55555555-5555-4555-8555-555555555555'
const STEP_C = '66666666-6666-4666-8666-666666666666'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function twoStepFlow(): FlowResource {
	return {
		id: FLOW_ID,
		name: 'Two steps',
		entryStepId: STEP_A,
		steps: {
			[STEP_A]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'root', event: 'press' }, targetStepId: STEP_B }] },
			[STEP_B]: { target: { viewId: VIEW_B }, transitions: [] },
		},
	}
}

describe('Flow replay recipe (Clauses 01a172cc-d6f0-714d-b2fb-bd66e13c73a5 and 01a172cc-daa6-7a0e-960e-fa996e0a58c5)', () => {
	it('derives a recipe that enters every step and takes every transition, in a fixed order', () => {
		const flow: FlowResource = {
			...twoStepFlow(),
			steps: {
				[STEP_A]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'z', event: 'press' }, targetStepId: STEP_C }, { trigger: { widgetId: 'a', event: 'press' }, targetStepId: STEP_B }] },
				[STEP_B]: { target: { viewId: VIEW_B, variantName: 'done' }, transitions: [{ trigger: { widgetId: 'a', event: 'back' }, targetStepId: STEP_A }] },
				[STEP_C]: { target: { viewId: VIEW_B }, transitions: [] },
			},
		}
		const recipe = deriveFlowRecipe(flow)
		expect(validateFlowRecipe(recipe, flow)).toEqual([])
		expect(recipe.actions.map(action => [action.type, action.stepId, action.type === 'trigger' ? action.trigger.widgetId : ''])).toEqual([
			['enter', STEP_A, ''], ['trigger', STEP_A, 'a'],
			['enter', STEP_A, ''], ['trigger', STEP_A, 'z'],
			['enter', STEP_B, ''], ['trigger', STEP_B, 'a'],
			['enter', STEP_C, ''],
		])
		expect(flowRecipeEntries(recipe)).toEqual([
			{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'a', event: 'press' }, resultStepId: STEP_B },
			{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'z', event: 'press' }, resultStepId: STEP_C },
			{ stepId: STEP_B, viewId: VIEW_B, variantName: 'done', trigger: { widgetId: 'a', event: 'back' }, resultStepId: STEP_A },
			{ stepId: STEP_C, viewId: VIEW_B },
		])
		expect(deriveFlowRecipe(flow)).toEqual(recipe)
	})

	it('refuses a recipe that names what the Flow lacks or asserts what it does not hold', () => {
		const flow = twoStepFlow()
		const enter = { type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } }
		const trigger = { type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'press' }, expect: { resultStepId: STEP_B } }
		const codes = (recipe: unknown) => validateFlowRecipe(recipe, flow).map(item => item.code)
		expect(codes({ actions: [enter, trigger] })).toEqual([])
		expect(codes(undefined)).toEqual(['flow.recipe_invalid_shape'])
		expect(codes({ actions: [] })).toEqual(['flow.recipe_invalid_shape'])
		expect(codes({ actions: [{ ...enter, stepId: STEP_C }] })).toEqual(['flow.recipe_unknown_step'])
		expect(codes({ actions: [{ ...enter, expect: { viewId: VIEW_B } }] })).toEqual(['flow.recipe_assertion_failed'])
		expect(codes({ actions: [{ ...enter, expect: { viewId: VIEW_A, variantName: 'x' } }] })).toEqual(['flow.recipe_assertion_failed'])
		expect(codes({ actions: [trigger] })).toEqual(['flow.recipe_orphan_trigger'])
		expect(codes({ actions: [enter, trigger, trigger] })).toEqual(['flow.recipe_orphan_trigger'])
		expect(codes({ actions: [enter, { ...trigger, trigger: { widgetId: 'root', event: 'other' } }] })).toEqual(['flow.recipe_unknown_trigger'])
		expect(codes({ actions: [enter, { ...trigger, expect: { resultStepId: STEP_A } }] })).toEqual(['flow.recipe_assertion_failed'])
		expect(codes({ actions: [enter], extra: 1 })).toEqual(['flow.recipe_invalid_shape'])
	})
})

describe('flow_trace Evidence record (Clause 01a172cc-d382-7cd3-b140-6320d2065edc)', () => {
	const capture = `sha256:${'a'.repeat(64)}`
	const record = (patch: Record<string, unknown> = {}) => ({
		schemaVersion: 1,
		kind: 'flow_trace',
		executionContext: { flowId: FLOW_ID, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
		evidenceRefs: [{ kind: 'formal_capture', evidence: capture }],
		data: {
			recipe: { actions: [{ type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } }] },
			steps: [{ stepId: STEP_A, viewId: VIEW_A, valid: true, captureRef: capture }],
		},
		...patch,
	})

	it('accepts a trace whose steps, recipe and references agree', () => {
		expect(validateFormalEvidenceRecord(record()).diagnostics).toEqual([])
	})

	it('refuses a trace that disagrees with itself', () => {
		const codes = (patch: Record<string, unknown>) => validateFormalEvidenceRecord(record(patch)).diagnostics.map(item => item.code)
		expect(codes({ executionContext: { flowId: FLOW_ID, locale: 'en-US' } })).toContain('schema.expected_string')
		expect(codes({ artifactRefs: [capture] })).toEqual(['evidence.invalid_flow_trace'])
		expect(codes({ evidenceRefs: [] })).toEqual(['evidence.flow_trace_mismatch'])
		expect(codes({ evidenceRefs: [{ kind: 'formal_capture', evidence: `sha256:${'b'.repeat(64)}` }] })).toEqual(['evidence.flow_trace_mismatch'])
		expect(codes({ data: { recipe: { actions: [] }, steps: [] } })).toContain('evidence.invalid_flow_trace')
		expect(codes({ data: { recipe: { actions: [{ type: 'enter', stepId: STEP_A }] }, steps: [] } })).toContain('evidence.flow_trace_mismatch')
		expect(codes({ data: { recipe: { actions: [{ type: 'enter', stepId: STEP_A }] }, steps: [{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'w', event: 'e' }, valid: true, captureRef: capture }] } })).toContain('evidence.invalid_flow_trace')
		expect(codes({ data: { recipe: { actions: [{ type: 'enter', stepId: STEP_A }] }, steps: [{ stepId: STEP_A, viewId: VIEW_A, valid: 'yes', captureRef: 'x' }] } })).toEqual(expect.arrayContaining(['evidence.invalid_flow_trace', 'identity.invalid_sha256']))
	})

	it('is stored as an immutable record whose identity is its canonical bytes', () => {
		expect(canonicalJsonBytes(record())).toEqual(canonicalJsonBytes(record()))
	})
})

describe('validate_flow and capture_flow_evidence refusals', () => {
	it('reports diagnostics identically through the application, HTTP helpers and MCP', async () => {
		const { app } = await seededSession({ ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_B]: { target: { viewId: GONE_VIEW }, transitions: [] } } })
		const application = await app.validateFlow(FLOW_ID)
		expect(application).toMatchObject({ flowId: FLOW_ID, valid: false })
		if ('status' in application) return
		expect(application.diagnostics.map(item => [item.code, item.path])).toEqual([['flow.missing_view', `/steps/${STEP_B}/target/viewId`]])
		const http = await validateFlowForHttp(app, FLOW_ID)
		expect(http).toEqual({ status: 200, body: application })
		expect(await validateFlowForHttp(app, '77777777-7777-4777-8777-777777777777')).toMatchObject({ status: 404, body: { status: 'not_found' } })
		expect(await validateFlowForHttp(app, 'not-a-uuid')).toMatchObject({ status: 404 })

		await withMcp(app, async (client) => {
			expect((await client.listTools()).tools.find(tool => tool.name === 'validate_flow')?.annotations?.readOnlyHint).toBe(true)
			const result = await client.callTool({ name: 'validate_flow', arguments: { flowId: FLOW_ID } })
			expect(result.isError).toBeUndefined()
			expect(result.structuredContent).toEqual(JSON.parse(JSON.stringify(application)))
			const missing = await client.callTool({ name: 'validate_flow', arguments: { flowId: '77777777-7777-4777-8777-777777777777' } })
			expect(missing.isError).toBe(true)
			expect(missing.structuredContent).toEqual({ status: 'not_found', flowId: '77777777-7777-4777-8777-777777777777' })
		})
	})

	it('reports a valid Flow as valid', async () => {
		const { app } = await seededSession(twoStepFlow())
		expect(await app.validateFlow(FLOW_ID)).toMatchObject({ flowId: FLOW_ID, valid: true, diagnostics: [] })
	})

	it('refuses to capture a Flow with a reference diagnostic, before any browser runs, and records nothing', async () => {
		const flow = { ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_A]: { target: { viewId: VIEW_A, variantName: 'gone' }, transitions: [{ trigger: { widgetId: 'ghost', event: 'press' }, targetStepId: STEP_B }] } } }
		const { app, root } = await seededSession(flow)
		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		const refused = await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext })
		expect(refused.status).toBe('invalid')
		if (refused.status !== 'invalid') return
		expect(refused.diagnostics.map(item => item.code).sort()).toEqual(['flow.missing_variant', 'flow.missing_widget'])
		expect(await captureFlowEvidenceForHttp(app, FLOW_ID, { renderContext })).toMatchObject({ status: 422, body: { status: 'invalid' } })
		await withMcp(app, async (client) => {
			const result = await client.callTool({ name: 'capture_flow_evidence', arguments: { flowId: FLOW_ID, renderContext } })
			expect(result.isError).toBe(true)
			expect(result.structuredContent).toMatchObject({ status: 'invalid', flowId: FLOW_ID })
		})
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect(await persistence.artifacts.readAllCandidateJson({ select: () => undefined })).toEqual([])
	})

	it('refuses an unknown Flow, a render context or recipe the Flow does not match, and an unknown viewport', async () => {
		const { app } = await seededSession(twoStepFlow())
		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		expect(await app.captureFlowEvidence({ flowId: '77777777-7777-4777-8777-777777777777', renderContext })).toEqual({ status: 'not_found', flowId: '77777777-7777-4777-8777-777777777777' })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { locale: 'en-US' } as never })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.invalid_render_context' }] })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { ...renderContext, viewportId: 'tv' } })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'render_context.unknown_viewport' }] })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext, recipe: { actions: [{ type: 'enter', stepId: STEP_B, expect: { viewId: VIEW_A } }] } })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_assertion_failed' }] })
	})

	it('blocks the Handoff readiness of a Flow root with a reference diagnostic (Clause 01a172cc-e51b-78a2-b96b-d7788a02a823)', async () => {
		const flow = { ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_B]: { target: { viewId: VIEW_B, variantName: 'gone' }, transitions: [] } } }
		const { app } = await seededSession(flow)
		const assessment = await app.assessHandoffReadiness({ roots: [{ type: 'flow', flowId: FLOW_ID }] })
		const blocking = JSON.stringify(assessment)
		expect(blocking).toContain('flow.missing_variant')
		expect(blocking).toContain(`/flows/${FLOW_ID}/steps/${STEP_B}/target/variantName`)
		expect(JSON.stringify((await (await seededSession(twoStepFlow())).app.assessHandoffReadiness({ roots: [{ type: 'flow', flowId: FLOW_ID }] })))).not.toContain('flow.missing')
	})
})

async function withMcp(app: ReturnType<typeof createWorkspaceApplicationSession>, run: (client: Client) => Promise<void>): Promise<void> {
	const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
	const client = new Client({ name: 'uiux-flow-evidence-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
	const transport = new StreamableHTTPClientTransport(new URL('http://uiux.test/mcp'), {
		fetch: async (input, init) => handler.fetch(new Request(input, init), { authInfo: principalAuthInfo(AGENT_EDITOR) }),
	})
	try {
		await client.connect(transport)
		await run(client)
	}
	finally {
		await client.close()
		await handler.close()
	}
}

async function seededSession(flow: FlowResource) {
	const root = await mkdtemp(join(tmpdir(), 'uiux-flow-evidence-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	for (const id of [VIEW_A, VIEW_B]) await persistence.views.create(id, view(id))
	await persistence.locales.create('en-US', { title: 'Title' })
	await persistence.flows.create(flow.id, flow)
	return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
}

function view(id: string): ViewResource {
	return {
		id,
		name: `View ${id.slice(0, 2)}`,
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}
