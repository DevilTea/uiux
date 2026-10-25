import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createLeaseManager, type LeaseManager } from '../src/application/access/leases'
import type { MemberPrincipal } from '../src/application/access/principal'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { FileNativePersistence, type CommittedResourceChange } from '../src/persistence'
import { assetMetadataRelativePath, flowRelativePath, reviewRelativePath, viewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { deleteAssetForHttp, deleteFlowForHttp, deleteViewForHttp, updateViewStructureForHttp, updateWorkspaceSettingsForHttp } from '../src/server/authoring-http'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { connectMcp, scoped, testMember } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { putEvidenceRecord } from './support/evidence-record'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * Reference-impact acknowledgement (issue #75): Rules 01a1144e-50dd-7b92-aa5e-e175e34bf424,
 * 01a1144e-50ef-7219-ae87-bb012dc85f12, 01a172ce-280b-7cec-9ca5-ec189b313ebe,
 * 01a172ce-2b4d-70dc-ab08-bd22c71fd1c7 and 01a172ce-2e97-7d83-b175-f0d15f846768; MCP Clauses
 * 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34 (`acknowledgeImpact`) and 01a172ce-ebcc-7a79-8103-ff5339409948
 * (the delete tools and routes); Access Clause 01a11485-fa44-7b6a-99f8-de4e1e8edcfc.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '12121212-1212-4121-8121-121212121212'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const ASSET_ID = '33333333-3333-4333-8333-333333333333'
const REVIEW_ID = '44444444-4444-4444-8444-444444444444'
const STEP_ID = '66666666-6666-4666-8666-666666666666'
const START = Date.parse('2026-10-25T00:00:00.000Z')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')

const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', preset: 'owner', credential: 'session' })
const VIEWER = testMember({ memberId: 'viewer-1', nickname: 'vera', kind: 'human', preset: 'viewer', credential: 'session' })
const REVIEWER = testMember({ memberId: 'reviewer-1', nickname: 'rui', kind: 'human', preset: 'reviewer', credential: 'session' })
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', preset: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ memberId: 'agent-2', nickname: 'codex', kind: 'agent', preset: 'editor', credential: 'token' })
const AGENT_REVIEWER = testMember({ memberId: 'agent-3', nickname: 'critic', kind: 'agent', preset: 'reviewer', credential: 'token' })

const MANIFEST = {
	schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	i18n: { defaultLocale: 'en-US' },
	viewports: { desktop: { dimensions: { width: 1280, height: 800 } }, mobile: { dimensions: { width: 390, height: 844 } } },
	themes: { light: { label: 'Light' }, dark: { label: 'Dark' } },
}

const cleanup: string[] = []
const running: HistoryRecorder[] = []
afterEach(async () => {
	await Promise.all(running.splice(0).map(recorder => recorder.stop()))
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

function spec(intent: string, references: ViewSpecContent['references'] = []): ViewSpecContent {
	return { intent, entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references }
}

function manualClock(): HistoryRecorderClock & Readonly<{ advance(milliseconds: number): void }> {
	let now = START
	return { now: () => now, setTimeout: () => Symbol('timer'), clearTimeout: () => undefined, advance(milliseconds) { now += milliseconds } }
}

type Fixture = Readonly<{
	root: string
	persistence: FileNativePersistence
	recorder: HistoryRecorder
	app: WorkspaceApplicationSession
	leases: LeaseManager
	commits: CommittedResourceChange[][]
}>

/**
 * A Workspace with the View under test (Variants `dark` and `compact`, a Widget `pay` and an Asset
 * binding), a second View whose Spec references it, a UX Flow whose steps target it, an Asset and a
 * Review thread anchored in it that names the Variant `dark`.
 */
async function fixture(): Promise<Fixture> {
	const parent = await realpath(await mkdtemp(join(tmpdir(), 'uiux-impact-ack-')))
	cleanup.push(parent)
	const root = join(parent, 'ws')
	await mkdir(root)
	const home = join(parent, 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, MANIFEST)
	await persistence.locales.create('en-US', {})
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock: manualClock(), log: () => undefined })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
	const leases = createLeaseManager()
	const owner = scoped(app, OWNER, { leases, history: recorder })

	expect(await owner.createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: PNG })).toMatchObject({ status: 'created' })
	const created = await owner.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })
	const structure = await owner.updateViewStructure({
		key: VIEW_ID,
		expectedRevision: (created as { revision: string }).revision,
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay', config: { icon: { $asset: ASSET_ID } } }] } },
		variants: { dark: { state: {} }, compact: { state: {} }, spare: { state: {} } },
	})
	expect(structure, JSON.stringify(structure)).toMatchObject({ status: 'updated' })
	expect(await owner.createView({ id: OTHER_VIEW_ID, name: 'Receipt', spec: spec('Receipt', [{ type: 'view', viewId: VIEW_ID, variantName: 'dark' }]) })).toMatchObject({ status: 'created' })
	const step = { target: { viewId: VIEW_ID, variantName: 'dark' }, transitions: [] }
	expect(await owner.createFlow({ id: FLOW_ID, name: 'Checkout flow', entryStepId: STEP_ID, steps: { [STEP_ID]: step } })).toMatchObject({ status: 'created' })
	expect(await scoped(app, REVIEWER, { leases }).createReviewThread({ id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'pay' }, variantNames: ['dark'], renderContext: { viewportId: 'mobile' } })).toMatchObject({ status: 'created' })

	running.push(recorder)
	await recorder.start()
	const commits: CommittedResourceChange[][] = []
	persistence.onCanonicalCommit(changes => commits.push([...changes]))
	return { root, persistence, recorder, app, leases, commits }
}

function session(ctx: Fixture, principal: MemberPrincipal = OWNER, leases: LeaseManager = ctx.leases) {
	return scoped(ctx.app, principal, { leases, history: ctx.recorder, transport: principal.kind === 'agent' ? 'mcp' : 'http' })
}

async function fileOf(ctx: Fixture, relative: string): Promise<string> {
	return readFile(join(ctx.root, relative), 'utf8')
}

async function viewRead(ctx: Fixture, key = VIEW_ID) {
	return (await ctx.persistence.views.read(key))!
}

async function exists(path: string): Promise<boolean> {
	return stat(path).then(() => true, () => false)
}

/** Everything the referencing resources hold, byte for byte. */
async function referencingBytes(ctx: Fixture) {
	return Promise.all([
		fileOf(ctx, viewRelativePath(OTHER_VIEW_ID)),
		fileOf(ctx, reviewRelativePath(REVIEW_ID)),
		fileOf(ctx, flowRelativePath(FLOW_ID)),
	])
}

function structureOf(variants: readonly string[]) {
	return {
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay', config: { icon: { $asset: ASSET_ID } } }] } },
		variants: Object.fromEntries(variants.map(name => [name, { state: {} }])),
	}
}

const VARIANT_IMPACTS = [
	{ category: 'review_variant_stale', reviewId: REVIEW_ID, reviewStatus: 'open', viewId: VIEW_ID, variantNames: ['dark'] },
	{ category: 'flow_step_target_missing', flowId: FLOW_ID, stepId: STEP_ID, viewId: VIEW_ID, missing: 'variant', variantName: 'dark' },
	{ category: 'view_reference_dangling', viewId: OTHER_VIEW_ID, targetViewId: VIEW_ID, missing: 'variant', variantName: 'dark', pointer: '/spec/references/0' },
]

describe('removing or renaming a Variant (Rule 01a172ce-2b4d-70dc-ab08-bd22c71fd1c7)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('refuses to write over MCP and HTTP with the same impact, and writes nothing', async () => {
		const ctx = await fixture()
		const before = await viewRead(ctx)
		const referencing = await referencingBytes(ctx)
		const command = { expectedRevision: before.revision, ...structureOf(['dark-mode', 'compact', 'spare']) }
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'update_view_structure', arguments: { viewId: VIEW_ID, ...command } })
			expect(mcp.isError).toBe(true)
			expect(mcp.structuredContent).toEqual({ status: 'impact_acknowledgement_required', key: VIEW_ID, impacts: VARIANT_IMPACTS })

			const http = await updateViewStructureForHttp(session(ctx, OWNER), VIEW_ID, command)
			expect(http.status).toBe(409)
			expect(http.body).toEqual(mcp.structuredContent)
		}
		finally { await close() }
		expect((await viewRead(ctx)).revision).toBe(before.revision)
		expect(await referencingBytes(ctx)).toEqual(referencing)
		// The attempt took nothing: no lease stays with the Agent.
		expect(ctx.leases.find({ kind: 'view', key: VIEW_ID })).toBeUndefined()
	})

	it('writes once acknowledged, over MCP and HTTP, and leaves what names the Variant untouched', async () => {
		const ctx = await fixture()
		const referencing = await referencingBytes(ctx)
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'update_view_structure', arguments: { viewId: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['compact', 'spare']), acknowledgeImpact: true } })
			expect(mcp.isError).not.toBe(true)
			expect(mcp.structuredContent).toMatchObject({ status: 'updated', key: VIEW_ID, impacts: VARIANT_IMPACTS })
		}
		finally { await close() }
		expect(Object.keys((await viewRead(ctx)).resource.variants)).toEqual(['compact', 'spare'])
		// Nothing cascades, rebinds or rewrites a referencing resource (Rule 01a1144e-50ef-…).
		expect(await referencingBytes(ctx)).toEqual(referencing)
		// The references now report as dangling, with their original target identity.
		const flow = await ctx.app.readPointResource('flow', FLOW_ID)
		expect(flow?.diagnostics.map(item => item.code)).toContain('flow.missing_variant')
		expect(JSON.parse(await fileOf(ctx, flowRelativePath(FLOW_ID))).steps[STEP_ID].target).toEqual({ viewId: VIEW_ID, variantName: 'dark' })

		// HTTP, with a second Variant name that something still references: compact is named by nothing.
		const again = await updateViewStructureForHttp(session(ctx, AGENT), VIEW_ID, { expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['spare']) })
		expect(again.status).toBe(200)
		expect(again.body).toMatchObject({ status: 'updated' })
		expect(again.body).not.toHaveProperty('impacts')
	})

	it('needs no acknowledgement for a Variant nothing names, or when none is removed', async () => {
		const ctx = await fixture()
		const dropped = await session(ctx, AGENT).updateViewStructure({ key: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['dark', 'compact']) } as never)
		expect(dropped, JSON.stringify(dropped)).toMatchObject({ status: 'updated' })
		expect(dropped).not.toHaveProperty('impacts')
		const renamedUnreferenced = await session(ctx, AGENT).updateViewStructure({ key: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['dark', 'tight']) } as never)
		expect(renamedUnreferenced).toMatchObject({ status: 'updated' })
		const added = await session(ctx, AGENT).updateViewStructure({ key: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['dark', 'tight', 'extra']) } as never)
		expect(added).toMatchObject({ status: 'updated' })
	})

	it('lets an Agent acknowledge like anyone else', async () => {
		const ctx = await fixture()
		const refused = await session(ctx, AGENT).updateViewStructure({ key: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['compact', 'spare']) } as never)
		expect(refused).toMatchObject({ status: 'impact_acknowledgement_required', impacts: VARIANT_IMPACTS })
		const written = await session(ctx, AGENT).updateViewStructure({ key: VIEW_ID, expectedRevision: (await viewRead(ctx)).revision, ...structureOf(['compact', 'spare']), acknowledgeImpact: true } as never)
		expect(written).toMatchObject({ status: 'updated' })
	})
})

describe('removing or renaming a viewport or theme key (Rule 01a172ce-2e97-7d83-b175-f0d15f846768)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	const withoutMobile = { ...MANIFEST, viewports: { desktop: MANIFEST.viewports.desktop, phone: MANIFEST.viewports.mobile } }
	const KEY_IMPACT = [{ category: 'render_key_removed', dimension: 'viewport', key: 'mobile', reviewIds: [REVIEW_ID] }]

	it('refuses to write over MCP and HTTP with the same impact, and writes nothing', async () => {
		const ctx = await fixture()
		const before = (await ctx.persistence.workspace.readInspected()).revision!
		const bytes = await fileOf(ctx, 'workspace.json')
		const { schemaVersion: _schemaVersion, ...settings } = withoutMobile
		void _schemaVersion
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'update_workspace_settings', arguments: { expectedRevision: before, settings: { i18n: settings.i18n, viewports: settings.viewports, themes: settings.themes } } })
			expect(mcp.isError).toBe(true)
			expect(mcp.structuredContent).toEqual({ status: 'impact_acknowledgement_required', key: 'workspace', impacts: KEY_IMPACT })
			const http = await updateWorkspaceSettingsForHttp(session(ctx, OWNER), { expectedRevision: before, settings })
			expect(http.status).toBe(409)
			expect(http.body).toEqual(mcp.structuredContent)
		}
		finally { await close() }
		expect(await fileOf(ctx, 'workspace.json')).toBe(bytes)
		expect((await ctx.persistence.workspace.readInspected()).revision).toBe(before)
	})

	it('writes once acknowledged and leaves the threads that name the key untouched', async () => {
		const ctx = await fixture()
		const referencing = await referencingBytes(ctx)
		const { schemaVersion: _schemaVersion, ...settings } = withoutMobile
		void _schemaVersion
		const http = await updateWorkspaceSettingsForHttp(session(ctx, OWNER), { expectedRevision: (await ctx.persistence.workspace.readInspected()).revision!, settings, acknowledgeImpact: true })
		expect(http.status).toBe(200)
		expect(http.body).toMatchObject({ status: 'updated', key: 'workspace', impacts: KEY_IMPACT })
		expect(Object.keys((await ctx.persistence.workspace.readInspected()).resource!.viewports)).toEqual(['desktop', 'phone'])
		expect(await referencingBytes(ctx)).toEqual(referencing)
	})

	it('gates only a write that removes a key: other settings changes proceed without acknowledgement', async () => {
		const ctx = await fixture()
		const result = await session(ctx, AGENT).updateWorkspaceSettings({
			expectedRevision: (await ctx.persistence.workspace.readInspected()).revision!,
			settings: { i18n: { defaultLocale: 'en-US' }, viewports: { ...MANIFEST.viewports, tablet: { dimensions: { width: 768, height: 1024 } }, desktop: { dimensions: { width: 1440, height: 900 } } }, themes: MANIFEST.themes },
		})
		expect(result).toMatchObject({ status: 'updated' })
		expect(result).not.toHaveProperty('impacts')
	})
})

describe('deleting a View (Rule 01a172ce-280b-7cec-9ca5-ec189b313ebe)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	const VIEW_IMPACT_CATEGORIES = ['review_anchor_invalidated', 'flow_step_target_missing', 'view_reference_dangling']

	it('refuses to delete over MCP and HTTP with the same impact, and deletes nothing', async () => {
		const ctx = await fixture()
		const before = await viewRead(ctx)
		const file = await fileOf(ctx, viewRelativePath(VIEW_ID))
		const referencing = await referencingBytes(ctx)
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'delete_view', arguments: { viewId: VIEW_ID, expectedRevision: before.revision } })
			expect(mcp.isError).toBe(true)
			const refusal = mcp.structuredContent as { status: string; key: string; impacts: readonly { category: string }[] }
			expect(refusal).toMatchObject({ status: 'impact_acknowledgement_required', key: VIEW_ID })
			expect([...new Set(refusal.impacts.map(item => item.category))]).toEqual(expect.arrayContaining(VIEW_IMPACT_CATEGORIES))
			expect(refusal.impacts).toContainEqual({ category: 'review_anchor_invalidated', reviewId: REVIEW_ID, reviewStatus: 'open', anchor: { viewId: VIEW_ID, widgetId: 'pay' } })
			expect(refusal.impacts).toContainEqual({ category: 'view_reference_dangling', viewId: OTHER_VIEW_ID, targetViewId: VIEW_ID, missing: 'view', pointer: '/spec/references/0' })

			const http = await deleteViewForHttp(session(ctx, OWNER), VIEW_ID, { expectedRevision: before.revision })
			expect(http.status).toBe(409)
			expect(http.body).toEqual(refusal)
		}
		finally { await close() }
		expect(await fileOf(ctx, viewRelativePath(VIEW_ID))).toBe(file)
		expect(await referencingBytes(ctx)).toEqual(referencing)
	})

	it('deletes once acknowledged: the View goes, nothing else is touched, and the references report as dangling', async () => {
		const ctx = await fixture()
		const referencing = await referencingBytes(ctx)
		const before = await viewRead(ctx)
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'delete_view', arguments: { viewId: VIEW_ID, expectedRevision: before.revision, acknowledgeImpact: true } })
			expect(mcp.isError).not.toBe(true)
			expect(mcp.structuredContent).toMatchObject({ status: 'deleted', key: VIEW_ID, changeSummary: { changes: [{ path: '', op: 'remove' }] } })
			expect(mcp.structuredContent).not.toHaveProperty('revision')
			expect((mcp.structuredContent as { impacts: unknown[] }).impacts.length).toBeGreaterThan(0)
		}
		finally { await close() }
		expect(await exists(join(ctx.root, viewRelativePath(VIEW_ID)))).toBe(false)
		expect(await ctx.app.readPointResource('view', VIEW_ID)).toBeUndefined()
		expect(await referencingBytes(ctx)).toEqual(referencing)
		const flow = await ctx.app.readPointResource('flow', FLOW_ID)
		expect(flow?.diagnostics.map(item => item.code)).toContain('flow.missing_view')
		// The Agent's reservation ended with the View.
		expect(ctx.leases.find({ kind: 'view', key: VIEW_ID })).toBeUndefined()
	})

	it('deletes a View nothing names without acknowledgement, over HTTP, as a write event and a resource.removed commit', async () => {
		const ctx = await fixture()
		const lonely = '99999999-9999-4999-8999-999999999999'
		const created = await session(ctx, OWNER).createView({ id: lonely, name: 'Lonely', spec: spec('Nothing names me') })
		expect(created.status).toBe('created')
		ctx.commits.length = 0
		const revision = (created as { revision: string }).revision
		const http = await deleteViewForHttp(session(ctx, OWNER), lonely, { expectedRevision: revision })
		expect(http.status).toBe(200)
		expect(http.body).toEqual({ status: 'deleted', key: lonely, changeSummary: { changes: [{ path: '', op: 'remove' }] } })
		expect(ctx.commits).toEqual([[{ kind: 'view', key: lonely, revision: null }]])

		await ctx.recorder.closeOpenAutosave('shutdown')
		const versions = await ctx.app.listVersions({ types: ['autosave'] })
		expect(versions.status).toBe('listed')
		const newest = (versions as { versions: readonly { id: string }[] }).versions[0]!
		const read = await ctx.app.readVersion(newest.id)
		const events = (read as { version: HostVersionRecord }).version.events
		expect(events.map(event => [event.operation, event.source, event.beforeRevision, event.afterRevision])).toContainEqual(['deleteView', 'workbench', revision, null])
	})

	it('refuses a stale revision, an unknown View and a key that is not a UUID, deleting nothing', async () => {
		const ctx = await fixture()
		const before = await viewRead(ctx)
		const stale = await session(ctx, OWNER).deleteView({ key: VIEW_ID, expectedRevision: 'r_stale', acknowledgeImpact: true })
		expect(stale).toMatchObject({ status: 'conflict', key: VIEW_ID, currentRevision: before.revision })
		expect(await session(ctx, OWNER).deleteView({ key: '77777777-7777-4777-8777-777777777777', expectedRevision: 'r', acknowledgeImpact: true })).toEqual({ status: 'not_found', key: '77777777-7777-4777-8777-777777777777' })
		expect(await session(ctx, OWNER).deleteView({ key: 'not-a-uuid', expectedRevision: 'r' })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'identity.invalid_uuid' }] })
		expect(await session(ctx, OWNER).deleteView({ key: VIEW_ID, expectedRevision: '' })).toMatchObject({ status: 'invalid_expected_revision' })
		expect((await viewRead(ctx)).revision).toBe(before.revision)
		const http = await deleteViewForHttp(session(ctx, OWNER), VIEW_ID, { expectedRevision: 'r_stale' })
		expect(http.status).toBe(409)
		expect((await deleteViewForHttp(session(ctx, OWNER), VIEW_ID, { acknowledgeImpact: true })).status).toBe(400)
		expect((await deleteViewForHttp(session(ctx, OWNER), VIEW_ID, { expectedRevision: before.revision, extra: true })).status).toBe(400)
	})

	it('needs views.write and the lease: refused with the keys named, or locked by another Agent', async () => {
		const ctx = await fixture()
		const revision = (await viewRead(ctx)).revision
		const denied = await session(ctx, REVIEWER).deleteView({ key: VIEW_ID, expectedRevision: revision, acknowledgeImpact: true })
		expect(denied).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
		const deniedAgent = await session(ctx, AGENT_REVIEWER).deleteView({ key: VIEW_ID, expectedRevision: revision, acknowledgeImpact: true })
		expect(deniedAgent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		const http = await deleteViewForHttp(session(ctx, VIEWER), VIEW_ID, { expectedRevision: revision, acknowledgeImpact: true })
		expect(http.status).toBe(403)

		expect(session(ctx, OTHER_AGENT).acquireLeases({ resources: [{ kind: 'view', key: VIEW_ID }] })).toMatchObject({ status: 'acquired' })
		const locked = await session(ctx, AGENT).deleteView({ key: VIEW_ID, expectedRevision: revision, acknowledgeImpact: true })
		expect(locked).toMatchObject({ status: 'locked', code: 'resource.locked' })
		const lockedHttp = await deleteViewForHttp(session(ctx, OWNER), VIEW_ID, { expectedRevision: revision, acknowledgeImpact: true })
		expect(lockedHttp.status).toBe(423)
		expect(await exists(join(ctx.root, viewRelativePath(VIEW_ID)))).toBe(true)
	})
})

describe('deleting an authored Asset (Rule 01a172ce-280b-7cec-9ca5-ec189b313ebe)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists the $asset bindings that would dangle, writes nothing unacknowledged, and removes only the Asset once acknowledged', async () => {
		const ctx = await fixture()
		const asset = (await ctx.persistence.assets.read(ASSET_ID))!
		const viewFile = await fileOf(ctx, viewRelativePath(VIEW_ID))
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const refused = await client.callTool({ name: 'delete_asset', arguments: { assetId: ASSET_ID, expectedRevision: asset.revision } })
			expect(refused.isError).toBe(true)
			expect(refused.structuredContent).toEqual({ status: 'impact_acknowledgement_required', key: ASSET_ID, impacts: [{ category: 'asset_reference_dangling', viewId: VIEW_ID, assetId: ASSET_ID, pointers: ['/ir/slots/content/0/config/icon'] }] })
			const http = await deleteAssetForHttp(session(ctx, OWNER), ASSET_ID, { expectedRevision: asset.revision })
			expect(http.status).toBe(409)
			expect(http.body).toEqual(refused.structuredContent)
			expect(await exists(join(ctx.root, assetMetadataRelativePath(ASSET_ID)))).toBe(true)

			ctx.commits.length = 0
			const deleted = await client.callTool({ name: 'delete_asset', arguments: { assetId: ASSET_ID, expectedRevision: asset.revision, acknowledgeImpact: true } })
			expect(deleted.isError).not.toBe(true)
			expect(deleted.structuredContent).toMatchObject({ status: 'deleted', key: ASSET_ID, changeSummary: { changes: [{ path: '', op: 'remove' }] } })
		}
		finally { await close() }
		expect(await exists(join(ctx.root, 'assets', ASSET_ID))).toBe(false)
		expect(await ctx.app.readPointResource('asset', ASSET_ID)).toBeUndefined()
		expect(ctx.commits).toEqual([[{ kind: 'asset', key: ASSET_ID, revision: null }]])
		// The View keeps its binding and reports it as dangling.
		expect(await fileOf(ctx, viewRelativePath(VIEW_ID))).toBe(viewFile)
		const view = await ctx.app.readPointResource('view', VIEW_ID)
		expect(view?.diagnostics.map(item => item.code).join()).toMatch(/asset/)
	})

	it('deletes an Asset nothing binds without acknowledgement over HTTP, and answers not_found for one that is gone', async () => {
		const ctx = await fixture()
		const loose = '88888888-8888-4888-8888-888888888888'
		const created = await session(ctx, OWNER).createAsset({ id: loose, name: 'Loose', contentFilename: 'loose.png', mediaType: 'image/png', contentBase64: PNG })
		const revision = (created as { revision: string }).revision
		const http = await deleteAssetForHttp(session(ctx, OWNER), loose, { expectedRevision: revision })
		expect(http).toEqual({ status: 200, body: { status: 'deleted', key: loose, changeSummary: { changes: [{ path: '', op: 'remove' }] } } })
		expect((await deleteAssetForHttp(session(ctx, OWNER), loose, { expectedRevision: revision })).status).toBe(404)
		expect(await session(ctx, AGENT).deleteAsset({ assetId: ASSET_ID, expectedRevision: 'r_stale', acknowledgeImpact: true })).toMatchObject({ status: 'conflict' })
		expect(await session(ctx, REVIEWER).deleteAsset({ assetId: ASSET_ID, expectedRevision: 'r', acknowledgeImpact: true })).toMatchObject({ status: 'blocked', requiredKeys: ['assets.write'] })
	})
})

describe('deleting a UX Flow (Rule 01a1144e-50dd-7b92-aa5e-e175e34bf424)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('deletes a Flow nothing depends on without acknowledgement, over MCP and HTTP, and nothing else changes', async () => {
		const ctx = await fixture()
		const second = '55555555-5555-4555-8555-555555555555'
		const step = { target: { viewId: VIEW_ID }, transitions: [] }
		const created = await session(ctx, OWNER).createFlow({ id: second, name: 'Second', entryStepId: STEP_ID, steps: { [STEP_ID]: step } })
		expect(created.status).toBe('created')
		const viewFile = await fileOf(ctx, viewRelativePath(VIEW_ID))
		const { client, close } = await connectMcp(ctx.app, AGENT, { leases: ctx.leases })
		try {
			const mcp = await client.callTool({ name: 'delete_flow', arguments: { flowId: second, expectedRevision: (created as { revision: string }).revision } })
			expect(mcp.isError).not.toBe(true)
			expect(mcp.structuredContent).toEqual({ status: 'deleted', key: second, changeSummary: { changes: [{ path: '', op: 'remove' }] } })
		}
		finally { await close() }
		expect(await ctx.app.readPointResource('flow', second)).toBeUndefined()
		expect(await fileOf(ctx, viewRelativePath(VIEW_ID))).toBe(viewFile)

		const first = (await ctx.persistence.flows.read(FLOW_ID))!
		const http = await deleteFlowForHttp(session(ctx, OWNER), FLOW_ID, { expectedRevision: first.revision })
		expect(http.status).toBe(200)
		expect(http.body).toMatchObject({ status: 'deleted', key: FLOW_ID })
		expect(await exists(join(ctx.root, flowRelativePath(FLOW_ID)))).toBe(false)
		expect(await session(ctx, OWNER).deleteFlow({ flowId: FLOW_ID, expectedRevision: first.revision })).toEqual({ status: 'not_found', key: FLOW_ID })
		expect(await session(ctx, REVIEWER).deleteFlow({ flowId: FLOW_ID, expectedRevision: 'r' })).toMatchObject({ status: 'blocked', requiredKeys: ['flows.write'] })
	})

	it('asks for acknowledgement when a ready-for-review submission names the Flow revision', async () => {
		const ctx = await fixture()
		const flow = (await ctx.persistence.flows.read(FLOW_ID))!
		const submitted = await session(ctx, REVIEWER).submitReadyForReview({
			reviewId: REVIEW_ID,
			expectedRevision: (await ctx.persistence.reviews.read(REVIEW_ID))!.revision,
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: (await viewRead(ctx)).revision }, { identity: { type: 'flow', id: FLOW_ID }, revision: flow.revision }],
			actor: { type: 'human', displayName: 'Rui' },
			changeDomains: ['metadata'],
			evidenceRefs: [{ kind: 'screenshot', evidence: await putEvidenceRecord(ctx.persistence, 'screenshot', 'impact-ack') }],
			reason: 'Please check the Flow.',
		} as never)
		expect(submitted.status, JSON.stringify(submitted)).toBe('updated')
		const refused = await session(ctx, OWNER).deleteFlow({ flowId: FLOW_ID, expectedRevision: flow.revision })
		expect(refused).toMatchObject({ status: 'impact_acknowledgement_required', key: FLOW_ID, impacts: [{ category: 'submission_revision_not_current', reviewId: REVIEW_ID, resource: { kind: 'flow', key: FLOW_ID } }] })
		expect(await exists(join(ctx.root, flowRelativePath(FLOW_ID)))).toBe(true)
		const deleted = await session(ctx, OWNER).deleteFlow({ flowId: FLOW_ID, expectedRevision: flow.revision, acknowledgeImpact: true })
		expect(deleted).toMatchObject({ status: 'deleted' })
	})
})

describe('deleting an Asset is atomic', () => {
	it('keeps the whole Asset when persistence fails part-way through the delete', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-impact-ack-fault-')))
		cleanup.push(root)
		let armed = false
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
			fault(point, details) {
				if (armed && point === 'asset.before_apply' && details.index === 1) { armed = false; throw new Error('injected asset apply failure') }
			},
		})
		await createCurrentWorkspace(persistence, MANIFEST)
		const app = createWorkspaceApplicationSession(persistence)
		const created = await scoped(app, OWNER).createAsset({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png', contentBase64: PNG })
		const metadata = await fileOf({ root } as Fixture, assetMetadataRelativePath(ASSET_ID))
		const content = await readFile(join(root, 'assets', ASSET_ID, 'logo.png'))
		armed = true
		await expect(scoped(app, OWNER).deleteAsset({ assetId: ASSET_ID, expectedRevision: (created as { revision: string }).revision })).rejects.toThrow(/asset/i)
		expect(await fileOf({ root } as Fixture, assetMetadataRelativePath(ASSET_ID))).toBe(metadata)
		expect(await readFile(join(root, 'assets', ASSET_ID, 'logo.png'))).toEqual(content)
		expect((await persistence.assets.read(ASSET_ID))?.revision).toBe((created as { revision: string }).revision)
	})
})

describe('Decisions are part of a View delete (owner ruling 2 of discussioncomment-19180530)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists every Decision of the View, whatever its status, and deletes only once acknowledged', async () => {
		const ctx = await fixture()
		const lonely = '99999999-9999-4999-8999-999999999999'
		const created = await session(ctx, OWNER).createView({ id: lonely, name: 'Decided', spec: spec('Has Decisions') })
		const read = (await ctx.persistence.views.read(lonely))!
		const decisions = [
			{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', question: 'Pending one?', status: 'pending', history: [] },
			{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', question: 'Deferred one?', status: 'deferred', history: [] },
			{ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', question: 'Decided one?', status: 'decided', outcome: { summary: 'Yes', rationale: 'Because.' }, history: [] },
		]
		const written = await ctx.persistence.views.compareAndSwap({ key: lonely, expectedRevision: read.revision, resource: { ...read.resource, spec: { ...read.resource.spec, decisions } } as never })
		expect(created.status).toBe('created')
		expect(written.ok).toBe(true)
		const revision = (written as { revision: string }).revision

		const refused = await session(ctx, AGENT).deleteView({ key: lonely, expectedRevision: revision })
		expect(refused).toEqual({
			status: 'impact_acknowledgement_required',
			key: lonely,
			impacts: decisions.map(decision => ({ category: 'view_decision_removed', viewId: lonely, decisionId: decision.id, status: decision.status, question: decision.question })),
		})
		const http = await deleteViewForHttp(session(ctx, OWNER), lonely, { expectedRevision: revision })
		expect(http.status).toBe(409)
		expect(await exists(join(ctx.root, viewRelativePath(lonely)))).toBe(true)
		const deleted = await session(ctx, AGENT).deleteView({ key: lonely, expectedRevision: revision, acknowledgeImpact: true })
		expect(deleted).toMatchObject({ status: 'deleted', impacts: [{ category: 'view_decision_removed' }, { category: 'view_decision_removed' }, { category: 'view_decision_removed' }] })
	})
})

describe('the impact is checked again inside the lock', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('refuses an unacknowledged View delete when a reference appeared after the first look, and deletes nothing', async () => {
		const ctx = await fixture()
		const lonely = '99999999-9999-4999-8999-999999999999'
		const created = await session(ctx, OWNER).createView({ id: lonely, name: 'Lonely', spec: spec('Nothing names me yet') })
		const revision = (created as { revision: string }).revision
		const repository = ctx.persistence.views
		const original = repository.deleteIfRevision.bind(repository)
		let raced = false
		repository.deleteIfRevision = (async (input: Parameters<typeof original>[0]) => {
			if (!raced) {
				raced = true
				// A Review thread anchors in the View between the caller's read and the delete.
				expect(await session(ctx, REVIEWER).createReviewThread({ anchor: { viewId: lonely, widgetId: 'root' } })).toMatchObject({ status: 'created' })
			}
			return original(input)
		}) as typeof original
		const refused = await session(ctx, OWNER).deleteView({ key: lonely, expectedRevision: revision })
		expect(refused).toMatchObject({ status: 'impact_acknowledgement_required', key: lonely, impacts: [{ category: 'review_anchor_invalidated' }] })
		expect(await exists(join(ctx.root, viewRelativePath(lonely)))).toBe(true)
		// The caller resends with the acknowledgement it was shown.
		expect(await session(ctx, OWNER).deleteView({ key: lonely, expectedRevision: revision, acknowledgeImpact: true })).toMatchObject({ status: 'deleted' })
	})

	it('does the same for a UX Flow and an Asset', async () => {
		const ctx = await fixture()
		const loose = '88888888-8888-4888-8888-888888888888'
		const asset = await session(ctx, OWNER).createAsset({ id: loose, name: 'Loose', contentFilename: 'loose.png', mediaType: 'image/png', contentBase64: PNG })
		const assetRevision = (asset as { revision: string }).revision
		const originalAsset = ctx.persistence.assets.deleteIfRevision.bind(ctx.persistence.assets)
		let racedAsset = false
		ctx.persistence.assets.deleteIfRevision = (async (input: Parameters<typeof originalAsset>[0]) => {
			if (!racedAsset) {
				racedAsset = true
				// A View binds the Asset between the caller's read and the delete.
				const view = (await ctx.persistence.views.read(VIEW_ID))!
				const widget = { type: 'Button', id: 'logo', config: { icon: { $asset: loose } } }
				const ir = { type: 'RootShell', id: 'root', slots: { content: [widget] } }
				expect(await session(ctx, OWNER).updateViewStructure({ key: VIEW_ID, expectedRevision: view.revision, ir, variants: view.resource.variants } as never)).toMatchObject({ status: 'updated' })
			}
			return originalAsset(input)
		}) as typeof originalAsset
		const refusedAsset = await session(ctx, OWNER).deleteAsset({ assetId: loose, expectedRevision: assetRevision })
		expect(refusedAsset).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'asset_reference_dangling', assetId: loose }] })
		expect(await exists(join(ctx.root, assetMetadataRelativePath(loose)))).toBe(true)

		const second = '55555555-5555-4555-8555-555555555555'
		const flow = await session(ctx, OWNER).createFlow({ id: second, name: 'Second', entryStepId: STEP_ID, steps: { [STEP_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } })
		const flowRevision = (flow as { revision: string }).revision
		const originalFlow = ctx.persistence.flows.deleteIfRevision.bind(ctx.persistence.flows)
		let racedFlow = false
		ctx.persistence.flows.deleteIfRevision = (async (input: Parameters<typeof originalFlow>[0]) => {
			if (!racedFlow) {
				racedFlow = true
				const submitted = await session(ctx, REVIEWER).submitReadyForReview({
					reviewId: REVIEW_ID,
					expectedRevision: (await ctx.persistence.reviews.read(REVIEW_ID))!.revision,
					resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: (await viewRead(ctx)).revision }, { identity: { type: 'flow', id: second }, revision: flowRevision }],
					actor: { type: 'human', displayName: 'Rui' },
					changeDomains: ['metadata'],
					evidenceRefs: [{ kind: 'screenshot', evidence: await putEvidenceRecord(ctx.persistence, 'screenshot', 'race') }],
					reason: 'Check the Flow.',
				} as never)
				expect(submitted.status, JSON.stringify(submitted)).toBe('updated')
			}
			return originalFlow(input)
		}) as typeof originalFlow
		const refusedFlow = await session(ctx, OWNER).deleteFlow({ flowId: second, expectedRevision: flowRevision })
		expect(refusedFlow).toMatchObject({ status: 'impact_acknowledgement_required', impacts: [{ category: 'submission_revision_not_current' }] })
		expect(await exists(join(ctx.root, flowRelativePath(second)))).toBe(true)
	})
})

describe('a delete is a history boundary (owner ruling 1 of discussioncomment-19180530)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function autosaves(ctx: Fixture) {
		await ctx.recorder.closeOpenAutosave('shutdown')
		const listed = await ctx.app.listVersions({ types: ['autosave'] })
		const rows = (listed as { versions: readonly { id: string }[] }).versions
		return Promise.all(rows.map(async (row) => {
			const read = await ctx.app.readVersion(row.id)
			return { id: row.id, operations: (read as { version: HostVersionRecord }).version.events.map(event => event.operation) }
		}))
	}

	it('restores a View created and deleted within one autosave window', async () => {
		const ctx = await fixture()
		await ctx.recorder.closeOpenAutosave('shutdown')
		const key = '99999999-9999-4999-8999-999999999999'
		const created = await session(ctx, OWNER).createView({ id: key, name: 'Short lived', spec: spec('Created, then deleted at once') })
		const before = (await ctx.persistence.views.read(key))!
		expect(await session(ctx, OWNER).deleteView({ key, expectedRevision: (created as { revision: string }).revision })).toMatchObject({ status: 'deleted' })

		const rows = await autosaves(ctx)
		// Newest first: the delete alone, then the autosave that holds the create.
		expect(rows.map(row => row.operations)).toEqual([['deleteView'], ['createView']])
		const restored = await session(ctx, OWNER).restoreResourceVersion({ versionId: rows[1]!.id, resource: { kind: 'view', key }, expectedRevision: null })
		expect(restored).toMatchObject({ status: 'created', kind: 'view', key })
		expect((await ctx.persistence.views.read(key))!.resource).toEqual(before.resource)
	})

	it('restores a View edited and then deleted by the same actor to the state just before the delete', async () => {
		const ctx = await fixture()
		await ctx.recorder.closeOpenAutosave('shutdown')
		const key = '99999999-9999-4999-8999-999999999999'
		const created = await session(ctx, OWNER).createView({ id: key, name: 'Edited', spec: spec('First') })
		const edited = await session(ctx, OWNER).updateViewSpec({ key, expectedRevision: (created as { revision: string }).revision, spec: spec('Second') })
		const before = (await ctx.persistence.views.read(key))!
		expect(await session(ctx, OWNER).deleteView({ key, expectedRevision: (edited as { revision: string }).revision })).toMatchObject({ status: 'deleted' })

		const rows = await autosaves(ctx)
		expect(rows.map(row => row.operations)).toEqual([['deleteView'], ['createView', 'updateViewSpec']])
		await session(ctx, OWNER).restoreResourceVersion({ versionId: rows[1]!.id, resource: { kind: 'view', key }, expectedRevision: null })
		expect((await ctx.persistence.views.read(key))!.resource).toEqual(before.resource)
	})

	it('restores a deleted Asset and a deleted UX Flow the same way', async () => {
		const ctx = await fixture()
		await ctx.recorder.closeOpenAutosave('shutdown')
		const assetKey = '88888888-8888-4888-8888-888888888888'
		const flowKey = '55555555-5555-4555-8555-555555555555'
		const asset = await session(ctx, OWNER).createAsset({ id: assetKey, name: 'Loose', contentFilename: 'loose.png', mediaType: 'image/png', contentBase64: PNG })
		const flow = await session(ctx, OWNER).createFlow({ id: flowKey, name: 'Second', entryStepId: STEP_ID, steps: { [STEP_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } })
		const assetBefore = (await ctx.persistence.assets.read(assetKey))!
		const flowBefore = (await ctx.persistence.flows.read(flowKey))!
		expect(await session(ctx, OWNER).deleteAsset({ assetId: assetKey, expectedRevision: (asset as { revision: string }).revision })).toMatchObject({ status: 'deleted' })
		expect(await session(ctx, OWNER).deleteFlow({ flowId: flowKey, expectedRevision: (flow as { revision: string }).revision })).toMatchObject({ status: 'deleted' })

		const rows = await autosaves(ctx)
		// Every delete closes the autosave before it, so each stands alone after the one that holds the creates.
		expect(rows.map(row => [...row.operations].sort())).toEqual([['deleteFlow'], ['deleteAsset'], ['createAsset', 'createFlow']])
		const versionId = rows[2]!.id
		expect(await session(ctx, OWNER).restoreResourceVersion({ versionId, resource: { kind: 'asset', key: assetKey }, expectedRevision: null })).toMatchObject({ status: 'created' })
		expect(await session(ctx, OWNER).restoreResourceVersion({ versionId, resource: { kind: 'flow', key: flowKey }, expectedRevision: null })).toMatchObject({ status: 'created' })
		expect((await ctx.persistence.assets.read(assetKey))!.revision).toBe(assetBefore.revision)
		expect((await ctx.persistence.flows.read(flowKey))!.resource).toEqual(flowBefore.resource)
	})
})

describe('create_flow and update_flow results carry the reference diagnostics (Clause 01a172e8-906d-779b-8305-870bf5f09e75)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('lists the missing View, Variant and Widget after the structural diagnostics, and still saves', async () => {
		const ctx = await fixture()
		const missingView = '77777777-7777-4777-8777-777777777777'
		const OTHER_STEP = '99999999-0000-4999-8999-999999999999'
		const second = '55555555-5555-4555-8555-555555555555'
		const steps = {
			[STEP_ID]: { target: { viewId: VIEW_ID, variantName: 'gone' }, transitions: [{ trigger: { widgetId: 'nope', event: 'click' }, targetStepId: OTHER_STEP }] },
			[OTHER_STEP]: { target: { viewId: missingView }, transitions: [] },
		}
		const created = await session(ctx, OWNER).createFlow({ id: second, name: 'Dangling', entryStepId: STEP_ID, steps: steps as never })
		expect(created, JSON.stringify(created)).toMatchObject({ status: 'created' })
		const codes = (created as unknown as { diagnostics: { code: string }[] }).diagnostics.map(item => item.code)
		expect(codes).toEqual(expect.arrayContaining(['flow.missing_variant', 'flow.missing_view', 'flow.missing_widget']))
		const updated = await session(ctx, OWNER).updateFlow({ flowId: second, expectedRevision: (created as { revision: string }).revision, name: 'Dangling 2', entryStepId: STEP_ID, steps: steps as never })
		expect(updated).toMatchObject({ status: 'updated' })
		expect((updated as unknown as { diagnostics: { code: string }[] }).diagnostics.map(item => item.code)).toEqual(codes)
		// The Flow read reports the same.
		const read = await ctx.app.readPointResource('flow', second)
		expect(read?.diagnostics.map(item => item.code)).toEqual(codes)
		// A Flow without a dangling reference carries none.
		const clean = await session(ctx, OWNER).createFlow({ id: '66666666-0000-4666-8666-666666666666', name: 'Clean', entryStepId: STEP_ID, steps: { [STEP_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } })
		expect((clean as unknown as { diagnostics: unknown[] }).diagnostics).toEqual([])
	})
})
