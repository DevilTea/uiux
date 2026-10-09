import { readdirSync } from 'node:fs'
import { lstat, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import type { ViewSpecContent } from '../src/application/services/view-authoring'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runMigrateCommand } from '../src/cli/migrate'
import type { CheckpointRecord, VersionRecord } from '../src/domain/history/schema'
import { FileNativePersistence, viewRelativePath, workspaceRelativePath, type PersistenceFaultHook } from '../src/persistence'
import { CheckpointStore, HostHistoryStore } from '../src/persistence/history'
import { defineWorkspaceSchemaPolicy, type WorkspaceMigrationStep, type WorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { acquireServerHold } from '../src/persistence/server-hold'
import {
	PRODUCT_WORKSPACE_SCHEMA_POLICY,
	WORKSPACE_V1_TO_V2_STEP,
	WORKSPACE_V2_TO_V3_STEP,
	WORKSPACE_V3_TO_V4_STEP,
} from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { scoped, testMember } from './support/access'

/**
 * `uiux migrate` and version history (issue #132 B7): Rules 01a11a5e-0b23-7d4f-954a-26fcde4a8014
 * and 01a11a5e-0422-78fe-b28b-d877417932e9; Clauses 01a1144e-5605-722c-a662-2b483ddaad73 and
 * 01a11a5e-22ca-756e-8128-8f730ca887c9. Every test runs against its own temporary Workspace and
 * its own temporary UIUX_HOME (AGENTS.md).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const CHECKPOINTS_DIR = '.uiux/history/checkpoints'
const AGENT = testMember({ memberId: 'agent-1', nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })

/** The policy under which schemaVersion 3 was current, so a v3 server can run and record history. */
const V3_POLICY = defineWorkspaceSchemaPolicy({ currentVersion: 3, recognizedVersions: [1, 2, 3], steps: [WORKSPACE_V1_TO_V2_STEP, WORKSPACE_V2_TO_V3_STEP] })

/** The product policy with its last step replaced. */
function productPolicyWith(lastStep: WorkspaceMigrationStep): WorkspaceSchemaPolicy {
	return defineWorkspaceSchemaPolicy({ ...PRODUCT_WORKSPACE_SCHEMA_POLICY, steps: [WORKSPACE_V1_TO_V2_STEP, WORKSPACE_V2_TO_V3_STEP, lastStep] })
}

/** Timers never fire: the recorder of a crashed server must not close anything on its own later. */
const FROZEN_TIMERS: HistoryRecorderClock = { now: () => Date.now(), setTimeout: () => 0, clearTimeout: () => undefined }

const cleanup: string[] = []
afterEach(async () => {
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

/** A Workspace with one View at `schemaVersion`, and a private UIUX_HOME that does not exist yet. */
async function seed(schemaVersion: number) {
	const root = await tempDir('uiux-history-cli-ws-')
	const home = join(await tempDir('uiux-history-cli-home-'), 'home')
	const policy = schemaVersion === 3 ? V3_POLICY : PRODUCT_WORKSPACE_SCHEMA_POLICY
	const persistence = new FileNativePersistence({ root, schemaPolicy: policy })
	await persistence.workspace.create({ schemaVersion, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	const app = createWorkspaceApplicationSession(persistence)
	expect((await app.createView({ id: VIEW_ID, name: 'Checkout', spec: spec('Pay') })).status).toBe('created')
	return { root, home, persistence, app }
}

async function migrate(options: Readonly<{ root: string; home: string; dryRun?: boolean; schemaPolicy?: WorkspaceSchemaPolicy; fault?: PersistenceFaultHook }>) {
	const out: string[] = []
	const err: string[] = []
	const code = await runMigrateCommand({
		workspaceRoot: options.root,
		dryRun: options.dryRun ?? false,
		home: options.home,
		stdout: line => out.push(line),
		stderr: line => err.push(line),
		...(options.schemaPolicy ? { schemaPolicy: options.schemaPolicy } : {}),
		...(options.fault ? { fault: options.fault } : {}),
	})
	return { code, out: out.join('\n'), err: err.join('\n') }
}

/** Every file under `root`, as base64. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
		files[path] = (await readFile(join(root, path))).toString('base64')
	}
	return files
}

/** The canonical files a migration may change, as base64. */
async function canonicalFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const path of [workspaceRelativePath(), viewRelativePath(VIEW_ID)]) files[path] = (await readFile(join(root, path))).toString('base64')
	return files
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

async function hostStore(home: string, root: string): Promise<HostHistoryStore | undefined> {
	return HostHistoryStore.open({ paths: hostHistoryPaths(home, root) })
}

function revisionOf(version: VersionRecord, kind: string, key: string): string | undefined {
	return version.resources.find(resource => resource.kind === kind && resource.key === key)?.revision
}

describe('uiux migrate records history', () => {
	it('closes a leftover autosave and records outside changes, writes the pre-migration Checkpoint before any step, then a system version', async () => {
		const { root, home, persistence, app } = await seed(3)
		// A v3 server ran on this host: it wrote the Baseline, then an Agent edited a View, then the
		// server was killed with the autosave still open in open.json.
		const host = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root), create: true }))!
		const checkpoints = new CheckpointStore(persistence)
		const recorder = createHistoryRecorder({ persistence, stores: async () => ({ host, checkpoints }), clock: FROZEN_TIMERS, log: () => undefined })
		const started = await recorder.start()
		expect(started.baseline).toBeDefined()
		const edited = await scoped(app, AGENT, { transport: 'mcp', history: recorder }).updateViewSpec({ key: VIEW_ID, expectedRevision: (await persistence.views.readRevision(VIEW_ID))!, spec: spec('Pay now') })
		expect(edited).toMatchObject({ status: 'updated' })
		expect((await host.readOpenJournal())!.entries.map(entry => entry.type)).toEqual(['begin', 'event'])
		persistence.setWriteObserver(undefined)
		// Then someone edited the View in a text editor.
		const viewPath = join(root, viewRelativePath(VIEW_ID))
		await writeFile(viewPath, `${JSON.stringify({ ...JSON.parse(await readFile(viewPath, 'utf8')) as object, name: 'Checkout (edited)' }, null, '\t')}\n`)
		const editedOutside = (await persistence.views.readRevision(VIEW_ID))!
		const manifestBefore = (await persistence.workspace.read('workspace'))!.revision

		let checkpointsAtStep: string[] | undefined
		const observing = productPolicyWith({
			...WORKSPACE_V3_TO_V4_STEP,
			apply(snapshot) {
				checkpointsAtStep = readdirSync(join(root, CHECKPOINTS_DIR)).sort()
				return WORKSPACE_V3_TO_V4_STEP.apply(snapshot)
			},
		})
		const result = await migrate({ root, home, schemaPolicy: observing })
		expect(result).toMatchObject({ code: 0, err: '' })

		const hostVersions = (await host.listVersions()).records
		expect(hostVersions.map(version => version.type)).toEqual(['autosave', 'external', 'system'])
		const [autosave, external, system] = hostVersions
		expect(autosave).toMatchObject({ actor: { type: 'agent', id: 'member:agent-1' }, events: [{ operation: 'updateViewSpec', source: 'mcp' }], workspaceSchemaVersion: 3 })
		expect(external).toMatchObject({ actor: { type: 'external' }, parent: autosave!.id, workspaceSchemaVersion: 3 })
		expect(revisionOf(external!, 'view', VIEW_ID)).toBe(editedOutside)
		expect(await host.readOpenJournal()).toBeUndefined()

		const records = (await checkpoints.list()).records
		expect(records.map(record => record.name)).toEqual(['Baseline', 'Before migration to schemaVersion 4'])
		const checkpoint = records[1] as CheckpointRecord
		expect(checkpoint).toMatchObject({
			type: 'checkpoint',
			actor: { type: 'system', id: 'system:migrate' },
			source: 'cli',
			workspaceSchemaVersion: 3,
			parentCheckpoint: started.baseline,
		})
		expect(revisionOf(checkpoint, 'workspace', 'workspace')).toBe(manifestBefore)
		expect(revisionOf(checkpoint, 'view', VIEW_ID)).toBe(editedOutside)
		// Rule 01a11a5e-0b23: written before any step ran, outside every step.
		expect(checkpointsAtStep).toEqual([`${started.baseline}.json`, `${checkpoint.id}.json`].sort())

		const manifestAfter = (await new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).workspace.read('workspace'))!.revision
		expect(system).toMatchObject({
			type: 'system',
			actor: { type: 'system', id: 'system:migrate' },
			parent: external!.id,
			startedAt: checkpoint.at,
			netChange: true,
			events: [],
			workspaceSchemaVersion: 4,
		})
		expect(revisionOf(system!, 'workspace', 'workspace')).toBe(manifestAfter)
		expect(revisionOf(system!, 'view', VIEW_ID)).toBe(editedOutside)
		expect(Date.parse(autosave!.at)).toBeLessThan(Date.parse(external!.at))
		expect(Date.parse(external!.at)).toBeLessThan(Date.parse(checkpoint.at))
		expect(Date.parse(checkpoint.at)).toBeLessThan(Date.parse(system!.at))

		expect(result.out).toContain(`manifest revision: ${manifestAfter}`)
		expect(result.out).toContain(`history: closed the leftover autosave ${autosave!.id}`)
		expect(result.out).toContain(`history: recorded changes outside UIUX as ${external!.id}`)
		expect(result.out).toContain(`pre-migration Checkpoint: ${checkpoint.id} (Before migration to schemaVersion 4)`)
		expect(result.out).toContain(`system version: ${system!.id}`)

		// The next server start finds the timeline explaining the Workspace: no Baseline, no drift.
		const current = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const next = createHistoryRecorder({ persistence: current, stores: async () => ({ host, checkpoints: new CheckpointStore(current) }), clock: FROZEN_TIMERS, log: () => undefined })
		expect(await next.start()).toMatchObject({ enabled: true, boundary: { reason: 'start' } })
		expect((await host.listVersions()).records).toHaveLength(3)
		expect((await checkpoints.list()).records).toHaveLength(2)
		await next.stop()
	})

	it('writes the Checkpoint and the system version on a host with no history yet', async () => {
		const { root, home } = await seed(3)
		const result = await migrate({ root, home })
		expect(result.code).toBe(0)
		const host = (await hostStore(home, root))!
		const [system, ...others] = (await host.listVersions()).records
		expect(others).toEqual([])
		expect(system).toMatchObject({ type: 'system', actor: { id: 'system:migrate' }, netChange: true })
		expect(system).not.toHaveProperty('parent')
		const [checkpoint] = (await new CheckpointStore(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })).list()).records
		expect(checkpoint).toMatchObject({ name: 'Before migration to schemaVersion 4', actor: { type: 'system', id: 'system:migrate' }, source: 'cli', workspaceSchemaVersion: 3 })
		expect(checkpoint).not.toHaveProperty('parentCheckpoint')
		// Every blob either side names is on the host, as the recorder expects of its recorded state.
		for (const version of [checkpoint!, system!])
			for (const resource of version.resources)
				for (const digest of Object.values(resource.files)) expect(await host.hasBlob(digest)).toBe(true)
	})

	it('leaves the Checkpoint in place and the canonical files unchanged when a step fails or the transaction is interrupted', async () => {
		const failingStep = productPolicyWith({ ...WORKSPACE_V3_TO_V4_STEP, apply() { throw new Error('injected step failure') } })
		let interrupted = false
		const interruption: PersistenceFaultHook = (point, details) => {
			if (!interrupted && point === 'migration.before_apply' && details.index === 0) {
				interrupted = true
				throw new Error('injected apply interruption')
			}
		}
		for (const failure of [{ schemaPolicy: failingStep }, { fault: interruption }]) {
			const { root, home } = await seed(3)
			const before = await canonicalFiles(root)
			const result = await migrate({ root, home, ...failure })
			expect(result.code).toBe(1)
			expect(result.err).toContain('migrate failed (workspace.migration_failed)')
			const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
			const [checkpoint, ...others] = (await new CheckpointStore(persistence).list()).records
			expect(others).toEqual([])
			expect(checkpoint).toMatchObject({ name: 'Before migration to schemaVersion 4', actor: { id: 'system:migrate' }, workspaceSchemaVersion: 3 })
			expect(result.err).toContain(`The pre-migration Checkpoint ${checkpoint!.id} stays in the Workspace.`)
			expect(await canonicalFiles(root)).toEqual(before)
			expect((await persistence.inspectWorkspace()).inspection.state).toBe('migration_required')
			// No system version: nothing was migrated.
			expect((await (await hostStore(home, root))!.listVersions()).records).toEqual([])

			// A later run succeeds and writes its own Checkpoint after the one left behind.
			expect((await migrate({ root, home })).code).toBe(0)
			const records = (await new CheckpointStore(persistence).list()).records
			expect(records).toHaveLength(2)
			expect(records[1]).toMatchObject({ parentCheckpoint: checkpoint!.id })
		}
	})

	it('writes nothing at all on a dry run', async () => {
		const { root, home } = await seed(3)
		const before = await snapshotTree(root)
		const result = await migrate({ root, home, dryRun: true })
		expect(result).toMatchObject({ code: 0 })
		expect(result.out).toContain('dry run, nothing written')
		expect(result.out).not.toContain('Checkpoint')
		expect(await snapshotTree(root)).toEqual(before)
		expect(await exists(join(root, CHECKPOINTS_DIR))).toBe(false)
		expect(await exists(home)).toBe(false)
	})

	it('writes nothing for a Workspace already at the current schemaVersion', async () => {
		const { root, home } = await seed(4)
		const before = await snapshotTree(root)
		const result = await migrate({ root, home })
		expect(result).toMatchObject({ code: 0, err: '' })
		expect(result.out).toContain('is already at schemaVersion 4; nothing to migrate.')
		expect(await snapshotTree(root)).toEqual(before)
		expect(await exists(home)).toBe(false)
	})

	it('writes nothing when a server holds the Workspace or the Checkpoint cannot be written', async () => {
		const { root, home } = await seed(3)
		const hold = (await acquireServerHold(root))!
		const before = await snapshotTree(root)
		expect((await migrate({ root, home })).code).toBe(1)
		await hold.release()
		expect(await exists(home)).toBe(false)
		expect(await exists(join(root, CHECKPOINTS_DIR))).toBe(false)

		// UIUX_HOME inside the Workspace: host history would travel with it, so no step runs.
		const inside = await migrate({ root, home: join(root, 'home') })
		expect(inside.code).toBe(1)
		expect(inside.err).toContain('the pre-migration Checkpoint could not be written, so no step ran')
		expect(await canonicalFiles(root)).toEqual(Object.fromEntries(Object.entries(before).filter(([path]) => path === workspaceRelativePath() || path === viewRelativePath(VIEW_ID))))
		expect(await exists(join(root, CHECKPOINTS_DIR))).toBe(false)
	})
})
