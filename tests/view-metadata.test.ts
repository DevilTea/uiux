import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import metadataRoute from '../server/api/views/[id]/metadata.put'
import { createLeaseManager } from '../src/application/access/leases'
import { createHistoryRecorder, type HistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { VersionListing } from '../src/application/services/history-service'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import { evaluateEvidenceStaleness } from '../src/domain/evidence/staleness'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import { canonicalJsonBytes, FileNativePersistence } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createAccessGuardHandler } from '../src/server/access/http'
import { mapAuthoringResultToHttpStatus, updateViewMetadataForHttp } from '../src/server/authoring-http'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { createLoopbackGuardHandler } from '../src/server/loopback-guard'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, connectMcp, provisionToken, scoped, testMember } from './support/access'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { createCurrentWorkspace } from './support/workspace-layout'

/**
 * The View metadata operation, `update_view_metadata` and `PUT /api/views/:id/metadata` (Clause
 * 01a15379-d8f7-7c0c-9b9a-05c07c64cc85; `views.write` by Clause 01a11485-fa44-7b6a-99f8-de4e1e8edcfc):
 * a View's `name` and `feature` are not its identity (Rules 01a1144e-4fa5-7ff4-aeb0-1278a85f188b and
 * 01a11485-bbef-7485-80ed-791fe9b3bc5e), so they change in place and formal Evidence stays fresh
 * (Rule 01a115cd-c5a5-757a-b049-b5138fe75920). Scenarios 01a1537a-5e4b-7f25-a271-f8229a3803bc,
 * 01a1537a-6135-759d-a23b-9ed8c8d58c81 and 01a1537a-61db-7608-933b-6500bb64e087.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const MISSING_VIEW_ID = '33333333-3333-4333-8333-333333333333'
const DECISION_ID = '55555555-5555-4555-8555-555555555555'
const START = Date.parse('2026-10-19T00:00:00.000Z')

const OWNER = testMember({ memberId: 'owner-1', nickname: 'mei', kind: 'human', preset: 'owner', credential: 'session' })
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', preset: 'editor', credential: 'token' })
const OTHER_AGENT = testMember({ memberId: 'agent-2', nickname: 'codex', kind: 'agent', preset: 'editor', credential: 'token' })
const REVIEWER = testMember({ memberId: 'reviewer-1', nickname: 'rui', kind: 'human', preset: 'reviewer', credential: 'session' })

const MANIFEST = {
	schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
	i18n: { defaultLocale: 'en-US' },
	viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
	themes: { light: { label: 'Light' } },
} satisfies WorkspaceManifest

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

const VIEW: ViewResource = {
	id: VIEW_ID,
	name: 'Checkout',
	feature: 'checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [{ type: 'Button', id: 'pay', config: { label: 'Pay' } }] } } as ViewResource['ir'],
	variants: { empty: { state: { pay: { disabled: true } } } } as ViewResource['variants'],
	spec: {
		...spec('Pay for the order.'),
		decisions: [{ id: DECISION_ID, question: 'Keep a single Pay button?', status: 'pending', history: [] }],
	},
}

function manualClock(): HistoryRecorderClock {
	return { now: () => START, setTimeout: () => Symbol('timer'), clearTimeout: () => undefined }
}

type Fixture = Readonly<{ persistence: FileNativePersistence; app: WorkspaceApplicationSession; recorder: HistoryRecorder }>

/** A started Workspace with one tagged View carrying a Decision and a Variant, and a Locale. */
async function fixture(): Promise<Fixture> {
	const root = await tempDir('uiux-view-metadata-ws-')
	const home = join(await tempDir('uiux-view-metadata-home-'), 'home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, MANIFEST)
	await persistence.locales.create('en-US', { greeting: 'Hello' })
	await persistence.views.create(VIEW_ID, VIEW)
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock: manualClock(), log: () => undefined })
	const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
	running.push(recorder)
	expect(await recorder.start()).toMatchObject({ enabled: true })
	return { persistence, app, recorder }
}

async function readView(ctx: Fixture, key = VIEW_ID) {
	const read = await ctx.persistence.views.read(key)
	if (!read) throw new Error(`View ${key} is missing`)
	return read
}

function listed(outcome: unknown): VersionListing {
	expect((outcome as { status: string }).status, JSON.stringify(outcome)).toBe('listed')
	return outcome as VersionListing
}

describe('updateViewMetadata (Clause 01a15379-d8f7)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('stores the name trimmed and keeps identity, IR, Variants, Spec, Decisions and the omitted feature', async () => {
		const ctx = await fixture()
		const before = await readView(ctx)
		const result = await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, name: '  Checkout v2 \n' })
		expect(result).toMatchObject({ status: 'updated', key: VIEW_ID })
		const after = await readView(ctx)
		expect(after.revision).toBe((result as { revision: string }).revision)
		expect(after.resource).toEqual({ ...VIEW, name: 'Checkout v2' })
	})

	it('sets the feature tag and keeps the omitted name', async () => {
		const ctx = await fixture()
		const before = await readView(ctx)
		expect(await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, feature: 'payments' })).toMatchObject({ status: 'updated' })
		expect((await readView(ctx)).resource).toEqual({ ...VIEW, feature: 'payments' })
	})

	it('removes the feature tag with null, and the View appears ungrouped (Scenario 01a1537a-61db)', async () => {
		const ctx = await fixture()
		const before = await readView(ctx)
		expect(await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, feature: null })).toMatchObject({ status: 'updated' })
		const after = await readView(ctx)
		expect(Object.hasOwn(after.resource, 'feature')).toBe(false)
		expect(after.resource).toEqual({ id: VIEW.id, name: VIEW.name, ir: VIEW.ir, variants: VIEW.variants, spec: VIEW.spec })
		const listing = await ctx.app.listPointResources({ kinds: ['view'], limit: 10 })
		if (listing.status !== 'ok') throw new Error(JSON.stringify(listing))
		const summary = listing.page.items.find(item => item.key === VIEW_ID) as { summary: Record<string, unknown> } | undefined
		expect(summary?.summary).toMatchObject({ name: 'Checkout' })
		expect(summary?.summary.feature).toBeUndefined()
	})

	it('allows a name another View already has', async () => {
		const ctx = await fixture()
		await ctx.persistence.views.create(OTHER_VIEW_ID, { ...VIEW, id: OTHER_VIEW_ID, name: 'Payment' })
		const before = await readView(ctx)
		expect(await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, name: 'Payment' })).toMatchObject({ status: 'updated' })
		expect((await readView(ctx)).resource.name).toBe('Payment')
		expect((await readView(ctx, OTHER_VIEW_ID)).resource.name).toBe('Payment')
	})

	it('refuses a name empty after trimming, an empty feature, and a call with neither field as invalid, writing nothing', async () => {
		const ctx = await fixture()
		const before = await readView(ctx)
		for (const command of [{ name: '   ' }, { name: '' }, { feature: '' }, {}]) {
			const result = await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, ...command })
			expect(result, JSON.stringify(command)).toMatchObject({ status: 'invalid', key: VIEW_ID, diagnostics: [expect.objectContaining({ code: expect.any(String) })] })
		}
		expect((await readView(ctx)).revision).toBe(before.revision)
	})

	it('refuses an invalid id as invalid, a malformed revision as invalid_expected_revision, and a missing View as not_found', async () => {
		const ctx = await fixture()
		const before = await readView(ctx)
		expect(await ctx.app.updateViewMetadata({ key: 'not-a-uuid', expectedRevision: before.revision, name: 'X' })).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'identity.invalid_uuid' }] })
		expect(await ctx.app.updateViewMetadata({ key: VIEW_ID, expectedRevision: '', name: 'X' })).toMatchObject({ status: 'invalid_expected_revision' })
		expect(await ctx.app.updateViewMetadata({ key: MISSING_VIEW_ID, expectedRevision: before.revision, name: 'X' })).toEqual({ status: 'not_found', key: MISSING_VIEW_ID })
		expect((await readView(ctx)).revision).toBe(before.revision)
	})
})

describe('update_view_metadata over MCP', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('renames and retags a View for an Agent, takes the lease, and records an updateViewMetadata write event', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const mcp = await connectMcp(ctx.app, AGENT, { leases, history: ctx.recorder })
		try {
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'update_view_metadata')!
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['expectedRevision', 'feature', 'name', 'viewId'])
			expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true })

			const before = await readView(ctx)
			const written = await mcp.client.callTool({ name: 'update_view_metadata', arguments: { viewId: VIEW_ID, expectedRevision: before.revision, name: 'Pay', feature: 'payments' } })
			expect(written.isError).not.toBe(true)
			expect(written.structuredContent).toMatchObject({ status: 'updated', key: VIEW_ID, resourceUri: `uiux://view/${VIEW_ID}` })
			expect((await readView(ctx)).resource).toEqual({ ...VIEW, name: 'Pay', feature: 'payments' })
			expect(leases.find({ kind: 'view', key: VIEW_ID })).toMatchObject({ holder: { nickname: 'claude' } })

			const released = await mcp.client.callTool({ name: 'release_lock', arguments: {} })
			expect(released.structuredContent).toMatchObject({ status: 'released' })
		}
		finally {
			await mcp.close()
		}
		const autosave = listed(await ctx.app.listVersions({})).versions.find(version => version.type === 'autosave')
		expect(autosave).toBeDefined()
		const read = await ctx.app.readVersion(autosave!.id)
		if (read.status !== 'found' || read.version.type === 'checkpoint') throw new Error(JSON.stringify(read))
		expect(read.version.events.map(event => [event.operation, event.source, event.resource.key])).toEqual([['updateViewMetadata', 'mcp', VIEW_ID]])
		expect(read.version.events[0]!.actor).toEqual({ type: 'agent', id: `member:${AGENT.memberId}`, displayName: 'claude' })
	})

	it('refuses a stale revision as conflict carrying the current revision, and the name is unchanged (Scenario 01a1537a-6135)', async () => {
		const ctx = await fixture()
		const read = await readView(ctx)
		// Another member changes the View meanwhile.
		const moved = await scoped(ctx.app, OWNER).updateViewSpec({ key: VIEW_ID, expectedRevision: read.revision, spec: spec('Changed meanwhile.') })
		expect(moved).toMatchObject({ status: 'updated' })
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const stale = await mcp.client.callTool({ name: 'update_view_metadata', arguments: { viewId: VIEW_ID, expectedRevision: read.revision, name: 'Renamed' } })
			expect(stale.isError).toBe(true)
			expect(stale.structuredContent).toEqual({ status: 'conflict', key: VIEW_ID, currentRevision: (moved as { revision: string }).revision })
		}
		finally {
			await mcp.close()
		}
		expect((await readView(ctx)).resource.name).toBe('Checkout')
	})

	it('clears the feature tag with null and no name (Scenario 01a1537a-61db)', async () => {
		const ctx = await fixture()
		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const cleared = await mcp.client.callTool({ name: 'update_view_metadata', arguments: { viewId: VIEW_ID, expectedRevision: (await readView(ctx)).revision, feature: null } })
			expect(cleared.isError).not.toBe(true)
		}
		finally {
			await mcp.close()
		}
		const after = await readView(ctx)
		expect(after.resource.name).toBe('Checkout')
		expect(after.resource.feature).toBeUndefined()
	})

	it('refuses locked, not_found, invalid_expected_revision, invalid and auth.scope_denied, writing nothing', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const before = await readView(ctx)
		const holder = await connectMcp(ctx.app, OTHER_AGENT, { leases })
		const agent = await connectMcp(ctx.app, AGENT, { leases })
		const reviewer = await connectMcp(ctx.app, testMember({ nickname: 'critic', kind: 'agent', preset: 'reviewer', credential: 'token' }), { leases })
		try {
			const call = (client: typeof agent.client, args: Record<string, unknown>) => client.callTool({ name: 'update_view_metadata', arguments: { viewId: VIEW_ID, expectedRevision: before.revision, ...args } })

			expect((await call(agent.client, { viewId: MISSING_VIEW_ID, name: 'X' })).structuredContent).toEqual({ status: 'not_found', key: MISSING_VIEW_ID })
			expect((await call(agent.client, { expectedRevision: '', name: 'X' })).structuredContent).toMatchObject({ status: 'invalid_expected_revision' })
			expect((await call(agent.client, {})).structuredContent).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ path: '/name' })] })
			expect((await call(agent.client, { name: '  ' })).structuredContent).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ path: '/name' })] })
			const denied = await call(reviewer.client, { name: 'X' })
			expect(denied.isError).toBe(true)
			expect(denied.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })

			// Another Agent holds the View's edit lease.
			expect((await holder.client.callTool({ name: 'acquire_lock', arguments: { resources: [{ kind: 'view', key: VIEW_ID }] } })).structuredContent).toMatchObject({ status: 'acquired' })
			const locked = await call(agent.client, { name: 'X' })
			expect(locked.isError).toBe(true)
			expect(locked.structuredContent).toMatchObject({ status: 'locked', code: 'resource.locked', lock: { kind: 'view', key: VIEW_ID, holder: { nickname: 'codex' } } })
		}
		finally {
			await Promise.all([holder.close(), agent.close(), reviewer.close()])
		}
		expect((await readView(ctx)).revision).toBe(before.revision)
	})
})

describe('PUT /api/views/:id/metadata', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	it('maps every result to its HTTP status in process, the human edit lease check included', async () => {
		const ctx = await fixture()
		const leases = createLeaseManager()
		const before = await readView(ctx)
		const human = scoped(ctx.app, OWNER, { leases })
		const put = (body: unknown, id = VIEW_ID) => updateViewMetadataForHttp(human, id, body)

		expect(await put({ expectedRevision: before.revision, name: 'X', extra: 1 })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })
		expect(await put({ expectedRevision: before.revision, feature: 3 })).toMatchObject({ status: 400, body: { code: 'malformed_payload' } })
		expect(await put({ expectedRevision: before.revision })).toMatchObject({ status: 400, body: { status: 'invalid' } })
		expect(await put({ expectedRevision: '', name: 'X' })).toMatchObject({ status: 400, body: { status: 'invalid_expected_revision' } })
		expect(await put({ expectedRevision: before.revision, name: 'X' }, MISSING_VIEW_ID)).toMatchObject({ status: 404, body: { status: 'not_found' } })
		expect(await updateViewMetadataForHttp(scoped(ctx.app, REVIEWER, { leases }), VIEW_ID, { expectedRevision: before.revision, name: 'X' }))
			.toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['views.write'] } })

		// An Agent's write takes the View's lease; a human's rename is then refused with 423.
		const agentWrite = await scoped(ctx.app, AGENT, { leases, transport: 'mcp' }).updateViewMetadata({ key: VIEW_ID, expectedRevision: before.revision, name: 'By the Agent' })
		expect(agentWrite).toMatchObject({ status: 'updated' })
		const locked = await put({ expectedRevision: (agentWrite as { revision: string }).revision, name: 'By the human' })
		expect(locked).toMatchObject({ status: 423, body: { status: 'locked', code: 'resource.locked' } })
		expect(mapAuthoringResultToHttpStatus('locked')).toBe(423)
		leases.release({ memberId: AGENT.memberId, nickname: AGENT.nickname, kind: 'agent' })

		expect(await put({ expectedRevision: before.revision, name: 'Stale' })).toMatchObject({ status: 409, body: { status: 'conflict', currentRevision: (agentWrite as { revision: string }).revision } })
		const renamed = await put({ expectedRevision: (agentWrite as { revision: string }).revision, name: ' By the human ', feature: null })
		expect(renamed).toMatchObject({ status: 200, body: { status: 'updated', key: VIEW_ID } })
		expect((await readView(ctx)).resource).toMatchObject({ name: 'By the human' })
		expect((await readView(ctx)).resource.feature).toBeUndefined()
	})

	describe('through the route and the access guard', () => {
		let root: string
		let server: Server
		let origin: string
		const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

		beforeAll(async () => {
			root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-view-metadata-api-')))
			process.env.UIUX_WORKSPACE_ROOT = root
			const app = createApp()
			app.use(createLoopbackGuardHandler())
			app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
			const router = createRouter()
			router.put('/api/views/:id/metadata', metadataRoute)
			app.use(router)
			server = createServer(toNodeListener(app))
			await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
			origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
			process.env.UIUX_SERVER_ORIGIN = origin
			const runtime = getSelectedWorkspaceServerRuntime()
			await createCurrentWorkspace(runtime.persistence, MANIFEST)
			await runtime.persistence.views.create(VIEW_ID, VIEW)
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

		it('answers 401 without a credential, 403 auth.scope_denied without views.write, and 200 for an Editor', async () => {
			const runtime = getSelectedWorkspaceServerRuntime()
			const revision = (await runtime.persistence.views.readRevision(VIEW_ID))!
			const editor = await provisionToken(root, { nickname: 'eve', kind: 'human', preset: 'editor' })
			const reader = await provisionToken(root, { nickname: 'vic', kind: 'human', keys: ['workspace.read'] })
			const url = `${origin}/api/views/${VIEW_ID}/metadata`
			const json = { 'content-type': 'application/json' }
			const body = JSON.stringify({ expectedRevision: revision, name: 'Renamed over HTTP' })

			expect((await fetch(url, { method: 'PUT', headers: json, body })).status).toBe(401)
			const denied = await fetch(url, { method: 'PUT', headers: { ...bearer(reader), ...json }, body })
			expect(denied.status).toBe(403)
			expect(await denied.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['views.write'] })
			expect((await runtime.persistence.views.read(VIEW_ID))!.resource.name).toBe('Checkout')

			const renamed = await fetch(url, { method: 'PUT', headers: { ...bearer(editor), ...json }, body })
			expect(renamed.status).toBe(200)
			expect(await renamed.json()).toMatchObject({ status: 'updated', key: VIEW_ID })
			expect((await runtime.persistence.views.read(VIEW_ID))!.resource).toMatchObject({ name: 'Renamed over HTTP', feature: 'checkout' })
		})
	})
})

describe('formal Evidence after a rename (Scenario 01a1537a-5e4b)', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, () => {
	async function captureRecord(ctx: Fixture): Promise<FormalEvidenceRecord> {
		const workspace = await ctx.persistence.workspace.readInspected()
		const locale = (await ctx.persistence.locales.readInspected('en-US'))!
		const view = await ctx.persistence.views.readInspected(VIEW_ID)
		const screenshot = await ctx.persistence.artifacts.put(new TextEncoder().encode('screenshot'))
		const record: FormalEvidenceRecord = {
			schemaVersion: 1,
			kind: 'formal_capture',
			executionContext: { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
			coverage: { complete: true },
			provenance: {
				workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
				resources: [
					{ identity: { type: 'view', id: VIEW_ID }, revision: view!.revision! },
					{ identity: { type: 'workspace', id: 'workspace' }, revision: workspace.revision! },
					{ identity: { type: 'locale', id: 'en-US' }, revision: locale.revision },
				],
				versions: { uiux: '0.1.0' },
				renderInputDigest: renderInputDigest(view!.resource),
			},
			artifactRefs: [screenshot.identity],
			evidenceRefs: [],
			data: {},
		}
		await ctx.persistence.artifacts.put(canonicalJsonBytes(record))
		return record
	}

	/** Freshness as the Evidence list judges it: against every View's current render-input digest. */
	async function stale(ctx: Fixture): Promise<boolean> {
		const [item] = await ctx.app.listEvidence(VIEW_ID)
		const workspace = await ctx.persistence.workspace.readInspected()
		const locales = await ctx.persistence.locales.discover()
		const localeRevisions: Record<string, string> = {}
		for (const locale of locales) localeRevisions[locale] = (await ctx.persistence.locales.readRevision(locale))!
		return evaluateEvidenceStaleness(item!.record, {
			allViews: (await ctx.app.viewRenderInputs()).map(input => ({ key: input.key, renderInputDigest: input.renderInputDigest })),
			workspace: { resource: workspace.resource as never },
			discoveredLocales: locales,
			localeRevisions,
		}).isStale
	}

	it('keeps a formal capture fresh when an Agent renames and retags the View, and an IR change still makes it stale', async () => {
		const ctx = await fixture()
		await captureRecord(ctx)
		expect(await stale(ctx)).toBe(false)

		const mcp = await connectMcp(ctx.app, AGENT)
		try {
			const renamed = await mcp.client.callTool({ name: 'update_view_metadata', arguments: { viewId: VIEW_ID, expectedRevision: (await readView(ctx)).revision, name: 'Pay now', feature: 'payments' } })
			expect(renamed.isError).not.toBe(true)
		}
		finally {
			await mcp.close()
		}
		const after = await readView(ctx)
		expect(after.resource).toMatchObject({ id: VIEW_ID, ir: VIEW.ir, variants: VIEW.variants })
		expect(await stale(ctx)).toBe(false)

		// Control: the same check notices a render-input change.
		const changed = await ctx.app.updateViewStructure({ key: VIEW_ID, expectedRevision: after.revision, ir: { type: 'RootShell', id: 'root', slots: { content: [] } } as ViewResource['ir'], variants: {} })
		expect(changed).toMatchObject({ status: 'updated' })
		expect(await stale(ctx)).toBe(true)
	})
})
