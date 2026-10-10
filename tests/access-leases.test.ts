import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PERMISSION_KEYS } from '../src/application/access/keys'
import { createLeaseManager, LEASE_TTL_MS, type LeaseHolder } from '../src/application/access/leases'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { AccessService } from '../src/server/access/service'
import { AccessStore } from '../src/server/access/store'
import { appendReviewMessageForHttp, mapAuthoringResultToHttpStatus, updateViewSpecForHttp } from '../src/server/authoring-http'
import { connectMcp, scoped, testMember } from './support/access'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const NEW_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const FLOW_KEY = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

const A: LeaseHolder = { memberId: 'a', nickname: 'claude-main', kind: 'agent' }
const B: LeaseHolder = { memberId: 'b', nickname: 'claude-wt-a', kind: 'agent' }
const HUMAN: LeaseHolder = { memberId: 'h', nickname: 'mei', kind: 'human' }
const VIEW = { kind: 'view', key: VIEW_ID } as const

function clock(start = Date.parse('2026-10-05T14:00:00Z')) {
	let now = start
	return { now: () => now, advance(ms: number) { now += ms } }
}

describe('lease manager', () => {
	it('auto-acquires on an agent write, renews on the holder\'s writes and expires 5 minutes after the last one', () => {
		const time = clock()
		const leases = createLeaseManager({ now: time.now })
		const changes: string[] = []
		leases.onChange(change => changes.push(`${change.kind}:${change.key}`))
		const first = leases.beginWrite(VIEW, A, { autoAcquire: true })
		if (first.status !== 'ok') throw new Error('first')
		first.ticket.commit()
		expect(leases.find(VIEW)).toMatchObject({ holder: A, expiresAt: new Date(time.now() + LEASE_TTL_MS).toISOString() })
		expect(leases.beginWrite(VIEW, B, { autoAcquire: true })).toMatchObject({ status: 'locked', lease: { holder: A } })
		expect(leases.beginWrite(VIEW, HUMAN, { autoAcquire: false })).toMatchObject({ status: 'locked' })

		time.advance(4 * 60 * 1000)
		const renew = leases.beginWrite(VIEW, A, { autoAcquire: true })
		if (renew.status !== 'ok') throw new Error('renew')
		renew.ticket.commit()
		time.advance(4 * 60 * 1000)
		expect(leases.find(VIEW)?.holder).toEqual(A)
		time.advance(60 * 1000 + 1)
		expect(leases.find(VIEW)).toBeUndefined()
		expect(leases.beginWrite(VIEW, B, { autoAcquire: true }).status).toBe('ok')
		expect(changes.length).toBeGreaterThanOrEqual(3)
	})

	it('never lets a failed write create a lease, never lets humans hold one, and keeps an existing lease on failure', () => {
		const leases = createLeaseManager()
		const failed = leases.beginWrite(VIEW, A, { autoAcquire: true })
		if (failed.status !== 'ok') throw new Error('begin')
		// The tentative reservation blocks others while the write is in flight.
		expect(leases.beginWrite(VIEW, B, { autoAcquire: true }).status).toBe('locked')
		failed.ticket.abort()
		expect(leases.find(VIEW)).toBeUndefined()
		const human = leases.beginWrite(VIEW, HUMAN, { autoAcquire: false })
		if (human.status !== 'ok') throw new Error('human')
		human.ticket.commit()
		expect(leases.list()).toEqual([])

		expect(leases.acquire([VIEW], A).status).toBe('acquired')
		const expiresAt = leases.find(VIEW)!.expiresAt
		const again = leases.beginWrite(VIEW, A, { autoAcquire: true })
		if (again.status !== 'ok') throw new Error('again')
		again.ticket.abort()
		expect(leases.find(VIEW)?.expiresAt).toBe(expiresAt)
	})

	it('acquires all-or-nothing, releases idempotently, force-releases and drops a removed holder', () => {
		const leases = createLeaseManager()
		const flow = { kind: 'flow', key: FLOW_KEY } as const
		expect(leases.acquire([VIEW], B).status).toBe('acquired')
		expect(leases.acquire([flow, VIEW], A)).toMatchObject({ status: 'locked', conflicts: [{ kind: 'view', holder: B }] })
		expect(leases.find(flow)).toBeUndefined()
		expect(leases.release(A, [VIEW])).toEqual([])
		expect(leases.release(B).map(lease => lease.key)).toEqual([VIEW_ID])
		expect(leases.release(B)).toEqual([])
		leases.acquire([VIEW, flow], A)
		expect(leases.forceRelease(VIEW)?.holder).toEqual(A)
		expect(leases.forceRelease(VIEW)).toBeUndefined()
		expect(leases.dropHolder('a').map(lease => lease.kind)).toEqual(['flow'])
		expect(leases.list()).toEqual([])
	})

	it('commits nothing after a force-release that happened while the holder\'s write was in flight', () => {
		const leases = createLeaseManager()
		const begun = leases.beginWrite(VIEW, A, { autoAcquire: true })
		if (begun.status !== 'ok') throw new Error('begin')
		leases.forceRelease(VIEW)
		begun.ticket.commit()
		expect(leases.find(VIEW)).toBeUndefined()
	})
})

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-leases-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	const review = await app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
	if (view.status !== 'created' || review.status !== 'created') throw new Error('fixture')
	return { app, viewRevision: view.revision, reviewRevision: review.revision }
}

describe('leases through MCP and HTTP', () => {
	it('locks a View for other writers with 423 resource.locked, complements CAS, and yields to an Owner force-release', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const claude = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
		const other = testMember({ nickname: 'claude-wt-a', kind: 'agent', role: 'editor', credential: 'token' })
		const owner = testMember({ nickname: 'deviltea', kind: 'human', role: 'owner', credential: 'session' })
		const agent = await connectMcp(ctx.app, claude, { leases })
		const second = await connectMcp(ctx.app, other, { leases })
		try {
			// A failed agent write (stale revision) takes no lease.
			const stale = await agent.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: 'sha256:' + '0'.repeat(64), spec: spec('stale') } })
			expect(stale.structuredContent).toMatchObject({ status: 'conflict' })
			expect(leases.list()).toEqual([])

			const write = await agent.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('agent step 1') } })
			expect(write.isError).not.toBe(true)
			const agentRevision = (write.structuredContent as { revision: string }).revision
			expect(leases.list()).toMatchObject([{ kind: 'view', key: VIEW_ID, holder: { nickname: 'claude', kind: 'agent' } }])

			// A human write only checks: it gets 423 with the holder and expiry and changes nothing.
			const human = await updateViewSpecForHttp(scoped(ctx.app, owner, { leases }), VIEW_ID, { expectedRevision: agentRevision, spec: spec('human edit') })
			expect(human.status).toBe(423)
			expect(human.body).toMatchObject({
				status: 'locked',
				key: VIEW_ID,
				code: 'resource.locked',
				message: expect.stringMatching(new RegExp(`^view ${VIEW_ID} is locked by claude until .+Z\\.$`, 'u')),
				lock: { kind: 'view', key: VIEW_ID, holder: { nickname: 'claude', kind: 'agent' }, expiresAt: leases.list()[0]!.expiresAt },
			})
			expect(mapAuthoringResultToHttpStatus('locked')).toBe(423)
			const otherAgent = await second.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: agentRevision, spec: spec('other agent') } })
			expect(otherAgent.isError).toBe(true)
			expect(otherAgent.structuredContent).toMatchObject({ status: 'locked', code: 'resource.locked' })
			expect((await ctx.app.readPointResource('view', VIEW_ID))?.revision).toBe(agentRevision)
			// Promotion writes the View, so it checks the View's lease too; Review threads are never locked.
			const promote = await second.client.callTool({ name: 'promote_review_to_decision', arguments: { reviewId: REVIEW_ID, expectedReviewRevision: ctx.reviewRevision, viewId: VIEW_ID, expectedViewRevision: agentRevision, question: 'Keep it?' } })
			expect(promote.structuredContent).toMatchObject({ status: 'locked', lock: { kind: 'view' } })
			const reply = await appendReviewMessageForHttp(scoped(ctx.app, owner, { leases }), REVIEW_ID, { expectedRevision: ctx.reviewRevision, body: 'Replying while the View is leased.' })
			expect(reply.status).toBe(200)
			const lockReview = await agent.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'review', key: REVIEW_ID }] } })
			expect(lockReview.isError).toBe(true)

			// The Owner is not exempt: force-release first, then write; the agent's next write fails CAS.
			const session = scoped(ctx.app, owner, { leases })
			expect(session.listLeases()).toHaveLength(1)
			expect(session.forceReleaseLease({ kind: 'view', key: VIEW_ID })).toMatchObject({ status: 'released', lease: { holder: { nickname: 'claude' } } })
			const humanAfter = await updateViewSpecForHttp(session, VIEW_ID, { expectedRevision: agentRevision, spec: spec('human edit') })
			expect(humanAfter.status).toBe(200)
			expect(leases.list()).toEqual([])
			const agentAgain = await agent.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: agentRevision, spec: spec('agent step 2') } })
			expect(agentAgain.structuredContent).toMatchObject({ status: 'conflict' })
			expect(leases.list()).toEqual([])
		}
		finally {
			await agent.close()
			await second.close()
		}
	})

	it('serves acquire_lock / release_lock: all-or-nothing, renewing, idempotent and covering creates', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const agent = await connectMcp(ctx.app, testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' }), { leases })
		const other = await connectMcp(ctx.app, testMember({ nickname: 'other', kind: 'agent', role: 'editor', credential: 'token' }), { leases })
		try {
			const acquired = await agent.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'view', key: VIEW_ID }, { kind: 'workspace', key: 'workspace' }] } })
			expect(acquired.structuredContent).toMatchObject({ status: 'acquired', leases: [{ kind: 'view', key: VIEW_ID }, { kind: 'workspace', key: 'workspace' }] })
			const conflict = await other.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'flow', key: FLOW_KEY }, { kind: 'view', key: VIEW_ID }] } })
			expect(conflict.isError).toBe(true)
			expect(conflict.structuredContent).toMatchObject({ status: 'locked', code: 'resource.locked', locks: [{ kind: 'view', holder: { nickname: 'claude' } }] })
			expect(leases.find({ kind: 'flow', key: FLOW_KEY })).toBeUndefined()
			const renewed = await agent.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'view', key: VIEW_ID }] } })
			expect(renewed.structuredContent).toMatchObject({ status: 'acquired' })
			const badKey = await agent.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'workspace', key: 'other' }] } })
			expect(badKey.structuredContent).toMatchObject({ status: 'invalid', code: 'lease.invalid_resources' })

			// A create takes the new resource's lease for the agent.
			const created = await other.client.callTool({ name: 'create_view', arguments: { id: NEW_VIEW_ID, name: 'New', spec: spec('n') } })
			expect(created.isError).not.toBe(true)
			expect(leases.find({ kind: 'view', key: NEW_VIEW_ID })?.holder.nickname).toBe('other')

			expect((await other.client.callTool({ name: 'release_lock', arguments: { resources: [{ kind: 'view', key: VIEW_ID }] } })).structuredContent).toMatchObject({ status: 'released', released: [] })
			const released = await agent.client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.structuredContent).toMatchObject({ status: 'released', released: [{ kind: 'view' }, { kind: 'workspace' }] })
			expect((await agent.client.callTool({ name: 'release_lock', arguments: {} })).structuredContent).toMatchObject({ released: [] })
			expect(leases.list().map(lease => lease.key)).toEqual([NEW_VIEW_ID])
		}
		finally {
			await agent.close()
			await other.close()
		}
	})
})

describe('leases by write key (Rules 01a11c09-c125, 01a11485-f074, 01a11485-f08f)', () => {
	it('needs each requested kind\'s write key to acquire, refusing the whole request, and no key to release one\'s own leases', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const translator = scoped(ctx.app, testMember({ nickname: 'tran', kind: 'agent', credential: 'token', keys: ['workspace.read', 'reviews.write', 'locales.write'] }), { leases })
		expect(translator.acquireLeases({ resources: [{ kind: 'locale', key: 'en-US' }, { kind: 'view', key: VIEW_ID }, { kind: 'flow', key: FLOW_KEY }] }))
			.toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write', 'flows.write'] })
		expect(leases.list()).toEqual([])
		expect(translator.acquireLeases({ resources: [{ kind: 'locale', key: 'en-US' }] })).toMatchObject({ status: 'acquired', leases: [{ kind: 'locale', key: 'en-US' }] })
		// Malformed input is the request's fault once the member may lease some kind; a member that may lease none is refused first.
		expect(translator.acquireLeases({ resources: [] })).toMatchObject({ status: 'invalid', code: 'lease.invalid_resources' })
		const reader = scoped(ctx.app, testMember({ nickname: 'vera', kind: 'agent', role: 'viewer', credential: 'token' }), { leases })
		expect(reader.acquireLeases({ resources: [] })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write', 'flows.write', 'locales.write', 'assets.write', 'settings.write'] })
		// Releasing needs no key, and releases only one's own leases.
		expect(await reader.releaseLeases({})).toMatchObject({ status: 'released', released: [] })
		expect(leases.list()).toHaveLength(1)
		expect(await translator.releaseLeases({})).toMatchObject({ status: 'released', released: [{ kind: 'locale', key: 'en-US' }] })
		expect(leases.list()).toEqual([])
	})

	it('exempts no key holder from another member\'s lease: even every catalog key needs a force-release first', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const claude = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
		expect(scoped(ctx.app, claude, { leases }).acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'acquired' })
		const everyKey = scoped(ctx.app, testMember({ nickname: 'root', kind: 'human', credential: 'session', keys: PERMISSION_KEYS }), { leases })
		expect(await everyKey.updateViewSpec({ key: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('mine') })).toMatchObject({ status: 'locked', code: 'resource.locked' })
		expect(everyKey.forceReleaseLease({ kind: 'view', key: VIEW_ID })).toMatchObject({ status: 'released' })
		expect(await everyKey.updateViewSpec({ key: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('mine') })).toMatchObject({ status: 'updated' })
	})

	it('ends a lease when its holder loses the write key of the leased kind or is removed, and keeps it otherwise', async () => {
		const base = await mkdtemp(join(tmpdir(), 'uiux-leases-roster-'))
		roots.push(base)
		const workspaceRoot = join(base, 'design')
		await mkdir(workspaceRoot, { recursive: true })
		const store = (await AccessStore.open({ workspaceRoot, home: join(base, 'home'), create: true }))!
		const leases = createLeaseManager()
		const service = new AccessService({ store, leases })
		const bot = await service.addMember({ nickname: 'bot', role: 'editor', kind: 'agent' })
		const pal = await service.addMember({ nickname: 'pal', role: 'editor', kind: 'agent' })
		leases.acquire([{ kind: 'view', key: VIEW_ID }, { kind: 'flow', key: FLOW_KEY }], { memberId: bot.id, nickname: 'bot', kind: 'agent' })
		leases.acquire([{ kind: 'workspace', key: 'workspace' }], { memberId: pal.id, nickname: 'pal', kind: 'agent' })

		await service.setMember(bot.id, { nickname: 'bot-renamed' })
		expect(leases.list().map(lease => lease.kind)).toEqual(['flow', 'view', 'workspace'])
		await service.setMember(bot.id, { role: 'reviewer' })
		expect(leases.list().map(lease => [lease.holder.nickname, lease.kind])).toEqual([['pal', 'workspace']])
		await service.removeMember(pal.id)
		expect(leases.list()).toEqual([])
	})
})
