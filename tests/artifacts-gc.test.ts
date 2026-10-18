import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runArtifactsCommand } from '../src/cli/artifacts'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { CheckpointRecord, HistoryResourceEntry, HostVersionRecord } from '../src/domain/history/schema'
import { ArtifactGcSweepError, collectArtifactGarbage } from '../src/persistence/artifact-gc'
import { canonicalJsonBytes, FileNativePersistence, revisionForResourceFiles, type PersistenceFaultHook } from '../src/persistence/file-native'
import { CheckpointStore } from '../src/persistence/history/checkpoint-store'
import { blobDigest, HostHistoryStore } from '../src/persistence/history/host-store'
import { reviewRelativePath, viewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { artifactPath, artifactShardsPath, checkpointsPath, createCurrentWorkspace, currentManifest, writeCurrentWorkspace, writeManifest } from './support/workspace-layout'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * `uiux artifacts gc` (Clauses 01a14e30-30de-70c3-888f-63e8982353d7 and
 * 01a14e30-314b-7ee5-b85e-c8a926013beb): the artifact cleanup of Rule 01a115cd-c208-7a92-9582-69966f36e7fe
 * with the roots of Rule 01a14e30-31c0-7289-a944-74af9556eabf, which never rewrites a canonical record
 * (Rule 01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2), and the owner decisions of 2026-10-18
 * (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221).
 */
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeDirectory(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-artifacts-gc-')))
	roots.push(root)
	return root
}

/** A Workspace and its own temporary `UIUX_HOME`, never the real one. */
async function makeWorkspace(options: Readonly<{ fault?: PersistenceFaultHook }> = {}): Promise<{ root: string; home: string; persistence: FileNativePersistence }> {
	const root = await makeDirectory()
	const home = join(await makeDirectory(), 'uiux-home')
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, ...options })
	await createCurrentWorkspace(persistence)
	return { root, home, persistence }
}

async function gc(workspace: Readonly<{ root: string; home: string }>, ...flags: string[]) {
	const stdout: string[] = []
	const stderr: string[] = []
	const status = await runArtifactsCommand({ argv: ['gc', '--workspace', workspace.root, ...flags], cwd: workspace.root, home: workspace.home, stdout: line => stdout.push(line), stderr: line => stderr.push(line) })
	return { status, stdout, stderr }
}

const encoder = new TextEncoder()
const TIME = '2026-10-18T12:00:00Z'
/** One modification time for every blob, as a Git checkout or a plain copy leaves them. */
const CHECKOUT_TIME = new Date('2026-10-18T00:00:00Z')

async function put(persistence: FileNativePersistence, bytes: Uint8Array | string): Promise<string> {
	const { identity } = await persistence.artifacts.put(typeof bytes === 'string' ? encoder.encode(bytes) : bytes)
	return identity
}

/** Gives every blob of the store the same modification time. */
async function checkout(root: string): Promise<void> {
	for (const entry of await storeListing(root)) await utimes(join(artifactShardsPath(root), entry), CHECKOUT_TIME, CHECKOUT_TIME)
}

function evidenceRecord(input: Readonly<{ viewId: string; locale?: string; screenshot: string; viewRevision?: string; evidenceRefs?: FormalEvidenceRecord['evidenceRefs'] }>): FormalEvidenceRecord {
	return {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: input.viewId, locale: input.locale ?? 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: {
			workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
			resources: [{ identity: { type: 'view', id: input.viewId }, revision: input.viewRevision ?? `r_${randomUUID()}` }],
			versions: { uiux: '0.1.0' },
		},
		artifactRefs: [input.screenshot],
		...(input.evidenceRefs ? { evidenceRefs: input.evidenceRefs } : {}),
		data: { format: 'png' },
	}
}

async function putEvidence(persistence: FileNativePersistence, record: FormalEvidenceRecord): Promise<string> {
	return put(persistence, canonicalJsonBytes(record))
}

function readyThread(evidence: string, resources: readonly Readonly<{ viewId: string; revision: string }>[] = [{ viewId: randomUUID(), revision: 'r_reviewed' }], at = TIME): Record<string, unknown> {
	const id = randomUUID()
	const submissionId = randomUUID()
	return {
		id,
		anchor: { scope: 'workspace' },
		variantNames: [],
		status: 'ready-for-review',
		messages: [],
		submissions: [{
			id: submissionId,
			actor: { type: 'agent', id: 'member:agent' },
			at,
			changeDomains: ['ir'],
			resources: resources.map(resource => ({ identity: { type: 'view', id: resource.viewId }, revision: resource.revision })),
			scope: {},
			evidenceRefs: [{ kind: 'formal_capture', evidence }],
		}],
		history: [{ id: randomUUID(), kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent', id: 'member:agent' }, at, submissionId }],
	}
}

async function writeReview(root: string, thread: Record<string, unknown>): Promise<void> {
	await mkdir(join(root, 'reviews'), { recursive: true })
	await writeFile(join(root, reviewRelativePath(thread.id as string)), `${JSON.stringify(thread)}\n`)
}

/** A View resource of a version record whose one file is `bytes`. */
function viewResource(viewId: string, bytes: Uint8Array, revision = 'r_checkpointed'): HistoryResourceEntry {
	return { kind: 'view', key: viewId, revision, files: { [viewRelativePath(viewId)]: blobDigest(bytes) } }
}

function checkpoint(resources: readonly HistoryResourceEntry[], at = TIME): CheckpointRecord {
	return {
		historySchemaVersion: 1,
		id: randomUUID(),
		type: 'checkpoint',
		actor: { type: 'human', id: 'member:owner', displayName: 'Owner' },
		at,
		workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		resources,
		name: 'Before launch',
		source: 'workbench',
	}
}

async function createCheckpoint(persistence: FileNativePersistence, resources: readonly HistoryResourceEntry[], blobs: readonly Uint8Array[], at = TIME): Promise<CheckpointRecord> {
	const record = checkpoint(resources, at)
	await new CheckpointStore(persistence).create(record, new Map(blobs.map(bytes => [blobDigest(bytes), bytes])))
	return record
}

function hostVersion(resources: readonly HistoryResourceEntry[], at: string): HostVersionRecord {
	return { historySchemaVersion: 1, id: randomUUID(), type: 'external', actor: { type: 'external' }, at, workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, resources, startedAt: at, netChange: true, events: [] }
}

/** This host's history of the Workspace at `root`, under `home`. */
async function hostStore(root: string, home: string): Promise<HostHistoryStore> {
	return (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root), create: true }))!
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

/** Every entry under `root` with its bytes (files) or `dir`, so a test sees any change at all. */
async function tree(root: string): Promise<Record<string, string>> {
	const entries: Record<string, string> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name)
		entries[path.slice(root.length)] = entry.isDirectory() ? 'dir' : (await readFile(path)).toString('base64')
	}
	return entries
}

async function storeListing(root: string): Promise<string[]> {
	const shards = await readdir(artifactShardsPath(root)).catch(() => [])
	const entries: string[] = []
	for (const shard of shards) for (const name of await readdir(join(artifactShardsPath(root), shard))) entries.push(`${shard}/${name}`)
	return entries.sort()
}

/** Writes a View file and returns its current revision. */
async function writeView(root: string, viewId: string, text: string): Promise<string> {
	const bytes = encoder.encode(text)
	await mkdir(join(root, 'views'), { recursive: true })
	await writeFile(join(root, viewRelativePath(viewId)), bytes)
	return revisionForResourceFiles('view', new Map([[viewRelativePath(viewId), bytes]]))!
}

/**
 * A Workspace holding one blob of each kind: every root kind with what it reaches, and the
 * blobs no root reaches. Every blob has the same modification time.
 */
async function populated() {
	const workspace = await makeWorkspace()
	const { root, persistence } = workspace
	const contextView = randomUUID()
	const current = await writeView(root, contextView, '{"view":"current"}\n')

	// The latest Evidence of one View and render context names the View's current revision; it
	// keeps its screenshot and the Evidence it references, although that one is older.
	const referencedByLatest = await putEvidence(persistence, evidenceRecord({ viewId: contextView, viewRevision: 'r_previous', screenshot: await put(persistence, 'png: referenced by the latest record') }))
	const latestScreenshot = await put(persistence, 'png: latest')
	const latest = await putEvidence(persistence, evidenceRecord({ viewId: contextView, viewRevision: current, screenshot: latestScreenshot, evidenceRefs: [{ kind: 'formal_capture', evidence: referencedByLatest }] }))
	// An older Evidence record of the same View and render context is not a root.
	const staleScreenshot = await put(persistence, 'png: stale')
	const stale = await putEvidence(persistence, evidenceRecord({ viewId: contextView, viewRevision: 'r_previous', screenshot: staleScreenshot }))
	// The same View in another render context (another Locale) has its own latest record.
	const otherContextScreenshot = await put(persistence, 'png: other context')
	const otherContext = await putEvidence(persistence, evidenceRecord({ viewId: contextView, locale: 'zh-TW', screenshot: otherContextScreenshot }))

	// Evidence that a Review submission references stays, even when a newer record of its context exists.
	const submittedView = randomUUID()
	const submittedCurrent = await writeView(root, submittedView, '{"view":"submitted, then changed"}\n')
	const submittedScreenshot = await put(persistence, 'png: submitted')
	const submitted = await putEvidence(persistence, evidenceRecord({ viewId: submittedView, viewRevision: 'r_submitted', screenshot: submittedScreenshot }))
	const submittedSuccessor = await putEvidence(persistence, evidenceRecord({ viewId: submittedView, viewRevision: submittedCurrent, screenshot: await put(persistence, 'png: successor') }))
	await writeReview(root, readyThread(submitted, [{ viewId: submittedView, revision: 'r_submitted' }]))

	// A blob a Checkpoint references; the Checkpoint also places `r_previous` on the timeline.
	const checkpointView = randomUUID()
	const checkpointBytes = encoder.encode('{"view":"checkpointed bytes"}\n')
	const previousBytes = encoder.encode('{"view":"previous"}\n')
	await createCheckpoint(persistence, [viewResource(checkpointView, checkpointBytes), viewResource(contextView, previousBytes, 'r_previous')], [checkpointBytes, previousBytes])
	const checkpointBlobs = [blobDigest(checkpointBytes), blobDigest(previousBytes)]

	// Unreachable: a Handoff-like blob, which is no root, and an orphan screenshot.
	const handoff = await put(persistence, `{"bundleIdentity":"handoff manifest","evidence":"${latest}"}`)
	const orphan = await put(persistence, 'png: orphan')

	// Not a candidate: entries of the store that are not `<2>/<64>` blobs at their own shard.
	const misplacedHex = 'ff'.repeat(32)
	await mkdir(join(artifactShardsPath(root), '00'), { recursive: true })
	await writeFile(join(artifactShardsPath(root), '00', misplacedHex), 'misplaced')
	await writeFile(join(artifactShardsPath(root), latest.slice(7, 9), 'notes.txt'), 'not a blob')
	await checkout(root)

	const unreachable = [stale, staleScreenshot, handoff, orphan].sort()
	const reachable = [latest, latestScreenshot, referencedByLatest, otherContext, otherContextScreenshot, submitted, submittedScreenshot, submittedSuccessor, ...checkpointBlobs]
	return { ...workspace, unreachable, reachable, latest, stale, staleScreenshot, handoff, misplaced: join(artifactShardsPath(root), '00', misplacedHex) }
}

async function sizeOf(root: string, identities: readonly string[]): Promise<number> {
	let total = 0
	for (const identity of identities) total += (await stat(artifactPath(root, identity))).size
	return total
}

describe('uiux artifacts gc', () => {
	it('with --dry-run lists only the unreachable blobs, then their count and total bytes, and deletes nothing', async () => {
		const workspace = await populated()
		const before = await storeListing(workspace.root)
		const bytes = await sizeOf(workspace.root, workspace.unreachable)
		const run = await gc(workspace, '--dry-run')
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([...workspace.unreachable, `Would delete ${workspace.unreachable.length} blobs, ${bytes} bytes (--dry-run: nothing was deleted).`])
		expect(await storeListing(workspace.root)).toEqual(before)
	})

	it('deletes the unreachable blobs, each after the doomed blobs that reference it, and keeps every root kind and what it reaches', async () => {
		const workspace = await populated()
		const { root, unreachable, reachable, misplaced } = workspace
		const bytes = await sizeOf(root, unreachable)
		const reviews = await readdir(join(root, 'reviews'))
		const reviewBytes = await readFile(join(root, 'reviews', reviews[0]!))
		const checkpointFiles = await readdir(checkpointsPath(root))
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout.slice(0, -1).sort()).toEqual(unreachable)
		expect(run.stdout.at(-1)).toBe(`Deleted ${unreachable.length} blobs, ${bytes} bytes.`)
		// The stale Evidence record goes before its screenshot.
		expect(run.stdout.indexOf(workspace.stale)).toBeLessThan(run.stdout.indexOf(workspace.staleScreenshot))
		for (const identity of unreachable) expect(await exists(artifactPath(root, identity))).toBe(false)
		for (const identity of reachable) expect(await exists(artifactPath(root, identity)), identity).toBe(true)
		// Entries that are not candidate blobs are left alone, and no canonical record was rewritten.
		expect(await exists(misplaced)).toBe(true)
		expect(await readFile(join(root, 'reviews', reviews[0]!))).toEqual(reviewBytes)
		expect(await readdir(checkpointsPath(root))).toEqual(checkpointFiles)
		// A second run finds nothing more to delete.
		expect((await gc(workspace)).stdout).toEqual(['Deleted 0 blobs, 0 bytes.'])
	})

	it('orders Evidence by the version timeline of the View revision it names, not by blob time, and keeps an undecidable group whole', async () => {
		const workspace = await makeWorkspace()
		const { root, home, persistence } = workspace
		// The View no longer exists, so no current revision decides; only the timeline does.
		const viewId = randomUUID()
		const screenshot = (label: string) => put(persistence, `png: ${label}`)
		const atCheckpoint = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_1', screenshot: await screenshot('r_1') }))
		const atHostVersion = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_2', screenshot: await screenshot('r_2') }))
		const atSubmissionScreenshot = await screenshot('r_3')
		const atSubmission = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_3', screenshot: atSubmissionScreenshot }))
		// Another render context: one record names a revision the timeline does not show.
		const known = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'zh-TW', viewRevision: 'r_1', screenshot: await screenshot('zh-TW r_1') }))
		const unknown = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'zh-TW', viewRevision: 'r_unrecorded', screenshot: await screenshot('zh-TW unrecorded') }))
		// A third: two revisions share the newest instant.
		const tiedLeft = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'fr-FR', viewRevision: 'r_tie_a', screenshot: await screenshot('fr-FR a') }))
		const tiedRight = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'fr-FR', viewRevision: 'r_tie_b', screenshot: await screenshot('fr-FR b') }))

		const v1 = encoder.encode('{"view":1}\n')
		await createCheckpoint(persistence, [viewResource(viewId, v1, 'r_1')], [v1], '2026-10-01T00:00:00Z')
		const host = await hostStore(root, home)
		await host.writeVersion(hostVersion([viewResource(viewId, encoder.encode('{"view":2}\n'), 'r_2')], '2026-10-02T00:00:00Z'))
		await host.writeVersion(hostVersion([viewResource(viewId, encoder.encode('{"view":"tie a"}\n'), 'r_tie_a')], '2026-10-04T00:00:00Z'))
		await host.writeVersion(hostVersion([viewResource(viewId, encoder.encode('{"view":"tie b"}\n'), 'r_tie_b')], '2026-10-04T00:00:00Z'))
		// A submission about the View (its Evidence is another record) places r_3 last.
		const reviewed = await putEvidence(persistence, evidenceRecord({ viewId: randomUUID(), screenshot: await screenshot('reviewed') }))
		await writeReview(root, readyThread(reviewed, [{ viewId, revision: 'r_3' }], '2026-10-03T00:00:00Z'))
		await checkout(root)

		const run = await gc(workspace, '--dry-run')
		expect(run.status, run.stderr.join('\n')).toBe(0)
		const doomed = run.stdout.slice(0, -1)
		expect(doomed).toEqual(expect.arrayContaining([atCheckpoint, atHostVersion]))
		for (const identity of [atSubmission, atSubmissionScreenshot, known, unknown, tiedLeft, tiedRight]) expect(doomed, identity).not.toContain(identity)
	})

	it('places a revision that only a Review submission or the open autosave records on the timeline', async () => {
		const workspace = await makeWorkspace()
		const { root, home, persistence } = workspace
		const viewId = randomUUID()
		const older = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_reviewed', screenshot: await put(persistence, 'png: reviewed') }))
		const newer = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_open', screenshot: await put(persistence, 'png: open') }))
		const orphanEvidence = await putEvidence(persistence, evidenceRecord({ viewId: randomUUID(), screenshot: await put(persistence, 'png: unrelated') }))
		await writeReview(root, readyThread(orphanEvidence, [{ viewId, revision: 'r_reviewed' }], '2026-10-01T00:00:00Z'))
		const host = await hostStore(root, home)
		await host.appendOpenEntry({ type: 'begin', id: randomUUID(), startedAt: '2026-10-02T00:00:00Z' })
		await host.appendOpenEntry({
			type: 'event',
			event: { at: '2026-10-02T00:00:00Z', actor: { type: 'agent', id: 'member:agent', displayName: 'agent' }, source: 'mcp', operation: 'updateViewSpec', resource: { kind: 'view', key: viewId }, beforeRevision: 'r_reviewed', afterRevision: 'r_open' },
			files: { [viewRelativePath(viewId)]: null },
		})
		await checkout(root)
		const run = await gc(workspace, '--dry-run')
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toContain(older)
		expect(run.stdout).not.toContain(newer)
	})

	it('keeps every blob a host history version or the open autosave references, though no Checkpoint does any more', async () => {
		const workspace = await makeWorkspace()
		const { root, home, persistence } = workspace
		const viewId = randomUUID()
		const versioned = encoder.encode('{"view":"only in the artifact store"}\n')
		const opened = encoder.encode('{"view":"named by the open autosave"}\n')
		const base = await createCheckpoint(persistence, [viewResource(viewId, versioned), viewResource(randomUUID(), opened)], [versioned, opened])
		const host = await hostStore(root, home)
		// A host version whose base was that Checkpoint names its blob without a host copy.
		await host.writeVersion(hostVersion([viewResource(viewId, versioned, 'r_versioned')], TIME))
		expect(await host.hasBlob(blobDigest(versioned))).toBe(false)
		await host.appendOpenEntry({ type: 'begin', id: randomUUID(), startedAt: TIME })
		await host.appendOpenEntry({
			type: 'event',
			event: { at: TIME, actor: { type: 'agent', id: 'member:agent', displayName: 'agent' }, source: 'mcp', operation: 'updateViewSpec', resource: { kind: 'view', key: viewId }, beforeRevision: 'r_versioned', afterRevision: 'r_open' },
			files: { [viewRelativePath(viewId)]: blobDigest(opened) },
		})
		const orphan = await put(persistence, 'png: orphan')
		await rm(join(checkpointsPath(root), `${base.id}.json`))
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([orphan, 'Deleted 1 blob, 11 bytes.'])
		expect(await exists(artifactPath(root, blobDigest(versioned)))).toBe(true)
		expect(await exists(artifactPath(root, blobDigest(opened)))).toBe(true)
		// Another host (another UIUX_HOME) has no history of this Workspace, so there the blobs are collectable.
		const elsewhere = await gc({ root, home: join(await makeDirectory(), 'other-home') }, '--dry-run')
		expect(elsewhere.stdout).toEqual([...[blobDigest(versioned), blobDigest(opened)].sort(), expect.stringMatching(/^Would delete 2 blobs/u)])
	})

	it('keeps every sha256 identity found anywhere in a kept JSON blob that is not a valid Evidence record, recursively', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const deepest = await put(persistence, 'png: reached through two JSON blobs')
		const inner = await put(persistence, JSON.stringify({ items: [{ ref: `see ${deepest}` }] }))
		const asKey = await put(persistence, 'png: named by a key')
		const outer = await put(persistence, JSON.stringify({ note: `not Evidence, but names ${inner}`, map: { [asKey]: true }, list: ['x', 1, null] }))
		const orphan = await put(persistence, 'png: orphan')
		await writeReview(root, readyThread(outer))
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([orphan, 'Deleted 1 blob, 11 bytes.'])
		for (const identity of [outer, inner, asKey, deepest]) expect(await exists(artifactPath(root, identity)), identity).toBe(true)
	})

	it('refuses, deleting nothing, a Workspace that a running uiux dev server holds', async () => {
		const workspace = await populated()
		const { root, unreachable } = workspace
		const before = await storeListing(root)
		await writeFile(join(root, '.server-hold.json'), `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: TIME, token: randomUUID() })}\n`)
		for (const flags of [[], ['--dry-run']]) {
			const run = await gc(workspace, ...flags)
			expect(run.status).toBe(1)
			expect(run.stdout).toEqual([])
			expect(run.stderr.join('\n')).toContain(`A UIUX server (pid ${process.pid} on ${hostname()}) is serving ${root}`)
		}
		expect(await storeListing(root)).toEqual(before)
		// A hold whose process is gone is stale and does not refuse.
		await writeFile(join(root, '.server-hold.json'), `${JSON.stringify({ pid: 2 ** 31 - 2, hostname: hostname(), startedAt: TIME, token: randomUUID() })}\n`)
		expect((await gc(workspace, '--dry-run')).stdout).toHaveLength(unreachable.length + 1)
	})

	it('refuses an unusable Workspace root with status 2 before any lock or read', async () => {
		const cases: [string, (root: string) => Promise<unknown>, string][] = [
			['an older schemaVersion', root => writeCurrentWorkspace(root).then(() => writeManifest(root, currentManifest({ schemaVersion: 5 }))), 'schemaVersion 5'],
			['a newer schemaVersion', root => writeCurrentWorkspace(root).then(() => writeManifest(root, currentManifest({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION + 1 }))), `schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION + 1}`],
			['a foreign manifest', root => writeManifest(root, { name: 'not a Workspace' }), 'is not a UIUX Workspace manifest'],
			['a missing product-kit.json', root => writeCurrentWorkspace(root).then(() => rm(join(root, 'product-kit.json'))), 'no product-kit.json'],
			['no manifest at all', async () => undefined, 'is not an initialized UIUX Workspace'],
		]
		for (const [label, arrange, message] of cases) {
			const root = await makeDirectory()
			await arrange(root)
			await mkdir(join(artifactShardsPath(root), 'ab'), { recursive: true })
			await writeFile(join(artifactShardsPath(root), 'ab', `ab${'0'.repeat(62)}`), 'orphan')
			const before = await tree(root)
			const run = await gc({ root, home: join(await makeDirectory(), 'uiux-home') })
			expect(run.status, label).toBe(2)
			expect(run.stderr.join('\n'), label).toContain(message)
			expect(await tree(root), label).toEqual(before)
		}
	})

	it('refuses, deleting nothing, when a Review thread, a Checkpoint, the host history or a stored blob cannot be read', async () => {
		const arrangements: [string, (workspace: Readonly<{ root: string; home: string; persistence: FileNativePersistence }>) => Promise<unknown>, string][] = [
			['an invalid Review thread', ({ root }) => writeReview(root, { ...readyThread(`sha256:${'1'.repeat(64)}`), status: 'unknown' }), 'is not a valid Review thread'],
			['a Review thread that is not JSON', ({ root }) => mkdir(join(root, 'reviews'), { recursive: true }).then(() => writeFile(join(root, reviewRelativePath(randomUUID())), '{')), 'is not readable JSON'],
			['an invalid Checkpoint', ({ root }) => mkdir(checkpointsPath(root), { recursive: true }).then(() => writeFile(join(checkpointsPath(root), `${randomUUID()}.json`), '{}')), 'is not a valid Checkpoint record'],
			['an invalid host version', async ({ root, home }) => {
				const host = await hostStore(root, home)
				await writeFile(join(host.paths.versions, `${randomUUID()}.json`), '{}', { mode: 0o600 })
			}, 'which is not a valid version record'],
			['an unreadable open autosave journal', async ({ root, home }) => {
				const host = await hostStore(root, home)
				await writeFile(host.paths.open, 'not json\n', { mode: 0o600 })
			}, 'holds an open.json that cannot be read'],
			['an incomplete host history', async ({ root, home }) => {
				const host = await hostStore(root, home)
				await rm(host.paths.objects, { recursive: true })
			}, 'is incomplete'],
			['a corrupt blob', async ({ root, persistence }) => {
				const identity = await put(persistence, 'png: will be corrupted')
				await rm(artifactPath(root, identity))
				await writeFile(artifactPath(root, identity), 'other bytes')
			}, 'does not match its content identity'],
		]
		for (const [label, arrange, message] of arrangements) {
			const workspace = await makeWorkspace()
			const orphan = await put(workspace.persistence, 'png: orphan')
			await arrange(workspace)
			for (const flags of [['--dry-run'], []]) {
				const run = await gc(workspace, ...flags)
				expect(run.status, label).toBe(1)
				expect(run.stderr.join('\n'), label).toContain(message)
				expect(run.stderr.join('\n'), label).toContain('othing was deleted')
				expect(await exists(artifactPath(workspace.root, orphan)), label).toBe(true)
			}
		}
	})

	it('skips a symbolic link in the store, whether it stands for a blob or for a shard', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const outside = join(await makeDirectory(), 'target')
		await writeFile(outside, 'png: outside the store')
		const linkedHex = blobDigest(encoder.encode('png: outside the store')).slice('sha256:'.length)
		const orphan = await put(persistence, 'png: orphan')
		const shard = join(artifactShardsPath(root), linkedHex.slice(0, 2))
		await mkdir(shard, { recursive: true })
		const blobLink = join(shard, linkedHex)
		await symlink(outside, blobLink)
		const shardTarget = await makeDirectory()
		const shardHex = 'ee'.repeat(32)
		await writeFile(join(shardTarget, shardHex), 'png: in a linked shard')
		const shardLink = join(artifactShardsPath(root), 'ee')
		await symlink(shardTarget, shardLink)
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([orphan, 'Deleted 1 blob, 11 bytes.'])
		expect((await lstat(blobLink)).isSymbolicLink()).toBe(true)
		expect((await lstat(shardLink)).isSymbolicLink()).toBe(true)
		expect(await readFile(outside, 'utf8')).toBe('png: outside the store')
		expect(await readFile(join(shardTarget, shardHex), 'utf8')).toBe('png: in a linked shard')
	})

	it('leaves a consistent store when a deletion fails part way, and a later run finishes', async () => {
		let failOn: string | undefined
		const workspace = await makeWorkspace({
			fault: (point, details) => {
				if (point === 'file.before_remove' && failOn !== undefined && details.path?.endsWith(failOn.slice('sha256:'.length)))
					throw new Error('injected removal failure')
			},
		})
		const { root, home, persistence } = workspace
		const staleScreenshot = await put(persistence, 'png: stale')
		// A View whose stale record sorts after its screenshot, so an identity-ordered sweep would remove the screenshot first.
		let viewId = randomUUID()
		while (blobDigest(canonicalJsonBytes(evidenceRecord({ viewId, viewRevision: 'r_then', screenshot: staleScreenshot }))) < staleScreenshot) viewId = randomUUID()
		const stale = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_then', screenshot: staleScreenshot }))
		const orphan = await put(persistence, 'png: orphan')
		const current = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_now', screenshot: await put(persistence, 'png: now') }))
		const host = await hostStore(root, home)
		await host.writeVersion(hostVersion([viewResource(viewId, encoder.encode('{}'), 'r_then')], '2026-10-01T00:00:00Z'))
		await host.writeVersion(hostVersion([viewResource(viewId, encoder.encode('{}'), 'r_now')], TIME))
		failOn = stale
		const deleted: string[] = []
		const error = await collectArtifactGarbage(persistence, { dryRun: false, hostHistory: hostHistoryPaths(home, root), onDeleted: blob => deleted.push(blob.identity) }).catch((caught: unknown) => caught)
		expect(error).toBeInstanceOf(ArtifactGcSweepError)
		expect((error as ArtifactGcSweepError).deleted.map(blob => blob.identity)).toEqual(deleted)
		// The Evidence record failed to go, so its screenshot was not touched either.
		expect(await exists(artifactPath(root, stale))).toBe(true)
		expect(await exists(artifactPath(root, staleScreenshot))).toBe(true)
		// Every Evidence record still in the store has its screenshots.
		for (const entry of await storeListing(root)) {
			const text = await readFile(join(artifactShardsPath(root), entry), 'utf8')
			if (!text.startsWith('{')) continue
			for (const ref of (JSON.parse(text) as FormalEvidenceRecord).artifactRefs ?? []) expect(await exists(artifactPath(root, ref)), ref).toBe(true)
		}
		failOn = undefined
		const rerun = await gc(workspace)
		expect(rerun.status, rerun.stderr.join('\n')).toBe(0)
		expect(rerun.stdout.slice(0, -1).sort()).toEqual([stale, staleScreenshot, ...(deleted.includes(orphan) ? [] : [orphan])].sort())
		expect(await exists(artifactPath(root, current))).toBe(true)
	})

	it('runs through the uiux binary, which lists it in help and refuses invalid usage with status 2', async () => {
		const { root, home, persistence } = await makeWorkspace()
		const env = { ...process.env, UIUX_HOME: home }
		const orphan = await put(persistence, 'png: orphan')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', env })
		expect(help.stdout).toContain('artifacts gc [--workspace <dir>] [--dry-run]')
		for (const args of [['artifacts'], ['artifacts', 'sweep'], ['artifacts', 'gc', '--force'], ['artifacts', 'gc', 'extra'], ['artifacts', 'gc', '--workspace']]) {
			const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8', env })
			expect(result.status, args.join(' ')).toBe(2)
			expect(result.stderr, args.join(' ')).toContain('Usage: uiux artifacts gc [--workspace <dir>] [--dry-run]')
		}
		const dry = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--dry-run', '--workspace', root], { encoding: 'utf8', env })
		expect(dry.status, dry.stderr).toBe(0)
		expect(dry.stdout).toBe(`${orphan}\nWould delete 1 blob, 11 bytes (--dry-run: nothing was deleted).\n`)
		const real = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--workspace', root], { encoding: 'utf8', env })
		expect(real.status, real.stderr).toBe(0)
		expect(real.stdout).toBe(`${orphan}\nDeleted 1 blob, 11 bytes.\n`)
		expect(await exists(artifactPath(root, orphan))).toBe(false)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)
})
