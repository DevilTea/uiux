import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runMigrateCommand } from '../src/cli/migrate'
import { validateReviewThread } from '../src/domain/reviews/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { HostHistoryStore } from '../src/persistence/history/host-store'
import { reviewRelativePath, viewRelativePath, WORKSPACE_ARTIFACTS_DIRECTORY, workspaceRelativePath } from '../src/persistence/paths'
import { acquireServerHold, readActiveServerHold, SERVER_HOLD_RELATIVE_PATH } from '../src/persistence/server-hold'
import {
	CURRENT_WORKSPACE_SCHEMA_VERSION,
	PRODUCT_WORKSPACE_SCHEMA_POLICY,
	WORKSPACE_V1_TO_V2_STEP,
	WORKSPACE_V1_TO_V2_STEP_ID,
	WORKSPACE_V2_TO_V3_STEP,
	WORKSPACE_V2_TO_V3_STEP_ID,
	WORKSPACE_V3_TO_V4_STEP,
	WORKSPACE_V3_TO_V4_STEP_ID,
} from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPOSITORY_ROOT, 'bin', 'uiux.mjs')
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const RESOLVED_REVIEW_ID = '22222222-2222-4222-8222-222222222222'
const OPEN_REVIEW_ID = '33333333-3333-4333-8333-333333333333'
const SUBMISSION_ID = '44444444-4444-4444-8444-444444444444'
const ASSET_ID = '55555555-5555-4555-8555-555555555555'
const TIME = '2026-10-04T06:35:53.025Z'
const LATER = '2026-10-04T06:36:02.699Z'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const v1Manifest = { schemaVersion: 1, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }

function v1ResolvedReview() {
	return {
		id: RESOLVED_REVIEW_ID,
		anchor: { viewId: VIEW_ID, widgetId: 'root' },
		variantNames: [],
		status: 'resolved',
		messages: [{ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', actor: { type: 'human' }, at: TIME, body: 'Add a nav bar?' }],
		submissions: [{
			id: SUBMISSION_ID, actor: { type: 'agent' }, at: TIME, changeDomains: ['view-structure'],
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r_1' }], scope: {},
			evidenceRefs: [{ kind: 'screenshot', evidence: `sha256:${'c'.repeat(64)}` }],
		}],
		history: [
			{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent' }, at: TIME, submissionId: SUBMISSION_ID },
			{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', kind: 'lifecycle', from: 'ready-for-review', to: 'resolved', actor: { type: 'human', displayName: 'Reviewer' }, at: LATER, submissionId: SUBMISSION_ID },
		],
	}
}

function v1OpenReview() {
	return { id: OPEN_REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: [], status: 'open', messages: [], history: [], submissions: [] }
}

const view = {
	id: VIEW_ID,
	name: 'Checkout',
	ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
	variants: {},
	spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
}

/** A v1 Workspace written the way v1 UIUX wrote it (pretty manifest from init, canonical resources). */
async function seedV1Workspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-migration-'))
	roots.push(root)
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await mkdir(join(root, 'reviews'), { recursive: true })
	await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
	await writeFile(join(root, workspaceRelativePath()), `${JSON.stringify(v1Manifest, null, 2)}\n`)
	await writeFile(join(root, viewRelativePath(VIEW_ID)), `${JSON.stringify(view)}\n`)
	await writeFile(join(root, reviewRelativePath(RESOLVED_REVIEW_ID)), `${JSON.stringify(v1ResolvedReview())}\n`)
	await writeFile(join(root, reviewRelativePath(OPEN_REVIEW_ID)), `${JSON.stringify(v1OpenReview())}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'asset.json'), `${JSON.stringify({ id: ASSET_ID, name: 'icon', contentFilename: 'icon.svg', mediaType: 'image/svg+xml' })}\n`)
	await writeFile(join(root, 'assets', ASSET_ID, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
	return root
}

/** Every file under root (ignored runtime state included), as base64 so binary Assets compare exactly. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile()) continue
		const path = relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')
		files[path] = (await readFile(join(root, path))).toString('base64')
	}
	return files
}

const DOGFOOD_ROOT = join(REPOSITORY_ROOT, 'design')
const DOGFOOD_ARTIFACT_SHARDS = join(DOGFOOD_ROOT, WORKSPACE_ARTIFACTS_DIRECTORY, 'sha256')

/**
 * A private copy of the dogfood Workspace for migration replays. Migration changes only the
 * canonical files (manifest, Views, Flows, Reviews, Locales, Assets); the CLI's pre-migration
 * Checkpoint only adds a record and new blobs to the content-addressed artifact store, yet that
 * store holds 142 of the tree's 160 files, spread over 110 shard directories. Copying all of it
 * cost about 4 s under I/O load and pushed these tests past Vitest's 5 s default, so the copy keeps
 * every canonical file and exactly one artifact file (the first by name): enough to still prove
 * that migration leaves the existing store files byte-identical.
 */
async function copyDogfoodWorkspace(prefix: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), prefix))
	roots.push(root)
	const [witnessShard] = (await readdir(DOGFOOD_ARTIFACT_SHARDS)).sort()
	const shard = join(DOGFOOD_ARTIFACT_SHARDS, witnessShard!)
	const [witnessFile] = (await readdir(shard)).sort()
	const witness = join(shard, witnessFile!)
	await cp(DOGFOOD_ROOT, root, {
		recursive: true,
		filter: source => !source.startsWith(`${DOGFOOD_ARTIFACT_SHARDS}${sep}`) || source === shard || source === witness,
	})
	return root
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const path of [workspaceRelativePath(), viewRelativePath(VIEW_ID), reviewRelativePath(RESOLVED_REVIEW_ID), reviewRelativePath(OPEN_REVIEW_ID), `assets/${ASSET_ID}/asset.json`, `assets/${ASSET_ID}/icon.svg`])
		files[path] = await readFile(join(root, path), 'utf8')
	return files
}

describe('product Workspace schema policy v4', () => {
	it('makes schemaVersion 4 current, recognizes 1 to 3, and ships the uiux.v1-to-v2, uiux.v2-to-v3 and uiux.v3-to-v4 steps', async () => {
		const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { uiuxWorkspaceSchemaVersion: number }
		expect(packageJson.uiuxWorkspaceSchemaVersion).toBe(4)
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(4)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion).toBe(4)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions).toEqual([1, 2, 3, 4])
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.map(step => [step.id, step.fromVersion, step.toVersion]))
			.toEqual([[WORKSPACE_V1_TO_V2_STEP_ID, 1, 2], [WORKSPACE_V2_TO_V3_STEP_ID, 2, 3], [WORKSPACE_V3_TO_V4_STEP_ID, 3, 4]])
		expect(WORKSPACE_V1_TO_V2_STEP_ID).toBe('uiux.v1-to-v2')
		expect(WORKSPACE_V2_TO_V3_STEP_ID).toBe('uiux.v2-to-v3')
		expect(WORKSPACE_V3_TO_V4_STEP_ID).toBe('uiux.v3-to-v4')
	})

	it('opens a v1 Workspace as migration_required: readable, v1-decoded, and every Review mutation blocked', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 1, targetVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		const read = await persistence.reviews.readInspected(RESOLVED_REVIEW_ID)
		expect(read?.diagnostics).toEqual([])

		const app = createWorkspaceApplicationSession(persistence)
		const blocked = await app.appendReviewMessage({ reviewId: RESOLVED_REVIEW_ID, expectedRevision: read!.revision, actor: { type: 'human' }, body: 'hi' })
		expect(blocked).toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		expect(await app.createReviewThread({ anchor: { viewId: VIEW_ID, widgetId: 'root' } })).toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		const openRead = await persistence.reviews.read(OPEN_REVIEW_ID)
		expect(await app.resolveReviewThread({ reviewId: OPEN_REVIEW_ID, expectedRevision: openRead!.revision, actor: { type: 'human' }, resolution: 'answered' }))
			.toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		expect(await app.setReviewDisplayHint({ reviewId: OPEN_REVIEW_ID, expectedRevision: openRead!.revision, displayHint: { pin: { x: 0.5, y: 0.5 } } }))
			.toMatchObject({ status: 'blocked', code: 'workspace.migration_required' })
		expect(await snapshotFiles(root)).toEqual(before)
	})

	it('plans a dry run in memory without writing anything', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const plan = await persistence.planWorkspaceMigration()
		expect(plan).toMatchObject({ fromVersion: 1, version: 4, steps: ['uiux.v1-to-v2', 'uiux.v2-to-v3', 'uiux.v3-to-v4'] })
		expect(plan.changedFiles).toEqual(['.uiux/workspace.json', reviewRelativePath(RESOLVED_REVIEW_ID)])
		expect(await snapshotFiles(root)).toEqual(before)
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('migration_required')
		expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
	})

	it('migrates v1 fixtures: bumps the manifest, backfills verified on v1 resolves only, and leaves other files byte-identical', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 1, version: 4, steps: ['uiux.v1-to-v2', 'uiux.v2-to-v3', 'uiux.v3-to-v4'] })
		expect(result.changedFiles).toEqual(['.uiux/workspace.json', reviewRelativePath(RESOLVED_REVIEW_ID)])
		const after = await snapshotFiles(root)
		expect(JSON.parse(after[workspaceRelativePath()]!)).toEqual({ ...v1Manifest, schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		expect(result.revision).toBe((await persistence.workspace.read('workspace'))?.revision)

		const migrated = JSON.parse(after[reviewRelativePath(RESOLVED_REVIEW_ID)]!) as ReturnType<typeof v1ResolvedReview>
		const expected = v1ResolvedReview()
		expected.history[1] = { ...expected.history[1]!, resolution: 'verified' } as typeof expected.history[number]
		expect(migrated).toEqual(expected)
		expect(migrated.history[0]).not.toHaveProperty('resolution')
		expect(validateReviewThread(migrated, { schemaVersion: 2 }).ok).toBe(true)
		expect(validateReviewThread(migrated, { schemaVersion: 3 }).ok).toBe(true)
		expect(validateReviewThread(migrated, { schemaVersion: 4 }).ok).toBe(true)

		for (const unchanged of [viewRelativePath(VIEW_ID), reviewRelativePath(OPEN_REVIEW_ID), `assets/${ASSET_ID}/asset.json`, `assets/${ASSET_ID}/icon.svg`])
			expect(after[unchanged]).toBe(before[unchanged])
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('current')
		expect((await persistence.reviews.readInspected(RESOLVED_REVIEW_ID))?.diagnostics).toEqual([])
	})

	it('is deterministic and idempotent', async () => {
		const first = await seedV1Workspace()
		const second = await seedV1Workspace()
		const a = await new FileNativePersistence({ root: first, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).migrateWorkspace()
		const b = await new FileNativePersistence({ root: second, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).migrateWorkspace()
		expect(a.revision).toBe(b.revision)
		expect(await snapshotFiles(first)).toEqual(await snapshotFiles(second))

		const persistence = new FileNativePersistence({ root: first, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const settled = await snapshotFiles(first)
		expect(await persistence.planWorkspaceMigration()).toMatchObject({ fromVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, version: CURRENT_WORKSPACE_SCHEMA_VERSION, steps: [], changedFiles: [] })
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: CURRENT_WORKSPACE_SCHEMA_VERSION, steps: [], changedFiles: [], revision: a.revision })
		expect(await snapshotFiles(first)).toEqual(settled)

		// Applying the step to its own output is refused rather than silently re-applied.
		const snapshot = new Map([[workspaceRelativePath(), new TextEncoder().encode(settled[workspaceRelativePath()]!)]])
		expect(() => WORKSPACE_V1_TO_V2_STEP.apply(snapshot)).toThrow(/schemaVersion 1/)
		expect(() => WORKSPACE_V2_TO_V3_STEP.apply(snapshot)).toThrow(/schemaVersion 2/)
		expect(() => WORKSPACE_V3_TO_V4_STEP.apply(snapshot)).toThrow(/schemaVersion 3/)
	})

	it('carries pre-existing v1 Review diagnostics through migration instead of masking them', async () => {
		const root = await seedV1Workspace()
		const broken = { ...v1ResolvedReview(), history: [v1ResolvedReview().history[0]!, { ...v1ResolvedReview().history[1]!, actor: { type: 'agent' } }] }
		await writeFile(join(root, reviewRelativePath(RESOLVED_REVIEW_ID)), `${JSON.stringify(broken)}\n`)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.reviews.readInspected(RESOLVED_REVIEW_ID))?.diagnostics.map(item => item.code)).toEqual(['review.resolve_requires_human'])
		await persistence.migrateWorkspace()
		expect((await persistence.reviews.readInspected(RESOLVED_REVIEW_ID))?.diagnostics.map(item => item.code)).toEqual(['review.resolve_requires_human'])
	})

	it('refuses to migrate a Workspace with syntactically invalid canonical JSON and writes nothing', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		await writeFile(join(root, 'reviews', '66666666-6666-4666-8666-666666666666.review.json'), '{ not json')
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await expect(persistence.planWorkspaceMigration()).rejects.toMatchObject({ code: 'persistence.invalid_json' })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'persistence.invalid_json' })
		expect(await snapshotFiles(root)).toEqual(before)
	})
})

describe('uiux migrate CLI', () => {
	it('lists migrate in honest help text and validates its arguments', () => {
		const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
		expect(help).toContain('migrate --workspace <dir> [--dry-run]')
		expect(help).toMatch(/a real run first writes the Checkpoint "Before migration to\s+schemaVersion 4"/u)
		expect(help).toMatch(/--dry-run prints the steps and changed\s+files without writing anything/u)
		for (const args of [['migrate'], ['migrate', '--workspace'], ['migrate', '--dry-run'], ['migrate', '--workspace', '.', 'extra'], ['migrate', '--workspace', '.', '--dry-run', '--dry-run']]) {
			const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('uiux: migrate requires --workspace <dir> and accepts --dry-run.')
		}
		const missing = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', join(tmpdir(), 'uiux-definitely-missing-workspace')], { encoding: 'utf8' })
		expect(missing.status).toBe(2)
		expect(missing.stderr).toContain('Workspace root does not exist')
	})

	it('initializes new Workspaces at the current schemaVersion, which migrate reports as already current', async () => {
		const parent = await mkdtemp(join(tmpdir(), 'uiux-init-current-'))
		roots.push(parent)
		const root = join(parent, 'design')
		execFileSync(process.execPath, [CLI, 'init', '--workspace', root], { encoding: 'utf8' })
		expect(JSON.parse(await readFile(join(root, workspaceRelativePath()), 'utf8')).schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
		expect((await new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).inspectWorkspace()).inspection.state).toBe('current')
		const migrate = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root, '--dry-run'], { encoding: 'utf8' })
		expect(migrate.status).toBe(0)
		expect(migrate.stdout).toContain(`already at schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}`)
	})

	it('prints the dry-run plan, then migrates with the new manifest revision, then reports already current', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const dryRun = spawnSync(process.execPath, [CLI, 'migrate', '--dry-run', '--workspace', root], { encoding: 'utf8' })
		expect(dryRun.status).toBe(0)
		expect(dryRun.stdout).toContain('dry run, nothing written')
		expect(dryRun.stdout).toContain('schemaVersion: 1 -> 4')
		expect(dryRun.stdout).toContain('steps: uiux.v1-to-v2, uiux.v2-to-v3, uiux.v3-to-v4')
		expect(dryRun.stdout).toContain(`    ${reviewRelativePath(RESOLVED_REVIEW_ID)}`)
		expect(dryRun.stdout).not.toContain('manifest revision')
		expect(await snapshotFiles(root)).toEqual(before)

		const real = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(real.status).toBe(0)
		expect(real.stdout).toContain(`Migrated UIUX Workspace ${root}`)
		expect(real.stdout).toContain('changedFiles (2):')
		const revision = (await new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).workspace.read('workspace'))?.revision
		expect(real.stdout).toContain(`manifest revision: ${revision}`)

		const again = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(again.status).toBe(0)
		expect(again.stdout).toContain(`is already at schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}; nothing to migrate.`)
	})

	it('refuses the real run while a live UIUX server holds the Workspace, and ignores a stale hold', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const hold = await acquireServerHold(root)
		expect(hold).toBeDefined()
		expect(await readActiveServerHold(root)).toMatchObject({ pid: process.pid })
		const lines: string[] = []
		const refused = await runMigrateCommand({ workspaceRoot: root, dryRun: false, stdout: line => lines.push(line), stderr: line => lines.push(line) })
		expect(refused).toBe(1)
		expect(lines.join('\n')).toContain(`a UIUX server (pid ${process.pid}`)
		expect(await snapshotFiles(root)).toEqual(before)

		lines.length = 0
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(0)
		expect(lines.join('\n')).toContain('stop it before the real run')
		await hold!.release()
		expect(await readActiveServerHold(root)).toBeUndefined()

		await writeFile(join(root, SERVER_HOLD_RELATIVE_PATH), JSON.stringify({ pid: 2_000_000_000, hostname: hostname(), startedAt: TIME, token: 'stale' }))
		expect(await readActiveServerHold(root)).toBeUndefined()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, stdout: () => undefined, stderr: () => undefined })).toBe(0)
		expect((await new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).inspectWorkspace()).inspection.state).toBe('current')
	})

	it('finds nothing to migrate in a copy of the current dogfood Workspace, whose Reviews all read without diagnostics', async () => {
		const root = await copyDogfoodWorkspace('uiux-dogfood-migration-')
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 4, version: 4, steps: [], changedFiles: [] })
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('current')
		for (const key of await persistence.reviews.discoverKeys())
			expect((await persistence.reviews.readInspected(key))?.diagnostics).toEqual([])
	})

	// Three real CLI runs (each bundles the command with esbuild in a fresh Node process) plus an
	// fsynced migration transaction: about 0.6 s alone, close to 4 s under CPU and I/O load.
	it('replays the dogfood uiux.v3-to-v4 migration through the CLI: one step, only the manifest changes, a pre-migration Checkpoint and a system version are recorded, re-runs are no-ops', { timeout: HEAVY_SERVER_SUITE_TIMEOUT_MS }, async () => {
		const root = await copyDogfoodWorkspace('uiux-dogfood-v3-to-v4-')
		// The committed dogfood Workspace was migrated by this step; restore its v3 manifest in the copy.
		const manifestPath = join(root, workspaceRelativePath())
		const current = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>
		await writeFile(manifestPath, `${JSON.stringify({ ...current, schemaVersion: 3 })}\n`)
		const before = await snapshotTree(root)
		expect(Object.keys(before).filter(path => path.startsWith(`${WORKSPACE_ARTIFACTS_DIRECTORY}/`))).toHaveLength(1)

		const dryRun = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root, '--dry-run'], { encoding: 'utf8' })
		expect(dryRun.status).toBe(0)
		expect(dryRun.stdout).toContain('schemaVersion: 3 -> 4')
		expect(dryRun.stdout).toContain(`steps: ${WORKSPACE_V3_TO_V4_STEP_ID}\n`)
		expect(dryRun.stdout).toContain(`changedFiles (1):\n    ${workspaceRelativePath()}`)
		expect(await snapshotTree(root)).toEqual(before)

		// Its own UIUX_HOME, so the host history the real run records can be inspected (and nothing else shares it).
		const home = join(await mkdtemp(join(tmpdir(), 'uiux-dogfood-v3-to-v4-home-')), 'home')
		roots.push(dirname(home))
		expect(spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root, '--dry-run'], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } }).status).toBe(0)
		expect(await snapshotTree(root)).toEqual(before)
		expect(await readdir(home).catch(() => undefined)).toBeUndefined()

		const real = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(real.status).toBe(0)
		const after = await snapshotTree(root)
		// Besides the manifest, the run adds only the pre-migration Checkpoint and the blobs it names.
		const added = Object.keys(after).filter(path => !(path in before))
		const [checkpointFile, ...otherCheckpoints] = added.filter(path => path.startsWith('.uiux/history/checkpoints/'))
		expect(otherCheckpoints).toEqual([])
		expect(added.filter(path => path !== checkpointFile).every(path => path.startsWith(`${WORKSPACE_ARTIFACTS_DIRECTORY}/sha256/`))).toBe(true)
		expect(Object.keys(before).filter(path => after[path] !== before[path])).toEqual([workspaceRelativePath()])
		const checkpoint = JSON.parse(Buffer.from(after[checkpointFile!]!, 'base64').toString('utf8')) as Record<string, unknown>
		expect(checkpoint).toMatchObject({ type: 'checkpoint', name: 'Before migration to schemaVersion 4', actor: { type: 'system', id: 'system:migrate' }, source: 'cli', workspaceSchemaVersion: 3 })
		expect(real.stdout).toContain(`pre-migration Checkpoint: ${String(checkpoint.id)} (Before migration to schemaVersion 4)`)
		const systemVersion = /system version: (?<id>\S+)/u.exec(real.stdout)?.groups?.id
		const host = await HostHistoryStore.open({ paths: hostHistoryPaths(home, await realpath(root)) })
		expect((await host!.listVersions()).records.map(version => [version.id, version.type, version.actor, version.workspaceSchemaVersion]))
			.toEqual([[systemVersion, 'system', { type: 'system', id: 'system:migrate' }, 4]])
		expect(JSON.parse(await readFile(manifestPath, 'utf8'))).toEqual({ ...current, schemaVersion: 4 })
		expect(await readFile(manifestPath, 'utf8')).toBe(await readFile(join(REPOSITORY_ROOT, 'design', workspaceRelativePath()), 'utf8'))

		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'current', version: 4 })
		for (const key of await persistence.reviews.discoverKeys())
			expect((await persistence.reviews.readInspected(key))?.diagnostics).toEqual([])

		const again = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(again.status).toBe(0)
		expect(again.stdout).toContain('is already at schemaVersion 4; nothing to migrate.')
		expect(await snapshotTree(root)).toEqual(after)
		expect((await host!.listVersions()).records).toHaveLength(1)
	})
})
