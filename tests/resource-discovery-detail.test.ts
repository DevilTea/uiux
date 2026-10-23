import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ResourceDiscoveryItem } from '../src/application/dto/resource-discovery'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { listResourcesForHttp, searchResourcesForHttp, type ResourceDiscoveryHttpResult } from '../src/server/resource-discovery'
import { connectMcp } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The `detail` selector of discovery (issue #78; owner rulings in Discussion #241,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19136881).
 *
 * - Clause 01a166bd-ef89-7bdc-96a9-6eb86451932a: `detail` `summary` (default) or `expanded`, the
 *   `detail` member only when expanded, unchanged paging, the same shape over HTTP and MCP.
 * - Clause 01a166bd-f154-7a1f-972b-7e9019510570: any other `detail` is refused.
 * - Clauses 01a166bd-f310-7e84-b1da-892a8b3c3873, 01a166bd-f4d9-7427-9b9a-881b61fe8b18 and
 *   01a166bd-f6ac-71d8-86c1-3494875a3e14: the content per kind.
 */

const VIEW_A = '11111111-1111-4111-8111-11111111111a'
const VIEW_B = '11111111-1111-4111-8111-11111111111b'
const FLOW = '33333333-3333-4333-8333-333333333331'
const STEP_1 = '44444444-4444-4444-8444-444444444441'
const STEP_2 = '44444444-4444-4444-8444-444444444442'
const STEP_3 = '44444444-4444-4444-8444-444444444443'
const ASSET = '55555555-5555-4555-8555-555555555551'
const ASSET_BYTES = Buffer.from('logo-bytes')
const READY = '22222222-2222-4222-8222-000000000001'
const REOPENED = '22222222-2222-4222-8222-000000000002'
const SILENT = '22222222-2222-4222-8222-000000000003'
const DECISION = (n: number) => `66666666-6666-4666-8666-00000000000${n}`
const ID = (prefix: string, n: number) => `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${String(n).padStart(12, '0')}`

const AGENT = { type: 'agent', id: 'member:33333333-3333-4333-8333-333333333331', displayName: 'Ada' }
const OTHER_AGENT = { type: 'agent', id: 'member:33333333-3333-4333-8333-333333333332', displayName: 'Ada' }
const HUMAN = { type: 'human', displayName: 'Mei' }
/** Another id-less actor: id-less actors are told apart by `displayName`. */
const OTHER_HUMAN = { type: 'human', displayName: 'Lin' }
const EVIDENCE = [{ kind: 'screenshot', evidence: `sha256:${'d'.repeat(64)}` }]
/** 250 grapheme clusters of two code units each, so a code-unit cut would differ from a grapheme cut. */
const LONG_TEXT = 'é'.repeat(200) + 'TAIL-NOT-IN-EXCERPT' + 'é'.repeat(31)
const CORE_KEYS = ['kind', 'key', 'revision', 'diagnosticCount', 'summary']

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function viewA(): ViewResource {
	return {
		id: VIEW_A,
		name: 'Checkout',
		feature: 'payments',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay', props: {}, bindings: {}, events: {} }] } },
		variants: { empty: { state: {} }, error: { state: {} } },
		spec: {
			intent: LONG_TEXT,
			entryConditions: ['signed in'],
			interactionRules: ['pay once', 'confirm', 'cancel'],
			constraints: [],
			accessibility: ['focus order'],
			references: [{ type: 'external', uri: 'https://example.com/spec' }, { type: 'view', viewId: VIEW_B }],
			decisions: [
				{ id: DECISION(1), question: 'One button?', status: 'pending', history: [] },
				{ id: DECISION(2), question: 'Show tax?', status: 'pending', history: [] },
				{ id: DECISION(3), question: 'Promo codes?', status: 'deferred', history: [] },
				{ id: DECISION(4), question: 'Currency?', status: 'decided', outcome: { summary: 'Local', rationale: 'Clarity' }, history: [] },
			],
		},
	}
}

function viewB(): ViewResource {
	return {
		id: VIEW_B,
		name: 'Receipt',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: 'Show the receipt.', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function flow(): FlowResource {
	return {
		id: FLOW,
		name: 'Pay',
		entryStepId: STEP_1,
		steps: {
			[STEP_1]: { target: { viewId: VIEW_A }, transitions: [{ trigger: { widgetId: 'pay', event: 'click' }, targetStepId: STEP_2 }, { trigger: { widgetId: 'pay', event: 'dblclick' }, targetStepId: STEP_3 }] },
			[STEP_2]: { target: { viewId: VIEW_B }, transitions: [] },
			[STEP_3]: { target: { viewId: VIEW_A, variantName: 'error' }, transitions: [{ trigger: { widgetId: 'pay', event: 'click' }, targetStepId: STEP_2 }] },
		},
	}
}

function submission(n: number, at: string) {
	return { id: ID('f', n), actor: AGENT, at, changeDomains: ['ir'], resources: [{ identity: { type: 'view', id: VIEW_A }, revision: `sha256:${'a'.repeat(64)}` }], scope: {}, evidenceRefs: EVIDENCE }
}

function lifecycle(n: number, at: string, from: string, to: string, actor: unknown, extra: Record<string, unknown> = {}) {
	return { id: ID('d', n), kind: 'lifecycle', actor, at, from, to, ...extra }
}

function threads(): ReviewThread[] {
	const fixtures: unknown[] = [
		{
			id: READY,
			anchor: { viewId: VIEW_A, widgetId: 'pay' },
			variantNames: [],
			status: 'ready-for-review',
			messages: [
				{ id: ID('c', 1), actor: HUMAN, at: '2026-10-01T08:00:00Z', body: LONG_TEXT },
				{ id: ID('c', 2), actor: AGENT, at: '2026-10-01T09:00:00Z', body: 'Fixed.' },
				{ id: ID('c', 3), actor: HUMAN, at: '2026-10-01T09:30:00Z', body: 'Thanks.' },
				{ id: ID('c', 4), actor: OTHER_AGENT, at: '2026-10-01T09:40:00Z', body: 'Also checked.' },
				{ id: ID('c', 6), actor: OTHER_HUMAN, at: '2026-10-01T09:50:00Z', body: 'Looks right.' },
			],
			submissions: [submission(1, '2026-10-01T10:00:00Z')],
			history: [lifecycle(1, '2026-10-01T10:00:00Z', 'open', 'ready-for-review', AGENT, { submissionId: ID('f', 1) })],
		},
		{
			id: REOPENED,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'open',
			messages: [{ id: ID('c', 5), actor: AGENT, at: '2026-10-02T08:00:00Z', body: 'Still wrong.' }],
			submissions: [submission(2, '2026-10-02T09:00:00Z')],
			history: [
				lifecycle(2, '2026-10-02T09:00:00Z', 'open', 'ready-for-review', AGENT, { submissionId: ID('f', 2) }),
				lifecycle(3, '2026-10-02T10:00:00Z', 'ready-for-review', 'open', HUMAN),
			],
		},
		{
			id: SILENT,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'resolved',
			messages: [],
			submissions: [],
			history: [lifecycle(4, '2026-10-03T08:00:00Z', 'open', 'resolved', HUMAN, { resolution: 'obsolete' })],
		},
	]
	return fixtures as ReviewThread[]
}

async function session(options: Parameters<typeof createWorkspaceApplicationSession>[1] = {}) {
	const root = await mkdtemp(join(tmpdir(), 'uiux-discovery-detail-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await persistence.views.create(VIEW_A, viewA())
	await persistence.views.create(VIEW_B, viewB())
	await persistence.flows.create(FLOW, flow())
	await persistence.locales.create('en-US', { greeting: 'Hello', farewell: 'Bye' })
	await persistence.locales.create('zh-TW', { greeting: '你好' })
	await persistence.assets.create(ASSET, { metadata: { id: ASSET, name: 'Logo', contentFilename: 'logo.bin', mediaType: 'application/octet-stream' }, content: ASSET_BYTES })
	for (const thread of threads())
		await persistence.reviews.create(thread.id, thread)
	const app = createWorkspaceApplicationSession(persistence, options)
	for (const item of page(await listResourcesForHttp(app, { limit: 100 })).items)
		expect(item.diagnosticCount, `${item.kind} ${item.key}`).toBe(0)
	return Object.assign(app, { root, persistence })
}

type App = Awaited<ReturnType<typeof session>>

function page(result: ResourceDiscoveryHttpResult) {
	if (result.status !== 200) throw new Error(`Expected a discovery page, got ${JSON.stringify(result.body)}`)
	return result.body
}

function diagnosticCodes(result: ResourceDiscoveryHttpResult): string[] {
	const body = result.body as { diagnostics?: readonly { code: string }[] }
	return (body.diagnostics ?? []).map(diagnostic => diagnostic.code)
}

function detailOf(items: readonly ResourceDiscoveryItem[], key: string): unknown {
	const item = items.find(entry => entry.key === key)
	if (!item) throw new Error(`Expected item ${key}`)
	return item.detail
}

async function walk(app: App, input: Record<string, unknown>): Promise<ResourceDiscoveryItem[]> {
	const collected: ResourceDiscoveryItem[] = []
	let cursor: string | undefined
	do {
		const next = page(await listResourcesForHttp(app, { ...input, limit: 2, ...(cursor ? { cursor } : {}) }))
		collected.push(...next.items)
		cursor = next.nextCursor
	} while (cursor)
	return collected
}

describe('discovery detail selector (Clause 01a166bd-ef89)', { timeout: 30_000 }, () => {
	it('keeps the default result compact: no detail, and "summary" is byte-for-byte the same', async () => {
		const app = await session()
		for (const search of [false, true]) {
			const run = (input: Record<string, unknown>) => search
				? searchResourcesForHttp(app, { query: 'e', limit: 100, ...input })
				: listResourcesForHttp(app, { limit: 100, ...input })
			const plain = page(await run({}))
			expect(plain.items.length).toBeGreaterThan(0)
			for (const item of plain.items) expect(Object.keys(item), item.key).toEqual(CORE_KEYS)
			expect(JSON.stringify(page(await run({ detail: 'summary' })))).toBe(JSON.stringify(plain))
		}
	})

	it('adds only a detail member when expanded, leaving the rest of each item unchanged', async () => {
		const app = await session()
		const plain = page(await listResourcesForHttp(app, { limit: 100 })).items
		const expanded = page(await listResourcesForHttp(app, { limit: 100, detail: 'expanded' })).items
		expect(expanded.map(item => item.key)).toEqual(plain.map(item => item.key))
		for (const [index, item] of expanded.entries()) {
			expect(Object.keys(item), item.key).toEqual([...CORE_KEYS, 'detail'])
			expect(JSON.stringify({ ...item, detail: undefined })).toBe(JSON.stringify(plain[index]))
		}
	})

	it('expands Views with Variant names, an intent excerpt, spec list counts and Decision counts (Clause 01a166bd-f310)', async () => {
		const app = await session()
		const items = page(await listResourcesForHttp(app, { kinds: ['view'], limit: 100, detail: 'expanded' })).items
		expect(detailOf(items, VIEW_A)).toEqual({
			variantNames: ['empty', 'error'],
			intentExcerpt: 'é'.repeat(200),
			specCounts: { entryConditions: 1, interactionRules: 3, constraints: 0, accessibility: 1, references: 2 },
			decisionCounts: { pending: 2, deferred: 1, decided: 1 },
		})
		expect(detailOf(items, VIEW_B)).toEqual({
			variantNames: [],
			intentExcerpt: 'Show the receipt.',
			specCounts: { entryConditions: 0, interactionRules: 0, constraints: 0, accessibility: 0, references: 0 },
			decisionCounts: { pending: 0, deferred: 0, decided: 0 },
		})
		// The IR and the full Spec stay behind the Resource.
		expect(JSON.stringify(items)).not.toContain('TAIL-NOT-IN-EXCERPT')
		expect(JSON.stringify(items)).not.toContain('RootShell')
	})

	it('expands Flows, Locales and Assets (Clause 01a166bd-f4d9)', async () => {
		const app = await session()
		const items = page(await listResourcesForHttp(app, { kinds: ['flow', 'locale', 'asset'], limit: 100, detail: 'expanded' })).items
		expect(detailOf(items, FLOW)).toEqual({ entryStepId: STEP_1, stepCount: 3, transitionCount: 3, viewIds: [VIEW_A, VIEW_B] })
		expect(detailOf(items, 'en-US')).toEqual({ isDefault: true })
		expect(detailOf(items, 'zh-TW')).toEqual({ isDefault: false })
		expect(detailOf(items, ASSET)).toEqual({ byteSize: ASSET_BYTES.byteLength, digest: `sha256:${createHash('sha256').update(ASSET_BYTES).digest('hex')}` })
		// Locale messages and Asset content stay behind the Resource.
		expect(JSON.stringify(items)).not.toContain('Hello')
		expect(JSON.stringify(items)).not.toContain('logo-bytes')
	})

	it('expands Review threads with counts, participants, a first-message excerpt and current evidence refs (Clause 01a166bd-f6ac)', async () => {
		const app = await session()
		const items = page(await listResourcesForHttp(app, { kinds: ['review'], limit: 100, detail: 'expanded' })).items
		expect(detailOf(items, READY)).toEqual({
			submissionCount: 1,
			historyCount: 1,
			participants: [HUMAN, AGENT, OTHER_AGENT, OTHER_HUMAN],
			firstMessageExcerpt: 'é'.repeat(200),
			evidenceRefs: EVIDENCE,
		})
		// Reopened since its submission: no current submission, so no evidence refs.
		expect(detailOf(items, REOPENED)).toEqual({ submissionCount: 1, historyCount: 2, participants: [AGENT, HUMAN], firstMessageExcerpt: 'Still wrong.' })
		expect(detailOf(items, SILENT)).toEqual({ submissionCount: 0, historyCount: 1, participants: [HUMAN] })
		expect(JSON.stringify(items)).not.toContain('TAIL-NOT-IN-EXCERPT')
	})

	it('pages the same with expansion, and a cursor carries over between summary and expanded', async () => {
		const app = await session()
		const plain = await walk(app, {})
		const expanded = await walk(app, { detail: 'expanded' })
		expect(plain.length).toBeGreaterThan(2)
		expect(expanded.map(item => item.key)).toEqual(plain.map(item => item.key))
		expect(expanded.every(item => item.detail !== undefined)).toBe(true)

		const first = page(await listResourcesForHttp(app, { limit: 2 }))
		const rest = page(await listResourcesForHttp(app, { limit: 2, detail: 'expanded', cursor: first.nextCursor }))
		expect(rest.items.map(item => item.key)).toEqual(plain.slice(2, 4).map(item => item.key))
		expect(page(await listResourcesForHttp(app, { limit: 100, detail: 'expanded' })).items).toHaveLength(plain.length)
		const refused = await listResourcesForHttp(app, { limit: 101, detail: 'expanded' })
		expect(diagnosticCodes(refused)).toEqual(['discovery.invalid_limit'])
	})

	it('refuses any other detail (Clause 01a166bd-f154)', async () => {
		const app = await session()
		for (const detail of ['full', 'Expanded', '', null, true, ['expanded'], { level: 'expanded' }]) {
			const listed = await listResourcesForHttp(app, { limit: 10, detail })
			expect(listed.status, JSON.stringify(detail)).toBe(400)
			expect(diagnosticCodes(listed), JSON.stringify(detail)).toEqual(['discovery.invalid_detail'])
			const searched = await searchResourcesForHttp(app, { query: 'pay', limit: 10, detail })
			expect(diagnosticCodes(searched), JSON.stringify(detail)).toEqual(['discovery.invalid_detail'])
		}
	})

	it('serves the same detail over MCP as over HTTP', async () => {
		const app = await session()
		const mcp = await connectMcp(app)
		try {
			const core = (list: readonly ResourceDiscoveryItem[]) => list.map(({ kind, key, revision, diagnosticCount, summary, detail }) => ({ kind, key, revision, diagnosticCount, summary, detail }))
			for (const detail of [undefined, 'summary', 'expanded']) {
				const args = { limit: 100, ...(detail ? { detail } : {}) }
				const listed = await mcp.client.callTool({ name: 'list_resources', arguments: args })
				const items = (listed.structuredContent as { items: ResourceDiscoveryItem[] }).items
				expect(core(items)).toEqual(core(page(await listResourcesForHttp(app, args)).items))
				expect(items.every(item => (item.detail !== undefined) === (detail === 'expanded')), String(detail)).toBe(true)
			}

			const searchArgs = { query: 'pay', kinds: ['view', 'flow'], limit: 100, detail: 'expanded' }
			const searched = await mcp.client.callTool({ name: 'search_resources', arguments: searchArgs })
			const found = (searched.structuredContent as { items: ResourceDiscoveryItem[] }).items
			expect(found.map(item => item.key)).toEqual([VIEW_A, FLOW])
			expect(core(found)).toEqual(core(page(await searchResourcesForHttp(app, searchArgs)).items))

			const refused = await mcp.client.callTool({ name: 'list_resources', arguments: { limit: 10, detail: 'full' } })
			expect(refused.isError).toBe(true)
			expect(JSON.stringify(refused.structuredContent ?? refused.content)).toContain('detail')
		}
		finally {
			await mcp.close()
		}
	})

	it('marks a participant removed from the roster as removed, like other Review reads', async () => {
		// Only the other agent is still on the roster.
		const app = await session({ memberIds: async () => new Set([OTHER_AGENT.id.slice('member:'.length)]) })
		const items = page(await listResourcesForHttp(app, { kinds: ['review'], limit: 100, detail: 'expanded' })).items
		expect((detailOf(items, READY) as { participants: unknown }).participants).toEqual([HUMAN, { ...AGENT, removed: true }, OTHER_AGENT, OTHER_HUMAN])
	})

	it('gives an unreadable item an empty detail and leaves out the members a malformed resource does not hold', async () => {
		const app = await session()
		const unreadable = '77777777-7777-4777-8777-777777777771'
		const malformedView = '77777777-7777-4777-8777-777777777772'
		const malformedThread = '22222222-2222-4222-8222-000000000009'
		await writeFile(join(app.root, 'views', `${unreadable}.view.json`), '{broken-json')
		await writeFile(join(app.root, 'views', `${malformedView}.view.json`), `${JSON.stringify({ id: malformedView, name: 'Broken', ir: { type: 'RootShell', id: 'root', slots: { content: [] } }, variants: { only: { state: {} } }, spec: { intent: 42, decisions: 'none' } })}\n`)
		await writeFile(join(app.root, 'reviews', `${malformedThread}.review.json`), `${JSON.stringify({
			id: malformedThread,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'ready-for-review',
			messages: [{ id: ID('c', 9), actor: 'not-an-actor', at: '2026-10-04T08:00:00Z', body: 'Hi' }],
			submissions: [{ ...submission(9, '2026-10-04T09:00:00Z'), evidenceRefs: [{ ...EVIDENCE[0], payload: 'inline-bytes' }, 'not-a-ref', { kind: 'screenshot' }] }],
			history: [lifecycle(9, '2026-10-04T09:00:00Z', 'open', 'ready-for-review', AGENT, { submissionId: ID('f', 9) })],
		})}\n`)
		const items = page(await listResourcesForHttp(app, { kinds: ['view', 'review'], limit: 100, detail: 'expanded' })).items
		const plain = page(await listResourcesForHttp(app, { kinds: ['view', 'review'], limit: 100 })).items
		expect(items.find(item => item.key === unreadable)).toMatchObject({ summary: {}, detail: {} })
		expect(items.find(item => item.key === malformedView)?.diagnosticCount).toBeGreaterThan(0)
		expect(detailOf(items, malformedView)).toEqual({ variantNames: ['only'] })
		expect(items.find(item => item.key === malformedThread)?.diagnosticCount).toBeGreaterThan(0)
		// Evidence refs keep only `{ kind, evidence }`, and drop entries of another shape.
		expect(detailOf(items, malformedThread)).toEqual({ submissionCount: 1, historyCount: 1, participants: [AGENT], firstMessageExcerpt: 'Hi', evidenceRefs: EVIDENCE })
		for (const [index, item] of items.entries())
			expect(JSON.stringify({ ...item, detail: undefined })).toBe(JSON.stringify(plain[index]))
	})

	it('leaves out isDefault, and keeps every Locale summary, when the Workspace manifest cannot be read', async () => {
		const app = await session()
		const plain = page(await listResourcesForHttp(app, { kinds: ['locale'], limit: 100 })).items
		vi.spyOn(app.persistence.workspace, 'readInspected').mockRejectedValue(new Error('manifest unavailable'))
		const items = page(await listResourcesForHttp(app, { kinds: ['locale'], limit: 100, detail: 'expanded' })).items
		expect(items.map(item => item.detail)).toEqual([{}, {}])
		expect(items.map(item => ({ ...item, detail: undefined }))).toEqual(plain.map(item => ({ ...item, detail: undefined })))
		expect(plain.map(item => item.summary)).toEqual([{ messageCount: 2 }, { messageCount: 1 }])
	})
})

/** Issue #311: a Review thread read with malformed members degrades only its own summary. */
describe('discovery of a Review thread with malformed members', () => {
	const BAD_BODY = '22222222-2222-4222-8222-0000000000b1'
	const BAD_ENTRIES = '22222222-2222-4222-8222-0000000000b2'

	async function sessionWithMalformedThreads() {
		const app = await session()
		await writeFile(join(app.root, 'reviews', `${BAD_BODY}.review.json`), `${JSON.stringify({
			id: BAD_BODY,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'open',
			messages: [
				{ id: ID('c', 7), actor: HUMAN, at: '2026-10-05T08:00:00Z', body: 'Fine.' },
				{ id: ID('c', 8), actor: HUMAN, at: '2026-10-05T09:00:00Z', body: 42 },
			],
			submissions: [],
			history: [],
		})}\n`)
		await writeFile(join(app.root, 'reviews', `${BAD_ENTRIES}.review.json`), `${JSON.stringify({
			id: BAD_ENTRIES,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'ready-for-review',
			messages: [null, 'not-a-message'],
			submissions: [null],
			history: [null, 7],
		})}\n`)
		return app
	}

	function summaryOf(items: readonly ResourceDiscoveryItem[], key: string) {
		const item = items.find(candidate => candidate.key === key)
		return item?.kind === 'review' ? item : undefined
	}

	function expectDegraded(items: readonly ResourceDiscoveryItem[]) {
		const bad = summaryOf(items, BAD_BODY)
		expect(bad?.diagnosticCount).toBeGreaterThan(0)
		expect(bad?.summary).toMatchObject({ messageCount: 2, latestActivityAt: '2026-10-05T09:00:00Z' })
		expect(bad?.summary).not.toHaveProperty('latestMessage')
		const entries = summaryOf(items, BAD_ENTRIES)
		expect(entries?.summary).not.toHaveProperty('latestMessage')
		expect(entries?.summary).not.toHaveProperty('currentSubmission')
		// The rest of the page is unchanged: a healthy thread still carries its latest message.
		expect(summaryOf(items, READY)?.summary.latestMessage?.excerpt).toBe('Looks right.')
	}

	it('omits latestMessage for the item and keeps the rest of the page over HTTP', async () => {
		const app = await sessionWithMalformedThreads()
		for (const detail of [undefined, 'expanded'] as const) {
			const args = { kinds: ['review'], limit: 100, ...(detail ? { detail } : {}) }
			const listed = await listResourcesForHttp(app, args)
			expect(listed.status, String(detail)).toBe(200)
			expectDegraded(page(listed).items)
			// Every Review key contains the query `22222222`, so search returns the same items.
			const searched = await searchResourcesForHttp(app, { ...args, query: '22222222' })
			expect(searched.status, String(detail)).toBe(200)
			expectDegraded(page(searched).items)
		}
	})

	it('omits latestMessage for the item and keeps the rest of the page over MCP', async () => {
		const app = await sessionWithMalformedThreads()
		const mcp = await connectMcp(app)
		try {
			for (const detail of [undefined, 'expanded']) {
				const args = { kinds: ['review'], limit: 100, ...(detail ? { detail } : {}) }
				const listed = await mcp.client.callTool({ name: 'list_resources', arguments: args })
				expect(listed.isError, String(detail)).toBeFalsy()
				expectDegraded((listed.structuredContent as { items: ResourceDiscoveryItem[] }).items)
				const searched = await mcp.client.callTool({ name: 'search_resources', arguments: { ...args, query: '22222222' } })
				expect(searched.isError, String(detail)).toBeFalsy()
				expectDegraded((searched.structuredContent as { items: ResourceDiscoveryItem[] }).items)
			}
		}
		finally {
			await mcp.close()
		}
	})
})
