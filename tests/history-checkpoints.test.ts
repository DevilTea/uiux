import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import diffRoute from '../server/api/history/diff.get'
import createCheckpointRoute from '../server/api/history/checkpoints.post'
import deleteCheckpointRoute from '../server/api/history/checkpoints/[id].delete'
import listVersionsRoute from '../server/api/history/versions.get'
import readVersionRoute from '../server/api/history/versions/[id].get'
import loginRoute from '../server/api/session/login.post'
import { createLeaseManager } from '../src/application/access/leases'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { CheckpointBoundary, VersionListing, VersionListItem } from '../src/application/services/history-service'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { CheckpointRecord, HostVersionRecord } from '../src/domain/history/schema'
import { FileNativePersistence, localeRelativePath, WORKSPACE_CHECKPOINTS_DIRECTORY, workspaceRelativePath } from '../src/persistence'
import { readMergedTimeline } from '../src/persistence/history'
import { CHECKPOINT_RECOMMENDATION, versionResourceUri } from '../src/mcp/server'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createHistoryStoreFactory, type HistoryStoreFactory } from '../src/server/history-stores'
import { createCheckpointForHttp, deleteCheckpointForHttp, diffVersionsForHttp, listVersionsForHttp, readVersionForHttp } from '../src/server/history-http'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, connectMcp, provisionToken, scoped, sessionCookieFor, testMember } from './support/access'

/**
 * Named Checkpoints, the version listing and their access (issue #132 B4): Feature
 * 01a11a5d-fcb9-72b3-a52d-52c0fbd74401 Rules 0919, 096a, 09bb, 0a0c, 0a5e, 0bcd, 0c1f; Rules
 * 01a11a5e-00b9, 0313, 07c1, 081c, 1ca3 and 01a11a5d-fe15; MCP Clauses 01a11a5e-265d, 26b9 (as
 * amended by https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18828964), 27c1,
 * 2821; Access Clauses 01a11485-fa00, fa21, fa66, f978; Scenario 01a11a5e-90a5-70f3-912e-e9e6e9b0eee9.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const START = Date.parse('2026-10-09T00:00:00.000Z')
const VERBATIM_INSTRUCTION = 'When you finish a meaningful task that changed design resources, call `create_checkpoint` with a descriptive name, then `release_lock`.'

const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', role: 'owner', credential: 'session' })
const OWNER_TOKEN = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', role: 'owner', credential: 'token' })
const EDITOR = testMember({ memberId: 'editor-1', nickname: 'eve', kind: 'human', role: 'editor', credential: 'session' })
const REVIEWER = testMember({ memberId: 'reviewer-1', nickname: 'rui', kind: 'human', role: 'reviewer', credential: 'session' })
const VIEWER = testMember({ memberId: 'viewer-1', nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
const AGENT_REVIEWER = testMember({ memberId: 'agent-2', nickname: 'critic', kind: 'agent', role: 'reviewer', credential: 'token' })
const AGENT_OWNER = testMember({ memberId: 'agent-3', nickname: 'boss', kind: 'agent', role: 'owner', credential: 'token' })

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

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

/** A clock whose timers never fire unless a test advances it. */
function manualClock(start = START): HistoryRecorderClock & Readonly<{ advance(milliseconds: number): void }> {
	let now = start
	return {
		now: () => now,
		setTimeout: () => Symbol('timer'),
		clearTimeout: () => undefined,
		advance(milliseconds) { now += milliseconds },
	}
}

type Fixture = Readonly<{
	root: string
	persistence: FileNativePersistence
	history: HistoryStoreFactory
	recorder: HistoryRecorder
	clock: ReturnType<typeof manualClock>
	app: WorkspaceApplicationSession
	baseline: string
}>

async function fixture(options: Readonly<{ boundary?: CheckpointBoundary }> = {}): Promise<Fixture> {
	const root = await tempDir('uiux-checkpoints-ws-')
	const home = join(await tempDir('uiux-checkpoints-home-'), 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await persistence.locales.create('en-US', { greeting: 'Hello' })
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const clock = manualClock()
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock, log: () => undefined })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => options.boundary ?? recorder })
	expect((await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).status).toBe('created')
	const started = await recorder.start()
	running.push(recorder)
	expect(started).toMatchObject({ enabled: true, baseline: expect.any(String) })
	return { root, persistence, history, recorder, clock, app, baseline: started.baseline! }
}

async function editView(ctx: Fixture, principal: MemberPrincipal, intent: string): Promise<void> {
	ctx.clock.advance(1_000)
	const session = scoped(ctx.app, principal, { history: ctx.recorder, transport: principal.kind === 'agent' ? 'mcp' : 'http' })
	const result = await session.updateViewSpec({ key: VIEW_ID, expectedRevision: (await ctx.persistence.views.readRevision(VIEW_ID))!, spec: spec(intent) })
	expect(result.status).toBe('updated')
}

/** A change made outside UIUX: a text editor rewrites the Locale file. */
async function externalLocaleEdit(ctx: Fixture, greeting: string): Promise<string> {
	ctx.clock.advance(1_000)
	await writeFile(join(ctx.root, localeRelativePath('en-US')), `${JSON.stringify({ greeting }, null, '\t')}\n`)
	return (await ctx.persistence.locales.readRevision('en-US'))!
}

async function createCheckpoint(ctx: Fixture, principal: MemberPrincipal, name: string, note?: string): Promise<string> {
	ctx.clock.advance(1_000)
	const outcome = await scoped(ctx.app, principal).createCheckpoint({ name, ...(note === undefined ? {} : { note }) })
	expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'created' })
	return (outcome as { versionId: string }).versionId
}

async function canonicalBytes(ctx: Fixture): Promise<Map<string, string>> {
	const snapshot = await ctx.persistence.withReadLock(() => ctx.persistence.scanCanonicalSnapshotUnlocked())
	return new Map([...snapshot].map(([path, bytes]) => [path, Buffer.from(bytes).toString('base64')]))
}

async function checkpointFiles(ctx: Fixture): Promise<string[]> {
	return (await readdir(join(ctx.root, WORKSPACE_CHECKPOINTS_DIRECTORY))).sort()
}

async function readCheckpointFile(ctx: Fixture, id: string): Promise<CheckpointRecord> {
	return JSON.parse(await readFile(join(ctx.root, WORKSPACE_CHECKPOINTS_DIRECTORY, `${id}.json`), 'utf8')) as CheckpointRecord
}

function listed(outcome: unknown): VersionListing {
	expect((outcome as { status: string }).status, JSON.stringify(outcome)).toBe('listed')
	return outcome as VersionListing
}

const actorOf = (principal: MemberPrincipal) => ({ type: principal.kind, id: `member:${principal.memberId}`, displayName: principal.nickname })

describe('creating a Checkpoint', () => {
	it('writes a named record with the member as actor, holding no lease and changing no canonical file (Scenario 01a11a5e-90a5)', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		// Another member's edit lease on the View does not stop a Checkpoint (Rule 01a11a5e-0a0c-7d65-8d09-9a71a730ec61).
		expect(scoped(ctx.app, AGENT, { leases }).acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'acquired' })
		const before = await canonicalBytes(ctx)
		ctx.clock.advance(1_000)
		const outcome = await scoped(ctx.app, REVIEWER, { leases }).createCheckpoint({ name: '  v1 layout approved  ', note: 'Signed off in the design review.' })
		expect(outcome).toMatchObject({ status: 'created', versionId: expect.any(String), at: expect.any(String), resources: 3 })
		const { versionId, at } = outcome as { versionId: string; at: string }

		const record = await readCheckpointFile(ctx, versionId)
		expect(record).toMatchObject({
			type: 'checkpoint',
			name: 'v1 layout approved',
			note: 'Signed off in the design review.',
			actor: actorOf(REVIEWER),
			source: 'workbench',
			at,
			parentCheckpoint: ctx.baseline,
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		})
		expect(record.resources.map(resource => `${resource.kind}:${resource.key}`)).toEqual(['locale:en-US', `view:${VIEW_ID}`, 'workspace:workspace'])
		// Its blobs are in the derived-artifact store (Clause 01a11a5e-1e0e-7539-b925-c54dcb1afb55).
		for (const digest of record.resources.flatMap(resource => Object.values(resource.files)))
			expect(await ctx.persistence.artifacts.read(digest)).toBeInstanceOf(Uint8Array)
		expect(await canonicalBytes(ctx)).toEqual(before)
		// The reviewer took no lease and the agent's lease is untouched.
		expect(leases.list().map(lease => [lease.holder.nickname, lease.kind, lease.key])).toEqual([['claude', 'view', VIEW_ID]])
	})

	it('lets an Agent create one over MCP, recording source mcp', async () => {
		const ctx = await fixture()
		const mcp = await connectMcp(ctx.app, AGENT_REVIEWER)
		try {
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'create_checkpoint')!
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['name', 'note'])
			expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
			const created = await mcp.client.callTool({ name: 'create_checkpoint', arguments: { name: 'Agent task done' } })
			expect(created.isError).not.toBe(true)
			const output = created.structuredContent as { status: string; versionId: string; at: string; resources: number; resourceUri: string }
			expect(output).toMatchObject({ status: 'created', resources: 3, resourceUri: versionResourceUri(output.versionId) })
			expect(await readCheckpointFile(ctx, output.versionId)).toMatchObject({ actor: actorOf(AGENT_REVIEWER), source: 'mcp' })
			expect(await readCheckpointFile(ctx, output.versionId)).not.toHaveProperty('note')
			// The schema is closed: no caller-supplied actor or time (Rule 01a11a5e-025f-71d7-8d08-63948220de57).
			const spoofed = await mcp.client.callTool({ name: 'create_checkpoint', arguments: { name: 'x', actor: { type: 'human', id: 'member:someone' } } })
			expect(spoofed.isError).toBe(true)
		}
		finally {
			await mcp.close()
		}
	})

	it('closes the open autosave first and records an outside change as an external version before the Checkpoint (Rules 01a11a5e-00b9 and 0313)', async () => {
		const ctx = await fixture()
		await editView(ctx, OWNER, 'edited in the Workbench')
		const autosave = ctx.recorder.openAutosaveId
		expect(autosave).toBeDefined()
		const edited = await externalLocaleEdit(ctx, 'Changed in a text editor')
		const checkpoint = await createCheckpoint(ctx, REVIEWER, 'After the review')
		expect(ctx.recorder.openAutosaveId).toBeUndefined()

		const stores = (await ctx.history.open())!
		const versions = (await readMergedTimeline(ctx.persistence, stores)).versions.map(entry => entry.version)
		expect(versions.map(version => [version.type, version.id === checkpoint])).toEqual([
			['checkpoint', false],
			['autosave', false],
			['external', false],
			['checkpoint', true],
		])
		expect(versions[1]!.id).toBe(autosave)
		expect(versions[2]!.actor).toEqual({ type: 'external' })
		expect(versions[2]!.resources.find(resource => resource.kind === 'locale')!.revision).toBe(edited)
		expect(versions[3]!.resources.find(resource => resource.kind === 'locale')!.revision).toBe(edited)
		// A later write opens a new autosave after the Checkpoint.
		await editView(ctx, OWNER, 'after the checkpoint')
		await ctx.recorder.stop()
		const after = (await readMergedTimeline(ctx.persistence, stores)).versions.map(entry => entry.version)
		expect(after.map(version => version.type)).toEqual(['checkpoint', 'autosave', 'external', 'checkpoint', 'autosave'])
	})

	it('validates the name and the note in code points, stores the name trimmed, and writes nothing when refused (Clause 01a11a5e-2272-795d-8806-1dedf74f7e21)', async () => {
		const ctx = await fixture()
		const session = scoped(ctx.app, REVIEWER)
		const files = await checkpointFiles(ctx)
		expect(await session.createCheckpoint({ name: '   ' })).toMatchObject({ status: 'invalid', code: 'history.invalid_checkpoint_name' })
		expect(await session.createCheckpoint({ name: 'x'.repeat(121) })).toMatchObject({ status: 'invalid', code: 'history.invalid_checkpoint_name' })
		expect(await session.createCheckpoint({ name: 'ok', note: 'n'.repeat(2001) })).toMatchObject({ status: 'invalid', code: 'history.invalid_checkpoint_note' })
		expect(await checkpointFiles(ctx)).toEqual(files)
		const http = await createCheckpointForHttp(session, { name: '' })
		expect(http).toMatchObject({ status: 400, body: { code: 'history.invalid_checkpoint_name' } })
		expect((await createCheckpointForHttp(session, { name: 'x', extra: true })).status).toBe(400)
		expect((await createCheckpointForHttp(session, { note: 'no name' })).status).toBe(400)

		// 120 emoji are 120 code points (240 UTF-16 code units); a 2,000 code point note fits.
		const emoji = '🎨'.repeat(120)
		const id = await createCheckpoint(ctx, REVIEWER, ` ${emoji} `, '🎨'.repeat(2000))
		expect(await readCheckpointFile(ctx, id)).toMatchObject({ name: emoji, note: '🎨'.repeat(2000) })
		expect(await session.createCheckpoint({ name: 'x'.repeat(120) })).toMatchObject({ status: 'created' })
		// Names need not be unique (Rule 01a11a5e-0919-73d1-9082-cd17a275da0c).
		const again = await createCheckpoint(ctx, REVIEWER, emoji)
		expect(again).not.toBe(id)
	})

	it('is refused while migration is required or the schema is unsupported, while listing still works (Rules 01a11a5e-0a5e and 07c1)', async () => {
		const ctx = await fixture()
		const manifestPath = join(ctx.root, workspaceRelativePath())
		const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
		const files = await checkpointFiles(ctx)
		for (const [schemaVersion, code] of [[CURRENT_WORKSPACE_SCHEMA_VERSION - 1, 'workspace.migration_required'], [99, 'workspace.schema_unsupported']] as const) {
			await writeFile(manifestPath, `${JSON.stringify({ ...manifest, schemaVersion })}\n`)
			const http = await createCheckpointForHttp(scoped(ctx.app, REVIEWER), { name: 'Blocked' })
			expect(http).toMatchObject({ status: 422, body: { status: 'blocked', code } })
			const mcp = await connectMcp(ctx.app, AGENT_REVIEWER)
			try {
				const viaMcp = await mcp.client.callTool({ name: 'create_checkpoint', arguments: { name: 'Blocked' } })
				expect(viaMcp.isError).toBe(true)
				expect(viaMcp.structuredContent).toMatchObject({ status: 'blocked', code })
				const list = await mcp.client.callTool({ name: 'list_versions', arguments: {} })
				expect(list.isError).not.toBe(true)
				expect((list.structuredContent as VersionListing).versions.map(version => version.id)).toEqual([ctx.baseline])
			}
			finally {
				await mcp.close()
			}
			expect(listed((await listVersionsForHttp(scoped(ctx.app, VIEWER), {})).body).versions.map(version => version.id)).toEqual([ctx.baseline])
			expect(await checkpointFiles(ctx)).toEqual(files)
		}
	})

	it('refuses, writing nothing, when the open autosave cannot be closed first', async () => {
		const failing: CheckpointBoundary = {
			closeOpenAutosaveUnlocked: async () => { throw new Error('a history recorder operation did not finish within 5000 ms and was abandoned') },
			nextVersionAt: () => new Date().toISOString(),
		}
		const ctx = await fixture({ boundary: failing })
		const files = await checkpointFiles(ctx)
		const http = await createCheckpointForHttp(scoped(ctx.app, REVIEWER), { name: 'Not now' })
		expect(http).toMatchObject({ status: 503, headers: { 'Retry-After': '1' }, body: { status: 'unavailable', code: 'history.boundary_failed', retryable: true } })
		expect(await checkpointFiles(ctx)).toEqual(files)
	})

	it('cannot be created where history is off (the internal uiux publish server)', async () => {
		const ctx = await fixture()
		const publishing = createHistoryStoreFactory({ workspaceRoot: ctx.root, persistence: ctx.persistence, home: () => '/nonexistent', publishCredential: 'x' })
		const app = createWorkspaceApplicationSession(ctx.persistence, { history: publishing })
		expect(await app.createCheckpoint({ name: 'x', actor: actorOf(OWNER), source: 'workbench' })).toMatchObject({ status: 'failed', code: 'history.unavailable' })
		expect(await app.listVersions({})).toEqual({ status: 'listed', versions: [] })
	})
})

describe('Checkpoints are immutable and deleted record-only', () => {
	it('offers no update anywhere and deletes only the record, leaving its blobs (Rules 01a11a5e-09bb and 0c1f)', async () => {
		const ctx = await fixture()
		const id = await createCheckpoint(ctx, REVIEWER, 'Keep me?')
		const record = await readCheckpointFile(ctx, id)
		// No session or service method, HTTP route or MCP tool changes a Checkpoint.
		const session = scoped(ctx.app, OWNER) as unknown as Record<string, unknown>
		expect(Object.keys(session).filter(name => /checkpoint/iu.test(name)).sort()).toEqual(['createCheckpoint', 'deleteCheckpoint'])
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			expect((await mcp.client.listTools()).tools.map(tool => tool.name).filter(name => /checkpoint|version/u.test(name)).sort()).toEqual(['create_checkpoint', 'get_version_diff', 'list_versions'])
		}
		finally {
			await mcp.close()
		}

		// An autosave is not deletable.
		await editView(ctx, OWNER, 'autosaved')
		await ctx.recorder.closeOpenAutosave('checkpoint')
		const autosave = listed(await ctx.app.listVersions({ types: ['autosave'] })).versions[0]!.id
		expect(await scoped(ctx.app, OWNER).deleteCheckpoint(autosave)).toMatchObject({ status: 'blocked', code: 'history.not_checkpoint' })

		const deleted = await deleteCheckpointForHttp(scoped(ctx.app, OWNER), id)
		expect(deleted).toEqual({ status: 200, body: { status: 'deleted', versionId: id } })
		expect(await checkpointFiles(ctx)).toEqual([`${ctx.baseline}.json`])
		for (const digest of record.resources.flatMap(resource => Object.values(resource.files)))
			expect(await ctx.persistence.artifacts.read(digest)).toBeInstanceOf(Uint8Array)
		expect(await deleteCheckpointForHttp(scoped(ctx.app, OWNER), id)).toMatchObject({ status: 404, body: { code: 'history.record_missing' } })
		expect(await readVersionForHttp(scoped(ctx.app, VIEWER), id)).toMatchObject({ status: 404, body: { code: 'history.record_missing' } })
		expect(await deleteCheckpointForHttp(scoped(ctx.app, OWNER), 'not-a-uuid')).toMatchObject({ status: 404 })
	})
})

describe('the version listing', () => {
	/** Baseline B, autosave A1 (Owner), external E1, Checkpoint C2, autosave A2 (Agent). */
	async function timeline() {
		const ctx = await fixture()
		await editView(ctx, OWNER, 'owner edit')
		await externalLocaleEdit(ctx, 'Edited outside')
		const c2 = await createCheckpoint(ctx, REVIEWER, 'Reviewed')
		await editView(ctx, AGENT, 'agent edit')
		await ctx.recorder.closeOpenAutosave('checkpoint')
		const all = listed(await ctx.app.listVersions({})).versions
		expect(all.map(version => version.type)).toEqual(['autosave', 'checkpoint', 'external', 'autosave', 'checkpoint'])
		const [a2, , e1, a1, b] = all
		expect(all[1]!.id).toBe(c2)
		return { ctx, b: b!, a1: a1!, e1: e1!, c2: all[1]!, a2: a2!, all }
	}

	const ids = (versions: readonly VersionListItem[]) => versions.map(version => version.id)

	it('gives every row its merged-timeline parent, unchanged by filters (owner ruling 2026-10-09, comparison 1)', async () => {
		const { ctx, b, a1, e1, c2, a2, all } = await timeline()
		expect(all.map(version => version.parent)).toEqual([c2.id, e1.id, a1.id, b.id, null])
		expect(b).toMatchObject({ type: 'checkpoint', name: 'Baseline', actor: { type: 'system', id: 'system:baseline' } })
		expect(b.summary.map(row => `${row.kind}:${row.status}`)).toEqual(['locale:added', 'view:added', 'workspace:added'])
		expect(a1).toMatchObject({ actor: actorOf(OWNER), netChange: true, summary: [{ kind: 'view', key: VIEW_ID, status: 'modified' }] })
		expect(e1).toMatchObject({ actor: { type: 'external' }, summary: [{ kind: 'locale', key: 'en-US', status: 'modified' }] })
		expect(c2).toMatchObject({ name: 'Reviewed', summary: [] })
		expect(c2).not.toHaveProperty('netChange')

		const checkpoints = listed(await ctx.app.listVersions({ types: ['checkpoint'] })).versions
		expect(checkpoints.map(version => [version.id, version.parent])).toEqual([[c2.id, e1.id], [b.id, null]])
		const autosaves = listed(await ctx.app.listVersions({ types: ['autosave', 'external'] })).versions
		expect(autosaves.map(version => [version.id, version.parent])).toEqual([[a2.id, c2.id], [e1.id, a1.id], [a1.id, b.id]])
		expect(ids(listed(await ctx.app.listVersions({ actor: `member:${OWNER.memberId}` })).versions)).toEqual([a1.id])
		expect(ids(listed(await ctx.app.listVersions({ actor: 'external' })).versions)).toEqual([e1.id])
		expect(ids(listed(await ctx.app.listVersions({ actor: 'system:baseline' })).versions)).toEqual([b.id])

		// The parent is what the Workbench compares with: get_version_diff from the row's parent gives the same answer.
		const viaParent = await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: 'parent', to: c2.id })
		const viaRow = await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: checkpoints[0]!.parent!, to: c2.id })
		expect(viaRow.body).toEqual(viaParent.body)
	})

	it('projects one resource\'s history from the merged timeline (Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28)', async () => {
		const { ctx, b, a1, e1, c2, a2 } = await timeline()
		const view = listed(await ctx.app.listVersions({ resource: { kind: 'view', key: VIEW_ID } })).versions
		expect(view.map(version => [version.id, version.parent])).toEqual([[a2.id, c2.id], [a1.id, b.id], [b.id, null]])
		const locale = listed(await ctx.app.listVersions({ resource: { kind: 'locale', key: 'en-US' } })).versions
		expect(ids(locale)).toEqual([e1.id, b.id])
		expect(ids(listed(await ctx.app.listVersions({ resource: { kind: 'view', key: VIEW_ID }, types: ['checkpoint'] })).versions)).toEqual([b.id])
		expect(listed(await ctx.app.listVersions({ resource: { kind: 'flow', key: randomUUID() } })).versions).toEqual([])
	})

	it('pages with a stable cursor and validates the request', async () => {
		const { ctx, all } = await timeline()
		const first = listed(await ctx.app.listVersions({ limit: 2 }))
		expect(ids(first.versions)).toEqual(ids(all.slice(0, 2)))
		const second = listed(await ctx.app.listVersions({ limit: 2, cursor: first.nextCursor! }))
		expect(ids(second.versions)).toEqual(ids(all.slice(2, 4)))
		const last = listed(await ctx.app.listVersions({ limit: 2, cursor: second.nextCursor! }))
		expect(ids(last.versions)).toEqual(ids(all.slice(4)))
		expect(last.nextCursor).toBeUndefined()
		expect(await ctx.app.listVersions({ cursor: 'nope' })).toMatchObject({ status: 'invalid', code: 'history.invalid_cursor' })
		expect(await ctx.app.listVersions({ types: ['draft' as never] })).toMatchObject({ status: 'invalid', code: 'history.invalid_listing' })
		expect(await ctx.app.listVersions({ limit: 0 })).toMatchObject({ status: 'invalid', code: 'history.invalid_listing' })
		expect(await ctx.app.listVersions({ limit: 201 })).toMatchObject({ status: 'invalid' })

		const session = scoped(ctx.app, VIEWER)
		const http = await listVersionsForHttp(session, { type: ['autosave', 'external'], resource: 'locale:en-US', limit: '5' })
		expect(http.status).toBe(200)
		expect(http.body).toEqual(await ctx.app.listVersions({ types: ['autosave', 'external'], resource: { kind: 'locale', key: 'en-US' }, limit: 5 }))
		expect((await listVersionsForHttp(session, { resource: 'view' })).status).toBe(400)
		expect((await listVersionsForHttp(session, { limit: 'ten' })).status).toBe(400)
		expect((await listVersionsForHttp(session, { other: '1' })).status).toBe(400)
		expect((await listVersionsForHttp(session, { cursor: 'nope' })).status).toBe(400)
	})

	it('answers the same over MCP, with each version also a read-only Resource (Clauses 01a11a5e-26b9 and 27c1)', async () => {
		const { ctx, a2, c2 } = await timeline()
		const http = listed((await listVersionsForHttp(scoped(ctx.app, VIEWER), { type: 'checkpoint' })).body)
		const mcp = await connectMcp(ctx.app, testMember({ nickname: 'watcher', kind: 'agent', role: 'viewer', credential: 'token' }))
		try {
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'list_versions')!
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['cursor', 'limit', 'resource', 'types'])
			expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
			const viaMcp = await mcp.client.callTool({ name: 'list_versions', arguments: { types: ['checkpoint'] } })
			expect(viaMcp.isError).not.toBe(true)
			expect(viaMcp.structuredContent).toEqual({ ...http, versions: http.versions.map(version => ({ ...version, resourceUri: versionResourceUri(version.id) })) })
			expect((await mcp.client.callTool({ name: 'list_versions', arguments: { actor: 'external' } })).isError).toBe(true)

			const read = await mcp.client.readResource({ uri: versionResourceUri(a2.id) })
			const content = read.contents[0]!
			const body = JSON.parse('text' in content ? content.text : '') as { status: string; version: HostVersionRecord; parent: string }
			expect(body).toEqual((await readVersionForHttp(scoped(ctx.app, VIEWER), a2.id)).body)
			expect(body).toMatchObject({ status: 'found', parent: c2.id, version: { id: a2.id, type: 'autosave', actor: actorOf(AGENT) } })
			expect(body.version.events.map(event => [event.operation, event.source])).toEqual([['updateViewSpec', 'mcp']])
			expect(Object.values(body.version.resources[0]!.files)[0]).toMatch(/^sha256:/u)
			await expect(mcp.client.readResource({ uri: versionResourceUri(randomUUID()) })).rejects.toThrow()
		}
		finally {
			await mcp.close()
		}
	})
})

describe('access to history (Clauses 01a11485-fa00, fa21, fa66 and f978)', () => {
	it('lets a Viewer list and read, a Reviewer create, and only a human Owner in a Workbench session delete', async () => {
		const ctx = await fixture()
		const viewer = scoped(ctx.app, VIEWER)
		expect(listed(await viewer.listVersions({})).versions).toHaveLength(1)
		expect(await viewer.readVersion(ctx.baseline)).toMatchObject({ status: 'found', parent: null })
		expect(await viewer.createCheckpoint({ name: 'Nope' })).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'reviewer' })
		const created = await createCheckpoint(ctx, REVIEWER, 'By a Reviewer')
		await createCheckpoint(ctx, AGENT_REVIEWER, 'By an Agent')

		for (const principal of [VIEWER, REVIEWER, EDITOR, OWNER_TOKEN, AGENT, AGENT_OWNER]) {
			const refused = await deleteCheckpointForHttp(scoped(ctx.app, principal), created)
			expect(refused, principal.nickname).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredRole: 'owner' } })
		}
		expect(await checkpointFiles(ctx)).toContain(`${created}.json`)
		expect(await deleteCheckpointForHttp(scoped(ctx.app, OWNER), created)).toMatchObject({ status: 200, body: { status: 'deleted' } })
	})

	it('needs no Checkpoint before release_lock and tells Agents the recommendation verbatim (Clause 01a11a5e-2821, Rule 01a11a5e-1ca3)', async () => {
		const ctx = await fixture()
		expect(CHECKPOINT_RECOMMENDATION).toBe(VERBATIM_INSTRUCTION)
		const mcp = await connectMcp(ctx.app, AGENT, { history: ctx.recorder })
		try {
			expect(mcp.client.getInstructions()).toContain(VERBATIM_INSTRUCTION)
			const written = await mcp.client.callTool({ name: 'update_view_spec', arguments: { viewId: VIEW_ID, expectedRevision: (await ctx.persistence.views.readRevision(VIEW_ID))!, spec: spec('agent task') } })
			expect(written.isError).not.toBe(true)
			const released = await mcp.client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.isError).not.toBe(true)
			expect(released.structuredContent).toMatchObject({ status: 'released' })
		}
		finally {
			await mcp.close()
		}
		// release_lock closed the autosave and created no Checkpoint.
		expect(listed(await ctx.app.listVersions({})).versions.map(version => version.type)).toEqual(['autosave', 'checkpoint'])
	})
})

describe('/api/history/* over HTTP', () => {
	let root: string
	let server: Server
	let origin: string
	const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

	beforeAll(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-api-')))
		process.env.UIUX_WORKSPACE_ROOT = root
		const app = createApp()
		app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
		const router = createRouter()
		router.post('/api/session/login', loginRoute)
		router.get('/api/history/diff', diffRoute)
		router.get('/api/history/versions', listVersionsRoute)
		router.get('/api/history/versions/:id', readVersionRoute)
		router.post('/api/history/checkpoints', createCheckpointRoute)
		router.delete('/api/history/checkpoints/:id', deleteCheckpointRoute)
		app.use(router)
		server = createServer(toNodeListener(app))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		process.env.UIUX_SERVER_ORIGIN = origin
		const runtime = getSelectedWorkspaceServerRuntime()
		await runtime.persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		await runtime.persistence.locales.create('en-US', { greeting: 'Hello' })
		expect(await runtime.historyRecorder.start()).toMatchObject({ enabled: true, baseline: expect.any(String) })
	})

	afterAll(async () => {
		await new Promise<void>(resolve => server.close(() => resolve()))
		await closeSelectedWorkspaceServerRuntime()
		for (const [name, value] of [['UIUX_WORKSPACE_ROOT', previous.root], ['UIUX_SERVER_ORIGIN', previous.origin]] as const) {
			if (value === undefined) delete process.env[name]
			else process.env[name] = value
		}
		await rm(root, { recursive: true, force: true })
	})

	const json = { 'content-type': 'application/json' }

	it('serves the access matrix and refuses the system credential on every /api/history/* route', async () => {
		const viewer = await provisionToken(root, { nickname: 'vera', kind: 'human', role: 'viewer' })
		const reviewer = await provisionToken(root, { nickname: 'rui', kind: 'human', role: 'reviewer' })
		const owner = await provisionToken(root, { nickname: 'mei', kind: 'human', role: 'owner' })
		const agent = await provisionToken(root, { nickname: 'claude', kind: 'agent', role: 'editor' })

		const created = await fetch(`${origin}/api/history/checkpoints`, { method: 'POST', headers: { ...bearer(reviewer), ...json }, body: JSON.stringify({ name: 'Over HTTP', note: 'With a bearer Token.' }) })
		expect(created.status).toBe(201)
		const { versionId } = await created.json() as { versionId: string }
		const listedResponse = await fetch(`${origin}/api/history/versions?type=checkpoint`, { headers: bearer(viewer) })
		expect(listedResponse.status).toBe(200)
		expect(listedResponse.headers.get('cache-control')).toBe('no-store')
		const listing = await listedResponse.json() as VersionListing
		expect(listing.versions.map(version => version.name)).toEqual(['Over HTTP', 'Baseline'])
		expect(listing.versions[0]).toMatchObject({ id: versionId, actor: { type: 'human', displayName: 'rui' }, parent: listing.versions[1]!.id })
		const read = await fetch(`${origin}/api/history/versions/${versionId}`, { headers: bearer(viewer) })
		expect(read.status).toBe(200)
		// A bearer-Token write over /api/* records the source workbench (Clause 01a11a5e-221b-7a04-a6cb-66bc9608c11f).
		expect(await read.json()).toMatchObject({ status: 'found', version: { id: versionId, name: 'Over HTTP', note: 'With a bearer Token.', source: 'workbench' } })

		// The system credential gets no history route, not even the reads.
		const access = await getSelectedWorkspaceServerRuntime().access()
		const system = { cookie: `${access.cookieName}=${access.captureCredential}` }
		for (const [method, path] of [['GET', '/api/history/versions'], ['GET', `/api/history/versions/${versionId}`], ['POST', '/api/history/checkpoints'], ['DELETE', `/api/history/checkpoints/${versionId}`], ['GET', `/api/history/diff?from=${versionId}`]] as const) {
			const response = await fetch(`${origin}${path}`, { method, headers: { ...system, ...json }, ...(method === 'POST' ? { body: JSON.stringify({ name: 'system' }) } : {}) })
			expect(response.status, `${method} ${path}`).toBe(403)
			expect(await response.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		}
		expect((await fetch(`${origin}/api/history/versions`)).status).toBe(401)

		// Deletion is a human Owner's Workbench session only: bearer Tokens are refused, even the Owner's.
		for (const token of [viewer, reviewer, owner, agent]) {
			const refused = await fetch(`${origin}/api/history/checkpoints/${versionId}`, { method: 'DELETE', headers: bearer(token) })
			expect(refused.status).toBe(403)
		}
		const cookie = await sessionCookieFor(origin, owner)
		const deleted = await fetch(`${origin}/api/history/checkpoints/${versionId}`, { method: 'DELETE', headers: { cookie: `${cookie.name}=${cookie.value}` } })
		expect(deleted.status).toBe(200)
		expect(await deleted.json()).toEqual({ status: 'deleted', versionId })
		expect((await fetch(`${origin}/api/history/versions/${versionId}`, { headers: bearer(viewer) })).status).toBe(404)
	})

	it('has no route that changes a Checkpoint (Rule 01a11a5e-09bb-755c-9253-3cbff9f65da9)', async () => {
		const reviewer = await provisionToken(root, { nickname: 'rui', kind: 'human', role: 'reviewer' })
		const owner = await provisionToken(root, { nickname: 'mei', kind: 'human', role: 'owner' })
		const created = await fetch(`${origin}/api/history/checkpoints`, { method: 'POST', headers: { ...bearer(reviewer), ...json }, body: JSON.stringify({ name: 'Final' }) })
		const { versionId } = await created.json() as { versionId: string }
		const path = join(root, WORKSPACE_CHECKPOINTS_DIRECTORY, `${versionId}.json`)
		const bytes = await readFile(path)
		for (const method of ['PUT', 'PATCH', 'POST'] as const) {
			const response = await fetch(`${origin}/api/history/checkpoints/${versionId}`, { method, headers: { ...bearer(owner), ...json }, body: JSON.stringify({ name: 'Renamed' }) })
			expect(response.status, method).toBeGreaterThanOrEqual(400)
		}
		expect(await readFile(path)).toEqual(bytes)
	})
})
