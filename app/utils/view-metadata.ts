/** The View page header's draft of a View's display name and `feature` tag. */
export type ViewMetadataDraft = { name: string; feature: string }

/** The body fields of `PUT /api/views/:id/metadata` (Clause 01a15379-d8f7-7c0c-9b9a-05c07c64cc85). */
export type ViewMetadataChange = Readonly<{ name?: string; feature?: string | null }>

export function viewMetadataDraftOf(view: Readonly<{ name: string; feature?: string }>): ViewMetadataDraft {
	return { name: view.name, feature: view.feature ?? '' }
}

/**
 * What a save sends: only the fields that differ from `base`, the name trimmed as the server stores
 * it, and an emptied tag as `null`, which removes it. `undefined` when nothing changed. The name is
 * not checked here; an empty one is the form's own error.
 */
export function viewMetadataChange(base: Readonly<{ name: string; feature?: string }>, draft: ViewMetadataDraft): ViewMetadataChange | undefined {
	const name = draft.name.trim()
	const feature = draft.feature.trim()
	const change: { name?: string; feature?: string | null } = {}
	if (name !== base.name) change.name = name
	if (feature !== (base.feature ?? '')) change.feature = feature === '' ? null : feature
	return Object.keys(change).length > 0 ? change : undefined
}
