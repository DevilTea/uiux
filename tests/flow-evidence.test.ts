import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createFlowEvidenceService } from '../src/application/services/flow-evidence'
import type { CaptureFormalEvidenceCommand, CaptureFormalEvidenceResult, ReplayInteractionsCommand } from '../src/application/services/formal-capture'
import type { InteractionReplayOutcome } from '../src/application/services/interaction-replay'
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
import { AGENT_EDITOR, scoped, testMember } from './support/access'
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
		requirements: [],
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
				[STEP_A]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'z', event: 'click' }, targetStepId: STEP_C }, { trigger: { widgetId: 'a', event: 'press' }, targetStepId: STEP_B }] },
				[STEP_B]: { target: { viewId: VIEW_B, variantName: 'done' }, transitions: [{ trigger: { widgetId: 'a', event: 'back' }, targetStepId: STEP_A }] },
				[STEP_C]: { target: { viewId: VIEW_B }, transitions: [] },
			},
		}
		const recipe = deriveFlowRecipe(flow)
		// Only a press or click trigger defaults to a click (owner rulings of #241 comments 19197851 and 19200269): the `back` trigger states no perform, so the derived recipe is refused.
		expect(validateFlowRecipe(recipe, flow).map(item => [item.code, item.path])).toEqual([['flow.recipe_perform_required', '/recipe/actions/5/perform']])
		const performed = { actions: recipe.actions.map(action => action.type === 'trigger' && action.trigger.event === 'back' ? { ...action, perform: { action: 'hover' } } : action) }
		expect(validateFlowRecipe(performed, flow)).toEqual([])
		expect(recipe.actions.map(action => [action.type, action.stepId, action.type === 'trigger' ? action.trigger.widgetId : ''])).toEqual([
			['enter', STEP_A, ''], ['trigger', STEP_A, 'a'],
			['enter', STEP_A, ''], ['trigger', STEP_A, 'z'],
			['enter', STEP_B, ''], ['trigger', STEP_B, 'a'],
			['enter', STEP_C, ''],
		])
		expect(flowRecipeEntries(recipe)).toEqual([
			{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'a', event: 'press' }, perform: { action: 'click' }, resultStepId: STEP_B },
			{ stepId: STEP_A, viewId: VIEW_A, trigger: { widgetId: 'z', event: 'click' }, perform: { action: 'click' }, resultStepId: STEP_C },
			{ stepId: STEP_B, viewId: VIEW_B, variantName: 'done', trigger: { widgetId: 'a', event: 'back' }, resultStepId: STEP_A },
			{ stepId: STEP_C, viewId: VIEW_B },
		])
		expect(deriveFlowRecipe(flow)).toEqual(recipe)
	})

	it('refuses a recipe that names what the Flow lacks or asserts what it does not hold', () => {
		const flow = twoStepFlow()
		const enter = { type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } }
		const trigger = { type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'press' }, perform: { action: 'click' }, expect: { resultStepId: STEP_B } }
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

	it('requires every trigger of a given recipe to state a perform shaped as an interaction replay step', () => {
		const flow = twoStepFlow()
		const enter = { type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } }
		const withPerform = (perform?: unknown) => ({ actions: [enter, { type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'press' }, ...(perform === undefined ? {} : { perform }), expect: { resultStepId: STEP_B } }] })
		const found = (perform?: unknown) => validateFlowRecipe(withPerform(perform), flow).map(item => [item.code, item.path])
		// A given recipe never defaults, not even a press trigger.
		expect(found()).toEqual([['flow.recipe_perform_required', '/recipe/actions/1/perform']])
		for (const action of ['click', 'hover']) expect(found({ action })).toEqual([])
		expect(found({ action: 'type', text: 'hello' })).toEqual([])
		expect(found({ action: 'press', key: 'Enter' })).toEqual([])
		expect(found({ action: 'tap' })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/action']])
		expect(found('click')).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform']])
		expect(found({ action: 'type' })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/text']])
		expect(found({ action: 'press' })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/key']])
		expect(found({ action: 'click', text: 'x' })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/text']])
		expect(found({ action: 'click', key: 'x' })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/key']])
		expect(found({ action: 'click', extra: 1 })).toEqual([['flow.recipe_invalid_shape', '/recipe/actions/1/perform/extra']])
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
		const { app, persistence } = await seededSession(flow)
		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		const before = await persistence.artifacts.listIdentities()
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
		// The store is compared by identity, so a stored record of any kind would show.
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	})

	it('keeps the formal captures a failed run already recorded, and records no trace', async () => {
		const { persistence } = await seededSession(twoStepFlow())
		const before = await persistence.artifacts.listIdentities()
		const first = await persistence.artifacts.put(new TextEncoder().encode('a formal capture recorded before the failure'))
		const service = createFlowEvidenceService(persistence, {
			readFlow: async () => ({ resource: twoStepFlow(), revision: 'r_flow', diagnostics: [] }),
			openReplaySession: () => { throw new Error('The replay is not reached after a failed capture.') },
			captureFormal: async ({ contexts }) => ({
				status: 'incomplete',
				executedAt: new Date().toISOString(),
				summary: { total: contexts.length, captured: 1, failed: 1 },
				results: [
					{ context: contexts[0]!, status: 'captured', evidenceDigest: first.identity, screenshotDigest: first.identity, evidence: { schemaVersion: 1, kind: 'formal_capture', executionContext: {}, coverage: { complete: true }, provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.1.0' } }, artifactRefs: [] } },
					{ context: contexts[1]!, status: 'failed', diagnostics: [{ code: 'preview.runtime_failed', path: '/preview', message: 'The Preview failed.' }] },
				],
			}),
		})
		expect(await service.capture({ flowId: FLOW_ID, renderContext: { locale: 'en-US', viewportId: 'desktop', themeId: 'light' } }))
			.toMatchObject({ status: 'failed', flowId: FLOW_ID, diagnostics: [{ code: 'preview.runtime_failed' }] })
		// Only what the capture itself stored remains; no flow_trace was written.
		expect(await persistence.artifacts.listIdentities()).toEqual([...before, first.identity].sort())
	})

	it('writes nothing for a member without evidence.capture', async () => {
		const { app, persistence } = await seededSession(twoStepFlow())
		const before = await persistence.artifacts.listIdentities()
		const viewer = scoped(app, testMember({ nickname: 'vera', preset: 'viewer' }))
		expect(await viewer.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { locale: 'en-US', viewportId: 'desktop', themeId: 'light' } }))
			.toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['evidence.capture'] })
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
		expect(await viewer.validateFlow(FLOW_ID)).toMatchObject({ flowId: FLOW_ID, valid: true })
	})

	it('reports a Flow file that is not valid JSON with its parse diagnostics instead of throwing', async () => {
		const { app, root } = await seededSession(twoStepFlow())
		await writeFile(join(root, 'flows', `${FLOW_ID}.flow.json`), '{corrupt')
		const result = await app.validateFlow(FLOW_ID)
		expect(result).toMatchObject({ flowId: FLOW_ID, valid: false })
		if ('status' in result) throw new Error('expected a diagnostic result')
		expect(result.revision).toMatch(/^r_/u)
		expect(result.diagnostics.length).toBeGreaterThan(0)
		expect(await validateFlowForHttp(app, FLOW_ID)).toMatchObject({ status: 200 })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { locale: 'en-US', viewportId: 'desktop', themeId: 'light' } })).toMatchObject({ status: 'invalid' })
	})

	it('refuses an unknown Flow, a render context or recipe the Flow does not match, and an unknown viewport', async () => {
		const { app } = await seededSession(twoStepFlow())
		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		expect(await app.captureFlowEvidence({ flowId: '77777777-7777-4777-8777-777777777777', renderContext })).toEqual({ status: 'not_found', flowId: '77777777-7777-4777-8777-777777777777' })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { locale: 'en-US' } as never })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.invalid_render_context' }] })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext: { ...renderContext, viewportId: 'tv' } })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'render_context.unknown_viewport' }] })
		expect(await app.captureFlowEvidence({ flowId: FLOW_ID, renderContext, recipe: { actions: [{ type: 'enter', stepId: STEP_B, expect: { viewId: VIEW_A } }] } })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_assertion_failed' }] })
	})

	it('accepts a recipe whose trigger carries perform through the MCP schema, leaving its judgement to the domain', async () => {
		const { app, persistence } = await seededSession(twoStepFlow())
		const before = await persistence.artifacts.listIdentities()
		const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
		const recipe = (perform: unknown, resultStepId: string) => ({ actions: [
			{ type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } },
			{ type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'press' }, perform, expect: { resultStepId } },
		] })
		await withMcp(app, async (client) => {
			// Each refusal is the domain's `invalid` result with a Flow diagnostic, so perform passed the strict input schema (a schema error has no `status`).
			const wrongStep = await client.callTool({ name: 'capture_flow_evidence', arguments: { flowId: FLOW_ID, renderContext, recipe: recipe({ action: 'type', text: 'hello' }, STEP_A) } })
			expect(wrongStep.isError).toBe(true)
			expect(wrongStep.structuredContent).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_assertion_failed' }] })
			const badAction = await client.callTool({ name: 'capture_flow_evidence', arguments: { flowId: FLOW_ID, renderContext, recipe: recipe({ action: 'tap' }, STEP_B) } })
			expect(badAction.structuredContent).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_invalid_shape', path: '/recipe/actions/1/perform/action' }] })
			const missing = await client.callTool({ name: 'capture_flow_evidence', arguments: { flowId: FLOW_ID, renderContext, recipe: { actions: [{ type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } }, { type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'press' }, expect: { resultStepId: STEP_B } }] } } })
			expect(missing.structuredContent).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_perform_required' }] })
		})
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
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

describe('replaying each trigger as a browser action (Rule 01a11544-66d9-7fcd-8400-93516ddf2857, owner ruling 4 of #241 comment 19197851)', () => {
	const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }

	/** The service over fakes: every context is captured, and every replay is answered by `answer`. */
	async function serviceOver(flow: FlowResource, answer: (command: ReplayInteractionsCommand) => InteractionReplayOutcome) {
		const { persistence } = await seededSession(flow)
		const captured: CaptureFormalEvidenceCommand[] = []
		const replayed: ReplayInteractionsCommand[] = []
		const sessions = { opened: 0, closed: 0 }
		const service = createFlowEvidenceService(persistence, {
			readFlow: async () => ({ resource: flow, revision: 'r_flow', diagnostics: [] }),
			captureFormal: async (command) => {
				captured.push(command)
				const results = await Promise.all(command.contexts.map(async (context, index) => {
					const stored = await persistence.artifacts.put(new TextEncoder().encode(`capture ${index}`))
					return { context, status: 'captured' as const, evidenceDigest: stored.identity, screenshotDigest: stored.identity, evidence: { schemaVersion: 1, kind: 'formal_capture', executionContext: {}, coverage: { complete: true }, provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.1.0' } }, artifactRefs: [] } }
				}))
				return { status: 'captured', executedAt: new Date().toISOString(), summary: { total: results.length, captured: results.length, failed: 0 }, results } as unknown as CaptureFormalEvidenceResult
			},
			openReplaySession: () => {
				sessions.opened++
				return {
					replay: async (command) => {
						replayed.push(command)
						return answer(command)
					},
					close: async () => { sessions.closed++ },
				}
			},
		})
		return { persistence, service, captured, replayed, sessions }
	}
	const pass: InteractionReplayOutcome = { status: 'replayed', results: ['pass'] }

	it('performs a derived press trigger as a click and asserts its Event exactly once, then records the replay as valid', async () => {
		const { service, replayed, persistence } = await serviceOver(twoStepFlow(), () => pass)
		const outcome = await service.capture({ flowId: FLOW_ID, renderContext })
		expect(outcome.status, JSON.stringify(outcome)).toBe('captured')
		if (outcome.status !== 'captured') return
		// The trigger is replayed once, in the Preview of the step's View in the render context, as the interaction replay engine's step and assertion.
		expect(replayed).toHaveLength(1)
		expect(replayed[0]).toMatchObject({
			context: { viewId: VIEW_A, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
			steps: [{ action: 'click', target: { viewId: VIEW_A, widgetId: 'root' } }],
			assertions: [{ expect: { widgetEvent: { widgetId: 'root', name: 'press', count: 1 } } }],
		})
		expect(outcome.evidence.data?.steps).toMatchObject([{ stepId: STEP_A, valid: true }, { stepId: STEP_B, valid: true }])
		// The stored recipe is the derived one with the default perform, so that replaying it is deterministic.
		expect(JSON.stringify(outcome.evidence.data?.recipe)).toContain('"perform":{"action":"click"}')
		expect(await persistence.artifacts.read(outcome.evidenceDigest)).toBeDefined()
	})

	it('replays the given perform on the entered Variant, and records an Event that did not occur exactly once as invalid', async () => {
		const flow: FlowResource = { ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_A]: { target: { viewId: VIEW_A, variantName: 'x' }, transitions: [{ trigger: { widgetId: 'name', event: 'change' }, targetStepId: STEP_B }] } } }
		const { service, replayed } = await serviceOver(flow, () => ({ status: 'replayed', results: ['fail'] }))
		const recipe = { actions: [
			{ type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A, variantName: 'x' } },
			{ type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'name', event: 'change' }, perform: { action: 'type', text: 'hello' }, expect: { resultStepId: STEP_B } },
			{ type: 'enter', stepId: STEP_B, expect: { viewId: VIEW_B } },
		] }
		const outcome = await service.capture({ flowId: FLOW_ID, renderContext, recipe })
		expect(outcome.status, JSON.stringify(outcome)).toBe('captured')
		if (outcome.status !== 'captured') return
		expect(replayed[0]).toMatchObject({
			context: { viewId: VIEW_A, variantName: 'x' },
			steps: [{ action: 'type', text: 'hello', target: { viewId: VIEW_A, variant: 'x', widgetId: 'name' } }],
			assertions: [{ expect: { widgetEvent: { widgetId: 'name', name: 'change', count: 1 } } }],
		})
		expect(outcome.evidence.data?.steps).toMatchObject([{ stepId: STEP_A, valid: false }, { stepId: STEP_B, valid: true }])
		expect(validateFormalEvidenceRecord(outcome.evidence).diagnostics).toEqual([])
	})

	it('fails the run, recording no trace, when a replay cannot run', async () => {
		const { service, persistence } = await serviceOver(twoStepFlow(), () => ({ status: 'failed', diagnostics: [{ code: 'interaction.step_failed', path: '/steps/0', message: 'The click could not be performed.' }] }))
		const before = await persistence.artifacts.listIdentities()
		const outcome = await service.capture({ flowId: FLOW_ID, renderContext })
		expect(outcome).toMatchObject({ status: 'failed', flowId: FLOW_ID, diagnostics: [{ code: 'interaction.step_failed' }] })
		// Only the formal captures the run had already stored remain.
		const added = (await persistence.artifacts.listIdentities()).filter(identity => !before.includes(identity))
		expect(added).toHaveLength(2)
	})

	it('replays every trigger of a run in one session, which is closed once the run ends', async () => {
		const flow: FlowResource = { ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_B]: { target: { viewId: VIEW_B }, transitions: [{ trigger: { widgetId: 'next', event: 'press' }, targetStepId: STEP_A }] } } }
		const { service, replayed, sessions } = await serviceOver(flow, () => pass)
		expect(await service.capture({ flowId: FLOW_ID, renderContext })).toMatchObject({ status: 'captured' })
		expect(replayed).toHaveLength(2)
		expect(sessions).toEqual({ opened: 1, closed: 1 })
	})

	it('closes the session when a replay cannot run, and when a replay throws', async () => {
		const failed = await serviceOver(twoStepFlow(), () => ({ status: 'failed', diagnostics: [{ code: 'interaction.step_failed', path: '/steps/0', message: 'x' }] }))
		expect(await failed.service.capture({ flowId: FLOW_ID, renderContext })).toMatchObject({ status: 'failed' })
		expect(failed.sessions).toEqual({ opened: 1, closed: 1 })
		const thrown = await serviceOver(twoStepFlow(), () => { throw new Error('boom') })
		await expect(thrown.service.capture({ flowId: FLOW_ID, renderContext })).rejects.toThrow('boom')
		expect(thrown.sessions).toEqual({ opened: 1, closed: 1 })
	})

	it('refuses a derived recipe with a trigger that is neither press nor click before any capture or replay, and records nothing', async () => {
		const flow: FlowResource = { ...twoStepFlow(), steps: { ...twoStepFlow().steps, [STEP_A]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'root', event: 'change' }, targetStepId: STEP_B }] } } }
		const { service, persistence, captured, replayed } = await serviceOver(flow, () => pass)
		const before = await persistence.artifacts.listIdentities()
		expect(await service.capture({ flowId: FLOW_ID, renderContext })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'flow.recipe_perform_required', path: '/recipe/actions/1/perform' }] })
		expect(captured).toEqual([])
		expect(replayed).toEqual([])
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
		// The same Flow runs once its recipe states the perform.
		const recipe = { actions: [
			{ type: 'enter', stepId: STEP_A, expect: { viewId: VIEW_A } },
			{ type: 'trigger', stepId: STEP_A, trigger: { widgetId: 'root', event: 'change' }, perform: { action: 'click' }, expect: { resultStepId: STEP_B } },
			{ type: 'enter', stepId: STEP_B, expect: { viewId: VIEW_B } },
		] }
		expect(await service.capture({ flowId: FLOW_ID, renderContext, recipe })).toMatchObject({ status: 'captured' })
		expect(replayed).toHaveLength(1)
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
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
}
