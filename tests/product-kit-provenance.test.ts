import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { adapterGraphDigest } from '../src/adapters/adapter-graph-digest'
import { createHistoryRecorder, type HistoryRecorder } from '../src/application/services/history-recorder'
import { readWorkspaceProductKitProvenance } from '../src/application/services/product-kit-provenance'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { evaluateEvidenceStaleness, PRODUCT_KIT_CHANGED_REASON, type EvidenceStalenessContext } from '../src/domain/evidence/staleness'
import type { ProductKitProvenance } from '../src/domain/product-kit/provenance'
import type { ProductKit } from '../src/domain/product-kit/schema'
import { FileNativePersistence, localeRelativePath } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { evidenceFreshness } from '../app/utils/readiness'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '01a11bb1-0000-7000-8000-00000000c2b2'
const temporaryRoots: string[] = []
const recorders: HistoryRecorder[] = []

afterEach(async () => {
	for (const recorder of recorders.splice(0)) await recorder.stop()
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix))
	temporaryRoots.push(dir)
	return dir
}

async function put(root: string, path: string, content: string | Uint8Array): Promise<void> {
	await mkdir(dirname(join(root, path)), { recursive: true })
	await writeFile(join(root, path), content)
}

/**
 * A current-schema Workspace with a kit project that declares a build (output `dist/`), a source
 * file, build output with a source map, a dot-directory and one installed Design System package.
 */
async function kitWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await tempDir('uiux-kit-provenance-')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence, { i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
	await put(root, 'kit/package.json', JSON.stringify({ name: 'kit', private: true, dependencies: { '@acme/ds': '^2.0.0' }, uiux: { output: 'dist', build: { command: ['node', 'build.mjs'] } } }))
	await put(root, 'kit/src/button.ts', 'export const button = 1\n')
	await put(root, 'kit/dist/index.js', 'export const built = 1\n')
	await put(root, 'kit/dist/index.js.map', '{"version":3}\n')
	await put(root, 'kit/.cache/state', 'one\n')
	await put(root, 'kit/node_modules/@acme/ds/package.json', JSON.stringify({ name: '@acme/ds', version: '2.3.4' }))
	await setProductKit(persistence, { designSystems: ['@acme/ds'] })
	return { root, persistence }
}

async function setProductKit(persistence: FileNativePersistence, patch: Partial<ProductKit>): Promise<void> {
	const current = (await persistence.productKit.read())!
	const result = await persistence.productKit.compareAndSwap({ key: 'product-kit', expectedRevision: current.revision, resource: { ...current.resource, ...patch } })
	expect(result.ok).toBe(true)
}

async function provenance(persistence: FileNativePersistence): Promise<ProductKitProvenance> {
	const read = await readWorkspaceProductKitProvenance(persistence)
	expect(read).toBeDefined()
	return read!
}

function captureRecord(productKit?: ProductKitProvenance): FormalEvidenceRecord {
	return {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: VIEW_ID, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: {
			workspaceSchemaVersion: 6,
			resources: [{ identity: { type: 'view', id: VIEW_ID }, revision: 'r1' }],
			versions: { uiux: '0.0.0' },
			...(productKit ? { productKit } : {}),
		},
		artifactRefs: [],
	}
}

function context(productKit?: ProductKitProvenance): EvidenceStalenessContext {
	return { allViews: [{ key: VIEW_ID, revision: 'r1' }], ...(productKit ? { productKit } : {}) }
}

describe('Product Kit provenance (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a)', () => {
	it('digests the Product Kit data, the build output without source maps and kit/ without its output or dot entries, and names each Design System', async () => {
		const { root, persistence } = await kitWorkspace()
		const first = await provenance(persistence)
		expect(first.designSystems).toEqual([{ package: '@acme/ds', version: '2.3.4', linked: false }])
		for (const digest of [first.dataDigest, first.outputDigest, first.sourceDigest]) expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/)
		// No host path enters provenance.
		const serialized = JSON.stringify(first)
		expect(serialized).not.toContain(root)
		expect(serialized).not.toContain(await realpath(root))

		// A source map and a dot entry take part in no digest.
		await put(root, 'kit/dist/index.js.map', '{"version":3,"changed":true}\n')
		await put(root, 'kit/.cache/state', 'two\n')
		expect(await provenance(persistence)).toEqual(first)

		// A source change moves only the source digest.
		await put(root, 'kit/src/button.ts', 'export const button = 2\n')
		const sourceChanged = await provenance(persistence)
		expect(sourceChanged.sourceDigest).not.toBe(first.sourceDigest)
		expect(sourceChanged.outputDigest).toBe(first.outputDigest)
		expect(sourceChanged.dataDigest).toBe(first.dataDigest)

		// A build output change moves only the output digest.
		await put(root, 'kit/dist/index.js', 'export const built = 2\n')
		const outputChanged = await provenance(persistence)
		expect(outputChanged.outputDigest).not.toBe(sourceChanged.outputDigest)
		expect(outputChanged.sourceDigest).toBe(sourceChanged.sourceDigest)

		// The Adapter list is not Product Kit data; the styles are.
		await setProductKit(persistence, { adapters: [{ moduleSpecifier: './dist/index.js' }] })
		expect((await provenance(persistence)).dataDigest).toBe(first.dataDigest)
		await setProductKit(persistence, { styles: ['./dist/index.css'] })
		expect((await provenance(persistence)).dataDigest).not.toBe(first.dataDigest)
	})

	it('marks a Design System package reached through a link as linked', async () => {
		const { root, persistence } = await kitWorkspace()
		await rm(join(root, 'kit/node_modules/@acme/ds'), { recursive: true })
		await put(root, 'vendor/ds/package.json', JSON.stringify({ name: '@acme/ds', version: '3.0.0' }))
		await symlink(join(root, 'vendor/ds'), join(root, 'kit/node_modules/@acme/ds'))
		expect((await provenance(persistence)).designSystems).toEqual([{ package: '@acme/ds', version: '3.0.0', linked: true }])
	})

	it('gives a Workspace without kit/ provenance over empty file sets', async () => {
		const root = await tempDir('uiux-kit-provenance-nokit-')
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await createCurrentWorkspace(persistence, { adapters: [] })
		const read = await provenance(persistence)
		expect(read.outputDigest).toBe(read.sourceDigest)
		expect(read.designSystems).toEqual([])
	})
})

describe('Evidence freshness against Product Kit provenance (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…)', () => {
	it('makes a capture stale once the Product Kit data changes', async () => {
		const { persistence } = await kitWorkspace()
		const record = captureRecord(await provenance(persistence))
		expect(evaluateEvidenceStaleness(record, context(await provenance(persistence)))).toEqual({ isStale: false })
		await setProductKit(persistence, { themes: { light: { 'data-theme': 'light' } } })
		const current = await provenance(persistence)
		expect(evaluateEvidenceStaleness(record, context(current))).toEqual({ isStale: true, reason: PRODUCT_KIT_CHANGED_REASON })
		expect(evidenceFreshness(record, context(current))).toEqual({ state: 'stale', reason: 'productKitChanged' })
	})

	it('makes a capture stale once the build output changes, and not when only the kit source does', async () => {
		const { root, persistence } = await kitWorkspace()
		const record = captureRecord(await provenance(persistence))
		await put(root, 'kit/src/button.ts', 'export const button = 3\n')
		expect(evaluateEvidenceStaleness(record, context(await provenance(persistence)))).toEqual({ isStale: false })
		await put(root, 'kit/dist/index.js', 'export const built = 3\n')
		expect(evaluateEvidenceStaleness(record, context(await provenance(persistence)))).toEqual({ isStale: true, reason: PRODUCT_KIT_CHANGED_REASON })
	})

	it('treats a capture recorded without Product Kit provenance as unknown, hence not fresh (owner ruling 8 of 2026-10-10)', async () => {
		const { persistence } = await kitWorkspace()
		const legacy = captureRecord()
		const current = await provenance(persistence)
		expect(evaluateEvidenceStaleness(legacy, context(current))).toMatchObject({ isStale: true, unknown: true })
		expect(evidenceFreshness(legacy, context(current))).toEqual({ state: 'unknown', reason: 'noProductKit' })
		// Without a Product Kit to judge against (a Workspace below schemaVersion 5), the Product Kit is not judged.
		expect(evaluateEvidenceStaleness(legacy, context())).toEqual({ isStale: false })
	})
})

describe('version records carry Product Kit provenance (Clause 01a11bb1-b6ae-7cf7-9838-9628757d1190)', () => {
	it('records it in the Baseline Checkpoint and in an external version', async () => {
		const { root, persistence } = await kitWorkspace()
		await persistence.locales.create('en-US', { greeting: 'Hello' })
		const home = join(await tempDir('uiux-kit-provenance-home-'), 'home')
		const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
		const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), log: () => undefined })
		recorders.push(recorder)
		const started = await recorder.start()
		const stores = await history.open()
		const current = await provenance(persistence)
		const baseline = (await stores.checkpoints.list()).records.find(record => record.id === started.baseline)
		expect(baseline?.productKit).toEqual(current)

		await writeFile(join(root, localeRelativePath('en-US')), `${JSON.stringify({ greeting: 'Hi' }, null, '\t')}\n`)
		const boundary = await recorder.closeOpenAutosave('checkpoint')
		expect(boundary?.external).toEqual(expect.any(String))
		const external = await stores.host.readVersion(boundary!.external!)
		expect(external?.productKit).toEqual(current)
		expect(JSON.stringify(external)).not.toContain(root)
	})
})

describe('graph-wide Adapter content digest (Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5)', () => {
	it('changes when a stylesheet or an asset deep in the Adapter module graph changes, and leaves out the host packages', async () => {
		const root = await tempDir('uiux-adapter-digest-')
		await put(root, 'kit/src/adapter.ts', 'import { ref } from \'vue\'\nimport { a } from \'./deep/a\'\nexport const value = ref(a)\n')
		await put(root, 'kit/src/deep/a.ts', 'import \'./style.css\'\nexport const a = 1\n')
		await put(root, 'kit/src/deep/style.css', '@import \'./more.css\';\n.a { background: url(\'./mark.png\'); }\n')
		await put(root, 'kit/src/deep/more.css', '.b { color: red; }\n')
		await put(root, 'kit/src/deep/mark.png', new Uint8Array([137, 80, 78, 71, 1]))
		const digest = () => adapterGraphDigest({ workspaceRoot: root, moduleBase: join(root, 'kit'), entry: join(root, 'kit/src/adapter.ts') })

		const first = await digest()
		expect(first).toMatch(/^sha256:[0-9a-f]{64}$/)
		expect(await digest()).toBe(first)

		await put(root, 'kit/src/deep/more.css', '.b { color: blue; }\n')
		const cssChanged = await digest()
		expect(cssChanged).not.toBe(first)

		await put(root, 'kit/src/deep/mark.png', new Uint8Array([137, 80, 78, 71, 2]))
		expect(await digest()).not.toBe(cssChanged)
	})

	it('has no digest when the graph cannot be bundled', async () => {
		const root = await tempDir('uiux-adapter-digest-broken-')
		await put(root, 'kit/src/adapter.ts', 'import { missing } from \'./nowhere\'\nexport const value = missing\n')
		expect(await adapterGraphDigest({ workspaceRoot: root, moduleBase: join(root, 'kit'), entry: join(root, 'kit/src/adapter.ts') })).toBeUndefined()
	})
})
