import { PARENT_COMPARE } from './version-history'

/**
 * When a comparison is read again (issue #132, B8 follow-up in B10). Framework-free and
 * unit-tested; `useVersionDiff` applies them.
 */

/**
 * The key that re-reads a comparison with `current`: the newest listed version and the revisions
 * the Workbench has read. It is `undefined` until the timeline's first page and the Workbench's
 * first read have both arrived, so their arrival on a cold start is not taken for a change and the
 * comparison is read once, not three times. Once the timeline is loaded an empty one (a filter that
 * matches nothing) keys as `-`, so a later Workbench change still re-reads the comparison.
 */
export function comparisonRefreshKey(timeline: Readonly<{ loaded: boolean; latestVersionId: string | undefined }>, workbenchSignature: string): string | undefined {
	return timeline.loaded && workbenchSignature ? `${timeline.latestVersionId ?? '-'}|${workbenchSignature}` : undefined
}

/** A refresh key change re-reads the comparison only between two known keys. */
export function refreshKeyChanged(key: string | undefined, previous: string | undefined): boolean {
	return key !== undefined && previous !== undefined && key !== previous
}

/**
 * Deleting a Checkpoint changes the merged-timeline parent of the version after it, so every
 * cached comparison with `from=parent` may now be wrong, and one naming the deleted version can no
 * longer be asked for. Comparisons between two named versions keep their sides and stay cached.
 * `cache` is keyed by the JSON of the diff request query (`diffRequestQuery`).
 */
export function forgetComparisonsAfterDeletion(cache: Map<string, unknown>, deletedId: string): void {
	for (const key of [...cache.keys()]) {
		let query: { from?: unknown; to?: unknown }
		try { query = JSON.parse(key) as { from?: unknown; to?: unknown } }
		catch { cache.delete(key); continue }
		if (query.from === PARENT_COMPARE || query.from === deletedId || query.to === deletedId) cache.delete(key)
	}
}
