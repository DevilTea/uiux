import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { builtInAccessPresetsFile } from '../src/domain/access-presets/schema'
import { runMigrateCommand } from '../src/cli/migrate'
import { validateReviewThread } from '../src/domain/reviews/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { reviewRelativePath, viewRelativePath, workspaceRelativePath } from '../src/persistence/paths'
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
	WORKSPACE_V4_TO_V5_STEP_ID,
	WORKSPACE_V5_TO_V6_STEP_ID,
} from '../src/product/workspace-schema'
import { LEGACY_LAYOUT } from '../src/persistence/paths'
import { artifactShardsPath, CURRENT_TEST_LAYOUT, V4_TEST_SCHEMA_POLICY } from './support/workspace-layout'

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

/** The dogfood Workspace: the schemaVersion 5 root `<repo>/.uiux/` since the owner relocated it from `design/` (D1). */
const DOGFOOD_ROOT = join(REPOSITORY_ROOT, '.uiux')
const DOGFOOD_ARTIFACT_SHARDS = artifactShardsPath(DOGFOOD_ROOT)

/**
 * A private copy of the dogfood Workspace, which these tests only read. Migration changes only the
 * canonical files (manifest, Product Kit, Views, Flows, Reviews, Locales, Assets), while the
 * content-addressed artifact store holds most of the tree's files over many shard directories.
 * Copying all of it cost about 4 s under I/O load and pushed these tests past Vitest's 5 s default,
 * so the copy keeps every other file and exactly one artifact file (the first by name).
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

/** The `schemaVersion` of a dogfood copy's manifest. */
async function dogfoodSchemaVersion(root: string): Promise<number> {
	return (JSON.parse(await readFile(join(root, CURRENT_TEST_LAYOUT.manifestPath), 'utf8')) as { schemaVersion: number }).schemaVersion
}

async function snapshotFiles(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	for (const path of [workspaceRelativePath(), viewRelativePath(VIEW_ID), reviewRelativePath(RESOLVED_REVIEW_ID), reviewRelativePath(OPEN_REVIEW_ID), `assets/${ASSET_ID}/asset.json`, `assets/${ASSET_ID}/icon.svg`])
		files[path] = await readFile(join(root, path), 'utf8')
	return files
}

/**
 * The steps from 1 to 4 keep the old layout, so beyond the version facts these runs use a build where
 * schemaVersion 4 is current (`V4_TEST_SCHEMA_POLICY`); `uiux.v4-to-v5` is covered by
 * `workspace-relocation.test.ts`. The dogfood went through it in the owner's relocation to `<repo>/.uiux/`
 * (D1, `scripts/dogfood-relocate.mjs`), and the dogfood tests below read a copy of the result.
 */
describe('product Workspace schema policy', () => {
	it('makes schemaVersion 6 current, recognizes 1 to 5, and ships the uiux.v1-to-v2, uiux.v2-to-v3, uiux.v3-to-v4, uiux.v4-to-v5 and uiux.v5-to-v6 steps', async () => {
		const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8')) as { uiuxWorkspaceSchemaVersion: number }
		expect(packageJson.uiuxWorkspaceSchemaVersion).toBe(6)
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(6)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion).toBe(6)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions).toEqual([1, 2, 3, 4, 5, 6])
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.steps.map(step => [step.id, step.fromVersion, step.toVersion]))
			.toEqual([[WORKSPACE_V1_TO_V2_STEP_ID, 1, 2], [WORKSPACE_V2_TO_V3_STEP_ID, 2, 3], [WORKSPACE_V3_TO_V4_STEP_ID, 3, 4], [WORKSPACE_V4_TO_V5_STEP_ID, 4, 5], [WORKSPACE_V5_TO_V6_STEP_ID, 5, 6]])
		expect(WORKSPACE_V1_TO_V2_STEP_ID).toBe('uiux.v1-to-v2')
		expect(WORKSPACE_V2_TO_V3_STEP_ID).toBe('uiux.v2-to-v3')
		expect(WORKSPACE_V3_TO_V4_STEP_ID).toBe('uiux.v3-to-v4')
		expect(WORKSPACE_V4_TO_V5_STEP_ID).toBe('uiux.v4-to-v5')
		expect(WORKSPACE_V5_TO_V6_STEP_ID).toBe('uiux.v5-to-v6')
	})

	it('opens a v1 Workspace as migration_required: readable, v1-decoded, and every Review mutation blocked', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		const persistence = new FileNativePersistence({ root, schemaPolicy: V4_TEST_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'migration_required', version: 1, targetVersion: V4_TEST_SCHEMA_POLICY.currentVersion })
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
		const persistence = new FileNativePersistence({ root, schemaPolicy: V4_TEST_SCHEMA_POLICY })
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
		const persistence = new FileNativePersistence({ root, schemaPolicy: V4_TEST_SCHEMA_POLICY })
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject({ fromVersion: 1, version: 4, steps: ['uiux.v1-to-v2', 'uiux.v2-to-v3', 'uiux.v3-to-v4'] })
		expect(result.changedFiles).toEqual(['.uiux/workspace.json', reviewRelativePath(RESOLVED_REVIEW_ID)])
		const after = await snapshotFiles(root)
		expect(JSON.parse(after[workspaceRelativePath()]!)).toEqual({ ...v1Manifest, schemaVersion: V4_TEST_SCHEMA_POLICY.currentVersion })
		expect(result.revision).toBe((await persistence.workspace.read('workspace'))?.revision)

		const migrated = JSON.parse(after[reviewRelativePath(RESOLVED_REVIEW_ID)]!) as ReturnType<typeof v1ResolvedReview>
		const original = v1ResolvedReview()
		const expected = { ...original, history: original.history.map((entry, index) => index === 1 ? { ...entry, resolution: 'verified' } : entry) }
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
		const a = await new FileNativePersistence({ root: first, schemaPolicy: V4_TEST_SCHEMA_POLICY }).migrateWorkspace()
		const b = await new FileNativePersistence({ root: second, schemaPolicy: V4_TEST_SCHEMA_POLICY }).migrateWorkspace()
		expect(a.revision).toBe(b.revision)
		expect(await snapshotFiles(first)).toEqual(await snapshotFiles(second))

		const persistence = new FileNativePersistence({ root: first, schemaPolicy: V4_TEST_SCHEMA_POLICY })
		const settled = await snapshotFiles(first)
		expect(await persistence.planWorkspaceMigration()).toMatchObject({ fromVersion: V4_TEST_SCHEMA_POLICY.currentVersion, version: V4_TEST_SCHEMA_POLICY.currentVersion, steps: [], changedFiles: [] })
		expect(await persistence.migrateWorkspace()).toMatchObject({ version: V4_TEST_SCHEMA_POLICY.currentVersion, steps: [], changedFiles: [], revision: a.revision })
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
		const persistence = new FileNativePersistence({ root, schemaPolicy: V4_TEST_SCHEMA_POLICY })
		expect((await persistence.reviews.readInspected(RESOLVED_REVIEW_ID))?.diagnostics.map(item => item.code)).toEqual(['review.resolve_requires_human'])
		await persistence.migrateWorkspace()
		expect((await persistence.reviews.readInspected(RESOLVED_REVIEW_ID))?.diagnostics.map(item => item.code)).toEqual(['review.resolve_requires_human'])
	})

	it('refuses to migrate a Workspace with syntactically invalid canonical JSON and writes nothing', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		await writeFile(join(root, 'reviews', '66666666-6666-4666-8666-666666666666.review.json'), '{ not json')
		const persistence = new FileNativePersistence({ root, schemaPolicy: V4_TEST_SCHEMA_POLICY })
		await expect(persistence.planWorkspaceMigration()).rejects.toMatchObject({ code: 'persistence.invalid_json' })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'persistence.invalid_json' })
		expect(await snapshotFiles(root)).toEqual(before)
	})
})

describe('uiux migrate CLI', () => {
	it('lists migrate in honest help text and validates its arguments', () => {
		const help = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
		expect(help).toContain('migrate [--workspace <dir>] [--dry-run]')
		expect(help).toMatch(/a real run first writes the\s+Checkpoint "Before migration to schemaVersion 6"/u)
		expect(help).toMatch(/--dry-run prints the steps and changed files without writing\s+anything/u)
		expect(help).toMatch(/uiux\.v5-to-v6 adds access-presets\.json with the built-in\s+Access presets/u)
		// Outside the repository, so nothing past the usage check could discover the dogfood.
		const cwd = tmpdir()
		for (const args of [['migrate', '--workspace'], ['migrate', '--workspace', '.', 'extra'], ['migrate', '--workspace', '.', '--dry-run', '--dry-run']]) {
			const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' })
			expect(result.status).toBe(2)
			expect(result.stderr).toContain('uiux: migrate accepts --workspace <dir> and --dry-run.')
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
		expect(JSON.parse(await readFile(join(root, CURRENT_TEST_LAYOUT.manifestPath), 'utf8')).schemaVersion).toBe(CURRENT_WORKSPACE_SCHEMA_VERSION)
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
		expect(dryRun.stdout).toContain('schemaVersion: 1 -> 6')
		expect(dryRun.stdout).toContain('steps: uiux.v1-to-v2, uiux.v2-to-v3, uiux.v3-to-v4, uiux.v4-to-v5, uiux.v5-to-v6')
		expect(dryRun.stdout).toContain('    .uiux/access-presets.json')
		expect(dryRun.stdout).toContain(`new Workspace root (after a real run): ${join(root, '.uiux')}`)
		// Relocated files are named by their path from the old root.
		expect(dryRun.stdout).toContain(`    .uiux/${reviewRelativePath(RESOLVED_REVIEW_ID)}`)
		expect(dryRun.stdout).not.toContain('manifest revision')
		expect(await snapshotFiles(root)).toEqual(before)

		const real = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(real.status).toBe(0)
		expect(real.stdout).toContain(`Migrated UIUX Workspace ${root}`)
		expect(real.stdout).toContain(`new Workspace root: ${join(root, '.uiux')}`)
		const revision = (await new FileNativePersistence({ root: join(root, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).workspace.read('workspace'))?.revision
		expect(real.stdout).toContain(`manifest revision: ${revision}`)

		const again = spawnSync(process.execPath, [CLI, 'migrate', '--workspace', root], { encoding: 'utf8' })
		expect(again.status).toBe(0)
		expect(again.stdout).toContain(`is already at schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}; nothing to migrate.`)
	})

	it('refuses the real run while a live UIUX server holds the Workspace, and ignores a stale hold', async () => {
		const root = await seedV1Workspace()
		const before = await snapshotFiles(root)
		// The v1 Workspace is in the old layout, so its server hold is in .uiux/.
		const hold = await acquireServerHold(root, { layout: LEGACY_LAYOUT })
		expect(hold).toBeDefined()
		expect(await readActiveServerHold(root, LEGACY_LAYOUT)).toMatchObject({ pid: process.pid })
		const lines: string[] = []
		const refused = await runMigrateCommand({ workspaceRoot: root, dryRun: false, stdout: line => lines.push(line), stderr: line => lines.push(line) })
		expect(refused).toBe(1)
		expect(lines.join('\n')).toContain(`a UIUX server (pid ${process.pid}`)
		expect(await snapshotFiles(root)).toEqual(before)

		lines.length = 0
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(0)
		expect(lines.join('\n')).toContain('stop it before the real run')
		await hold!.release()
		expect(await readActiveServerHold(root, LEGACY_LAYOUT)).toBeUndefined()

		await writeFile(join(root, SERVER_HOLD_RELATIVE_PATH), JSON.stringify({ pid: 2_000_000_000, hostname: hostname(), startedAt: TIME, token: 'stale' }))
		expect(await readActiveServerHold(root, LEGACY_LAYOUT)).toBeUndefined()
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, stdout: () => undefined, stderr: () => undefined })).toBe(0)
		expect((await new FileNativePersistence({ root: join(root, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).inspectWorkspace()).inspection.state).toBe('current')
	})

	// The dogfood may still be at schemaVersion 5 until the owner runs its uiux.v5-to-v6 migration
	// (#140 owner ruling 3 of 2026-10-10), so these tests accept 5 or the current version.
	it('migrates a copy of the dogfood to the current schema (from 5, only uiux.v5-to-v6), and its Reviews all read without diagnostics', async () => {
		const root = await copyDogfoodWorkspace('uiux-dogfood-migration-')
		const fromVersion = await dogfoodSchemaVersion(root)
		expect([5, CURRENT_WORKSPACE_SCHEMA_VERSION]).toContain(fromVersion)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const result = await persistence.migrateWorkspace()
		expect(result).toMatchObject(fromVersion === 5
			? { fromVersion: 5, version: CURRENT_WORKSPACE_SCHEMA_VERSION, steps: [WORKSPACE_V5_TO_V6_STEP_ID] }
			: { fromVersion, version: fromVersion, steps: [], changedFiles: [] })
		if (fromVersion === 5) expect([...result.changedFiles].sort()).toEqual(['access-presets.json', 'workspace.json'])
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('current')
		expect((await persistence.accessPresets.readInspected())?.diagnostics).toEqual([])
		for (const key of await persistence.reviews.discoverKeys())
			expect((await persistence.reviews.readInspected(key))?.diagnostics, key).toEqual([])
	})

	it('runs uiux migrate on a copy of the dogfood: the dry run writes nothing, and the real run writes only the presets file, the manifest and the pre-migration Checkpoint (none when current)', async () => {
		const root = await copyDogfoodWorkspace('uiux-dogfood-current-')
		const fromVersion = await dogfoodSchemaVersion(root)
		const before = await snapshotTree(root)
		expect(Object.keys(before).filter(path => path.startsWith(`${CURRENT_TEST_LAYOUT.artifactsDir}/`))).toHaveLength(1)
		const home = join(await mkdtemp(join(tmpdir(), 'uiux-dogfood-current-home-')), 'home')
		roots.push(dirname(home))

		const dryLines: string[] = []
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: true, home, stdout: line => dryLines.push(line), stderr: line => dryLines.push(line) })).toBe(0)
		expect(dryLines.join('\n')).toContain(fromVersion === CURRENT_WORKSPACE_SCHEMA_VERSION
			? `is already at schemaVersion ${fromVersion}; nothing to migrate.`
			: `steps: ${WORKSPACE_V5_TO_V6_STEP_ID}`)
		expect(await snapshotTree(root)).toEqual(before)
		expect(await readdir(home).catch(() => undefined)).toBeUndefined()

		const lines: string[] = []
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(0)
		const after = await snapshotTree(root)
		const changed = Object.keys({ ...before, ...after }).filter(path => before[path] !== after[path]).sort()
		if (fromVersion === CURRENT_WORKSPACE_SCHEMA_VERSION) {
			expect(lines.join('\n')).toContain(`is already at schemaVersion ${fromVersion}; nothing to migrate.`)
			expect(changed).toEqual([])
			return
		}
		// The Checkpoint stores the files it records by digest in the artifact store.
		const recorded = (path: string) => path.startsWith(`${CURRENT_TEST_LAYOUT.checkpointsDir}/`) || path.startsWith(`${CURRENT_TEST_LAYOUT.artifactsDir}/`)
		expect(changed.filter(path => !recorded(path))).toEqual(['access-presets.json', 'workspace.json'])
		expect(changed.filter(path => path.startsWith(`${CURRENT_TEST_LAYOUT.artifactsDir}/`)).every(path => before[path] === undefined)).toBe(true)
		expect(changed.filter(path => path.startsWith(`${CURRENT_TEST_LAYOUT.checkpointsDir}/`))).toHaveLength(1)
		expect(JSON.parse(Buffer.from(after['access-presets.json']!, 'base64').toString('utf8'))).toEqual(builtInAccessPresetsFile())
	})
})
