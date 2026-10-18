import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'

import { canonicalJsonStringify } from '../domain/canonical-json'
import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../domain/evidence/schema'
import type { HostVersionRecord, VersionRecord } from '../domain/history/schema'
import { validateReviewThread, type ReviewSubmission } from '../domain/reviews/schema'
import { isFullUuid, isRecord } from '../domain/validation'
import { REVIEW_FILE_SUFFIX, viewRelativePath, WORKSPACE_DATA_DIRECTORY } from './paths'
import { revisionForResourceFiles, type FileNativePersistence } from './file-native'
import { CheckpointStore } from './history/checkpoint-store'
import { HostHistoryStore, type HostHistoryPaths, type OpenAutosaveEntry } from './history/host-store'
import { referencedDigests } from './history/snapshot'
import { readActiveServerHold } from './server-hold'

/**
 * Artifact cleanup (Rule 01a115cd-c208-7a92-9582-69966f36e7fe): an explicit mark-and-sweep of the
 * derived-artifact store, run only by `uiux artifacts gc` (Clause 01a14e30-30de-70c3-888f-63e8982353d7).
 *
 * The roots (Rule 01a14e30-31c0-7289-a944-74af9556eabf) are the Evidence records that a Review
 * submission references, the blobs that a Checkpoint, a host history version or the open autosave
 * references (Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0), and, for each View and render context,
 * the latest Evidence record. Handoff blobs are not roots. Owner decisions of 2026-10-18
 * (https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19019221):
 *
 * - "Latest" follows the version timeline, never a file time: an Evidence record names the View
 *   revision it shows, and that revision's place is the latest time a Checkpoint, a host version
 *   (or one of its write events), the open autosave or a Review submission records it; the View's
 *   current revision is newer than all of them. Among the records of one Evidence kind and
 *   execution context, the ones at the newest place are kept. When that cannot be decided (a
 *   record whose View revision the timeline does not show, unless the newest is the current one;
 *   two revisions at the newest place; a context naming no View), every record of the group is kept.
 * - A kept blob that is JSON is scanned conservatively: every `sha256:<64 hex>` identity anywhere in
 *   it (a key or a string value, whole or in part) is kept too, and so on through every kept JSON
 *   blob. For a valid Evidence record this includes its `artifactRefs` and `evidenceRefs`; a JSON
 *   blob that is not a valid Evidence record is followed the same way.
 * - Conservative on anything it cannot read: a Review thread, a Checkpoint, a host version or the
 *   open autosave journal that is not a valid record, a host history directory that cannot be
 *   opened, or a stored blob whose bytes do not match its identity, refuses the whole run before
 *   anything is deleted, because that record could name any blob.
 * - Only regular files at `artifacts/sha256/<2>/<64>` whose name is their identity's hexadecimal
 *   digest, under the shard of its first two characters, are candidates. Every other entry of the
 *   store directory (a symbolic link among them) is left alone.
 * - A blob is deleted only after every other doomed blob that references it, so a run that fails
 *   part way never leaves an Evidence record (or any kept JSON blob) whose referenced blobs are gone.
 * - It never rewrites a canonical record (Rule 01a115cd-c23e-7143-bd1e-7ffd9fcaa6f2): it reads
 *   Review threads, Checkpoints and host history, and only removes candidate blobs, each with one
 *   atomic unlink.
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
	/**
	 * The selected Workspace's host history (Clause 01a11a5e-1e65-7deb-a89e-6ad021248fe0) under
	 * `$UIUX_HOME`; when its directory does not exist, this host has no history for the Workspace.
	 */
	hostHistory: HostHistoryPaths
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
 * Runs artifact cleanup on `persistence`'s Workspace. A Workspace that a running UIUX server holds
 * is refused (Clause 01a14e30-314b-7ee5-b85e-c8a926013beb). A dry run and a real run take the same
 * path up to the plan: the exclusive persistence lock, which first recovers pending transactions,
 * then, under that lock, the server hold again (a server may have started meanwhile; while the lock
 * is held no server can write a blob) and the schema check. Only then does a real run delete.
 */
export async function collectArtifactGarbage(persistence: FileNativePersistence, options: ArtifactGcOptions): Promise<ArtifactGcResult> {
	await refuseWhileServed(persistence)
	return persistence.withLock(async () => {
		await refuseWhileServed(persistence)
		await persistence.assertWritableUnlocked()
		const plan = await planArtifactGarbageUnlocked(persistence, options.hostHistory)
		if (options.dryRun) return plan.result
		const deleted: ArtifactGcBlob[] = []
		for (const blob of plan.deletionOrder) {
			try {
				await persistence.removeUnlocked(candidateRelativePath(persistence, blob.identity))
			}
			catch (cause) {
				throw new ArtifactGcSweepError(`Deleting ${blob.identity} failed: ${cause instanceof Error ? cause.message : String(cause)}`, deleted, cause)
			}
			deleted.push(blob)
			options.onDeleted?.(blob)
		}
		return plan.result
	})
}

async function refuseWhileServed(persistence: FileNativePersistence): Promise<void> {
	const hold = await readActiveServerHold(persistence.root, persistence.layout)
	if (hold)
		throw new ArtifactGcRefusal(`A UIUX server (pid ${hold.pid} on ${hold.hostname}) is serving ${persistence.root}. Stop that server, then run uiux artifacts gc again.`)
}

type StoredBlob = Readonly<{
	identity: string
	bytes: number
	evidence?: FormalEvidenceRecord
	/** Every `sha256:` identity found in a JSON blob; empty for any other blob. */
	references: readonly string[]
}>

export type ArtifactGcPlan = Readonly<{
	result: ArtifactGcResult
	/** The same blobs in the order a sweep deletes them: each one after every doomed blob that references it. */
	deletionOrder: readonly ArtifactGcBlob[]
}>

/** The mark and the plan of the sweep; the caller holds the exclusive persistence lock. */
export async function planArtifactGarbageUnlocked(persistence: FileNativePersistence, hostHistory: HostHistoryPaths): Promise<ArtifactGcPlan> {
	const store = await scanStoreUnlocked(persistence)
	const submissions = await reviewSubmissionsUnlocked(persistence)
	const checkpoints = await checkpointsUnlocked(persistence)
	const host = await hostHistoryUnlocked(hostHistory)
	const timeline = new RevisionTimeline()
	for (const record of [...checkpoints, ...host.versions]) timeline.addVersion(record)
	for (const event of host.openEvents) timeline.addEvent(event)
	for (const submission of submissions) timeline.addSubmission(submission)

	const roots = new Set<string>([
		...submissions.flatMap(submission => submission.evidenceRefs.map(ref => ref.evidence)),
		...referencedDigests(checkpoints.flatMap(record => record.resources)),
		...referencedDigests(host.versions.flatMap(record => record.resources)),
		...host.openFiles,
		...await latestEvidenceUnlocked(persistence, store.values(), timeline),
	])
	const marked = new Set<string>()
	const pending = [...roots]
	while (pending.length > 0) {
		const identity = pending.pop()!
		if (marked.has(identity)) continue
		marked.add(identity)
		pending.push(...store.get(identity)?.references ?? [])
	}
	const garbage = [...store.values()]
		.filter(blob => !marked.has(blob.identity))
		.sort((left, right) => compareIdentity(left.identity, right.identity))
	const blobs = garbage.map(toResultBlob)
	return {
		result: { blobs, totalBytes: blobs.reduce((sum, blob) => sum + blob.bytes, 0), kept: store.size - blobs.length },
		deletionOrder: deletionOrder(garbage).map(toResultBlob),
	}
}

const SHARD = /^[0-9a-f]{2}$/u
const BLOB = /^[0-9a-f]{64}$/u
const IDENTITY = /sha256:[0-9a-f]{64}/gu

function toResultBlob(blob: StoredBlob): ArtifactGcBlob {
	return { identity: blob.identity, bytes: blob.bytes }
}

function compareIdentity(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

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
			const bytes = await persistence.readBytesUnlocked(candidateRelativePath(persistence, identity))
			if (`sha256:${createHash('sha256').update(bytes).digest('hex')}` !== identity)
				throw new ArtifactGcRefusal(`The stored artifact ${identity} does not match its content identity, so the Evidence it may hold cannot be read; nothing was deleted.`)
			const json = decodeJson(bytes)
			const validation = json.ok ? validateFormalEvidenceRecord(json.value) : undefined
			store.set(identity, {
				identity,
				bytes: bytes.byteLength,
				references: [...new Set([...rawIdentities(bytes), ...(json.ok ? identitiesIn(json.value) : [])])].filter(found => found !== identity),
				...(validation?.ok ? { evidence: validation.value } : {}),
			})
		}
	}
	return store
}

/**
 * Every `sha256:<64 hex>` in a blob's raw bytes, read as latin1 so each byte maps to one character
 * (plain text, a UTF-8 BOM or any encoding that keeps ASCII). It adds to the parsed-JSON scan, which
 * still finds identities written with `\u` escapes.
 */
function rawIdentities(bytes: Uint8Array): Set<string> {
	return new Set(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1').match(IDENTITY) ?? [])
}

/** The parsed value of a blob that is UTF-8 JSON text holding an object, an array or a string. */
function decodeJson(bytes: Uint8Array): Readonly<{ ok: true; value: unknown } | { ok: false }> {
	const first = bytes.find(byte => byte !== 0x20 && byte !== 0x09 && byte !== 0x0A && byte !== 0x0D)
	// `{`, `[` or `"`: a number, a boolean or null names no identity.
	if (first !== 0x7B && first !== 0x5B && first !== 0x22) return { ok: false }
	try { return { ok: true, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } }
	catch { return { ok: false } }
}

/** Every `sha256:<64 hex>` in a JSON value's keys and strings, found without recursion. */
function identitiesIn(value: unknown): Set<string> {
	const found = new Set<string>()
	const scan = (text: string) => {
		for (const match of text.matchAll(IDENTITY)) found.add(match[0])
	}
	const pending: unknown[] = [value]
	while (pending.length > 0) {
		const next = pending.pop()
		if (typeof next === 'string') scan(next)
		else if (Array.isArray(next)) pending.push(...next)
		else if (isRecord(next)) {
			for (const [key, member] of Object.entries(next)) {
				scan(key)
				pending.push(member)
			}
		}
	}
	return found
}

/**
 * Where each View revision sits on the version timeline: the latest instant a version, a write
 * event or a Review submission records it.
 */
class RevisionTimeline {
	private readonly revisions = new Map<string, Map<string, number>>()

	addVersion(record: VersionRecord): void {
		for (const resource of record.resources)
			if (resource.kind === 'view') this.add(resource.key, resource.revision, record.at)
		if (record.type !== 'checkpoint') for (const event of record.events) this.addEvent(event)
	}

	addEvent(event: HostVersionRecord['events'][number]): void {
		if (event.resource.kind === 'view' && event.afterRevision !== null) this.add(event.resource.key, event.afterRevision, event.at)
	}

	addSubmission(submission: ReviewSubmission): void {
		for (const resource of submission.resources) {
			const viewId = viewIdOf(resource.identity)
			if (viewId !== undefined) this.add(viewId, resource.revision, submission.at)
		}
	}

	/** The latest instant recorded for `revision` of `viewId`, or undefined when the timeline does not show it. */
	place(viewId: string, revision: string): number | undefined {
		return this.revisions.get(viewId)?.get(revision)
	}

	private add(viewId: string, revision: string, at: string): void {
		const instant = Date.parse(at)
		if (Number.isNaN(instant)) return
		const places = this.revisions.get(viewId) ?? new Map<string, number>()
		places.set(revision, Math.max(places.get(revision) ?? Number.NEGATIVE_INFINITY, instant))
		this.revisions.set(viewId, places)
	}
}

function viewIdOf(identity: unknown): string | undefined {
	return isRecord(identity) && identity.type === 'view' && typeof identity.id === 'string' ? identity.id : undefined
}

/**
 * For each Evidence kind and execution context, the records whose View revision is the newest on
 * the timeline, or every record of the group when that cannot be decided.
 */
async function latestEvidenceUnlocked(persistence: FileNativePersistence, blobs: Iterable<StoredBlob>, timeline: RevisionTimeline): Promise<string[]> {
	const groups = new Map<string, { viewId?: string; records: { identity: string; revision?: string }[] }>()
	for (const blob of blobs) {
		if (!blob.evidence) continue
		const { kind, executionContext, provenance } = blob.evidence
		const key = canonicalJsonStringify({ kind, executionContext })
		const viewId = typeof executionContext.viewId === 'string' ? executionContext.viewId : undefined
		const group = groups.get(key) ?? { ...(viewId === undefined ? {} : { viewId }), records: [] }
		const revisions = new Set(viewId === undefined ? [] : provenance.resources.filter(resource => viewIdOf(resource.identity) === viewId).map(resource => resource.revision))
		const revision = revisions.size === 1 ? [...revisions][0]! : undefined
		group.records.push({ identity: blob.identity, ...(revision === undefined ? {} : { revision }) })
		groups.set(key, group)
	}
	const current = new Map<string, string | undefined>()
	const kept: string[] = []
	for (const { viewId, records } of groups.values()) {
		if (viewId === undefined) {
			kept.push(...records.map(record => record.identity))
			continue
		}
		if (!current.has(viewId)) current.set(viewId, await currentViewRevisionUnlocked(persistence, viewId))
		const now = current.get(viewId)
		const placed = records.map(record => ({
			...record,
			place: record.revision === undefined ? undefined : record.revision === now ? Number.POSITIVE_INFINITY : timeline.place(viewId, record.revision),
		}))
		const newest = Math.max(...placed.map(record => record.place ?? Number.NEGATIVE_INFINITY))
		const atNewest = placed.filter(record => record.place === newest)
		const decided = placed.every(record => record.revision !== undefined)
			&& (newest === Number.POSITIVE_INFINITY || placed.every(record => record.place !== undefined))
			&& new Set(atNewest.map(record => record.revision)).size === 1
		kept.push(...(decided ? atNewest : records).map(record => record.identity))
	}
	return kept
}

async function currentViewRevisionUnlocked(persistence: FileNativePersistence, viewId: string): Promise<string | undefined> {
	if (!isFullUuid(viewId)) return undefined
	const path = viewRelativePath(viewId)
	const bytes = await persistence.readOptionalBytesUnlocked(path)
	return bytes ? revisionForResourceFiles('view', new Map([[path, bytes]])) : undefined
}

/** Every Review submission; a thread file that is not a valid record refuses the run. */
async function reviewSubmissionsUnlocked(persistence: FileNativePersistence): Promise<ReviewSubmission[]> {
	const directory = WORKSPACE_DATA_DIRECTORY.reviews
	const submissions: ReviewSubmission[] = []
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
		submissions.push(...validation.value.submissions)
	}
	return submissions
}

/** Every Checkpoint; a checkpoint file that is not a valid record refuses the run. */
async function checkpointsUnlocked(persistence: FileNativePersistence) {
	const listing = await new CheckpointStore(persistence).listUnlocked()
	const invalid = listing.invalid[0]
	if (invalid)
		throw new ArtifactGcRefusal(`${invalid.file} is not a valid Checkpoint record (${describe(invalid.diagnostics)}), so the blobs it references cannot be read; nothing was deleted.`)
	return listing.records
}

type HostHistoryRoots = Readonly<{
	versions: readonly HostVersionRecord[]
	openEvents: readonly Extract<OpenAutosaveEntry, { type: 'event' }>['event'][]
	/** Every blob the open autosave's events name. */
	openFiles: readonly string[]
}>

/**
 * This host's history of the Workspace: its versions and the open autosave. No history directory
 * means none; a directory that cannot be opened, a version file that is not a valid record or a
 * journal that cannot be read refuses the run.
 */
async function hostHistoryUnlocked(paths: HostHistoryPaths): Promise<HostHistoryRoots> {
	const refuse = (detail: string): never => {
		throw new ArtifactGcRefusal(`The host history at ${paths.dir} ${detail}, so the blobs its versions reference cannot be read; nothing was deleted.`)
	}
	const message = (error: unknown) => error instanceof Error ? error.message : String(error)
	let store: HostHistoryStore | undefined
	try { store = await HostHistoryStore.open({ paths }) }
	catch (error) { return refuse(`cannot be opened (${message(error)})`) }
	if (!store) {
		// A partial history directory (versions without the rest) is not "no history".
		const present = await fs.lstat(paths.dir).then(() => true, (error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? false : refuse(`cannot be read (${message(error)})`))
		if (present) refuse('is incomplete')
		return { versions: [], openEvents: [], openFiles: [] }
	}
	let versions: readonly HostVersionRecord[]
	try {
		const listing = await store.listVersions()
		const invalid = listing.invalid[0]
		if (invalid) return refuse(`holds ${invalid.file}, which is not a valid version record (${describe(invalid.diagnostics)})`)
		versions = listing.records
	}
	catch (error) {
		if (error instanceof ArtifactGcRefusal) throw error
		return refuse(`cannot be listed (${message(error)})`)
	}
	let entries: readonly OpenAutosaveEntry[]
	try { entries = (await store.readOpenJournal())?.entries ?? [] }
	catch (error) { return refuse(`holds an open.json that cannot be read (${message(error)})`) }
	const openEvents: Extract<OpenAutosaveEntry, { type: 'event' }>[] = entries.filter((entry): entry is Extract<OpenAutosaveEntry, { type: 'event' }> => entry.type === 'event')
	return {
		versions,
		openEvents: openEvents.map(entry => entry.event),
		openFiles: openEvents.flatMap(entry => Object.values(entry.files).filter((digest): digest is string => digest !== null)),
	}
}

/**
 * The doomed blobs in deletion order: a blob comes after every doomed blob that references it, so
 * an interrupted sweep leaves no remaining blob whose references are gone. Content identities make
 * a reference cycle impossible; any blob left over is appended in identity order all the same.
 */
function deletionOrder(garbage: readonly StoredBlob[]): StoredBlob[] {
	const doomed = new Map(garbage.map(blob => [blob.identity, blob]))
	const referrers = new Map<string, number>()
	for (const blob of garbage)
		for (const reference of new Set(blob.references))
			if (doomed.has(reference)) referrers.set(reference, (referrers.get(reference) ?? 0) + 1)
	const ready = garbage.filter(blob => !referrers.get(blob.identity))
	const order: StoredBlob[] = []
	const placed = new Set<string>()
	while (ready.length > 0) {
		const blob = ready.shift()!
		order.push(blob)
		placed.add(blob.identity)
		for (const reference of new Set(blob.references)) {
			const remaining = referrers.get(reference)
			if (remaining === undefined) continue
			referrers.set(reference, remaining - 1)
			if (remaining === 1) ready.push(doomed.get(reference)!)
		}
	}
	return [...order, ...garbage.filter(blob => !placed.has(blob.identity))]
}

function describe(diagnostics: readonly Readonly<{ code: string; path: string }>[]): string {
	const shown = diagnostics.slice(0, 3).map(diagnostic => `${diagnostic.code} at ${diagnostic.path || '/'}`)
	return diagnostics.length > 3 ? `${shown.join(', ')}, …` : shown.join(', ') || 'no diagnostics'
}
