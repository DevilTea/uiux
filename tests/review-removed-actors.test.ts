import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import type { ResourceDiscoveryItem } from '../src/application/dto/resource-discovery'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { markRemovedActor } from '../src/domain/reviews/removed-actors'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import { FileNativePersistence } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { pointResourceUri } from '../src/mcp/resource-uri'
import { readPointResourceForHttp } from '../src/server/point-resource'
import { listResourcesForHttp, searchResourcesForHttp } from '../src/server/resource-discovery'
import { connectMcp } from './support/access'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * A removed member's actor in Review reads (issue #79; owner decision in Discussion #241,
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19128072): an actor of kind
 * member whose member ID is not in the host's roster carries `removed: true` in a point read and
 * in a list or search summary, over HTTP and MCP. A current member and a non-member actor carry no
 * `removed` member, the recorded name is unchanged and the stored file is not rewritten.
 */

const VIEW = '11111111-1111-4111-8111-11111111111a'
const THREAD = '22222222-2222-4222-8222-000000000001'
const GONE_ID = '33333333-3333-4333-8333-333333333331'
const HERE_ID = '33333333-3333-4333-8333-333333333332'
const GONE = { type: 'agent', id: `member:${GONE_ID}`, displayName: 'Ada' }
const HERE = { type: 'human', id: `member:${HERE_ID}`, displayName: 'Mei' }
const ASSERTED = { type: 'human', displayName: 'Older reviewer' }
const SYSTEM = { type: 'system', id: 'system:baseline' }
const ROSTER: ReadonlySet<string> = new Set([HERE_ID])

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const view: ViewResource = {
	id: VIEW,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: {} },
	variants: {},
	spec: { intent: 'Checkout', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
}

const thread = {
	id: THREAD,
	anchor: { viewId: VIEW, widgetId: 'root' },
	variantNames: [],
	status: 'ready-for-review',
	messages: [
		{ id: 'c1', actor: GONE, at: '2026-10-01T08:00:00Z', body: 'first', edits: [{ id: 'e1', actor: GONE, at: '2026-10-01T08:30:00Z', previousBody: 'older' }] },
		{ id: 'c2', actor: HERE, at: '2026-10-01T09:00:00Z', body: 'reply' },
		{ id: 'c3', actor: ASSERTED, at: '2026-10-01T09:30:00Z', body: 'asserted' },
		{ id: 'c4', actor: GONE, at: '2026-10-01T10:00:00Z', body: 'last, by the departed member' },
	],
	submissions: [{ id: 's1', actor: GONE, at: '2026-10-01T11:00:00Z', changeDomains: ['ir'], resources: [{ identity: { type: 'view', id: VIEW }, revision: `sha256:${'a'.repeat(64)}` }], scope: {}, evidenceRefs: [{ kind: 'screenshot', evidence: `sha256:${'d'.repeat(64)}` }] }],
	history: [
		{ id: 'h1', kind: 'lifecycle', actor: GONE, at: '2026-10-01T11:00:00Z', from: 'open', to: 'ready-for-review', submissionId: 's1' },
		{ id: 'h2', kind: 'lifecycle', actor: SYSTEM, at: '2026-10-01T11:30:00Z', from: 'ready-for-review', to: 'ready-for-review' },
	],
} as unknown as ReviewThread

async function session(memberIds?: () => Promise<ReadonlySet<string>>) {
	const root = await mkdtemp(join(tmpdir(), 'uiux-review-removed-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await persistence.views.create(VIEW, view)
	await persistence.reviews.create(THREAD, thread)
	return { persistence, app: createWorkspaceApplicationSession(persistence, memberIds ? { memberIds } : {}) }
}

type Read = { resource: ReviewThread }

function expectMarked(read: ReviewThread): void {
	const [first, second, third, fourth] = read.messages
	expect(first!.actor).toEqual({ ...GONE, removed: true })
	expect(first!.edits![0]!.actor).toEqual({ ...GONE, removed: true })
	expect(second!.actor).toEqual(HERE)
	expect(third!.actor).toEqual(ASSERTED)
	expect(fourth!.actor).toEqual({ ...GONE, removed: true })
	expect(read.submissions[0]!.actor).toEqual({ ...GONE, removed: true })
	expect(read.history[0]!.actor).toEqual({ ...GONE, removed: true })
	expect(read.history[1]!.actor).toEqual(SYSTEM)
	expect('removed' in second!.actor).toBe(false)
	expect('removed' in third!.actor).toBe(false)
}

function latestActor(items: readonly ResourceDiscoveryItem[]) {
	const item = items.find(entry => entry.key === THREAD)
	if (item?.kind !== 'review') throw new Error('Expected the Review item')
	return item.summary.latestMessage!.actor
}

describe('removed members in Review reads (Rule 01a11485-f185-7c23-8f2a-e045a279cd27)', { timeout: 30_000 }, () => {
	it('marks only a member actor that is off the roster, in the point read over HTTP', async () => {
		const { app } = await session(async () => ROSTER)
		const result = await readPointResourceForHttp(app, 'review', THREAD)
		expect(result.status).toBe(200)
		expectMarked((result.body as unknown as Read).resource)
	})

	it('marks it in list and search summaries over HTTP, keeping the recorded name', async () => {
		const { app } = await session(async () => ROSTER)
		const listed = await listResourcesForHttp(app, { kinds: ['review'], limit: 10 })
		const searched = await searchResourcesForHttp(app, { query: THREAD, kinds: ['review'], limit: 10 })
		for (const result of [listed, searched]) {
			if (result.status !== 200) throw new Error(JSON.stringify(result.body))
			expect(latestActor(result.body.items)).toEqual({ type: 'agent', id: `member:${GONE_ID}`, displayName: 'Ada', removed: true })
		}
	})

	it('marks it in the point read and the summaries over MCP', async () => {
		const { app } = await session(async () => ROSTER)
		const mcp = await connectMcp(app)
		try {
			const read = await mcp.client.readResource({ uri: pointResourceUri({ kind: 'review', key: THREAD }) })
			const text = (read.contents[0] as { text: string }).text
			expectMarked((JSON.parse(text) as Read).resource)

			const listed = await mcp.client.callTool({ name: 'list_resources', arguments: { kinds: ['review'], limit: 10 } })
			expect(latestActor((listed.structuredContent as { items: ResourceDiscoveryItem[] }).items)).toMatchObject({ removed: true })
			const searched = await mcp.client.callTool({ name: 'search_resources', arguments: { query: THREAD, kinds: ['review'], limit: 10 } })
			expect(latestActor((searched.structuredContent as { items: ResourceDiscoveryItem[] }).items)).toMatchObject({ removed: true })
		}
		finally { await mcp.close() }
	})

	it('marks a current member in no read, and never rewrites the stored file', async () => {
		const { app, persistence } = await session(async () => new Set([GONE_ID, HERE_ID]))
		const result = await readPointResourceForHttp(app, 'review', THREAD)
		expect(JSON.stringify((result.body as unknown as Read).resource)).not.toContain('"removed"')

		const marked = await session(async () => ROSTER)
		await readPointResourceForHttp(marked.app, 'review', THREAD)
		expect(JSON.stringify((await marked.persistence.reviews.readInspected(THREAD))?.resource)).not.toContain('"removed"')
		expect(JSON.stringify((await persistence.reviews.readInspected(THREAD))?.resource)).not.toContain('"removed"')
	})

	it('reads the roster once per discovery request and marks nothing without a roster source', async () => {
		let reads = 0
		const counted = await session(async () => { reads += 1; return ROSTER })
		await listResourcesForHttp(counted.app, { kinds: ['review'], limit: 10 })
		expect(reads).toBe(1)

		const bare = await session()
		const result = await readPointResourceForHttp(bare.app, 'review', THREAD)
		expect(JSON.stringify((result.body as unknown as Read).resource)).not.toContain('"removed"')
	})

	it('reads Reviews unflagged, and not as unreadable, when the roster cannot be read', async () => {
		const { app } = await session(async () => { throw new Error('access.store_invalid') })
		const result = await readPointResourceForHttp(app, 'review', THREAD)
		expect(result.status).toBe(200)
		expect(JSON.stringify((result.body as unknown as Read).resource)).not.toContain('"removed"')
		const listed = await listResourcesForHttp(app, { kinds: ['review'], limit: 10 })
		if (listed.status !== 200) throw new Error(JSON.stringify(listed.body))
		expect(listed.body.items.map(item => item.key)).toEqual([THREAD])
		expect(latestActor(listed.body.items)).toEqual(GONE)
	})

	it('marks by member ID only', () => {
		expect(markRemovedActor({ type: 'human', id: 'user:someone' }, ROSTER)).toEqual({ type: 'human', id: 'user:someone' })
		expect(markRemovedActor({ type: 'human', displayName: 'No id' }, ROSTER)).toEqual({ type: 'human', displayName: 'No id' })
	})
})
