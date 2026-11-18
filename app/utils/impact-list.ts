import type { ImpactCategory, ImpactItem } from '../../src/domain/impact/analyzer'

/**
 * The reference-impact list of a delete, a Variant removal or a viewport or theme key change, as the
 * Workbench groups it for the confirmation (Rule 01a172ce-2e97-7d83-b175-f0d15f846768 and Clause
 * 01a172ce-bdef-7cf6-bf8c-770dc9dd5e34). Framework-free and unit-tested.
 */

/** The impact list's groups, in the order the confirmation shows them. */
export const IMPACT_GROUPS = ['anchors', 'references', 'flowSteps', 'decisions', 'submissions', 'renderKeys', 'evidence', 'other'] as const
export type ImpactGroup = typeof IMPACT_GROUPS[number]

const GROUP_OF: Readonly<Record<ImpactCategory, ImpactGroup>> = {
	review_anchor_invalidated: 'anchors',
	review_anchor_revalidated: 'anchors',
	i18n_reference_dangling: 'references',
	asset_reference_dangling: 'references',
	flow_step_widget_missing: 'flowSteps',
	flow_step_target_missing: 'flowSteps',
	review_variant_stale: 'anchors',
	view_reference_dangling: 'references',
	view_decision_removed: 'decisions',
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
