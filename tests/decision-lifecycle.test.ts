import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager } from '../src/application/access/leases'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { VersionListing } from '../src/application/services/history-service'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { Decision } from '../src/domain/spec/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { createDecisionFromReviewForHttp, decideDecisionForHttp, transitionDecisionForHttp } from '../src/server/authoring-http'
import { connectMcp, presetKeys, scoped, testMember } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The Decision lifecycle, `defer_decision`, `decide_decision`, `reopen_decision` and
 * `create_decision_from_review` with their HTTP routes (issue #86; Clauses
 * 01a17226-fafc-7691-99ff-aa3b20f5836f, 01a17226-fca4-7a13-b38e-c51ffeb47c44 and
 * 01a17226-f9d8-7fe9-ac7c-549177becb02; Rules 01a11544-5e99-789d-bfed-dda22a98776f,
 * 01a11544-5ec3-73ae-b122-ed8387eff75b and 01a11544-6084-7f2c-848d-cc4319e66134).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const MISSING_VIEW_ID = '33333333-3333-4333-8333-333333333333'
const DECISION_ID = '55555555-5555-4555-8555-555555555555'
const MISSING_DECISION_ID = '66666666-6666-4666-8666-666666666666'
const REVIEW_ID = '77777777-7777-4777-8777-777777777777'
const SECOND_DECISION_ID = '99999999-9999-4999-8999-999999999999'
const START = Date.parse('2026-10-25T00:00:00.000Z')

const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', preset: 'owner', credential: 'session' })
const OWNER_TOKEN = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', preset: 'owner', credential: 'token' })
const EDITOR_SESSION = testMember({ memberId: 'editor-1', nickname: 'eve', kind: 'human', preset: 'editor', credential: 'session' })
const REVIEWER = testMember({ memberId: 'reviewer-1', nickname: 'rui', kind: 'human', preset: 'reviewer', credential: 'session' })
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', preset: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ memberId: 'agent-2', nickname: 'codex', kind: 'agent', preset: 'editor', credential: 'token' })

const MANIFEST = {
	schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	i18n: { defaultLocale: 'en-US' },
	viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
	themes: { light: { label: 'Light' } },
} satisfies WorkspaceManifest

const VIEW: ViewResource = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } } as ViewResource['ir'],
	variants: {},
	spec: {
		intent: 'Pay for the order.',
		entryConditions: [],
		interactionRules: [],
		constraints: [],
		accessibility: [],
		references: [],
		requirements: [],
		decisions: [{ id: DECISION_ID, question: 'Keep a single Pay button?', status: 'pending', history: [] }],
	},
}

const cleanup: string[] = []
const running: HistoryRecorder[] = []
afterEach(async () => {
	await Promise.all(running.splice(0).map(recorder => recorder.stop()))
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(path)
	return path
}

function manualClock(): HistoryRecorderClock {
	return { now: () => START, setTimeout: () => Symbol('timer'), clearTimeout: () => undefined }
}

type Fixture = Readonly<{ persistence: FileNativePersistence; app: WorkspaceApplicationSession; recorder: HistoryRecorder }>

async function fixture(): Promise<Fixture> {
	const root = await tempDir('uiux-decision-lifecycle-ws-')
	const home = join(await tempDir('uiux-decision-lifecycle-home-'), 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, MANIFEST)
	await persistence.views.create(VIEW_ID, VIEW)
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock: manualClock(), log: () => undefined })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
	running.push(recorder)
	expect(await recorder.start()).toMatchObject({ enabled: true })
	return { persistence, app, recorder }
}

async function readView(ctx: Fixture) {
	const read = await ctx.persistence.views.read(VIEW_ID)
	if (!read) throw new Error('View is missing')
	return read
}

async function decisionOf(ctx: Fixture, id = DECISION_ID): Promise<Decision> {
	const decision = (await readView(ctx)).resource.spec.decisions?.find(item => item.id === id)
	if (!decision) throw new Error(`Decision ${id} is missing`)
	return decision
}

const OUTCOME = { summary: 'Keep one button', rationale: 'Fewer taps.' }

describe('the lifecycle service (Rules 01a11544-5e99, 01a11544-5ec3 and 01a11544-5eee)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('defers, decides and reopens one Decision in place, each appending a history entry with the stamped actor', async () => {
		const ctx = await fixture()
		const human = scoped(ctx.app, OWNER)
		const actor = { type: 'human', id: `member:${OWNER.memberId}`, displayName: 'mei' }

		let revision: string = (await readView(ctx)).revision
		const deferred = await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision })
		expect(deferred).toMatchObject({ status: 'updated', key: VIEW_ID, decision: { id: DECISION_ID, status: 'deferred' } })
		revision = (deferred as { revision: string }).revision
		expect(revision).toBe((await readView(ctx)).revision)

		const decided = await human.decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME })
		expect(decided).toMatchObject({ status: 'updated', decision: { status: 'decided', outcome: OUTCOME } })
		revision = (decided as { revision: string }).revision

		const reopened = await human.reopenDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision })
		expect(reopened).toMatchObject({ status: 'updated', decision: { status: 'pending' } })

		const decision = await decisionOf(ctx)
		expect(Object.hasOwn(decision, 'outcome')).toBe(false)
		expect(decision.history.map(entry => [entry.before.status, entry.after.status])).toEqual([['pending', 'deferred'], ['deferred', 'decided'], ['decided', 'pending']])
		for (const entry of decision.history) expect(entry.actor).toEqual(actor)
		// The earlier outcome survives only in the history.
		expect(decision.history[2]).toMatchObject({ before: { status: 'decided', outcome: OUTCOME }, after: { status: 'pending' } })
		expect(Object.hasOwn(decision.history[2]!.after, 'outcome')).toBe(false)
		// The Decision keeps its identity and its place in the list.
		expect((await readView(ctx)).resource.spec.decisions!.map(item => item.id)).toEqual([DECISION_ID])
	})

	it('decides a pending Decision directly and reopens a deferred one back to pending', async () => {
		const ctx = await fixture()
		const human = scoped(ctx.app, OWNER)
		const decided = await human.decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (await readView(ctx)).revision, outcome: OUTCOME })
		expect(decided).toMatchObject({ status: 'updated', decision: { status: 'decided' } })
		const reopened = await human.reopenDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (decided as { revision: string }).revision })
		const deferred = await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (reopened as { revision: string }).revision })
		const back = await human.reopenDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (deferred as { revision: string }).revision })
		expect(back).toMatchObject({ status: 'updated', decision: { status: 'pending' } })
	})

	it('refuses a transition the status does not allow as decision.invalid_transition, with the revision unchanged', async () => {
		const ctx = await fixture()
		const human = scoped(ctx.app, OWNER)
		const invalid = { status: 'invalid', key: VIEW_ID, diagnostics: [expect.objectContaining({ code: 'decision.invalid_transition' })] }

		const deferred = await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (await readView(ctx)).revision })
		let revision = (deferred as { revision: string }).revision
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision })).toMatchObject(invalid)
		const decided = await human.decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME })
		revision = (decided as { revision: string }).revision
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision })).toMatchObject(invalid)
		expect(await human.decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME })).toMatchObject(invalid)
		expect((await readView(ctx)).revision).toBe(revision)
	})

	it('refuses a pending Decision that is reopened, a malformed outcome, a stale revision, and unknown or malformed ids', async () => {
		const ctx = await fixture()
		const human = scoped(ctx.app, OWNER)
		const before = await readView(ctx)
		const reopenPending = await human.reopenDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: before.revision })
		expect(reopenPending).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'decision.invalid_transition' })] })
		for (const outcome of [{ summary: '   ', rationale: 'x' }, { summary: 'x' }, undefined, { summary: 3, rationale: '' }]) {
			expect(await human.decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: before.revision, outcome: outcome as never }), JSON.stringify(outcome)).toMatchObject({ status: 'invalid' })
		}
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: 'r_stale' })).toMatchObject({ status: 'conflict', currentRevision: before.revision })
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: MISSING_DECISION_ID, expectedRevision: before.revision })).toEqual({ status: 'not_found', key: MISSING_DECISION_ID })
		expect(await human.deferDecision({ key: MISSING_VIEW_ID, decisionId: DECISION_ID, expectedRevision: before.revision })).toEqual({ status: 'not_found', key: MISSING_VIEW_ID })
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: 'nope', expectedRevision: before.revision })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'identity.invalid_uuid' }] })
		expect(await human.deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: '' })).toMatchObject({ status: 'invalid_expected_revision' })
		expect((await readView(ctx)).revision).toBe(before.revision)
	})

	it('describes the change under /spec/decisions/<id> in the change summary', async () => {
		const ctx = await fixture()
		const result = await scoped(ctx.app, OWNER).deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (await readView(ctx)).revision })
		const paths = (result as unknown as { changeSummary: { changes: { path: string }[] } }).changeSummary.changes.map(change => change.path)
		expect(paths.length).toBeGreaterThan(0)
		for (const path of paths) expect(path.startsWith(`/spec/decisions/${DECISION_ID}`), path).toBe(true)
	})
})

describe('who may act (decisions.decide is humanOnly)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lets only a human Workbench session with decisions.decide decide, and views.write defer and reopen', async () => {
		const ctx = await fixture()
		const revision = (await readView(ctx)).revision
		const decide = (principal: typeof OWNER) => scoped(ctx.app, principal).decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME })
		const refused = { status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['decisions.decide'] }

		// An Agent holding every key that is not humanOnly, a human Token, a human Editor session and a Reviewer.
		const everyKey = testMember({ kind: 'agent', credential: 'token', keys: presetKeys('owner', 'agent') })
		expect(everyKey.keys).not.toContain('decisions.decide')
		for (const principal of [everyKey, AGENT, OWNER_TOKEN, EDITOR_SESSION, REVIEWER])
			expect(await decide(principal), principal.nickname).toMatchObject(refused)
		// An Agent given the key by hand still never holds it (roster files are loaded the same way).
		expect(await decide(testMember({ kind: 'agent', credential: 'token', keys: [...presetKeys('owner', 'agent'), 'decisions.decide'] }))).toMatchObject(refused)
		expect((await readView(ctx)).revision).toBe(revision)

		const deferred = await scoped(ctx.app, AGENT, { transport: 'mcp' }).deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision })
		expect(deferred).toMatchObject({ status: 'updated', decision: { status: 'deferred', history: [{ actor: { type: 'agent', displayName: 'claude' } }] } })
		expect(await scoped(ctx.app, REVIEWER).reopenDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (deferred as { revision: string }).revision }))
			.toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		expect(await scoped(ctx.app, OWNER).decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: (deferred as { revision: string }).revision, outcome: OUTCOME }))
			.toMatchObject({ status: 'updated', decision: { status: 'decided' } })
	})

	it('checks the View\'s edit lease, refusing as locked while another member holds it', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const revision = (await readView(ctx)).revision
		const holder = scoped(ctx.app, OTHER_AGENT, { leases, transport: 'mcp' })
		expect(holder.acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'acquired' })
		expect(await scoped(ctx.app, OWNER, { leases }).deferDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision }))
			.toMatchObject({ status: 'locked', code: 'resource.locked', lock: { kind: 'view', key: VIEW_ID } })
		expect(await scoped(ctx.app, OWNER, { leases }).decideDecision({ key: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME }))
			.toMatchObject({ status: 'locked' })
		expect((await readView(ctx)).revision).toBe(revision)
	})
})

describe('the lifecycle over MCP and HTTP', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists the three tools, runs defer and reopen as an Agent, refuses decide, and records write events', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const mcp = await connectMcp(ctx.app, AGENT, { leases, history: ctx.recorder })
		try {
			const tools = (await mcp.client.listTools()).tools
			for (const name of ['defer_decision', 'decide_decision', 'reopen_decision', 'create_decision_from_review'])
				expect(tools.some(tool => tool.name === name), name).toBe(true)
			expect(Object.keys(tools.find(tool => tool.name === 'defer_decision')!.inputSchema.properties ?? {}).sort()).toEqual(['decisionId', 'expectedRevision', 'viewId'])
			expect(Object.keys(tools.find(tool => tool.name === 'decide_decision')!.inputSchema.properties ?? {}).sort()).toEqual(['decisionId', 'expectedRevision', 'outcome', 'viewId'])

			let revision: string = (await readView(ctx)).revision
			const deferred = await mcp.client.callTool({ name: 'defer_decision', arguments: { viewId: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision } })
			expect(deferred.isError).not.toBe(true)
			expect(deferred.structuredContent).toMatchObject({ status: 'updated', key: VIEW_ID, resourceUri: `uiux://view/${VIEW_ID}`, decision: { status: 'deferred' } })
			revision = (deferred.structuredContent as { revision: string }).revision

			const decide = await mcp.client.callTool({ name: 'decide_decision', arguments: { viewId: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision, outcome: OUTCOME } })
			expect(decide.isError).toBe(true)
			expect(decide.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['decisions.decide'] })

			const invalid = await mcp.client.callTool({ name: 'defer_decision', arguments: { viewId: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision } })
			expect(invalid.isError).toBe(true)
			expect(invalid.structuredContent).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'decision.invalid_transition' }] })

			const reopened = await mcp.client.callTool({ name: 'reopen_decision', arguments: { viewId: VIEW_ID, decisionId: DECISION_ID, expectedRevision: revision } })
			expect(reopened.structuredContent).toMatchObject({ status: 'updated', decision: { status: 'pending' } })
			expect((await mcp.client.callTool({ name: 'release_lock', arguments: {} })).structuredContent).toMatchObject({ status: 'released' })
		}
		finally {
			await mcp.close()
		}
		const listing = (await ctx.app.listVersions({})) as VersionListing
		const autosave = listing.versions.find(version => version.type === 'autosave')!
		const read = await ctx.app.readVersion(autosave.id)
		if (read.status !== 'found' || read.version.type === 'checkpoint') throw new Error(JSON.stringify(read))
		expect(read.version.events.map(event => [event.operation, event.source])).toEqual([['deferDecision', 'mcp'], ['reopenDecision', 'mcp']])
	})

	it('maps every HTTP result to its status, and decide needs a human session holding the key', async () => {
		const ctx = await fixture()
		const revision = (await readView(ctx)).revision
		const human = scoped(ctx.app, OWNER)
		const defer = (body: unknown, view = VIEW_ID, decision = DECISION_ID, session = human) => transitionDecisionForHttp(session, 'defer', view, decision, body)

		expect(await defer({ expectedRevision: revision, extra: 1 })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })
		expect(await defer({ expectedRevision: '' })).toMatchObject({ status: 400, body: { status: 'invalid_expected_revision' } })
		expect(await defer({ expectedRevision: revision }, MISSING_VIEW_ID)).toMatchObject({ status: 404 })
		expect(await defer({ expectedRevision: revision }, VIEW_ID, MISSING_DECISION_ID)).toMatchObject({ status: 404 })
		expect(await defer({ expectedRevision: revision }, VIEW_ID, DECISION_ID, scoped(ctx.app, REVIEWER))).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['views.write'] } })
		expect(await decideDecisionForHttp(scoped(ctx.app, OWNER_TOKEN), VIEW_ID, DECISION_ID, { expectedRevision: revision, outcome: OUTCOME })).toMatchObject({ status: 403, body: { requiredKeys: ['decisions.decide'] } })
		expect(await decideDecisionForHttp(human, VIEW_ID, DECISION_ID, { expectedRevision: revision })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })

		const deferred = await defer({ expectedRevision: revision })
		expect(deferred).toMatchObject({ status: 200, body: { status: 'updated', decision: { status: 'deferred' } } })
		const next = (deferred.body as { revision: string }).revision
		expect(await defer({ expectedRevision: revision })).toMatchObject({ status: 409, body: { status: 'conflict', currentRevision: next } })
		expect(await defer({ expectedRevision: next })).toMatchObject({ status: 400, body: { status: 'invalid', diagnostics: [{ code: 'decision.invalid_transition' }] } })
		const decided = await decideDecisionForHttp(human, VIEW_ID, DECISION_ID, { expectedRevision: next, outcome: OUTCOME })
		expect(decided).toMatchObject({ status: 200, body: { status: 'updated', decision: { status: 'decided', outcome: OUTCOME } } })
		const reopened = await transitionDecisionForHttp(human, 'reopen', VIEW_ID, DECISION_ID, { expectedRevision: (decided.body as { revision: string }).revision })
		expect(reopened).toMatchObject({ status: 200, body: { decision: { status: 'pending' } } })
		expect(Object.hasOwn((await decisionOf(ctx)), 'outcome')).toBe(false)
	})
})

describe('another Decision from the same thread (Rule 01a11544-6084 and Clause 01a17226-fca4)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function promoted(ctx: Fixture) {
		const review = await ctx.app.createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' } })
		if (review.status !== 'created') throw new Error(JSON.stringify(review))
		const first = await scoped(ctx.app, REVIEWER).promoteReviewToDecision({
			reviewId: REVIEW_ID,
			expectedReviewRevision: review.revision,
			viewId: VIEW_ID,
			expectedViewRevision: (await readView(ctx)).revision,
			question: 'First question?',
		})
		if (first.status !== 'updated') throw new Error(JSON.stringify(first))
		return { review: (await ctx.persistence.reviews.read(REVIEW_ID))!, first }
	}

	it('creates a second, independent Decision from a promoted thread, and promotion still returns the first', async () => {
		const ctx = await fixture()
		const { review, first } = await promoted(ctx)
		const viewRevision = (await readView(ctx)).revision
		const another = await scoped(ctx.app, REVIEWER).createDecisionFromReview({
			reviewId: REVIEW_ID,
			expectedReviewRevision: review.revision,
			viewId: VIEW_ID,
			expectedViewRevision: viewRevision,
			decisionId: SECOND_DECISION_ID,
			question: 'Second question?',
		})
		expect(another).toMatchObject({ status: 'updated', decision: { id: SECOND_DECISION_ID, status: 'pending', provenance: { reviewId: REVIEW_ID, sourceReviewThreadId: REVIEW_ID } } })
		const decisions = (await readView(ctx)).resource.spec.decisions!
		expect(decisions.map(item => item.id)).toEqual([DECISION_ID, first.decision!.id, SECOND_DECISION_ID])
		expect(decisions.filter(item => item.provenance?.reviewId === REVIEW_ID)).toHaveLength(2)
		// The thread is unchanged, and promotion keeps returning the first Decision.
		expect((await ctx.persistence.reviews.read(REVIEW_ID))!.revision).toBe(review.revision)
		const again = await scoped(ctx.app, REVIEWER).promoteReviewToDecision({ reviewId: REVIEW_ID, expectedReviewRevision: 'r_stale', viewId: VIEW_ID, expectedViewRevision: 'r_stale', question: 'ignored' })
		expect(again).toMatchObject({ status: 'updated', decision: { id: first.decision!.id } })
	})

	it('returns the Decision it created for a retry with the same decisionId, before any revision check and writing nothing', async () => {
		const ctx = await fixture()
		const { review } = await promoted(ctx)
		const command = { reviewId: REVIEW_ID, expectedReviewRevision: review.revision, viewId: VIEW_ID, expectedViewRevision: (await readView(ctx)).revision, decisionId: SECOND_DECISION_ID, question: 'Second question?' }
		expect(await scoped(ctx.app, REVIEWER).createDecisionFromReview(command)).toMatchObject({ status: 'updated' })
		const written = await readView(ctx)
		const retry = await scoped(ctx.app, REVIEWER).createDecisionFromReview(command)
		expect(retry).toMatchObject({ status: 'updated', decision: { id: SECOND_DECISION_ID }, changeSummary: { changes: [] } })
		expect(await scoped(ctx.app, REVIEWER).createDecisionFromReview({ ...command, question: 'Different text', expectedViewRevision: 'r_stale' })).toMatchObject({ status: 'updated', decision: { id: SECOND_DECISION_ID, question: 'Second question?' } })
		// A retry also ignores a different outcome, and an earlier Decision of the same thread is returned by its id.
		expect(await scoped(ctx.app, REVIEWER).createDecisionFromReview({ ...command, outcome: OUTCOME })).toMatchObject({ status: 'updated', decision: { id: SECOND_DECISION_ID, status: 'pending' } })
		const firstId = (await readView(ctx)).resource.spec.decisions!.find(item => item.question === 'First question?')!.id
		expect(await scoped(ctx.app, REVIEWER).createDecisionFromReview({ ...command, decisionId: firstId, question: 'Ignored' })).toMatchObject({ status: 'updated', decision: { id: firstId, question: 'First question?' } })
		expect((await readView(ctx)).revision).toBe(written.revision)
		expect((await readView(ctx)).resource.spec.decisions).toHaveLength(3)
	})

	it('refuses a decisionId that names a Decision from another thread, a missing or malformed decisionId, and a stale revision', async () => {
		const ctx = await fixture()
		const { review } = await promoted(ctx)
		const command = { reviewId: REVIEW_ID, expectedReviewRevision: review.revision, viewId: VIEW_ID, expectedViewRevision: (await readView(ctx)).revision, question: 'Second question?' }
		const member = scoped(ctx.app, REVIEWER)
		expect(await member.createDecisionFromReview({ ...command, decisionId: DECISION_ID })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'decision.id_in_use' }] })
		expect(await member.createDecisionFromReview({ ...command, decisionId: 'nope' })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'identity.invalid_uuid', path: '/decisionId' }] })
		expect(await member.createDecisionFromReview({ ...command, decisionId: undefined as never })).toMatchObject({ status: 'invalid' })
		expect(await member.createDecisionFromReview({ ...command, decisionId: SECOND_DECISION_ID, expectedViewRevision: 'r_stale' })).toMatchObject({ status: 'conflict', conflicts: [{ resource: 'view' }] })
		expect((await readView(ctx)).resource.spec.decisions).toHaveLength(2)
	})

	it('needs reviews.promote, and works the same over HTTP and MCP', async () => {
		const ctx = await fixture()
		const { review } = await promoted(ctx)
		const body = (decisionId: string, viewRevision: string) => ({ expectedReviewRevision: review.revision, viewId: VIEW_ID, expectedViewRevision: viewRevision, decisionId, question: 'Another?' })
		const viewer = testMember({ kind: 'human', credential: 'session', preset: 'viewer' })
		expect(await createDecisionFromReviewForHttp(scoped(ctx.app, viewer), REVIEW_ID, body(SECOND_DECISION_ID, (await readView(ctx)).revision))).toMatchObject({ status: 403, body: { requiredKeys: ['reviews.promote'] } })
		expect(await createDecisionFromReviewForHttp(scoped(ctx.app, REVIEWER), REVIEW_ID, { ...body(SECOND_DECISION_ID, 'x'), extra: 1 })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })
		const viaHttp = await createDecisionFromReviewForHttp(scoped(ctx.app, REVIEWER), REVIEW_ID, body(SECOND_DECISION_ID, (await readView(ctx)).revision))
		expect(viaHttp).toMatchObject({ status: 200, body: { status: 'updated', decision: { id: SECOND_DECISION_ID } } })

		const mcp = await connectMcp(ctx.app, testMember({ kind: 'agent', credential: 'token', preset: 'reviewer', nickname: 'critic' }))
		try {
			const third = '12121212-1212-4212-8212-121212121212'
			const viaMcp = await mcp.client.callTool({ name: 'create_decision_from_review', arguments: { reviewId: REVIEW_ID, ...body(third, (await readView(ctx)).revision) } })
			expect(viaMcp.isError).not.toBe(true)
			expect(viaMcp.structuredContent).toMatchObject({ status: 'updated', decision: { id: third }, targetView: { key: VIEW_ID } })
			const retried = await mcp.client.callTool({ name: 'create_decision_from_review', arguments: { reviewId: REVIEW_ID, ...body(third, 'r_stale') } })
			expect(retried.structuredContent).toMatchObject({ status: 'updated', decision: { id: third } })
		}
		finally {
			await mcp.close()
		}
		expect((await readView(ctx)).resource.spec.decisions).toHaveLength(4)
	})
})
