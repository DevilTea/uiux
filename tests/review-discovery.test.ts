import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ResourceDiscoveryItem, ReviewDiscoverySummary } from '../src/application/dto/resource-discovery'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { listResourcesForHttp, searchResourcesForHttp, type ResourceDiscoveryHttpResult } from '../src/server/resource-discovery'
import { connectMcp } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Review discovery summaries and filters (issue #84; owner acceptance in Discussion #241,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19123284).
 *
 * - Clause 01a163a5-719e-789d-a0fb-fc08646ed1d8: `latestMessage` and `currentSubmission`.
 * - Clauses 01a11544-6d38-7c63-958a-e0133b131fd3 and 01a163a5-7110-79e8-94ac-887c8eddde6a: the
 *   `status`, `viewId`, `variant`, `anchor` and `changeDomain` filters beside `resolution` and
 *   `anchorScope`.
 */

const VIEW_A = '11111111-1111-4111-8111-11111111111a'
const VIEW_B = '11111111-1111-4111-8111-11111111111b'
const VIEW_GONE = '11111111-1111-4111-8111-11111111111c'
const T = (n: number) => `22222222-2222-4222-8222-00000000000${n}`
const ID = (prefix: string, n: number) => `${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}${prefix}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${String(n).padStart(12, '0')}`
const READY = T(1)
const OPEN = T(2)
const VERIFIED = T(3)
const DISMISSED = T(4)
const REOPENED = T(5)
const ANSWERED_AFTER_REOPEN = T(6)
const GONE_VIEW = T(7)
const ALL_THREADS = [READY, OPEN, VERIFIED, DISMISSED, REOPENED, ANSWERED_AFTER_REOPEN, GONE_VIEW]

const AGENT = { type: 'agent', id: 'member:33333333-3333-4333-8333-333333333331', displayName: 'Ada' }
const HUMAN = { type: 'human', displayName: 'Mei' }
const EVIDENCE = [{ kind: 'screenshot', evidence: `sha256:${'d'.repeat(64)}` }]
/** 250 grapheme clusters of two code units each, so a code-unit cut would differ from a grapheme cut. */
const LONG_BODY = 'é'.repeat(200) + 'TAIL-NOT-IN-EXCERPT' + 'é'.repeat(31)
const EARLIER_BODY = 'EARLIER-MESSAGE-BODY'
const PREVIOUS_BODY = 'PREVIOUS-EDITED-BODY'

const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function view(id: string, name: string, widgets: readonly string[], variants: readonly string[]): ViewResource {
	return {
		id,
		name,
		ir: { type: 'RootShell', id: 'root', slots: { content: widgets.map(widget => ({ type: 'Button', id: widget, props: {}, bindings: {}, events: {} })) } },
		variants: Object.fromEntries(variants.map(variant => [variant, { state: {} }])),
		spec: { intent: name, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function submission(n: number, at: string, changeDomains: readonly string[], viewId = VIEW_A) {
	return { id: ID('f', n), actor: AGENT, at, changeDomains, resources: [{ identity: { type: 'view', id: viewId }, revision: `sha256:${'a'.repeat(64)}` }], scope: {}, evidenceRefs: EVIDENCE }
}

function lifecycle(n: number, at: string, from: string, to: string, extra: Record<string, unknown> = {}) {
	return { id: ID('d', n), kind: 'lifecycle', actor: to === 'resolved' ? HUMAN : AGENT, at, from, to, ...extra }
}

function message(n: number, at: string, body: string, edits?: readonly unknown[]) {
	return { id: ID('c', n), actor: n % 2 ? HUMAN : AGENT, at, body, ...(edits ? { edits } : {}) }
}

function threads(): ReviewThread[] {
	const fixtures: unknown[] = [
		{
			id: READY,
			anchor: { viewId: VIEW_A, widgetId: 'button-1' },
			variantNames: ['alt'],
			status: 'ready-for-review',
			messages: [
				message(1, '2026-10-01T08:00:00Z', EARLIER_BODY),
				message(2, '2026-10-01T09:00:00Z', LONG_BODY, [{ id: ID('e', 1), actor: AGENT, at: '2026-10-01T09:05:00Z', previousBody: PREVIOUS_BODY }]),
			],
			submissions: [submission(1, '2026-10-01T10:00:00Z', ['ir', 'variant'])],
			history: [lifecycle(1, '2026-10-01T10:00:00Z', 'open', 'ready-for-review', { submissionId: ID('f', 1) })],
		},
		{
			id: OPEN,
			anchor: { viewId: VIEW_A, widgetId: 'root' },
			variantNames: [],
			status: 'open',
			messages: [message(3, '2026-10-02T08:00:00Z', 'Short note.')],
			submissions: [],
			history: [],
		},
		{
			id: VERIFIED,
			anchor: { viewId: VIEW_B, widgetId: 'root' },
			variantNames: [],
			status: 'resolved',
			messages: [message(4, '2026-10-03T08:00:00Z', 'Fix the copy.')],
			submissions: [submission(2, '2026-10-03T09:00:00Z', ['spec'], VIEW_B)],
			history: [
				lifecycle(2, '2026-10-03T09:00:00Z', 'open', 'ready-for-review', { submissionId: ID('f', 2) }),
				lifecycle(3, '2026-10-03T10:00:00Z', 'ready-for-review', 'resolved', { submissionId: ID('f', 2), resolution: 'verified' }),
			],
		},
		{
			id: DISMISSED,
			anchor: { scope: 'workspace' },
			variantNames: [],
			status: 'resolved',
			messages: [],
			submissions: [],
			history: [lifecycle(4, '2026-10-04T08:00:00Z', 'open', 'resolved', { resolution: 'wont-fix' })],
		},
		{
			id: REOPENED,
			anchor: { viewId: VIEW_A, widgetId: 'gone-widget' },
			variantNames: [],
			status: 'open',
			messages: [message(5, '2026-10-05T08:00:00Z', 'Still wrong.')],
			submissions: [submission(3, '2026-10-05T09:00:00Z', ['variant'])],
			history: [
				lifecycle(5, '2026-10-05T09:00:00Z', 'open', 'ready-for-review', { submissionId: ID('f', 3) }),
				lifecycle(6, '2026-10-05T10:00:00Z', 'ready-for-review', 'open'),
			],
		},
		{
			id: ANSWERED_AFTER_REOPEN,
			anchor: { viewId: VIEW_A, widgetId: 'root' },
			variantNames: ['ghost'],
			status: 'resolved',
			messages: [message(6, '2026-10-06T08:00:00Z', 'Answered in chat.')],
			submissions: [submission(4, '2026-10-06T09:00:00Z', ['metadata'])],
			history: [
				lifecycle(7, '2026-10-06T09:00:00Z', 'open', 'ready-for-review', { submissionId: ID('f', 4) }),
				lifecycle(8, '2026-10-06T10:00:00Z', 'ready-for-review', 'open'),
				lifecycle(9, '2026-10-06T11:00:00Z', 'open', 'resolved', { resolution: 'answered' }),
			],
		},
		{
			id: GONE_VIEW,
			anchor: { viewId: VIEW_GONE, widgetId: 'root' },
			variantNames: [],
			status: 'open',
			messages: [message(7, '2026-10-07T08:00:00Z', 'The View was deleted.')],
			submissions: [],
			history: [],
		},
	]
	return fixtures as ReviewThread[]
}

async function session() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-review-discovery-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await persistence.views.create(VIEW_A, view(VIEW_A, 'Checkout', ['button-1'], ['alt']))
	await persistence.views.create(VIEW_B, view(VIEW_B, 'Receipt', [], []))
	for (const id of [VIEW_A, VIEW_B])
		expect((await persistence.views.readInspected(id))?.diagnostics, id).toEqual([])
	for (const thread of threads()) {
		await persistence.reviews.create(thread.id, thread)
		expect((await persistence.reviews.readInspected(thread.id))?.diagnostics, thread.id).toEqual([])
	}
	return { persistence, app: createWorkspaceApplicationSession(persistence) }
}

function page(result: ResourceDiscoveryHttpResult) {
	if (result.status !== 200) throw new Error(`Expected a discovery page, got ${JSON.stringify(result.body)}`)
	return result.body
}

function summaryOf(items: readonly ResourceDiscoveryItem[], key: string): ReviewDiscoverySummary {
	const item = items.find(entry => entry.key === key)
	if (item?.kind !== 'review') throw new Error(`Expected Review item ${key}`)
	return item.summary
}

function diagnosticCodes(result: ResourceDiscoveryHttpResult): string[] {
	const body = result.body as { diagnostics?: readonly { code: string }[] }
	return (body.diagnostics ?? []).map(diagnostic => diagnostic.code)
}

type App = Awaited<ReturnType<typeof session>>['app']

async function keys(app: App, input: Record<string, unknown>): Promise<string[]> {
	return page(await listResourcesForHttp(app, { limit: 100, ...input })).items.map(item => item.key)
}

describe('Review discovery summaries (Clause 01a163a5-719e)', { timeout: 30_000 }, () => {
	it('carries the latest message with a 200-grapheme excerpt and the current submission, and nothing more of the thread', async () => {
		const { app } = await session()
		const items = page(await listResourcesForHttp(app, { kinds: ['review'], limit: 100 })).items
		expect(items.map(item => item.key)).toEqual(ALL_THREADS)

		const ready = summaryOf(items, READY)
		expect(ready.latestMessage).toEqual({ id: ID('c', 2), actor: AGENT, at: '2026-10-01T09:00:00Z', excerpt: 'é'.repeat(200), edited: true })
		expect([...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(ready.latestMessage!.excerpt)]).toHaveLength(200)
		expect(ready.currentSubmission).toEqual({ id: ID('f', 1), at: '2026-10-01T10:00:00Z', changeDomains: ['ir', 'variant'] })
		expect(ready.messageCount).toBe(2)

		// No content beyond the excerpt: not the rest of the body, earlier messages, edits, or submission payloads.
		const serialized = JSON.stringify(items)
		for (const hidden of ['TAIL-NOT-IN-EXCERPT', EARLIER_BODY, PREVIOUS_BODY, 'previousBody', 'evidenceRefs', 'resources', 'history', '"messages"', '"submissions"', '"body"'])
			expect(serialized).not.toContain(hidden)

		expect(summaryOf(items, OPEN).latestMessage).toEqual({ id: ID('c', 3), actor: HUMAN, at: '2026-10-02T08:00:00Z', excerpt: 'Short note.', edited: false })
		expect(summaryOf(items, OPEN).currentSubmission).toBeUndefined()
		// Resolved keeps the accepted submission.
		expect(summaryOf(items, VERIFIED).currentSubmission).toEqual({ id: ID('f', 2), at: '2026-10-03T09:00:00Z', changeDomains: ['spec'] })
		// A thread with no message has no latestMessage.
		expect(summaryOf(items, DISMISSED).latestMessage).toBeUndefined()
		expect(summaryOf(items, DISMISSED).currentSubmission).toBeUndefined()
		// After a reopen the earlier submission is no longer current, even once resolved again directly.
		expect(summaryOf(items, REOPENED).currentSubmission).toBeUndefined()
		expect(summaryOf(items, ANSWERED_AFTER_REOPEN).currentSubmission).toBeUndefined()

		// Search returns the same summary.
		const found = page(await searchResourcesForHttp(app, { kinds: ['review'], query: VIEW_A, limit: 100 })).items
		expect(summaryOf(found, READY)).toEqual(ready)
	})
})

describe('currentSubmission after a reopen (owner confirmation 2, #241 comment 19123763)', { timeout: 30_000 }, () => {
	it('judges a reopen by its position in history, even when its time equals the submission time', async () => {
		const { persistence, app } = await session()
		const id = '22222222-2222-4222-8222-000000000008'
		const at = '2026-10-08T09:00:00Z'
		const thread = {
			id,
			anchor: { viewId: VIEW_B, widgetId: 'root' },
			variantNames: [],
			status: 'resolved',
			messages: [message(8, '2026-10-08T08:00:00Z', 'Same instant.')],
			submissions: [submission(5, at, ['asset'], VIEW_B)],
			history: [
				lifecycle(10, at, 'open', 'ready-for-review', { submissionId: ID('f', 5) }),
				lifecycle(11, at, 'ready-for-review', 'open'),
				lifecycle(12, '2026-10-08T10:00:00Z', 'open', 'resolved', { resolution: 'answered' }),
			],
		} as unknown as ReviewThread
		await persistence.reviews.create(id, thread)
		expect((await persistence.reviews.readInspected(id))?.diagnostics).toEqual([])
		const items = page(await listResourcesForHttp(app, { kinds: ['review'], viewId: [VIEW_B], limit: 100 })).items
		expect(items.map(item => item.key)).toEqual([VERIFIED, id])
		expect(summaryOf(items, id).currentSubmission).toBeUndefined()
		expect(summaryOf(items, VERIFIED).currentSubmission?.id).toBe(ID('f', 2))
	})
})

describe('Review discovery filters (Clauses 01a11544-6d38 and 01a163a5-7110)', { timeout: 30_000 }, () => {
	it('narrows by each filter, and a Review filter excludes other kinds', async () => {
		const { app } = await session()
		const cases: [Record<string, unknown>, string[]][] = [
			[{ status: ['ready-for-review'] }, [READY]],
			[{ status: ['open'] }, [OPEN, REOPENED, GONE_VIEW]],
			[{ status: ['resolved'] }, [VERIFIED, ANSWERED_AFTER_REOPEN]],
			[{ status: ['dismissed'] }, [DISMISSED]],
			[{ status: ['resolved', 'dismissed'] }, [VERIFIED, DISMISSED, ANSWERED_AFTER_REOPEN]],
			[{ viewId: [VIEW_A] }, [READY, OPEN, REOPENED, ANSWERED_AFTER_REOPEN]],
			[{ viewId: [VIEW_B] }, [VERIFIED]],
			[{ viewId: ['workspace'] }, [DISMISSED]],
			[{ viewId: [VIEW_GONE, 'workspace'] }, [DISMISSED, GONE_VIEW]],
			[{ variant: ['alt'] }, [READY]],
			[{ variant: ['ghost'] }, [ANSWERED_AFTER_REOPEN]],
			// `*` is View-wide; a Workspace thread has no Variant scope.
			[{ variant: ['*'] }, [OPEN, VERIFIED, REOPENED, GONE_VIEW]],
			[{ anchor: ['missing'] }, [REOPENED, GONE_VIEW]],
			[{ anchor: ['stale'] }, [ANSWERED_AFTER_REOPEN]],
			[{ anchor: ['valid'] }, [READY, OPEN, VERIFIED, DISMISSED]],
			[{ changeDomain: ['ir'] }, [READY]],
			// Any submission counts, including one a reopen superseded.
			[{ changeDomain: ['variant'] }, [READY, REOPENED]],
			[{ changeDomain: ['spec', 'metadata'] }, [VERIFIED, ANSWERED_AFTER_REOPEN]],
			[{ changeDomain: ['asset'] }, []],
		]
		for (const [filter, expected] of cases) {
			expect(await keys(app, filter), JSON.stringify(filter)).toEqual(expected)
			expect(await keys(app, { kinds: ['review'], ...filter }), JSON.stringify(filter)).toEqual(expected)
		}
		// Without a Review filter the Views are listed too.
		expect(await keys(app, {})).toEqual([VIEW_A, VIEW_B, ...ALL_THREADS])
		expect(await keys(app, { kinds: ['view'], status: ['open'] })).toEqual([])
	})

	it('combines filters with AND, including resolution and anchorScope', async () => {
		const { app } = await session()
		const cases: [Record<string, unknown>, string[]][] = [
			[{ status: ['ready-for-review', 'open'], viewId: [VIEW_A] }, [READY, OPEN, REOPENED]],
			[{ status: ['open'], anchor: ['missing'] }, [REOPENED, GONE_VIEW]],
			[{ viewId: [VIEW_A], variant: ['*'], anchor: ['valid'] }, [OPEN]],
			[{ resolution: ['answered'], viewId: [VIEW_A] }, [ANSWERED_AFTER_REOPEN]],
			[{ resolution: ['verified', 'answered'], status: ['resolved'], changeDomain: ['spec'] }, [VERIFIED]],
			[{ anchorScope: ['workspace'], status: ['dismissed'] }, [DISMISSED]],
			[{ anchorScope: ['view'], status: ['dismissed'] }, []],
			[{ anchorScope: ['view'], anchor: ['valid'], changeDomain: ['ir', 'spec'] }, [READY, VERIFIED]],
		]
		for (const [filter, expected] of cases)
			expect(await keys(app, filter), JSON.stringify(filter)).toEqual(expected)
		const found = page(await searchResourcesForHttp(app, { query: VIEW_A, status: ['open'], anchor: ['valid'], limit: 100 })).items
		expect(found.map(item => item.key)).toEqual([OPEN])
	})

	it('refuses empty, repeated and unknown filter values', async () => {
		const { app } = await session()
		const cases: [string, unknown, string][] = [
			['status', [], 'discovery.empty_status_filter'],
			['status', ['closed'], 'discovery.invalid_status'],
			['status', ['open', 'open'], 'discovery.duplicate_status'],
			['viewId', [], 'discovery.empty_view_id_filter'],
			['viewId', ['checkout'], 'discovery.invalid_view_id'],
			['viewId', [VIEW_A, VIEW_A], 'discovery.duplicate_view_id'],
			['variant', [], 'discovery.empty_variant_filter'],
			['variant', [''], 'discovery.invalid_variant'],
			['variant', ['*', '*'], 'discovery.duplicate_variant'],
			['anchor', [], 'discovery.empty_anchor_filter'],
			['anchor', ['broken'], 'discovery.invalid_anchor'],
			['anchor', ['stale', 'stale'], 'discovery.duplicate_anchor'],
			['changeDomain', [], 'discovery.empty_change_domain_filter'],
			['changeDomain', ['views'], 'discovery.invalid_change_domain'],
			['changeDomain', ['ir', 'ir'], 'discovery.duplicate_change_domain'],
			['status', 'open', 'schema.expected_array'],
			['viewId', [42], 'discovery.invalid_view_id'],
		]
		for (const [key, value, code] of cases) {
			const listed = await listResourcesForHttp(app, { limit: 10, [key]: value })
			expect(listed.status, `${key}=${JSON.stringify(value)}`).toBe(400)
			expect(diagnosticCodes(listed), `${key}=${JSON.stringify(value)}`).toContain(code)
			const searched = await searchResourcesForHttp(app, { limit: 10, query: 'x', [key]: value })
			expect(diagnosticCodes(searched), `${key}=${JSON.stringify(value)}`).toContain(code)
		}
	})

	it('keeps cursors stable within one filter scope and refuses them in another', async () => {
		const { app } = await session()
		const filter = { status: ['open', 'resolved'], viewId: [VIEW_A, VIEW_GONE] }
		const expected = await keys(app, filter)
		expect(expected).toEqual([OPEN, REOPENED, ANSWERED_AFTER_REOPEN, GONE_VIEW])
		const collected: string[] = []
		let cursor: string | undefined
		do {
			const next = page(await listResourcesForHttp(app, { limit: 1, ...filter, ...(cursor ? { cursor } : {}) }))
			collected.push(...next.items.map(item => item.key))
			cursor = next.nextCursor
		} while (cursor)
		expect(collected).toEqual(expected)

		const first = page(await listResourcesForHttp(app, { limit: 2, ...filter }))
		expect(first.nextCursor).toBeDefined()
		// The same filters in another order are the same scope.
		const reordered = await listResourcesForHttp(app, { limit: 2, status: ['resolved', 'open'], viewId: [VIEW_GONE, VIEW_A], cursor: first.nextCursor })
		expect(page(reordered).items.map(item => item.key)).toEqual([ANSWERED_AFTER_REOPEN, GONE_VIEW])
		for (const other of [{ status: ['open'] }, { ...filter, anchor: ['valid'] }, { ...filter, variant: ['*'] }, { ...filter, changeDomain: ['ir'] }, { viewId: filter.viewId }]) {
			const refused = await listResourcesForHttp(app, { limit: 2, ...other, cursor: first.nextCursor })
			expect(refused.status, JSON.stringify(other)).toBe(400)
			expect(diagnosticCodes(refused)).toEqual(['discovery.invalid_cursor'])
		}
	})

	it('serves the same filters and summaries over MCP', async () => {
		const { app } = await session()
		const mcp = await connectMcp(app)
		try {
			const args = { status: ['ready-for-review', 'open'], viewId: [VIEW_A], anchor: ['valid'], limit: 100 }
			const listed = await mcp.client.callTool({ name: 'list_resources', arguments: args })
			const items = (listed.structuredContent as { items: ResourceDiscoveryItem[] }).items
			expect(items.map(item => item.key)).toEqual([READY, OPEN])
			// MCP adds each item's Resource URI; everything else matches HTTP.
			const core = (list: readonly ResourceDiscoveryItem[]) => list.map(({ kind, key, revision, diagnosticCount, summary }) => ({ kind, key, revision, diagnosticCount, summary }))
			expect(core(items)).toEqual(core(page(await listResourcesForHttp(app, args)).items))
			expect(summaryOf(items, READY).latestMessage?.excerpt).toBe('é'.repeat(200))

			const searched = await mcp.client.callTool({ name: 'search_resources', arguments: { query: 'root', variant: ['*'], changeDomain: ['spec'], limit: 100 } })
			expect((searched.structuredContent as { items: ResourceDiscoveryItem[] }).items.map(item => item.key)).toEqual([VERIFIED])

			const refused = await mcp.client.callTool({ name: 'list_resources', arguments: { viewId: ['checkout'], limit: 10 } })
			expect(refused.isError).toBe(true)
			expect(JSON.stringify(refused.structuredContent ?? refused.content)).toContain('/viewId/0: viewId values must be View IDs')
		}
		finally {
			await mcp.close()
		}
	})
})
