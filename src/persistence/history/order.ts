/**
 * The one ordering of history versions, oldest first: by the instant of `at`, then by the `at`
 * text, then by `id`, all in code unit order. It is total and depends only on immutable record
 * fields, so a cursor that names one position stays valid while versions are added or pruned.
 */
export function compareVersionOrder(left: Readonly<{ at: string; id: string }>, right: Readonly<{ at: string; id: string }>): number {
	return (Date.parse(left.at) - Date.parse(right.at)) || compareCodeUnits(left.at, right.at) || compareCodeUnits(left.id, right.id)
}

export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
