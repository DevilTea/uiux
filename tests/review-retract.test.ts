import { access, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { principalActor } from '../src/application/access/principal'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { FileNativePersistence, type PersistenceFaultPoint } from '../src/persistence'
import { reviewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	appendReviewMessageForHttp,
	createReviewThreadForHttp,
	editReviewMessageForHttp,
	mapAuthoringResultToHttpStatus,
	reanchorReviewThreadForHttp,
	resolveReviewThreadForHttp,
	retractReviewThreadForHttp,
	setReviewDisplayHintForHttp,
	submitReadyForReviewForHttp,
} from '../src/server/authoring-http'
import { AGENT_EDITOR, connectMcp, scoped, testMember } from './support/access'

/**
 * Accepted addendum "Author quick retract of a new Review thread" (Part 7,
 * discussioncomment-18772501): E1–E6, the empty-thread rule (Q1), no trace, both transports and
 * the persistence fault points.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const MEI = testMember({ nickname: 'mei', kind: 'human', role: 'reviewer', credential: 'session' })
const RUI = testMember({ nickname: 'rui', kind: 'human', role: 'owner', credential: 'session' })
const VIEWER = testMember({ nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spec(): ViewSpecContent {
	return { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

async function session(fault?: (point: PersistenceFaultPoint) => void) {
	const root = await mkdtemp(join(tmpdir(), 'uiux-retract-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, ...(fault ? { fault } : {}) })
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec() })
	if (view.status !== 'created') throw new Error('View fixture failed.')
	return { root, persistence, app, viewRevision: view.revision }
}

type Ctx = Awaited<ReturnType<typeof session>>

function body(result: { body: unknown }) {
	return result.body as { status: string; code?: string; reason?: string; revision?: string; diagnostics?: { code: string; path?: string }[] }
}

async function thread(ctx: Ctx, author = MEI, anchor: Record<string, unknown> = { viewId: VIEW_ID, widgetId: 'submit' }) {
	const created = await createReviewThreadForHttp(scoped(ctx.app, author), { id: REVIEW_ID, anchor })
	const posted = await appendReviewMessageForHttp(scoped(ctx.app, author), REVIEW_ID, { expectedRevision: body(created).revision!, body: 'Wrong Widget, sorry.' })
	return body(posted).revision!
}

async function exists(ctx: Ctx): Promise<boolean> {
	return access(join(ctx.root, reviewRelativePath(REVIEW_ID))).then(() => true, () => false)
}

describe('retract eligibility (E1–E6)', () => {
	it('lets the author hard-delete an unengaged thread: no file, no trace, then not_found', async () => {
		const ctx = await session()
		const revision = await thread(ctx)
		// The author's own edit and a pin move are not engagement (T9).
		const messageId = (await ctx.persistence.reviews.read(REVIEW_ID))!.resource.messages[0]!.id
		const edited = await editReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, messageId, { expectedRevision: revision, body: 'Wrong Widget.' })
		const moved = await setReviewDisplayHintForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: body(edited).revision!, displayHint: { pin: { x: 0.4, y: 0.4 } } })
		const retracted = await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: body(moved).revision! })
		expect(retracted.status).toBe(200)
		expect(retracted.body).toEqual({ status: 'deleted', key: REVIEW_ID })
		expect(await exists(ctx)).toBe(false)
		expect(await readdir(join(ctx.root, 'reviews'))).toEqual([])
		expect(await readdir(join(ctx.root, '.uiux')).then(entries => entries.filter(name => name.startsWith('.transactions')))).toEqual([])
		expect(await ctx.app.readPointResource('review', REVIEW_ID)).toBeUndefined()
		const again = await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: body(moved).revision! })
		expect(again.status).toBe(404)
		const reply = await appendReviewMessageForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: body(moved).revision!, body: 'late' })
		expect(reply.status).toBe(404)
	})

	it('refuses a non-author, the Owner included, and a Viewer by role', async () => {
		const ctx = await session()
		const revision = await thread(ctx)
		const owner = await retractReviewThreadForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision })
		expect(owner.status).toBe(422)
		expect(body(owner)).toMatchObject({ status: 'blocked', code: 'review.retract_not_author' })
		expect((await retractReviewThreadForHttp(scoped(ctx.app, VIEWER), REVIEW_ID, { expectedRevision: revision })).status).toBe(403)
		expect(await exists(ctx)).toBe(true)
	})

	it('refuses with review.retract_engaged and the matching reason once anyone engaged', async () => {
		const reasons: [string, (ctx: Ctx, revision: string) => Promise<string>][] = [
			['messages', async (ctx, revision) => body(await appendReviewMessageForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision, body: 'I see it.' })).revision!],
			['history', async (ctx, revision) => body(await reanchorReviewThreadForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision, anchor: { viewId: VIEW_ID, widgetId: 'root' } })).revision!],
			['status', async (ctx, revision) => body(await resolveReviewThreadForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision, resolution: 'obsolete' })).revision!],
			['status', async (ctx, revision) => {
				const evidence = await ctx.persistence.artifacts.put(new TextEncoder().encode('evidence'))
				return body(await submitReadyForReviewForHttp(scoped(ctx.app, AGENT_EDITOR), REVIEW_ID, {
					expectedRevision: revision,
					changeDomains: ['view-structure'],
					resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }],
					evidenceRefs: [{ kind: 'screenshot', evidence: evidence.identity }],
				})).revision!
			}],
			['history', async (ctx, revision) => {
				const resolved = body(await resolveReviewThreadForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision, resolution: 'answered' })).revision!
				return (await ctx.app.reopenReviewThread({ reviewId: REVIEW_ID, expectedRevision: resolved, actor: principalActor(RUI) }) as { revision: string }).revision
			}],
			['promoted', async (ctx, revision) => {
				const promoted = await ctx.app.promoteReviewToDecision({ reviewId: REVIEW_ID, expectedReviewRevision: revision, viewId: VIEW_ID, expectedViewRevision: ctx.viewRevision, question: 'Keep it?' })
				expect(promoted.status).toBe('updated')
				return (await ctx.persistence.reviews.readRevision(REVIEW_ID))!
			}],
		]
		for (const [reason, engage] of reasons) {
			const ctx = await session()
			const revision = await engage(ctx, await thread(ctx))
			const refused = await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revision })
			expect(refused.status, reason).toBe(422)
			expect(body(refused), reason).toMatchObject({ status: 'blocked', code: 'review.retract_engaged', reason, message: 'Someone has already engaged with this thread. Dismiss it instead.' })
			expect(await exists(ctx)).toBe(true)
		}
	})

	it('answers a stale revision with conflict and leaves the file (a racing reply wins)', async () => {
		const ctx = await session()
		const revision = await thread(ctx)
		await appendReviewMessageForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: revision, body: 'Racing reply' })
		const stale = await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revision })
		expect(stale.status).toBe(409)
		expect(await exists(ctx)).toBe(true)
		expect(body(await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: (await ctx.persistence.reviews.readRevision(REVIEW_ID))! }))).toMatchObject({ code: 'review.retract_engaged', reason: 'messages' })
	})

	it('lets any Reviewer retract an empty, authorless thread while it is open and unengaged (Q1)', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { scope: 'workspace' } })
		const byOther = await retractReviewThreadForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedRevision: body(created).revision! })
		expect(body(byOther)).toEqual({ status: 'deleted', key: REVIEW_ID })
		expect(await exists(ctx)).toBe(false)

		const ctx2 = await session()
		const empty = await createReviewThreadForHttp(scoped(ctx2.app, MEI), { id: REVIEW_ID, anchor: { scope: 'workspace' } })
		const resolved = await resolveReviewThreadForHttp(scoped(ctx2.app, MEI), REVIEW_ID, { expectedRevision: body(empty).revision!, resolution: 'obsolete' })
		expect(body(await retractReviewThreadForHttp(scoped(ctx2.app, RUI), REVIEW_ID, { expectedRevision: body(resolved).revision! }))).toMatchObject({ code: 'review.retract_engaged', reason: 'status' })
	})

	it('treats legacy authors without a member id as never retractable (T15) and validates input', async () => {
		const ctx = await session()
		const created = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const legacy = await ctx.app.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: (created as { revision: string }).revision, actor: { type: 'human', displayName: 'mei' }, body: 'old' })
		expect(body(await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: (legacy as { revision: string }).revision }))).toMatchObject({ code: 'review.retract_not_author' })
		expect((await retractReviewThreadForHttp(scoped(ctx.app, MEI), 'not-a-uuid', { expectedRevision: 'r_x' })).status).toBe(400)
		expect((await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, {})).status).toBe(400)
		expect((await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: '' })).status).toBe(400)
		expect((await retractReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: 'r_stale' })).status).toBe(409)
		expect(mapAuthoringResultToHttpStatus('deleted')).toBe(200)
	})
})

describe('retract over MCP and persistence faults', () => {
	it('lets an agent retract its own thread over MCP and refuses a human\'s', async () => {
		const ctx = await session()
		const mcp = await connectMcp(ctx.app)
		try {
			const created = await mcp.client.callTool({ name: 'create_review_thread', arguments: { id: REVIEW_ID, anchor: { scope: 'workspace' } } })
			const posted = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: (created.structuredContent as { revision: string }).revision, body: 'Oops' } })
			const retracted = await mcp.client.callTool({ name: 'retract_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: (posted.structuredContent as { revision: string }).revision } })
			expect(retracted.isError).toBeFalsy()
			expect(retracted.structuredContent).toEqual({ status: 'deleted', key: REVIEW_ID })
			expect(await exists(ctx)).toBe(false)

			const human = await thread(ctx, MEI)
			const refused = await mcp.client.callTool({ name: 'retract_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: human } })
			expect(refused.isError).toBe(true)
			expect(refused.structuredContent).toMatchObject({ code: 'review.retract_not_author' })
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'retract_review_thread')!
			expect(tool.annotations?.destructiveHint).toBe(true)
			expect(tool.description).toContain('Permanently delete your own brand-new Review thread')
		}
		finally {
			await mcp.close()
		}
	})

	it('leaves the old file or no file around a crash at file.before_remove / file.after_remove', async () => {
		let armed: PersistenceFaultPoint | undefined
		const ctx = await session((point) => {
			if (point === armed) throw new Error(`injected ${point}`)
		})
		const revision = await thread(ctx)
		armed = 'file.before_remove'
		await expect(ctx.app.retractReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, actor: principalActor(MEI) })).rejects.toThrow(/injected/)
		expect(await exists(ctx)).toBe(true)
		expect((await ctx.persistence.reviews.readInspected(REVIEW_ID))?.diagnostics).toEqual([])
		armed = 'file.after_remove'
		await expect(ctx.app.retractReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, actor: principalActor(MEI) })).rejects.toThrow(/injected/)
		expect(await exists(ctx)).toBe(false)
		armed = undefined
		expect(await ctx.app.readPointResource('review', REVIEW_ID)).toBeUndefined()
	})

	it('serializes a racing reply with the delete under one lock: exactly one of them wins', async () => {
		const ctx = await session()
		const revision = await thread(ctx)
		const [retract, reply] = await Promise.all([
			ctx.app.retractReviewThread({ reviewId: REVIEW_ID, expectedRevision: revision, actor: principalActor(MEI) }),
			ctx.app.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: revision, actor: principalActor(RUI), body: 'race' }),
		])
		const outcomes = [retract.status, reply.status].sort()
		expect([['conflict', 'deleted'], ['conflict', 'updated'], ['deleted', 'not_found']]).toContainEqual(outcomes)
		if (retract.status === 'deleted') expect(await exists(ctx)).toBe(false)
		else expect(await exists(ctx)).toBe(true)
	})
})
