import type { FetchErrorDetails } from './fetch-error'

/**
 * A promotion refused for a revision conflict (Rule 01a11544-611c-73e0-990b-c094b48b3eb6): which of
 * its two resources moved, the thread (`review`) or the View (`view`), as the server lists them in
 * `conflicts[]` (Clause 01a11544-6d0a-70f4-b6b7-76e42f95d42e). Pure, so the canvas bubble and the
 * Reviews detail name it the same way.
 */
export type PromoteMoved = 'review' | 'view'

export type PromoteConflict = Readonly<{ threadId: string; moved: readonly PromoteMoved[] }>

/** The moved resources of a conflict result, thread first; empty when the body names none. */
export function promoteMovedOf(details: FetchErrorDetails): readonly PromoteMoved[] {
	const resources = new Set(details.conflicts?.map(item => item.resource))
	return (['review', 'view'] as const).filter(resource => resources.has(resource))
}

/** The i18n key of the sentence that names what moved; undefined when nothing is named. */
export function promoteConflictTitleKey(moved: readonly PromoteMoved[] | undefined): string | undefined {
	if (!moved?.length) return undefined
	if (moved.length === 2) return 'reviews.promote.conflict.both'
	return moved[0] === 'view' ? 'reviews.promote.conflict.view' : 'reviews.promote.conflict.review'
}
