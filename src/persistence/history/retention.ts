import { HOST_RETENTION_MAX_AGE_MS, HOST_RETENTION_MIN_KEPT } from '../../domain/history/constants'
import type { HostVersionRecord } from '../../domain/history/schema'
import type { CheckpointListing } from './checkpoint-store'
import type { HostHistoryStore } from './host-store'
import { compareVersionOrder } from './order'
import { referencedDigests } from './snapshot'

export type HostPruneResult = Readonly<{
	/** Ids of the removed autosave and external versions. */
	pruned: readonly string[]
	/** Surviving versions whose pruned parent was replaced by their nearest surviving ancestor. */
	repointed: readonly Readonly<{ id: string; parent?: string }>[]
	gc: HostGarbageCollection
}>

export type HostGarbageCollection = Readonly<{
	/** Digests of the removed host blobs. */
	removed: readonly string[]
	/** Why the sweep did not run, when it did not: an unreadable record could name any blob. */
	skipped?: string
}>

/**
 * The host versions retention removes at `now` (Clause 01a11a5e-2374-7d1e-8c35-778d6188cbfe, Rule
 * 01a11a5e-05ef-7c25-a035-e94c377fcbd7): autosave and external versions that are at least the
 * retention age old and not among the latest kept ones. System versions are never candidates,
 * and checkpoints are not host versions at all.
 */
export function selectPrunableHostVersions(versions: readonly HostVersionRecord[], now: Date): ReadonlySet<string> {
	const candidates = versions
		.filter(version => version.type === 'autosave' || version.type === 'external')
		.sort((left, right) => compareVersionOrder(right, left))
	const prunable = new Set<string>()
	for (const [index, version] of candidates.entries()) {
		if (index < HOST_RETENTION_MIN_KEPT) continue
		if (now.getTime() - Date.parse(version.at) >= HOST_RETENTION_MAX_AGE_MS) prunable.add(version.id)
	}
	return prunable
}

/**
 * Prunes host history at `now`, then collects host blob garbage. Pruning never touches the
 * Workspace. Surviving versions are re-pointed first (Rule 01a11a5e-06a4-7897-9ae1-e2eddd9a2923),
 * then pruned versions are removed, so a crash part way leaves every parent pointer naming a
 * version that still exists; the next prune finishes the work. The caller holds the exclusive
 * persistence lock and passes the current checkpoint listing.
 */
export async function pruneHostHistory(input: Readonly<{ host: HostHistoryStore; checkpoints: CheckpointListing; now: Date }>): Promise<HostPruneResult> {
	const listing = await input.host.listVersions()
	const prunable = selectPrunableHostVersions(listing.records, input.now)
	const byId = new Map(listing.records.map(version => [version.id, version]))
	const repointed: { id: string; parent?: string }[] = []
	for (const version of listing.records) {
		if (prunable.has(version.id) || version.parent === undefined || !prunable.has(version.parent)) continue
		let parent: string | undefined = version.parent
		while (parent !== undefined && prunable.has(parent)) parent = byId.get(parent)?.parent
		const { parent: _previous, ...rest } = version
		void _previous
		await input.host.replaceVersion(parent === undefined ? rest : { ...rest, parent })
		repointed.push(parent === undefined ? { id: version.id } : { id: version.id, parent })
	}
	for (const id of prunable) await input.host.removeVersion(id)
	const gc = await collectHostGarbage({ host: input.host, checkpoints: input.checkpoints })
	return { pruned: [...prunable].sort(), repointed, gc }
}

/**
 * Mark-and-sweep of host blobs (Rule 01a11a5e-064d-79c9-ade3-220a8f6bfb64): a blob survives when a
 * host version, a checkpoint or the open autosave's journal names it. When any record cannot be
 * read the sweep is skipped, because that record could name any blob.
 */
export async function collectHostGarbage(input: Readonly<{ host: HostHistoryStore; checkpoints: CheckpointListing }>): Promise<HostGarbageCollection> {
	const listing = await input.host.listVersions()
	if (listing.invalid.length > 0) return { removed: [], skipped: `${listing.invalid.length} host version file(s) are not valid records.` }
	if (input.checkpoints.invalid.length > 0) return { removed: [], skipped: `${input.checkpoints.invalid.length} checkpoint file(s) are not valid records.` }
	let journal: Awaited<ReturnType<HostHistoryStore['readOpenJournal']>>
	try {
		journal = await input.host.readOpenJournal()
	}
	catch (error) {
		return { removed: [], skipped: `the open autosave journal is unreadable: ${error instanceof Error ? error.message : String(error)}` }
	}
	const marked = new Set([...referencedDigests(listing.records.flatMap(version => version.resources)), ...referencedDigests(input.checkpoints.records.flatMap(checkpoint => checkpoint.resources))])
	for (const entry of journal?.entries ?? []) {
		if (entry.type !== 'event') continue
		for (const digest of Object.values(entry.files)) if (digest !== null) marked.add(digest)
	}
	const removed: string[] = []
	for (const digest of await input.host.listBlobDigests()) {
		if (marked.has(digest)) continue
		await input.host.removeBlob(digest)
		removed.push(digest)
	}
	return { removed }
}
