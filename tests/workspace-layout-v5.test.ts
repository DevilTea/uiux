import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { runMigrateCommand } from '../src/cli/migrate'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { emptyProductKit, validateProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { validateWorkspaceManifest } from '../src/domain/workspace/schema'
import {
	acquireServerHold,
	canonicalJsonBytes,
	defineWorkspaceSchemaPolicy,
	detectWorkspaceLayout,
	detectWorkspaceLayoutSync,
	FileNativePersistence,
	LEGACY_LAYOUT,
	layoutForSchemaVersion,
	readActiveServerHold,
	V5_LAYOUT,
	viewRelativePath,
} from '../src/persistence'
import { CheckpointStore, HostHistoryStore, runWithDesignWriteContext, versionResourcesFromSnapshot, writeSnapshotCheckpointUnlocked } from '../src/persistence/history'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { currentManifest, transactionsPath, V5_TEST_SCHEMA_POLICY, v5Manifest, writeManifest } from './support/workspace-layout'

/**
 * The dormant `schemaVersion` 5 layout (issue #141, unit K2): Clauses 01a1144e-531c-…, 01a11bb1-8d67-…,
 * 01a11bb1-8dcc-…, 01a11bb1-8e31-…, 01a11bb1-8e98-…, 01a11bb1-8efc-…, 01a1144e-5336-…, 01a1144e-538e-…,
 * 01a1144e-5508-…, 01a1144e-551f-…, 01a11a5e-1e0e-…, 01a11a5e-1eba-… and 01a11a5e-1fc4-…, Rule
 * 01a11bb1-9585-…. UIUX's current schema stays 4, so a v5 Workspace is exercised under an injected
 * policy (`V5_TEST_SCHEMA_POLICY`).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const CHECKPOINT_ID = '22222222-2222-4222-8222-222222222222'
const HEX = 'cd'.repeat(32)
const HUMAN = { type: 'human', id: 'member:m-owner', displayName: 'deviltea' } as const

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(prefix = 'uiux-layout-v5-'): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	roots.push(root)
	return root
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

function view(name = 'Checkout') {
	return {
		id: VIEW_ID,
		name,
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

const KIT: ProductKit = {
	designSystems: ['@acme/design-system'],
	adapters: [{ moduleSpecifier: './dist/uiux.js' }, { moduleSpecifier: '@acme/uiux-adapter', config: { density: 'compact' } }],
	styles: ['./dist/kit.css', '@acme/design-system/styles.css'],
	themes: { dark: { 'data-theme': 'dark' }, light: {} },
	components: {
		'button': { files: ['src/components/button.vue'], layer: 'design-system', packages: ['@acme/design-system'] },
		'order-summary-card': { files: ['src/components/order-summary-card.vue', 'src/components/money.ts'], requires: ['button'], layer: 'product' },
	},
	widgets: { Button: { component: 'button' }, DatePicker: { import: '@acme/design-system', export: 'DatePicker' } },
}

/** A fresh v5 Workspace root: the manifest at `workspace.json` and an empty Product Kit file. */
async function v5Workspace(kit: ProductKit = emptyProductKit()): Promise<Readonly<{ root: string; persistence: FileNativePersistence }>> {
	const root = await makeRoot()
	await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(kit))
	const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
	return { root, persistence }
}

describe('the schemaVersion 5 layout', () => {
	it('keeps the manifest, Product Kit file, artifacts, Checkpoints and runtime files directly under the root', () => {
		expect(V5_LAYOUT.metadataDir).toBe('')
		expect(V5_LAYOUT.manifestPath).toBe('workspace.json')
		expect(V5_LAYOUT.productKitPath).toBe('product-kit.json')
		expect(V5_LAYOUT.codeDir).toBe('kit')
		expect(V5_LAYOUT.artifactsDir).toBe('artifacts')
		expect(V5_LAYOUT.checkpointsDir).toBe('history/checkpoints')
		expect(V5_LAYOUT.transactionsDir).toBe('.transactions')
		expect(V5_LAYOUT.lockPath).toBe('.persistence.lock')
		expect(V5_LAYOUT.serverHoldPath).toBe('.server-hold.json')
		expect(V5_LAYOUT.metadataFilePath('.server-hold-x.tmp')).toBe('.server-hold-x.tmp')
		expect(V5_LAYOUT.artifactRelativePath(`sha256:${HEX}`)).toBe(`artifacts/sha256/cd/${HEX}`)
		expect(V5_LAYOUT.checkpointRelativePath(CHECKPOINT_ID)).toBe(`history/checkpoints/${CHECKPOINT_ID}.json`)
		expect(V5_LAYOUT.canonicalFiles).toEqual(['workspace.json', 'product-kit.json'])
		expect(V5_LAYOUT.versionedRoots).toEqual(['workspace.json', 'product-kit.json', 'views/', 'flows/', 'i18n/', 'assets/'])
		expect(V5_LAYOUT.excluded).toEqual(['reviews/', 'artifacts/', 'history/', '.transactions/', 'kit/'])
		expect(LEGACY_LAYOUT.productKitPath).toBeUndefined()
		expect(LEGACY_LAYOUT.codeDir).toBeUndefined()
	})

	it('classifies the manifest and the Product Kit file as their resources, and nothing in kit/ or the runtime directories', () => {
		const classify = V5_LAYOUT.classifyVersionedPath
		expect(classify('workspace.json')).toEqual({ kind: 'workspace', key: 'workspace' })
		expect(classify('product-kit.json')).toEqual({ kind: 'product-kit', key: 'product-kit' })
		expect(classify(viewRelativePath(VIEW_ID))).toEqual({ kind: 'view', key: VIEW_ID })
		expect(classify('i18n/en-US.json')).toEqual({ kind: 'locale', key: 'en-US' })
		for (const path of ['.uiux/workspace.json', 'kit/package.json', 'kit/src/button.vue', `kit/views/${VIEW_ID}.view.json`, `reviews/${VIEW_ID}.review.json`, `artifacts/sha256/cd/${HEX}`, `history/checkpoints/${CHECKPOINT_ID}.json`, '.server-hold.json'])
			expect(classify(path), path).toBeUndefined()
		// The old layout knows no Product Kit file.
		expect(LEGACY_LAYOUT.classifyVersionedPath('product-kit.json')).toBeUndefined()
	})

	it('allows canonical writes only to the root files and the data directories (never kit/)', () => {
		for (const path of ['workspace.json', 'product-kit.json', viewRelativePath(VIEW_ID), `reviews/${VIEW_ID}.review.json`, 'i18n/zh-TW.json', `assets/${VIEW_ID}/asset.json`, `assets/${VIEW_ID}/logo.png`])
			expect(V5_LAYOUT.isCanonicalPath(path), path).toBe(true)
		for (const path of ['.uiux/workspace.json', 'kit/package.json', 'kit/product-kit.json', `kit/views/${VIEW_ID}.view.json`, 'artifacts/x', 'history/checkpoints/x.json', '.persistence.lock', 'notes.txt'])
			expect(V5_LAYOUT.isCanonicalPath(path), path).toBe(false)
		expect(LEGACY_LAYOUT.isCanonicalPath('.uiux/workspace.json')).toBe(true)
		expect(LEGACY_LAYOUT.isCanonicalPath('workspace.json')).toBe(false)
		expect(LEGACY_LAYOUT.isCanonicalPath('product-kit.json')).toBe(false)
	})

	it('detects the layout from where the manifest is, the old layout winning, and falls back to the given version', async () => {
		const legacy = await makeRoot()
		await writeManifest(legacy, currentManifest(), LEGACY_LAYOUT)
		const relocated = await makeRoot()
		await writeManifest(relocated, v5Manifest(), V5_LAYOUT)
		const both = await makeRoot()
		await writeManifest(both, currentManifest(), LEGACY_LAYOUT)
		await writeFile(join(both, 'workspace.json'), '{"version":2}\n') // another tool's file
		const empty = await makeRoot()
		for (const detect of [detectWorkspaceLayout, async (root: string, version: number) => detectWorkspaceLayoutSync(root, version)]) {
			expect(await detect(legacy, 5)).toBe(LEGACY_LAYOUT)
			expect(await detect(relocated, 4)).toBe(V5_LAYOUT)
			expect(await detect(both, 5)).toBe(LEGACY_LAYOUT)
			expect(await detect(empty, 4)).toBe(LEGACY_LAYOUT)
			expect(await detect(empty, 5)).toBe(V5_LAYOUT)
		}
	})

	it('stays dormant: UIUX\'s own policy is still schemaVersion 4 and does not recognize 5', () => {
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(4)
		expect(PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions).not.toContain(5)
		expect(layoutForSchemaVersion(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion)).toBe(LEGACY_LAYOUT)
	})
})

describe('the Product Kit file and the versioned manifest shape', () => {
	it('accepts the six members, any of them empty', () => {
		expect(validateProductKit(KIT).diagnostics).toEqual([])
		expect(validateProductKit(emptyProductKit()).ok).toBe(true)
	})

	it('requires every member and refuses unknown ones', () => {
		const missing: Partial<ProductKit> = { ...KIT }
		delete missing.widgets
		expect(validateProductKit(missing).diagnostics).toEqual([expect.objectContaining({ code: 'schema.required_field', path: '/widgets' })])
		expect(validateProductKit({ ...KIT, tokens: {} }).diagnostics).toEqual([expect.objectContaining({ code: 'schema.unknown_field', path: '/tokens' })])
		expect(validateProductKit([]).ok).toBe(false)
	})

	it('reports each malformed member at its path', () => {
		const codes = (value: unknown) => validateProductKit(value).diagnostics.map(item => `${item.code} ${item.path}`)
		expect(codes({ ...KIT, designSystems: ['Not A Package', '@acme/design-system', '@acme/design-system'] })).toEqual(['product_kit.invalid_package_name /designSystems/0', 'identity.duplicate /designSystems/2'])
		expect(codes({ ...KIT, adapters: [{ moduleSpecifier: '/abs/adapter.js' }] })).toEqual(['workspace.invalid_adapter_specifier /adapters/0/moduleSpecifier'])
		expect(codes({ ...KIT, styles: ['../outside.css', './../outside.css', './dist/../../x.css', './dist//x.css', '@acme/ds/../../x.css', './dist/./x.css'] })).toEqual([0, 1, 2, 3, 4, 5].map(index => `product_kit.invalid_style_specifier /styles/${index}`))
		expect(codes({ ...KIT, styles: ['./dist/kit.css', '@acme/design-system/styles.css', 'normalize.css'] })).toEqual([])
		expect(codes({ ...KIT, themes: { dark: { 'data theme': 'dark', 'data-mode': 1 } } })).toEqual(['product_kit.invalid_theme_attribute /themes/dark/data theme', 'schema.expected_string /themes/dark/data-mode'])
		expect(codes({ ...KIT, widgets: {}, components: { Button: { files: ['components/button.vue', 'src/../x.ts'], requires: ['ghost', 'Button'], layer: 'ui', extra: true } } })).toEqual([
			'product_kit.invalid_component_name /components/Button',
			'schema.unknown_field /components/Button/extra',
			'product_kit.invalid_component_file /components/Button/files/0',
			'product_kit.invalid_component_file /components/Button/files/1',
			'product_kit.unknown_component /components/Button/requires/0',
			'product_kit.unknown_component /components/Button/requires/1',
			'product_kit.invalid_component_layer /components/Button/layer',
		])
		expect(codes({ ...KIT, widgets: { Card: { component: 'card' }, Chart: { import: './local.js', export: '' }, Both: { component: 'button', import: 'x' } } })).toEqual([
			'product_kit.unknown_component /widgets/Card/component',
			'product_kit.invalid_widget_import /widgets/Chart/import',
			'product_kit.invalid_widget_import /widgets/Chart/export',
			'schema.unknown_field /widgets/Both/import',
		])
	})

	it('requires adapters in the manifest below schemaVersion 5 and refuses them from 5', () => {
		const base = { i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} }
		expect(validateWorkspaceManifest({ ...base, schemaVersion: 4, adapters: [] }).ok).toBe(true)
		expect(validateWorkspaceManifest({ ...base, schemaVersion: 4 }).diagnostics).toEqual([expect.objectContaining({ code: 'schema.expected_array', path: '/adapters' })])
		expect(validateWorkspaceManifest({ ...base, schemaVersion: 5 }).ok).toBe(true)
		expect(validateWorkspaceManifest({ ...base, schemaVersion: 5, adapters: [] }).diagnostics).toEqual([expect.objectContaining({ code: 'schema.unknown_field', path: '/adapters' })])
	})
})

describe('persistence on a schemaVersion 5 root', () => {
	it('reads and writes the manifest, Product Kit file, data, lock, transactions, artifacts, Checkpoints and server hold at the v5 paths', async () => {
		const root = await makeRoot()
		const seen: string[] = []
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: V5_TEST_SCHEMA_POLICY,
			async fault(point) {
				if (point === 'transaction.before_apply') seen.push(...await readdir(transactionsPath(root, V5_LAYOUT)))
			},
		})
		// An empty directory gets the layout of the injected policy's current version.
		expect(persistence.layout).toBe(V5_LAYOUT)
		await persistence.workspace.create(v5Manifest())
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))).toEqual(v5Manifest())
		expect(await exists(join(root, '.uiux'))).toBe(false)
		// Until product-kit.json exists the root cannot be written (Clause 01a11bb1-8d67); creating that file is the one exception.
		const withoutKit = (await persistence.workspace.readInspected()).inspection
		expect(withoutKit).toMatchObject({ state: 'unsupported', version: 5 })
		expect(withoutKit.diagnostics).toContainEqual(expect.objectContaining({ code: 'workspace.schema_unsupported', path: '/product-kit.json' }))
		await expect(persistence.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })

		const created = await persistence.productKit.create(KIT)
		expect((await persistence.workspace.readInspected()).inspection).toMatchObject({ state: 'current', version: 5 })
		expect(await readFile(join(root, 'product-kit.json'))).toEqual(canonicalJsonBytes(KIT))
		expect(await persistence.productKit.read()).toEqual({ resource: KIT, revision: created })
		expect(await persistence.productKit.readRevision()).toBe(created)
		expect((await persistence.productKit.readInspected())?.diagnostics).toEqual([])
		const changed = { ...KIT, styles: [] }
		expect(await persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: 'r_stale' as never, resource: changed })).toEqual({ ok: false, conflict: { code: 'revision_conflict', currentRevision: created } })
		const swapped = await persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: created, resource: changed })
		expect(swapped.ok).toBe(true)
		await expect(persistence.productKit.create(KIT)).rejects.toMatchObject({ code: 'persistence.resource_exists' })

		await persistence.views.create(VIEW_ID, view() as never)
		expect(await exists(join(root, viewRelativePath(VIEW_ID)))).toBe(true)

		await persistence.withLock(async () => {
			expect((await lstat(join(root, '.persistence.lock'))).isFile()).toBe(true)
		})
		expect(await exists(join(root, '.persistence.lock'))).toBe(false)

		await persistence.withLock(() => persistence.applyFileTransaction([{ path: `flows/${CHECKPOINT_ID}.flow.json`, bytes: new TextEncoder().encode('{}') }], 'asset'))
		expect(seen).toHaveLength(1)
		expect(await readdir(join(root, '.transactions'))).toEqual([])

		const stored = await persistence.artifacts.put(new TextEncoder().encode('v5 artifact'))
		const hex = stored.identity.slice('sha256:'.length)
		expect(await exists(join(root, 'artifacts', 'sha256', hex.slice(0, 2), hex))).toBe(true)
		expect(await persistence.artifacts.listIdentities()).toEqual([stored.identity])

		const hold = await acquireServerHold(root, { layout: persistence.layout })
		expect(hold).toBeDefined()
		expect((await lstat(join(root, '.server-hold.json'))).isFile()).toBe(true)
		expect((await readActiveServerHold(root, persistence.layout))?.token).toBe(hold!.hold.token)
		await hold!.release()
		expect((await readdir(root)).filter(name => name.endsWith('.tmp'))).toEqual([])
	})

	it('does not hold a v5 root that has no manifest yet', async () => {
		const root = await makeRoot()
		expect(await acquireServerHold(root, { layout: V5_LAYOUT })).toBeUndefined()
		expect(await readdir(root)).toEqual([])
	})

	it('scans the Product Kit file with the versioned and canonical files, and never kit/, reviews/ or artifacts/', async () => {
		const { root, persistence } = await v5Workspace(KIT)
		await persistence.views.create(VIEW_ID, view() as never)
		await mkdir(join(root, 'kit', 'src'), { recursive: true })
		await writeFile(join(root, 'kit', 'package.json'), '{"name":"kit"}\n')
		await writeFile(join(root, 'kit', 'src', 'button.vue'), '<template />\n')
		await mkdir(join(root, 'kit', 'views'), { recursive: true })
		await writeFile(join(root, 'kit', 'views', `${VIEW_ID}.view.json`), '{}\n')
		await persistence.artifacts.put(new TextEncoder().encode('blob'))

		const versioned = await persistence.withReadLock(() => persistence.scanVersionedSnapshotUnlocked())
		expect([...versioned.keys()]).toEqual(['product-kit.json', viewRelativePath(VIEW_ID), 'workspace.json'])
		const canonical = await persistence.withReadLock(() => persistence.scanCanonicalSnapshotUnlocked())
		expect([...canonical.keys()].sort()).toEqual(['product-kit.json', viewRelativePath(VIEW_ID), 'workspace.json'])

		const resources = versionResourcesFromSnapshot(versioned, persistence.layout).resources
		expect(resources.map(resource => [resource.kind, resource.key, Object.keys(resource.files)])).toEqual([
			['product-kit', 'product-kit', ['product-kit.json']],
			['view', VIEW_ID, [viewRelativePath(VIEW_ID)]],
			['workspace', 'workspace', ['workspace.json']],
		])
		expect(resources[0]!.revision).toBe(await persistence.productKit.readRevision())
	})

	it('never creates, changes or deletes anything in kit/ (Rule 01a11bb1-9585)', async () => {
		const { root, persistence } = await v5Workspace()
		await mkdir(join(root, 'kit', 'src'), { recursive: true })
		await writeFile(join(root, 'kit', 'src', 'button.vue'), 'original\n')
		const bytes = new TextEncoder().encode('changed\n')
		const refused = { code: 'persistence.path_rejected' }
		await persistence.withLock(async () => {
			await expect(persistence.atomicWriteUnlocked('kit/src/button.vue', bytes)).rejects.toMatchObject(refused)
			await expect(persistence.atomicCreateUnlocked('kit/src/new.vue', bytes)).rejects.toMatchObject(refused)
			await expect(persistence.atomicCreateImmutableUnlocked('kit/blob', bytes)).rejects.toMatchObject(refused)
			await expect(persistence.removeUnlocked('kit/src/button.vue')).rejects.toMatchObject(refused)
			// A differently cased spelling cannot reach it on a case-insensitive volume either.
			await expect(persistence.atomicWriteUnlocked('KIT/src/button.vue', bytes)).rejects.toMatchObject(refused)
			await expect(persistence.applyFileTransaction([{ path: 'kit/src/button.vue', bytes }], 'asset')).rejects.toMatchObject(refused)
			await expect(persistence.applyFileTransaction([{ path: `kit/views/${VIEW_ID}.view.json`, bytes }], 'asset')).rejects.toMatchObject(refused)
		})
		expect(await readFile(join(root, 'kit', 'src', 'button.vue'), 'utf8')).toBe('original\n')
		expect(await readdir(join(root, 'kit', 'src'))).toEqual(['button.vue'])
	})

	it('is unsupported under UIUX\'s current policy, so nothing can be written there yet', async () => {
		const { root } = await v5Workspace()
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect(persistence.layout).toBe(V5_LAYOUT)
		expect((await persistence.workspace.readInspected()).inspection).toMatchObject({ state: 'unsupported', version: 5 })
		await expect(persistence.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: (await persistence.productKit.readRevision())!, resource: KIT })).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})

	it('has no Product Kit file in the old layout', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.workspace.create(currentManifest() as never)
		expect(persistence.layout).toBe(LEGACY_LAYOUT)
		expect(await persistence.productKit.read()).toBeUndefined()
		await expect(persistence.productKit.create(KIT)).rejects.toMatchObject({ code: 'persistence.path_rejected' })
		expect(await exists(join(root, 'product-kit.json'))).toBe(false)
	})

	it('refuses a manifest whose schemaVersion belongs to the other layout', async () => {
		// An old-layout `.uiux/` directory selected as the root: its workspace.json is below 5.
		const oldParent = await makeRoot()
		await writeManifest(oldParent, currentManifest(), LEGACY_LAYOUT)
		const metadataDir = new FileNativePersistence({ root: join(oldParent, '.uiux'), schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(metadataDir.layout).toBe(V5_LAYOUT)
		const inspected = (await metadataDir.workspace.readInspected()).inspection
		expect(inspected).toMatchObject({ state: 'unsupported', version: 4 })
		expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: 'workspace.schema_unsupported', message: expect.stringMatching(/select its parent/) }))
		await expect(metadataDir.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(metadataDir.planWorkspaceMigration()).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })

		// The old-layout parent of a relocated Workspace: its .uiux/workspace.json is version 5.
		const relocatedParent = await makeRoot()
		await writeManifest(relocatedParent, v5Manifest(), LEGACY_LAYOUT)
		const parent = new FileNativePersistence({ root: relocatedParent, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(parent.layout).toBe(LEGACY_LAYOUT)
		expect((await parent.workspace.readInspected()).inspection).toMatchObject({ state: 'unsupported', version: 5 })
		await expect(parent.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(parent.withLock(() => parent.readRecordSchemaVersionUnlocked())).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})

	it('refuses, before writing anything, a migration that would move an old-layout Workspace to the v5 layout', async () => {
		const root = await makeRoot()
		const manifest = await writeManifest(root, currentManifest())
		const before = await readFile(manifest)
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(persistence.layout).toBe(LEGACY_LAYOUT)
		expect((await persistence.workspace.readInspected()).inspection).toMatchObject({ state: 'migration_required', version: 4, targetVersion: 5 })
		let beforeSteps = false
		await expect(persistence.migrateWorkspace({ async beforeSteps() { beforeSteps = true } })).rejects.toMatchObject({ code: 'workspace.migration_failed' })
		await expect(persistence.planWorkspaceMigration()).rejects.toMatchObject({ code: 'workspace.migration_failed' })
		expect(beforeSteps).toBe(false)
		expect(await readFile(manifest)).toEqual(before)
		expect(await readdir(root)).toEqual(['.uiux'])
	})
})

describe('uiux migrate on a schemaVersion 5 root', () => {
	// A later schema inside the same layout, to exercise migrate on the v5 paths.
	const V6_TEST_POLICY = defineWorkspaceSchemaPolicy({
		currentVersion: 6,
		recognizedVersions: [1, 2, 3, 4, 5, 6],
		steps: [...V5_TEST_SCHEMA_POLICY.steps, {
			id: 'test.v5-to-v6',
			fromVersion: 5,
			toVersion: 6,
			apply(snapshot) {
				const next = new Map(snapshot)
				const manifest = JSON.parse(new TextDecoder().decode(next.get('workspace.json')!)) as Record<string, unknown>
				next.set('workspace.json', canonicalJsonBytes({ ...manifest, schemaVersion: 6 }))
				return next
			},
		}],
	})

	it('finds the server hold at the v5 path and refuses, then migrates in place with history at the v5 paths', async () => {
		const { root } = await v5Workspace(KIT)
		const home = join(await makeRoot('uiux-layout-v5-home-'), 'home')
		const hold = (await acquireServerHold(root, { layout: V5_LAYOUT }))!
		const lines: string[] = []
		const run = () => runMigrateCommand({ workspaceRoot: root, dryRun: false, home, schemaPolicy: V6_TEST_POLICY, stdout: line => lines.push(line), stderr: line => lines.push(line) })
		expect(await run()).toBe(1)
		expect(lines.join('\n')).toContain(`a UIUX server (pid ${process.pid}`)
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).schemaVersion).toBe(5)
		await hold.release()

		lines.length = 0
		expect(await run(), lines.join('\n')).toBe(0)
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')).schemaVersion).toBe(6)
		expect(await readFile(join(root, 'product-kit.json'))).toEqual(canonicalJsonBytes(KIT))
		const [checkpoint] = await readdir(join(root, 'history', 'checkpoints'))
		expect(JSON.parse(await readFile(join(root, 'history', 'checkpoints', checkpoint!), 'utf8'))).toMatchObject({ workspaceSchemaVersion: 5, name: 'Before migration to schemaVersion 6' })
		expect(lines.join('\n')).toMatch(/system version: [0-9a-f-]{36}/)
		expect(await exists(join(root, '.uiux'))).toBe(false)
	})
})

describe('history on a schemaVersion 5 Workspace', () => {
	const clock = (): HistoryRecorderClock => ({ now: () => Date.parse('2026-10-10T00:00:00.000Z'), setTimeout: () => Symbol('timer'), clearTimeout: () => undefined })

	async function historyFixture() {
		const { root, persistence } = await v5Workspace({ ...emptyProductKit(), adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }] })
		const home = join(await makeRoot('uiux-layout-v5-home-'), 'home')
		const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
		const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock: clock(), log: () => undefined })
		const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
		return { root, home, persistence, history, recorder, app }
	}

	it('writes the Baseline under history/checkpoints/ as schemaVersion 5 with the product-kit resource, and records Product Kit writes', async () => {
		const ctx = await historyFixture()
		const started = await ctx.recorder.start()
		expect(await readdir(join(ctx.root, 'history', 'checkpoints'))).toEqual([`${started.baseline}.json`])
		const baseline = JSON.parse(await readFile(join(ctx.root, 'history', 'checkpoints', `${started.baseline}.json`), 'utf8'))
		expect(baseline).toMatchObject({ workspaceSchemaVersion: 5 })
		expect(baseline.resources.map((resource: { kind: string }) => resource.kind)).toEqual(['product-kit', 'workspace'])
		expect(Object.keys(baseline.resources[0].files)).toEqual(['product-kit.json'])

		const before = (await ctx.persistence.productKit.read())!
		await runWithDesignWriteContext({ actor: HUMAN, source: 'workbench', operation: 'updateProductKit' }, () =>
			ctx.persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: before.revision, resource: { ...before.resource, styles: ['./dist/kit.css'] } }))
		await ctx.recorder.stop()
		const versions = (await (await ctx.history.open()).host.listVersions()).records as HostVersionRecord[]
		expect(versions).toHaveLength(1)
		expect(versions[0]).toMatchObject({ type: 'autosave', workspaceSchemaVersion: 5, events: [expect.objectContaining({ operation: 'updateProductKit' })] })
		expect(versions[0]!.resources.find(resource => resource.kind === 'product-kit')?.revision).toBe(await ctx.persistence.productKit.readRevision())
	})

	it('compares and restores a version recorded in the old layout against the v5 current, by each record\'s own layout', async () => {
		const ctx = await historyFixture()
		await ctx.persistence.views.create(VIEW_ID, view('Pay') as never)
		const stores = (await ctx.history.open())!
		// A version recorded at schemaVersion 4: the manifest at .uiux/workspace.json holds the Adapters.
		const recorded = new Map<string, Uint8Array>([
			[LEGACY_LAYOUT.manifestPath, canonicalJsonBytes(currentManifest({ adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }] }))],
			[viewRelativePath(VIEW_ID), canonicalJsonBytes(view('Checkout'))],
		])
		const built = versionResourcesFromSnapshot(recorded, layoutForSchemaVersion(4))
		for (const bytes of built.blobs.values()) await stores.host.putBlob(bytes)
		const version: HostVersionRecord = { historySchemaVersion: 1, id: randomUUID(), type: 'autosave', actor: HUMAN, at: '2026-10-09T00:00:00.000Z', workspaceSchemaVersion: 4, resources: built.resources, startedAt: '2026-10-09T00:00:00.000Z', netChange: true, events: [] }
		await stores.host.writeVersion(version)

		const diff = await ctx.app.diffVersions({ from: version.id, to: 'current', detail: 'semantic' })
		expect(diff.status, JSON.stringify(diff)).toBe('compared')
		if (diff.status !== 'compared') return
		expect(Object.fromEntries(diff.summary.map(row => [`${row.kind}:${row.key}`, row.status]))).toEqual({
			'product-kit:product-kit': 'unchanged',
			[`view:${VIEW_ID}`]: 'modified',
			'workspace:workspace': 'unchanged',
		})
		// A Product Kit changed since is compared with what the upgrade made of the old manifest's Adapters.
		const kit = (await ctx.persistence.productKit.read())!
		await ctx.persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: kit.revision, resource: { ...kit.resource, styles: ['./dist/kit.css'] } })
		const changed = await ctx.app.diffVersions({ from: version.id, to: 'current', detail: 'semantic', resources: [{ kind: 'product-kit', key: 'product-kit' }] })
		expect(changed).toMatchObject({ status: 'compared', summary: [{ kind: 'product-kit', status: 'modified' }], changes: [{ kind: 'product-kit', diff: { type: 'structural', changes: [expect.objectContaining({ path: '/styles/0', after: './dist/kit.css' })] } }] })
		// No record holds the upgraded side's revision, so the row names none.
		expect(changed.status === 'compared' && changed.summary[0]).not.toHaveProperty('fromRevision')

		const current = await ctx.persistence.views.readRevision(VIEW_ID)
		const restored = await ctx.app.restoreResourceVersion({ versionId: version.id, resource: { kind: 'view', key: VIEW_ID }, expectedRevision: current! })
		expect(restored).toMatchObject({ status: 'updated', kind: 'view', key: VIEW_ID })
		expect((await ctx.persistence.views.read(VIEW_ID))?.resource).toMatchObject({ name: 'Checkout' })
		expect(await exists(join(ctx.root, '.uiux'))).toBe(false)

		// Restoring the Product Kit file waits for its write key (Rule 01a11c09-c648); this build refuses the kind.
		const kitRevision = await ctx.persistence.productKit.readRevision()
		expect(await ctx.app.restoreResourceVersion({ versionId: version.id, resource: { kind: 'product-kit', key: 'product-kit' }, expectedRevision: kitRevision! })).toMatchObject({ status: 'invalid', code: 'history.restore_unsupported_kind' })
	})

	it('fails loudly instead of recording a version whose layout differs from the persistence layout', async () => {
		const root = await makeRoot()
		await writeManifest(root, v5Manifest(), LEGACY_LAYOUT)
		// A persistence opened before a relocation keeps the old layout; the manifest now says 5.
		const stale = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY, layout: LEGACY_LAYOUT })
		const home = join(await makeRoot('uiux-layout-v5-home-'), 'home')
		const host = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root), create: true }))!
		await expect(stale.withLock(() => stale.readRecordSchemaVersionUnlocked())).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(stale.withLock(() => writeSnapshotCheckpointUnlocked({ persistence: stale, checkpoints: new CheckpointStore(stale), host, at: '2026-10-10T00:00:00.000Z', actor: HUMAN, name: 'Stale', source: 'cli' })))
			.rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		expect(await exists(join(root, LEGACY_LAYOUT.checkpointsDir))).toBe(false)
		expect((await host.listVersions()).records).toEqual([])
	})
})
