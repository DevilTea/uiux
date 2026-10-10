import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createApp, createRouter, toNodeListener } from 'h3'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import diffRoute from '../server/api/history/diff.get'
import { authorizeOperation } from '../src/application/access/policy'
import { createWorkspaceApplicationSession, type WorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { VersionDiffOutcome, VersionDiffResult } from '../src/application/services/history-diff'
import type { CheckpointRecord, HistoryResourceEntry, HostVersionRecord } from '../src/domain/history/schema'
import {
	FileNativePersistence,
	canonicalJsonBytes,
	defineWorkspaceSchemaPolicy,
	layoutForSchemaVersion,
	localeRelativePath,
	viewRelativePath,
	workspaceRelativePath,
	type WorkspaceSnapshot,
} from '../src/persistence'
import { CheckpointStore, versionResourcesFromSnapshot } from '../src/persistence/history'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createAccessGuardHandler } from '../src/server/access/http'
import { createHistoryStoreFactory, type HistoryStores } from '../src/server/history-stores'
import { diffVersionsForHttp } from '../src/server/history-http'
import { closeSelectedWorkspaceServerRuntime, getSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { bearer, connectMcp, provisionToken, scoped, testMember } from './support/access'
import { writeManifest } from './support/workspace-layout'

/**
 * Version comparison through the service, `GET /api/history/diff` and MCP `get_version_diff`
 * (Feature 01a11a5d-fd13-7f52-918c-af3a73e5bb6e, Clauses 01a11a5e-2710-70b7-b63b-82f27236b1cd,
 * 01a11a5e-23cd-718c-b4db-807f823238ed and 01a11a5e-2434-7342-a3c1-6d63aa74334c).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const ASSET_ID = '44444444-4444-4444-8444-444444444444'
const HUMAN = { type: 'human', id: 'member:m-owner', displayName: 'deviltea' } as const
const AGENT = { type: 'agent', id: 'member:m-agent', displayName: 'claude' } as const
const VIEWER = testMember({ nickname: 'vera', kind: 'human', role: 'viewer', credential: 'session' })
const AGENT_VIEWER = testMember({ nickname: 'watcher', kind: 'agent', role: 'viewer', credential: 'token' })

const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

type Context = Readonly<{ root: string; persistence: FileNativePersistence; stores: HistoryStores; app: WorkspaceApplicationSession }>

const MANIFEST = { schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: { desktop: { label: 'Desktop', dimensions: { width: 1280, height: 800 } } }, themes: {} }

async function workspace(): Promise<Context> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-diff-')))
	const home = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-diff-home-')))
	cleanup.push(root, home)
	// Hand-written (not canonical) JSON, as a Workspace edited outside UIUX has.
	await writeManifest(root, `${JSON.stringify(MANIFEST, null, 2)}\n`)
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await writeView(root, view())
	await persistence.locales.create('en-US', { greeting: 'Hello' })
	await persistence.assets.create(ASSET_ID, { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' }, content: Buffer.from('png-1') })
	const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
	const stores = (await history.open())!
	return { root, persistence, stores, app: createWorkspaceApplicationSession(persistence, { history }) }
}

function view(overrides: Record<string, unknown> = {}) {
	return {
		id: VIEW_ID,
		name: 'Checkout',
		ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'title', type: 'Text', config: { text: { $i18n: 'greeting' } } }] } },
		variants: {},
		spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
		...overrides,
	}
}

async function writeView(root: string, value: unknown): Promise<void> {
	await mkdir(join(root, 'views'), { recursive: true })
	await writeFile(join(root, viewRelativePath(VIEW_ID)), `${JSON.stringify(value, null, 2)}\n`)
}

type RecordOptions = Readonly<{
	at: string
	edit?: (snapshot: Map<string, Uint8Array>) => void
	workspaceSchemaVersion?: number
	resources?: (resources: HistoryResourceEntry[]) => HistoryResourceEntry[]
	parentCheckpoint?: string
}>

/** Records the Workspace's current files (optionally edited) as a checkpoint or a host autosave. */
async function record(ctx: Context, type: 'checkpoint' | 'autosave', options: RecordOptions): Promise<string> {
	const snapshot = await ctx.persistence.withReadLock(() => ctx.persistence.scanVersionedSnapshotUnlocked())
	options.edit?.(snapshot)
	const built = versionResourcesFromSnapshot(snapshot)
	const resources = options.resources ? options.resources([...built.resources]) : [...built.resources]
	const base = { historySchemaVersion: 1 as const, id: randomUUID(), at: options.at, workspaceSchemaVersion: options.workspaceSchemaVersion ?? 4, resources }
	if (type === 'checkpoint') {
		const checkpoint: CheckpointRecord = { ...base, type: 'checkpoint', actor: HUMAN, name: `Checkpoint at ${options.at}`, source: 'workbench', ...(options.parentCheckpoint ? { parentCheckpoint: options.parentCheckpoint } : {}) }
		await ctx.stores.checkpoints.create(checkpoint, built.blobs)
		return checkpoint.id
	}
	for (const bytes of built.blobs.values()) await ctx.stores.host.putBlob(bytes)
	const version: HostVersionRecord = { ...base, type: 'autosave', actor: AGENT, startedAt: options.at, netChange: true, events: [] }
	await ctx.stores.host.writeVersion(version)
	return version.id
}

const json = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`)

function compared(outcome: VersionDiffOutcome): VersionDiffResult {
	expect(outcome.status, JSON.stringify(outcome)).toBe('compared')
	return outcome as VersionDiffResult
}

function statuses(result: VersionDiffResult): Record<string, string> {
	return Object.fromEntries(result.summary.map(row => [`${row.kind}:${row.key}`, row.status]))
}

describe('diffVersions', () => {
	it('summarizes by revision, adds semantic changes on request, and compares with the live files as current', async () => {
		const ctx = await workspace()
		const first = await record(ctx, 'checkpoint', { at: '2026-10-01T00:00:00.000Z' })
		await writeView(ctx.root, view({ name: 'Pay' }))

		const summary = compared(await ctx.app.diffVersions({ from: first }))
		expect(summary.from).toMatchObject({ id: first, type: 'checkpoint', workspaceSchemaVersion: 4 })
		expect(summary.to).toEqual({ id: 'current', workspaceSchemaVersion: 4 })
		expect(statuses(summary)).toEqual({ [`asset:${ASSET_ID}`]: 'unchanged', 'locale:en-US': 'unchanged', [`view:${VIEW_ID}`]: 'modified', 'workspace:workspace': 'unchanged' })
		expect(summary.changes).toBeUndefined()
		const current = await ctx.persistence.views.readRevision(VIEW_ID)
		expect(summary.summary.find(row => row.kind === 'view')).toMatchObject({ toRevision: current })

		const semantic = compared(await ctx.app.diffVersions({ from: first, to: 'current', detail: 'semantic' }))
		expect(semantic.changes).toEqual([{ kind: 'view', key: VIEW_ID, status: 'modified', diff: expect.objectContaining({ type: 'view', name: { before: 'Checkout', after: 'Pay' } }) }])

		const filtered = compared(await ctx.app.diffVersions({ from: first, resources: [{ kind: 'view', key: VIEW_ID }] }))
		expect(filtered.summary.map(row => row.kind)).toEqual(['view'])
	})

	it('compares two recorded versions, reading host blobs and checkpoint blobs', async () => {
		const ctx = await workspace()
		const checkpoint = await record(ctx, 'checkpoint', { at: '2026-10-01T00:00:00.000Z' })
		await writeView(ctx.root, view({ ir: { type: 'RootShell', id: 'root', slots: { content: [{ id: 'title', type: 'Heading', config: { text: { $i18n: 'title' } } }] } } }))
		await ctx.persistence.locales.compareAndSwap({ key: 'en-US', expectedRevision: (await ctx.persistence.locales.readRevision('en-US'))!, resource: { greeting: 'Hi', title: 'Pay' } })
		const autosave = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z' })
		const result = compared(await ctx.app.diffVersions({ from: checkpoint, to: autosave, detail: 'semantic' }))
		expect(statuses(result)).toMatchObject({ 'locale:en-US': 'modified', [`view:${VIEW_ID}`]: 'modified', 'workspace:workspace': 'unchanged' })
		const byKind = Object.fromEntries(result.changes!.map(change => [change.kind, change.diff]))
		expect(byKind.locale).toEqual({ type: 'locale', messages: { added: [{ key: 'title', value: 'Pay' }], removed: [], changed: [{ key: 'greeting', before: 'Hello', after: 'Hi' }] } })
		expect(byKind.view).toMatchObject({
			widgets: {
				typeChanged: [{ id: 'title', before: 'Text', after: 'Heading' }],
				// The binding stays a reference (Rule 01a11a5e-0e8d-7d8a-84f1-3195ac7719e7).
				configChanged: [{ id: 'title', changes: [{ op: 'replace', path: '/config/text', before: { $i18n: 'greeting' }, after: { $i18n: 'title' } }] }],
			},
		})
	})

	it('resolves a version\'s parent as its predecessor on the merged timeline (Rule 01a11e0d-d550-78e4-9787-f0023bbc1b93)', async () => {
		const ctx = await workspace()
		const first = await record(ctx, 'checkpoint', { at: '2026-10-01T00:00:00.000Z' })
		await writeView(ctx.root, view({ name: 'Two' }))
		const autosave = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z' })
		await writeView(ctx.root, view({ name: 'Three' }))
		// The stored pointer names the earlier checkpoint; the merged predecessor is the autosave.
		const second = await record(ctx, 'checkpoint', { at: '2026-10-03T00:00:00.000Z', parentCheckpoint: first })

		const withParent = compared(await ctx.app.diffVersions({ from: { parentOf: second }, detail: 'semantic' }))
		expect(withParent.from).toMatchObject({ id: autosave, type: 'autosave' })
		expect(withParent.to).toMatchObject({ id: second, type: 'checkpoint' })
		expect(withParent.changes).toEqual([expect.objectContaining({ kind: 'view', diff: expect.objectContaining({ name: { before: 'Two', after: 'Three' } }) })])
		expect(withParent).toEqual(await ctx.app.diffVersions({ from: autosave, to: second, detail: 'semantic' }))

		const firstVersion = compared(await ctx.app.diffVersions({ from: { parentOf: first } }))
		expect(firstVersion.from).toBeNull()
		expect(new Set(firstVersion.summary.map(row => row.status))).toEqual(new Set(['added']))
	})

	it('shows no manifest change across the v3 to v4 migration (Rules 01a11a5e-118c-733d-92d7-27262bfbcd33 and 01a11a5e-1085-71ec-ac82-d60263ae8173)', async () => {
		const ctx = await workspace()
		const manifestV3 = (overrides: Record<string, unknown> = {}) => (snapshot: Map<string, Uint8Array>) => {
			snapshot.set(workspaceRelativePath(), json({ ...MANIFEST, schemaVersion: 3, ...overrides }))
			snapshot.set(viewRelativePath(VIEW_ID), json(view({ name: 'Before migration' })))
		}
		const sameSettings = await record(ctx, 'autosave', { at: '2026-10-01T00:00:00.000Z', workspaceSchemaVersion: 3, edit: manifestV3() })
		const otherLocale = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z', workspaceSchemaVersion: 3, edit: manifestV3({ i18n: { defaultLocale: 'zh-TW' } }) })

		for (const detail of ['summary', 'semantic'] as const) {
			const result = compared(await ctx.app.diffVersions({ from: sameSettings, detail }))
			expect(result.from).toMatchObject({ workspaceSchemaVersion: 3 })
			expect(statuses(result)).toMatchObject({ 'workspace:workspace': 'unchanged', [`view:${VIEW_ID}`]: 'modified', 'locale:en-US': 'unchanged' })
			if (detail === 'semantic') expect(result.changes!.map(change => change.kind)).toEqual(['view'])
		}
		const changed = compared(await ctx.app.diffVersions({ from: otherLocale, detail: 'semantic', resources: [{ kind: 'workspace', key: 'workspace' }] }))
		expect(changed.changes).toEqual([{ kind: 'workspace', key: 'workspace', status: 'modified', diff: { type: 'workspace', defaultLocale: { before: 'zh-TW', after: 'en-US' } } }])
		expect(JSON.stringify(changed)).not.toContain('schemaVersion')
	})

	it('gives the same summary at every detail for two versions recorded under the same older schema', async () => {
		const ctx = await workspace()
		const recordV3 = (at: string, manifestBytes: Uint8Array) => record(ctx, 'autosave', {
			at,
			workspaceSchemaVersion: 3,
			edit: snapshot => snapshot.set(workspaceRelativePath(), manifestBytes),
		})
		// The manifests differ in whitespace only; upgrading both would canonicalize them alike.
		const pretty = await recordV3('2026-10-01T00:00:00.000Z', json({ ...MANIFEST, schemaVersion: 3 }))
		const compact = await recordV3('2026-10-02T00:00:00.000Z', new TextEncoder().encode(`${JSON.stringify({ ...MANIFEST, schemaVersion: 3 })}\n`))
		const summary = compared(await ctx.app.diffVersions({ from: pretty, to: compact }))
		const semantic = compared(await ctx.app.diffVersions({ from: pretty, to: compact, detail: 'semantic' }))
		expect(semantic.summary).toEqual(summary.summary)
		expect(statuses(summary)['workspace:workspace']).toBe('modified')
		expect(semantic.changes).toEqual([{ kind: 'workspace', key: 'workspace', status: 'modified', diff: { type: 'workspace' } }])
	})

	it('upgrades an older side in memory with the policy steps before comparing, so a migration adds no change', async () => {
		const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-diff-upgrade-')))
		const home = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-diff-home-')))
		cleanup.push(root, home)
		// A synthetic 1 -> 2 step that renames a View member, as a real migration could.
		const policy = defineWorkspaceSchemaPolicy({
			currentVersion: 2,
			recognizedVersions: [1, 2],
			steps: [{
				id: 'synthetic-1-to-2',
				fromVersion: 1,
				toVersion: 2,
				apply(snapshot: WorkspaceSnapshot) {
					const next = new Map(snapshot)
					for (const [path, bytes] of snapshot) {
						const value = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
						if (path === workspaceRelativePath()) next.set(path, canonicalJsonBytes({ ...value, schemaVersion: 2 }))
						else if (path.startsWith('views/')) {
							const { title, ...rest } = value
							next.set(path, canonicalJsonBytes({ ...rest, name: title }))
						}
					}
					return next
				},
			}],
		})
		await writeManifest(root, canonicalJsonBytes({ ...MANIFEST, schemaVersion: 2 }), layoutForSchemaVersion(2))
		await mkdir(join(root, 'views'), { recursive: true })
		await writeFile(join(root, viewRelativePath(VIEW_ID)), canonicalJsonBytes(view()))
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy })
		const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
		const ctx: Context = { root, persistence, stores: (await history.open())!, app: createWorkspaceApplicationSession(persistence, { history }) }
		const { name, ...v1View } = view()
		const old = await record(ctx, 'autosave', {
			at: '2026-10-01T00:00:00.000Z',
			workspaceSchemaVersion: 1,
			edit: (snapshot) => {
				snapshot.set(workspaceRelativePath(), canonicalJsonBytes({ ...MANIFEST, schemaVersion: 1 }))
				snapshot.set(viewRelativePath(VIEW_ID), canonicalJsonBytes({ ...v1View, title: name }))
			},
		})
		const result = compared(await ctx.app.diffVersions({ from: old, detail: 'semantic' }))
		expect(statuses(result)).toEqual({ [`view:${VIEW_ID}`]: 'unchanged', 'workspace:workspace': 'unchanged' })
		expect(result.changes).toEqual([])
		// The recorded revisions are reported as recorded.
		expect(result.summary.find(row => row.kind === 'view')!.fromRevision).not.toBe(result.summary.find(row => row.kind === 'view')!.toRevision)
	})

	it('refuses a version recorded under an unrecognized schema with workspace.schema_unsupported (Clause 01a11a5e-2434-7342-a3c1-6d63aa74334c)', async () => {
		const ctx = await workspace()
		const known = await record(ctx, 'autosave', { at: '2026-10-01T00:00:00.000Z' })
		const future = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z', workspaceSchemaVersion: 99 })
		for (const command of [{ from: future }, { from: known, to: future }, { from: { parentOf: future } }])
			expect(await ctx.app.diffVersions(command)).toMatchObject({ status: 'blocked', code: 'workspace.schema_unsupported' })

		// The live Workspace on an unsupported schema: only the comparison with current is refused (Rule 01a11a5e-07c1-70d6-b4fb-69c99be791e3).
		const other = await record(ctx, 'autosave', { at: '2026-10-03T00:00:00.000Z' })
		await writeFile(join(ctx.root, workspaceRelativePath()), `${JSON.stringify({ ...MANIFEST, schemaVersion: 99 })}\n`)
		expect(await ctx.app.diffVersions({ from: known })).toMatchObject({ status: 'blocked', code: 'workspace.schema_unsupported', diagnostics: [{ path: '/to' }] })
		expect(compared(await ctx.app.diffVersions({ from: known, to: other })).summary.every(row => row.status === 'unchanged')).toBe(true)
	})

	it('lists a resource of an unknown kind with its revision status only (open kind set)', async () => {
		const ctx = await workspace()
		const mystery = (revision: string) => (resources: HistoryResourceEntry[]) => [...resources, { kind: 'mystery', key: 'x', revision, files: { 'mystery/x.json': `sha256:${revision.slice(-1).repeat(64)}` } }]
		const before = await record(ctx, 'autosave', { at: '2026-10-01T00:00:00.000Z', resources: mystery('r_a') })
		const after = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z', resources: mystery('r_b') })
		const result = compared(await ctx.app.diffVersions({ from: before, to: after, detail: 'semantic' }))
		expect(result.summary.find(row => row.kind === 'mystery')).toEqual({ kind: 'mystery', key: 'x', status: 'modified', fromRevision: 'r_a', toRevision: 'r_b' })
		expect(result.changes).toEqual([{ kind: 'mystery', key: 'x', status: 'modified', diff: { type: 'unsupported_kind' } }])
	})

	it('refuses unknown versions and malformed requests', async () => {
		const ctx = await workspace()
		const known = await record(ctx, 'autosave', { at: '2026-10-01T00:00:00.000Z' })
		expect(await ctx.app.diffVersions({ from: randomUUID() })).toMatchObject({ status: 'not_found', code: 'history.record_missing', diagnostics: [{ path: '/from' }] })
		expect(await ctx.app.diffVersions({ from: known, to: randomUUID() })).toMatchObject({ status: 'not_found', code: 'history.record_missing', diagnostics: [{ path: '/to' }] })
		for (const command of [{ from: 'parent' }, { from: known, to: 'latest' }, { from: known, detail: 'full' }, { from: known, resources: [{ kind: '', key: 'x' }] }, { from: { parentOf: known }, to: 'current' }])
			expect(await ctx.app.diffVersions(command as never)).toMatchObject({ status: 'invalid', code: 'history.invalid_comparison' })
	})

	it('answers the same over HTTP and MCP, to any Viewer (Rule 01a11a5e-0ddc-7d9d-83b9-5366d0ac44dd)', async () => {
		const ctx = await workspace()
		const first = await record(ctx, 'checkpoint', { at: '2026-10-01T00:00:00.000Z' })
		await writeView(ctx.root, view({ name: 'Pay' }))
		const second = await record(ctx, 'autosave', { at: '2026-10-02T00:00:00.000Z' })
		await ctx.persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: (await ctx.persistence.assets.readRevision(ASSET_ID))!, resource: { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.png', mediaType: 'image/png' }, content: Buffer.from('png-2') } })

		const http = await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: first, detail: 'semantic' })
		expect(http.status).toBe(200)
		const asset = (http.body as VersionDiffResult).changes!.find(change => change.kind === 'asset')!
		expect(asset.diff).toMatchObject({ type: 'asset', content: { before: expect.stringMatching(/^sha256:/u), after: expect.stringMatching(/^sha256:/u) }, image: { before: { mediaType: 'image/png' }, after: { mediaType: 'image/png' } } })
		expect(asset.diff).not.toHaveProperty('metadata')

		const parent = await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: 'parent', to: second, resource: [`view:${VIEW_ID}`, 'workspace:workspace'], detail: 'semantic' })
		expect(parent.status).toBe(200)
		expect(parent.body).toEqual(await ctx.app.diffVersions({ from: { parentOf: second }, resources: [{ kind: 'view', key: VIEW_ID }, { kind: 'workspace', key: 'workspace' }], detail: 'semantic' }))

		const mcp = await connectMcp(ctx.app, AGENT_VIEWER)
		try {
			const tool = (await mcp.client.listTools()).tools.find(item => item.name === 'get_version_diff')!
			expect(tool.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false })
			expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(['detail', 'from', 'resources', 'to'])
			const viaMcp = await mcp.client.callTool({ name: 'get_version_diff', arguments: { from: first, detail: 'semantic' } })
			expect(viaMcp.isError).not.toBe(true)
			expect(viaMcp.structuredContent).toEqual(http.body)
			const filtered = await mcp.client.callTool({ name: 'get_version_diff', arguments: { from: first, to: second, resources: [{ kind: 'view', key: VIEW_ID }] } })
			expect(filtered.structuredContent).toEqual((await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: first, to: second, resource: `view:${VIEW_ID}` })).body)
			const missing = await mcp.client.callTool({ name: 'get_version_diff', arguments: { from: randomUUID() } })
			expect(missing.isError).toBe(true)
			expect(missing.structuredContent).toMatchObject({ status: 'not_found', code: 'history.record_missing' })
			const extra = await mcp.client.callTool({ name: 'get_version_diff', arguments: { from: first, unknown: true } })
			expect(extra.isError).toBe(true)
		}
		finally {
			await mcp.close()
		}

		expect((await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: first, extra: '1' })).status).toBe(400)
		expect((await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: 'parent' })).status).toBe(400)
		const parentOfCurrent = await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: 'parent', to: 'current' })
		expect(parentOfCurrent).toMatchObject({ status: 400, body: { diagnostics: [{ path: '/to', message: expect.stringContaining('needs a version ID in to') }] } })
		expect((await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: first, resource: 'view' })).status).toBe(400)
		expect((await diffVersionsForHttp(scoped(ctx.app, VIEWER), { from: randomUUID() })).status).toBe(404)
	})

	it('finds no version where history is off', async () => {
		const ctx = await workspace()
		const known = await record(ctx, 'checkpoint', { at: '2026-10-01T00:00:00.000Z' })
		const app = createWorkspaceApplicationSession(ctx.persistence)
		expect(await app.diffVersions({ from: known })).toMatchObject({ status: 'not_found', code: 'history.record_missing' })
	})
})

describe('GET /api/history/diff access (Clause 01a11485-f978-767a-b977-33028aee7ae7)', () => {
	let root: string
	let server: Server
	let origin: string
	let checkpointId: string
	const previous = { root: process.env.UIUX_WORKSPACE_ROOT, origin: process.env.UIUX_SERVER_ORIGIN }

	beforeAll(async () => {
		root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-history-diff-http-')))
		await writeManifest(root, `${JSON.stringify(MANIFEST)}\n`)
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, localeRelativePath('en-US')), '{"greeting":"Hello"}\n')
		process.env.UIUX_WORKSPACE_ROOT = root
		const app = createApp()
		app.use(createAccessGuardHandler(() => getSelectedWorkspaceServerRuntime().access()))
		const router = createRouter()
		router.get('/api/history/diff', diffRoute)
		app.use(router)
		server = createServer(toNodeListener(app))
		await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
		origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
		process.env.UIUX_SERVER_ORIGIN = origin

		const runtime = getSelectedWorkspaceServerRuntime()
		const snapshot = await runtime.persistence.withReadLock(() => runtime.persistence.scanVersionedSnapshotUnlocked())
		const built = versionResourcesFromSnapshot(snapshot)
		checkpointId = randomUUID()
		await new CheckpointStore(runtime.persistence).create({ historySchemaVersion: 1, id: checkpointId, type: 'checkpoint', actor: HUMAN, at: '2026-10-01T00:00:00.000Z', workspaceSchemaVersion: 4, resources: built.resources, name: 'Before', source: 'workbench' }, built.blobs)
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

	it('answers a Viewer and refuses the system credential', async () => {
		const viewerToken = await provisionToken(root, { nickname: 'vera', kind: 'human', role: 'viewer' })
		const allowed = await fetch(`${origin}/api/history/diff?from=${checkpointId}&resource=${encodeURIComponent('locale:en-US')}`, { headers: bearer(viewerToken) })
		expect(allowed.status).toBe(200)
		expect(allowed.headers.get('cache-control')).toBe('no-store')
		expect(await allowed.json()).toMatchObject({ status: 'compared', from: { id: checkpointId }, to: { id: 'current' }, summary: [{ kind: 'locale', key: 'en-US', status: 'unchanged' }] })

		const access = await getSelectedWorkspaceServerRuntime().access()
		const refused = await fetch(`${origin}/api/history/diff?from=${checkpointId}`, { headers: { cookie: `${access.cookieName}=${access.captureCredential}` } })
		expect(refused.status).toBe(403)
		expect(await refused.json()).toMatchObject({ status: 'blocked', code: 'auth.scope_denied' })
		for (const id of ['system:capture'] as const)
			expect(authorizeOperation({ type: 'system', id, credential: 'system' }, 'diffVersions')).toMatchObject({ code: 'auth.scope_denied' })

		expect((await fetch(`${origin}/api/history/diff?from=${checkpointId}`)).status).toBe(401)
	})
})

