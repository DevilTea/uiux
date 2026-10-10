import { randomUUID } from 'node:crypto'
import { appendFile, chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { HOST_RETENTION_MAX_AGE_MS, HOST_RETENTION_MIN_KEPT } from '../src/domain/history/constants'
import type { CheckpointRecord, HistoryActor, HistoryResourceEntry, HostVersionRecord } from '../src/domain/history/schema'
import type { ReviewThread } from '../src/domain/reviews/schema'
import type { ViewResource } from '../src/domain/views/schema'
import type { WorkspaceManifest } from '../src/domain/workspace/schema'
import {
	FileNativePersistence,
	LEGACY_LAYOUT,
	assetMetadataRelativePath,
	flowRelativePath,
	localeRelativePath,
	viewRelativePath,
	workspaceRelativePath,
	type CanonicalResourceChange,
	type CanonicalWriteObserver,
	type PersistenceFaultPoint,
	type WorkspaceSnapshot,
} from '../src/persistence'
import {
	CheckpointStore,
	HostHistoryStore,
	blobDigest,
	collectHostGarbage,
	decodeTimelineCursor,
	encodeTimelineCursor,
	mergeTimeline,
	pageTimeline,
	pruneHostHistory,
	readMergedTimeline,
	runWithDesignWriteContext,
	selectPrunableHostVersions,
	versionResourcesFromSnapshot,
	writeFullyAt,
	TimelineCursorError,
	type DesignWriteContext,
	type HostHistoryPaths,
	type OpenAutosaveEntry,
} from '../src/persistence/history'
import { defineWorkspaceSchemaPolicy } from '../src/persistence/schema-policy'
import { accessStorePaths, hostHistoryPaths, workspaceStoreId } from '../src/server/access/store'
import { createSelectedWorkspaceServerRuntime } from '../src/server/selected-workspace'
import { metadataPath } from './support/workspace-layout'

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const FLOW_ID = '22222222-2222-4222-8222-222222222222'
const REVIEW_ID = '33333333-3333-4333-8333-333333333333'
const ASSET_ID = '44444444-4444-4444-8444-444444444444'
const AGENT: HistoryActor = { type: 'agent', id: 'member:m-agent', displayName: 'claude' }
const HUMAN: HistoryActor = { type: 'human', id: 'member:m-owner', displayName: 'deviltea' }
const CONTEXT: DesignWriteContext = { actor: AGENT, source: 'mcp', operation: 'updateViewSpec' }
const NOW = new Date('2026-10-09T00:00:00.000Z')

const cleanup: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(path)
	return path
}

async function hostStore(options: { fault?: (point: PersistenceFaultPoint, details: Readonly<{ path?: string }>) => void } = {}): Promise<{ store: HostHistoryStore; paths: HostHistoryPaths; base: string }> {
	const base = await tempDir('uiux-history-')
	const paths = hostHistoryPaths(join(base, 'home'), join(base, 'ws'))
	const store = (await HostHistoryStore.open({ paths, create: true, ...(options.fault ? { fault: options.fault } : {}) }))!
	return { store, paths, base }
}

function iso(ms: number): string {
	return new Date(ms).toISOString()
}

function hostVersion(overrides: Partial<HostVersionRecord> & Pick<HostVersionRecord, 'type'>): HostVersionRecord {
	const at = overrides.at ?? NOW.toISOString()
	const actor: HistoryActor = overrides.type === 'external' ? { type: 'external' } : overrides.type === 'system' ? { type: 'system', id: 'system:migrate' } : AGENT
	return {
		historySchemaVersion: 1,
		id: randomUUID(),
		actor,
		at,
		workspaceSchemaVersion: 2,
		resources: [],
		startedAt: at,
		netChange: true,
		events: [],
		...overrides,
	} as HostVersionRecord
}

function checkpoint(overrides: Partial<CheckpointRecord> = {}): CheckpointRecord {
	return {
		historySchemaVersion: 1,
		id: randomUUID(),
		type: 'checkpoint',
		actor: HUMAN,
		at: NOW.toISOString(),
		workspaceSchemaVersion: 2,
		resources: [],
		name: 'Before launch',
		source: 'workbench',
		...overrides,
	}
}

function resourceWithBlob(bytes: Uint8Array, key = VIEW_ID): HistoryResourceEntry {
	return { kind: 'view', key, revision: 'r_test', files: { [viewRelativePath(key)]: blobDigest(bytes) } }
}

describe('host history paths', () => {
	it('lives under $UIUX_HOME/workspaces/<wsid>/history with the roster\'s <wsid>', () => {
		const paths = hostHistoryPaths('/h', '/work/design')
		const wsid = workspaceStoreId('/work/design')
		expect(paths.workspaceDir).toBe(accessStorePaths('/h', '/work/design').dir)
		expect(paths.dir).toBe(`/h/workspaces/${wsid}/history`)
		expect(paths.versions).toBe(`/h/workspaces/${wsid}/history/versions`)
		expect(paths.open).toBe(`/h/workspaces/${wsid}/history/open.json`)
		expect(paths.objects).toBe(`/h/workspaces/${wsid}/history/objects/sha256`)
	})
})

describe('host history store', () => {
	it('writes one canonical 0600 file per version under 0700 directories and blobs at objects/sha256/<2>/<64>', async () => {
		const { store, paths } = await hostStore()
		const bytes = Buffer.from('{"id":"view"}\n')
		const digest = await store.putBlob(bytes)
		const version = hostVersion({ type: 'autosave', resources: [resourceWithBlob(bytes)] })
		await store.writeVersion(version)
		await store.appendOpenEntry({ type: 'begin', id: randomUUID(), startedAt: NOW.toISOString() })

		for (const directory of [paths.home, paths.workspaces, paths.workspaceDir, paths.dir, paths.versions, paths.objects])
			expect((await stat(directory)).mode & 0o777).toBe(0o700)
		const hex = digest.slice('sha256:'.length)
		const blobPath = join(paths.objects, hex.slice(0, 2), hex)
		for (const file of [join(paths.versions, `${version.id}.json`), blobPath, paths.open])
			expect((await stat(file)).mode & 0o777).toBe(0o600)
		expect(await readFile(blobPath)).toEqual(bytes)
		const written = await readFile(join(paths.versions, `${version.id}.json`), 'utf8')
		expect(written.endsWith('}\n')).toBe(true)
		expect(written).not.toContain('\n  ')
		expect(await store.readVersion(version.id)).toEqual(version)
		expect((await store.listVersions()).records.map(record => record.id)).toEqual([version.id])
		expect(await store.readBlob(digest)).toEqual(Uint8Array.from(bytes))
		expect(await store.putBlob(bytes)).toBe(digest)
	})

	it('never replaces a version by id and refuses an invalid record', async () => {
		const { store } = await hostStore()
		const version = hostVersion({ type: 'autosave' })
		await store.writeVersion(version)
		await expect(store.writeVersion({ ...version, netChange: false })).rejects.toMatchObject({ code: 'history.record_exists' })
		expect((await store.readVersion(version.id))?.netChange).toBe(true)
		await expect(store.writeVersion({ ...hostVersion({ type: 'autosave' }), actor: { type: 'agent' } } as HostVersionRecord)).rejects.toMatchObject({ code: 'history.record_invalid' })
	})

	it('refuses symbolic links and group-writable entries like the roster', async () => {
		const base = await tempDir('uiux-history-links-')
		const elsewhere = join(base, 'elsewhere')
		await mkdir(elsewhere, { mode: 0o700 })
		const paths = hostHistoryPaths(join(base, 'home'), join(base, 'ws'))
		await mkdir(paths.workspaceDir, { recursive: true, mode: 0o700 })
		await symlink(elsewhere, paths.dir)
		await expect(HostHistoryStore.open({ paths, create: true })).rejects.toMatchObject({ code: 'history.store_unsafe' })
		await rm(paths.dir)

		const store = (await HostHistoryStore.open({ paths, create: true }))!
		const target = join(elsewhere, 'target.json')
		await writeFile(target, 'x', { mode: 0o600 })
		const id = randomUUID()
		await symlink(target, join(paths.versions, `${id}.json`))
		await expect(store.readVersion(id)).rejects.toMatchObject({ code: 'history.store_unsafe' })
		await symlink(target, paths.open)
		await expect(store.appendOpenEntry({ type: 'gap', at: NOW.toISOString() })).rejects.toMatchObject({ code: 'history.store_unsafe' })
		expect(await readFile(target, 'utf8')).toBe('x')

		await chmod(paths.versions, 0o777)
		await expect(HostHistoryStore.open({ paths })).rejects.toMatchObject({ code: 'history.store_unsafe' })
		await chmod(paths.versions, 0o700)
		expect(await HostHistoryStore.open({ paths: hostHistoryPaths(join(base, 'missing'), join(base, 'ws')) })).toBeUndefined()
	})

	it.each([
		['file.before_rename'],
		['file.after_rename'],
	] as const)('leaves no partial or temporary version file when a write fails at %s', async (failAt) => {
		const { store, paths } = await hostStore({
			fault(point) {
				if (point === failAt) throw new Error(`injected ${point}`)
			},
		})
		const version = hostVersion({ type: 'autosave' })
		await expect(store.writeVersion(version)).rejects.toMatchObject({ code: 'history.write_failed' })
		expect(await readdir(paths.versions)).toEqual([])
		expect(await store.readVersion(version.id)).toBeUndefined()
	})

	it('keeps the previous record bytes when a replacement fails after its rename', async () => {
		let armed = false
		const { store, paths } = await hostStore({
			fault(point) {
				if (armed && point === 'file.after_rename') throw new Error('injected after rename')
			},
		})
		const version = hostVersion({ type: 'autosave', parent: randomUUID() })
		await store.writeVersion(version)
		const before = await readFile(join(paths.versions, `${version.id}.json`))
		armed = true
		const { parent: _parent, ...withoutParent } = version
		void _parent
		await expect(store.replaceVersion(withoutParent)).rejects.toMatchObject({ code: 'history.write_failed' })
		expect(await readFile(join(paths.versions, `${version.id}.json`))).toEqual(before)
		expect(await readdir(paths.versions)).toEqual([`${version.id}.json`])
	})

	it.each([
		['artifact.before_publish'],
		['artifact.after_publish'],
	] as const)('leaves no blob or temporary file when a blob write fails at %s', async (failAt) => {
		const { store, paths } = await hostStore({
			fault(point) {
				if (point === failAt) throw new Error(`injected ${point}`)
			},
		})
		const bytes = Buffer.from('blob')
		await expect(store.putBlob(bytes)).rejects.toMatchObject({ code: 'history.write_failed' })
		expect(await store.hasBlob(blobDigest(bytes))).toBe(false)
		const hex = blobDigest(bytes).slice('sha256:'.length)
		expect(await readdir(join(paths.objects, hex.slice(0, 2)))).toEqual([])
	})
})

describe('open autosave journal', () => {
	const event = (afterRevision: string): OpenAutosaveEntry => ({
		type: 'event',
		event: { at: NOW.toISOString(), actor: AGENT, source: 'mcp', operation: 'updateViewSpec', resource: { kind: 'view', key: VIEW_ID }, beforeRevision: 'r_a', afterRevision },
		files: { [viewRelativePath(VIEW_ID)]: blobDigest(Buffer.from(afterRevision)) },
	})

	it('drops a final line cut short by a crash and trims it before the next append', async () => {
		const { store, paths } = await hostStore()
		const begin: OpenAutosaveEntry = { type: 'begin', id: randomUUID(), startedAt: NOW.toISOString() }
		await store.appendOpenEntry(begin)
		await store.appendOpenEntry(event('r_b'))
		const complete = await readFile(paths.open, 'utf8')
		expect(complete.split('\n')).toHaveLength(3)

		// A crash during the third append leaves part of its line without the newline.
		const partial = JSON.stringify(event('r_c')).slice(0, 40)
		await appendFile(paths.open, partial)
		expect(await store.readOpenJournal()).toEqual({ entries: [begin, event('r_b')], droppedPartialLine: true })

		await store.appendOpenEntry(event('r_d'))
		expect(await readFile(paths.open, 'utf8')).toBe(`${complete}${JSON.stringify(event('r_d'))}\n`)
		expect(await store.readOpenJournal()).toEqual({ entries: [begin, event('r_b'), event('r_d')], droppedPartialLine: false })

		await store.clearOpenJournal()
		expect(await store.readOpenJournal()).toBeUndefined()
	})

	it('finishes short writes and fails, rather than spins, on a write that makes no progress', async () => {
		const bytes = Buffer.from('{"type":"gap"}\n')
		const written: number[] = []
		const short = {
			async write(buffer: Uint8Array, offset: number, length: number, position: number) {
				const count = Math.min(3, length)
				for (let index = 0; index < count; index++) written[position + index] = buffer[offset + index]!
				return { bytesWritten: count, buffer }
			},
		}
		await writeFullyAt(short as never, bytes, 0)
		expect(Buffer.from(written)).toEqual(bytes)

		let calls = 0
		const stuck = {
			async write(buffer: Uint8Array) {
				calls += 1
				return { bytesWritten: 0, buffer }
			},
		}
		await expect(writeFullyAt(stuck as never, bytes, 0)).rejects.toMatchObject({ code: 'history.write_failed' })
		expect(calls).toBe(1)
	})

	it('refuses a corrupt complete line and an invalid entry', async () => {
		const { store, paths } = await hostStore()
		await writeFile(paths.open, `{"type":"gap","at":"${NOW.toISOString()}"}\nnot json\n{"type":"gap","at":"${NOW.toISOString()}"}\n`, { mode: 0o600 })
		await expect(store.readOpenJournal()).rejects.toMatchObject({ code: 'history.journal_invalid' })
		await expect(store.appendOpenEntry({ type: 'begin', id: 'nope', startedAt: NOW.toISOString() })).rejects.toMatchObject({ code: 'history.journal_invalid' })
	})
})

describe('host retention', () => {
	it('prunes autosave and external versions at least 30 days old beyond the latest 200, never system versions', () => {
		const old = (type: 'autosave' | 'external' | 'system', ageMs: number) => hostVersion({ type, at: iso(NOW.getTime() - ageMs) })
		const latest = Array.from({ length: HOST_RETENTION_MIN_KEPT }, (_, index) => old('autosave', HOST_RETENTION_MAX_AGE_MS + (index + 1) * 1000))
		// Exactly the kept count: nothing goes, however old.
		expect(selectPrunableHostVersions(latest, NOW).size).toBe(0)

		const recent = Array.from({ length: HOST_RETENTION_MIN_KEPT }, (_, index) => old('autosave', (index + 1) * 60_000))
		const youngerThanRetention = old('autosave', HOST_RETENTION_MAX_AGE_MS - 1)
		const exactlyRetention = old('autosave', HOST_RETENTION_MAX_AGE_MS)
		const externalOld = old('external', HOST_RETENTION_MAX_AGE_MS * 2)
		const systemOld = old('system', HOST_RETENTION_MAX_AGE_MS * 3)
		const prunable = selectPrunableHostVersions([...recent, youngerThanRetention, exactlyRetention, externalOld, systemOld], NOW)
		expect([...prunable].sort()).toEqual([exactlyRetention.id, externalOld.id].sort())
	})

	it('re-points surviving parents, removes pruned versions, keeps checkpoints, and collects unnamed host blobs', async () => {
		const { store } = await hostStore()
		const root = await tempDir('uiux-history-ws-')
		const persistence = await newWorkspace(root)
		const checkpoints = new CheckpointStore(persistence)

		const prunedOnly = Buffer.from('named only by a pruned version')
		const checkpointOnly = Buffer.from('named only by a checkpoint')
		const journalOnly = Buffer.from('named only by the open autosave')
		const unnamed = Buffer.from('named by nothing')
		for (const bytes of [prunedOnly, checkpointOnly, journalOnly, unnamed]) await store.putBlob(bytes)

		const system = hostVersion({ type: 'system', at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS * 3) })
		const external = hostVersion({ type: 'external', actor: { type: 'external' }, at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS * 2), parent: system.id, resources: [resourceWithBlob(prunedOnly)] })
		const aged = hostVersion({ type: 'autosave', at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS), parent: external.id })
		const young = hostVersion({ type: 'autosave', at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS + 1), parent: aged.id })
		const recent: HostVersionRecord[] = []
		let parent = young.id
		for (let index = HOST_RETENTION_MIN_KEPT; index >= 1; index--) {
			const version = hostVersion({ type: 'autosave', at: iso(NOW.getTime() - index * 60_000), parent })
			recent.push(version)
			parent = version.id
		}
		for (const version of [system, external, aged, young, ...recent]) await store.writeVersion(version)
		const kept = checkpoint({ at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS * 4), resources: [resourceWithBlob(checkpointOnly)] })
		await checkpoints.create(kept, new Map([[blobDigest(checkpointOnly), checkpointOnly]]))
		const checkpointBytes = await readFile(join(root, LEGACY_LAYOUT.checkpointRelativePath(kept.id)))
		await store.appendOpenEntry({ type: 'event', event: { at: NOW.toISOString(), actor: AGENT, source: 'mcp', operation: 'updateViewSpec', resource: { kind: 'view', key: VIEW_ID }, beforeRevision: null, afterRevision: 'r_x' }, files: { [viewRelativePath(VIEW_ID)]: blobDigest(journalOnly) } })

		// A timeline read holds the persistence read lock across both stores: a prune started while
		// the read is paused between them waits, and the read sees the whole timeline before the prune.
		let entered!: () => void
		let release!: () => void
		const readEntered = new Promise<void>(resolve => entered = resolve)
		const gate = new Promise<void>(resolve => release = resolve)
		const pausedHost = {
			async listVersions() {
				const listing = await store.listVersions()
				entered()
				await gate
				return listing
			},
		} as unknown as HostHistoryStore
		const reading = readMergedTimeline(persistence, { host: pausedHost, checkpoints })
		await readEntered
		let pruneStarted = false
		const pruning = persistence.withLock(async () => {
			pruneStarted = true
			return pruneHostHistory({ host: store, checkpoints: await checkpoints.listUnlocked(), now: NOW })
		})
		await new Promise(resolve => setTimeout(resolve, 200))
		expect(pruneStarted).toBe(false)
		release()
		const snapshot = await reading
		expect(snapshot.invalid).toEqual([])
		expect(snapshot.versions).toHaveLength(HOST_RETENTION_MIN_KEPT + 5)
		const result = await pruning
		expect(pruneStarted).toBe(true)
		expect((await readMergedTimeline(persistence, { host: store, checkpoints })).versions).toHaveLength(HOST_RETENTION_MIN_KEPT + 3)

		expect(result.pruned).toEqual([external.id, aged.id].sort())
		expect(result.repointed).toEqual([{ id: young.id, parent: system.id }])
		expect(result.cycles).toEqual([])
		expect((await store.readVersion(young.id))?.parent).toBe(system.id)
		expect(await store.readVersion(external.id)).toBeUndefined()
		expect(await store.readVersion(system.id)).toEqual(system)
		expect((await store.listVersions()).records).toHaveLength(HOST_RETENTION_MIN_KEPT + 2)
		expect(await readFile(join(root, LEGACY_LAYOUT.checkpointRelativePath(kept.id)))).toEqual(checkpointBytes)
		expect([...result.gc.removed].sort()).toEqual([blobDigest(prunedOnly), blobDigest(unnamed)].sort())
		expect(await store.hasBlob(blobDigest(checkpointOnly))).toBe(true)
		expect(await store.hasBlob(blobDigest(journalOnly))).toBe(true)
	}, 60_000)

	it('drops a pruned first parent and skips the sweep while any record is unreadable', async () => {
		const { store, paths } = await hostStore()
		const first = hostVersion({ type: 'external', actor: { type: 'external' }, at: iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS * 2) })
		const versions = [first]
		for (let index = HOST_RETENTION_MIN_KEPT; index >= 1; index--)
			versions.push(hostVersion({ type: 'autosave', at: iso(NOW.getTime() - index * 1000), parent: versions.at(-1)!.id }))
		for (const version of versions) await store.writeVersion(version)
		const orphan = Buffer.from('orphan')
		await store.putBlob(orphan)
		await writeFile(join(paths.versions, `${randomUUID()}.json`), '{', { mode: 0o600 })

		const result = await pruneHostHistory({ host: store, checkpoints: { records: [], invalid: [] }, now: NOW })
		expect(result.pruned).toEqual([first.id])
		expect(result.repointed).toEqual([{ id: versions[1]!.id }])
		expect(await store.readVersion(versions[1]!.id)).not.toHaveProperty('parent')
		expect(result.gc).toMatchObject({ removed: [], skipped: expect.stringContaining('host version') })
		expect(await store.hasBlob(blobDigest(orphan))).toBe(true)

		const skippedForCheckpoints = await collectHostGarbage({ host: store, checkpoints: { records: [], invalid: [{ file: 'x', diagnostics: [] }] } })
		expect(skippedForCheckpoints.removed).toEqual([])
	}, 60_000)

	it('terminates on a parent cycle or a self-parent among pruned versions and reports the dropped parents', async () => {
		const { store } = await hostStore()
		const old = (ageDays: number) => iso(NOW.getTime() - HOST_RETENTION_MAX_AGE_MS - ageDays * 86_400_000)
		const [loopA, loopB, self] = [randomUUID(), randomUUID(), randomUUID()]
		const versions = [
			hostVersion({ type: 'autosave', id: loopA, at: old(3), parent: loopB }),
			hostVersion({ type: 'autosave', id: loopB, at: old(2), parent: loopA }),
			hostVersion({ type: 'autosave', id: self, at: old(1), parent: self }),
		]
		const intoLoop = hostVersion({ type: 'system', at: old(0), parent: loopA })
		const intoSelf = hostVersion({ type: 'system', at: old(0), parent: self })
		const selfSurvivor = hostVersion({ type: 'system', at: old(0) })
		versions.push(intoLoop, intoSelf, { ...selfSurvivor, parent: selfSurvivor.id })
		for (let index = HOST_RETENTION_MIN_KEPT; index >= 1; index--)
			versions.push(hostVersion({ type: 'autosave', at: iso(NOW.getTime() - index * 1000) }))
		for (const version of versions) await store.writeVersion(version)

		const result = await pruneHostHistory({ host: store, checkpoints: { records: [], invalid: [] }, now: NOW })
		expect(result.pruned).toEqual([loopA, loopB, self].sort())
		expect([...result.cycles].sort()).toEqual([intoLoop.id, intoSelf.id].sort())
		expect(await store.readVersion(intoLoop.id)).not.toHaveProperty('parent')
		expect(await store.readVersion(intoSelf.id)).not.toHaveProperty('parent')
		// A surviving self-parent is never walked, so it is left as it is.
		expect((await store.readVersion(selfSurvivor.id))?.parent).toBe(selfSurvivor.id)
	}, 60_000)

	it('lists versions without failing while versions are removed underneath', async () => {
		const { store } = await hostStore()
		const versions = Array.from({ length: 80 }, (_, index) => hostVersion({ type: 'autosave', at: iso(NOW.getTime() - index * 1000) }))
		for (const version of versions) await store.writeVersion(version)
		const listings = Array.from({ length: 5 }, () => store.listVersions())
		const removals = versions.map(version => store.removeVersion(version.id))
		const results = await Promise.all([...listings, ...removals])
		for (const listing of results.slice(0, 5) as Awaited<ReturnType<HostHistoryStore['listVersions']>>[]) {
			expect(listing.invalid).toEqual([])
			expect(listing.records.length).toBeLessThanOrEqual(versions.length)
		}
		expect((await store.listVersions()).records).toEqual([])
		expect(await store.readVersion(versions[0]!.id)).toBeUndefined()
	}, 60_000)
})

describe('checkpoint store and versioned snapshot', () => {
	it('scans only versioned files and turns them into resources with persistence revisions', async () => {
		const root = await tempDir('uiux-history-scan-')
		const persistence = await newWorkspace(root)
		await seedAllKinds(persistence)
		await persistence.reviews.create(REVIEW_ID, reviewFixture())
		await persistence.artifacts.put(Buffer.from('artifact'))
		await writeFile(join(root, 'views', 'notes.txt'), 'not versioned')
		await mkdir(join(root, 'views', 'drafts'))
		await writeFile(join(root, 'views', 'drafts', `${VIEW_ID}.view.json`), '{}')

		const snapshot = await persistence.withLock(() => persistence.scanVersionedSnapshotUnlocked())
		expect([...snapshot.keys()]).toEqual([
			workspaceRelativePath(),
			`assets/${ASSET_ID}/asset.json`,
			`assets/${ASSET_ID}/logo.bin`,
			flowRelativePath(FLOW_ID),
			localeRelativePath('zh-TW'),
			viewRelativePath(VIEW_ID),
		].sort())

		const { resources, blobs } = versionResourcesFromSnapshot(snapshot)
		expect(resources.map(resource => `${resource.kind}:${resource.key}`)).toEqual(['asset:' + ASSET_ID, 'flow:' + FLOW_ID, 'locale:zh-TW', 'view:' + VIEW_ID, 'workspace:workspace'])
		const revisionOf = (kind: string) => resources.find(resource => resource.kind === kind)!.revision
		expect(revisionOf('view')).toBe(await persistence.views.readRevision(VIEW_ID))
		expect(revisionOf('asset')).toBe(await persistence.assets.readRevision(ASSET_ID))
		expect(revisionOf('workspace')).toBe((await persistence.workspace.read('workspace'))!.revision)
		expect(blobs.size).toBe(6)
		for (const [digest, bytes] of blobs) expect(blobDigest(bytes)).toBe(digest)

		await rm(join(root, 'flows'), { recursive: true })
		await symlink(join(root, 'views'), join(root, 'flows'))
		await expect(persistence.withLock(() => persistence.scanVersionedSnapshotUnlocked())).rejects.toMatchObject({ code: 'persistence.path_rejected' })
	})

	it('writes one canonical JSON file per checkpoint after storing its blobs in the artifact store', async () => {
		const root = await tempDir('uiux-history-checkpoint-')
		const persistence = await newWorkspace(root)
		await seedAllKinds(persistence)
		const store = new CheckpointStore(persistence)
		const { resources, blobs } = versionResourcesFromSnapshot(await persistence.withLock(() => persistence.scanVersionedSnapshotUnlocked()))
		const first = checkpoint({ resources, at: iso(NOW.getTime() - 1000) })
		await store.create(first, blobs)

		const path = join(root, LEGACY_LAYOUT.checkpointRelativePath(first.id))
		expect(path).toBe(join(root, '.uiux', 'history', 'checkpoints', `${first.id}.json`))
		const text = await readFile(path, 'utf8')
		expect(JSON.parse(text)).toEqual(first)
		expect(text).toBe(`${JSON.stringify(sortKeys(first))}\n`)
		for (const digest of blobs.keys()) expect(await persistence.artifacts.read(digest)).toEqual(Uint8Array.from(blobs.get(digest)!))

		// A later checkpoint may name already stored blobs without supplying them again.
		const second = checkpoint({ resources, parentCheckpoint: first.id })
		await store.create(second, new Map())
		expect((await store.list()).records.map(record => record.id)).toEqual([first.id, second.id])
		expect(await store.read(second.id)).toEqual(second)
		await expect(store.create(second, new Map())).rejects.toMatchObject({ code: 'persistence.resource_exists' })
		await expect(store.create(checkpoint({ resources: [resourceWithBlob(Buffer.from('never stored'))] }), new Map())).rejects.toMatchObject({ code: 'persistence.resource_not_found' })
		await expect(store.create({ ...checkpoint(), name: '   ' }, new Map())).rejects.toMatchObject({ code: 'persistence.invalid_resource' })
	})
})

describe('merged timeline', () => {
	it('orders both stores by time then id, links merged predecessors, and pages with a stable cursor', async () => {
		const at = (seconds: number) => iso(NOW.getTime() + seconds * 1000)
		const sameInstant = at(20)
		const [lowId, highId] = [randomUUID(), randomUUID()].sort()
		const a = hostVersion({ type: 'autosave', at: at(10) })
		const b = checkpoint({ at: sameInstant, id: highId! })
		const c = hostVersion({ type: 'external', actor: { type: 'external' }, at: sameInstant, id: lowId!, parent: a.id })
		const d = hostVersion({ type: 'autosave', at: at(30), parent: c.id })
		const e = checkpoint({ at: at(40), parentCheckpoint: b.id })

		const timeline = mergeTimeline({ records: [d, a, c], invalid: [] }, { records: [e, b], invalid: [] })
		expect(timeline.versions.map(entry => entry.version.id)).toEqual([a.id, c.id, b.id, d.id, e.id])
		expect(timeline.versions.map(entry => entry.store)).toEqual(['host', 'host', 'workspace', 'host', 'workspace'])
		expect(timeline.versions.map(entry => entry.predecessor)).toEqual([undefined, a.id, c.id, b.id, d.id])

		const first = pageTimeline(timeline, { limit: 2 })
		expect(first.items.map(entry => entry.version.id)).toEqual([e.id, d.id])
		expect(decodeTimelineCursor(first.nextCursor!)).toEqual({ at: d.at, id: d.id })

		// A newer version and a pruned older one do not move the cursor's place.
		const newer = hostVersion({ type: 'autosave', at: at(50) })
		const changed = mergeTimeline({ records: [newer, d, c], invalid: [] }, { records: [e, b], invalid: [] })
		const second = pageTimeline(changed, { limit: 2, cursor: first.nextCursor })
		expect(second.items.map(entry => entry.version.id)).toEqual([b.id, c.id])
		expect(second.nextCursor).toBeUndefined()
		expect(pageTimeline(timeline, { limit: 2, cursor: first.nextCursor }).nextCursor).toBe(encodeTimelineCursor(c))

		expect(() => decodeTimelineCursor('garbage')).toThrow(TimelineCursorError)
		expect(() => pageTimeline(timeline, { limit: 0 })).toThrow(RangeError)
	})
})

describe('persistence write observer', () => {
	type Call = Readonly<{ hook: 'before' | 'after'; context: DesignWriteContext; changes?: readonly CanonicalResourceChange[] }>

	function recorder(): { observer: CanonicalWriteObserver; calls: Call[] } {
		const calls: Call[] = []
		return {
			calls,
			observer: {
				beforeCanonicalWrite(context) { calls.push({ hook: 'before', context }) },
				afterCanonicalCommit(context, changes) { calls.push({ hook: 'after', context, changes }) },
			},
		}
	}

	async function expectCommitted(root: string, changes: readonly CanonicalResourceChange[]): Promise<void> {
		for (const change of changes) {
			for (const file of change.files) {
				if (file.bytes === null) await expect(lstat(join(root, file.path))).rejects.toMatchObject({ code: 'ENOENT' })
				else expect(Uint8Array.from(await readFile(join(root, file.path)))).toEqual(file.bytes)
			}
		}
	}

	it('fires each hook exactly once per committed write, with the exact committed bytes, for every versioned repository', async () => {
		const root = await tempDir('uiux-history-hooks-')
		const persistence = await newWorkspace(root)
		const { observer, calls } = recorder()
		persistence.setWriteObserver(observer)
		const inContext = <T>(operation: () => Promise<T>) => runWithDesignWriteContext(CONTEXT, operation)

		const cases: { label: string; kind: string; key: string; run: () => Promise<unknown>; revision: () => Promise<string | undefined> }[] = [
			{ label: 'view create', kind: 'view', key: VIEW_ID, run: () => persistence.views.create(VIEW_ID, viewFixture()), revision: () => persistence.views.readRevision(VIEW_ID) },
			{ label: 'view CAS', kind: 'view', key: VIEW_ID, run: async () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: (await persistence.views.readRevision(VIEW_ID))!, resource: { ...viewFixture(), name: 'Renamed' } }), revision: () => persistence.views.readRevision(VIEW_ID) },
			{ label: 'flow create', kind: 'flow', key: FLOW_ID, run: () => persistence.flows.create(FLOW_ID, flowFixture()), revision: () => persistence.flows.readRevision(FLOW_ID) },
			{ label: 'flow CAS', kind: 'flow', key: FLOW_ID, run: async () => persistence.flows.compareAndSwap({ key: FLOW_ID, expectedRevision: (await persistence.flows.readRevision(FLOW_ID))!, resource: { ...flowFixture(), name: 'Renamed Flow' } }), revision: () => persistence.flows.readRevision(FLOW_ID) },
			{ label: 'workspace CAS', kind: 'workspace', key: 'workspace', run: async () => persistence.workspace.compareAndSwap({ key: 'workspace', expectedRevision: (await persistence.workspace.read('workspace'))!.revision, resource: { ...workspaceFixture(), themes: { dark: {} } } as WorkspaceManifest }), revision: async () => (await persistence.workspace.read('workspace'))?.revision },
			{ label: 'locale create', kind: 'locale', key: 'zh-TW', run: () => persistence.locales.create('zh-TW', { greeting: '嗨' }), revision: () => persistence.locales.readRevision('zh-TW') },
			{ label: 'locale CAS', kind: 'locale', key: 'zh-TW', run: async () => persistence.locales.compareAndSwap({ key: 'zh-TW', expectedRevision: (await persistence.locales.readRevision('zh-TW'))!, resource: { greeting: '你好' } }), revision: () => persistence.locales.readRevision('zh-TW') },
			{ label: 'asset create', kind: 'asset', key: ASSET_ID, run: () => persistence.assets.create(ASSET_ID, { metadata: assetFixture('logo.bin'), content: Buffer.from('v1') }), revision: () => persistence.assets.readRevision(ASSET_ID) },
			{ label: 'asset replace', kind: 'asset', key: ASSET_ID, run: async () => persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: (await persistence.assets.readRevision(ASSET_ID))!, resource: { metadata: assetFixture('logo-2.bin'), content: Buffer.from('v2') } }), revision: () => persistence.assets.readRevision(ASSET_ID) },
		]
		for (const testCase of cases) {
			const before = await testCase.revision()
			calls.length = 0
			await inContext(testCase.run)
			expect(calls.map(call => call.hook), testCase.label).toEqual(['before', 'after'])
			expect(calls[0]!.context).toEqual(CONTEXT)
			const changes = calls[1]!.changes!
			expect(changes, testCase.label).toHaveLength(1)
			expect(changes[0]!.resource).toEqual({ kind: testCase.kind, key: testCase.key })
			expect(changes[0]!.beforeRevision, testCase.label).toBe(before ?? null)
			expect(changes[0]!.afterRevision, testCase.label).toBe((await testCase.revision()) ?? null)
			await expectCommitted(root, changes)
		}
		// The Asset replacement also removed the previous content file, and says so.
		const assetFiles = calls[1]!.changes![0]!.files
		expect(assetFiles.map(file => [file.path, file.bytes === null])).toEqual([
			[assetMetadataRelativePath(ASSET_ID), false],
			[`assets/${ASSET_ID}/logo-2.bin`, false],
			[`assets/${ASSET_ID}/logo.bin`, true],
		])

		// Deleting a View or a Flow reports the removed file and no revision after it.
		for (const [kind, key, repository] of [['view', VIEW_ID, persistence.views], ['flow', FLOW_ID, persistence.flows]] as const) {
			const before = (await repository.readRevision(key))!
			calls.length = 0
			const deleted = await inContext(() => repository.deleteIfRevision({ key, expectedRevision: before }))
			expect(deleted).toEqual({ status: 'deleted' })
			expect(calls.map(call => call.hook)).toEqual(['before', 'after'])
			const path = kind === 'view' ? viewRelativePath(key) : flowRelativePath(key)
			expect(calls[1]!.changes).toEqual([{ resource: { kind, key }, beforeRevision: before, afterRevision: null, files: [{ path, bytes: null }] }])
			await expectCommitted(root, calls[1]!.changes!)
		}
	})

	it('reports a Workspace create, and runs the before hook while the old bytes are still on disk', async () => {
		const root = await tempDir('uiux-history-create-')
		const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
		const { observer, calls } = recorder()
		persistence.setWriteObserver(observer)
		await runWithDesignWriteContext({ ...CONTEXT, operation: 'updateWorkspaceSettings' }, () => persistence.workspace.create(workspaceFixture()))
		expect(calls.map(call => call.hook)).toEqual(['before', 'after'])
		expect(calls[1]!.changes).toMatchObject([{ resource: { kind: 'workspace', key: 'workspace' }, beforeRevision: null, afterRevision: (await persistence.workspace.read('workspace'))!.revision }])
		await expectCommitted(root, calls[1]!.changes!)

		await persistence.views.create(VIEW_ID, viewFixture())
		const oldBytes = await readFile(join(root, viewRelativePath(VIEW_ID)))
		let seenBefore: Buffer | undefined
		persistence.setWriteObserver({
			async beforeCanonicalWrite() { seenBefore = await readFile(join(root, viewRelativePath(VIEW_ID))) },
		})
		await runWithDesignWriteContext(CONTEXT, async () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: (await persistence.views.readRevision(VIEW_ID))!, resource: { ...viewFixture(), name: 'New' } }))
		expect(seenBefore).toEqual(oldBytes)
		expect(await readFile(join(root, viewRelativePath(VIEW_ID)))).not.toEqual(oldBytes)
	})

	it('reports only the View part of a Decision promotion and nothing for Review writes', async () => {
		const root = await tempDir('uiux-history-promotion-')
		const persistence = await newWorkspace(root)
		await persistence.views.create(VIEW_ID, viewFixture())
		await persistence.reviews.create(REVIEW_ID, reviewFixture())
		const { observer, calls } = recorder()
		persistence.setWriteObserver(observer)

		await runWithDesignWriteContext(CONTEXT, async () => {
			const review = (await persistence.reviews.read(REVIEW_ID))!
			await persistence.reviews.compareAndSwap({ key: REVIEW_ID, expectedRevision: review.revision, resource: { ...reviewFixture(), status: 'resolved' } as ReviewThread })
			await persistence.reviews.create('55555555-5555-4555-8555-555555555555', { ...reviewFixture(), id: '55555555-5555-4555-8555-555555555555' })
			const removable = (await persistence.reviews.read('55555555-5555-4555-8555-555555555555'))!
			await persistence.reviews.deleteIfRevision({ key: '55555555-5555-4555-8555-555555555555', expectedRevision: removable.revision })
		})
		expect(calls).toEqual([])

		const viewBefore = (await persistence.views.read(VIEW_ID))!
		const reviewBefore = (await persistence.reviews.read(REVIEW_ID))!
		const promoted = { ...viewFixture(), name: 'Promoted' }
		const result = await runWithDesignWriteContext({ ...CONTEXT, operation: 'promoteReviewToDecision' }, () => persistence.atomicReviewViewPromotionCas({
			reviewId: REVIEW_ID,
			expectedReviewRevision: reviewBefore.revision,
			reviewResource: { ...reviewFixture(), status: 'open' },
			viewId: VIEW_ID,
			expectedViewRevision: viewBefore.revision,
			viewResource: promoted,
		}))
		expect(result.ok).toBe(true)
		expect(calls.map(call => call.hook)).toEqual(['before', 'after'])
		const changes = calls[1]!.changes!
		expect(changes.map(change => change.resource)).toEqual([{ kind: 'view', key: VIEW_ID }])
		expect(changes[0]!.files.map(file => file.path)).toEqual([viewRelativePath(VIEW_ID)])
		expect(changes[0]).toMatchObject({ beforeRevision: viewBefore.revision, afterRevision: result.ok ? result.viewRevision : '' })
		await expectCommitted(root, changes)
	})

	it('calls no hook without a design-write context, on a refused write, or on a failed Asset transaction', async () => {
		let failApply = false
		const root = await tempDir('uiux-history-nohook-')
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: policy(),
			fault(point) {
				if (failApply && point === 'transaction.after_apply') throw new Error('injected mid-transaction')
			},
		})
		await persistence.workspace.create(workspaceFixture())
		const { observer, calls } = recorder()
		persistence.setWriteObserver(observer)

		await seedAllKinds(persistence)
		const viewRevision = (await persistence.views.readRevision(VIEW_ID))!
		await persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: viewRevision, resource: { ...viewFixture(), name: 'No context' } })
		expect(calls).toEqual([])

		const conflict = await runWithDesignWriteContext(CONTEXT, () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: viewRevision, resource: viewFixture() }))
		expect(conflict.ok).toBe(false)
		expect(calls).toEqual([])

		failApply = true
		const assetRevision = (await persistence.assets.readRevision(ASSET_ID))!
		await expect(runWithDesignWriteContext(CONTEXT, () => persistence.assets.compareAndSwap({ key: ASSET_ID, expectedRevision: assetRevision, resource: { metadata: assetFixture('other.bin'), content: Buffer.from('x') } }))).rejects.toBeDefined()
		expect(calls.map(call => call.hook)).toEqual(['before'])
		expect(await persistence.assets.readRevision(ASSET_ID)).toBe(assetRevision)
	})

	it('keeps the write and flags a recording gap when a hook fails or re-enters the lock', async () => {
		const root = await tempDir('uiux-history-gap-')
		const persistence = await newWorkspace(root)
		const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
		persistence.setWriteObserver({
			afterCanonicalCommit() { throw new Error('recorder down') },
		})
		await runWithDesignWriteContext(CONTEXT, () => persistence.views.create(VIEW_ID, viewFixture()))
		expect(await persistence.views.readRevision(VIEW_ID)).toBeDefined()
		expect(persistence.recordingGap).toBe(true)
		expect(logged).toHaveBeenCalledWith(expect.stringContaining('recorder down'))
		expect(persistence.consumeRecordingGap()).toBe(true)
		expect(persistence.consumeRecordingGap()).toBe(false)

		let reentry: unknown
		persistence.setWriteObserver({
			async beforeCanonicalWrite() {
				try { await persistence.views.read(VIEW_ID) }
				catch (error) {
					reentry = error
					throw error
				}
			},
		})
		const started = Date.now()
		const revision = (await persistence.views.readRevision(VIEW_ID))!
		const result = await runWithDesignWriteContext(CONTEXT, () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: revision, resource: { ...viewFixture(), name: 'Still written' } }))
		expect(result.ok).toBe(true)
		expect(Date.now() - started).toBeLessThan(5_000)
		expect(reentry).toMatchObject({ code: 'persistence.lock_busy' })
		expect(persistence.consumeRecordingGap()).toBe(true)
		expect((await persistence.views.read(VIEW_ID))?.resource.name).toBe('Still written')

		// Work a hook schedules for later (an idle-close timer) may take the lock once the hook settled.
		let later: Promise<unknown> | undefined
		persistence.setWriteObserver({
			afterCanonicalCommit() {
				later = new Promise(resolve => setTimeout(resolve, 0)).then(() => persistence.views.read(VIEW_ID))
			},
		})
		const latest = (await persistence.views.readRevision(VIEW_ID))!
		await runWithDesignWriteContext(CONTEXT, () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: latest, resource: { ...viewFixture(), name: 'Later' } }))
		await expect(later).resolves.toMatchObject({ resource: { name: 'Later' } })
		expect(persistence.recordingGap).toBe(false)

		// The guard is per instance: a hook may still use another Workspace's persistence.
		const other = await newWorkspace(await tempDir('uiux-history-other-'))
		await other.views.create(VIEW_ID, { ...viewFixture(), name: 'Other' })
		let otherRead: unknown
		persistence.setWriteObserver({
			async afterCanonicalCommit() { otherRead = await other.views.read(VIEW_ID) },
		})
		const current = (await persistence.views.readRevision(VIEW_ID))!
		await runWithDesignWriteContext(CONTEXT, () => persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: current, resource: { ...viewFixture(), name: 'Again' } }))
		expect(otherRead).toMatchObject({ resource: { name: 'Other' } })
		expect(persistence.recordingGap).toBe(false)
	})

	it('refuses a design-write context that is not stamped', () => {
		expect(() => runWithDesignWriteContext({ ...CONTEXT, actor: { type: 'agent' } } as DesignWriteContext, () => undefined)).toThrow(TypeError)
		expect(() => runWithDesignWriteContext({ ...CONTEXT, operation: 'resolveReviewThread' } as unknown as DesignWriteContext, () => undefined)).toThrow(TypeError)
	})
})

describe('selected-Workspace history stores', () => {
	it('opens host history under UIUX_HOME for the served Workspace', async () => {
		const base = await tempDir('uiux-history-serve-')
		const workspace = join(base, 'ws')
		await mkdir(metadataPath(workspace), { recursive: true })
		const home = join(base, 'home')

		const serving = createSelectedWorkspaceServerRuntime(workspace, { uiuxHome: home, serverOrigin: 'http://127.0.0.1:1' })
		const stores = await serving.history.open()
		expect(stores.host.paths.dir).toBe(hostHistoryPaths(home, await realpath(workspace)).dir)
		expect((await stat(stores.host.paths.dir)).isDirectory()).toBe(true)
		await serving.close()
	})
})

async function newWorkspace(root: string): Promise<FileNativePersistence> {
	const persistence = new FileNativePersistence({ root, schemaPolicy: policy() })
	await persistence.workspace.create(workspaceFixture())
	return persistence
}

async function seedAllKinds(persistence: FileNativePersistence): Promise<void> {
	await persistence.views.create(VIEW_ID, viewFixture())
	await persistence.flows.create(FLOW_ID, flowFixture())
	await persistence.locales.create('zh-TW', { greeting: 'hi' })
	await persistence.assets.create(ASSET_ID, { metadata: assetFixture('logo.bin'), content: Buffer.from('logo') })
}

function policy() {
	return defineWorkspaceSchemaPolicy({
		currentVersion: 2,
		recognizedVersions: [1, 2],
		steps: [{ id: 'synthetic-1-to-2', fromVersion: 1, toVersion: 2, apply: (snapshot: WorkspaceSnapshot) => new Map(snapshot) }],
	})
}

function workspaceFixture(): WorkspaceManifest {
	return { schemaVersion: 2, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }
}

function viewFixture(): ViewResource {
	return {
		id: VIEW_ID,
		name: 'Checkout',
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: '', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

function flowFixture() {
	const stepId = '66666666-6666-4666-8666-666666666666'
	return { id: FLOW_ID, name: 'Checkout Flow', entryStepId: stepId, steps: { [stepId]: { target: { viewId: VIEW_ID }, transitions: [] } } }
}

function assetFixture(contentFilename: string) {
	return { id: ASSET_ID, name: 'Logo', contentFilename, mediaType: 'application/octet-stream' }
}

function reviewFixture(): ReviewThread {
	return { id: REVIEW_ID, anchor: { viewId: VIEW_ID, widgetId: 'root' }, variantNames: [], status: 'open', messages: [], history: [], submissions: [] }
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys)
	if (value && typeof value === 'object')
		return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys((value as Record<string, unknown>)[key])]))
	return value
}
