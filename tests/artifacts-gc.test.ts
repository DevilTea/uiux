import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runArtifactsCommand } from '../src/cli/artifacts'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { createChecksRunEvidenceService } from '../src/application/services/checks-run-evidence'
import { ArtifactGcSweepError, CHECKS_RUN_RETENTION, collectArtifactGarbage, keptChecksRuns } from '../src/persistence/artifact-gc'
import { canonicalJsonBytes, FileNativePersistence, revisionForResourceFiles, type PersistenceFaultHook } from '../src/persistence/file-native'
import { reviewRelativePath, viewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { flowTraceRecord } from './support/evidence-record'
import { artifactPath, artifactShardsPath, createCurrentWorkspace, currentManifest, writeCurrentWorkspace, writeManifest } from './support/workspace-layout'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * `uiux artifacts gc` (Clauses 01a14e30-30de-70c3-888f-63e8982353d7 and
 * 01a14e30-314b-7ee5-b85e-c8a926013beb): the artifact cleanup of Rule 01a115cd-c208-7a92-9582-69966f36e7fe
 * with the roots of Rule 01a14e30-31c0-7289-a944-74af9556eabf, which never rewrites a canonical record
 * (Rule 01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2), and the owner decisions of 2026-10-18
 * (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221) as amended by Discussion
 * #491 P1: UIUX keeps no version history, so the roots are the Evidence a Review submission references
 * and, per Evidence kind and render context, the records that name the View's current revision (every
 * record of a group whose order cannot be decided), never a Checkpoint, a host version or a timeline.
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

async function makeWorkspace(options: Readonly<{ fault?: PersistenceFaultHook }> = {}): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await makeDirectory()
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY, ...options })
	await createCurrentWorkspace(persistence)
	return { root, persistence }
}

async function gc(workspace: Readonly<{ root: string }>, ...flags: string[]) {
	const stdout: string[] = []
	const stderr: string[] = []
	const status = await runArtifactsCommand({ argv: ['gc', '--workspace', workspace.root, ...flags], cwd: workspace.root, stdout: line => stdout.push(line), stderr: line => stderr.push(line) })
	return { status, stdout, stderr }
}

const encoder = new TextEncoder()

function sha256Identity(bytes: Uint8Array): string {
	return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}
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
	const reachable = [latest, latestScreenshot, referencedByLatest, otherContext, otherContextScreenshot, submitted, submittedScreenshot, submittedSuccessor]
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
		// A second run finds nothing more to delete.
		expect((await gc(workspace)).stdout).toEqual(['Deleted 0 blobs, 0 bytes.'])
	})

	it('keeps the Evidence that names the View\'s current revision, not the newest blob, and every record of a group whose order cannot be decided', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const viewId = randomUUID()
		const current = await writeView(root, viewId, '{"view":"current"}\n')
		const screenshot = (label: string) => put(persistence, `png: ${label}`)
		// en-US: the record of the current revision is the latest; the others are older, however they were written.
		const olderScreenshot = await screenshot('older')
		const older = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_older', screenshot: olderScreenshot }))
		const latestScreenshot = await screenshot('latest')
		const latest = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: current, screenshot: latestScreenshot }))
		const newerBlobScreenshot = await screenshot('newer blob')
		const newerBlob = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_newer_blob', screenshot: newerBlobScreenshot }))
		// zh-TW: no record names the current revision, so the order cannot be decided and both are kept.
		const noneCurrentA = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'zh-TW', viewRevision: 'r_a', screenshot: await screenshot('zh-TW a') }))
		const noneCurrentB = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'zh-TW', viewRevision: 'r_b', screenshot: await screenshot('zh-TW b') }))
		// fr-FR: one record names two revisions of the View, so its group cannot be decided either, though another names the current one.
		const twoRevisions = evidenceRecord({ viewId, locale: 'fr-FR', viewRevision: 'r_first', screenshot: await screenshot('fr-FR two') })
		const ambiguous = await putEvidence(persistence, {
			...twoRevisions,
			provenance: { ...twoRevisions.provenance, resources: [{ identity: { type: 'view', id: viewId }, revision: 'r_first' }, { identity: { type: 'view', id: viewId }, revision: 'r_second' }] },
		})
		const frCurrent = await putEvidence(persistence, evidenceRecord({ viewId, locale: 'fr-FR', viewRevision: current, screenshot: await screenshot('fr-FR current') }))
		// A View that no longer exists has no current revision: its group is kept whole.
		const goneView = randomUUID()
		const goneA = await putEvidence(persistence, evidenceRecord({ viewId: goneView, viewRevision: 'r_gone_a', screenshot: await screenshot('gone a') }))
		const goneB = await putEvidence(persistence, evidenceRecord({ viewId: goneView, viewRevision: 'r_gone_b', screenshot: await screenshot('gone b') }))
		// A Flow trace names no View in its context, so its group is kept whole.
		const flowId = randomUUID()
		const flowA = await putEvidence(persistence, flowTraceRecord({ flowId, flowRevision: 'r_flow_a', stepId: randomUUID(), viewId }, await screenshot('flow a')) as FormalEvidenceRecord)
		const flowB = await putEvidence(persistence, flowTraceRecord({ flowId, flowRevision: 'r_flow_b', stepId: randomUUID(), viewId }, await screenshot('flow b')) as FormalEvidenceRecord)
		await checkout(root)

		const run = await gc(workspace, '--dry-run')
		expect(run.status, run.stderr.join('\n')).toBe(0)
		const doomed = run.stdout.slice(0, -1)
		expect([...doomed].sort()).toEqual([older, olderScreenshot, newerBlob, newerBlobScreenshot].sort())
		for (const identity of [latest, latestScreenshot, noneCurrentA, noneCurrentB, ambiguous, frCurrent, goneA, goneB, flowA, flowB]) expect(doomed, identity).not.toContain(identity)
	})

	it('reads no version history: a blob only a leftover Checkpoint or host version names is collectable, and an unreadable history file refuses nothing', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const checkpointed = encoder.encode('{"view":"named only by a leftover Checkpoint"}\n')
		const checkpointedIdentity = await put(persistence, checkpointed)
		// What an earlier UIUX left under the Workspace root: a Checkpoint naming the blob, and a file no record format accepts.
		await mkdir(join(root, 'history', 'checkpoints'), { recursive: true })
		await writeFile(join(root, 'history', 'checkpoints', `${randomUUID()}.json`), JSON.stringify({ resources: [{ kind: 'view', key: randomUUID(), revision: 'r_old', files: { 'views/x.view.json': checkpointedIdentity } }] }))
		await writeFile(join(root, 'history', 'checkpoints', `${randomUUID()}.json`), '{ not a record')
		const before = await tree(join(root, 'history'))
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([checkpointedIdentity, `Deleted 1 blob, ${checkpointed.byteLength} bytes.`])
		expect(await tree(join(root, 'history'))).toEqual(before)
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

	it('keeps the newest checks_run records and any a root references, and deletes the older ones (owner ruling of 2026-10-26, item 1)', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const service = createChecksRunEvidenceService(persistence)
		const sources = ['validation', 'translation', 'catalog', 'product-kit'].map(source => ({ source, state: 'completed' }))
		const record = async (minute: number) => {
			const result = await service.record({ ranAt: `2026-10-20T10:${String(minute).padStart(2, '0')}:00Z`, sources, findings: [] })
			if (result.status !== 'recorded') throw new Error(JSON.stringify(result))
			return result.evidenceDigest
		}
		// 25 runs, recorded out of order: the newest by ranAt, not by write order or blob time, are kept.
		const order = [3, 24, 0, 17, 9, 1, 22, 5, 14, 20, 2, 11, 23, 7, 19, 4, 13, 21, 8, 16, 6, 18, 10, 15, 12]
		const runs = new Map<number, string>()
		for (const minute of order) runs.set(minute, await record(minute))
		expect(runs.size).toBe(25)
		// The oldest run is referenced by a Review submission, so it stays.
		await writeReview(root, readyThread(runs.get(0)!))
		const newest = [...runs.entries()].filter(([minute]) => minute >= 25 - CHECKS_RUN_RETENTION).map(([, identity]) => identity)
		const doomed = [...runs.entries()].filter(([minute]) => minute > 0 && minute < 25 - CHECKS_RUN_RETENTION).map(([, identity]) => identity).sort()
		expect(newest).toHaveLength(CHECKS_RUN_RETENTION)
		expect(doomed).toHaveLength(4)
		const dry = await gc(workspace, '--dry-run')
		expect(dry.status, dry.stderr.join('\n')).toBe(0)
		expect(dry.stdout.slice(0, -1)).toEqual(doomed)
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout.slice(0, -1)).toEqual(doomed)
		for (const identity of doomed) expect(await exists(artifactPath(root, identity)), identity).toBe(false)
		for (const identity of [...newest, runs.get(0)!]) expect(await exists(artifactPath(root, identity)), identity).toBe(true)
		expect((await storeListing(root)).length).toBe(CHECKS_RUN_RETENTION + 1)
		// A second run finds nothing more to delete.
		expect((await gc(workspace)).stdout).toEqual(['Deleted 0 blobs, 0 bytes.'])
	})

	it('keeps a checks_run record whose ranAt cannot be parsed outside the retained slots, and ranks only the rest', () => {
		const unparseable = Array.from({ length: CHECKS_RUN_RETENTION + 2 }, (_, index) => ({ identity: `bad-${String(index).padStart(2, '0')}`, ranAt: index % 2 === 0 ? 'not a time' : undefined }))
		const ranked = Array.from({ length: CHECKS_RUN_RETENTION + 3 }, (_, index) => ({ identity: `run-${String(index).padStart(2, '0')}`, ranAt: new Date(Date.UTC(2026, 9, 1, 0, index)).toISOString() }))
		const kept = keptChecksRuns([...unparseable, ...ranked])
		expect(kept.filter(identity => identity.startsWith('bad-')).sort()).toEqual(unparseable.map(record => record.identity))
		expect(kept.filter(identity => identity.startsWith('run-')).sort()).toEqual(ranked.slice(3).map(record => record.identity))
	})

	it('keeps the identities named by a kept blob that is not JSON, including one behind a UTF-8 BOM', async () => {
		const workspace = await makeWorkspace()
		const { root, persistence } = workspace
		const plain = await put(persistence, 'png: named by plain text')
		const bommed = await put(persistence, 'png: named behind a BOM')
		const text = await put(persistence, `notes, not JSON: see ${plain}\n`)
		const withBom = await put(persistence, new Uint8Array([0xEF, 0xBB, 0xBF, ...encoder.encode(JSON.stringify({ ref: bommed }))]))
		const orphan = await put(persistence, 'png: orphan')
		await writeReview(root, readyThread(text, [{ viewId: randomUUID(), revision: 'r_reviewed' }]))
		await writeReview(root, readyThread(withBom, [{ viewId: randomUUID(), revision: 'r_reviewed' }]))
		const run = await gc(workspace)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([orphan, 'Deleted 1 blob, 11 bytes.'])
		for (const identity of [text, plain, withBom, bommed]) expect(await exists(artifactPath(root, identity)), identity).toBe(true)
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
			const run = await gc({ root })
			expect(run.status, label).toBe(2)
			expect(run.stderr.join('\n'), label).toContain(message)
			expect(await tree(root), label).toEqual(before)
		}
	})

	it('refuses, deleting nothing, when a Review thread or a stored blob cannot be read', async () => {
		const arrangements: [string, (workspace: Readonly<{ root: string; persistence: FileNativePersistence }>) => Promise<unknown>, string][] = [
			['an invalid Review thread', ({ root }) => writeReview(root, { ...readyThread(`sha256:${'1'.repeat(64)}`), status: 'unknown' }), 'is not a valid Review thread'],
			['a Review thread that is not JSON', ({ root }) => mkdir(join(root, 'reviews'), { recursive: true }).then(() => writeFile(join(root, reviewRelativePath(randomUUID())), '{')), 'is not readable JSON'],
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
		const linkedHex = sha256Identity(encoder.encode('png: outside the store')).slice('sha256:'.length)
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
		const { root, persistence } = workspace
		const staleScreenshot = await put(persistence, 'png: stale')
		// A View whose stale record sorts after its screenshot, so an identity-ordered sweep would remove the screenshot first.
		let viewId = randomUUID()
		while (sha256Identity(canonicalJsonBytes(evidenceRecord({ viewId, viewRevision: 'r_then', screenshot: staleScreenshot }))) < staleScreenshot) viewId = randomUUID()
		const stale = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: 'r_then', screenshot: staleScreenshot }))
		const orphan = await put(persistence, 'png: orphan')
		const now = await writeView(root, viewId, '{"view":"now"}\n')
		const current = await putEvidence(persistence, evidenceRecord({ viewId, viewRevision: now, screenshot: await put(persistence, 'png: now') }))
		failOn = stale
		const deleted: string[] = []
		const error = await collectArtifactGarbage(persistence, { dryRun: false, onDeleted: blob => deleted.push(blob.identity) }).catch((caught: unknown) => caught)
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
		const { root, persistence } = await makeWorkspace()
		const env = { ...process.env, UIUX_HOME: join(await makeDirectory(), 'uiux-home') }
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
