import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createInteractionEvidenceService } from '../src/application/services/interaction-evidence'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { canonicalJsonBytes } from '../src/domain/canonical-json'
import {
	INTERACTION_RECORD_CODES,
	MAX_INTERACTION_ASSERTIONS,
	MAX_INTERACTION_STEPS,
	validateInteractionRecipeInput,
} from '../src/domain/evidence/interaction-replay'
import { validateFormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { createUiuxMcpHttpHandler, principalAuthInfo } from '../src/mcp/server'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { captureInteractionEvidenceForHttp } from '../src/server/interactions-http'
import { AGENT_EDITOR, scoped, testMember } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Replayable interaction Evidence (issue #89; Clauses 01a17762-b293-7157-aa2f-39a9c2ffbab5,
 * 01a17762-b467-7da6-9a61-59c1af1ba6af, 01a17762-b631-7681-965d-80e97eb92809 and
 * 01a17762-b85b-77d6-a399-e26843475501) without a browser: the recipe and record shapes, the service
 * with a fake capture and replay, and the refusals as the application, HTTP and MCP report them.
 */

const VIEW = '11111111-1111-4111-8111-111111111111'
const GONE_VIEW = '99999999-9999-4999-8999-999999999999'
const roots: string[] = []
const renderContext = { locale: 'en-US', viewportId: 'desktop', themeId: 'light' }
const capture = `sha256:${'a'.repeat(64)}`

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const click = { action: 'click', target: { viewId: VIEW, widgetId: 'pay-button' } }
const eventAssertion = { expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' } } }

describe('interaction recipe input (Clauses 01a17762-b467-… and 01a17762-b631-…)', () => {
	const codes = (patch: Record<string, unknown> = {}, variant?: string) => validateInteractionRecipeInput({
		viewId: VIEW,
		...(variant !== undefined ? { variant } : {}),
		steps: [click],
		assertions: [eventAssertion],
		...patch,
	}).map(item => item.code)

	it('accepts every action and both expectation forms', () => {
		expect(validateInteractionRecipeInput({
			viewId: VIEW,
			variant: 'error',
			steps: [
				{ action: 'hover', target: { viewId: VIEW, variant: 'error', widgetId: 'a' } },
				{ action: 'type', target: { viewId: VIEW, variant: 'error', widgetId: 'field' }, text: 'hello' },
				{ action: 'press', target: { viewId: VIEW, variant: 'error', widgetId: 'field' }, key: 'Enter' },
				{ action: 'click', target: { viewId: VIEW, variant: 'error', widgetId: 'a' } },
			],
			assertions: [
				{ expect: { widgetEvent: { widgetId: 'a', name: 'click', payload: [1, { x: 'y' }] } } },
				{ expect: { state: { widgetId: 'pay-button', key: 'value', value: { text: 'hello' } } } },
			],
		})).toEqual([])
	})

	it('refuses a recipe outside the shape or the bounds', () => {
		expect(codes({ steps: [] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: Array.from({ length: MAX_INTERACTION_STEPS + 1 }, () => click) })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: Array.from({ length: MAX_INTERACTION_ASSERTIONS + 1 }, () => eventAssertion) })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, action: 'drag' }] })).toEqual(['interaction.invalid_recipe'])
		// `type` needs text and `press` a key; no other action carries either.
		expect(codes({ steps: [{ ...click, action: 'type' }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, action: 'press' }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, text: 'x' }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, key: 'Enter' }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, action: 'type', text: 'x'.repeat(1001) }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, action: 'press', key: 'k'.repeat(65) }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ steps: [{ ...click, extra: 1 }] })).toEqual(['schema.unknown_field'])
		expect(codes({ steps: [{ action: 'click', target: { viewId: VIEW } }] })).toContain('interaction.invalid_recipe')
		expect(codes({ assertions: [{ expect: {} }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click' }, state: { widgetId: 'pay-button', key: 'a', value: 1 } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: 'x' } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'pay-button', name: 'click', payload: ['x'.repeat(9000)] } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { state: { widgetId: 'pay-button', key: 'a' } } }] })).toEqual(['interaction.invalid_recipe'])
		// widgetId is required on every expectation, and count is an integer from 0 to 1000.
		expect(codes({ assertions: [{ expect: { widgetEvent: { name: 'click' } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { state: { key: 'a', value: 1 } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'a', name: 'click', count: -1 } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'a', name: 'click', count: 1.5 } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'a', name: 'click', count: 1001 } } }] })).toEqual(['interaction.invalid_recipe'])
		expect(codes({ assertions: [{ expect: { widgetEvent: { widgetId: 'a', name: 'click', count: 1 } } }] })).toEqual([])
		// A caller does not decide a result.
		expect(codes({ assertions: [{ ...eventAssertion, result: 'pass' }] })).toEqual(['schema.unknown_field'])
		// The whole recipe is bounded, so a record stays readable.
		const wide = { expect: { state: { widgetId: 'pay-button', key: 'k', value: 'v'.repeat(8000) } } }
		expect(codes({ steps: Array.from({ length: 50 }, () => ({ ...click, action: 'type', text: 'x'.repeat(1000) })), assertions: Array.from({ length: 50 }, () => wide) })).toContain('interaction.invalid_recipe')
	})

	it('refuses a step that does not target the View and Variant of the call', () => {
		expect(codes({ steps: [{ ...click, target: { viewId: GONE_VIEW, widgetId: 'a' } }] })).toEqual(['interaction.recipe_mismatch'])
		expect(codes({ steps: [{ ...click, target: { viewId: VIEW, variant: 'error', widgetId: 'a' } }] })).toEqual(['interaction.recipe_mismatch'])
		expect(codes({}, 'error')).toEqual(['interaction.recipe_mismatch'])
	})
})

describe('interaction_replay Evidence record (Clauses 01a17762-b293-… and 01a17762-b631-…)', () => {
	const record = (patch: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
		schemaVersion: 1,
		kind: 'interaction_replay',
		executionContext: { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
		evidenceRefs: [{ kind: 'formal_capture', evidence: capture }],
		data: { steps: [click], assertions: [{ ...eventAssertion, result: 'pass' }], captures: [capture], ...data },
		...patch,
	})
	const codes = (patch: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => validateFormalEvidenceRecord(record(patch, data)).diagnostics.map(item => item.code)

	it('accepts a record whose steps, assertions and references agree, with a pass or a fail', () => {
		expect(codes()).toEqual([])
		expect(codes({}, { assertions: [{ ...eventAssertion, result: 'fail' }] })).toEqual([])
	})

	it('refuses a record that disagrees with itself', () => {
		expect(codes({ schemaVersion: 2 })).toEqual([INTERACTION_RECORD_CODES.shape])
		expect(codes({ artifactRefs: [capture] })).toEqual([INTERACTION_RECORD_CODES.shape])
		expect(codes({ evidenceRefs: [] })).toEqual([INTERACTION_RECORD_CODES.mismatch])
		expect(codes({ evidenceRefs: [{ kind: 'formal_capture', evidence: `sha256:${'b'.repeat(64)}` }] })).toEqual([INTERACTION_RECORD_CODES.mismatch])
		expect(codes({}, { captures: [] })).toContain(INTERACTION_RECORD_CODES.shape)
		expect(codes({}, { captures: [capture, capture] })).toContain(INTERACTION_RECORD_CODES.shape)
		expect(codes({}, { assertions: [eventAssertion] })).toEqual([INTERACTION_RECORD_CODES.shape])
		expect(codes({}, { assertions: [{ ...eventAssertion, result: 'maybe' }] })).toEqual([INTERACTION_RECORD_CODES.shape])
		expect(codes({}, { steps: [{ ...click, target: { viewId: GONE_VIEW, widgetId: 'a' } }] })).toEqual([INTERACTION_RECORD_CODES.mismatch])
		expect(codes({ executionContext: { viewId: VIEW, locale: 'en-US' } })).toContain('schema.expected_string')
		expect(codes({}, { extra: true })).toContain('schema.unknown_field')
	})

	it('is an immutable record whose identity is its canonical bytes', () => {
		expect(canonicalJsonBytes(record())).toEqual(canonicalJsonBytes(record()))
		expect(canonicalJsonBytes(record())).not.toEqual(canonicalJsonBytes(record({}, { assertions: [{ ...eventAssertion, result: 'fail' }] })))
	})
})

describe('capture_interaction_evidence with a fake capture and replay', () => {
	it('stores a record that references the capture, with the result the replay decided for each assertion', async () => {
		const { persistence } = await seededSession()
		const seen: unknown[] = []
		const service = fakeService(persistence, { results: ['pass', 'fail'], seen })
		const assertions = [eventAssertion, { expect: { state: { widgetId: 'pay-button', key: 'value', value: 1 } } }]
		const outcome = await service.capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: assertions as never })
		expect(outcome.status, JSON.stringify(outcome)).toBe('captured')
		if (outcome.status !== 'captured') return
		expect(outcome.evidence).toMatchObject({
			kind: 'interaction_replay',
			schemaVersion: 1,
			executionContext: { viewId: VIEW, ...renderContext, viewport: { width: 1280, height: 800 } },
			coverage: { complete: true },
			artifactRefs: [],
			evidenceRefs: [{ kind: 'formal_capture', evidence: outcome.captures[0]!.evidenceDigest }],
			data: { steps: [click], assertions: [{ ...assertions[0], result: 'pass' }, { ...assertions[1], result: 'fail' }], captures: [outcome.captures[0]!.evidenceDigest] },
		})
		expect(validateFormalEvidenceRecord(outcome.evidence).diagnostics).toEqual([])
		// The record is stored, immutable and content-addressed.
		const stored = JSON.parse(Buffer.from((await persistence.artifacts.read(outcome.evidenceDigest))!).toString('utf8'))
		expect(stored).toEqual(JSON.parse(JSON.stringify(outcome.evidence)))
		expect(seen).toEqual([expect.objectContaining({ context: expect.objectContaining({ viewId: VIEW, locale: 'en-US' }) })])
		// The same recipe and replay results give the same identity; another result gives another.
		expect((await fakeService(persistence, { results: ['pass', 'fail'], seen }).capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: assertions as never }))).toMatchObject({ evidenceDigest: outcome.evidenceDigest })
		expect((await fakeService(persistence, { results: ['pass', 'pass'], seen }).capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: assertions as never }))).not.toMatchObject({ evidenceDigest: outcome.evidenceDigest })
	})

	it('records an incomplete capture as incomplete coverage', async () => {
		const { persistence } = await seededSession()
		const outcome = await fakeService(persistence, { results: ['pass'], complete: false }).capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: [eventAssertion as never] })
		expect(outcome).toMatchObject({ status: 'captured', evidence: { coverage: { complete: false } } })
	})

	it('keeps the formal capture a failed replay already stored, and records no interaction record', async () => {
		const { persistence } = await seededSession()
		const before = await persistence.artifacts.listIdentities()
		const outcome = await fakeService(persistence, { replayFails: true }).capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: [eventAssertion as never] })
		expect(outcome).toMatchObject({ status: 'failed', viewId: VIEW, diagnostics: [{ code: 'interaction.step_failed' }] })
		const after = await persistence.artifacts.listIdentities()
		// The formal capture and its screenshot.
		expect(after.length).toBe(before.length + 2)
		const added = after.filter(candidate => !before.includes(candidate))
		const kinds = await Promise.all(added.map(async identity => (await persistence.artifacts.readCandidateJson(identity) as { kind?: string } | undefined)?.kind))
		expect(kinds).toContain('formal_capture')
		expect(kinds).not.toContain('interaction_replay')
	})

	it('reports a failed capture without replaying', async () => {
		const { persistence } = await seededSession()
		const seen: unknown[] = []
		const outcome = await fakeService(persistence, { captureFails: true, seen }).capture({ viewId: VIEW, renderContext, steps: [click as never], assertions: [eventAssertion as never] })
		expect(outcome).toMatchObject({ status: 'failed', diagnostics: [{ code: 'preview.runtime_failed' }] })
		expect(seen).toEqual([])
	})
})

describe('capture_interaction_evidence refusals, as the application, HTTP and MCP report them', () => {
	const body = (patch: Record<string, unknown> = {}) => ({ viewId: VIEW, renderContext, steps: [click], assertions: [eventAssertion], ...patch })

	it('refuses identically through every transport and records nothing', async () => {
		const { app, persistence } = await seededSession()
		const before = await persistence.artifacts.listIdentities()
		const cases: ReadonlyArray<[string, Record<string, unknown>, number, string, string?]> = [
			['an unknown View', { viewId: GONE_VIEW, steps: [{ ...click, target: { viewId: GONE_VIEW, widgetId: 'pay-button' } }] }, 404, 'not_found'],
			['a render context without a viewport', { renderContext: { ...renderContext, viewportId: 'tv' } }, 422, 'invalid', 'render_context.unknown_viewport'],
			['a malformed render context', { renderContext: { locale: 'en-US' } }, 422, 'invalid', 'interaction.invalid_render_context'],
			['a Variant the View lacks', { variant: 'gone', steps: [{ ...click, target: { viewId: VIEW, variant: 'gone', widgetId: 'pay-button' } }] }, 422, 'invalid', 'interaction.unknown_variant'],
			['a Widget the View lacks', { steps: [{ ...click, target: { viewId: VIEW, widgetId: 'ghost' } }] }, 422, 'invalid', 'interaction.unknown_widget'],
			['an assertion about a Widget the View lacks', { assertions: [{ expect: { widgetEvent: { widgetId: 'ghost', name: 'click' } } }] }, 422, 'invalid', 'interaction.unknown_widget'],
			['an unknown action', { steps: [{ ...click, action: 'drag' }] }, 422, 'invalid', 'interaction.invalid_recipe'],
			['a step on another View', { steps: [{ ...click, target: { viewId: GONE_VIEW, widgetId: 'pay-button' } }] }, 422, 'invalid', 'interaction.recipe_mismatch'],
		]
		await withMcp(app, async (client) => {
			for (const [label, patch, status, expectedStatus, code] of cases) {
				const input = body(patch)
				const application = await app.captureInteractionEvidence(input as never)
				expect(application, label).toMatchObject({ status: expectedStatus })
				if (code) expect(JSON.stringify(application), label).toContain(code)
				expect(await captureInteractionEvidenceForHttp(app, input), label).toEqual({ status, body: application })
				// MCP checks the argument types before the domain does: a render context that is not { locale, viewportId, themeId } never reaches it.
				const result = await client.callTool({ name: 'capture_interaction_evidence', arguments: input })
				expect(result.isError, label).toBe(true)
				if (label !== 'a malformed render context') expect(result.structuredContent, label).toEqual(JSON.parse(JSON.stringify(application)))
			}
		})
		// The store is compared by identity, so a record of any kind would show.
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	})

	it('writes nothing for a member without evidence.capture and takes the key of Flow Evidence', async () => {
		const { app, persistence } = await seededSession()
		const before = await persistence.artifacts.listIdentities()
		const viewer = scoped(app, testMember({ nickname: 'vera', preset: 'viewer' }))
		expect(await viewer.captureInteractionEvidence(body() as never)).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['evidence.capture'] })
		expect(await captureInteractionEvidenceForHttp(viewer, body())).toMatchObject({ status: 403, body: { status: 'blocked' } })
		expect(await persistence.artifacts.listIdentities()).toEqual(before)
	})
})

function fakeService(persistence: FileNativePersistence, options: Readonly<{ results?: readonly ('pass' | 'fail')[]; complete?: boolean; replayFails?: boolean; captureFails?: boolean; seen?: unknown[] }>) {
	return createInteractionEvidenceService(persistence, {
		captureFormal: async ({ contexts }) => {
			const context = contexts[0]!
			if (options.captureFails) {
				return { status: 'failed', executedAt: '', summary: { total: 1, captured: 0, failed: 1 }, results: [{ context, status: 'failed', diagnostics: [{ code: 'preview.runtime_failed', path: '/preview', message: 'The Preview failed.' }] }] }
			}
			const screenshot = await persistence.artifacts.put(new TextEncoder().encode('screenshot'))
			const evidence = {
				schemaVersion: 1,
				kind: 'formal_capture',
				executionContext: { locale: context.locale, themeId: context.themeId, viewId: context.viewId, viewport: context.viewport, viewportId: context.viewportId },
				coverage: { complete: options.complete ?? true },
				provenance: { workspaceSchemaVersion: 6, resources: [{ identity: { type: 'view', id: VIEW }, revision: 'r_view' }], versions: { uiux: '0.1.0' }, renderInputDigest: capture },
				artifactRefs: [screenshot.identity],
			}
			const stored = await persistence.artifacts.put(canonicalJsonBytes(evidence))
			return { status: 'ok', executedAt: '', summary: { total: 1, captured: 1, failed: 0 }, results: [{ context, status: 'captured', evidenceDigest: stored.identity, screenshotDigest: screenshot.identity, evidence }] }
		},
		replay: async (command) => {
			options.seen?.push(command)
			if (options.replayFails) return { status: 'failed', diagnostics: [{ code: 'interaction.step_failed', path: '/steps/0', message: 'The click could not be performed.' }] }
			return { status: 'replayed', results: options.results ?? command.assertions.map(() => 'pass' as const) }
		},
	})
}

async function withMcp(app: ReturnType<typeof createWorkspaceApplicationSession>, run: (client: Client) => Promise<void>): Promise<void> {
	const handler = createUiuxMcpHttpHandler(app, { leases: createLeaseManager() })
	const client = new Client({ name: 'uiux-interaction-evidence-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto', probe: { timeoutMs: 2_000 } } })
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

async function seededSession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-interaction-evidence-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } })
	await persistence.views.create(VIEW, view())
	await persistence.locales.create('en-US', { title: 'Title' })
	return { root, persistence, app: createWorkspaceApplicationSession(persistence) }
}

function view(): ViewResource {
	return {
		id: VIEW,
		name: 'Pay',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay-button', config: { label: 'Pay' } }] } },
		variants: { error: { state: {} } },
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}
