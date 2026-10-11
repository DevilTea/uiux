import { afterEach, describe, expect, it } from 'vitest'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
	acquireServerHold,
	artifactRelativePath,
	CANONICAL_WORKSPACE_DATA_DIRECTORIES,
	FileNativePersistence,
	LEGACY_LAYOUT,
	layoutForSchemaVersion,
	readActiveServerHold,
	SERVER_HOLD_RELATIVE_PATH,
	V5_LAYOUT,
	WORKSPACE_DATA_DIRECTORY,
	workspaceRelativePath,
} from '../src/persistence'
import { CheckpointStore } from '../src/persistence/history'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { CURRENT_TEST_LAYOUT } from './support/workspace-layout'

const HEX = 'ab'.repeat(32)
const CHECKPOINT_ID = '11111111-1111-4111-8111-111111111111'
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-layout-'))
	roots.push(root)
	return root
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

describe('Workspace layout seam', () => {
	it('keeps every legacy layout path at the literal it had before the seam', () => {
		expect(LEGACY_LAYOUT.metadataDir).toBe('.uiux')
		expect(LEGACY_LAYOUT.manifestPath).toBe('.uiux/workspace.json')
		expect(LEGACY_LAYOUT.artifactsDir).toBe('.uiux/artifacts')
		expect(LEGACY_LAYOUT.checkpointsDir).toBe('.uiux/history/checkpoints')
		expect(LEGACY_LAYOUT.transactionsDir).toBe('.uiux/.transactions')
		expect(LEGACY_LAYOUT.lockPath).toBe('.uiux/.persistence.lock')
		expect(LEGACY_LAYOUT.serverHoldPath).toBe('.uiux/.server-hold.json')
		expect(LEGACY_LAYOUT.metadataFilePath('.server-hold-x.tmp')).toBe('.uiux/.server-hold-x.tmp')
		expect(LEGACY_LAYOUT.artifactRelativePath(`sha256:${HEX}`)).toBe(`.uiux/artifacts/sha256/ab/${HEX}`)
		expect(LEGACY_LAYOUT.checkpointRelativePath(CHECKPOINT_ID)).toBe(`.uiux/history/checkpoints/${CHECKPOINT_ID}.json`)
		expect(() => LEGACY_LAYOUT.artifactRelativePath('sha256:not-hex')).toThrow(expect.objectContaining({ code: 'persistence.invalid_identity' }))
		// The legacy-layout shorthands and constants still name the same paths.
		expect(workspaceRelativePath()).toBe(LEGACY_LAYOUT.manifestPath)
		expect(artifactRelativePath(`sha256:${HEX}`)).toBe(LEGACY_LAYOUT.artifactRelativePath(`sha256:${HEX}`))
		expect(SERVER_HOLD_RELATIVE_PATH).toBe(LEGACY_LAYOUT.serverHoldPath)
	})

	it('leaves the data directories the Adapter resolver refuses unchanged', () => {
		// `src/adapters/resolution.ts` refuses Adapter modules inside these directories; the seam must not change the set.
		expect(WORKSPACE_DATA_DIRECTORY).toEqual({ workspaceMeta: '.uiux', assets: 'assets', views: 'views', flows: 'flows', reviews: 'reviews', locales: 'i18n' })
		expect([...CANONICAL_WORKSPACE_DATA_DIRECTORIES].sort()).toEqual(['.uiux', 'assets', 'flows', 'i18n', 'reviews', 'views'])
	})

	it('selects the legacy layout for every schemaVersion this build knows and for unusable versions, and the schemaVersion 5 layout from 5', () => {
		for (const version of [...PRODUCT_WORKSPACE_SCHEMA_POLICY.recognizedVersions, CURRENT_WORKSPACE_SCHEMA_VERSION, 0, -1, Number.NaN])
			expect(layoutForSchemaVersion(version), String(version)).toBe(LEGACY_LAYOUT)
		for (const version of [5, 6, 99])
			expect(layoutForSchemaVersion(version), String(version)).toBe(V5_LAYOUT)
	})

	it('writes the lock, transactions, artifacts, Checkpoints and server hold at the legacy paths', async () => {
		const root = await makeRoot()
		const seen: string[] = []
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY,
			async fault(point) {
				if (point === 'transaction.before_apply')
					seen.push(...(await readdir(join(root, '.uiux', '.transactions'))))
			},
		})
		expect(persistence.layout).toBe(LEGACY_LAYOUT)
		await persistence.workspace.create({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })
		expect(await exists(join(root, '.uiux', 'workspace.json'))).toBe(true)

		await persistence.withLock(async () => {
			expect((await lstat(join(root, '.uiux', '.persistence.lock'))).isFile()).toBe(true)
		})
		expect(await exists(join(root, '.uiux', '.persistence.lock'))).toBe(false)

		const stored = await persistence.artifacts.put(new TextEncoder().encode('layout seam artifact'))
		const hex = stored.identity.slice('sha256:'.length)
		expect(await exists(join(root, '.uiux', 'artifacts', 'sha256', hex.slice(0, 2), hex))).toBe(true)
		expect(await persistence.artifacts.listIdentities()).toEqual([stored.identity])

		await persistence.withLock(() => persistence.applyFileTransaction([{ path: 'views/22222222-2222-4222-8222-222222222222.view.json', bytes: new TextEncoder().encode('{}') }], 'asset'))
		expect(seen).toHaveLength(1)
		expect(await readdir(join(root, '.uiux', '.transactions'))).toEqual([])

		await new CheckpointStore(persistence).create({
			historySchemaVersion: 1,
			id: CHECKPOINT_ID,
			type: 'checkpoint',
			actor: { type: 'human', id: 'member:m-owner', displayName: 'deviltea' },
			at: '2026-10-01T00:00:00.000Z',
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			resources: [],
			name: 'Layout seam',
			source: 'workbench',
		}, new Map())
		expect(await readdir(join(root, '.uiux', 'history', 'checkpoints'))).toEqual([`${CHECKPOINT_ID}.json`])

		const hold = await acquireServerHold(root, { layout: CURRENT_TEST_LAYOUT })
		expect(hold).toBeDefined()
		expect((await lstat(join(root, '.uiux', '.server-hold.json'))).isFile()).toBe(true)
		expect((await readActiveServerHold(root, CURRENT_TEST_LAYOUT))?.token).toBe(hold!.hold.token)
		await hold!.release()
		expect(await exists(join(root, '.uiux', '.server-hold.json'))).toBe(false)
		expect((await readdir(join(root, '.uiux'))).filter(name => name.endsWith('.tmp'))).toEqual([])
	})
})
