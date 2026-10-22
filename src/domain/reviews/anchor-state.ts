import { isWidgetAnchor, type ReviewAnchor } from './schema'

/**
 * Anchor validity of a Review thread, in the Workbench inbox vocabulary (Clause
 * 01a163a5-7110-79e8-94ac-887c8eddde6a): `missing` when the anchored View or Widget does not exist,
 * `stale` when only a named Variant does not exist (Rule 01a11544-5201-70e6-9e60-a2433deb62b0), and
 * `valid` otherwise, as for every Workspace thread (Rule 01a11544-529e-7ace-beeb-c5ce2b2071e8).
 *
 * Pure and browser-safe.
 */
export const REVIEW_ANCHOR_STATES = ['valid', 'stale', 'missing'] as const
export type ReviewAnchorState = typeof REVIEW_ANCHOR_STATES[number]

/**
 * What is known about the anchored View: `null` when it does not exist. `widgetIds` and
 * `variantNames` are left out when they cannot be read (an unreadable View or an invalid Widget
 * tree), and then cannot make the anchor invalid.
 */
export type ReviewAnchorTarget = Readonly<{ widgetIds?: Pick<ReadonlySet<string>, 'has'>; variantNames?: Pick<ReadonlySet<string>, 'has'> }> | null

export function reviewAnchorState(anchor: ReviewAnchor, variantNames: readonly string[], target: ReviewAnchorTarget): ReviewAnchorState {
	if (!isWidgetAnchor(anchor)) return 'valid'
	if (target === null) return 'missing'
	if (target.widgetIds && anchor.widgetId !== 'root' && !target.widgetIds.has(anchor.widgetId)) return 'missing'
	if (target.variantNames && variantNames.some(name => !target.variantNames!.has(name))) return 'stale'
	return 'valid'
}
