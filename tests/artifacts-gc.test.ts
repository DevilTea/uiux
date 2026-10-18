import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runArtifactsCommand } from '../src/cli/artifacts'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { CheckpointRecord } from '../src/domain/history/schema'
import { canonicalJsonBytes, FileNativePersistence, revisionForResourceFiles } from '../src/persistence/file-native'
import { CheckpointStore } from '../src/persistence/history/checkpoint-store'
import { blobDigest } from '../src/persistence/history/host-store'
import { reviewRelativePath, viewRelativePath } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { artifactPath, artifactShardsPath, checkpointsPath, createCurrentWorkspace, currentManifest, writeCurrentWorkspace, writeManifest } from './support/workspace-layout'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * `uiux artifacts gc` (Clauses 01a14e30-30de-70c3-888f-63e8982353d7 and
 * 01a14e30-314b-7ee5-b85e-c8a926013beb): the artifact cleanup of Rule 01a115cd-c208-7a92-9582-69966f36e7fe
 * with the roots of Rule 01a14e30-31c0-7289-a944-74af9556eabf, which never rewrites a canonical record
 * (Rule 01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2).
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

async function makeWorkspace(): Promise<{ root: string; persistence: FileNativePersistence }> {
	const root = await makeDirectory()
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	return { root, persistence }
}

async function gc(root: string, ...flags: string[]) {
	const stdout: string[] = []
	const stderr: string[] = []
	const status = await runArtifactsCommand({ argv: ['gc', '--workspace', root, ...flags], cwd: root, stdout: line => stdout.push(line), stderr: line => stderr.push(line) })
	return { status, stdout, stderr }
}

const encoder = new TextEncoder()
const TIME = '2026-10-18T12:00:00Z'

async function put(persistence: FileNativePersistence, bytes: Uint8Array | string, mtime?: Date): Promise<string> {
	const { identity } = await persistence.artifacts.put(typeof bytes === 'string' ? encoder.encode(bytes) : bytes)
	if (mtime) await utimes(artifactPath(persistence.root, identity), mtime, mtime)
	return identity
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

async function putEvidence(persistence: FileNativePersistence, record: FormalEvidenceRecord, mtime: Date): Promise<string> {
	return put(persistence, canonicalJsonBytes(record), mtime)
}

function readyThread(evidence: string): Record<string, unknown> {
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
			at: TIME,
			changeDomains: ['ir'],
			resources: [{ identity: { type: 'view', id: randomUUID() }, revision: 'r_reviewed' }],
			scope: {},
			evidenceRefs: [{ kind: 'formal_capture', evidence }],
		}],
		history: [{ id: randomUUID(), kind: 'lifecycle', from: 'open', to: 'ready-for-review', actor: { type: 'agent', id: 'member:agent' }, at: TIME, submissionId }],
	}
}

async function writeReview(root: string, thread: Record<string, unknown>): Promise<void> {
	await mkdir(join(root, 'reviews'), { recursive: true })
	await writeFile(join(root, reviewRelativePath(thread.id as string)), `${JSON.stringify(thread)}\n`)
}

function checkpoint(files: Record<string, string>): CheckpointRecord {
	return {
		historySchemaVersion: 1,
		id: randomUUID(),
		type: 'checkpoint',
		actor: { type: 'human', id: 'member:owner', displayName: 'Owner' },
		at: TIME,
		workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		resources: [{ kind: 'view', key: Object.keys(files)[0]!.slice('views/'.length, -'.view.json'.length), revision: 'r_checkpointed', files }],
		name: 'Before launch',
		source: 'workbench',
	}
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

/**
 * A Workspace holding one blob of each kind: every root kind with what it reaches, and the
 * blobs no root reaches.
 */
async function populated() {
	const { root, persistence } = await makeWorkspace()
	const old = new Date('2026-10-01T00:00:00Z')
	const newer = new Date('2026-10-10T00:00:00Z')
	const contextView = randomUUID()

	// The latest Evidence of one View and render context keeps its screenshot and the Evidence it references.
	const referencedByLatest = await putEvidence(persistence, evidenceRecord({ viewId: randomUUID(), screenshot: await put(persistence, 'png: referenced by the latest record', old) }), old)
	const latestScreenshot = await put(persistence, 'png: latest', newer)
	const latest = await putEvidence(persistence, evidenceRecord({ viewId: contextView, screenshot: latestScreenshot, evidenceRefs: [{ kind: 'formal_capture', evidence: referencedByLatest }] }), newer)
	// An older Evidence record of the same View and render context is not a root.
	const staleScreenshot = await put(persistence, 'png: stale', old)
	const stale = await putEvidence(persistence, evidenceRecord({ viewId: contextView, screenshot: staleScreenshot }), old)
	// The same View in another render context (another Locale) has its own latest record.
	const otherContextScreenshot = await put(persistence, 'png: other context', old)
	const otherContext = await putEvidence(persistence, evidenceRecord({ viewId: contextView, locale: 'zh-TW', screenshot: otherContextScreenshot }), old)

	// Evidence that a Review submission references stays, even when a newer record of its context exists.
	const submittedView = randomUUID()
	const submittedScreenshot = await put(persistence, 'png: submitted', old)
	const submitted = await putEvidence(persistence, evidenceRecord({ viewId: submittedView, screenshot: submittedScreenshot }), old)
	const submittedSuccessor = await putEvidence(persistence, evidenceRecord({ viewId: submittedView, screenshot: await put(persistence, 'png: successor', newer) }), newer)
	await writeReview(root, readyThread(submitted))

	// A blob a Checkpoint references.
	const checkpointView = randomUUID()
	const checkpointBytes = encoder.encode('{"view":"checkpointed bytes"}\n')
	await new CheckpointStore(persistence).create(checkpoint({ [viewRelativePath(checkpointView)]: blobDigest(checkpointBytes) }), new Map([[blobDigest(checkpointBytes), checkpointBytes]]))
	const checkpointBlob = blobDigest(checkpointBytes)
	await utimes(artifactPath(root, checkpointBlob), old, old)

	// Unreachable: a Handoff-like blob, which is no root, and an orphan screenshot.
	const handoff = await put(persistence, '{"bundleIdentity":"handoff manifest"}', newer)
	const orphan = await put(persistence, 'png: orphan', newer)

	// Not a candidate: entries of the store that are not `<2>/<64>` blobs at their own shard.
	const misplacedHex = 'ff'.repeat(32)
	await mkdir(join(artifactShardsPath(root), '00'), { recursive: true })
	await writeFile(join(artifactShardsPath(root), '00', misplacedHex), 'misplaced')
	await writeFile(join(artifactShardsPath(root), latest.slice(7, 9), 'notes.txt'), 'not a blob')

	const unreachable = [stale, staleScreenshot, handoff, orphan].sort()
	const reachable = [latest, latestScreenshot, referencedByLatest, otherContext, otherContextScreenshot, submitted, submittedScreenshot, submittedSuccessor, checkpointBlob]
	return { root, persistence, unreachable, reachable, latest, stale, misplaced: join(artifactShardsPath(root), '00', misplacedHex) }
}

async function sizeOf(root: string, identities: readonly string[]): Promise<number> {
	let total = 0
	for (const identity of identities) total += (await stat(artifactPath(root, identity))).size
	return total
}

describe('uiux artifacts gc', () => {
	it('with --dry-run lists only the unreachable blobs, then their count and total bytes, and deletes nothing', async () => {
		const { root, unreachable } = await populated()
		const before = await storeListing(root)
		const bytes = await sizeOf(root, unreachable)
		const run = await gc(root, '--dry-run')
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([...unreachable, `Would delete ${unreachable.length} blobs, ${bytes} bytes (--dry-run: nothing was deleted).`])
		expect(await storeListing(root)).toEqual(before)
	})

	it('deletes the unreachable blobs and keeps every root kind and what it reaches', async () => {
		const { root, unreachable, reachable, misplaced } = await populated()
		const bytes = await sizeOf(root, unreachable)
		const reviews = await readdir(join(root, 'reviews'))
		const reviewBytes = await readFile(join(root, 'reviews', reviews[0]!))
		const checkpointFiles = await readdir(checkpointsPath(root))
		const run = await gc(root)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout).toEqual([...unreachable, `Deleted ${unreachable.length} blobs, ${bytes} bytes.`])
		for (const identity of unreachable) expect(await exists(artifactPath(root, identity))).toBe(false)
		for (const identity of reachable) expect(await exists(artifactPath(root, identity)), identity).toBe(true)
		// Entries that are not candidate blobs are left alone, and no canonical record was rewritten.
		expect(await exists(misplaced)).toBe(true)
		expect(await readFile(join(root, 'reviews', reviews[0]!))).toEqual(reviewBytes)
		expect(await readdir(checkpointsPath(root))).toEqual(checkpointFiles)
		// A second run finds nothing more to delete.
		expect((await gc(root)).stdout).toEqual(['Deleted 0 blobs, 0 bytes.'])
	})

	it('keeps every Evidence record that names the current revision of its View, whatever its time', async () => {
		const { root, persistence } = await makeWorkspace()
		const viewId = randomUUID()
		const viewBytes = encoder.encode('{"view":"current"}\n')
		await mkdir(join(root, 'views'), { recursive: true })
		await writeFile(join(root, viewRelativePath(viewId)), viewBytes)
		const current = revisionForResourceFiles('view', new Map([[viewRelativePath(viewId), viewBytes]]))!
		// A copy or checkout reset the times: the fresh capture looks older than a stale one.
		const fresh = await putEvidence(persistence, evidenceRecord({ viewId, screenshot: await put(persistence, 'png: fresh'), viewRevision: current }), new Date('2026-10-01T00:00:00Z'))
		const staleScreenshot = await put(persistence, 'png: stale view revision', new Date('2026-10-01T00:00:00Z'))
		const stale = await putEvidence(persistence, evidenceRecord({ viewId, screenshot: staleScreenshot, viewRevision: 'r_previous' }), new Date('2026-10-02T00:00:00Z'))
		const olderStaleScreenshot = await put(persistence, 'png: older stale', new Date('2026-09-01T00:00:00Z'))
		const olderStale = await putEvidence(persistence, evidenceRecord({ viewId, screenshot: olderStaleScreenshot, viewRevision: 'r_older' }), new Date('2026-09-01T00:00:00Z'))
		const run = await gc(root)
		expect(run.status, run.stderr.join('\n')).toBe(0)
		expect(run.stdout.slice(0, -1)).toEqual([olderStale, olderStaleScreenshot].sort())
		expect(await exists(artifactPath(root, fresh))).toBe(true)
		expect(await exists(artifactPath(root, stale))).toBe(true)
	})

	it('dates a blob that a producer yields again at that time, so a repeated capture is the latest one', async () => {
		const { root, persistence } = await makeWorkspace()
		const old = new Date('2026-01-01T00:00:00Z')
		const identity = await put(persistence, 'png: repeated', old)
		await persistence.artifacts.put(encoder.encode('png: repeated'))
		expect((await stat(artifactPath(root, identity))).mtimeMs).toBeGreaterThan(old.getTime())
		expect(await readFile(artifactPath(root, identity), 'utf8')).toBe('png: repeated')
	})

	it('refuses, deleting nothing, a Workspace that a running uiux dev server holds', async () => {
		const { root, unreachable } = await populated()
		const before = await storeListing(root)
		await writeFile(join(root, '.server-hold.json'), `${JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: TIME, token: randomUUID() })}\n`)
		for (const flags of [[], ['--dry-run']]) {
			const run = await gc(root, ...flags)
			expect(run.status).toBe(1)
			expect(run.stdout).toEqual([])
			expect(run.stderr.join('\n')).toContain(`A UIUX server (pid ${process.pid} on ${hostname()}) is serving ${root}`)
		}
		expect(await storeListing(root)).toEqual(before)
		// A hold whose process is gone is stale and does not refuse.
		await writeFile(join(root, '.server-hold.json'), `${JSON.stringify({ pid: 2 ** 31 - 2, hostname: hostname(), startedAt: TIME, token: randomUUID() })}\n`)
		expect((await gc(root, '--dry-run')).stdout).toHaveLength(unreachable.length + 1)
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
			const run = await gc(root)
			expect(run.status, label).toBe(2)
			expect(run.stderr.join('\n'), label).toContain(message)
			expect(await tree(root), label).toEqual(before)
		}
	})

	it('refuses, deleting nothing, when a Review thread, a Checkpoint or a stored blob cannot be read', async () => {
		const arrangements: [string, (root: string, persistence: FileNativePersistence) => Promise<unknown>, string][] = [
			['an invalid Review thread', root => writeReview(root, { ...readyThread(`sha256:${'1'.repeat(64)}`), status: 'unknown' }), 'is not a valid Review thread'],
			['a Review thread that is not JSON', root => mkdir(join(root, 'reviews'), { recursive: true }).then(() => writeFile(join(root, reviewRelativePath(randomUUID())), '{')), 'is not readable JSON'],
			['an invalid Checkpoint', root => mkdir(checkpointsPath(root), { recursive: true }).then(() => writeFile(join(checkpointsPath(root), `${randomUUID()}.json`), '{}')), 'is not a valid Checkpoint record'],
			['a corrupt blob', async (root, persistence) => {
				const identity = await put(persistence, 'png: will be corrupted')
				await rm(artifactPath(root, identity))
				await writeFile(artifactPath(root, identity), 'other bytes')
			}, 'does not match its content identity'],
		]
		for (const [label, arrange, message] of arrangements) {
			const { root, persistence } = await makeWorkspace()
			const orphan = await put(persistence, 'png: orphan')
			await arrange(root, persistence)
			const run = await gc(root)
			expect(run.status, label).toBe(1)
			expect(run.stderr.join('\n'), label).toContain(message)
			expect(run.stderr.join('\n'), label).toContain('nothing was deleted')
			expect(await exists(artifactPath(root, orphan)), label).toBe(true)
		}
	})

	it('runs through the uiux binary, which lists it in help and refuses invalid usage with status 2', async () => {
		const { root, persistence } = await makeWorkspace()
		const orphan = await put(persistence, 'png: orphan')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
		expect(help.stdout).toContain('artifacts gc [--workspace <dir>] [--dry-run]')
		for (const args of [['artifacts'], ['artifacts', 'sweep'], ['artifacts', 'gc', '--force'], ['artifacts', 'gc', 'extra'], ['artifacts', 'gc', '--workspace']]) {
			const result = spawnSync(process.execPath, [CLI, ...args], { cwd: root, encoding: 'utf8' })
			expect(result.status, args.join(' ')).toBe(2)
			expect(result.stderr, args.join(' ')).toContain('Usage: uiux artifacts gc [--workspace <dir>] [--dry-run]')
		}
		const dry = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--dry-run', '--workspace', root], { encoding: 'utf8' })
		expect(dry.status, dry.stderr).toBe(0)
		expect(dry.stdout).toBe(`${orphan}\nWould delete 1 blob, 11 bytes (--dry-run: nothing was deleted).\n`)
		const real = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--workspace', root], { encoding: 'utf8' })
		expect(real.status, real.stderr).toBe(0)
		expect(real.stdout).toBe(`${orphan}\nDeleted 1 blob, 11 bytes.\n`)
		expect(await exists(artifactPath(root, orphan))).toBe(false)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)
})
