import type { ComparisonSummaryStatus } from './constants'
import type { HistoryResourceEntry } from './schema'

export type ResourceRevisionEntry = Pick<HistoryResourceEntry, 'kind' | 'key' | 'revision'>

/** One row of a comparison summary (Clause 01a11a5e-23cd-718c-b4db-807f823238ed). */
export type ResourceChangeSummary = Readonly<{
	kind: string
	key: string
	status: ComparisonSummaryStatus
	fromRevision?: string
	toRevision?: string
}>

/**
 * Compares two versions' resources by `{ kind, key }` identity and revision only, never by file
 * path (seam 2). `from` is `undefined` when there is no earlier version, so every resource is
 * `added`. Rows are sorted by kind, then key, in code unit order.
 */
export function summarizeResourceChanges(from: readonly ResourceRevisionEntry[] | undefined, to: readonly ResourceRevisionEntry[]): readonly ResourceChangeSummary[] {
	const before = indexByIdentity(from ?? [])
	const after = indexByIdentity(to)
	const rows: ResourceChangeSummary[] = []
	for (const [identity, entry] of after) {
		const previous = before.get(identity)
		if (!previous) rows.push({ kind: entry.kind, key: entry.key, status: 'added', toRevision: entry.revision })
		else rows.push({ kind: entry.kind, key: entry.key, status: previous.revision === entry.revision ? 'unchanged' : 'modified', fromRevision: previous.revision, toRevision: entry.revision })
	}
	for (const [identity, entry] of before) {
		if (!after.has(identity)) rows.push({ kind: entry.kind, key: entry.key, status: 'removed', fromRevision: entry.revision })
	}
	return rows.sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key))
}

export function resourceIdentityKey(resource: Readonly<{ kind: string; key: string }>): string {
	return `${resource.kind}\0${resource.key}`
}

function indexByIdentity(resources: readonly ResourceRevisionEntry[]): Map<string, ResourceRevisionEntry> {
	return new Map(resources.map(resource => [resourceIdentityKey(resource), resource]))
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
