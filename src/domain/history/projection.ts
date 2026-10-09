import type { ComparisonSummaryStatus } from './constants'
import type { HistoryResourceIdentity } from './schema'
import type { ResourceRevisionEntry } from './summary'

export type ProjectedVersion<Version> = Readonly<{
	version: Version
	status: Exclude<ComparisonSummaryStatus, 'unchanged'>
	fromRevision?: string
	toRevision?: string
}>

/**
 * Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28: a resource's history is the projection of the versions
 * in which its revision changed; nothing is stored per resource. `versions` is the merged timeline,
 * oldest first, and each version is compared with the one before it in that list; the first is
 * compared with no version, so it is included when it holds the resource.
 */
export function projectResourceHistory<Version extends Readonly<{ resources: readonly ResourceRevisionEntry[] }>>(
	versions: readonly Version[],
	resource: HistoryResourceIdentity,
): readonly ProjectedVersion<Version>[] {
	const projected: ProjectedVersion<Version>[] = []
	let previous: string | undefined
	for (const version of versions) {
		const current = version.resources.find(entry => entry.kind === resource.kind && entry.key === resource.key)?.revision
		if (current !== previous) {
			if (previous === undefined) projected.push({ version, status: 'added', toRevision: current })
			else if (current === undefined) projected.push({ version, status: 'removed', fromRevision: previous })
			else projected.push({ version, status: 'modified', fromRevision: previous, toRevision: current })
		}
		previous = current
	}
	return projected
}
