import { randomUUID } from 'node:crypto'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import restoreRoute from '../server/api/history/versions/[id]/restore.post'
import { createLeaseManager, type LeaseManager } from '../src/application/access/leases'
import { ACCESS_OPERATIONS, writeOperationForKind } from '../src/application/access/policy'
import type { MemberPrincipal, SystemPrincipal } from '../src/application/access/principal'
import { createScopedWorkspaceSession } from '../src/application/access/scoped-session'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { RestoreResourceVersionCommand } from '../src/application/services/history-restore'
import type { VersionListing } from '../src/application/services/history-service'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { evaluateEvidenceStaleness } from '../src/domain/evidence/staleness'
import type { HostVersionRecord } from '../src/domain/history/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { canonicalJsonBytes, FileNativePersistence, reviewRelativePath, viewRelativePath, workspaceRelativePath } from '../src/persistence'
import { versionResourcesFromSnapshot } from '../src/persistence/history'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createHistoryStoreFactory, type HistoryStoreFactory } from '../src/server/history-stores'
import { restoreResourceVersionForHttp } from '../src/server/history-http'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, connectMcp, provisionToken, scoped, testMember } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * Single-resource restore (issue #132 B6): Feature 01a11a5d-fd6b-7f9d-be15-2bc2bc3adc13 Rules 1428,
 * 147c, 14ce, 1520, 1580, 15e9, 1645, 16a2, 16f7, 174b, 17a0, 17f7, 184c, 189f, 01a11c09-c648 and
 * 01a11e0d-d911; Rules 01a11a5e-00b9 (restore) and 081c (restore); MCP Clause 01a11a5e-2768; Access
 * Clause 01a11485-fa44 (`history.restore`); Clause 01a11a5e-20c6 (`restoredFrom`); Scenarios
 * 01a11a5e-9106-73c2-b51b-107557aa88e8 and 01a11a5e-9174-7006-b506-038e979982b8.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const ASSET_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const DECISION_ID = '55555555-5555-4555-8555-555555555555'
const STEP_ID = '66666666-6666-4666-8666-666666666666'
const START = Date.parse('2026-10-09T00:00:00.000Z')
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', role: 'owner', credential: 'session' })
const EDITOR = testMember({ memberId: 'editor-1', nickname: 'eve', kind: 'human', role: 'editor', credential: 'session' })
const REVIEWER = testMember({ memberId: 'reviewer-1', nickname: 'rui', kind: 'human', role: 'reviewer', credential: 'session' })
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ memberId: 'agent-2', nickname: 'codex', kind: 'agent', role: 'editor', credential: 'token' })
const AGENT_REVIEWER = testMember({ memberId: 'agent-3', nickname: 'critic', kind: 'agent', role: 'reviewer', credential: 'token' })

const MANIFEST: WorkspaceManifest = {
	schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	i18n: { defaultLocale: 'en-US' },
	adapters: [],
	viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
	themes: { light: { label: 'Light' } },
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

function spec(intent: string): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [] }
}

function ir(...widgets: readonly Readonly<Record<string, unknown>>[]): ViewResource['ir'] {
	return { type: 'RootShell', id: 'root', slots: { content: widgets as ViewResource['ir'][] } }
}

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
	leases: LeaseManager
	baseline: string
}>

async function fixture(): Promise<Fixture> {
	const root = await tempDir('uiux-restore-ws-')
	const home = join(await tempDir('uiux-restore-home-'), 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await persistence.workspace.create(MANIFEST)
	await persistence.locales.create('en-US', { greeting: 'Hello' })
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const clock = manualClock()
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock, log: () => undefined })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
	expect((await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).status).toBe('created')
	running.push(recorder)
	const started = await recorder.start()
	expect(started).toMatchObject({ enabled: true, baseline: expect.any(String) })
	return { root, persistence, history, recorder, clock, app, leases: createLeaseManager(), baseline: started.baseline! }
}

function session(ctx: Fixture, principal: MemberPrincipal, leases: LeaseManager = ctx.leases) {
	return scoped(ctx.app, principal, { leases, history: ctx.recorder, transport: principal.kind === 'agent' ? 'mcp' : 'http' })
}

async function viewRevision(ctx: Fixture): Promise<string> {
	return (await ctx.persistence.views.readRevision(VIEW_ID))!
}

async function setStructure(ctx: Fixture, principal: MemberPrincipal, structure: ViewResource['ir']): Promise<string> {
	ctx.clock.advance(1_000)
	const result = await session(ctx, principal).updateViewStructure({ key: VIEW_ID, expectedRevision: await viewRevision(ctx), ir: structure, variants: {} })
	expect(result.status, JSON.stringify(result)).toBe('updated')
	return (result as { revision: string }).revision
}

async function setIntent(ctx: Fixture, principal: MemberPrincipal, intent: string): Promise<string> {
	ctx.clock.advance(1_000)
	const result = await session(ctx, principal).updateViewSpec({ key: VIEW_ID, expectedRevision: await viewRevision(ctx), spec: spec(intent) })
	expect(result.status, JSON.stringify(result)).toBe('updated')
	return (result as { revision: string }).revision
}

async function checkpoint(ctx: Fixture, name: string): Promise<string> {
	ctx.clock.advance(1_000)
	const outcome = await scoped(ctx.app, OWNER).createCheckpoint({ name })
	expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'created' })
	return (outcome as { versionId: string }).versionId
}

async function restore(ctx: Fixture, principal: MemberPrincipal, command: RestoreResourceVersionCommand, leases?: LeaseManager) {
	ctx.clock.advance(1_000)
	return session(ctx, principal, leases).restoreResourceVersion(command)
}

/** A Decision gained after the earlier version, written as the Workbench promotion would leave it. */
async function addDecidedDecision(ctx: Fixture): Promise<void> {
	const current = (await ctx.persistence.views.read(VIEW_ID))!
	const decision = { id: DECISION_ID, question: 'Show the total before tax?', status: 'decided' as const, outcome: { summary: 'Yes', rationale: 'Users asked for it.' }, history: [] }
	const next: ViewResource = { ...current.resource, spec: { ...current.resource.spec, decisions: [decision] } }
	const commit = await ctx.persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: current.revision, resource: next })
	expect(commit.ok).toBe(true)
}

async function reviewBytes(ctx: Fixture): Promise<string> {
	return readFile(join(ctx.root, reviewRelativePath(REVIEW_ID)), 'utf8')
}

function listed(outcome: unknown): VersionListing {
	expect((outcome as { status: string }).status, JSON.stringify(outcome)).toBe('listed')
	return outcome as VersionListing
}

async function hostVersion(ctx: Fixture, id: string): Promise<HostVersionRecord> {
	const read = await ctx.app.readVersion(id)
	if (read.status !== 'found' || read.version.type === 'checkpoint') throw new Error(JSON.stringify(read))
	return read.version
}

describe('restoring a View (Scenario 01a11a5e-9106-73c2-b51b-107557aa88e8)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('replaces its IR, Variants, name and non-Decision Spec, keeps its current Decisions, and records a version of its own naming the source', async () => {
		const ctx = await fixture()
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay', config: { label: 'Pay' } }))
		const earlier = await checkpoint(ctx, 'Before redesign')
		const earlierView = (await ctx.persistence.views.read(VIEW_ID))!.resource
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay', config: { label: 'Pay now' } }, { type: 'Text', id: 'note' }))
		await setIntent(ctx, EDITOR, 'Pay quickly')
		await addDecidedDecision(ctx)
		const before = (await ctx.persistence.views.read(VIEW_ID))!

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: before.revision })
		expect(outcome, JSON.stringify(outcome)).toMatchObject({ status: 'updated', kind: 'view', key: VIEW_ID, restoredFrom: earlier, impacts: [] })
		const after = (await ctx.persistence.views.read(VIEW_ID))!
		expect((outcome as { revision: string }).revision).toBe(after.revision)
		expect(after.resource.ir).toEqual(earlierView.ir)
		expect(after.resource.variants).toEqual(earlierView.variants)
		expect(after.resource.name).toBe(earlierView.name)
		expect(after.resource.spec.intent).toBe('Pay')
		expect(after.resource.spec.decisions).toEqual(before.resource.spec.decisions)
		expect(after.resource.spec.decisions.map(decision => decision.id)).toEqual([DECISION_ID])

		// Rule 01a11a5e-1428-…: history is never rewritten; the restore is a new version naming its source.
		const rows = listed(await ctx.app.listVersions({})).versions
		expect(rows.some(row => row.id === earlier)).toBe(true)
		const restored = rows[0]!
		expect(restored).toMatchObject({ type: 'autosave', restoredFrom: earlier, actor: { type: 'human', id: 'member:editor-1' } })
		const record = await hostVersion(ctx, restored.id)
		expect(record.events.map(event => [event.operation, event.source, event.beforeRevision, event.afterRevision])).toEqual([['restoreResourceVersion', 'workbench', before.revision, after.revision]])
	})

	it('closes the open autosave before the restore and right after it (Rules 01a11a5e-00b9 and 01a11e0d-d911)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		await setIntent(ctx, AGENT, 'Agent edit one')
		const current = await viewRevision(ctx)
		const outcome = await restore(ctx, AGENT, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current })
		expect(outcome.status).toBe('updated')
		await setIntent(ctx, AGENT, 'Agent edit two')
		await ctx.recorder.closeOpenAutosave('shutdown')

		const rows = listed(await ctx.app.listVersions({ types: ['autosave'] })).versions
		const operations = await Promise.all(rows.map(async row => (await hostVersion(ctx, row.id)).events.map(event => event.operation)))
		// Newest first: the edit after, the restore alone, the edit before.
		expect(operations).toEqual([['updateViewSpec'], ['restoreResourceVersion'], ['updateViewSpec']])
		expect(rows.map(row => row.restoredFrom ?? null)).toEqual([null, earlier, null])
	})

	it('re-creates a View that no longer exists with its identity, with expectedRevision null (Rule 01a11a5e-16a2)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'With the View')
		const original = await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))
		await rm(join(ctx.root, viewRelativePath(VIEW_ID)))

		const stale = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: 'r_gone' })
		expect(stale).toEqual({ status: 'conflict', kind: 'view', key: VIEW_ID, currentRevision: null })
		const created = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: null })
		expect(created).toMatchObject({ status: 'created', kind: 'view', key: VIEW_ID, restoredFrom: earlier })
		expect(await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))).toEqual(original)

		// null means "must not exist": once it exists again, null conflicts.
		const again = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: null })
		expect(again).toEqual({ status: 'conflict', kind: 'view', key: VIEW_ID, currentRevision: await viewRevision(ctx) })
	})

	it('takes the version\'s Decisions only when it re-creates the View; an existing View without Decisions keeps none (owner ruling 1 of discussioncomment-18837266)', async () => {
		const ctx = await fixture()
		await addDecidedDecision(ctx)
		const withDecision = await checkpoint(ctx, 'With a Decision')
		const path = join(ctx.root, viewRelativePath(VIEW_ID))
		const file = JSON.parse(await readFile(path, 'utf8')) as { spec: Record<string, unknown> }
		const { decisions: _decisions, ...specWithout } = file.spec
		void _decisions
		// A hand edit dropped the Decisions member: the View exists, so it keeps none.
		await writeFile(path, `${JSON.stringify({ ...file, spec: specWithout })}\n`)
		const kept = await restore(ctx, EDITOR, { versionId: withDecision, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })
		expect(kept, JSON.stringify(kept)).toMatchObject({ status: 'updated' })
		expect((await ctx.persistence.views.read(VIEW_ID))!.resource.spec.decisions).toEqual([])

		await rm(path)
		const recreated = await restore(ctx, EDITOR, { versionId: withDecision, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: null })
		expect(recreated).toMatchObject({ status: 'created' })
		expect((await ctx.persistence.views.read(VIEW_ID))!.resource.spec.decisions.map(decision => decision.id)).toEqual([DECISION_ID])
	})

	it('refuses, as blocked with diagnostics, to replace a current file that is not readable JSON', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Readable')
		const path = join(ctx.root, viewRelativePath(VIEW_ID))
		await writeFile(path, '{ "id": "not closed"\n')
		const current = await viewRevision(ctx)

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current })
		expect(outcome).toMatchObject({ status: 'blocked', kind: 'view', key: VIEW_ID, code: 'persistence.invalid_json', diagnostics: [expect.objectContaining({ code: 'persistence.invalid_json' })] })
		const http = await restoreResourceVersionForHttp(scoped(ctx.app, EDITOR), earlier, { resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current })
		expect(http.status).toBe(422)
		expect(await readFile(path, 'utf8')).toBe('{ "id": "not closed"\n')
	})
})

describe('restoring every other kind', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('restores a UX Flow', async () => {
		const ctx = await fixture()
		const step = { target: { viewId: VIEW_ID }, transitions: [] }
		const created = await session(ctx, EDITOR).createFlow({ id: FLOW_ID, name: 'Checkout flow', entryStepId: STEP_ID, steps: { [STEP_ID]: step } })
		expect(created.status).toBe('created')
		const earlier = await checkpoint(ctx, 'Flow v1')
		const renamed = await session(ctx, EDITOR).updateFlow({ flowId: FLOW_ID, expectedRevision: (created as { revision: string }).revision, name: 'Renamed flow', entryStepId: STEP_ID, steps: { [STEP_ID]: step } })
		expect(renamed.status).toBe('updated')

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'flow', key: FLOW_ID }, expectedRevision: (renamed as { revision: string }).revision })
		expect(outcome).toMatchObject({ status: 'updated', kind: 'flow', key: FLOW_ID, revision: (created as { revision: string }).revision })
		expect((await ctx.persistence.flows.read(FLOW_ID))!.resource.name).toBe('Checkout flow')
	})

	it('restores a Locale', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Hello')
		const initial = (await ctx.persistence.locales.readRevision('en-US'))!
		const updated = await session(ctx, EDITOR).updateLocale({ locale: 'en-US', expectedRevision: initial, messages: { greeting: 'Hi', farewell: 'Bye' } })
		expect(updated.status).toBe('updated')

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'locale', key: 'en-US' }, expectedRevision: (updated as { revision: string }).revision })
		expect(outcome).toMatchObject({ status: 'updated', kind: 'locale', key: 'en-US', revision: initial })
		expect((await ctx.persistence.locales.read('en-US'))!.resource).toEqual({ greeting: 'Hello' })
	})

	it('restores an Asset, metadata and content together', async () => {
		const ctx = await fixture()
		const first = await session(ctx, EDITOR).createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: Buffer.from([...PNG, 1]).toString('base64') })
		expect(first.status).toBe('created')
		const earlier = await checkpoint(ctx, 'Logo v1')
		const replaced = await session(ctx, EDITOR).replaceAsset({ assetId: ASSET_ID, expectedRevision: (first as { revision: string }).revision, name: 'Logo 2', contentFilename: 'logo-2.png', mediaType: 'image/png', contentBase64: Buffer.from([...PNG, 2]).toString('base64') })
		expect(replaced.status).toBe('updated')

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'asset', key: ASSET_ID }, expectedRevision: (replaced as { revision: string }).revision })
		expect(outcome).toMatchObject({ status: 'updated', kind: 'asset', key: ASSET_ID, revision: (first as { revision: string }).revision, diagnostics: [] })
		// The replaced content file is gone: the directory holds exactly the restored pair.
		expect((await readdir(join(ctx.root, 'assets', ASSET_ID))).sort()).toEqual(['asset.json', 'logo.png'])
		const asset = (await ctx.persistence.assets.read(ASSET_ID))!
		expect(asset.resource.metadata).toEqual({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' })
		expect([...asset.resource.content]).toEqual([...PNG, 1])
	})

	it('restores the Workspace settings, keeping the current schemaVersion, after acknowledging a removed viewport key (Rules 01a11a5e-15e9 and 17a0)', async () => {
		const ctx = await fixture()
		// A Checkpoint recorded under the previous schema version, holding settings without the mobile viewport.
		const snapshot = await ctx.persistence.withReadLock(() => ctx.persistence.scanVersionedSnapshotUnlocked())
		snapshot.set(workspaceRelativePath(), canonicalJsonBytes({ ...MANIFEST, schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION - 1, themes: { light: { label: 'Light' }, dark: { label: 'Dark' } } }))
		const built = versionResourcesFromSnapshot(snapshot)
		const earlier = randomUUID()
		await (await ctx.history.open())!.checkpoints.create({
			historySchemaVersion: 1,
			id: earlier,
			type: 'checkpoint',
			actor: { type: 'human', id: 'member:owner-1', displayName: 'mei' },
			at: new Date(START + 500).toISOString(),
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION - 1,
			resources: built.resources,
			name: 'Older settings',
			source: 'workbench',
		}, built.blobs)

		const current = (await ctx.persistence.workspace.readInspected()).revision!
		const added = await session(ctx, EDITOR).updateWorkspaceSettings({ expectedRevision: current, settings: { ...MANIFEST, viewports: { ...MANIFEST.viewports, mobile: { dimensions: { width: 390, height: 844 } } } } })
		expect(added.status).toBe('updated')
		const review = await session(ctx, REVIEWER).createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, renderContext: { viewportId: 'mobile' } })
		expect(review.status, JSON.stringify(review)).toBe('created')
		const revision = (added as { revision: string }).revision

		const refused = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'workspace', key: 'workspace' }, expectedRevision: revision })
		expect(refused).toEqual({
			status: 'impact_acknowledgement_required',
			kind: 'workspace',
			key: 'workspace',
			impacts: [{ category: 'render_key_removed', dimension: 'viewport', key: 'mobile', reviewIds: [REVIEW_ID] }],
		})
		expect((await ctx.persistence.workspace.readInspected()).revision).toBe(revision)

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'workspace', key: 'workspace' }, expectedRevision: revision, acknowledgeImpact: true })
		expect(outcome).toMatchObject({ status: 'updated', kind: 'workspace', key: 'workspace', impacts: [{ category: 'render_key_removed', key: 'mobile' }] })
		const manifest = (await ctx.persistence.workspace.readInspected()).resource!
		expect(manifest.schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
		expect(Object.keys(manifest.viewports)).toEqual(['desktop'])
		expect(Object.keys(manifest.themes).sort()).toEqual(['dark', 'light'])
	})
})

describe('impact acknowledgement (Scenario 01a11a5e-9174-7006-b506-038e979982b8)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('writes nothing and lists the thread whose anchor would become invalid, then writes once acknowledged', async () => {
		const ctx = await fixture()
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay' }))
		const earlier = await checkpoint(ctx, 'Without the note')
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay' }, { type: 'Text', id: 'note' }))
		const review = await session(ctx, REVIEWER).createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'note' } })
		expect(review.status).toBe('created')
		const current = await viewRevision(ctx)
		const fileBefore = await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))

		const refused = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current })
		expect(refused).toEqual({
			status: 'impact_acknowledgement_required',
			kind: 'view',
			key: VIEW_ID,
			impacts: [{ category: 'review_anchor_invalidated', reviewId: REVIEW_ID, reviewStatus: 'open', anchor: { viewId: VIEW_ID, widgetId: 'note' } }],
		})
		expect(await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))).toEqual(fileBefore)
		expect(listed(await ctx.app.listVersions({})).versions.some(row => row.restoredFrom !== undefined)).toBe(false)

		const reviewBefore = await reviewBytes(ctx)
		const written = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current, acknowledgeImpact: true })
		expect(written).toMatchObject({ status: 'updated', impacts: [{ category: 'review_anchor_invalidated', reviewId: REVIEW_ID }] })
		// Rules 01a11a5e-184c-… and 189f-…: the thread is untouched; its anchor simply no longer resolves.
		expect(await reviewBytes(ctx)).toBe(reviewBefore)

		// Restoring the later version back makes the anchor valid again, which is an impact too.
		const later = listed(await ctx.app.listVersions({ resource: { kind: 'view', key: VIEW_ID } })).versions.find(row => row.restoredFrom === undefined && row.type === 'autosave')!
		const back = await restore(ctx, EDITOR, { versionId: later.id, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })
		expect(back).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'review_anchor_revalidated', reviewId: REVIEW_ID }] })
	})
})

describe('refusals', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('conflicts on a stale expectedRevision and writes nothing (Rule 01a11a5e-1520)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		const stale = await viewRevision(ctx)
		await setIntent(ctx, EDITOR, 'Moved on')
		const current = await viewRevision(ctx)
		// The version's own revision is not the one checked: the target's current revision is.
		expect(await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: stale })).toEqual({ status: 'conflict', kind: 'view', key: VIEW_ID, currentRevision: current })
		expect(await viewRevision(ctx)).toBe(current)
	})

	it('is locked while another Agent holds the lease, and an Agent restoring takes the lease (Rule 01a11485-f020)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		await setIntent(ctx, EDITOR, 'Moved on')
		const leases = createLeaseManager()
		expect(session(ctx, OTHER_AGENT, leases).acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'acquired' })
		const locked = await restore(ctx, AGENT, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) }, leases)
		expect(locked).toMatchObject({ status: 'locked', code: 'resource.locked', lock: { kind: 'view', key: VIEW_ID, holder: { nickname: 'codex' } } })
		// A human is refused by the Agent's lease too.
		expect(await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) }, leases)).toMatchObject({ status: 'locked' })

		expect(await session(ctx, OTHER_AGENT, leases).releaseLeases({})).toMatchObject({ status: 'released' })
		const restored = await restore(ctx, AGENT, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) }, leases)
		expect(restored.status).toBe('updated')
		expect(leases.list().map(lease => [lease.holder.nickname, lease.kind, lease.key])).toEqual([['claude', 'view', VIEW_ID]])
	})

	it('refuses invalid content with diagnostics and writes nothing (Rule 01a11a5e-1580)', async () => {
		const ctx = await fixture()
		const good = await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))
		const broken = { ...(JSON.parse(good.toString('utf8')) as Record<string, unknown>), ir: { type: 'Panel', id: 'main' } }
		await writeFile(join(ctx.root, viewRelativePath(VIEW_ID)), `${JSON.stringify(broken)}\n`)
		const invalidVersion = await checkpoint(ctx, 'Hand-edited')
		await writeFile(join(ctx.root, viewRelativePath(VIEW_ID)), good)
		const current = await viewRevision(ctx)

		const outcome = await restore(ctx, EDITOR, { versionId: invalidVersion, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current })
		expect(outcome).toMatchObject({ status: 'invalid', code: 'history.restore_invalid_content', diagnostics: expect.arrayContaining([expect.objectContaining({ code: 'view.invalid_root_type' })]) })
		expect(await readFile(join(ctx.root, viewRelativePath(VIEW_ID)))).toEqual(good)
	})

	it('refuses kinds it cannot restore, Reviews included, and resources or versions that do not exist (Rule 01a11a5e-189f; seam 3)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		for (const kind of ['review', 'product-kit', 'access-presets', 'something-new']) {
			const outcome = await restore(ctx, OWNER, { versionId: earlier, resource: { kind, key: REVIEW_ID }, expectedRevision: 'r_x' })
			expect(outcome, kind).toMatchObject({ status: 'invalid', code: 'history.restore_unsupported_kind' })
		}
		expect(await restore(ctx, OWNER, { versionId: earlier, resource: { kind: 'flow', key: FLOW_ID }, expectedRevision: null })).toMatchObject({ status: 'not_found', code: 'history.resource_not_in_version' })
		expect(await restore(ctx, OWNER, { versionId: randomUUID(), resource: { kind: 'view', key: VIEW_ID }, expectedRevision: null })).toMatchObject({ status: 'not_found', code: 'history.record_missing' })
		expect(await restore(ctx, OWNER, { versionId: earlier, resource: { kind: 'view', key: 'not-a-uuid' }, expectedRevision: null })).toMatchObject({ status: 'invalid', code: 'history.invalid_restore' })
	})

	it('refuses a version recorded under an unrecognized schema version (Rule 01a11a5e-081c)', async () => {
		const ctx = await fixture()
		const snapshot = await ctx.persistence.withReadLock(() => ctx.persistence.scanVersionedSnapshotUnlocked())
		const built = versionResourcesFromSnapshot(snapshot)
		const future = randomUUID()
		await (await ctx.history.open())!.checkpoints.create({
			historySchemaVersion: 1,
			id: future,
			type: 'checkpoint',
			actor: { type: 'human', id: 'member:owner-1', displayName: 'mei' },
			at: new Date(START + 500).toISOString(),
			workspaceSchemaVersion: 99,
			resources: built.resources,
			name: 'From a newer build',
			source: 'workbench',
		}, built.blobs)
		expect(await restore(ctx, OWNER, { versionId: future, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })).toMatchObject({ status: 'blocked', code: 'workspace.schema_unsupported' })
	})

	it('is refused while the Workspace needs migration (Rule 01a1144e-4fcf)', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		const manifest = JSON.parse(await readFile(join(ctx.root, workspaceRelativePath()), 'utf8')) as Record<string, unknown>
		await writeFile(join(ctx.root, workspaceRelativePath()), `${JSON.stringify({ ...manifest, schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION - 1 })}\n`)
		expect(await restore(ctx, OWNER, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })).toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
	})
})

describe('effects on Evidence, Handoff readiness and Reviews (Rules 01a11a5e-17f7 and 184c)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function putEvidence(ctx: Fixture, revision: string): Promise<{ digest: string; record: FormalEvidenceRecord }> {
		const workspace = await ctx.persistence.workspace.readInspected()
		const locale = (await ctx.persistence.locales.readInspected('en-US'))!
		const screenshot = await ctx.persistence.artifacts.put(new TextEncoder().encode('screenshot'))
		const record: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
			coverage: { complete: true },
			provenance: {
				workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
				resources: [
					{ identity: { type: 'view', id: VIEW_ID }, revision },
					{ identity: { type: 'workspace', id: 'workspace' }, revision: workspace.revision! },
					{ identity: { type: 'locale', id: 'en-US' }, revision: locale.revision },
				],
				versions: { uiux: '0.1.0' },
			},
			artifactRefs: [screenshot.identity],
			evidenceRefs: [],
			data: {},
		}
		return { digest: (await ctx.persistence.artifacts.put(canonicalJsonBytes(record))).identity, record }
	}

	async function stale(ctx: Fixture, record: FormalEvidenceRecord): Promise<boolean> {
		const workspace = await ctx.persistence.workspace.readInspected()
		const locales = await ctx.persistence.locales.discover()
		const localeRevisions: Record<string, string> = {}
		for (const locale of locales) localeRevisions[locale] = (await ctx.persistence.locales.readRevision(locale))!
		return evaluateEvidenceStaleness(record, {
			allViews: [{ key: VIEW_ID, revision: await viewRevision(ctx) }],
			workspace: { resource: workspace.resource as never },
			discoveredLocales: locales,
			localeRevisions,
		}).isStale
	}

	async function staleViewEvidenceBlocks(ctx: Fixture): Promise<boolean> {
		const assessed = await ctx.app.assessHandoffReadiness({ roots: [{ type: 'view', viewId: VIEW_ID }] })
		if (!('readiness' in assessed) || !assessed.readiness) throw new Error(JSON.stringify(assessed))
		return assessed.readiness.blockingDiagnostics.some(item => item.code === 'handoff.stale_view_evidence')
	}

	it('makes Evidence captured at the restored revision fresh again only while every freshness Rule holds, and readiness follows', async () => {
		const ctx = await fixture()
		const captured = await viewRevision(ctx)
		const evidence = await putEvidence(ctx, captured)
		const earlier = await checkpoint(ctx, 'Captured')
		expect(await stale(ctx, evidence.record)).toBe(false)
		expect(await staleViewEvidenceBlocks(ctx)).toBe(false)

		await setIntent(ctx, EDITOR, 'Changed after capture')
		expect(await stale(ctx, evidence.record)).toBe(true)
		expect(await staleViewEvidenceBlocks(ctx)).toBe(true)

		// The View's bytes return to the captured revision: every freshness Rule holds again.
		const back = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })
		expect(back).toMatchObject({ status: 'updated', revision: captured })
		expect(await stale(ctx, evidence.record)).toBe(false)
		expect(await staleViewEvidenceBlocks(ctx)).toBe(false)

		// With the Locale changed since capture, the same restore leaves the Evidence stale.
		await setIntent(ctx, EDITOR, 'Changed again')
		const locale = await session(ctx, EDITOR).updateLocale({ locale: 'en-US', expectedRevision: (await ctx.persistence.locales.readRevision('en-US'))!, messages: { greeting: 'Hi' } })
		expect(locale.status).toBe('updated')
		const again = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })
		expect(again).toMatchObject({ status: 'updated', revision: captured })
		expect(await stale(ctx, evidence.record)).toBe(true)
		expect(await staleViewEvidenceBlocks(ctx)).toBe(true)
	})

	it('lists the formal Evidence a settings restore would make stale', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Desktop is 1280 wide')
		const current = (await ctx.persistence.workspace.readInspected()).revision!
		const widened = await session(ctx, EDITOR).updateWorkspaceSettings({ expectedRevision: current, settings: { ...MANIFEST, viewports: { desktop: { dimensions: { width: 1440, height: 900 } } } } })
		expect(widened.status).toBe('updated')
		const evidence = await putEvidence(ctx, await viewRevision(ctx))
		const record = JSON.parse(Buffer.from((await ctx.persistence.artifacts.read(evidence.digest))!).toString('utf8')) as FormalEvidenceRecord
		// Captured at the 1440 x 900 desktop preset.
		const resized: FormalEvidenceRecord = { ...record, executionContext: { ...record.executionContext, viewport: { width: 1440, height: 900 } } }
		const digest = (await ctx.persistence.artifacts.put(canonicalJsonBytes(resized))).identity

		const outcome = await restore(ctx, EDITOR, { versionId: earlier, resource: { kind: 'workspace', key: 'workspace' }, expectedRevision: (widened as { revision: string }).revision })
		expect(outcome).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'evidence_stale', evidence: digest, viewId: VIEW_ID }] })
	})
})

describe('access (Clause 01a11485-fa44, Rule 01a11c09-c648)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('needs history.restore and the kind\'s write key: a Reviewer and a system credential are refused, an Editor Agent may restore', async () => {
		expect(ACCESS_OPERATIONS.restoreResourceVersion).toEqual({ minRole: 'editor', permissionKey: 'history.restore' })
		expect(['view', 'flow', 'locale', 'asset', 'workspace'].map(writeOperationForKind)).toEqual(['updateViewStructure', 'updateFlow', 'updateLocale', 'replaceAsset', 'updateWorkspaceSettings'])
		expect(writeOperationForKind('product-kit')).toBeUndefined()

		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		await setIntent(ctx, EDITOR, 'Moved on')
		const command = async () => ({ versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: await viewRevision(ctx) })
		for (const principal of [REVIEWER, AGENT_REVIEWER]) {
			const refused = await restore(ctx, principal, await command())
			expect(refused, principal.nickname).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredRole: 'editor' })
		}
		const system: SystemPrincipal = { type: 'system', id: 'system:capture', role: 'viewer', credential: 'system' }
		const systemSession = createScopedWorkspaceSession(ctx.app, system, { transport: 'http', leases: ctx.leases })
		const unchanged = await viewRevision(ctx)
		expect(await systemSession.restoreResourceVersion(await command())).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		expect(await viewRevision(ctx)).toBe(unchanged)

		const restored = await restore(ctx, AGENT, await command())
		expect(restored.status).toBe('updated')
		expect(ctx.leases.list().map(lease => [lease.holder.nickname, lease.kind, lease.key])).toEqual([['claude', 'view', VIEW_ID]])
	})
})

describe('MCP restore_resource_version (Clause 01a11a5e-2768-76ad-b02a-e15f50f91268)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('takes the Clause\'s input and answers what HTTP answers', async () => {
		const ctx = await fixture()
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay' }))
		const earlier = await checkpoint(ctx, 'Without the note')
		await setStructure(ctx, EDITOR, ir({ type: 'Button', id: 'pay' }, { type: 'Text', id: 'note' }))
		expect((await session(ctx, REVIEWER).createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'note' } })).status).toBe('created')
		const current = await viewRevision(ctx)
		const leases = createLeaseManager()
		const mcp = await connectMcp(ctx.app, AGENT, { leases, history: ctx.recorder })
		try {
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'restore_resource_version')!
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['acknowledgeImpact', 'expectedRevision', 'resource', 'versionId'])
			expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })
			const args = { versionId: earlier, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current }

			const viaMcp = await mcp.client.callTool({ name: 'restore_resource_version', arguments: args })
			expect(viaMcp.isError).toBe(true)
			const viaHttp = await restoreResourceVersionForHttp(scoped(ctx.app, AGENT, { leases, transport: 'http' }), earlier, { resource: args.resource, expectedRevision: current })
			expect(viaHttp.status).toBe(409)
			expect(viaMcp.structuredContent).toEqual(viaHttp.body)
			expect(viaMcp.structuredContent).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'review_anchor_invalidated', reviewId: REVIEW_ID }] })

			const written = await mcp.client.callTool({ name: 'restore_resource_version', arguments: { ...args, acknowledgeImpact: true } })
			expect(written.isError).not.toBe(true)
			const { resourceUri, ...body } = written.structuredContent as Record<string, unknown>
			expect(resourceUri).toBe(`uiux://view/${VIEW_ID}`)
			expect(body).toMatchObject({ status: 'updated', kind: 'view', key: VIEW_ID, restoredFrom: earlier })

			// The same request again is now a conflict over both transports, with the same body.
			const conflictMcp = await mcp.client.callTool({ name: 'restore_resource_version', arguments: { ...args, acknowledgeImpact: true } })
			const conflictHttp = await restoreResourceVersionForHttp(scoped(ctx.app, AGENT, { leases, transport: 'http' }), earlier, { resource: args.resource, expectedRevision: current, acknowledgeImpact: true })
			expect(conflictHttp.status).toBe(409)
			expect(conflictMcp.structuredContent).toEqual(conflictHttp.body)
			expect(conflictHttp.body).toMatchObject({ status: 'conflict', currentRevision: body.revision })
		}
		finally {
			await mcp.close()
		}
		const restored = listed(await ctx.app.listVersions({})).versions.find(row => row.restoredFrom === earlier)
		expect(restored).toMatchObject({ actor: { type: 'agent', id: 'member:agent-1' } })
		expect((await hostVersion(ctx, restored!.id)).events.map(event => event.source)).toEqual(['mcp'])
	})

	it('validates the HTTP body', async () => {
		const ctx = await fixture()
		const earlier = await checkpoint(ctx, 'Start')
		const http = scoped(ctx.app, EDITOR)
		expect((await restoreResourceVersionForHttp(http, earlier, { resource: { kind: 'view', key: VIEW_ID } })).status).toBe(400)
		expect((await restoreResourceVersionForHttp(http, earlier, { resource: { kind: 'view', key: VIEW_ID }, expectedRevision: 'r', extra: 1 })).status).toBe(400)
		expect((await restoreResourceVersionForHttp(http, 'nope', { resource: { kind: 'view', key: VIEW_ID }, expectedRevision: 'r' })).status).toBe(404)
	})
})

describe('POST /api/history/versions/:id/restore', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	let root: string
	let server: Server
	let origin: string
	const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

	beforeAll(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-restore-api-')))
		process.env.UIUX_WORKSPACE_ROOT = root
		const app = createApp()
		app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
		const router = createRouter()
		router.post('/api/history/versions/:id/restore', restoreRoute)
		app.use(router)
		server = createServer(toNodeListener(app))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		process.env.UIUX_SERVER_ORIGIN = origin
		const runtime = getSelectedWorkspaceServerRuntime()
		await runtime.persistence.workspace.create(MANIFEST)
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

	it('re-creates a removed Locale for an Editor and refuses a Reviewer and the system credential', async () => {
		const runtime = getSelectedWorkspaceServerRuntime()
		const baseline = listed(await runtime.app.listVersions({})).versions[0]!.id
		await rm(join(root, 'i18n', 'en-US.json'))
		const editor = await provisionToken(root, { nickname: 'eve', kind: 'human', role: 'editor' })
		const reviewer = await provisionToken(root, { nickname: 'rui', kind: 'human', role: 'reviewer' })
		const body = JSON.stringify({ resource: { kind: 'locale', key: 'en-US' }, expectedRevision: null })
		const json = { 'content-type': 'application/json' }
		const path = `${origin}/api/history/versions/${baseline}/restore`

		const refused = await fetch(path, { method: 'POST', headers: { ...bearer(reviewer), ...json }, body })
		expect(refused.status).toBe(403)
		const access = await runtime.access()
		const system = await fetch(path, { method: 'POST', headers: { cookie: `${access.cookieName}=${access.captureCredential}`, ...json }, body })
		expect(system.status).toBe(403)
		expect(await system.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })

		const created = await fetch(path, { method: 'POST', headers: { ...bearer(editor), ...json }, body })
		expect(created.status).toBe(201)
		expect(created.headers.get('cache-control')).toBe('no-store')
		expect(await created.json()).toMatchObject({ status: 'created', kind: 'locale', key: 'en-US', restoredFrom: baseline })
		expect((await runtime.persistence.locales.read('en-US'))!.resource).toEqual({ greeting: 'Hello' })

		const conflict = await fetch(path, { method: 'POST', headers: { ...bearer(editor), ...json }, body })
		expect(conflict.status).toBe(409)
		expect(await conflict.json()).toMatchObject({ status: 'conflict', currentRevision: expect.any(String) })
	})
})
