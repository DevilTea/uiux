import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import { builtInAccessPresetsFile } from '../src/domain/access-presets/schema'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { emptyProductKit, validateProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { validateWorkspaceManifest } from '../src/domain/workspace/schema'
import {
	acquireServerHold,
	canonicalJsonBytes,
	FileNativePersistence,
	readActiveServerHold,
	V5_LAYOUT,
	viewRelativePath,
} from '../src/persistence'
import { runWithDesignWriteContext, versionResourcesFromSnapshot } from '../src/persistence/history'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { currentManifest, transactionsPath, v5Manifest, writeManifest } from './support/workspace-layout'

/**
 * The `schemaVersion` 5 layout (issue #141, units K2 and K6): Clauses 01a1144e-531c-…, 01a11bb1-8d67-…,
 * 01a11bb1-8dcc-…, 01a11bb1-8e31-…, 01a11bb1-8e98-…, 01a11bb1-8efc-…, 01a1144e-5336-…, 01a1144e-538e-…,
 * 01a1144e-5508-…, 01a1144e-551f-…, 01a11a5e-1e0e-…, 01a11a5e-1eba-… and 01a11a5e-1fc4-…, Rule
 * 01a11bb1-9585-…. The layout, the only one, is exercised on a current-schema Workspace (schemaVersion 6
 * keeps every path of 5) under UIUX's own policy; a schemaVersion 5 Workspace only to show it is refused.
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

/** A fresh current-schema Workspace root: the manifest at `workspace.json`, a Product Kit file and the built-in Access presets. */
async function currentWorkspace(kit: ProductKit = emptyProductKit()): Promise<Readonly<{ root: string; persistence: FileNativePersistence }>> {
	const root = await makeRoot()
	await writeManifest(root, canonicalJsonBytes(currentManifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(kit))
	await writeFile(join(root, 'access-presets.json'), canonicalJsonBytes(builtInAccessPresetsFile()))
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	return { root, persistence }
}

/** A schemaVersion 5 Workspace root (the manifest at `workspace.json` and an empty Product Kit file), which UIUX refuses. */
async function v5Workspace(kit: ProductKit = emptyProductKit()): Promise<Readonly<{ root: string; persistence: FileNativePersistence }>> {
	const root = await makeRoot()
	await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(kit))
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
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
		expect(V5_LAYOUT.canonicalFiles).toEqual(['workspace.json', 'product-kit.json', 'access-presets.json'])
		expect(V5_LAYOUT.versionedRoots).toEqual(['workspace.json', 'product-kit.json', 'access-presets.json', 'views/', 'flows/', 'i18n/', 'assets/'])
		expect(V5_LAYOUT.excluded).toEqual(['reviews/', 'artifacts/', 'history/', '.transactions/', 'kit/'])
	})

	it('classifies the manifest and the Product Kit file as their resources, and nothing in kit/ or the runtime directories', () => {
		const classify = V5_LAYOUT.classifyVersionedPath
		expect(classify('workspace.json')).toEqual({ kind: 'workspace', key: 'workspace' })
		expect(classify('product-kit.json')).toEqual({ kind: 'product-kit', key: 'product-kit' })
		expect(classify(viewRelativePath(VIEW_ID))).toEqual({ kind: 'view', key: VIEW_ID })
		expect(classify('i18n/en-US.json')).toEqual({ kind: 'locale', key: 'en-US' })
		for (const path of ['.uiux/workspace.json', 'kit/package.json', 'kit/src/button.vue', `kit/views/${VIEW_ID}.view.json`, `reviews/${VIEW_ID}.review.json`, `artifacts/sha256/cd/${HEX}`, `history/checkpoints/${CHECKPOINT_ID}.json`, '.server-hold.json'])
			expect(classify(path), path).toBeUndefined()
	})

	it('allows canonical writes only to the root files and the data directories (never kit/)', () => {
		for (const path of ['workspace.json', 'product-kit.json', viewRelativePath(VIEW_ID), `reviews/${VIEW_ID}.review.json`, 'i18n/zh-TW.json', `assets/${VIEW_ID}/asset.json`, `assets/${VIEW_ID}/logo.png`])
			expect(V5_LAYOUT.isCanonicalPath(path), path).toBe(true)
		for (const path of ['.uiux/workspace.json', 'kit/package.json', 'kit/product-kit.json', `kit/views/${VIEW_ID}.view.json`, 'artifacts/x', 'history/checkpoints/x.json', '.persistence.lock', 'notes.txt'])
			expect(V5_LAYOUT.isCanonicalPath(path), path).toBe(false)
	})

	it('is current: UIUX\'s own policy is schemaVersion 6, which keeps the schemaVersion 5 layout a new Workspace gets', () => {
		expect(CURRENT_WORKSPACE_SCHEMA_VERSION).toBe(6)
		expect(new FileNativePersistence({ root: tmpdir(), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }).layout).toBe(V5_LAYOUT)
		// Clause 01a11c09-a855-7d7e-93ec-cd9a85fdb65e: the Access presets file is a canonical, versioned root file.
		expect(V5_LAYOUT.accessPresetsPath).toBe('access-presets.json')
		expect(V5_LAYOUT.canonicalFiles).toContain('access-presets.json')
		expect(V5_LAYOUT.classifyVersionedPath('access-presets.json')).toEqual({ kind: 'access-presets', key: 'access-presets' })
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
		// Theme root attributes are allow-listed to class and data-* (Clause 01a11bb1-8efc-77df-a0bb-78033bb35d56).
		expect(codes({ ...KIT, themes: { dark: { onclick: 'alert(1)', style: 'color: red', href: 'javascript:alert(1)', 'data-': 'x', 'DATA-theme': 'x', 'data-X': 'x' } } })).toEqual(
			['onclick', 'style', 'href', 'data-', 'DATA-theme', 'data-X'].map(name => `product_kit.theme_attribute_not_allowed /themes/dark/${name}`),
		)
		expect(codes({ ...KIT, themes: { dark: { 'class': 'dark', 'data-theme': 'dark' } } })).toEqual([])
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

	it('refuses adapters in the manifest at every schemaVersion', () => {
		const base = { i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} }
		for (const schemaVersion of [1, 4, 5, CURRENT_WORKSPACE_SCHEMA_VERSION]) {
			expect(validateWorkspaceManifest({ ...base, schemaVersion }).ok, String(schemaVersion)).toBe(true)
			expect(validateWorkspaceManifest({ ...base, schemaVersion, adapters: [] }).diagnostics, String(schemaVersion)).toEqual([expect.objectContaining({ code: 'schema.unknown_field', path: '/adapters' })])
		}
	})
})

describe('persistence on a schemaVersion 5 root', () => {
	it('reads and writes the manifest, Product Kit file, data, lock, transactions, artifacts, Checkpoints and server hold at the v5 paths', async () => {
		const root = await makeRoot()
		const seen: string[] = []
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
			async fault(point) {
				if (point === 'transaction.before_apply') seen.push(...await readdir(transactionsPath(root, V5_LAYOUT)))
			},
		})
		// An empty directory gets the layout of the injected policy's current version.
		expect(persistence.layout).toBe(V5_LAYOUT)
		await persistence.workspace.create(currentManifest() as never)
		expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))).toEqual(currentManifest())
		expect(await exists(join(root, '.uiux'))).toBe(false)
		// Until product-kit.json exists the root cannot be written (Clause 01a11bb1-8d67); creating that file is the one exception.
		const withoutKit = (await persistence.workspace.readInspected()).inspection
		expect(withoutKit).toMatchObject({ state: 'unsupported', version: CURRENT_WORKSPACE_SCHEMA_VERSION })
		expect(withoutKit.diagnostics).toContainEqual(expect.objectContaining({ code: 'workspace.schema_unsupported', path: '/product-kit.json' }))
		await expect(persistence.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })

		const created = await persistence.productKit.create(KIT)
		expect((await persistence.workspace.readInspected()).inspection).toMatchObject({ state: 'current', version: CURRENT_WORKSPACE_SCHEMA_VERSION })
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
		const { root, persistence } = await currentWorkspace(KIT)
		await persistence.views.create(VIEW_ID, view() as never)
		await mkdir(join(root, 'kit', 'src'), { recursive: true })
		await writeFile(join(root, 'kit', 'package.json'), '{"name":"kit"}\n')
		await writeFile(join(root, 'kit', 'src', 'button.vue'), '<template />\n')
		await mkdir(join(root, 'kit', 'views'), { recursive: true })
		await writeFile(join(root, 'kit', 'views', `${VIEW_ID}.view.json`), '{}\n')
		await persistence.artifacts.put(new TextEncoder().encode('blob'))

		const versioned = await persistence.withReadLock(() => persistence.scanVersionedSnapshotUnlocked())
		expect([...versioned.keys()]).toEqual(['access-presets.json', 'product-kit.json', viewRelativePath(VIEW_ID), 'workspace.json'])
		const canonical = await persistence.withReadLock(() => persistence.scanCanonicalSnapshotUnlocked())
		expect([...canonical.keys()].sort()).toEqual(['access-presets.json', 'product-kit.json', viewRelativePath(VIEW_ID), 'workspace.json'])

		const resources = versionResourcesFromSnapshot(versioned, persistence.layout).resources
		expect(resources.map(resource => [resource.kind, resource.key, Object.keys(resource.files)])).toEqual([
			['access-presets', 'access-presets', ['access-presets.json']],
			['product-kit', 'product-kit', ['product-kit.json']],
			['view', VIEW_ID, [viewRelativePath(VIEW_ID)]],
			['workspace', 'workspace', ['workspace.json']],
		])
		expect(resources[0]!.revision).toBe(await persistence.accessPresets.readRevision())
		expect(resources[1]!.revision).toBe(await persistence.productKit.readRevision())
	})

	it('never creates, changes or deletes anything in kit/ (Rule 01a11bb1-9585)', async () => {
		const { root, persistence } = await currentWorkspace()
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

	it('is unsupported at schemaVersion 5, so nothing is written there', async () => {
		const { persistence } = await v5Workspace()
		const inspection = (await persistence.workspace.readInspected()).inspection
		expect(inspection).toMatchObject({ state: 'unsupported', version: 5 })
		expect(inspection.diagnostics).toContainEqual(expect.objectContaining({ code: 'workspace.schema_unsupported', message: expect.stringMatching(/schemaVersion 5 .*uiux init/u) }))
		await expect(persistence.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: (await persistence.productKit.readRevision())!, resource: KIT })).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})

	it('refuses an old build\'s .uiux/ opened as a root, naming its schemaVersion', async () => {
		const oldParent = await makeRoot()
		await mkdir(join(oldParent, '.uiux'))
		await writeFile(join(oldParent, '.uiux', 'workspace.json'), canonicalJsonBytes({ schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		const metadataDir = new FileNativePersistence({ root: join(oldParent, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const inspected = (await metadataDir.workspace.readInspected()).inspection
		expect(inspected).toMatchObject({ state: 'unsupported', version: 4 })
		expect(inspected.diagnostics).toContainEqual(expect.objectContaining({ code: 'workspace.schema_unsupported', message: expect.stringMatching(/schemaVersion 4 .*uiux init/u) }))
		await expect(metadataDir.views.create(VIEW_ID, view() as never)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})
})

describe('history on a schemaVersion 5 Workspace', () => {
	const clock = (): HistoryRecorderClock => ({ now: () => Date.parse('2026-10-10T00:00:00.000Z'), setTimeout: () => Symbol('timer'), clearTimeout: () => undefined })

	async function historyFixture(workspace = currentWorkspace) {
		const { root, persistence } = await workspace({ ...emptyProductKit(), adapters: [{ moduleSpecifier: '@acme/uiux-adapter' }] })
		const home = join(await makeRoot('uiux-layout-v5-home-'), 'home')
		const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
		const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), clock: clock(), log: () => undefined })
		const app = createWorkspaceApplicationSession(persistence, { history, historyBoundary: () => recorder })
		return { root, home, persistence, history, recorder, app }
	}

	it('writes the Baseline under history/checkpoints/ at the current schemaVersion with the product-kit resource, and records Product Kit writes', async () => {
		const ctx = await historyFixture()
		const started = await ctx.recorder.start()
		expect(await readdir(join(ctx.root, 'history', 'checkpoints'))).toEqual([`${started.baseline}.json`])
		const baseline = JSON.parse(await readFile(join(ctx.root, 'history', 'checkpoints', `${started.baseline}.json`), 'utf8'))
		expect(baseline).toMatchObject({ workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION })
		expect(baseline.resources.map((resource: { kind: string }) => resource.kind)).toEqual(['access-presets', 'product-kit', 'workspace'])
		expect(Object.keys(baseline.resources[1].files)).toEqual(['product-kit.json'])

		const before = (await ctx.persistence.productKit.read())!
		await runWithDesignWriteContext({ actor: HUMAN, source: 'workbench', operation: 'updateProductKit' }, () =>
			ctx.persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: before.revision, resource: { ...before.resource, styles: ['./dist/kit.css'] } }))
		await ctx.recorder.stop()
		const versions = (await (await ctx.history.open()).host.listVersions()).records as HostVersionRecord[]
		expect(versions).toHaveLength(1)
		expect(versions[0]).toMatchObject({ type: 'autosave', workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, events: [expect.objectContaining({ operation: 'updateProductKit' })] })
		expect(versions[0]!.resources.find(resource => resource.kind === 'product-kit')?.revision).toBe(await ctx.persistence.productKit.readRevision())
	})
})
