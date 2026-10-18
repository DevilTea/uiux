import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { adapterGraphDigest } from '../src/adapters/adapter-graph-digest'
import { IN_LOCK_PROVENANCE_BUDGET_MS, KitFileDigestCache, kitFileDigestCache, provenanceBudgetMessage, type KitFileHasher } from '../src/adapters/kit-provenance'
import { locateKitProject } from '../src/adapters/kit-registry'
import { digestKitFile, listKitFiles, readKitFile } from '../src/adapters/kit-source-files'
import { createHistoryRecorder, type HistoryRecorder } from '../src/application/services/history-recorder'
import { readCurrentProductKitProvenance, readWorkspaceProductKitProvenance } from '../src/application/services/product-kit-provenance'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { evaluateEvidenceStaleness, PRODUCT_KIT_CHANGED_REASON, PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON, type EvidenceStalenessContext } from '../src/domain/evidence/staleness'
import { fileDigest } from '../src/domain/product-kit/digest'
import { fileSetDigest, inOutputDigest, inSourceDigest, productKitFreshnessContext, type ProductKitProvenance } from '../src/domain/product-kit/provenance'
import type { ProductKit } from '../src/domain/product-kit/schema'
import { FileNativePersistence, localeRelativePath, OBSERVER_HOOK_TIMEOUT_MS } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { createHistoryStoreFactory } from '../src/server/history-stores'
import { evidenceFreshness } from '../app/utils/readiness'
import { createCurrentWorkspace } from './support/workspace-layout'

const VIEW_ID = '01a11bb1-0000-7000-8000-00000000c2b2'
const temporaryRoots: string[] = []
const recorders: HistoryRecorder[] = []

afterEach(async () => {
	kitFileDigestCache.hashFile = digestKitFile
	kitFileDigestCache.clear()
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
			renderInputDigest: VIEW_RENDER_INPUT,
		},
		artifactRefs: [],
	}
}

function context(productKit?: ProductKitProvenance): EvidenceStalenessContext {
	return { allViews: [{ key: VIEW_ID, renderInputDigest: VIEW_RENDER_INPUT }], ...(productKit ? { productKit } : {}) }
}

/** The View's render-input digest, the same at capture and now: only the Product Kit varies here. */
const VIEW_RENDER_INPUT = `sha256:${'c'.repeat(64)}`

/** Counts every kit file the shared digest cache reads, by its kit-relative path. */
function countHashes(): string[] {
	const hashed: string[] = []
	kitFileDigestCache.hashFile = (kit, path) => {
		hashed.push(path)
		return digestKitFile(kit, path)
	}
	return hashed
}

/**
 * The source and output digests computed without the cache, as before it: list each digest's files
 * with `listKitFiles` and read each one whole. The kit of `kitWorkspace` declares the output `dist`.
 */
async function uncachedDigests(root: string): Promise<Readonly<{ sourceDigest: string; outputDigest: string }>> {
	const project = await locateKitProject(root, 'kit')
	const digest = async (include: (path: string, directory: boolean) => boolean): Promise<string> => {
		const listing = await listKitFiles(project, 50_000, include)
		const digests: Record<string, string> = {}
		for (const file of listing.files) {
			const read = await readKitFile(project, file.path, { maxBytes: Number.POSITIVE_INFINITY })
			if (read.status === 'found') digests[file.path] = await fileDigest(read.bytes)
		}
		return fileSetDigest(digests)
	}
	return {
		sourceDigest: await digest(path => inSourceDigest(path, 'dist')),
		outputDigest: await digest((path, directory) => inOutputDigest(path, directory, 'dist')),
	}
}

async function fileDigests(persistence: FileNativePersistence): Promise<Readonly<{ sourceDigest: string; outputDigest: string }>> {
	const { sourceDigest, outputDigest } = await provenance(persistence)
	return { sourceDigest, outputDigest }
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

describe('Design System versions (owner ruling 4 of 2026-10-15)', () => {
	it('omits the version of a Design System package that is missing or names none', async () => {
		const { root, persistence } = await kitWorkspace()
		await put(root, 'kit/node_modules/@acme/unversioned/package.json', JSON.stringify({ name: '@acme/unversioned' }))
		await setProductKit(persistence, { designSystems: ['@acme/ds', '@acme/unversioned', '@acme/missing'] })
		const entries = (await provenance(persistence)).designSystems
		expect(entries).toEqual([
			{ package: '@acme/ds', version: '2.3.4', linked: false },
			{ package: '@acme/unversioned', linked: false },
			{ package: '@acme/missing', linked: false },
		])
		for (const entry of entries.slice(1)) expect(Object.hasOwn(entry, 'version')).toBe(false)
	})
})

describe('the kit digest cache', () => {
	it('gives the digests the uncached computation gives, reading only the files that changed or were added', async () => {
		const { root, persistence } = await kitWorkspace()
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		const hashed = countHashes()

		// Unchanged: answered by stat alone.
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		expect(hashed).toEqual([])

		await put(root, 'kit/src/button.ts', 'export const button = 42\n')
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		expect(hashed).toEqual(['src/button.ts'])

		hashed.length = 0
		await put(root, 'kit/src/deep/added.ts', 'export const added = 1\n')
		await put(root, 'kit/dist/chunk.js', 'export const chunk = 1\n')
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		expect(hashed.sort()).toEqual(['dist/chunk.js', 'src/deep/added.ts'])

		// A removed file drops out of the digest; nothing is read for it.
		hashed.length = 0
		await rm(join(root, 'kit/src/deep/added.ts'))
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		expect(hashed).toEqual([])

		// A changed kit/package.json is read again; every other digest stays cached.
		await put(root, 'kit/package.json', JSON.stringify({ name: 'kit', private: true, dependencies: { '@acme/ds': '^2.0.0' }, uiux: { output: 'dist', build: { command: ['node', 'build.mjs'] } }, version: '1.0.1' }))
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
		expect(hashed).toEqual(['package.json'])
	})

	it('shares one computation among concurrent requests', async () => {
		const { root } = await kitWorkspace()
		for (let index = 0; index < 50; index++) await put(root, `kit/src/many/f${index}.ts`, `export const v = ${index}\n`)
		const project = await locateKitProject(root, 'kit')
		const hashed = countHashes()
		const results = await Promise.all(Array.from({ length: 10 }, () => kitFileDigestCache.digests(project)))
		for (const result of results) expect(result).toEqual(results[0])
		expect(new Set(hashed).size).toBe(hashed.length)
		expect(hashed.length).toBe(53)
		expect(results[0]).toEqual(await uncachedDigests(root))
	})

	// Issue #211: a kit over the file limit has no digests, and computes them again once it drops back
	// under the limit, wherever the files it lost lay, the directories the file listing never reached included.
	it('has no digests over the file limit, and computes them again once the kit drops back under it', async () => {
		const { root } = await kitWorkspace()
		const project = await locateKitProject(root, 'kit')
		// Source files in walk order (a directory's files before its subdirectories): package.json,
		// src/button.ts, src/a/1.ts, src/a/2.ts, src/b/deep/3.ts, src/b/deep/4.ts. With a limit of 3
		// the listing stops at src/a/2.ts and never reaches src/b/.
		await put(root, 'kit/src/a/1.ts', 'export const one = 1\n')
		await put(root, 'kit/src/a/2.ts', 'export const two = 2\n')
		await put(root, 'kit/src/b/deep/3.ts', 'export const three = 3\n')
		await put(root, 'kit/src/b/deep/4.ts', 'export const four = 4\n')
		const hashed: string[] = []
		const cache = new KitFileDigestCache(4, 3)
		cache.hashFile = (kit, path) => {
			hashed.push(path)
			return digestKitFile(kit, path)
		}
		expect(await cache.digests(project)).toBeUndefined()
		expect(hashed).toEqual([])
		// Files removed where the listing never reached: four source files remain, still over the limit.
		await rm(join(root, 'kit/src/b/deep/3.ts'))
		await rm(join(root, 'kit/src/b/deep/4.ts'))
		expect(await cache.digests(project)).toBeUndefined()
		// One more removed: three remain, and the digests are computed.
		await rm(join(root, 'kit/src/a/1.ts'))
		expect(await cache.digests(project)).toEqual(await uncachedDigests(root))
		// Over the limit again, then back at it by a removal in a directory the listing did not reach.
		await put(root, 'kit/src/b/deep/3.ts', 'export const three = 3\n')
		expect(await cache.digests(project)).toBeUndefined()
		await rm(join(root, 'kit/src/b/deep/3.ts'))
		expect(await cache.digests(project)).toEqual(await uncachedDigests(root))
	})

	it('digests a file of any size in chunks from the open file', async () => {
		const { root, persistence } = await kitWorkspace()
		const bytes = new Uint8Array(3 * 1024 * 1024 + 7).map((_, index) => index % 251)
		await put(root, 'kit/src/big.bin', bytes)
		const project = await locateKitProject(root, 'kit')
		expect(await digestKitFile(project, 'src/big.bin')).toMatchObject({ status: 'found', digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}` })
		expect(await fileDigests(persistence)).toEqual(await uncachedDigests(root))
	})
})

describe('Evidence freshness against Product Kit provenance (Rules 01a11bb1-be4a-… and 01a1161b-ff68-…)', () => {
	it('makes every capture\'s freshness unknown, never fresh, while the current provenance cannot be computed', async () => {
		const { root, persistence } = await kitWorkspace()
		const record = captureRecord(await provenance(persistence))
		const unchanged = await readCurrentProductKitProvenance(persistence)
		expect(evaluateEvidenceStaleness(record, { ...context(), ...productKitFreshnessContext(unchanged) })).toEqual({ isStale: false })

		// A kit file that cannot be read leaves the provenance unknown; it is never digested without it.
		await put(root, 'kit/dist/index.js', 'export const built = 9\n')
		kitFileDigestCache.hashFile = async (kit, path) => path === 'dist/index.js' ? { status: 'not_found' } : digestKitFile(kit, path)
		const current = await readCurrentProductKitProvenance(persistence)
		expect(current).toEqual({ state: 'unavailable' })
		expect(await readWorkspaceProductKitProvenance(persistence)).toBeUndefined()
		const judged = { ...context(), ...productKitFreshnessContext(current) }
		expect(evaluateEvidenceStaleness(record, judged)).toEqual({ isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON })
		expect(evaluateEvidenceStaleness(captureRecord(), judged)).toMatchObject({ isStale: true, unknown: true })
		expect(evidenceFreshness(record, judged)).toEqual({ state: 'unknown', reason: 'productKitUnavailable' })

		// Readable again: judged against the provenance as usual.
		kitFileDigestCache.hashFile = digestKitFile
		const readable = await readCurrentProductKitProvenance(persistence)
		expect(readable.state).toBe('available')
		expect(evaluateEvidenceStaleness(record, { ...context(), ...productKitFreshnessContext(readable) })).toEqual({ isStale: true, reason: PRODUCT_KIT_CHANGED_REASON })
	})

	it.skipIf(process.getuid?.() === 0)('has no provenance while a kit file is unreadable to the host user', async () => {
		const { root, persistence } = await kitWorkspace()
		await chmod(join(root, 'kit/src/button.ts'), 0o000)
		try {
			expect(await readCurrentProductKitProvenance(persistence)).toEqual({ state: 'unavailable' })
		}
		finally {
			await chmod(join(root, 'kit/src/button.ts'), 0o644)
		}
		expect((await readCurrentProductKitProvenance(persistence)).state).toBe('available')
	})

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
		// Without a current Product Kit provenance in the context, the Product Kit is not judged.
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

	it('keeps the work under the lock to stats for an unchanged large kit, and never holds the lock past its budget for a slow one', async () => {
		const { root, persistence } = await kitWorkspace()
		for (let index = 0; index < 2_000; index++) await put(root, `kit/src/many/${index % 20}/f${index}.ts`, `export const v${index} = ${index}\n`)
		await persistence.locales.create('en-US', { greeting: 'Hello' })
		const home = join(await tempDir('uiux-kit-provenance-home-'), 'home')
		const history = createHistoryStoreFactory({ workspaceRoot: root, persistence, home: () => home })
		const logged: string[] = []
		const recorder = createHistoryRecorder({ persistence, stores: () => history.open(), log: message => logged.push(message) })
		recorders.push(recorder)
		const hashed = countHashes()
		// Starting digests the kit once, before the lock is taken.
		await recorder.start()
		expect(hashed.length).toBe(2_003)
		const stores = await history.open()
		let greeting = 0
		const externalVersion = async () => {
			await writeFile(join(root, localeRelativePath('en-US')), `${JSON.stringify({ greeting: `Hi ${++greeting}` }, null, '\t')}\n`)
			const started = performance.now()
			const boundary = await recorder.closeOpenAutosave('checkpoint')
			const elapsed = performance.now() - started
			return { record: (await stores.host.readVersion(boundary!.external!))!, elapsed }
		}

		// Unchanged kit: no kit file is read under the lock.
		hashed.length = 0
		const unchanged = await externalVersion()
		expect(hashed).toEqual([])
		expect(unchanged.record.productKit).toEqual(await provenance(persistence))

		// One changed kit file: only it is read.
		await put(root, 'kit/src/many/3/f3.ts', 'export const v3 = 33\n')
		const changed = await externalVersion()
		expect(hashed).toEqual(['src/many/3/f3.ts'])
		expect(changed.record.productKit).toEqual(await provenance(persistence))

		// A digest that does not finish (a counted stand-in held open) ends the wait at the budget, far
		// below the observer hook bound: the record goes without productKit and no gap is recorded.
		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		const counted: KitFileHasher = async (kit, path) => {
			hashed.push(path)
			await held
			return digestKitFile(kit, path)
		}
		kitFileDigestCache.hashFile = counted
		hashed.length = 0
		await put(root, 'kit/src/many/4/f4.ts', 'export const v4 = 44\n')
		const slow = await externalVersion()
		expect(hashed).toEqual(['src/many/4/f4.ts'])
		expect(slow.elapsed).toBeLessThan(OBSERVER_HOOK_TIMEOUT_MS)
		expect(slow.record.productKit).toBeUndefined()
		expect(slow.record.recordingGap).toBeUndefined()
		// Issue #211: the record left without productKit is logged, naming no host path.
		expect(logged).toEqual([provenanceBudgetMessage(IN_LOCK_PROVENANCE_BUDGET_MS)])
		expect(logged[0]).not.toContain(root)

		// The digest finishes outside the lock, and the next record finds it cached.
		release()
		await kitFileDigestCache.digests(await locateKitProject(root, 'kit'))
		hashed.length = 0
		const next = await externalVersion()
		expect(hashed).toEqual([])
		expect(next.record.productKit).toEqual(await provenance(persistence))
		expect(next.record.recordingGap).toBeUndefined()
		expect(logged).toHaveLength(1)
	}, 60_000)
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
