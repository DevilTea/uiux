import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { artifactStoreRelativePath } from '../src/domain/artifacts/schema'
import type { AuthoredAsset } from '../src/domain/assets/schema'
import type { FlowResource } from '../src/domain/flows/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import {
	FileNativePersistence,
	PersistenceError,
	artifactRelativePath,
	assetMetadataRelativePath,
	assetDirectoryRelativePath,
	flowRelativePath,
	localeRelativePath,
	reviewRelativePath,
	resolveWorkspacePath,
	viewRelativePath,
	workspaceRelativePath,
	type PersistenceFaultPoint,
	type WorkspaceSnapshot,
} from '../src/persistence'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const REVIEW_ID = '33333333-3333-4333-8333-333333333333'
const ASSET_ID = '44444444-4444-4444-8444-444444444444'

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('file-native persistence', () => {
	it('derives canonical paths and rejects traversal or non-canonical identities before filesystem access', () => {
		expect(workspaceRelativePath()).toBe('.uiux/workspace.json')
		expect(viewRelativePath(VIEW_ID)).toBe(`views/${VIEW_ID}.view.json`)
		expect(flowRelativePath(FLOW_ID)).toBe(`flows/${FLOW_ID}.flow.json`)
		expect(reviewRelativePath(REVIEW_ID)).toBe(`reviews/${REVIEW_ID}.review.json`)
		expect(localeRelativePath('zh-TW')).toBe('i18n/zh-TW.json')
		expect(assetDirectoryRelativePath(ASSET_ID)).toBe(`assets/${ASSET_ID}`)
		expect(assetMetadataRelativePath(ASSET_ID)).toBe(`assets/${ASSET_ID}/asset.json`)
		expect(artifactRelativePath(`sha256:${'a'.repeat(64)}`)).toBe(artifactStoreRelativePath(`sha256:${'a'.repeat(64)}`))
		expect(() => viewRelativePath('../outside')).toThrow(PersistenceError)
		expect(() => localeRelativePath('zh-tw')).toThrow(PersistenceError)
		expect(() => resolveWorkspacePath('/tmp/workspace', '../outside')).toThrow(PersistenceError)
		expect(() => resolveWorkspacePath('/tmp/workspace', '/etc/passwd')).toThrow(PersistenceError)
	})

	it('preserves filename/id mismatches for View, Flow, and Review reads and rejects authoritative writes', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'views'), { recursive: true })
		await mkdir(join(root, 'flows'), { recursive: true })
		await mkdir(join(root, 'reviews'), { recursive: true })
		await writeFile(join(root, viewRelativePath(VIEW_ID)), JSON.stringify({ ...viewFixture(), id: OTHER_ID }))
		await writeFile(join(root, flowRelativePath(FLOW_ID)), JSON.stringify({ id: OTHER_ID }))
		await writeFile(join(root, reviewRelativePath(REVIEW_ID)), JSON.stringify({ id: OTHER_ID }))

		const view = await persistence.views.readInspected(VIEW_ID)
		const flow = await persistence.flows.readInspected(FLOW_ID)
		const review = await persistence.reviews.readInspected(REVIEW_ID)
		expect(view?.resource).toMatchObject({ id: OTHER_ID })
		expect(flow?.resource).toMatchObject({ id: OTHER_ID })
		expect(review?.resource).toMatchObject({ id: OTHER_ID })
		for (const result of [view, flow, review])
			expect(result?.diagnostics.some(item => item.code === 'identity.filename_id_mismatch')).toBe(true)

		await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: view!.revision, resource: viewFixture() }))
			.rejects.toMatchObject({ code: 'persistence.identity_mismatch' })
		await expect(persistence.flows.compareAndSwap({ key: FLOW_ID, expectedRevision: flow!.revision, resource: flowFixture() }))
			.rejects.toMatchObject({ code: 'persistence.identity_mismatch' })
		await expect(persistence.reviews.compareAndSwap({ key: REVIEW_ID, expectedRevision: review!.revision, resource: { id: REVIEW_ID } as ReviewThread }))
			.rejects.toMatchObject({ code: 'persistence.identity_mismatch' })
		expect(JSON.parse(await readFile(join(root, viewRelativePath(VIEW_ID)), 'utf8')).id).toBe(OTHER_ID)
	})

	it('keeps a byte-derived revision stable across repository instances and detects out-of-band edits in CAS', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.views.create(VIEW_ID, viewFixture())
		const initial = await persistence.views.read(VIEW_ID)
		const secondProcess = new FileNativePersistence({ root, schemaPolicy: policy() })
		const secondRead = await secondProcess.views.read(VIEW_ID)
		expect(secondRead?.revision).toBe(initial?.revision)

		const externalBytes = Buffer.concat([await readFile(join(root, viewRelativePath(VIEW_ID))), Buffer.from('  \n')])
		await writeFile(join(root, viewRelativePath(VIEW_ID)), externalBytes)
		const candidate = { ...viewFixture(), name: 'Should not overwrite external edit' }
		const result = await persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: initial!.revision, resource: candidate })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.conflict.code).toBe('revision_conflict')
			expect(result.conflict.currentRevision).not.toBe(initial!.revision)
		}
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(externalBytes)
	})

	it('serializes competing CAS operations across persistence instances sharing one Workspace', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.views.create(VIEW_ID, viewFixture())
		const initial = await persistence.views.read(VIEW_ID)
		let entered!: () => void
		let release!: () => void
		const enteredFault = new Promise<void>(resolve => entered = resolve)
		const gate = new Promise<void>(resolve => release = resolve)
		let held = false
		const first = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			async fault(point) {
				if (point === 'file.before_rename' && !held) {
					held = true
					entered()
					await gate
				}
			},
		})
		const second = new FileNativePersistence({ root, schemaPolicy: policy(), lockWaitMilliseconds: 2_000 })
		const firstWrite = first.views.compareAndSwap({
			key: VIEW_ID, expectedRevision: initial!.revision, resource: { ...viewFixture(), name: 'First writer' },
		})
		await enteredFault
		const secondWrite = second.views.compareAndSwap({
			key: VIEW_ID, expectedRevision: initial!.revision, resource: { ...viewFixture(), name: 'Second writer' },
		})
		await new Promise(resolve => setTimeout(resolve, 30))
		release()
		const [firstResult, secondResult] = await Promise.all([firstWrite, secondWrite])
		expect(firstResult.ok).toBe(true)
		expect(secondResult.ok).toBe(false)
		if (firstResult.ok && !secondResult.ok)
			expect(secondResult.conflict.currentRevision).toBe(firstResult.revision)
		expect((await persistence.views.read(VIEW_ID))?.resource.name).toBe('First writer')
	})

	it('rejects a symbolic-link persistence lock without following or deleting its target', async () => {
		const { root, persistence } = await newWorkspace()
		const outside = await makeRoot()
		const target = join(outside, 'lock-target.json')
		const targetBytes = Buffer.from(JSON.stringify({ pid: process.pid, token: 'not-a-uiux-lock' }))
		await writeFile(target, targetBytes)
		const lockPath = join(root, '.uiux', '.persistence.lock')
		await symlink(target, lockPath)
		await expect(persistence.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.path_rejected' })
		expect(await readFile(target)).toEqual(targetBytes)
		expect((await lstat(lockPath)).isSymbolicLink()).toBe(true)
	})

	it('does not overwrite an out-of-band file that appears during canonical create', async () => {
		const root = await makeRoot()
		const external = Buffer.from('external canonical bytes')
		let injected = false
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			async fault(point, details) {
				if (!injected && point === 'file.before_rename' && details.path === viewRelativePath(VIEW_ID)) {
					injected = true
					await mkdir(join(root, 'views'), { recursive: true })
					await writeFile(join(root, viewRelativePath(VIEW_ID)), external)
				}
			},
		})
		await persistence.workspace.create(workspaceFixture())
		await expect(persistence.views.create(VIEW_ID, viewFixture())).rejects.toMatchObject({ code: 'persistence.resource_exists' })
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(external)
	})

	it('allows current-policy Workspace manifest CAS without embedding revision metadata', async () => {
		const { persistence } = await newWorkspace()
		const current = await persistence.workspace.read('workspace')
		const next = { ...current!.resource, viewports: { compact: { dimensions: { width: 390, height: 844 } } } }
		const result = await persistence.workspace.compareAndSwap({ key: 'workspace', expectedRevision: current!.revision, resource: next })
		expect(result.ok).toBe(true)
		if (result.ok) {
			const read = await persistence.workspace.read('workspace')
			expect(read?.revision).toBe(result.revision)
			expect(read?.resource.viewports).toEqual(next.viewports)
			expect(JSON.stringify(read?.resource)).not.toContain('revision')
		}
	})

	it('leaves prior single-file bytes intact when an atomic write fails before rename', async () => {
		const root = await makeRoot()
		let armed = false
		let targetPoint: PersistenceFaultPoint = 'file.before_rename'
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			fault(point) {
				if (armed && point === targetPoint) {
					armed = false
					throw new Error('injected interruption')
				}
			},
		})
		await persistence.workspace.create(workspaceFixture())
		await persistence.views.create(VIEW_ID, viewFixture())
		const path = join(root, viewRelativePath(VIEW_ID))
		const original = await readFile(path)
		const read = await persistence.views.read(VIEW_ID)
		armed = true
		await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: read!.revision, resource: { ...viewFixture(), name: 'failed' } }))
			.rejects.toMatchObject({ code: 'persistence.write_failed' })
		expect(await readFile(path)).toEqual(original)
		expect(await readdir(join(root, 'views'))).toEqual([`${VIEW_ID}.view.json`])

		targetPoint = 'file.after_rename'
		armed = true
		await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: read!.revision, resource: { ...viewFixture(), name: 'failed after rename' } }))
			.rejects.toMatchObject({ code: 'persistence.write_failed' })
		expect(await readFile(path)).toEqual(original)
		expect(await readdir(join(root, 'views'))).toEqual([`${VIEW_ID}.view.json`])
	})

	it('discovers canonical locale filenames and preserves flat message values on read/write', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, 'i18n', 'zh-tw.json'), '{"ignored":"noncanonical"}')
		const createdRevision = await persistence.locales.create('zh-TW', { greeting: '  ', empty: '' })
		const discovered = await persistence.locales.discoverInspected()
		expect(discovered.locales).toEqual(['zh-TW'])
		expect(discovered.diagnostics.some(item => item.code === 'i18n.invalid_locale_filename')).toBe(true)
		const read = await persistence.locales.read('zh-TW')
		expect(read?.revision).toBe(createdRevision)
		expect(read?.resource).toEqual({ empty: '', greeting: '  ' })
		await expect(persistence.locales.read('zh-tw')).rejects.toMatchObject({ code: 'persistence.invalid_identity' })
	})

	it('includes Asset metadata and source bytes in its revision and rolls back a failed replacement', async () => {
		const root = await makeRoot()
		let failure: { point: PersistenceFaultPoint; index: number } | undefined
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			fault(point, details) {
				if (failure && point === failure.point && details.index === failure.index) {
					failure = undefined
					throw new Error('asset transaction interruption')
				}
			},
		})
		await persistence.workspace.create(workspaceFixture())
		const originalContent = Buffer.from('original source bytes')
		await persistence.assets.create(ASSET_ID, { metadata: assetFixture('original.bin', 'Original'), content: originalContent })
		const original = await persistence.assets.readInspected(ASSET_ID)
		const originalMetadataBytes = await readFile(join(root, assetMetadataRelativePath(ASSET_ID)))
		const secondProcess = new FileNativePersistence({ root, schemaPolicy: policy() })
		expect((await secondProcess.assets.read(ASSET_ID))?.revision).toBe(original?.revision)

		const replacementContent = Buffer.from('replacement bytes')
		const replacement = { metadata: assetFixture('replacement.bin', 'Replaced'), content: replacementContent }
		failure = { point: 'asset.before_apply', index: 1 }
		await expect(persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: original!.revision, resource: replacement }))
			.rejects.toMatchObject({ code: 'persistence.write_failed' })
		expect(await readFile(join(root, assetMetadataRelativePath(ASSET_ID)))).toEqual(originalMetadataBytes)
		expect(await readFile(join(root, 'assets', ASSET_ID, 'original.bin'))).toEqual(originalContent)
		await expect(readFile(join(root, 'assets', ASSET_ID, 'replacement.bin'))).rejects.toMatchObject({ code: 'ENOENT' })
		const afterFailure = await persistence.assets.readInspected(ASSET_ID)
		expect(afterFailure?.resource.metadata.name).toBe('Original')
		expect(afterFailure?.revision).toBe(original?.revision)

		const updated = await persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: original!.revision, resource: replacement })
		expect(updated.ok).toBe(true)
		if (updated.ok) expect(updated.revision).not.toBe(original?.revision)
		const updatedAsset = await persistence.assets.readInspected(ASSET_ID)
		expect(updatedAsset?.resource.metadata.id).toBe(ASSET_ID)
		expect(updatedAsset?.resource.metadata.name).toBe('Replaced')
		expect(updatedAsset?.actualContentFilenames).toEqual(['replacement.bin'])
		expect(Buffer.from(updatedAsset!.resource.content)).toEqual(replacementContent)
		const externalMetadataBytes = Buffer.concat([await readFile(join(root, assetMetadataRelativePath(ASSET_ID))), Buffer.from(' \n')])
		await writeFile(join(root, assetMetadataRelativePath(ASSET_ID)), externalMetadataBytes)
		const staleAssetWrite = await persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: updatedAsset!.revision, resource: replacement })
		expect(staleAssetWrite.ok).toBe(false)
		if (!staleAssetWrite.ok) expect(staleAssetWrite.conflict.currentRevision).not.toBe(updatedAsset!.revision)
		expect(await readFile(join(root, assetMetadataRelativePath(ASSET_ID)))).toEqual(externalMetadataBytes)
	})

	it('deduplicates identical immutable artifacts and never overwrites an existing identity path', async () => {
		const { root, persistence } = await newWorkspace()
		const first = Buffer.from('artifact one')
		const second = Buffer.from('artifact two')
		const storedFirst = await persistence.artifacts.put(first)
		expect(storedFirst.created).toBe(true)
		expect((await persistence.artifacts.put(first)).created).toBe(false)
		const storedSecond = await persistence.artifacts.put(second)
		expect(storedSecond.identity).not.toBe(storedFirst.identity)
		expect(Buffer.from((await persistence.artifacts.read(storedFirst.identity))!)).toEqual(first)
		const artifactPath = join(root, artifactStoreRelativePath(storedFirst.identity))
		const corrupted = Buffer.from('external replacement')
		await writeFile(artifactPath, corrupted)
		await expect(persistence.artifacts.put(first)).rejects.toMatchObject({ code: 'persistence.artifact_corrupt' })
		expect(await readFile(artifactPath)).toEqual(corrupted)
	})

	it('allows inspection of recognized old schemas, blocks normal writes, then migrates complete results deterministically', async () => {
		const resultA = await runSuccessfulMigration()
		const resultB = await runSuccessfulMigration()
		expect(resultA.changedFiles).toEqual(['.uiux/workspace.json', `views/${VIEW_ID}.view.json`])
		expect(resultA.steps).toEqual(['synthetic-1-to-2'])
		expect(resultA.manifest).toEqual(resultB.manifest)
		expect(resultA.view).toEqual(resultB.view)
		expect(JSON.parse(resultA.manifest).schemaVersion).toBe(2)
		expect(JSON.parse(resultA.view).name).toBe('Checkout migrated')
	})

	it('aborts migration if canonical files change out of band during migration planning', async () => {
		const root = await makeRoot()
		const oldManifest = Buffer.from(JSON.stringify(workspaceFixture(1), null, 2))
		const oldView = Buffer.from(JSON.stringify(viewFixture(), null, 2))
		await seedOldWorkspace(root, oldManifest, oldView)
		const externalView = Buffer.from(JSON.stringify({ ...viewFixture(), name: 'External edit during planning' }, null, 2))
		const migrationPolicy = defineWorkspaceSchemaPolicy({
			currentVersion: 2,
			recognizedVersions: [1, 2],
			steps: [{
				id: 'synthetic-oob-1-to-2',
				fromVersion: 1,
				toVersion: 2,
				async apply(snapshot: WorkspaceSnapshot) {
					await writeFile(join(root, viewRelativePath(VIEW_ID)), externalView)
					const next = new Map(snapshot)
					const manifest = JSON.parse(new TextDecoder().decode(next.get(workspaceRelativePath())!)) as Record<string, unknown>
					manifest.schemaVersion = 2
					next.set(workspaceRelativePath(), Buffer.from(`${JSON.stringify(manifest)}\n`))
					return next
				},
			}],
		})
		const persistence = new FileNativePersistence({ root, schemaPolicy: migrationPolicy })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.migration_failed' })
		expect(await readFile(join(root, workspaceRelativePath()))).toEqual(oldManifest)
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(externalView)
		expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
	})

	it('rolls back migration failures at multiple apply points without a mixed authoritative workspace', async () => {
		for (const target of [
			{ point: 'migration.before_apply' as const, index: 0 },
			{ point: 'migration.after_apply' as const, index: 0 },
			{ point: 'migration.before_apply' as const, index: 1 },
		]) {
			const root = await makeRoot()
			let failure: { point: PersistenceFaultPoint; index: number } | undefined = target
			const persistence = new FileNativePersistence({
				root,
				schemaPolicy: policy(),
				fault(point, details) {
					if (failure && point === failure.point && details.index === failure.index) {
						failure = undefined
						throw new Error('migration apply interruption')
					}
				},
			})
			const oldManifest = Buffer.from(JSON.stringify(workspaceFixture(1), null, 2))
			const oldView = Buffer.from(JSON.stringify(viewFixture(), null, 2))
			await seedOldWorkspace(root, oldManifest, oldView)
			await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.migration_failed' })
			expect(await readFile(join(root, workspaceRelativePath()))).toEqual(oldManifest)
			expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(oldView)
			expect((await persistence.inspectWorkspace()).inspection.state).toBe('migration_required')
			expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
		}
	})

	it('recovers an interrupted migration transaction before exposing canonical reads', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
		const oldManifest = Buffer.from(JSON.stringify(workspaceFixture(1), null, 2))
		const oldView = Buffer.from(JSON.stringify(viewFixture(), null, 2))
		const newManifest = Buffer.from(JSON.stringify(workspaceFixture(2), null, 2))
		await seedOldWorkspace(root, oldManifest, oldView)
		await writeFile(join(root, workspaceRelativePath()), newManifest)

		const transactionId = '66666666-6666-4666-8666-666666666666'
		const transactionRoot = join(root, '.uiux', '.transactions', transactionId)
		await mkdir(join(transactionRoot, 'backup', '.uiux'), { recursive: true })
		await mkdir(join(transactionRoot, 'backup', 'views'), { recursive: true })
		await writeFile(join(transactionRoot, 'backup', workspaceRelativePath()), oldManifest)
		await writeFile(join(transactionRoot, 'backup', viewRelativePath(VIEW_ID)), oldView)
		await writeFile(join(transactionRoot, 'journal.json'), JSON.stringify({
			changes: [
				{ path: workspaceRelativePath(), existed: true },
				{ path: viewRelativePath(VIEW_ID), existed: true },
			],
		}))
		await writeFile(join(root, '.uiux', '.persistence.lock'), JSON.stringify({ pid: 2_000_000_000, token: '66666666-6666-4666-8666-666666666667' }))

		const inspected = await persistence.inspectWorkspace()
		expect(inspected.inspection.state).toBe('migration_required')
		expect(await readFile(join(root, workspaceRelativePath()))).toEqual(oldManifest)
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(oldView)
		expect(await readdir(join(root, '.uiux', '.transactions')).catch(() => [])).toEqual([])
	})

	it('leaves unknown future schema data unchanged and diagnoses unsupported state', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
		const future = workspaceFixture(Number.MAX_SAFE_INTEGER)
		const bytes = Buffer.from(JSON.stringify(future, null, 2))
		await mkdir(join(root, '.uiux'), { recursive: true })
		await writeFile(join(root, workspaceRelativePath()), bytes)
		const result = await persistence.inspectWorkspace()
		expect(result.inspection.state).toBe('unsupported')
		expect(result.inspection.diagnostics.some(item => item.code === 'workspace.schema_unsupported')).toBe(true)
		await expect(persistence.workspace.compareAndSwap({ key: 'workspace', expectedRevision: result.revision!, resource: workspaceFixture() }))
			.rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(persistence.migrateWorkspace()).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		expect(await readFile(join(root, workspaceRelativePath()))).toEqual(bytes)
	})

	it('keeps syntactically valid but semantically invalid authored JSON available with diagnostics', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'views'), { recursive: true })
		const invalidButReadable = { id: VIEW_ID, name: '', ir: null, variants: {}, spec: {} }
		await writeFile(join(root, viewRelativePath(VIEW_ID)), JSON.stringify(invalidButReadable))
		const result = await persistence.views.readInspected(VIEW_ID)
		expect(result?.resource).toEqual(invalidButReadable)
		expect(result?.diagnostics.length).toBeGreaterThan(0)
	})

	it('returns a structured persistence diagnostic for syntactically invalid JSON without changing its bytes', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'views'), { recursive: true })
		const invalidBytes = Buffer.from('{"id":')
		await writeFile(join(root, viewRelativePath(VIEW_ID)), invalidBytes)
		await expect(persistence.views.readInspected(VIEW_ID)).rejects.toMatchObject({
			code: 'persistence.invalid_json',
			diagnostics: [{ code: 'persistence.invalid_json' }],
		})
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).toEqual(invalidBytes)
	})
})

async function newWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await makeRoot()
	const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
	await persistence.workspace.create(workspaceFixture())
	return { root, persistence }
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-persistence-'))
	temporaryRoots.push(root)
	return root
}

function policy() {
	return defineWorkspaceSchemaPolicy({
		currentVersion: 2,
		recognizedVersions: [1, 2],
		steps: [{
			id: 'synthetic-1-to-2',
			fromVersion: 1,
			toVersion: 2,
			apply(snapshot: WorkspaceSnapshot) {
				const next = new Map(snapshot)
				const manifestPath = workspaceRelativePath()
				const manifest = JSON.parse(new TextDecoder().decode(next.get(manifestPath)!)) as Record<string, unknown>
				manifest.schemaVersion = 2
				next.set(manifestPath, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`))
				const path = viewRelativePath(VIEW_ID)
				if (next.has(path)) {
					const view = JSON.parse(new TextDecoder().decode(next.get(path)!)) as Record<string, unknown>
					view.name = `${String(view.name)} migrated`
					next.set(path, Buffer.from(`${JSON.stringify(view, null, 2)}\n`))
				}
				return next
			},
		}],
	})
}

function workspaceFixture(schemaVersion = 2): WorkspaceManifest {
	return {
		schemaVersion,
		i18n: { defaultLocale: 'en-US' },
		adapters: [],
		viewports: {},
		themes: {},
	}
}

function viewFixture(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Checkout',
		ir: { type: 'RootShell', id: 'root' },
		variants: {},
		spec: {
			intent: '',
			entryConditions: [],
			interactionRules: [],
			constraints: [],
			accessibility: [],
			references: [],
			decisions: [],
		},
	}
}

function flowFixture(): FlowResource {
	const stepId = '55555555-5555-4555-8555-555555555555'
	return {
		id: FLOW_ID,
		name: 'Checkout Flow',
		entryStepId: stepId,
		steps: { [stepId]: { target: { viewId: VIEW_ID }, transitions: [] } },
	}
}

function assetFixture(contentFilename: string, name: string): AuthoredAsset {
	return { id: ASSET_ID, name, contentFilename, mediaType: 'application/octet-stream' }
}

async function seedOldWorkspace(root: string, manifest: Uint8Array, view: Uint8Array): Promise<void> {
	await mkdir(join(root, '.uiux'), { recursive: true })
	await mkdir(join(root, 'views'), { recursive: true })
	await writeFile(join(root, workspaceRelativePath()), manifest)
	await writeFile(join(root, viewRelativePath(VIEW_ID)), view)
}

async function runSuccessfulMigration(): Promise<{ changedFiles: readonly string[]; steps: readonly string[]; manifest: string; view: string }> {
	const root = await makeRoot()
	const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
	await seedOldWorkspace(root, Buffer.from(JSON.stringify(workspaceFixture(1), null, 2)), Buffer.from(JSON.stringify(viewFixture(), null, 2)))
	const before = await persistence.inspectWorkspace()
	expect(before.inspection.state).toBe('migration_required')
	const view = await persistence.views.read(VIEW_ID)
	await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: view!.revision, resource: viewFixture() }))
		.rejects.toMatchObject({ code: 'workspace.migration_required' })
	const migration = await persistence.migrateWorkspace()
	return {
		changedFiles: migration.changedFiles,
		steps: migration.steps,
		manifest: await readFile(join(root, workspaceRelativePath()), 'utf8'),
		view: await readFile(join(root, viewRelativePath(VIEW_ID)), 'utf8'),
	}
}
