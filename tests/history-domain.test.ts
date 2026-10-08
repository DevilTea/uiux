import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
	AUTOSAVE_IDLE_MS,
	AUTOSAVE_MAX_EVENTS,
	AUTOSAVE_MAX_SPAN_MS,
	BASELINE_CHECKPOINT_NAME,
	CHECKPOINT_NAME_MAX_LENGTH,
	CHECKPOINT_NOTE_MAX_LENGTH,
	COMPARISON_SUMMARY_STATUSES,
	HISTORY_ACTOR_TYPES,
	HISTORY_RESOURCE_KINDS,
	HISTORY_SCHEMA_VERSION,
	HISTORY_SOURCES,
	HISTORY_SYSTEM_ACTOR_IDS,
	HISTORY_WRITE_OPERATIONS,
	HOST_PRUNE_INTERVAL_MS,
	HOST_RETENTION_MAX_AGE_MS,
	HOST_RETENTION_MIN_KEPT,
	migrationCheckpointName,
} from '../src/domain/history/constants'
import { projectResourceHistory } from '../src/domain/history/projection'
import {
	normalizeCheckpointName,
	validateCheckpointRecord,
	validateHistoryActor,
	validateHostVersionRecord,
	validateVersionRecord,
	validateWriteEvent,
	type CheckpointRecord,
	type HostVersionRecord,
} from '../src/domain/history/schema'
import { summarizeResourceChanges } from '../src/domain/history/summary'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import {
	FileNativePersistence,
	LEGACY_LAYOUT,
	PersistenceError,
	WORKSPACE_DATA_DIRECTORY,
	WORKSPACE_MANIFEST_PATH,
	assetMetadataRelativePath,
	flowRelativePath,
	localeRelativePath,
	revisionForResourceFiles,
	upgradeSnapshotInMemory,
	viewRelativePath,
	workspaceRelativePath,
	type WorkspaceSnapshot,
} from '../src/persistence'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'

const VERSION_ID = '0199aaaa-0000-7000-8000-000000000001'
const PARENT_ID = '0199aaaa-0000-7000-8000-000000000002'
const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const REVIEW_ID = '33333333-3333-4333-8333-333333333333'
const ASSET_ID = '44444444-4444-4444-8444-444444444444'
const DIGEST = `sha256:${'a'.repeat(64)}`
const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`
const HUMAN = { type: 'human', id: 'member:m1', displayName: 'Ada' } as const
const AGENT = { type: 'agent', id: 'member:m2', displayName: 'Claude' } as const

const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('history constants', () => {
	it('carries the fixed values of the Version history records Contract', () => {
		expect(HISTORY_SCHEMA_VERSION).toBe(1)
		expect(AUTOSAVE_IDLE_MS).toBe(2 * 60 * 1000)
		expect(AUTOSAVE_MAX_SPAN_MS).toBe(30 * 60 * 1000)
		expect(AUTOSAVE_MAX_EVENTS).toBe(200)
		expect(HOST_RETENTION_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000)
		expect(HOST_RETENTION_MIN_KEPT).toBe(200)
		expect(HOST_PRUNE_INTERVAL_MS).toBe(24 * 60 * 60 * 1000)
		expect(CHECKPOINT_NAME_MAX_LENGTH).toBe(120)
		expect(CHECKPOINT_NOTE_MAX_LENGTH).toBe(2000)
		expect(HISTORY_ACTOR_TYPES).toEqual(['human', 'agent', 'system', 'external'])
		expect(HISTORY_SYSTEM_ACTOR_IDS).toEqual(['system:migrate', 'system:baseline'])
		expect(HISTORY_SOURCES).toEqual(['workbench', 'mcp', 'cli'])
		expect(COMPARISON_SUMMARY_STATUSES).toEqual(['added', 'removed', 'modified', 'unchanged'])
		expect(HISTORY_RESOURCE_KINDS).toEqual(['workspace', 'product-kit', 'access-presets', 'view', 'flow', 'locale', 'asset'])
		expect(HISTORY_WRITE_OPERATIONS).toEqual([
			'createView',
			'updateViewSpec',
			'updateViewStructure',
			'updateWorkspaceSettings',
			'composeProductKit',
			'updateProductKit',
			'updateComponentRegistry',
			'updateAccessPresets',
			'createLocale',
			'updateLocale',
			'createFlow',
			'updateFlow',
			'createAsset',
			'replaceAsset',
			'promoteReviewToDecision',
			'restoreResourceVersion',
		])
		expect(BASELINE_CHECKPOINT_NAME).toBe('Baseline')
		expect(migrationCheckpointName(7)).toBe('Before migration to schemaVersion 7')
	})

	it('cannot be changed at runtime', () => {
		for (const list of [HISTORY_ACTOR_TYPES, HISTORY_SOURCES, HISTORY_WRITE_OPERATIONS, HISTORY_RESOURCE_KINDS])
			expect(Object.isFrozen(list)).toBe(true)
	})
})

describe('version record validators', () => {
	it('round-trips a checkpoint, an autosave, an external and a system version through JSON', () => {
		const records = [
			checkpoint(),
			checkpoint({ note: 'Before the redesign', parentCheckpoint: PARENT_ID }),
			hostVersion(),
			hostVersion({ type: 'external', actor: { type: 'external' }, events: [], netChange: true, recordingGap: true }),
			hostVersion({ type: 'system', actor: { type: 'system', id: 'system:migrate' }, events: [], parent: PARENT_ID }),
			hostVersion({ restoredFrom: PARENT_ID, adapters: [{ specifier: './adapters/reference.ts' }] }),
		]
		for (const record of records) {
			const decoded = JSON.parse(JSON.stringify(record)) as unknown
			const result = validateVersionRecord(decoded)
			expect(result.diagnostics).toEqual([])
			expect(result.ok && result.value).toEqual(record)
		}
	})

	it('accepts resource kinds this build does not know (open kind set)', () => {
		const resources = [
			...baseResources(),
			{ kind: 'product-kit', key: 'product-kit', revision: 'r_pk', files: { 'product-kit.json': DIGEST } },
			{ kind: 'access-presets', key: 'access-presets', revision: 'r_ap', files: { 'access-presets.json': OTHER_DIGEST } },
			{ kind: 'future-kind', key: 'anything', revision: 'r_f', files: { 'future/anything.json': DIGEST } },
		]
		expect(validateCheckpointRecord(checkpoint({ resources })).diagnostics).toEqual([])
		const event = writeEvent({ operation: 'updateAccessPresets', resource: { kind: 'future-kind', key: 'anything' } })
		expect(validateWriteEvent(event).diagnostics).toEqual([])
		expect(validateHostVersionRecord(hostVersion({ resources, events: [event] })).diagnostics).toEqual([])
	})

	it('checks the canonical key of known kinds and identity uniqueness', () => {
		const bad = (resources: unknown[]) => codes(validateCheckpointRecord(checkpoint({ resources })))
		expect(bad([{ kind: 'workspace', key: 'other', revision: 'r', files: { [WORKSPACE_MANIFEST_PATH]: DIGEST } }])).toContain('history.invalid_resource_key')
		expect(bad([{ kind: 'product-kit', key: 'kit', revision: 'r', files: { 'product-kit.json': DIGEST } }])).toContain('history.invalid_resource_key')
		expect(bad([{ kind: 'view', key: 'not-a-uuid', revision: 'r', files: { 'views/x.view.json': DIGEST } }])).toContain('history.invalid_resource_key')
		expect(bad([{ kind: 'locale', key: 'zh-tw', revision: 'r', files: { 'i18n/zh-tw.json': DIGEST } }])).toContain('history.invalid_resource_key')
		expect(bad([{ kind: '', key: 'x', revision: 'r', files: { 'x.json': DIGEST } }])).toContain('history.invalid_resource_kind')
		const view = { kind: 'view', key: VIEW_ID, revision: 'r', files: { [viewRelativePath(VIEW_ID)]: DIGEST } }
		expect(bad([view, view])).toEqual(expect.arrayContaining(['history.duplicate_resource', 'history.duplicate_file']))
		expect(bad([{ ...view, files: {} }])).toContain('history.empty_resource_files')
		expect(bad([{ ...view, files: { '../outside.json': DIGEST } }])).toContain('history.invalid_file_path')
		expect(bad([{ ...view, files: { [viewRelativePath(VIEW_ID)]: 'sha256:short' } }])).toContain('identity.invalid_sha256')
	})

	it('bounds the checkpoint name to 1-120 characters after trimming and the note to 2,000', () => {
		const nameCodes = (name: string) => codes(validateCheckpointRecord(checkpoint({ name })))
		expect(nameCodes('x')).toEqual([])
		expect(nameCodes('x'.repeat(120))).toEqual([])
		// A stored name is already trimmed; normalizeCheckpointName trims a requested one.
		expect(nameCodes(`   ${'x'.repeat(120)}   `)).toEqual(['history.invalid_checkpoint_name'])
		expect(nameCodes('x ')).toEqual(['history.invalid_checkpoint_name'])
		expect(normalizeCheckpointName(`   ${'x'.repeat(120)}   `)).toBe('x'.repeat(120))
		expect(normalizeCheckpointName('x'.repeat(121))).toBeUndefined()
		expect(nameCodes('😀'.repeat(120))).toEqual([])
		expect(nameCodes('x'.repeat(121))).toEqual(['history.invalid_checkpoint_name'])
		expect(nameCodes('')).toEqual(['history.invalid_checkpoint_name'])
		expect(nameCodes(' \n\t ')).toEqual(['history.invalid_checkpoint_name'])
		expect(normalizeCheckpointName('  Release candidate  ')).toBe('Release candidate')
		expect(normalizeCheckpointName('   ')).toBeUndefined()
		const noteCodes = (note: string) => codes(validateCheckpointRecord(checkpoint({ note })))
		expect(noteCodes('')).toEqual([])
		expect(noteCodes('n'.repeat(2000))).toEqual([])
		expect(noteCodes('n'.repeat(2001))).toEqual(['history.invalid_checkpoint_note'])
	})

	it('requires the system checkpoint names', () => {
		const system = (id: string, name: string) => codes(validateCheckpointRecord(checkpoint({ actor: { type: 'system', id }, name, source: 'cli' })))
		expect(system('system:baseline', 'Baseline')).toEqual([])
		expect(system('system:migrate', migrationCheckpointName(4))).toEqual([])
		expect(system('system:baseline', 'First')).toEqual(['history.invalid_system_checkpoint_name'])
		expect(system('system:migrate', 'Before migration')).toEqual(['history.invalid_system_checkpoint_name'])
		expect(system('system:migrate', 'Before migration to schemaVersion 0')).toEqual(['history.invalid_system_checkpoint_name'])
	})

	it('validates actors, sources, operations and the closed record shapes', () => {
		expect(validateHistoryActor(HUMAN).ok).toBe(true)
		expect(validateHistoryActor(AGENT).ok).toBe(true)
		expect(validateHistoryActor({ type: 'external', displayName: 'Changes outside UIUX' }).ok).toBe(true)
		expect(codes(validateHistoryActor({ type: 'human', id: 'member:m1' }))).toEqual(['history.unstamped_actor'])
		expect(codes(validateHistoryActor({ type: 'agent', displayName: 'Claude' }))).toEqual(['history.unstamped_actor'])
		expect(codes(validateHistoryActor({ ...HUMAN, id: 'm1' }))).toEqual(['history.unstamped_actor'])
		expect(codes(validateHistoryActor({ ...HUMAN, id: 'member:' }))).toEqual(['history.unstamped_actor'])
		expect(codes(validateHistoryActor({ ...AGENT, displayName: '' }))).toEqual(['history.unstamped_actor'])
		expect(codes(validateHistoryActor({ type: 'system', id: 'system:capture' }))).toEqual(['history.invalid_system_actor'])
		expect(codes(validateHistoryActor({ type: 'external', id: 'x' }))).toEqual(['history.external_actor_id'])
		expect(codes(validateHistoryActor({ type: 'robot' }))).toEqual(['history.invalid_actor_type'])
		expect(codes(validateHistoryActor({ ...HUMAN, role: 'owner' }))).toEqual(['schema.unknown_field'])

		expect(codes(validateCheckpointRecord(checkpoint({ source: 'http' })))).toEqual(['history.invalid_source'])
		expect(codes(validateWriteEvent(writeEvent({ operation: 'deleteView' })))).toEqual(['history.invalid_operation'])
		expect(codes(validateWriteEvent(writeEvent({ beforeRevision: null })))).toEqual([])
		const { afterRevision: _omitted, ...missing } = writeEvent()
		void _omitted
		expect(codes(validateWriteEvent(missing))).toEqual(['history.missing_revision'])

		expect(codes(validateVersionRecord(checkpoint({ historySchemaVersion: 2 })))).toEqual(['history.unsupported_history_schema_version'])
		expect(codes(validateVersionRecord(checkpoint({ id: 'v1' })))).toEqual(['identity.invalid_uuid'])
		expect(codes(validateVersionRecord(checkpoint({ at: '2026-10-09T10:00:00+08:00' })))).toEqual(['time.invalid_rfc3339_utc'])
		expect(codes(validateVersionRecord(checkpoint({ workspaceSchemaVersion: 0 })))).toEqual(['schema.expected_positive_integer'])
		expect(codes(validateVersionRecord(checkpoint({ events: [] })))).toEqual(['schema.unknown_field'])
		expect(codes(validateVersionRecord(hostVersion({ source: 'mcp' })))).toEqual(['schema.unknown_field'])
		expect(codes(validateVersionRecord(hostVersion({ recordingGap: false })))).toEqual(['history.invalid_recording_gap'])
		expect(codes(validateVersionRecord(hostVersion({ netChange: 'yes' })))).toEqual(['history.invalid_net_change'])
		expect(codes(validateVersionRecord(hostVersion({ type: 'branch' })))).toEqual(['history.invalid_version_type'])
		expect(codes(validateVersionRecord(hostVersion({ productKit: 'kit' })))).toEqual(['schema.invalid_json_object'])
	})
})

describe('comparison summary and resource projection', () => {
	const entry = (kind: string, key: string, revision: string) => ({ kind, key, revision })

	it('reports added, removed, modified and unchanged resources by identity and revision', () => {
		const from = [entry('workspace', 'workspace', 'r1'), entry('view', VIEW_ID, 'r1'), entry('flow', FLOW_ID, 'r1')]
		const to = [entry('workspace', 'workspace', 'r1'), entry('view', VIEW_ID, 'r2'), entry('locale', 'zh-TW', 'r1'), entry('future-kind', 'x', 'r1')]
		expect(summarizeResourceChanges(from, to)).toEqual([
			{ kind: 'flow', key: FLOW_ID, status: 'removed', fromRevision: 'r1' },
			{ kind: 'future-kind', key: 'x', status: 'added', toRevision: 'r1' },
			{ kind: 'locale', key: 'zh-TW', status: 'added', toRevision: 'r1' },
			{ kind: 'view', key: VIEW_ID, status: 'modified', fromRevision: 'r1', toRevision: 'r2' },
			{ kind: 'workspace', key: 'workspace', status: 'unchanged', fromRevision: 'r1', toRevision: 'r1' },
		])
		expect(summarizeResourceChanges(undefined, [entry('view', VIEW_ID, 'r1')])).toEqual([{ kind: 'view', key: VIEW_ID, status: 'added', toRevision: 'r1' }])
	})

	it('projects a resource history from the versions where its revision changed', () => {
		const versions = [
			{ id: 'a', resources: [entry('workspace', 'workspace', 'w1')] },
			{ id: 'b', resources: [entry('workspace', 'workspace', 'w1'), entry('view', VIEW_ID, 'v1')] },
			{ id: 'c', resources: [entry('workspace', 'workspace', 'w2'), entry('view', VIEW_ID, 'v1')] },
			{ id: 'd', resources: [entry('workspace', 'workspace', 'w2'), entry('view', VIEW_ID, 'v2')] },
			{ id: 'e', resources: [entry('workspace', 'workspace', 'w2')] },
			{ id: 'f', resources: [entry('workspace', 'workspace', 'w2'), entry('view', VIEW_ID, 'v2')] },
		]
		expect(projectResourceHistory(versions, { kind: 'view', key: VIEW_ID }).map(item => [item.version.id, item.status, item.fromRevision, item.toRevision])).toEqual([
			['b', 'added', undefined, 'v1'],
			['d', 'modified', 'v1', 'v2'],
			['e', 'removed', 'v2', undefined],
			['f', 'added', undefined, 'v2'],
		])
		expect(projectResourceHistory(versions, { kind: 'workspace', key: 'workspace' }).map(item => item.version.id)).toEqual(['a', 'c'])
		expect(projectResourceHistory(versions, { kind: 'flow', key: FLOW_ID })).toEqual([])
	})
})

describe('legacy Workspace layout', () => {
	it('names the history directories from the existing path constants', () => {
		expect(LEGACY_LAYOUT.manifestPath).toBe(workspaceRelativePath())
		expect(LEGACY_LAYOUT.artifactsDir).toBe('.uiux/artifacts')
		expect(LEGACY_LAYOUT.checkpointsDir).toBe('.uiux/history/checkpoints')
		expect(LEGACY_LAYOUT.checkpointRelativePath(VERSION_ID)).toBe(`.uiux/history/checkpoints/${VERSION_ID}.json`)
		expect(() => LEGACY_LAYOUT.checkpointRelativePath('../x')).toThrow(PersistenceError)
		expect(LEGACY_LAYOUT.versionedRoots).toEqual(['.uiux/workspace.json', 'views/', 'flows/', 'i18n/', 'assets/'])
		expect(LEGACY_LAYOUT.excluded).toEqual(['reviews/', '.uiux/'])
	})

	it('classifies every versioned path family and excludes Reviews, runtime files and everything else', () => {
		const classify = LEGACY_LAYOUT.classifyVersionedPath
		expect(classify(WORKSPACE_MANIFEST_PATH)).toEqual({ kind: 'workspace', key: 'workspace' })
		expect(classify(viewRelativePath(VIEW_ID))).toEqual({ kind: 'view', key: VIEW_ID })
		expect(classify(flowRelativePath(FLOW_ID))).toEqual({ kind: 'flow', key: FLOW_ID })
		expect(classify(localeRelativePath('zh-TW'))).toEqual({ kind: 'locale', key: 'zh-TW' })
		expect(classify(assetMetadataRelativePath(ASSET_ID))).toEqual({ kind: 'asset', key: ASSET_ID })
		expect(classify(`assets/${ASSET_ID}/logo.svg`)).toEqual({ kind: 'asset', key: ASSET_ID })
		for (const excluded of EXCLUDED_PATHS)
			expect(classify(excluded), excluded).toBeUndefined()
	})

	it('classifies only paths under a versioned root, and none under an excluded one except the manifest', () => {
		const classified = [...VERSIONED_PATHS, ...EXCLUDED_PATHS].filter(path => LEGACY_LAYOUT.classifyVersionedPath(path))
		expect(classified).toEqual(VERSIONED_PATHS)
		const under = (path: string, root: string) => root.endsWith('/') ? path.startsWith(root) : path === root
		for (const path of classified) {
			expect(LEGACY_LAYOUT.versionedRoots.some(root => under(path, root)), path).toBe(true)
			if (path !== LEGACY_LAYOUT.manifestPath)
				expect(LEGACY_LAYOUT.excluded.some(root => under(path, root)), path).toBe(false)
		}
	})
})

const VERSIONED_PATHS = [
	WORKSPACE_MANIFEST_PATH,
	viewRelativePath(VIEW_ID),
	flowRelativePath(FLOW_ID),
	localeRelativePath('zh-TW'),
	assetMetadataRelativePath(ASSET_ID),
	`assets/${ASSET_ID}/logo.svg`,
]

const EXCLUDED_PATHS = [
	`reviews/${REVIEW_ID}.review.json`,
	'.uiux/artifacts/sha256/aa/' + 'a'.repeat(64),
	`.uiux/history/checkpoints/${VERSION_ID}.json`,
	'.uiux/workspace.lock',
	'.uiux/transactions/x/journal.json',
	'adapters/reference.ts',
	'kit/package.json',
	'README.md',
	'views/notes.txt',
	'views/not-a-uuid.view.json',
	`views/nested/${VIEW_ID}.view.json`,
	`flows/${FLOW_ID}.view.json`,
	'i18n/zh-tw.json',
	`assets/${ASSET_ID}`,
	`assets/${ASSET_ID}/nested/file.bin`,
	'assets/not-a-uuid/asset.json',
	`../views/${VIEW_ID}.view.json`,
	`views\\${VIEW_ID}.view.json`,
	`views/${VIEW_ID}\u0001.view.json`,
	'views/.DS_Store',
	'',
]

describe('revision parity with file-native persistence', () => {
	it('computes the same revision persistence reads for every resource kind', async () => {
		const root = await makeRoot()
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		await persistence.workspace.create(manifest(PRODUCT_WORKSPACE_SCHEMA_POLICY.currentVersion))
		await persistence.views.create(VIEW_ID, { id: VIEW_ID, name: 'Checkout', ir: { type: 'RootShell', id: 'root', slots: { content: [] } }, variants: {}, spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] } })
		await persistence.flows.create(FLOW_ID, { id: FLOW_ID, name: 'Flow', entryStepId: VIEW_ID, steps: { [VIEW_ID]: { target: { viewId: VIEW_ID }, transitions: [] } } })
		await persistence.locales.create('zh-TW', { greeting: '你好' })
		await persistence.assets.create(ASSET_ID, { metadata: { id: ASSET_ID, name: 'Logo', contentFilename: 'logo.bin', mediaType: 'application/octet-stream' }, content: Buffer.from('logo-bytes') })
		await persistence.reviews.create(REVIEW_ID, { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: [], status: 'open', messages: [], history: [], submissions: [] })
		await persistence.artifacts.put(Buffer.from('artifact'))

		const grouped = await groupVersionedFiles(root)
		expect([...grouped.keys()].sort()).toEqual(['asset\0' + ASSET_ID, 'flow\0' + FLOW_ID, 'locale\0zh-TW', 'view\0' + VIEW_ID, 'workspace\0workspace'])
		const revision = (kind: string, key: string) => revisionForResourceFiles(kind, grouped.get(`${kind}\0${key}`)!)
		expect(revision('workspace', 'workspace')).toBe((await persistence.workspace.read('workspace'))!.revision)
		expect(revision('view', VIEW_ID)).toBe(await persistence.views.readRevision(VIEW_ID))
		expect(revision('flow', FLOW_ID)).toBe(await persistence.flows.readRevision(FLOW_ID))
		expect(revision('locale', 'zh-TW')).toBe(await persistence.locales.readRevision('zh-TW'))
		const assetRevision = revision('asset', ASSET_ID)
		expect(assetRevision).toBe(await persistence.assets.readRevision(ASSET_ID))
		expect(assetRevision).toBe((await persistence.assets.read(ASSET_ID))!.revision)

		// The Asset revision covers its content as well as its metadata.
		await writeFile(join(root, 'assets', ASSET_ID, 'logo.bin'), 'changed-logo')
		const changed = (await groupVersionedFiles(root)).get(`asset\0${ASSET_ID}`)!
		expect(revisionForResourceFiles('asset', changed)).not.toBe(assetRevision)
		expect(revisionForResourceFiles('asset', changed)).toBe(await persistence.assets.readRevision(ASSET_ID))

		// An unreadable asset.json falls back to the metadata bytes, as readRevision does.
		await writeFile(join(root, assetMetadataRelativePath(ASSET_ID)), '{ not json')
		const corrupt = (await groupVersionedFiles(root)).get(`asset\0${ASSET_ID}`)!
		expect(revisionForResourceFiles('asset', corrupt)).toBe(await persistence.assets.readRevision(ASSET_ID))
	})

	it('returns undefined for missing resources and kinds without a revision rule', () => {
		expect(revisionForResourceFiles('view', new Map())).toBeUndefined()
		expect(revisionForResourceFiles('asset', new Map([[`assets/${ASSET_ID}/logo.bin`, Buffer.from('x')]]))).toBeUndefined()
		expect(revisionForResourceFiles('future-kind', new Map([['future.json', Buffer.from('{}')]]))).toBeUndefined()
		expect(() => revisionForResourceFiles('view', new Map([['a', Buffer.from('1')], ['b', Buffer.from('2')]]))).toThrow(TypeError)
	})
})

describe('in-memory snapshot upgrade', () => {
	it('upgrades every older recognized version with the product policy and leaves design files identical', async () => {
		const policy = PRODUCT_WORKSPACE_SCHEMA_POLICY
		const older = policy.recognizedVersions.filter(version => version < policy.currentVersion)
		expect(older.length).toBeGreaterThan(0)
		for (const fromVersion of older) {
			const snapshot = designSnapshot(fromVersion)
			const frozen = cloneSnapshot(snapshot)
			const upgraded = await upgradeSnapshotInMemory(snapshot, fromVersion, policy)
			expect(upgraded.steps.length).toBeGreaterThan(0)
			expect(JSON.parse(new TextDecoder().decode(upgraded.snapshot.get(WORKSPACE_MANIFEST_PATH)))).toMatchObject({ schemaVersion: policy.currentVersion })
			expect([...upgraded.snapshot.keys()].sort()).toEqual([...snapshot.keys()].sort())
			for (const [path, bytes] of snapshot) {
				if (path === WORKSPACE_MANIFEST_PATH) continue
				expect(Buffer.from(upgraded.snapshot.get(path)!).equals(Buffer.from(bytes)), path).toBe(true)
			}
			// The input snapshot is never mutated.
			for (const [path, bytes] of frozen) expect(Buffer.from(snapshot.get(path)!).equals(Buffer.from(bytes))).toBe(true)
		}
	})

	it('returns the current version unchanged and refuses an unrecognized version', async () => {
		const policy = PRODUCT_WORKSPACE_SCHEMA_POLICY
		const current = designSnapshot(policy.currentVersion)
		const same = await upgradeSnapshotInMemory(current, policy.currentVersion, policy)
		expect(same.steps).toEqual([])
		expect(snapshotsEqual(same.snapshot, current)).toBe(true)
		await expect(upgradeSnapshotInMemory(designSnapshot(policy.currentVersion + 1), policy.currentVersion + 1, policy)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		await expect(upgradeSnapshotInMemory(current, 0, policy)).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})

	it('applies the injected policy steps and wraps a failing step', async () => {
		const policy = defineWorkspaceSchemaPolicy({
			currentVersion: 2,
			recognizedVersions: [1, 2],
			steps: [{
				id: 'synthetic-1-to-2',
				fromVersion: 1,
				toVersion: 2,
				apply(snapshot: WorkspaceSnapshot) {
					const next = new Map(snapshot)
					next.set(WORKSPACE_MANIFEST_PATH, json(manifest(2)))
					return next
				},
			}],
		})
		const upgraded = await upgradeSnapshotInMemory(designSnapshot(1), 1, policy)
		expect(upgraded.steps).toEqual(['synthetic-1-to-2'])
		const failing = defineWorkspaceSchemaPolicy({ ...policy, steps: [{ ...policy.steps[0]!, apply: () => { throw new Error('boom') } }] })
		await expect(upgradeSnapshotInMemory(designSnapshot(1), 1, failing)).rejects.toMatchObject({ code: 'workspace.migration_failed' })
	})
})

function checkpoint(overrides: Record<string, unknown> = {}): CheckpointRecord {
	return {
		historySchemaVersion: 1,
		id: VERSION_ID,
		type: 'checkpoint',
		actor: HUMAN,
		at: '2026-10-09T10:00:00.000Z',
		workspaceSchemaVersion: 3,
		resources: baseResources(),
		name: 'Ready for review',
		source: 'workbench',
		...overrides,
	} as CheckpointRecord
}

function hostVersion(overrides: Record<string, unknown> = {}): HostVersionRecord {
	return {
		historySchemaVersion: 1,
		id: VERSION_ID,
		type: 'autosave',
		actor: AGENT,
		at: '2026-10-09T10:05:00.000Z',
		workspaceSchemaVersion: 3,
		resources: baseResources(),
		startedAt: '2026-10-09T10:00:00.000Z',
		netChange: true,
		events: [writeEvent()],
		...overrides,
	} as HostVersionRecord
}

function writeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		at: '2026-10-09T10:01:00.000Z',
		actor: AGENT,
		source: 'mcp',
		operation: 'updateViewSpec',
		resource: { kind: 'view', key: VIEW_ID },
		beforeRevision: 'r_before',
		afterRevision: 'r_after',
		...overrides,
	}
}

function baseResources(): Record<string, unknown>[] {
	return [
		{ kind: 'workspace', key: 'workspace', revision: 'r_ws', files: { [WORKSPACE_MANIFEST_PATH]: DIGEST } },
		{ kind: 'view', key: VIEW_ID, revision: 'r_view', files: { [viewRelativePath(VIEW_ID)]: OTHER_DIGEST } },
		{ kind: 'locale', key: 'zh-TW', revision: 'r_zh', files: { [localeRelativePath('zh-TW')]: DIGEST } },
		{ kind: 'asset', key: ASSET_ID, revision: 'r_asset', files: { [assetMetadataRelativePath(ASSET_ID)]: DIGEST, [`assets/${ASSET_ID}/logo.svg`]: OTHER_DIGEST } },
	]
}

function codes(result: Readonly<{ diagnostics: readonly Readonly<{ code: string }>[] }>): string[] {
	return result.diagnostics.map(diagnostic => diagnostic.code)
}

function manifest(schemaVersion: number): WorkspaceManifest {
	return { schemaVersion, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }
}

function json(value: unknown): Uint8Array {
	return Buffer.from(`${JSON.stringify(value, null, '\t')}\n`)
}

/** The versioned files only: history snapshots never contain Reviews. */
function designSnapshot(schemaVersion: number): Map<string, Uint8Array> {
	return new Map<string, Uint8Array>([
		[WORKSPACE_MANIFEST_PATH, json(manifest(schemaVersion))],
		[viewRelativePath(VIEW_ID), json({ id: VIEW_ID, name: 'Checkout', ir: { type: 'RootShell', id: 'root', slots: { content: [] } }, variants: {} })],
		[flowRelativePath(FLOW_ID), json({ id: FLOW_ID, name: 'Flow', entryStepId: VIEW_ID, steps: {} })],
		[localeRelativePath('zh-TW'), json({ greeting: '你好' })],
		[assetMetadataRelativePath(ASSET_ID), json({ id: ASSET_ID, name: 'Logo', contentFilename: 'logo.bin', mediaType: 'application/octet-stream' })],
		[`assets/${ASSET_ID}/logo.bin`, Buffer.from('logo-bytes')],
	])
}

function cloneSnapshot(snapshot: WorkspaceSnapshot): Map<string, Uint8Array> {
	return new Map([...snapshot].map(([path, bytes]) => [path, Uint8Array.from(bytes)]))
}

function snapshotsEqual(left: WorkspaceSnapshot, right: WorkspaceSnapshot): boolean {
	return left.size === right.size && [...left].every(([path, bytes]) => right.has(path) && Buffer.from(right.get(path)!).equals(Buffer.from(bytes)))
}

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-history-'))
	temporaryRoots.push(root)
	return root
}

/** Walks the Workspace and groups every classified file by resource identity. */
async function groupVersionedFiles(root: string): Promise<Map<string, Map<string, Uint8Array>>> {
	const grouped = new Map<string, Map<string, Uint8Array>>()
	const walk = async (relative: string): Promise<void> => {
		for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
			const path = relative ? `${relative}/${entry.name}` : entry.name
			if (entry.isDirectory()) { await walk(path); continue }
			const identity = LEGACY_LAYOUT.classifyVersionedPath(path)
			if (!identity) {
				expect(path.startsWith(WORKSPACE_DATA_DIRECTORY.reviews) || path.startsWith(WORKSPACE_DATA_DIRECTORY.workspaceMeta), path).toBe(true)
				continue
			}
			const key = `${identity.kind}\0${identity.key}`
			const files = grouped.get(key) ?? new Map<string, Uint8Array>()
			files.set(path, await readFile(join(root, path)))
			grouped.set(key, files)
		}
	}
	await walk('')
	return grouped
}
