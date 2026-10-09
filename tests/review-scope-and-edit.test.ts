import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { principalActor } from '../src/application/access/principal'
import type { ResourceDiscoveryItem } from '../src/application/dto/resource-discovery'
import { createHandoffExportService } from '../src/application/services/handoff-export'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ReviewThread } from '../src/domain/reviews/schema'
import { FileNativePersistence } from '../src/persistence'
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

/**
 * Accepted decision group "Workspace-scoped Review threads and editable Review messages" (Part 7,
 * discussioncomment-18772095): the domain service, both transports, discovery and Handoff (O1).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '11111111-1111-4111-8111-111111111112'
const REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const WIDGET_REVIEW_ID = '22222222-2222-4222-8222-222222222223'
const EDIT_ID = '44444444-4444-4444-8444-444444444444'
const MEI = testMember({ nickname: 'mei', kind: 'human', role: 'reviewer', credential: 'session' })
const RUI = testMember({ nickname: 'rui', kind: 'human', role: 'owner', credential: 'session' })
const VIEWER = testMember({ nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
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
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	const other = await app.createView({ id: OTHER_VIEW_ID, name: 'Receipt', spec: spec('Show') })
	if (view.status !== 'created' || other.status !== 'created') throw new Error('View fixture failed.')
	return { root, persistence, app, viewRevision: view.revision, otherRevision: other.revision }
}

type Ctx = Awaited<ReturnType<typeof session>>

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
	return (await ctx.persistence.artifacts.put(new TextEncoder().encode(`evidence-${seed}`))).identity
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
			submitReadyForReviewForHttp(agent, REVIEW_ID, { expectedRevision: revision, changeDomains: ['copy'], resources, evidenceRefs })

		expect(codes(await submit([{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }]))).toEqual(['review.target_workspace_revision_missing'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: 'r_stale' }]))).toEqual(['review.target_workspace_revision_missing'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { type: 'view', id: VIEW_ID }, revision: 'r_stale' }]))).toEqual(['review.resource_revision_not_current'])
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { kind: 'view', key: '99999999-9999-4999-8999-999999999999' }, revision: 'r_1' }]))).toEqual(['review.target_view_missing'])

		// formal_capture must be complete for the current revision of a View named in resources.
		const formal = (viewId: string, viewRevision: string) => ctx.persistence.artifacts.put(new TextEncoder().encode(JSON.stringify({
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId },
			coverage: { complete: true },
			provenance: { workspaceSchemaVersion: 3, resources: [{ identity: { type: 'view', id: viewId }, revision: viewRevision }], versions: { uiux: '0.1.0' } },
			artifactRefs: [],
		})))
		const capturedOther = (await formal(OTHER_VIEW_ID, ctx.otherRevision)).identity
		expect(codes(await submit([{ identity: { type: 'workspace' }, revision: manifest }, { identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }], [{ kind: 'formal_capture', evidence: capturedOther }])))
			.toEqual(['review.formal_evidence_not_current'])
		const stale = (await formal(VIEW_ID, 'r_old')).identity
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
			changeDomains: ['copy'],
			resources: [{ identity: { type: 'workspace' }, revision: manifest }],
			evidenceRefs: [{ kind: 'screenshot', evidence: await screenshot(ctx, 'freeze') }],
		})
		expect(submitted.status).toBe(200)
		const frozen = await edit(MEI, 'Changed after the submission', body(submitted).revision!)
		expect(frozen.status).toBe(422)
		expect(body(frozen)).toMatchObject({ status: 'blocked', code: 'review.message_edit_after_formal_act' })
		const reopened = await ctx.app.reopenReviewThread({ reviewId: REVIEW_ID, expectedRevision: body(submitted).revision!, actor: principalActor(RUI) })
		expect(reopened.status).toBe('updated')
		const stillFrozen = await edit(MEI, 'Changed after reopening', (reopened as { revision: string }).revision)
		expect(body(stillFrozen).code).toBe('review.message_edit_after_formal_act')
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

	it('keeps resolve Workbench-only for Workspace threads: MCP refuses it for agents and humans alike', async () => {
		const ctx = await session()
		const { revision } = await workspaceThread(ctx)
		const agentMcp = await connectMcp(ctx.app)
		const humanMcp = await connectMcp(ctx.app, testMember({ nickname: 'hana', kind: 'human', role: 'owner', credential: 'token' }))
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
