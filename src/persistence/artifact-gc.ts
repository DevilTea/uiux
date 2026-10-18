import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'

import { canonicalJsonStringify } from '../domain/canonical-json'
import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../domain/evidence/schema'
import { validateReviewThread } from '../domain/reviews/schema'
import { isFullUuid, isRecord } from '../domain/validation'
import { REVIEW_FILE_SUFFIX, resolveWorkspacePath, viewRelativePath, WORKSPACE_DATA_DIRECTORY } from './paths'
import { revisionForResourceFiles, type FileNativePersistence } from './file-native'
import { CheckpointStore } from './history/checkpoint-store'
import { referencedDigests } from './history/snapshot'
import { readActiveServerHold } from './server-hold'

/**
 * Artifact cleanup (Rule 01a115cd-c208-7a92-9582-69966f36e7fe): an explicit mark-and-sweep of the
 * derived-artifact store, run only by `uiux artifacts gc` (Clause 01a14e30-30de-70c3-888f-63e8982353d7).
 *
 * The roots (Rule 01a14e30-31c0-7289-a944-74af9556eabf) are the Evidence records that a Review
 * submission references, the blobs that a Checkpoint references, and, for each View and render
 * context, the latest Evidence record. A marked Evidence record reaches the artifacts in its
 * `artifactRefs` and the Evidence records in its `evidenceRefs`. Handoff blobs are not roots.
 *
 * - "Latest" is the newest modification time among the Evidence records of one Evidence kind and
 *   execution context (for a formal capture, its View and resolved render context). The store
 *   moves a blob's time to now whenever a producer yields it again, so the time is when the record
 *   was last produced; records that tie on the newest time are all kept. Modification times do not
 *   survive every copy (a Git checkout or a plain `cp` sets them anew), so the run also keeps every
 *   Evidence record whose provenance names the current revision of its View: retention beyond the
 *   roots, never less, so a fresh capture is not collected because an older one looks newer.
 * - Conservative on anything it cannot read: a Review thread file or a Checkpoint file that is not
 *   a valid record, or a stored blob whose bytes do not match its identity, refuses the whole run
 *   before anything is deleted, because that record could name any blob.
 * - Only regular files at `artifacts/sha256/<2>/<64>` whose name is their identity's hexadecimal
 *   digest, under the shard of its first two characters, are candidates. Every other entry of the
 *   store directory is left alone.
 * - It never rewrites a canonical record (Rule 01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2): it reads
 *   Review threads and Checkpoints, and only removes candidate blobs, each with one atomic unlink.
 */
export type ArtifactGcBlob = Readonly<{ identity: string; bytes: number }>

export type ArtifactGcResult = Readonly<{
	/** The blobs the run deleted, or with `dryRun` would delete, sorted by identity. */
	blobs: readonly ArtifactGcBlob[]
	totalBytes: number
	/** Candidate blobs a root reaches, which the run keeps. */
	kept: number
}>

export type ArtifactGcOptions = Readonly<{
	dryRun: boolean
	/** Called with each blob once it is deleted (never on a dry run), so a caller can report progress. */
	onDeleted?: (blob: ArtifactGcBlob) => void
}>

/** A refusal: nothing was deleted. */
export class ArtifactGcRefusal extends Error {
	constructor(message: string) {
		super(message)
		this.name = 'ArtifactGcRefusal'
	}
}

/**
 * A failure part way through the sweep: `deleted` lists the blobs already removed, every other blob
 * is still in place.
 */
export class ArtifactGcSweepError extends Error {
	readonly deleted: readonly ArtifactGcBlob[]
	override readonly cause?: unknown

	constructor(message: string, deleted: readonly ArtifactGcBlob[], cause: unknown) {
		super(message)
		this.name = 'ArtifactGcSweepError'
		this.deleted = deleted
		this.cause = cause
	}
}

/**
 * Runs artifact cleanup on `persistence`'s Workspace: under the exclusive persistence lock, or the
 * shared one for a dry run, which deletes nothing. A Workspace that a running UIUX server holds is
 * refused (Clause 01a14e30-314b-7ee5-b85e-c8a926013beb), checked again once the lock is held, since
 * a server may have started meanwhile; while the lock is held no server can write a blob.
 */
export async function collectArtifactGarbage(persistence: FileNativePersistence, options: ArtifactGcOptions): Promise<ArtifactGcResult> {
	await refuseWhileServed(persistence)
	const run = async (): Promise<ArtifactGcResult> => {
		await refuseWhileServed(persistence)
		await persistence.assertWritableUnlocked()
		const plan = await planArtifactGarbageUnlocked(persistence)
		if (options.dryRun) return plan
		const deleted: ArtifactGcBlob[] = []
		for (const blob of plan.blobs) {
			try {
				await persistence.removeUnlocked(candidateRelativePath(persistence, blob.identity))
			}
			catch (cause) {
				throw new ArtifactGcSweepError(`Deleting ${blob.identity} failed: ${cause instanceof Error ? cause.message : String(cause)}`, deleted, cause)
			}
			deleted.push(blob)
			options.onDeleted?.(blob)
		}
		return plan
	}
	return options.dryRun ? persistence.withReadLock(run) : persistence.withLock(run)
}

async function refuseWhileServed(persistence: FileNativePersistence): Promise<void> {
	const hold = await readActiveServerHold(persistence.root, persistence.layout)
	if (hold)
		throw new ArtifactGcRefusal(`A UIUX server (pid ${hold.pid} on ${hold.hostname}) is serving ${persistence.root}. Stop that server, then run uiux artifacts gc again.`)
}

type StoredBlob = Readonly<{ identity: string; bytes: number; mtimeMs: number; evidence?: FormalEvidenceRecord }>

/** The mark and the plan of the sweep; the caller holds the persistence lock. */
export async function planArtifactGarbageUnlocked(persistence: FileNativePersistence): Promise<ArtifactGcResult> {
	const store = await scanStoreUnlocked(persistence)
	const roots = new Set<string>([
		...await reviewSubmissionEvidenceUnlocked(persistence),
		...await checkpointBlobsUnlocked(persistence),
		...latestEvidence(store.values()),
		...await currentViewEvidenceUnlocked(persistence, store.values()),
	])
	const marked = new Set<string>()
	const pending = [...roots]
	while (pending.length > 0) {
		const identity = pending.pop()!
		if (marked.has(identity)) continue
		marked.add(identity)
		const evidence = store.get(identity)?.evidence
		if (!evidence) continue
		pending.push(...evidence.artifactRefs, ...(evidence.evidenceRefs ?? []).map(ref => ref.evidence))
	}
	const blobs = [...store.values()]
		.filter(blob => !marked.has(blob.identity))
		.map(blob => ({ identity: blob.identity, bytes: blob.bytes }))
		.sort((left, right) => left.identity < right.identity ? -1 : left.identity > right.identity ? 1 : 0)
	return { blobs, totalBytes: blobs.reduce((sum, blob) => sum + blob.bytes, 0), kept: store.size - blobs.length }
}

const SHARD = /^[0-9a-f]{2}$/u
const BLOB = /^[0-9a-f]{64}$/u

function candidateRelativePath(persistence: FileNativePersistence, identity: string): string {
	const relativePath = persistence.layout.artifactRelativePath(identity)
	// Defense in depth: the sweep never removes anything outside the store directory.
	if (!relativePath.startsWith(`${persistence.layout.artifactsDir}/`))
		throw new ArtifactGcRefusal(`Refusing to remove ${relativePath}, which is outside ${persistence.layout.artifactsDir}/.`)
	return relativePath
}

async function scanStoreUnlocked(persistence: FileNativePersistence): Promise<Map<string, StoredBlob>> {
	const store = new Map<string, StoredBlob>()
	const base = `${persistence.layout.artifactsDir}/sha256`
	const shards = await persistence.listDirectoryUnlocked(base)
	for (const shard of shards ?? []) {
		if (!shard.isDirectory() || !SHARD.test(shard.name)) continue
		const entries = await persistence.listDirectoryUnlocked(`${base}/${shard.name}`)
		for (const entry of entries ?? []) {
			if (!entry.isFile() || !BLOB.test(entry.name) || !entry.name.startsWith(shard.name)) continue
			const identity = `sha256:${entry.name}`
			const relativePath = candidateRelativePath(persistence, identity)
			const bytes = await persistence.readBytesUnlocked(relativePath)
			if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== identity)
				throw new ArtifactGcRefusal(`The stored artifact ${identity} does not match its content identity, so the Evidence it may hold cannot be read; nothing was deleted.`)
			const stats = await fs.lstat(resolveWorkspacePath(persistence.root, relativePath))
			const evidence = decodeEvidence(bytes)
			store.set(identity, { identity, bytes: bytes.byteLength, mtimeMs: stats.mtimeMs, ...(evidence ? { evidence } : {}) })
		}
	}
	return store
}

/** An Evidence record (Clause 01a115cd-ce92-7986-b9a6-0e5fa9e092f5), or undefined for any other blob. */
function decodeEvidence(bytes: Uint8Array): FormalEvidenceRecord | undefined {
	const first = bytes.find(byte => byte !== 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D)
	if (first !== 0x7B) return undefined
	let value: unknown
	try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
	catch { return undefined }
	const validation = validateFormalEvidenceRecord(value)
	return validation.ok ? validation.value : undefined
}

/** For each Evidence kind and execution context, the records with the newest modification time. */
function latestEvidence(blobs: Iterable<StoredBlob>): string[] {
	const groups = new Map<string, { mtimeMs: number; identities: string[] }>()
	for (const blob of blobs) {
		if (!blob.evidence) continue
		const key = canonicalJsonStringify({ kind: blob.evidence.kind, executionContext: blob.evidence.executionContext })
		const group = groups.get(key)
		if (!group || blob.mtimeMs > group.mtimeMs) groups.set(key, { mtimeMs: blob.mtimeMs, identities: [blob.identity] })
		else if (blob.mtimeMs === group.mtimeMs) group.identities.push(blob.identity)
	}
	return [...groups.values()].flatMap(group => group.identities)
}

/** The Evidence records whose provenance names the current revision of the View their execution context names. */
async function currentViewEvidenceUnlocked(persistence: FileNativePersistence, blobs: Iterable<StoredBlob>): Promise<string[]> {
	const revisions = new Map<string, string | undefined>()
	const identities: string[] = []
	for (const blob of blobs) {
		const context = blob.evidence?.executionContext
		const viewId = isRecord(context) ? context.viewId : undefined
		if (!blob.evidence || typeof viewId !== 'string' || !isFullUuid(viewId)) continue
		if (!revisions.has(viewId)) {
			const path = viewRelativePath(viewId)
			const bytes = await persistence.readOptionalBytesUnlocked(path)
			revisions.set(viewId, bytes ? revisionForResourceFiles('view', new Map([[path, bytes]])) : undefined)
		}
		const current = revisions.get(viewId)
		if (current !== undefined && blob.evidence.provenance.resources.some(resource => isRecord(resource.identity)
			&& resource.identity.type === 'view' && resource.identity.id === viewId && resource.revision === current))
			identities.push(blob.identity)
	}
	return identities
}

/** The Evidence every Review submission references; a thread file that is not a valid record refuses the run. */
async function reviewSubmissionEvidenceUnlocked(persistence: FileNativePersistence): Promise<string[]> {
	const directory = WORKSPACE_DATA_DIRECTORY.reviews
	const identities: string[] = []
	for (const entry of await persistence.listDirectoryUnlocked(directory) ?? []) {
		if (!entry.name.toLowerCase().endsWith(REVIEW_FILE_SUFFIX)) continue
		const relativePath = `${directory}/${entry.name}`
		if (!entry.isFile())
			throw new ArtifactGcRefusal(`${relativePath} is not a regular file, so the Evidence its submissions reference cannot be read; nothing was deleted.`)
		let value: unknown
		try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await persistence.readBytesUnlocked(relativePath))) }
		catch {
			throw new ArtifactGcRefusal(`${relativePath} is not readable JSON, so the Evidence its submissions reference cannot be read; nothing was deleted.`)
		}
		const validation = validateReviewThread(value, { filename: entry.name })
		if (!validation.ok)
			throw new ArtifactGcRefusal(`${relativePath} is not a valid Review thread (${describe(validation.diagnostics)}), so the Evidence its submissions reference cannot be read; nothing was deleted.`)
		for (const submission of validation.value.submissions)
			for (const ref of submission.evidenceRefs) identities.push(ref.evidence)
	}
	return identities
}

/** Every blob a Checkpoint names; a checkpoint file that is not a valid record refuses the run. */
async function checkpointBlobsUnlocked(persistence: FileNativePersistence): Promise<Set<string>> {
	const listing = await new CheckpointStore(persistence).listUnlocked()
	const invalid = listing.invalid[0]
	if (invalid)
		throw new ArtifactGcRefusal(`${invalid.file} is not a valid Checkpoint record (${describe(invalid.diagnostics)}), so the blobs it references cannot be read; nothing was deleted.`)
	return referencedDigests(listing.records.flatMap(record => record.resources))
}

function describe(diagnostics: readonly Readonly<{ code: string; path: string }>[]): string {
	const shown = diagnostics.slice(0, 3).map(diagnostic => `${diagnostic.code} at ${diagnostic.path || '/'}`)
	return diagnostics.length > 3 ? `${shown.join(', ')}, …` : shown.join(', ') || 'no diagnostics'
}
