import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	CHANGE_SUMMARY_MAX_CHANGES,
	DELETED_CHANGE_SUMMARY,
	summarizeChange,
	type ChangeSummary,
} from '../src/application/dto/change-summary'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	appendReviewMessageForHttp,
	createAssetForHttp,
	createFlowForHttp,
	createLocaleForHttp,
	createReviewThreadForHttp,
	createViewForHttp,
	promoteReviewToDecisionForHttp,
	replaceAssetForHttp,
	retractReviewThreadForHttp,
	updateFlowForHttp,
	updateLocaleForHttp,
	updateViewMetadataForHttp,
	updateViewSpecForHttp,
	updateViewStructureForHttp,
	updateWorkspaceSettingsForHttp,
} from '../src/server/authoring-http'
import { AGENT_EDITOR, connectMcp, scoped } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The change summary of successful mutation results (issue #77): Clauses
 * 01a11485-f578-79a7-9d01-4bc233f2c1cb (shape, computed from canonical content),
 * 01a164f0-c0fe-7c86-9c50-cc9354e49fe8 (paths), 01a164f0-c2a5-74dc-805d-c05ce25697d8 (order and
 * cap), 01a164f0-c44e-7d21-811d-93cbf7750dba (created, deleted, unchanged),
 * 01a164f0-c5fc-7b97-b21a-d127e423a157 (related) and 01a164f0-c7a4-7ec9-aa1e-71dfb5f26b53 (scope),
 * and Scenario 01a164f1-33da-7dec-a52e-a2bd59a4b6e9 (a View rename over MCP and HTTP).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const EMPTY_REVIEW_ID = '77777777-7777-4777-8777-777777777777'
const MESSAGE_ID = '88888888-8888-4888-8888-888888888888'
const DECISION_ID = '99999999-9999-4999-8999-999999999999'
const STEP_1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const STEP_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')
const OTHER_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]).toString('base64')

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('summarizeChange', () => {
	it('lists every top-level member of a created resource as add, and a deleted one as one root remove', () => {
		expect(summarizeChange(undefined, { name: 'A', id: 'x', skipped: undefined, spec: { intent: 'i' } }))
			.toEqual({ changes: [{ path: '/id', op: 'add' }, { path: '/name', op: 'add' }, { path: '/spec', op: 'add' }] })
		expect(summarizeChange({ id: 'x' }, undefined)).toEqual({ changes: [{ path: '', op: 'remove' }] })
		expect(DELETED_CHANGE_SUMMARY).toEqual({ changes: [{ path: '', op: 'remove' }] })
	})

	it('gives empty changes for unchanged content, whatever the member order', () => {
		expect(summarizeChange({ a: 1, b: { c: [1, 2] } }, { b: { c: [1, 2] }, a: 1 })).toEqual({ changes: [] })
		expect(summarizeChange({ content: new Uint8Array([1, 2]) }, { content: new Uint8Array([1, 2]) })).toEqual({ changes: [] })
	})

	it('reports added, removed and replaced members as JSON Pointers, escaping ~ and /', () => {
		expect(summarizeChange(
			{ keep: 1, gone: true, 'a/b': 'x', 'c~d': 1 },
			{ keep: 2, added: null, 'a/b': 'y', 'c~d': 1 },
		)).toEqual({ changes: [
			{ path: '/added', op: 'add' },
			{ path: '/a~1b', op: 'replace' },
			{ path: '/gone', op: 'remove' },
			{ path: '/keep', op: 'replace' },
		] })
	})

	it('folds a difference deeper than 3 segments into its 3-segment prefix', () => {
		expect(summarizeChange(
			{ ir: { slots: { content: [{ id: 'a' }] } }, variants: { wide: { state: { x: { y: 1 } } } } },
			{ ir: { slots: { content: [{ id: 'a' }, { id: 'b' }] } }, variants: { wide: { state: { x: { y: 2 } } } } },
		)).toEqual({ changes: [{ path: '/ir/slots/content', op: 'replace' }, { path: '/variants/wide/state', op: 'replace' }] })
	})

	it('addresses id-bearing array elements by id and reports other arrays whole', () => {
		const before = { steps: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }, { id: 's3' }], tags: ['a', 'b'] }
		const after = { steps: [{ id: 's1', name: 'A2' }, { id: 's3' }, { id: 's4' }], tags: ['a', 'c'] }
		expect(summarizeChange(before, after)).toEqual({ changes: [
			{ path: '/steps/s1/name', op: 'replace' },
			{ path: '/steps/s2', op: 'remove' },
			{ path: '/steps/s4', op: 'add' },
			{ path: '/tags', op: 'replace' },
		] })
		// An empty array is id-bearing too, so the first element added to it is addressed by its id.
		expect(summarizeChange({ list: [] }, { list: [{ id: 'one' }] })).toEqual({ changes: [{ path: '/list/one', op: 'add' }] })
		// Elements without a unique string id make the array whole.
		expect(summarizeChange({ list: [{ id: 'a' }] }, { list: [{ id: 'a' }, { id: 'a' }] })).toEqual({ changes: [{ path: '/list', op: 'replace' }] })
		expect(summarizeChange({ list: [{ name: 'a' }] }, { list: [{ name: 'b' }] })).toEqual({ changes: [{ path: '/list', op: 'replace' }] })
	})

	it('reports an id-bearing array whose kept elements change order whole as replace', () => {
		expect(summarizeChange({ list: [{ id: 'a' }, { id: 'b' }] }, { list: [{ id: 'b' }, { id: 'a' }] }))
			.toEqual({ changes: [{ path: '/list', op: 'replace' }] })
	})

	it('reports a change of type, and a binary change, as replace', () => {
		expect(summarizeChange({ a: { b: 1 }, c: [1] }, { a: [1], c: { d: 1 } }))
			.toEqual({ changes: [{ path: '/a', op: 'replace' }, { path: '/c', op: 'replace' }] })
		expect(summarizeChange({ content: new Uint8Array([1]) }, { content: new Uint8Array([2]) }))
			.toEqual({ changes: [{ path: '/content', op: 'replace' }] })
		expect(summarizeChange(null, { a: 1 })).toEqual({ changes: [{ path: '', op: 'replace' }] })
	})

	it('sorts by path in code unit order, keeps at most 50 entries and counts the rest in truncated', () => {
		const after = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${String(index).padStart(2, '0')}`, index]))
		const summary = summarizeChange({}, { ...after, B: 1, a: 1 })
		expect(summary.changes).toHaveLength(CHANGE_SUMMARY_MAX_CHANGES)
		expect(summary.truncated).toBe(12)
		expect(summary.changes.slice(0, 3)).toEqual([{ path: '/B', op: 'add' }, { path: '/a', op: 'add' }, { path: '/k00', op: 'add' }])
		expect(summary.changes.at(-1)).toEqual({ path: '/k47', op: 'add' })
		expect(summarizeChange({}, { a: 1 })).not.toHaveProperty('truncated')
	})

	it('is deterministic: the same change gives the same summary regardless of member order', () => {
		const one = summarizeChange({ b: 1, a: { y: 1, x: 1 } }, { a: { x: 2, y: 2 }, c: 1 })
		const two = summarizeChange({ a: { x: 1, y: 1 }, b: 1 }, { c: 1, a: { y: 2, x: 2 } })
		expect(one).toEqual(two)
		expect(JSON.stringify(one)).toBe(JSON.stringify(two))
	})

	it('lists related resources sorted by kind then key, each sorted and capped like the primary', () => {
		const many = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`m${String(index).padStart(2, '0')}`, 1]))
		const summary = summarizeChange({ a: 1 }, { a: 1 }, [
			{ kind: 'view', key: 'v2', revision: 'r2', before: { name: 'x' }, after: { name: 'y' } },
			{ kind: 'flow', key: 'f1', revision: 'r3', before: {}, after: many },
			{ kind: 'view', key: 'v1', revision: 'r1', before: { b: 1, a: 1 }, after: {} },
		])
		expect(summary.changes).toEqual([])
		expect(summary.related!.map(entry => [entry.kind, entry.key, entry.revision, entry.truncated])).toEqual([
			['flow', 'f1', 'r3', 1],
			['view', 'v1', 'r1', undefined],
			['view', 'v2', 'r2', undefined],
		])
		expect(summary.related![1]!.changes).toEqual([{ path: '/a', op: 'remove' }, { path: '/b', op: 'remove' }])
		expect(summary.related![0]!.changes).toHaveLength(CHANGE_SUMMARY_MAX_CHANGES)
		expect(summarizeChange({}, {}, [])).toEqual({ changes: [] })
	})
})

type Result = Readonly<{ status: string; revision?: string; changeSummary?: ChangeSummary; [key: string]: unknown }>

/** One authoring operation set, run over HTTP or over MCP. */
type Transport = Readonly<{
	call(tool: string, args: Readonly<Record<string, unknown>>): Promise<Result>
	/** The current manifest revision, which no earlier result in the run names. */
	manifestRevision(): Promise<string>
	close(): Promise<void>
}>

async function emptySession() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-change-summary-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	return { app: createWorkspaceApplicationSession(persistence), manifestRevision: async () => (await persistence.workspace.readInspected()).revision! }
}

async function overHttp(): Promise<Transport> {
	const session = await emptySession()
	const app = scoped(session.app, AGENT_EDITOR, { transport: 'http' })
	const routes: Record<string, (args: Readonly<Record<string, unknown>>) => Promise<{ status: number; body: unknown }>> = {
		create_view: args => createViewForHttp(app, args),
		update_view_metadata: ({ viewId, ...body }) => updateViewMetadataForHttp(app, viewId as string, body),
		update_view_spec: ({ viewId, ...body }) => updateViewSpecForHttp(app, viewId as string, body),
		update_view_structure: ({ viewId, ...body }) => updateViewStructureForHttp(app, viewId as string, body),
		create_flow: args => createFlowForHttp(app, args),
		update_flow: ({ flowId, ...body }) => updateFlowForHttp(app, flowId as string, body),
		create_locale: args => createLocaleForHttp(app, args),
		update_locale: ({ locale, ...body }) => updateLocaleForHttp(app, locale as string, body),
		create_asset: args => createAssetForHttp(app, args),
		replace_asset: ({ assetId, ...body }) => replaceAssetForHttp(app, assetId as string, body),
		update_workspace_settings: args => updateWorkspaceSettingsForHttp(app, args),
		create_review_thread: args => createReviewThreadForHttp(app, args),
		append_review_message: ({ reviewId, ...body }) => appendReviewMessageForHttp(app, reviewId as string, body),
		promote_review_to_decision: ({ reviewId, ...body }) => promoteReviewToDecisionForHttp(app, reviewId as string, body),
		retract_review_thread: ({ reviewId, ...body }) => retractReviewThreadForHttp(app, reviewId as string, body),
	}
	return {
		async call(tool, args) {
			const response = await routes[tool]!(args)
			expect(response.status, `${tool}: ${JSON.stringify(response.body)}`).toBeLessThan(300)
			return response.body as Result
		},
		manifestRevision: session.manifestRevision,
		async close() {},
	}
}

async function overMcp(): Promise<Transport> {
	const session = await emptySession()
	const mcp = await connectMcp(session.app, AGENT_EDITOR)
	return {
		async call(tool, args) {
			const response = await mcp.client.callTool({ name: tool, arguments: args })
			expect(response.isError, `${tool}: ${JSON.stringify(response.structuredContent)}`).not.toBe(true)
			return response.structuredContent as Result
		},
		manifestRevision: session.manifestRevision,
		close: () => mcp.close(),
	}
}

function withoutRelatedRevisions(summary: ChangeSummary | undefined): unknown {
	if (!summary?.related) return summary
	return { ...summary, related: summary.related.map(entry => ({ ...entry, revision: typeof entry.revision })) }
}

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

function step(viewId: string) {
	return { target: { viewId }, transitions: [] }
}

/** Runs the same mutations on a fresh Workspace and returns each result by a label. */
async function run(transport: Transport): Promise<Map<string, Result>> {
	const results = new Map<string, Result>()
	const call = async (label: string, tool: string, args: Readonly<Record<string, unknown>>) => {
		const result = await transport.call(tool, args)
		results.set(label, result)
		return result
	}
	try {
		let view = await call('create_view', 'create_view', { id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
		view = await call('update_view_metadata', 'update_view_metadata', { viewId: VIEW_ID, expectedRevision: view.revision, name: 'Checkout v2' })
		view = await call('update_view_structure', 'update_view_structure', { viewId: VIEW_ID, expectedRevision: view.revision, ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay' }] } }, variants: {} })
		view = await call('update_view_spec (unchanged)', 'update_view_spec', { viewId: VIEW_ID, expectedRevision: view.revision, spec: spec('Pay') })

		const flow = await call('create_flow', 'create_flow', { id: FLOW_ID, name: 'Buy', entryStepId: STEP_1, steps: { [STEP_1]: step(VIEW_ID) } })
		await call('update_flow', 'update_flow', { flowId: FLOW_ID, expectedRevision: flow.revision, name: 'Buy now', entryStepId: STEP_1, steps: { [STEP_1]: { ...step(VIEW_ID), transitions: [{ trigger: { widgetId: 'pay', event: 'activate' }, targetStepId: STEP_2 }] }, [STEP_2]: step(VIEW_ID) } })

		const locale = await call('create_locale', 'create_locale', { locale: 'fr-FR', messages: { greeting: 'Bonjour' } })
		const many = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`k${String(index).padStart(2, '0')}`, `v${index}`]))
		await call('update_locale', 'update_locale', { locale: 'fr-FR', expectedRevision: locale.revision, messages: { greeting: 'Salut', ...many } })

		const asset = await call('create_asset', 'create_asset', { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: PNG })
		await call('replace_asset', 'replace_asset', { assetId: ASSET_ID, expectedRevision: asset.revision, name: 'Logo 2', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: OTHER_PNG })

		await call('update_workspace_settings', 'update_workspace_settings', { expectedRevision: await transport.manifestRevision(), settings: { i18n: { defaultLocale: 'en-US' }, viewports: { mobile: { dimensions: { width: 390, height: 844 } } }, themes: {} } })

		let thread = await call('create_review_thread', 'create_review_thread', { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'pay' } })
		thread = await call('append_review_message', 'append_review_message', { reviewId: REVIEW_ID, expectedRevision: thread.revision, id: MESSAGE_ID, at: '2026-10-23T00:00:00.000Z', body: 'Make it bigger.' })
		await call('promote_review_to_decision', 'promote_review_to_decision', { reviewId: REVIEW_ID, expectedReviewRevision: thread.revision, viewId: VIEW_ID, expectedViewRevision: view.revision, question: 'Bigger button?', decisionId: DECISION_ID })

		const empty = await call('create_review_thread (empty)', 'create_review_thread', { id: EMPTY_REVIEW_ID, anchor: { scope: 'workspace' } })
		await call('retract_review_thread', 'retract_review_thread', { reviewId: EMPTY_REVIEW_ID, expectedRevision: empty.revision })
	}
	finally { await transport.close() }
	return results
}

// Two Workspaces each take about 15 writes; under a loaded full run that exceeds the default 5 s.
describe('change summaries over HTTP and MCP', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('carries the same summary for every authoring kind on both transports', async () => {
		const expected: Record<string, ChangeSummary> = {
			'create_view': { changes: ['/id', '/ir', '/name', '/spec', '/variants'].map(path => ({ path, op: 'add' })) },
			'update_view_metadata': { changes: [{ path: '/name', op: 'replace' }] },
			'update_view_structure': { changes: [{ path: '/ir/slots/content', op: 'replace' }] },
			'update_view_spec (unchanged)': { changes: [] },
			'create_flow': { changes: ['/entryStepId', '/id', '/name', '/steps'].map(path => ({ path, op: 'add' })) },
			// Transitions carry no `id`, so the changed array is reported whole.
			'update_flow': { changes: [{ path: '/name', op: 'replace' }, { path: `/steps/${STEP_1}/transitions`, op: 'replace' }, { path: `/steps/${STEP_2}`, op: 'add' }] },
			'create_locale': { changes: [{ path: '/greeting', op: 'add' }] },
			'update_locale': {
				changes: [{ path: '/greeting', op: 'replace' }, ...Array.from({ length: 49 }, (_, index) => ({ path: `/k${String(index).padStart(2, '0')}`, op: 'add' as const }))],
				truncated: 11,
			},
			'create_asset': { changes: [{ path: '/content', op: 'add' }, { path: '/metadata', op: 'add' }] },
			'replace_asset': { changes: [{ path: '/content', op: 'replace' }, { path: '/metadata/name', op: 'replace' }] },
			'update_workspace_settings': { changes: [{ path: '/viewports/mobile', op: 'add' }] },
			'create_review_thread': { changes: ['/anchor', '/history', '/id', '/messages', '/status', '/submissions', '/variantNames'].map(path => ({ path, op: 'add' })) },
			'append_review_message': { changes: [{ path: `/messages/${MESSAGE_ID}`, op: 'add' }] },
			'retract_review_thread': { changes: [{ path: '', op: 'remove' }] },
		}

		const http = await run(await overHttp())
		const mcp = await run(await overMcp())

		for (const [label, summary] of Object.entries(expected)) {
			expect(http.get(label)?.changeSummary, `HTTP ${label}`).toEqual(summary)
			expect(mcp.get(label)?.changeSummary, `MCP ${label}`).toEqual(summary)
		}
		// Scenario 01a164f1-33da-7dec-a52e-a2bd59a4b6e9: the rename reports only the changed member, the same on both.
		expect(mcp.get('update_view_metadata')).not.toHaveProperty('ir')

		// Promotion: the thread is unchanged and the View it writes is related, with its new revision.
		for (const results of [http, mcp]) {
			const promoted = results.get('promote_review_to_decision')!
			const targetView = promoted.targetView as { revision: string }
			expect(promoted.changeSummary).toEqual({
				changes: [],
				related: [{ kind: 'view', key: VIEW_ID, revision: targetView.revision, changes: [{ path: `/spec/decisions/${DECISION_ID}`, op: 'add' }] }],
			})
		}

		// Every success carries a summary, the same on both transports; only the transport envelope
		// differs. A related revision is the one each Workspace wrote, so it is compared as present only.
		for (const label of http.keys()) {
			const viaHttp = http.get(label)!.changeSummary
			expect(viaHttp, label).toBeDefined()
			expect(withoutRelatedRevisions(mcp.get(label)!.changeSummary), label).toEqual(withoutRelatedRevisions(viaHttp))
		}
	})
})

