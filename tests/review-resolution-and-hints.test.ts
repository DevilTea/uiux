import { spawnSync } from 'node:child_process'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import type { ReviewThread } from '../src/domain/reviews/schema'
import { RESOLVE_REVIEW_THREAD_DESCRIPTION } from '../src/mcp/server'
import { FileNativePersistence } from '../src/persistence'
import { SERVER_HOLD_RELATIVE_PATH } from '../src/persistence/server-hold'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import {
	createReviewThreadForHttp,
	reanchorReviewThreadForHttp,
	reopenReviewThreadForHttp,
	resolveReviewThreadForHttp,
	setReviewDisplayHintForHttp,
	submitReadyForReviewForHttp,
} from '../src/server/authoring-http'
import { startWorkbenchServer } from './support/workbench-server'
import { AGENT_EDITOR, connectMcp, scoped, testMember } from './support/access'
import { principalActor, type MemberPrincipal } from '../src/application/access/principal'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const SECOND_REVIEW_ID = '77777777-7777-4777-8777-777777777777'
const THIRD_REVIEW_ID = '88888888-8888-4888-8888-888888888888'
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
/** The Workbench reviewer: a human member on a cookie session; actors are server-stamped from it. */
const MEI = testMember({ nickname: 'mei', kind: 'human', role: 'reviewer', credential: 'session' })
const AGENT_SESSION = testMember({ nickname: 'qa-bot', kind: 'agent', role: 'editor', credential: 'session' })
const human = principalActor(MEI)
const agent = principalActor(AGENT_EDITOR)
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

async function session() {
	const root = await mkdtemp(join(tmpdir(), 'uiux-review-v2-'))
	roots.push(root)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	const view = await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	if (view.status !== 'created') throw new Error('View fixture failed.')
	return { root, persistence, app, viewRevision: view.revision }
}

async function connectedClient(app: ReturnType<typeof createWorkspaceApplicationSession>, principal: MemberPrincipal = AGENT_EDITOR) {
	return connectMcp(app, principal)
}

async function readThread(app: ReturnType<typeof createWorkspaceApplicationSession>, key: string) {
	const read = await app.readPointResource('review', key)
	if (read?.kind !== 'review') throw new Error(`Review ${key} is missing.`)
	return read as { resource: ReviewThread; revision: string; diagnostics: readonly { code: string }[] }
}

function revisionOf(result: { body: unknown }): string {
	return (result.body as { revision: string }).revision
}

function codesOf(result: { body: unknown }): string[] {
	return ((result.body as { diagnostics?: { code: string }[] }).diagnostics ?? []).map(item => item.code)
}

async function submitReady(ctx: Awaited<ReturnType<typeof session>>, key: string, expectedRevision: string) {
	const evidence = await ctx.persistence.artifacts.put(new TextEncoder().encode(`evidence-${expectedRevision}`))
	const result = await submitReadyForReviewForHttp(scoped(ctx.app, AGENT_EDITOR), key, {
		expectedRevision,
		actor: agent,
		changeDomains: ['view-structure'],
		resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: ctx.viewRevision }],
		evidenceRefs: [{ kind: 'screenshot', evidence: evidence.identity }],
	})
	expect(result.status).toBe(200)
	return revisionOf(result)
}

describe('direct resolve through the Workbench HTTP surface', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('requires an explicit non-verified resolution on open threads and enforces the decided validation codes', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		expect(created.status).toBe(201)
		const rev = revisionOf(created)

		const omitted = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human })
		expect(omitted.status).toBe(400)
		expect(codesOf(omitted)).toEqual(['review.resolution_required'])
		const verifiedFromOpen = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, resolution: 'verified' })
		expect(verifiedFromOpen.status).toBe(400)
		expect(codesOf(verifiedFromOpen)).toEqual(['review.invalid_transition'])
		const withSubmission = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, resolution: 'answered', submissionId: SECOND_REVIEW_ID })
		expect(codesOf(withSubmission)).toEqual(['review.direct_resolve_submission_forbidden'])
		const duplicateWithoutReason = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, resolution: 'duplicate', reason: '  ' })
		expect(codesOf(duplicateWithoutReason)).toEqual(['review.resolution_reason_required'])
		const byAgent = await resolveReviewThreadForHttp(scoped(ctx.app, AGENT_SESSION), REVIEW_ID, { expectedRevision: rev, resolution: 'answered' })
		expect(codesOf(byAgent)).toEqual(['review.resolve_requires_human'])
		const unknownKind = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, resolution: 'promoted' })
		expect(unknownKind.status).toBe(400)
		expect(unknownKind.body).toMatchObject({ code: 'malformed_payload' })
		expect((await readThread(ctx.app, REVIEW_ID)).revision).toBe(rev)
		expect(await ctx.app.resolveReviewThread({ reviewId: REVIEW_ID, expectedRevision: rev, actor: human, resolution: 'promoted' as never }))
			.toMatchObject({ status: 'invalid', diagnostics: [{ code: 'review.invalid_resolution' }] })

		const answered = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, resolution: 'answered', reason: 'Secondary by design.' })
		expect(answered.status).toBe(200)
		const thread = await readThread(ctx.app, REVIEW_ID)
		expect(thread.diagnostics).toEqual([])
		expect(thread.resource.status).toBe('resolved')
		expect(thread.resource.submissions).toEqual([])
		expect(thread.resource.history).toHaveLength(1)
		expect(thread.resource.history[0]).toMatchObject({ kind: 'lifecycle', from: 'open', to: 'resolved', resolution: 'answered', reason: 'Secondary by design.', actor: human })
		expect(thread.resource.history[0]).not.toHaveProperty('submissionId')

		const again = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revisionOf(answered), actor: human, resolution: 'answered' })
		expect(codesOf(again)).toEqual(['review.invalid_transition'])

		// Reopen keeps the prior resolution event intact.
		const reopened = await reopenReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revisionOf(answered), actor: human, reason: 'Needs a change after all' })
		expect(reopened.status).toBe(200)
		const afterReopen = await readThread(ctx.app, REVIEW_ID)
		expect(afterReopen.resource.status).toBe('open')
		expect(afterReopen.resource.history.map(event => event.resolution)).toEqual(['answered', undefined])
	})

	it('declines a ready-for-review submission without accepting it, and keeps the backward-compatible verified default', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const ready = await submitReady(ctx, REVIEW_ID, revisionOf(created))

		const declined = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: ready, actor: human, resolution: 'wont-fix' })
		expect(declined.status).toBe(200)
		const declinedThread = await readThread(ctx.app, REVIEW_ID)
		expect(declinedThread.diagnostics).toEqual([])
		expect(declinedThread.resource.submissions).toHaveLength(1)
		expect(declinedThread.resource.history.at(-1)).toMatchObject({ from: 'ready-for-review', to: 'resolved', resolution: 'wont-fix' })
		expect(declinedThread.resource.history.at(-1)).not.toHaveProperty('submissionId')

		const reopened = await reopenReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revisionOf(declined), actor: human })
		const readyAgain = await submitReady(ctx, REVIEW_ID, revisionOf(reopened))
		const latestSubmission = (await readThread(ctx.app, REVIEW_ID)).resource.submissions.at(-1)!.id
		const forbidden = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: readyAgain, actor: human, resolution: 'obsolete', submissionId: latestSubmission })
		expect(codesOf(forbidden)).toEqual(['review.direct_resolve_submission_forbidden'])

		// Omitted resolution from ready-for-review is `verified`, accepting the latest submission.
		const verified = await resolveReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: readyAgain, actor: human, reason: 'Looks right' })
		expect(verified.status).toBe(200)
		const verifiedThread = await readThread(ctx.app, REVIEW_ID)
		expect(verifiedThread.diagnostics).toEqual([])
		expect(verifiedThread.resource.history.at(-1)).toMatchObject({ to: 'resolved', resolution: 'verified', submissionId: latestSubmission })
		expect(verifiedThread.resource.history.filter(event => event.to === 'resolved').map(event => event.resolution)).toEqual(['wont-fix', 'verified'])
	})
})

describe('resolve_review_thread on /mcp always refuses', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('keeps the tool registered with the decided description and refusal order, without touching the thread', async () => {
		const ctx = await session()
		const created = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		if (created.status !== 'created') throw new Error('fixture')
		const ready = await submitReady(ctx, REVIEW_ID, created.revision)
		const { client, close } = await connectedClient(ctx.app)
		try {
			const tool = (await client.listTools()).tools.find(item => item.name === 'resolve_review_thread')
			expect(tool?.description).toBe(RESOLVE_REVIEW_THREAD_DESCRIPTION)
			expect(RESOLVE_REVIEW_THREAD_DESCRIPTION).toBe('Resolution is human-only and happens in the UIUX Workbench. This tool always refuses. Reply on the thread, or submit it ready for review, and a human will resolve it.')
			expect((tool?.inputSchema.properties as Record<string, { enum?: string[] }>).resolution?.enum).toEqual(['verified', 'answered', 'wont-fix', 'duplicate', 'obsolete'])

			// The refusal order is keyed on the principal, not on the payload (identity decision 7):
			// a claimed `actor` changes nothing.
			const humanClient = await connectedClient(ctx.app, testMember({ nickname: 'lead', kind: 'human', role: 'owner', credential: 'token' }))
			const cases: Array<[typeof client, Record<string, unknown>, string]> = [
				[humanClient.client, {}, 'review.resolve_requires_workbench'],
				[humanClient.client, { resolution: 'answered' }, 'review.resolve_requires_workbench'],
				[humanClient.client, { actor: agent, resolution: 'answered' }, 'review.resolve_requires_workbench'],
				[client, { resolution: 'answered' }, 'review.direct_resolve_requires_workbench'],
				[client, { resolution: 'wont-fix' }, 'review.direct_resolve_requires_workbench'],
				[client, { resolution: 'verified' }, 'review.resolve_requires_human'],
				[client, {}, 'review.resolve_requires_human'],
				[client, { actor: { type: 'human', displayName: 'Spoofed' } }, 'review.resolve_requires_human'],
			]
			for (const [caller, args, code] of cases) {
				const result = await caller.callTool({ name: 'resolve_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: ready, ...args } })
				expect(result.isError).toBe(true)
				expect(result.structuredContent).toMatchObject({ status: 'blocked', key: REVIEW_ID, code, diagnostics: [expect.objectContaining({ code })] })
			}
			await humanClient.close()
			expect((await readThread(ctx.app, REVIEW_ID)).revision).toBe(ready)

			// Reopen is unchanged on /mcp.
			const reopened = await client.callTool({ name: 'reopen_review_thread', arguments: { reviewId: REVIEW_ID, expectedRevision: ready, actor: agent } })
			expect(reopened.isError).not.toBe(true)
		}
		finally { await close() }
	})
})

describe('Review list summary and resolution filter', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('derives resolution, exposes variantNames and displayHint beside the anchor, and filters by resolution', async () => {
		const ctx = await session()
		const a = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: ['Empty'], displayHint: { pin: { x: 0.25, y: 0.5 } } })
		const b = await ctx.app.createReviewThread({ id: SECOND_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		await ctx.app.createReviewThread({ id: THIRD_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		if (a.status !== 'created' || b.status !== 'created') throw new Error('fixture')
		await ctx.app.resolveReviewThread({ reviewId: REVIEW_ID, expectedRevision: a.revision, actor: human, resolution: 'answered' })
		await ctx.app.resolveReviewThread({ reviewId: SECOND_REVIEW_ID, expectedRevision: b.revision, actor: human, resolution: 'duplicate', reason: `Duplicates ${REVIEW_ID}` })

		const all = await ctx.app.listPointResources({ kinds: ['review'], limit: 10 })
		if (all.status !== 'ok') throw new Error('list failed')
		const summaries = Object.fromEntries(all.page.items.map(item => [item.key, item.summary]))
		expect(summaries[REVIEW_ID]).toEqual({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: ['Empty'], displayHint: { pin: { x: 0.25, y: 0.5 } }, status: 'resolved', resolution: 'answered', messageCount: 0, latestActivityAt: expect.any(String) })
		expect(summaries[SECOND_REVIEW_ID]).toMatchObject({ status: 'resolved', resolution: 'duplicate', variantNames: [] })
		expect(summaries[SECOND_REVIEW_ID]).not.toHaveProperty('displayHint')
		// No message, submission or history event yet: no latest activity to report.
		expect(summaries[THIRD_REVIEW_ID]).toEqual({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: [], status: 'open', messageCount: 0 })

		const answeredOnly = await ctx.app.listPointResources({ resolution: ['answered'], limit: 10 })
		expect(answeredOnly.status === 'ok' ? answeredOnly.page.items.map(item => item.key) : undefined).toEqual([REVIEW_ID])
		const closedWithoutChange = await ctx.app.listPointResources({ kinds: ['review'], resolution: ['duplicate', 'answered'], limit: 1 })
		if (closedWithoutChange.status !== 'ok') throw new Error('list failed')
		expect(closedWithoutChange.page.items.map(item => item.key)).toEqual([REVIEW_ID])
		const next = await ctx.app.listPointResources({ kinds: ['review'], resolution: ['duplicate', 'answered'], limit: 1, cursor: closedWithoutChange.page.nextCursor })
		expect(next.status === 'ok' ? next.page.items.map(item => item.key) : undefined).toEqual([SECOND_REVIEW_ID])
		const crossScope = await ctx.app.listPointResources({ kinds: ['review'], limit: 1, cursor: closedWithoutChange.page.nextCursor })
		expect(crossScope).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'discovery.invalid_cursor' }] })
		const searched = await ctx.app.searchPointResources({ query: 'root', resolution: ['duplicate'], limit: 10 })
		expect(searched.status === 'ok' ? searched.page.items.map(item => item.key) : undefined).toEqual([SECOND_REVIEW_ID])

		for (const [resolution, code] of [[['promoted'], 'discovery.invalid_resolution'], [[], 'discovery.empty_resolution_filter'], [['answered', 'answered'], 'discovery.duplicate_resolution']] as const)
			expect(await ctx.app.listPointResources({ resolution, limit: 10 })).toMatchObject({ status: 'invalid', diagnostics: [{ code }] })

		const { client, close } = await connectedClient(ctx.app)
		try {
			const listed = await client.callTool({ name: 'list_resources', arguments: { kinds: ['review'], resolution: ['duplicate'], limit: 10 } })
			expect((listed.structuredContent as { items: { key: string; summary: { resolution?: string } }[] }).items.map(item => [item.key, item.summary.resolution])).toEqual([[SECOND_REVIEW_ID, 'duplicate']])
		}
		finally { await close() }
	})
})

describe('Review pin display hint', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('creates with a writer-normalized hint beside the strict anchor', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint: { pin: { x: 0.123456, y: 1.5 } } })
		expect(created.status).toBe(201)
		const thread = await readThread(ctx.app, REVIEW_ID)
		expect(thread.resource.displayHint).toEqual({ pin: { x: 0.1235, y: 1 } })
		expect(thread.resource.anchor).toEqual({ viewId: VIEW_ID, widgetId: 'root' })
		expect(thread.diagnostics).toEqual([])

		const insideAnchor = await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { viewId: VIEW_ID, widgetId: 'root', displayHint: { x: 0.5, y: 0.5 } } })
		expect(insideAnchor.status).toBe(400)
		expect(insideAnchor.body).toMatchObject({ code: 'malformed_payload' })
		for (const displayHint of [{}, { pin: { x: 0.5 } }, { pin: { x: 0.5, y: 0.5, z: 1 } }, { pin: { x: '0.5', y: 0.5 } }]) {
			const invalid = await createReviewThreadForHttp(scoped(ctx.app, MEI), { anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint })
			expect(invalid.status).toBe(400)
		}
		expect(await ctx.app.createReviewThread({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint: {} as never }))
			.toMatchObject({ status: 'invalid', diagnostics: [{ code: 'review.display_hint_empty' }] })
		expect(await ctx.app.createReviewThread({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint: { pin: { x: Number.NaN, y: 0 } } }))
			.toMatchObject({ status: 'invalid', diagnostics: [{ code: 'schema.expected_finite_number', path: '/displayHint/pin/x' }] })
	})

	it('moves and clears the hint over HTTP and MCP without history, with revision CAS', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		const rev = revisionOf(created)
		const moved = await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, displayHint: { pin: { x: 0.7, y: 0.33333 } } })
		expect(moved.status).toBe(200)
		const movedThread = await readThread(ctx.app, REVIEW_ID)
		expect(movedThread.resource.displayHint).toEqual({ pin: { x: 0.7, y: 0.3333 } })
		expect(movedThread.resource.history).toEqual([])
		expect(movedThread.revision).toBe(revisionOf(moved))

		const stale = await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, displayHint: null })
		expect(stale.status).toBe(409)
		expect(stale.body).toMatchObject({ status: 'conflict', currentRevision: revisionOf(moved) })
		expect((await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revisionOf(moved) })).status).toBe(400)
		expect((await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: revisionOf(moved), displayHint: {} })).status).toBe(400)
		expect((await setReviewDisplayHintForHttp(scoped(ctx.app, MEI), SECOND_REVIEW_ID, { expectedRevision: revisionOf(moved), displayHint: null })).status).toBe(404)

		const { client, close } = await connectedClient(ctx.app)
		try {
			const cleared = await client.callTool({ name: 'set_review_display_hint', arguments: { reviewId: REVIEW_ID, expectedRevision: revisionOf(moved), displayHint: null } })
			expect(cleared.isError).not.toBe(true)
			expect(cleared.structuredContent).toMatchObject({ status: 'updated', resourceUri: `uiux://review/${REVIEW_ID}` })
			const clearedThread = await readThread(ctx.app, REVIEW_ID)
			expect(clearedThread.resource).not.toHaveProperty('displayHint')
			expect(clearedThread.resource.history).toEqual([])
			// Clearing returns the thread to its exact pre-hint canonical bytes.
			expect(clearedThread.revision).toBe(rev)

			const viaMcp = await client.callTool({ name: 'set_review_display_hint', arguments: { reviewId: REVIEW_ID, expectedRevision: rev, displayHint: { pin: { x: 0.1, y: 0.9 } } } })
			expect(viaMcp.isError).not.toBe(true)
			expect((await readThread(ctx.app, REVIEW_ID)).resource.displayHint).toEqual({ pin: { x: 0.1, y: 0.9 } })
		}
		finally { await close() }
	})

	it('re-anchors with the decided tri-state hint rule and never records hints in history', async () => {
		const ctx = await session()
		const created = await createReviewThreadForHttp(scoped(ctx.app, MEI), { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint: { pin: { x: 0.2, y: 0.4 } } })
		let rev = revisionOf(created)
		const reanchor = async (body: Record<string, unknown>) => {
			const result = await reanchorReviewThreadForHttp(scoped(ctx.app, MEI), REVIEW_ID, { expectedRevision: rev, actor: human, ...body })
			expect(result.status).toBe(200)
			rev = revisionOf(result)
			return (await readThread(ctx.app, REVIEW_ID)).resource
		}

		// Only Variants change: kept.
		expect((await reanchor({ anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: ['Empty'] })).displayHint).toEqual({ pin: { x: 0.2, y: 0.4 } })
		// Widget changes: cleared.
		expect(await reanchor({ anchor: { viewId: VIEW_ID, widgetId: 'submit' }, variantNames: ['Empty'] })).not.toHaveProperty('displayHint')
		// Widget changes with an explicit hint: the explicit value wins (normalized).
		expect((await reanchor({ anchor: { viewId: VIEW_ID, widgetId: 'header' }, displayHint: { pin: { x: 0.55555, y: 0 } } })).displayHint).toEqual({ pin: { x: 0.5556, y: 0 } })
		// Variant-only change with explicit null: cleared.
		const cleared = await reanchor({ anchor: { viewId: VIEW_ID, widgetId: 'header' }, variantNames: ['Empty'], displayHint: null })
		expect(cleared).not.toHaveProperty('displayHint')

		expect(cleared.history).toHaveLength(4)
		for (const event of cleared.history) {
			expect(event.kind).toBe('reanchor')
			expect(Object.keys(event.before!).sort()).toEqual(['anchor', 'variantNames'])
			expect(Object.keys(event.after!).sort()).toEqual(['anchor', 'variantNames'])
			expect(Object.keys(event.after!.anchor).sort()).toEqual(['viewId', 'widgetId'])
		}

		const { client, close } = await connectedClient(ctx.app)
		try {
			const viaMcp = await client.callTool({
				name: 'reanchor_review_thread',
				arguments: { reviewId: REVIEW_ID, expectedRevision: rev, anchor: { viewId: VIEW_ID, widgetId: 'root' }, actor: agent, displayHint: { pin: { x: 0.9, y: 0.1 } } },
			})
			expect(viaMcp.isError).not.toBe(true)
			expect((await readThread(ctx.app, REVIEW_ID)).resource.displayHint).toEqual({ pin: { x: 0.9, y: 0.1 } })
			const insideAnchor = await client.callTool({
				name: 'create_review_thread',
				arguments: { anchor: { viewId: VIEW_ID, widgetId: 'root', displayHint: { x: 0.5, y: 0.5 } } },
			})
			expect(insideAnchor.isError).toBe(true)
			const created2 = await client.callTool({ name: 'create_review_thread', arguments: { id: SECOND_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, displayHint: { pin: { x: 0.3, y: 0.3 } } } })
			expect(created2.isError).not.toBe(true)
			expect((await readThread(ctx.app, SECOND_REVIEW_ID)).resource.displayHint).toEqual({ pin: { x: 0.3, y: 0.3 } })
		}
		finally { await close() }
	})
})

describe('packaged Workbench server routes (requires pnpm build)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('serves display-hint and resolution routes, holds its Workspace, and makes uiux migrate refuse while running', async () => {
		const server = await startWorkbenchServer()
		try {
			await access(join(server.workspaceRoot, SERVER_HOLD_RELATIVE_PATH))
			const post = async (path: string, body: unknown) => {
				const response = await fetch(`${server.origin}${path}`, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) })
				return { status: response.status, body: await response.json() as Record<string, unknown> }
			}
			const workspace = await (await fetch(`${server.origin}/api/resources/workspace/workspace`, { headers: server.headers })).json() as { resource: { schemaVersion: number }; inspection: { state: string } }
			expect(workspace.resource.schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
			expect(workspace.inspection.state).toBe('current')
			const views = await (await fetch(`${server.origin}/api/resources/list`, { method: 'POST', headers: { ...server.headers, 'content-type': 'application/json' }, body: JSON.stringify({ kinds: ['view'], limit: 1 }) })).json() as { items: { key: string }[] }
			const viewId = views.items[0]!.key

			const created = await post('/api/reviews', { anchor: { viewId, widgetId: 'root' }, displayHint: { pin: { x: 0.5, y: 0.25 } } })
			expect(created.status).toBe(201)
			const key = created.body.key as string
			const moved = await post(`/api/reviews/${key}/display-hint`, { expectedRevision: created.body.revision, displayHint: { pin: { x: 0.75, y: 0.25 } } })
			expect(moved.status).toBe(200)
			const missingResolution = await post(`/api/reviews/${key}/resolve`, { expectedRevision: moved.body.revision, actor: human })
			expect(missingResolution.status).toBe(400)
			const resolved = await post(`/api/reviews/${key}/resolve`, { expectedRevision: moved.body.revision, actor: human, resolution: 'answered' })
			expect(resolved.status).toBe(200)
			const read = await (await fetch(`${server.origin}/api/resources/review/${key}`, { headers: server.headers })).json() as { resource: ReviewThread; diagnostics: unknown[] }
			expect(read.diagnostics).toEqual([])
			expect(read.resource.displayHint).toEqual({ pin: { x: 0.75, y: 0.25 } })
			expect(read.resource.history.at(-1)).toMatchObject({ to: 'resolved', resolution: 'answered' })

			const refused = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', server.workspaceRoot], { encoding: 'utf8' })
			expect(refused.status).toBe(1)
			expect(refused.stderr).toContain('refusing to migrate')
		}
		finally { await server.close() }
	}, 60_000)
})
