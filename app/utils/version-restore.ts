import { isRestorableResourceKind } from '../../src/domain/history/constants'
import type { ImpactCategory, ImpactItem } from '../../src/domain/impact/analyzer'
import type { ResourceChangeSummary } from '../../src/domain/history/summary'
import { CURRENT_COMPARE, PARENT_COMPARE, type ComparisonEndpoints } from './version-history'

/**
 * The Workbench restore's pure parts (issue #132, B10; Rule 01a11a5e-18f2-7991-8f7d-aa4c8015d14a):
 * when a resource's diff offers "Restore this version", which version it restores, and how the
 * server's impact list is grouped for the confirmation. Framework-free and unit-tested.
 */

export type RestoreGateInput = Readonly<{
	/** A desktop layout: Restore is never offered on a tablet or a phone (Rule 01a11a5e-1bfa-71e9-9611-152b5b665379). */
	desktop: boolean
	/**
	 * The member may author on this live, migrated Workspace: Editor or above, the role the Access
	 * Contract gives `history.restore` and every restorable kind's write key (the Workbench's
	 * `authorReadOnly`); the server's check stays the authority.
	 */
	canAuthor: boolean
	/** The changed resource of the comparison, with its status from `from` to `to`. */
	resource: Pick<ResourceChangeSummary, 'kind' | 'status'>
	/** The selected version (the address's `version`). */
	selectedVersion: string | undefined
	/** The comparison's two sides; the selected version is one of them. */
	endpoints: ComparisonEndpoints | undefined
}>

/**
 * The version "Restore this version" restores, or `undefined` when the action is not offered.
 *
 * It is always the *selected* version, the one the reader picked in the timeline and the comparison
 * is about, whichever side of the comparison it is: with the parent it is the newer side (restoring
 * brings the resource back to what that version made it), with the current state or another
 * version it is the side the reader chose. It is offered only when:
 * - the layout is desktop and the member may author (see `RestoreGateInput`);
 * - the kind is one this build restores (`RESTORABLE_RESOURCE_KINDS`: never a Review thread, a
 *   Product Kit, access presets or a kind this build does not know);
 * - the selected version is a real version, not `current` or `parent`;
 * - the resource exists in the selected version: not `removed` when the selected version is the
 *   newer side, not `added` when it is the older side.
 */
export function restoreSourceVersion(input: RestoreGateInput): string | undefined {
	const { desktop, canAuthor, resource, selectedVersion: version, endpoints } = input
	if (!desktop || !canAuthor || !endpoints || !version) return undefined
	if (!isRestorableResourceKind(resource.kind)) return undefined
	if (version === CURRENT_COMPARE || version === PARENT_COMPARE) return undefined
	if (endpoints.to === version) return resource.status === 'removed' ? undefined : version
	if (endpoints.from === version) return resource.status === 'added' ? undefined : version
	return undefined
}

/**
 * Whether the resource's current content already equals the selected version's: the summary of
 * `GET /api/history/diff?from=<version>&to=current&resource=<kind:key>` lists it as `unchanged`.
 * Restoring it would change nothing yet still form a version of its own (Rule
 * 01a11e0d-d911-7030-9565-7473aa0995e1), so the dialog offers no Restore. The restore Clause
 * (01a11a5e-2768-76ad-b02a-e15f50f91268) has no result for this case, so this guard is the
 * Workbench's own.
 */
export function matchesCurrent(summary: readonly Pick<ResourceChangeSummary, 'kind' | 'key' | 'status'>[], resource: Readonly<{ kind: string; key: string }>): boolean {
	return summary.find(row => row.kind === resource.kind && row.key === resource.key)?.status === 'unchanged'
}

/** The impact list's groups, in the order the confirmation shows them (Rules 01a11a5e-174b-… and 17a0-…). */
export const IMPACT_GROUPS = ['anchors', 'references', 'flowSteps', 'submissions', 'renderKeys', 'evidence', 'other'] as const
export type ImpactGroup = typeof IMPACT_GROUPS[number]

const GROUP_OF: Readonly<Record<ImpactCategory, ImpactGroup>> = {
	review_anchor_invalidated: 'anchors',
	review_anchor_revalidated: 'anchors',
	i18n_reference_dangling: 'references',
	asset_reference_dangling: 'references',
	flow_step_widget_missing: 'flowSteps',
	submission_revision_not_current: 'submissions',
	submission_revision_current: 'submissions',
	render_key_removed: 'renderKeys',
	evidence_stale: 'evidence',
}

/** An impact item as received: a category this build does not know is kept and listed under `other`. */
export type ReceivedImpact = ImpactItem | Readonly<{ category: string } & Record<string, unknown>>

export type ImpactGroupList = Readonly<{ group: ImpactGroup; items: readonly ReceivedImpact[] }>

/** The non-empty groups in display order, each keeping the server's item order. */
export function groupImpacts(impacts: readonly ReceivedImpact[]): ImpactGroupList[] {
	const byGroup = new Map<ImpactGroup, ReceivedImpact[]>()
	for (const item of impacts) {
		const group = GROUP_OF[item.category as ImpactCategory] ?? 'other'
		byGroup.set(group, [...byGroup.get(group) ?? [], item])
	}
	return IMPACT_GROUPS.flatMap(group => byGroup.has(group) ? [{ group, items: byGroup.get(group)! }] : [])
}

/** A shortened ID for a thread or Evidence digest in a list; the full value goes in a tooltip. */
export function shortId(value: string): string {
	const bare = value.replace(/^sha256:/u, '')
	return bare.length > 8 ? bare.slice(0, 8) : bare
}

/**
 * What the restore request answered, for the dialog. `POST /api/history/versions/:id/restore`
 * answers the object `restore_resource_version` returns; the HTTP status follows it.
 */
export type RestoreAnswer =
	| Readonly<{ state: 'restored'; created: boolean; restoredFrom?: string }>
	| Readonly<{ state: 'impact'; impacts: readonly ReceivedImpact[] }>
	| Readonly<{ state: 'conflict' }>
	| Readonly<{ state: 'locked' }>
	| Readonly<{ state: 'refused'; status: 'invalid' | 'not_found' | 'blocked' | 'denied' | 'failed' }>

export function classifyRestoreAnswer(httpStatus: number, body: unknown): RestoreAnswer {
	const record = typeof body === 'object' && body !== null ? body as Record<string, unknown> : {}
	const status = typeof record.status === 'string' ? record.status : undefined
	if ((status === 'updated' || status === 'created') && httpStatus < 300)
		return { state: 'restored', created: status === 'created', ...(typeof record.restoredFrom === 'string' ? { restoredFrom: record.restoredFrom } : {}) }
	if (status === 'impact_acknowledgement_required')
		return { state: 'impact', impacts: Array.isArray(record.impacts) ? record.impacts as ReceivedImpact[] : [] }
	if (status === 'conflict') return { state: 'conflict' }
	if (status === 'locked' || httpStatus === 423) return { state: 'locked' }
	if (httpStatus === 403 || record.code === 'auth.scope_denied') return { state: 'refused', status: 'denied' }
	if (status === 'invalid' || status === 'not_found' || status === 'blocked') return { state: 'refused', status }
	return { state: 'refused', status: 'failed' }
}
