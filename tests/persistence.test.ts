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
	CANONICAL_WORKSPACE_DATA_DIRECTORIES,
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
import { isCaseSensitiveDirectory } from './support/filesystem'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tmpIsCaseSensitive = await isCaseSensitiveDirectory(tmpdir())
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

	it('writes every authored resource kind only under canonical data directories', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.views.create(VIEW_ID, viewFixture())
		await persistence.flows.create(FLOW_ID, flowFixture())
		await persistence.reviews.create(REVIEW_ID, reviewFixture())
		await persistence.locales.create('zh-TW', { greeting: 'hi' })
		await persistence.assets.create(ASSET_ID, { metadata: assetFixture('file.bin', 'Real'), content: Buffer.from('data') })
		await persistence.artifacts.put(Buffer.from('artifact-bytes'))

		const topLevelEntries = (await readdir(root, { withFileTypes: true }))
			.filter(entry => !entry.name.startsWith('.transactions') && !entry.name.endsWith('.lock'))
			.map(entry => entry.name)

		// Authoring must never create a top-level entry outside the canonical data directories; a new
		// one here would be a silent fail-open for the Adapter resolution boundary that trusts this set.
		for (const name of topLevelEntries)
			expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).toContain(name)
		// The resources above exercise each canonical directory (artifacts live under `.uiux`).
		expect(topLevelEntries).toEqual(expect.arrayContaining(['.uiux', 'views', 'flows', 'reviews', 'i18n', 'assets']))
		expect(topLevelEntries).not.toContain('adapters')
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
		// A noncanonically cased tag that cannot alias `zh-TW.json` on any volume.
		await writeFile(join(root, 'i18n', 'zh-hant-tw.json'), '{"ignored":"noncanonical"}')
		const createdRevision = await persistence.locales.create('zh-TW', { greeting: '  ', empty: '' })
		const discovered = await persistence.locales.discoverInspected()
		expect(discovered.locales).toEqual(['zh-TW'])
		expect(discovered.diagnostics).toContainEqual(expect.objectContaining({ code: 'i18n.invalid_locale_filename', path: '/i18n/zh-hant-tw.json' }))
		const read = await persistence.locales.read('zh-TW')
		expect(read?.revision).toBe(createdRevision)
		expect(read?.resource).toEqual({ empty: '', greeting: '  ' })
		await expect(persistence.locales.read('zh-tw')).rejects.toMatchObject({ code: 'persistence.invalid_identity' })
	})

	// Locale identity is the exact canonical tag. On a case-insensitive volume
	// (default macOS APFS/HFS+, Windows NTFS) the path `i18n/zh-TW.json` resolves
	// to a case variant such as `zh-tw.json`; read, create and compareAndSwap
	// must not treat that file as the canonical locale or write into it.
	it('does not alias a case-variant locale file to the canonical locale identity', async () => {
		const { root, persistence } = await newWorkspace()
		await mkdir(join(root, 'i18n'), { recursive: true })
		const variantPath = join(root, 'i18n', 'zh-tw.json')
		const variantBytes = '{"ignored":"noncanonical"}'
		await writeFile(variantPath, variantBytes)
		expect((await persistence.locales.discoverInspected()).locales).toEqual([])
		expect(await persistence.locales.read('zh-TW')).toBeUndefined()
		expect(await persistence.locales.readInspected('zh-TW')).toBeUndefined()
		expect(await persistence.locales.readRevision('zh-TW')).toBeUndefined()
		await expect(persistence.locales.compareAndSwap({ key: 'zh-TW', expectedRevision: 'r_any' as never, resource: { greeting: 'hi' } }))
			.rejects.toMatchObject({ code: 'persistence.resource_not_found' })
		expect(await readFile(variantPath, 'utf8')).toBe(variantBytes)

		if (tmpIsCaseSensitive) {
			const createdRevision = await persistence.locales.create('zh-TW', { greeting: 'hi' })
			const discovered = await persistence.locales.discoverInspected()
			expect(discovered.locales).toEqual(['zh-TW'])
			expect(discovered.diagnostics).toContainEqual(expect.objectContaining({ code: 'i18n.invalid_locale_filename', path: '/i18n/zh-tw.json' }))
			expect(await persistence.locales.read('zh-TW')).toMatchObject({ revision: createdRevision, resource: { greeting: 'hi' } })
		}
		else {
			// The variant occupies the canonical path, so creation is refused with the discovery diagnostic.
			await expect(persistence.locales.create('zh-TW', { greeting: 'hi' })).rejects.toMatchObject({
				code: 'persistence.path_rejected',
				diagnostics: [expect.objectContaining({ code: 'i18n.invalid_locale_filename', path: '/i18n/zh-tw.json' })],
			})
			expect(await readdir(join(root, 'i18n'))).toEqual(['zh-tw.json'])
		}
		expect(await readFile(variantPath, 'utf8')).toBe(variantBytes)
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

	it('migrates a Workspace containing an authored Asset (result validation checks Asset filenames, not the directory UUID)', async () => {
		const root = await makeRoot()
		await seedOldWorkspace(root, Buffer.from(JSON.stringify(workspaceFixture(1), null, 2)), Buffer.from(JSON.stringify(viewFixture(), null, 2)))
		await mkdir(join(root, 'assets', ASSET_ID), { recursive: true })
		await writeFile(join(root, assetMetadataRelativePath(ASSET_ID)), JSON.stringify(assetFixture('logo.svg', 'Logo')))
		await writeFile(join(root, 'assets', ASSET_ID, 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
		const plan = await persistence.planWorkspaceMigration()
		expect(plan.changedFiles).toEqual(['.uiux/workspace.json', `views/${VIEW_ID}.view.json`])
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('migration_required')
		const migration = await persistence.migrateWorkspace()
		expect(migration.steps).toEqual(['synthetic-1-to-2'])
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('current')
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

	it('executes atomic Review and View CAS in a single transaction, detecting individual and simultaneous stale revisions with zero partial writes', async () => {
		const { persistence } = await newWorkspace()
		await persistence.views.create(VIEW_ID, viewFixture())
		await persistence.reviews.create(REVIEW_ID, reviewFixture())

		const initialView = await persistence.views.read(VIEW_ID)
		const initialReview = await persistence.reviews.read(REVIEW_ID)
		expect(initialView).toBeDefined()
		expect(initialReview).toBeDefined()

		const nextView: ViewResource = {
			...viewFixture(),
			spec: {
				...viewFixture().spec,
				decisions: [{
					id: '99999999-9999-4999-8999-999999999999',
					question: 'Promoted question?',
					status: 'pending',
					history: [],
					provenance: { reviewId: REVIEW_ID, sourceReviewThreadId: REVIEW_ID },
				}],
			},
		}
		const nextReview: ReviewThread = {
			...reviewFixture(),
			messages: [{
				id: '88888888-8888-4888-8888-888888888888',
				actor: { type: 'human', id: 'reviewer' },
				at: new Date().toISOString(),
				body: 'Promotion noted.',
			}],
		}

		// 1. Simultaneous stale revisions: both mismatch
		const bothStale = await persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: 'rev-stale-review',
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: 'rev-stale-view',
			viewResource: nextView,
		})
		expect(bothStale.ok).toBe(false)
		if (!bothStale.ok) {
			expect(bothStale.conflict.resource).toBe('both')
			expect(bothStale.conflict.conflicts).toHaveLength(2)
			expect(bothStale.conflict.conflicts.map(c => c.resource).sort()).toEqual(['review', 'view'])
		}

		// Verify disk bytes are completely untouched
		expect((await persistence.views.read(VIEW_ID))?.revision).toBe(initialView!.revision)
		expect((await persistence.reviews.read(REVIEW_ID))?.revision).toBe(initialReview!.revision)

		// 2. Stale Review revision alone
		const staleReview = await persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: 'rev-stale-review',
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: initialView!.revision,
			viewResource: nextView,
		})
		expect(staleReview.ok).toBe(false)
		if (!staleReview.ok) {
			expect(staleReview.conflict.resource).toBe('review')
			expect(staleReview.conflict.conflicts).toHaveLength(1)
			expect(staleReview.conflict.conflicts[0]!.resource).toBe('review')
		}
		expect((await persistence.views.read(VIEW_ID))?.revision).toBe(initialView!.revision)
		expect((await persistence.reviews.read(REVIEW_ID))?.revision).toBe(initialReview!.revision)

		// 3. Stale View revision alone
		const staleView = await persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: initialReview!.revision,
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: 'rev-stale-view',
			viewResource: nextView,
		})
		expect(staleView.ok).toBe(false)
		if (!staleView.ok) {
			expect(staleView.conflict.resource).toBe('view')
			expect(staleView.conflict.conflicts).toHaveLength(1)
			expect(staleView.conflict.conflicts[0]!.resource).toBe('view')
		}
		expect((await persistence.views.read(VIEW_ID))?.revision).toBe(initialView!.revision)
		expect((await persistence.reviews.read(REVIEW_ID))?.revision).toBe(initialReview!.revision)

		// 4. Successful atomic CAS with matching revisions
		const success = await persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: initialReview!.revision,
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: initialView!.revision,
			viewResource: nextView,
		})
		expect(success.ok).toBe(true)
		if (success.ok) {
			expect(success.viewRevision).not.toBe(initialView!.revision)
			expect(success.reviewRevision).not.toBe(initialReview!.revision)

			const readView = await persistence.views.read(VIEW_ID)
			const readReview = await persistence.reviews.read(REVIEW_ID)
			expect(readView?.revision).toBe(success.viewRevision)
			expect(readReview?.revision).toBe(success.reviewRevision)
			expect(readView?.resource.spec.decisions?.[0]?.question).toBe('Promoted question?')
			expect(readReview?.resource.messages?.[0]?.body).toBe('Promotion noted.')
		}
	})

	it('rolls back BOTH files during atomicReviewViewPromotionCas on transaction.before_apply and transaction.after_apply fault injection', async () => {
		const root = await makeRoot()
		let injectedFault: { point: PersistenceFaultPoint; index: number } | undefined
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			fault(point, details) {
				if (injectedFault && point === injectedFault.point && details.index === injectedFault.index && details.operation === 'decision-promotion') {
					injectedFault = undefined
					throw new Error(`Injected fault at ${point} index ${details.index}`)
				}
			},
		})
		await persistence.workspace.create(workspaceFixture())
		await persistence.views.create(VIEW_ID, viewFixture())
		await persistence.reviews.create(REVIEW_ID, reviewFixture())

		const viewPath = join(root, viewRelativePath(VIEW_ID))
		const reviewPath = join(root, reviewRelativePath(REVIEW_ID))
		const origViewBytes = await readFile(viewPath)
		const origReviewBytes = await readFile(reviewPath)

		const vRev = (await persistence.views.read(VIEW_ID))!.revision
		const rRev = (await persistence.reviews.read(REVIEW_ID))!.revision

		const nextView: ViewResource = {
			...viewFixture(),
			spec: {
				...viewFixture().spec,
				decisions: [{
					id: '99999999-9999-4999-8999-999999999999',
					question: 'Q?',
					status: 'pending',
					history: [],
					provenance: { reviewId: REVIEW_ID },
				}],
			},
		}
		const nextReview: ReviewThread = {
			...reviewFixture(),
			messages: [{
				id: '88888888-8888-4888-8888-888888888888',
				actor: { type: 'human', id: 'reviewer' },
				at: new Date().toISOString(),
				body: 'Msg',
			}],
		}

		// Inject before apply at index 1 (during second file apply)
		injectedFault = { point: 'transaction.before_apply', index: 1 }
		await expect(persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: rRev,
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: vRev,
			viewResource: nextView,
		})).rejects.toMatchObject({ code: 'persistence.write_failed' })

		// Verify BOTH files were completely restored
		expect(await readFile(viewPath)).toEqual(origViewBytes)
		expect(await readFile(reviewPath)).toEqual(origReviewBytes)

		// Inject after apply at index 0 (first file was renamed, then fault threw before second file finished)
		injectedFault = { point: 'transaction.after_apply', index: 0 }
		await expect(persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: rRev,
			reviewResource: nextReview,
			viewId: VIEW_ID,
			expectedViewRevision: vRev,
			viewResource: nextView,
		})).rejects.toMatchObject({ code: 'persistence.write_failed' })

		// Verify BOTH files were restored, no partial state
		expect(await readFile(viewPath)).toEqual(origViewBytes)
		expect(await readFile(reviewPath)).toEqual(origReviewBytes)
	})

	it('cleans up and recovers pending transactions where COMMITTED marker exists', async () => {
		const { root, persistence } = await newWorkspace()
		const txId = '77777777-7777-4777-8777-777777777777'
		const txDir = join(root, '.uiux', '.transactions', txId)
		await mkdir(txDir, { recursive: true })
		await writeFile(join(txDir, 'COMMITTED'), 'committed')
		await writeFile(join(txDir, 'journal.json'), JSON.stringify({ operation: 'decision-promotion', changes: [] }))

		// Any locked operation recovers pending transactions
		await persistence.withLock(async () => {})

		// Verify txDir was cleaned up
		const remaining = await readdir(join(root, '.uiux', '.transactions'))
		expect(remaining).not.toContain(txId)
	})

	it('discovers real UUID asset directories only and ignores symlinks', async () => {
		const { root, persistence } = await newWorkspace()
		await persistence.assets.create(ASSET_ID, { metadata: assetFixture('file.bin', 'Real'), content: Buffer.from('data') })

		const targetDir = join(root, 'target-dir')
		await mkdir(targetDir, { recursive: true })
		const symlinkUuid = '66666666-6666-4666-8666-666666666666'
		await symlink(targetDir, join(root, 'assets', symlinkUuid), 'dir')

		const keys = await persistence.assets.discoverKeys()
		expect(keys).toContain(ASSET_ID)
		expect(keys).not.toContain(symlinkUuid)
	})

	it('refuses to serve mismatched or missing content bytes under declared asset metadata', async () => {
		const { root, persistence } = await newWorkspace()
		const assetDir = join(root, 'assets', ASSET_ID)
		await mkdir(assetDir, { recursive: true })
		// Asset metadata declares contentFilename: 'declared.png'
		const metadata: AuthoredAsset = {
			id: ASSET_ID,
			name: 'Mismatch Asset',
			contentFilename: 'declared.png',
			mediaType: 'image/png',
		}
		await writeFile(join(assetDir, 'asset.json'), JSON.stringify(metadata, null, 2))
		// But on disk, only 'different.png' exists
		await writeFile(join(assetDir, 'different.png'), Buffer.from('different content'))

		const inspected = await persistence.assets.readInspected(ASSET_ID)
		expect(inspected).toBeDefined()
		// Content must be empty, NEVER different.png
		expect(inspected?.resource.content.length).toBe(0)
		expect(inspected?.diagnostics.some(d => d.code === 'asset.content_filename_mismatch' || d.code === 'asset.invalid_content_file_count')).toBe(true)

		// When both declared and an extra unexpected file exist
		await writeFile(join(assetDir, 'declared.png'), Buffer.from('declared content'))
		const inspectedMultiple = await persistence.assets.readInspected(ASSET_ID)
		expect(inspectedMultiple).toBeDefined()
		// Must select declared.png bytes
		expect(Buffer.from(inspectedMultiple!.resource.content).toString('utf8')).toBe('declared content')
		// But preserve diagnostic about invalid content file count
		expect(inspectedMultiple?.diagnostics.some(d => d.code === 'asset.invalid_content_file_count')).toBe(true)
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
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
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

function reviewFixture(): ReviewThread {
	return {
		id: REVIEW_ID,
		anchor: { viewId: VIEW_ID, widgetId: 'root' },
		variantNames: [],
		status: 'open',
		messages: [],
		history: [],
		submissions: [],
	}
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
