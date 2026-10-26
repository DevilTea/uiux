import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { principalActor } from '../src/application/access/principal'
import type { ResourceDiscoveryItem } from '../src/application/dto/resource-discovery'
import { createHandoffExportService } from '../src/application/services/handoff-export'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import type { ReviewThread } from '../src/domain/reviews/schema'
import { canonicalJsonBytes, FileNativePersistence, reviewRelativePath } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	appendReviewMessageForHttp,
	createReviewThreadForHttp,
	editReviewMessageForHttp,
	promoteReviewToDecisionForHttp,
	reanchorReviewThreadForHttp,
	resolveReviewThreadForHttp,
	setReviewDisplayHintForHttp,
	submitReadyForReviewForHttp,
} from '../src/server/authoring-http'
import { listResourcesForHttp, searchResourcesForHttp, type ResourceDiscoveryHttpResult } from '../src/server/resource-discovery'
import { AGENT_EDITOR, connectMcp, scoped, testMember } from './support/access'
import { currentCaptureProvenance, putEvidenceRecord } from './support/evidence-record'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Accepted decision group "Workspace-scoped Review threads and editable Review messages" (Part 7,
 * discussioncomment-18772095): the domain service, both transports, discovery and Handoff (O1).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '11111111-1111-4111-8111-111111111112'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const WIDGET_REVIEW_ID = '22222222-2222-4222-8222-222222222223'
const EDIT_ID = '44444444-4444-4444-8444-444444444444'
const MEI = testMember({ nickname: 'mei', kind: 'human', preset: 'reviewer', credential: 'session' })
const RUI = testMember({ nickname: 'rui', kind: 'human', preset: 'owner', credential: 'session' })
const VIEWER = testMember({ nickname: 'vera', kind: 'human', preset: 'viewer', credential: 'session' })
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

async function session() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-review-v3-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	const other = await app.createView({ id: OTHER_VIEW_ID, name: 'Receipt', spec: spec('Show') })
	if (view.status !== 'created' || other.status !== 'created') throw new Error('View fixture failed.')
	return { root, persistence, app, viewRevision: view.revision, otherRevision: other.revision }
}

type Ctx = Awaited<ReturnType<typeof session>>

/**
 * A complete formal capture of `viewId` recorded at `viewRevision`, with `digest` as its
 * render-input digest (the View's current one by default; `null` records none), and `provenance`
 * as its Adapter and Product Kit provenance (the current ones by default).
 */
async function formal(ctx: Ctx, viewId: string, viewRevision: string, digest?: string | null, provenance?: Awaited<ReturnType<typeof currentCaptureProvenance>>): Promise<string> {
	const recorded = digest === undefined ? renderInputDigest((await ctx.persistence.views.readInspected(viewId))!.resource) : digest
	// The Adapter and Product Kit provenance as formal capture records it: without it the capture's
	// freshness is unknown, which marking ready refuses (Rule 01a11686-8d71-…).
	const current = provenance ?? await currentCaptureProvenance(ctx.persistence)
	return (await ctx.persistence.artifacts.put(new TextEncoder().encode(JSON.stringify({
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 3, resources: [{ identity: { type: 'view', id: viewId }, revision: viewRevision }], versions: { uiux: '0.1.0' }, ...current, ...(recorded === null ? {} : { renderInputDigest: recorded }) },
		artifactRefs: [],
	})))).identity
}

async function read(ctx: Ctx, key = REVIEW_ID) {
	const result = await ctx.app.readPointResource('review', key)
	if (result?.kind !== 'review') throw new Error(`Review ${key} is missing.`)
	return result as { resource: ReviewThread; revision: string; diagnostics: readonly { code: string }[] }
}

function body(result: { body: unknown }) {
	return result.body as { status: string; code?: string; revision?: string; diagnostics?: { code: string; path?: string }[]; warnings?: { code: string }[] }
}

/** The page of a successful discovery call; a 400 fails the test. */
function discoveryPage(result: ResourceDiscoveryHttpResult) {
	if (result.status !== 200) throw new Error(`Expected a discovery page, got ${JSON.stringify(result.body)}`)
	return result.body
}

function reviewSummary(item: ResourceDiscoveryItem | undefined) {
	if (item?.kind !== 'review') throw new Error(`Expected a Review item, got ${JSON.stringify(item)}`)
	return item.summary
}

function codes(result: { body: unknown } | { diagnostics?: readonly { code: string }[] }): string[] {
	const value = 'body' in result ? body(result) : result
	return (value.diagnostics ?? []).map(item => item.code)
}

/** A Workspace thread with one message by `author`, created through the HTTP surface. */
async function workspaceThread(ctx: Ctx, author = MEI, text = 'Use one date format everywhere.') {
	const created = await createReviewThreadForHttp(scoped(ctx.app, author), { id: REVIEW_ID, anchor: { scope: 'workspace' } })
	expect(created.status).toBe(201)
	const posted = await appendReviewMessageForHttp(scoped(ctx.app, author), REVIEW_ID, { expectedRevision: body(created).revision!, body: text })
	expect(posted.status).toBe(200)
	const thread = await read(ctx)
	return { revision: thread.revision, messageId: thread.resource.messages[0]!.id }
}

async function workspaceRevision(ctx: Ctx) {
	return (await ctx.persistence.workspace.readInspected()).revision!
}

async function screenshot(ctx: Ctx, seed: string) {
	return putEvidenceRecord(ctx.persistence, 'screenshot', seed)
}

describe('Workspace-scoped threads: create, re-anchor, hint, promote', { timeout: 30_000 }, () => {
	it('creates a Workspace thread on both transports and refuses Variant scope and a display hint', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { scope: 'workspace' } })
		expect(created.status).toBe(201)
		const thread = await read(ctx)
		expect(thread.resource).toMatchObject({ anchor: { scope: 'workspace' }, variantNames: [], status: 'open' })
		expect(thread.resource).not.toHaveProperty('displayHint')
		expect(thread.diagnostics).toEqual([])

		const scopedVariants = await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { scope: 'workspace' }, variantNames: ['empty'] })
		expect(scopedVariants.status).toBe(400)
		expect(codes(scopedVariants)).toEqual(['review.workspace_anchor_variants'])
		const hinted = await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { scope: 'workspace' }, displayHint: { pin: { x: 0.5, y: 0.5 } } })
		expect(codes(hinted)).toEqual(['review.display_hint_without_widget'])
		// The transport schemas stay strict per arm: mixing members or another scope is a malformed payload.
		expect(body(await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { scope: 'workspace', viewId: VIEW_ID } }))).toMatchObject({ code: 'malformed_payload' })
		expect(body(await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { scope: 'flow' } }))).toMatchObject({ code: 'malformed_payload' })
		expect(body(await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: {} }))).toMatchObject({ code: 'malformed_payload' })

		const mcp = await connectMcp(ctx.app)
		try {
			const viaMcp = await mcp.client.callTool({ name: 'create_review_thread', arguments: { anchor: { scope: 'workspace' } } })
			expect(viaMcp.isError).toBeFalsy()
			expect(viaMcp.structuredContent).toMatchObject({ status: 'created' })
			const tools = await mcp.client.listTools()
			const create = tools.tools.find(tool => tool.name === 'create_review_thread')!
			expect(create.description).toContain('{ scope: "workspace" }')
			expect(create.description).toContain('widgetId: "root"')
			expect(tools.tools.find(tool => tool.name === 'reanchor_review_thread')!.description).toContain('Workspace')
		}
		finally {
			await mcp.close()
		}
	})

	it('re-anchors between the arms in both directions with the hint rules and full history', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: WIDGET_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: ['empty'], displayHint: { pin: { x: 0.2, y: 0.3 } } })
		const widgetRev = body(created).revision!
		const withHint = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: widgetRev, anchor: { scope: 'workspace' }, displayHint: { pin: { x: 0.5, y: 0.5 } } })
		expect(codes(withHint)).toEqual(['review.display_hint_without_widget'])
		const withVariants = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: widgetRev, anchor: { scope: 'workspace' }, variantNames: ['empty'] })
		expect(codes(withVariants)).toContain('review.workspace_anchor_variants')

		const toWorkspace = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: widgetRev, anchor: { scope: 'workspace' }, reason: 'This is about the product as a whole.' })
		expect(toWorkspace.status).toBe(200)
		let thread = await read(ctx, WIDGET_REVIEW_ID)
		expect(thread.diagnostics).toEqual([])
		expect(thread.resource.anchor).toEqual({ scope: 'workspace' })
		expect(thread.resource).not.toHaveProperty('displayHint')
		expect(thread.resource.history.at(-1)).toMatchObject({
			kind: 'reanchor',
			before: { anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: ['empty'] },
			after: { anchor: { scope: 'workspace' }, variantNames: [] },
		})

		const same = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: body(toWorkspace).revision!, anchor: { scope: 'workspace' } })
		expect(same.status).toBe(200)
		const back = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: body(same).revision!, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		expect(back.status).toBe(200)
		thread = await read(ctx, WIDGET_REVIEW_ID)
		expect(thread.resource.anchor).toEqual({ viewId: VIEW_ID, widgetId: 'root' })
		expect(thread.resource).not.toHaveProperty('displayHint')
		expect(thread.resource.history).toHaveLength(3)
		expect(thread.diagnostics).toEqual([])
		// Re-anchor by clicking: an explicit object sets a hint on the new Widget.
		const toWorkspaceAgain = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: body(back).revision!, anchor: { scope: 'workspace' } })
		const clicked = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: body(toWorkspaceAgain).revision!, anchor: { viewId: VIEW_ID, widgetId: 'submit' }, displayHint: { pin: { x: 0.9, y: 0.1 } } })
		expect(clicked.status).toBe(200)
		expect((await read(ctx, WIDGET_REVIEW_ID)).resource.displayHint).toEqual({ pin: { x: 0.9, y: 0.1 } })
	})

	it('refuses a display hint and promotion on a Workspace thread (O3)', async () => {
		const ctx = await session()
		const { revision } = await workspaceThread(ctx)
		for (const displayHint of [{ pin: { x: 0.5, y: 0.5 } }, null]) {
			const refused = await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revision, displayHint })
			expect(refused.status).toBe(400)
			expect(codes(refused)).toEqual(['review.display_hint_without_widget'])
		}
		const promoted = await promoteReviewToDecisionForHttp(scoped(ctx.app, RUI), REVIEW_ID, { expectedReviewRevision: revision, viewId: VIEW_ID, expectedViewRevision: ctx.viewRevision, question: 'Which date format?' })
		expect(promoted.status).toBe(400)
		expect(codes(promoted)).toEqual(['review.decision_target_unavailable'])
		expect(body(promoted).diagnostics?.[0]).toMatchObject({ path: '/reviewId' })
		const view = await ctx.app.readPointResource('view', VIEW_ID)
		expect(view?.revision).toBe(ctx.viewRevision)
		expect((await read(ctx)).revision).toBe(revision)
	})
})

describe('Workspace-scoped submissions (decision 4)', { timeout: 30_000 }, () => {
	it('requires the current manifest revision and makes every named View valid and current', async () => {
		const ctx = await session()
		const { revision } = await workspaceThread(ctx)
		const agent = scoped(ctx.app, AGENT_EDITOR)
		const evidence = await screenshot(ctx, 'ws')
		const manifest = await workspaceRevision(ctx)
		const submit = (resources: unknown[], evidenceRefs: unknown[] = [{ kind: 'screenshot', evidence }]) =>
			submitReadyForReviewForHttp(agent, REVIEW_ID, { expectedRevision: revision, changeDomains: ['i18n'], resources, evidenceRefs })

		expect(codes(await submit([{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }]))).toEqual(['review.target_workspace_revision_missing'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: 'r_stale' }]))).toEqual(['review.target_workspace_revision_missing'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { type: 'view', id: VIEW_ID }, revision: 'r_stale' }]))).toEqual(['review.resource_revision_not_current'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { kind: 'view', key: '99999999-9999-4999-8999-999999999999' }, revision: 'r_1' }]))).toEqual(['review.target_view_missing'])

		// formal_capture must be complete for the current render-input digest of a View named in resources.
		const capturedOther = await formal(ctx, OTHER_VIEW_ID, ctx.otherRevision)
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }], [{ kind: 'formal_capture', evidence: capturedOther }])))
			.toEqual(['review.formal_evidence_not_current'])
		const stale = await formal(ctx, VIEW_ID, 'r_old', `sha256:${'0'.repeat(64)}`)
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }], [{ kind: 'formal_capture', evidence: stale }])))
			.toEqual(['review.formal_evidence_not_current'])
		expect((await read(ctx)).revision).toBe(revision)

		const accepted = await submit([
			{ identity: { kind: 'workspace', key: 'workspace' }, revision: manifest },
			{ identity: { type: 'view', id: OTHER_VIEW_ID }, revision: ctx.otherRevision },
		], [{ kind: 'formal_capture', evidence: capturedOther }])
		expect(accepted.status).toBe(200)
		const thread = await read(ctx)
		expect(thread.resource.status).toBe('ready-for-review')
		expect(thread.diagnostics).toEqual([])
	})
})

describe('editing a message (decisions 10–16)', { timeout: 30_000 }, () => {
	it('lets the author edit over HTTP, keeps every version append-only, stamps actor and time, and counts as activity', async () => {
		const ctx = await session()
		const { revision, messageId } = await workspaceThread(ctx, MEI, 'Use one date format.')
		const before = discoveryPage(await listResourcesForHttp(ctx.app, { kinds: ['review'], limit: 10 }))
		const edited = await editReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, messageId, {
			expectedRevision: revision,
			body: 'Use one date format everywhere.',
			editId: EDIT_ID,
			actor: { type: 'agent', id: 'agent:spoof' },
			at: '2000-01-01T00:00:00.000Z',
		})
		expect(edited.status).toBe(200)
		expect(body(edited).warnings?.map(item => item.code).sort()).toEqual(['auth.actor_ignored', 'auth.time_ignored'])
		const second = await editReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, messageId, { expectedRevision: body(edited).revision!, body: 'Use ISO dates everywhere.' })
		expect(second.status).toBe(200)

		const thread = await read(ctx)
		expect(thread.diagnostics).toEqual([])
		const message = thread.resource.messages[0]!
		expect(message.body).toBe('Use ISO dates everywhere.')
		expect(message.edits).toHaveLength(2)
		expect(message.edits![0]).toMatchObject({ id: EDIT_ID, actor: principalActor(MEI), previousBody: 'Use one date format.' })
		expect(message.edits![1]).toMatchObject({ previousBody: 'Use one date format everywhere.' })
		expect(message.edits![0]!.at).not.toBe('2000-01-01T00:00:00.000Z')
		expect(thread.resource.history).toEqual([])

		const after = discoveryPage(await listResourcesForHttp(ctx.app, { kinds: ['review'], limit: 10 }))
		expect(reviewSummary(after.items[0]).latestActivityAt).toBe(message.edits![1]!.at)
		expect(Date.parse(reviewSummary(after.items[0]).latestActivityAt!)).toBeGreaterThanOrEqual(Date.parse(reviewSummary(before.items[0]).latestActivityAt!))
		// Search covers the current text only (R14); the title is the first message's current body.
		expect(((await searchResourcesForHttp(ctx.app, { kinds: ['review'], query: 'workspace', limit: 10 })).body as { items: unknown[] }).items).toHaveLength(1)
	})

	it('refuses non-authors, legacy messages, frozen messages, empty and no-op edits with the decided codes', async () => {
		const ctx = await session()
		const { revision, messageId } = await workspaceThread(ctx, MEI)
		const edit = (principal: typeof MEI, value: string, expectedRevision = revision, id = messageId) =>
			editReviewMessageForHttp(scoped(ctx.app, principal), REVIEW_ID, id, { expectedRevision, body: value })

		const byOwner = await edit(RUI, 'Owner override')
		expect(byOwner.status).toBe(422)
		expect(body(byOwner)).toMatchObject({ status: 'blocked', code: 'review.message_edit_not_author' })
		expect((await edit(VIEWER, 'x')).status).toBe(403)
		expect(codes(await edit(MEI, '   '))).toEqual(['review.message_body_empty'])
		expect(codes(await edit(MEI, 'Use one date format everywhere.'))).toEqual(['review.message_edit_noop'])
		expect(codes(await edit(MEI, 'x', revision, '99999999-9999-4999-8999-999999999999'))).toEqual(['review.unknown_message'])
		expect(body(await edit(MEI, 'x', revision, '99999999-9999-4999-8999-999999999999')).diagnostics?.[0]?.path).toBe('/messageId')
		expect(codes(await edit(MEI, 'x', revision, 'nope'))).toEqual(['identity.invalid_uuid'])
		expect((await edit(MEI, 'x', 'r_stale')).status).toBe(409)
		expect((await editReviewMessageForHttp(scoped(ctx.app, MEI), '99999999-9999-4999-8999-999999999999', messageId, { expectedRevision: revision, body: 'x' })).status).toBe(404)

		// O2: a later submission freezes every earlier message, permanently.
		const manifest = await workspaceRevision(ctx)
		const submitted = await submitReadyForReviewForHttp(scoped(ctx.app, AGENT_EDITOR), REVIEW_ID, {
			expectedRevision: revision,
			changeDomains: ['i18n'],
			resources: [{ identity: { type: 'workspace' }, revision: manifest }],
			evidenceRefs: [{ kind: 'screenshot', evidence: await screenshot(ctx, 'freeze') }],
		})
		expect(submitted.status).toBe(200)
		const frozen = await edit(MEI, 'Changed after the submission', body(submitted).revision!)
		expect(frozen.status).toBe(422)
		expect(body(frozen)).toMatchObject({ status: 'blocked', code: 'review.message_frozen', diagnostics: [{ code: 'review.message_frozen', path: '/messageId', message: expect.stringContaining('ready-for-review submission (') }] })
		const reopened = await ctx.app.reopenReviewThread({ reviewId: REVIEW_ID, expectedRevision: body(submitted).revision!, actor: principalActor(RUI) })
		expect(reopened.status).toBe('updated')
		const stillFrozen = await edit(MEI, 'Changed after reopening', (reopened as { revision: string }).revision)
		expect(body(stillFrozen).code).toBe('review.message_frozen')
		// A message posted after the formal act stays editable.
		const reply = await appendReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: (reopened as { revision: string }).revision, body: 'Follow-up' })
		const replyId = (await read(ctx)).resource.messages[1]!.id
		expect((await edit(MEI, 'Follow-up, edited', body(reply).revision!, replyId)).status).toBe(200)
	})

	it('treats legacy messages without a member id as not editable by anyone (R19)', async () => {
		const ctx = await session()
		const created = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const legacy = await ctx.app.appendReviewMessage({ reviewId: REVIEW_ID, expectedRevision: (created as { revision: string }).revision, actor: { type: 'human', displayName: 'mei' }, body: 'Old words' })
		const messageId = (await read(ctx)).resource.messages[0]!.id
		const refused = await editReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, messageId, { expectedRevision: (legacy as { revision: string }).revision, body: 'New words' })
		expect(body(refused)).toMatchObject({ status: 'blocked', code: 'review.message_edit_not_author' })
		expect(await ctx.app.editReviewMessage({ reviewId: REVIEW_ID, expectedRevision: (legacy as { revision: string }).revision, messageId, body: 'x', actor: { type: 'human', id: 'agent:claude' } }))
			.toMatchObject({ status: 'blocked', code: 'review.message_edit_not_author' })
	})

	it('lets an agent edit its own message over MCP and refuses another member\'s', async () => {
		const ctx = await session()
		const mcp = await connectMcp(ctx.app)
		try {
			const created = await mcp.client.callTool({ name: 'create_review_thread', arguments: { id: REVIEW_ID, anchor: { scope: 'workspace' } } })
			const createdRev = (created.structuredContent as { revision: string }).revision
			const posted = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: createdRev, body: 'Fix widget #submit.' } })
			const messageId = (await read(ctx)).resource.messages[0]!.id
			const edited = await mcp.client.callTool({ name: 'edit_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: (posted.structuredContent as { revision: string }).revision, messageId, body: 'Fix widget #pay.' } })
			expect(edited.isError).toBeFalsy()
			expect(edited.structuredContent).toMatchObject({ status: 'updated', resourceUri: `uiux://review/${REVIEW_ID}` })
			expect((await read(ctx)).resource.messages[0]!.edits?.[0]).toMatchObject({ actor: principalActor(AGENT_EDITOR), previousBody: 'Fix widget #submit.' })

			const humanReply = await appendReviewMessageForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: (edited.structuredContent as { revision: string }).revision, body: 'Thanks' })
			const humanMessageId = (await read(ctx)).resource.messages[1]!.id
			const refused = await mcp.client.callTool({ name: 'edit_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: body(humanReply).revision!, messageId: humanMessageId, body: 'No thanks' } })
			expect(refused.isError).toBe(true)
			expect(refused.structuredContent).toMatchObject({ status: 'blocked', code: 'review.message_edit_not_author' })
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'edit_review_message')!
			expect(tool.description).toContain('Replace the text of your own Review message')
		}
		finally {
			await mcp.close()
		}
	})

	it('refuses an edit of a message frozen by a resolution with review.message_frozen on HTTP and MCP, naming the resolution', async () => {
		const ctx = await session()
		const mcp = await connectMcp(ctx.app)
		try {
			const created = await mcp.client.callTool({ name: 'create_review_thread', arguments: { id: REVIEW_ID, anchor: { scope: 'workspace' } } })
			const posted = await mcp.client.callTool({ name: 'append_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: (created.structuredContent as { revision: string }).revision, body: 'Fix widget #submit.' } })
			const messageId = (await read(ctx)).resource.messages[0]!.id
			const resolved = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: (posted.structuredContent as { revision: string }).revision, resolution: 'answered' })
			expect(resolved.status).toBe(200)
			const revision = body(resolved).revision!

			const viaHttp = await editReviewMessageForHttp(scoped(ctx.app, AGENT_EDITOR), REVIEW_ID, messageId, { expectedRevision: revision, body: 'Fix widget #pay.' })
			expect(viaHttp.status).toBe(422)
			expect(body(viaHttp)).toMatchObject({ status: 'blocked', code: 'review.message_frozen', diagnostics: [{ code: 'review.message_frozen', path: '/messageId', message: expect.stringContaining('resolution (') }] })

			const viaMcp = await mcp.client.callTool({ name: 'edit_review_message', arguments: { reviewId: REVIEW_ID, expectedRevision: revision, messageId, body: 'Fix widget #pay.' } })
			expect(viaMcp.isError).toBe(true)
			expect(viaMcp.structuredContent).toMatchObject({ status: 'blocked', code: 'review.message_frozen', diagnostics: [{ code: 'review.message_frozen', message: expect.stringContaining('resolution (') }] })
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'edit_review_message')!
			expect(tool.description).toContain('review.message_frozen')
			// Authorship is checked first: someone else's frozen message stays a not-author refusal.
			const notAuthor = await editReviewMessageForHttp(scoped(ctx.app, RUI), REVIEW_ID, messageId, { expectedRevision: revision, body: 'x' })
			expect(body(notAuthor)).toMatchObject({ code: 'review.message_edit_not_author' })
		}
		finally {
			await mcp.close()
		}
	})

	it('keeps resolve Workbench-only for Workspace threads: MCP refuses it for agents and humans alike', async () => {
		const ctx = await session()
		const { revision } = await workspaceThread(ctx)
		const agentMcp = await connectMcp(ctx.app)
		const humanMcp = await connectMcp(ctx.app, testMember({ nickname: 'hana', kind: 'human', preset: 'owner', credential: 'token' }))
		try {
			const byAgent = await agentMcp.client.callTool({ name: 'resolve_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: revision, resolution: 'answered' } })
			expect(byAgent.structuredContent).toMatchObject({ code: 'review.direct_resolve_requires_workbench' })
			const byHuman = await humanMcp.client.callTool({ name: 'resolve_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: revision, resolution: 'answered' } })
			expect(byHuman.structuredContent).toMatchObject({ code: 'review.resolve_requires_workbench' })
		}
		finally {
			await agentMcp.close()
			await humanMcp.close()
		}
		const viaWorkbench = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revision, resolution: 'answered' })
		expect(viaWorkbench.status).toBe(200)
	})
})

describe('discovery: anchorScope and the workspace search term (R6)', { timeout: 30_000 }, () => {
	it('filters Review threads by anchor arm on both transports, scopes cursors, and validates the filter', async () => {
		const ctx = await session()
		await workspaceThread(ctx)
		await ctx.app.createReviewThread({ id: WIDGET_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const keys = async (input: Record<string, unknown>) => discoveryPage(await listResourcesForHttp(ctx.app, { limit: 10, ...input })).items.map(item => item.key)
		expect(await keys({ kinds: ['review'], anchorScope: ['workspace'] })).toEqual([REVIEW_ID])
		expect(await keys({ kinds: ['review'], anchorScope: ['view'] })).toEqual([WIDGET_REVIEW_ID])
		expect(await keys({ kinds: ['review'], anchorScope: ['view', 'workspace'] })).toEqual([REVIEW_ID, WIDGET_REVIEW_ID])
		// Other kinds do not match a Review-only filter, as with `resolution`.
		expect(await keys({ anchorScope: ['workspace'] })).toEqual([REVIEW_ID])
		for (const invalid of [[], ['flow'], ['view', 'view']]) {
			const result = await listResourcesForHttp(ctx.app, { kinds: ['review'], limit: 10, anchorScope: invalid })
			expect(result.status).toBe(400)
		}
		const page = discoveryPage(await listResourcesForHttp(ctx.app, { kinds: ['review'], limit: 1, anchorScope: ['view', 'workspace'] }))
		expect(page.nextCursor).toBeDefined()
		expect((await listResourcesForHttp(ctx.app, { kinds: ['review'], limit: 1, anchorScope: ['workspace'], cursor: page.nextCursor })).status).toBe(400)
		const found = discoveryPage(await searchResourcesForHttp(ctx.app, { kinds: ['review'], query: 'WORKSPACE', limit: 10 }))
		expect(found.items.map(item => item.key)).toEqual([REVIEW_ID])
		expect(reviewSummary(found.items[0]).anchor).toEqual({ scope: 'workspace' })

		const mcp = await connectMcp(ctx.app)
		try {
			const listed = await mcp.client.callTool({ name: 'list_resources', arguments: { kinds: ['review'], anchorScope: ['workspace'], limit: 10 } })
			expect((listed.structuredContent as { items: { key: string }[] }).items.map(item => item.key)).toEqual([REVIEW_ID])
		}
		finally {
			await mcp.close()
		}
	})
})

describe('Handoff closure (owner decision O1)', { timeout: 30_000 }, () => {
	it('puts every Workspace thread in every export closure: an open one blocks all roots, and none is silently skipped', async () => {
		const ctx = await session()
		const handoff = createHandoffExportService(ctx.persistence)
		const before = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_ID }] })
		expect(before.status).toBe('ok')
		const workspaceBlocked = (status: string) => `Workspace-scoped Review thread ${REVIEW_ID} is ${status}.`

		const { revision } = await workspaceThread(ctx)
		for (const roots of [[{ type: 'view' as const, viewId: VIEW_ID }], [{ type: 'view' as const, viewId: OTHER_VIEW_ID }], [{ type: 'workspace' as const }]]) {
			const assessed = await handoff.assessReadiness({ roots })
			expect(assessed.status).toBe('ok')
			if (assessed.status !== 'ok') continue
			expect(assessed.readiness!.implementationReady).toBe(false)
			expect(assessed.readiness!.coverage.review).toMatchObject({ complete: false, threads: 1, workspaceThreads: 1 })
			expect(assessed.readiness!.blockingDiagnostics).toContainEqual({ code: 'handoff.unresolved_review_thread', message: workspaceBlocked('open'), blocking: true, path: `/reviews/${REVIEW_ID}` })
		}

		const exported = await handoff.exportHandoff({ roots: [{ type: 'view', viewId: OTHER_VIEW_ID }] })
		expect(exported.status).toBe('exported')
		if (exported.status === 'exported') {
			const snapshot = exported.manifest!.resources.find(resource => resource.type === 'review')
			expect(snapshot?.snapshot).toMatchObject({ anchor: { scope: 'workspace' } })
			expect(exported.manifest!.provenance.workspaceSchemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
			expect(exported.manifest!.readiness.coverage.review).toMatchObject({ workspaceThreads: 1 })
		}

		const resolved = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revision, resolution: 'wont-fix' })
		expect(resolved.status).toBe(200)
		const after = await handoff.assessReadiness({ roots: [{ type: 'view', viewId: VIEW_ID }] })
		expect(after.status).toBe('ok')
		if (after.status === 'ok') {
			expect(after.assessment!.reviewCoverageComplete).toBe(true)
			expect(after.readiness!.blockingDiagnostics.some(item => item.code === 'handoff.unresolved_review_thread')).toBe(false)
			expect(after.readiness!.coverage.review).toMatchObject({ complete: true, threads: 1, workspaceThreads: 1, resolved: { 'wont-fix': 1 } })
			expect(after.readiness!.blockingDiagnostics).toContainEqual(expect.objectContaining({ code: 'handoff.review_declined', blocking: false, message: expect.stringContaining('Workspace-scoped Review thread') }))
		}
	})
})

describe('mark ready follows the render-input digest and the known change domains (Discussion #241 R2)', { timeout: 30_000 }, () => {
	/** An open Widget thread on the View's RootShell, with one message. */
	async function widgetThread(ctx: Ctx) {
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: WIDGET_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		expect(created.status).toBe(201)
		const posted = await appendReviewMessageForHttp(scoped(ctx.app, MEI), WIDGET_REVIEW_ID, { expectedRevision: body(created).revision!, body: 'Spacing is off.' })
		expect(posted.status).toBe(200)
		return (await read(ctx, WIDGET_REVIEW_ID)).revision
	}

	async function viewRevision(ctx: Ctx): Promise<string> {
		return (await ctx.persistence.views.readRevision(VIEW_ID))!
	}

	function markReady(ctx: Ctx, revision: string, current: string, evidence: string, changeDomains: unknown[] = ['ir']) {
		return submitReadyForReviewForHttp(scoped(ctx.app, AGENT_EDITOR), WIDGET_REVIEW_ID, {
			expectedRevision: revision,
			changeDomains: changeDomains as string[],
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: current }],
			evidenceRefs: [{ kind: 'formal_capture', evidence }],
		})
	}

	// Rule 01a11544-558b-… and Clause 01a115cd-3769-…: a Spec-only edit keeps the digest.
	it('accepts a capture taken before a Spec-only edit of its View', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const captured = await formal(ctx, VIEW_ID, ctx.viewRevision)
		const edited = await ctx.app.updateViewSpec({ key: VIEW_ID, expectedRevision: ctx.viewRevision, spec: spec('Pay faster') })
		expect(edited.status).toBe('updated')
		const current = await viewRevision(ctx)
		expect(current).not.toBe(ctx.viewRevision)
		const ready = await markReady(ctx, revision, current, captured, ['spec'])
		expect(ready.status, JSON.stringify(ready.body)).toBe(200)
		expect((await read(ctx, WIDGET_REVIEW_ID)).resource.submissions.at(-1)?.changeDomains).toEqual(['spec'])
	})

	// Scenario 01a118a1-cb0e-…: a capture taken before an IR change is refused.
	it('refuses a capture taken before an IR change with review.formal_evidence_not_current and keeps the thread open', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const captured = await formal(ctx, VIEW_ID, ctx.viewRevision)
		const changed = await ctx.app.updateViewStructure({ key: VIEW_ID, expectedRevision: ctx.viewRevision, ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay' }] } } as never, variants: {} })
		expect(changed.status, JSON.stringify(changed)).toBe('updated')
		const refused = await markReady(ctx, revision, await viewRevision(ctx), captured)
		expect(refused.status).toBe(400)
		expect(codes(refused)).toEqual(['review.formal_evidence_not_current'])
		const thread = await read(ctx, WIDGET_REVIEW_ID)
		expect(thread.revision).toBe(revision)
		expect(thread.resource.status).toBe('open')
		expect(thread.resource.submissions).toEqual([])
	})

	// Rule 01a115cd-c53c-…: a capture that records no render-input digest never counts.
	it('refuses a capture that records no render-input digest', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const legacy = await formal(ctx, VIEW_ID, ctx.viewRevision, null)
		expect(codes(await markReady(ctx, revision, ctx.viewRevision, legacy))).toEqual(['review.formal_evidence_not_current'])
	})

	// Rule 01a11686-8d71-…: a capture of unknown freshness, here one that records no Adapter or no
	// Product Kit provenance (Rule 01a1161b-ff68-…), is refused until it is recaptured.
	it('refuses a capture whose freshness is unknown and keeps the thread open', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const current = await currentCaptureProvenance(ctx.persistence)
		for (const recorded of [{ productKit: current.productKit }, { adapters: current.adapters }]) {
			const legacy = await formal(ctx, VIEW_ID, ctx.viewRevision, undefined, recorded)
			const refused = await markReady(ctx, revision, ctx.viewRevision, legacy)
			expect(refused.status).toBe(400)
			expect(body(refused).diagnostics?.map(item => [item.code, item.path])).toEqual([['review.formal_evidence_freshness_unknown', '/evidenceRefs/0/evidence']])
		}
		const thread = await read(ctx, WIDGET_REVIEW_ID)
		expect(thread.revision).toBe(revision)
		expect(thread.resource.status).toBe('open')
	})

	// Rules 01a11686-8d71-… and 01a1161b-ff68-…: while the current Adapter set does not resolve, no
	// capture's freshness can be judged, so even one that records Adapter provenance is refused.
	it('refuses a capture while the current Adapter set cannot be resolved', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const captured = await formal(ctx, VIEW_ID, ctx.viewRevision)
		const kit = (await ctx.persistence.productKit.read())!
		const swapped = await ctx.persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: kit.revision, resource: { ...kit.resource, adapters: [{ moduleSpecifier: './adapters/missing.mjs' }] } })
		expect(swapped.ok).toBe(true)
		const refused = await markReady(ctx, revision, ctx.viewRevision, captured)
		expect(refused.status).toBe(400)
		expect(body(refused).diagnostics?.map(item => [item.code, item.path])).toEqual([['review.formal_evidence_freshness_unknown', '/evidenceRefs/0/evidence']])
	})

	// Rule 01a11544-558b-… (Discussion #241 ruling 4): a capture made stale because an Adapter or the
	// Product Kit changed since capture is refused even while its render-input digest still matches.
	it('refuses a capture whose Adapters or Product Kit changed since capture, and accepts a fresh one', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const current = await currentCaptureProvenance(ctx.persistence)
		expect(current.adapters).toEqual([])
		expect(current.productKit).toBeDefined()
		const otherAdapter = { moduleSpecifier: './adapters/removed.mjs', adapterId: 'removed', apiVersion: '1', contentDigest: `sha256:${'a'.repeat(64)}` }
		const staleKit = { ...current.productKit!, dataDigest: `sha256:${'b'.repeat(64)}` }
		for (const stale of [{ ...current, adapters: [otherAdapter] }, { ...current, productKit: staleKit }]) {
			const captured = await formal(ctx, VIEW_ID, ctx.viewRevision, undefined, stale)
			const refused = await markReady(ctx, revision, ctx.viewRevision, captured)
			expect(refused.status).toBe(400)
			expect(body(refused).diagnostics?.map(item => [item.code, item.path])).toEqual([['review.formal_evidence_not_current', '/evidenceRefs/0/evidence']])
		}
		expect((await read(ctx, WIDGET_REVIEW_ID)).resource.submissions).toEqual([])
		const fresh = await formal(ctx, VIEW_ID, ctx.viewRevision)
		const ready = await markReady(ctx, revision, ctx.viewRevision, fresh)
		expect(ready.status, JSON.stringify(ready.body)).toBe(200)
	})

	// Clause 01a14e57-637f-…: an unknown value is refused when written, naming each one.
	it('refuses an unknown change domain with review.change_domain_unknown and writes nothing', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const captured = await formal(ctx, VIEW_ID, ctx.viewRevision)
		const refused = await markReady(ctx, revision, ctx.viewRevision, captured, ['ir', 'view-structure', 'IR'])
		expect(refused.status).toBe(400)
		expect(body(refused).diagnostics?.map(item => [item.code, item.path])).toEqual([
			['review.change_domain_unknown', '/changeDomains/1'],
			['review.change_domain_unknown', '/changeDomains/2'],
		])
		expect((await read(ctx, WIDGET_REVIEW_ID)).revision).toBe(revision)

		const mcp = await connectMcp(ctx.app, AGENT_EDITOR)
		try {
			const viaMcp = await mcp.client.callTool({ name: 'submit_ready_for_review', arguments: { reviewId: WIDGET_REVIEW_ID, expectedRevision: revision, changeDomains: ['views'], resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }], evidenceRefs: [{ kind: 'formal_capture', evidence: captured }] } })
			expect(JSON.stringify(viaMcp.structuredContent ?? viaMcp.content)).toContain('review.change_domain_unknown')
		}
		finally { await mcp.close() }

		// Every known value is accepted.
		const accepted = await markReady(ctx, revision, ctx.viewRevision, captured, ['ir', 'variant', 'spec', 'metadata', 'flow', 'asset', 'i18n', 'settings', 'adapter', 'product-kit', 'interaction'])
		expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
	})

	// Clause 01a14e30-2dce-…: a stored unknown value does not make the submission invalid.
	it('reads a stored submission whose change domain is unknown without a diagnostic', async () => {
		const ctx = await session()
		const revision = await widgetThread(ctx)
		const captured = await formal(ctx, VIEW_ID, ctx.viewRevision)
		expect((await markReady(ctx, revision, ctx.viewRevision, captured)).status).toBe(200)
		// The dogfood Workspace holds values such as `views` from before the known set.
		const stored = await read(ctx, WIDGET_REVIEW_ID)
		const legacy = { ...stored.resource, submissions: stored.resource.submissions.map(item => ({ ...item, changeDomains: ['views'] })) }
		await writeFile(join(ctx.root, reviewRelativePath(WIDGET_REVIEW_ID)), canonicalJsonBytes(legacy))
		const reread = await read(ctx, WIDGET_REVIEW_ID)
		expect(reread.diagnostics).toEqual([])
		expect(reread.resource.submissions[0]!.changeDomains).toEqual(['views'])
	})
})
