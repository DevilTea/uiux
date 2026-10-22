/**
 * The change summary a successful canonical mutation result carries (Contract
 * 01a11485-f46d-773b-b935-2856e1ee2d54, owner rulings of 2026-10-23 in
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19130600):
 *
 * - Clause 01a11485-f578-79a7-9d01-4bc233f2c1cb: `changeSummary: { changes: [{ path, op }], truncated? }`,
 *   computed here from the resource's canonical content before and after the commit, never from
 *   caller-supplied text.
 * - Clause 01a164f0-c0fe-7c86-9c50-cc9354e49fe8: `path` is a JSON Pointer from the resource root, at
 *   most {@link CHANGE_SUMMARY_MAX_DEPTH} segments; a deeper difference folds into its prefix as
 *   `replace`. An array whose elements all carry a unique string `id` is diffed by that id, which is
 *   the element's path segment; any other array is reported whole as `replace`.
 * - Clause 01a164f0-c2a5-74dc-805d-c05ce25697d8: entries sorted by `path` in code unit order, at most
 *   {@link CHANGE_SUMMARY_MAX_CHANGES}; `truncated` counts the omitted ones.
 * - Clause 01a164f0-c44e-7d21-811d-93cbf7750dba: a created resource lists each top-level member as
 *   `add`, a deleted one is `{ path: "", op: "remove" }`, and unchanged content gives no entries.
 * - Clause 01a164f0-c5fc-7b97-b21a-d127e423a157: the other resources one mutation writes go in
 *   `related`, sorted by `kind` then `key`, each capped like the primary.
 *
 * Interpretation recorded in the PR for issue #77: when the elements an id-addressed array keeps
 * change their order, the array is reported whole as `replace`, since no per-element entry can
 * express a move.
 *
 * Pure and deterministic: the same before and after content always give the same summary.
 */
export const CHANGE_SUMMARY_MAX_DEPTH = 3
export const CHANGE_SUMMARY_MAX_CHANGES = 50

export type ChangeOp = 'add' | 'remove' | 'replace'

export type ResourceChange = Readonly<{ path: string; op: ChangeOp }>

export type RelatedChangeSummary = Readonly<{
	kind: string
	key: string
	revision: string
	changes: readonly ResourceChange[]
	truncated?: number
}>

export type ChangeSummary = Readonly<{
	changes: readonly ResourceChange[]
	truncated?: number
	related?: readonly RelatedChangeSummary[]
}>

/** Another resource the same mutation wrote, with its content before and after. */
export type RelatedChangeInput = Readonly<{
	kind: string
	key: string
	revision: string
	before: unknown
	after: unknown
}>

/**
 * The change summary of one mutation. `before` is `undefined` for a created resource and `after`
 * is `undefined` for a deleted one.
 */
export function summarizeChange(before: unknown, after: unknown, related?: readonly RelatedChangeInput[]): ChangeSummary {
	const primary = capped(diffResource(before, after))
	if (!related || related.length === 0) return primary
	const entries = [...related]
		.sort((left, right) => compareCodeUnits(left.kind, right.kind) || compareCodeUnits(left.key, right.key))
		.map(entry => ({ kind: entry.kind, key: entry.key, revision: entry.revision, ...capped(diffResource(entry.before, entry.after)) }))
	return { ...primary, related: entries }
}

/** The summary of a deleted resource (Clause 01a164f0-c44e-7d21-811d-93cbf7750dba). */
export const DELETED_CHANGE_SUMMARY: ChangeSummary = Object.freeze({ changes: Object.freeze([Object.freeze({ path: '', op: 'remove' as const })]) })

/** The uncapped, unsorted changes between two versions of one resource. */
export function diffResource(before: unknown, after: unknown): ResourceChange[] {
	if (before === undefined && after === undefined) return []
	if (before === undefined) {
		if (!isPlainObject(after)) return [{ path: '', op: 'add' }]
		return Object.keys(after).filter(key => after[key] !== undefined).map(key => ({ path: pointer([key]), op: 'add' }))
	}
	if (after === undefined) return [{ path: '', op: 'remove' }]
	const changes: ResourceChange[] = []
	diffValue(before, after, [], changes)
	return changes
}

function capped(changes: readonly ResourceChange[]): Readonly<{ changes: readonly ResourceChange[]; truncated?: number }> {
	const sorted = [...changes].sort((left, right) => compareCodeUnits(left.path, right.path))
	if (sorted.length <= CHANGE_SUMMARY_MAX_CHANGES) return { changes: sorted }
	return { changes: sorted.slice(0, CHANGE_SUMMARY_MAX_CHANGES), truncated: sorted.length - CHANGE_SUMMARY_MAX_CHANGES }
}

function diffValue(before: unknown, after: unknown, segments: readonly string[], out: ResourceChange[]): void {
	if (equalValues(before, after)) return
	if (segments.length < CHANGE_SUMMARY_MAX_DEPTH) {
		if (isPlainObject(before) && isPlainObject(after)) {
			for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
				const from = before[key]
				const to = after[key]
				if (from === undefined && to === undefined) continue
				const path = [...segments, key]
				if (from === undefined) out.push({ path: pointer(path), op: 'add' })
				else if (to === undefined) out.push({ path: pointer(path), op: 'remove' })
				else diffValue(from, to, path, out)
			}
			return
		}
		if (Array.isArray(before) && Array.isArray(after)) {
			const from = indexById(before)
			const to = indexById(after)
			if (from && to && keptInOrder(from, to)) {
				for (const id of new Set([...from.keys(), ...to.keys()])) {
					const path = [...segments, id]
					if (!from.has(id)) out.push({ path: pointer(path), op: 'add' })
					else if (!to.has(id)) out.push({ path: pointer(path), op: 'remove' })
					else diffValue(from.get(id), to.get(id), path, out)
				}
				return
			}
		}
	}
	out.push({ path: pointer(segments), op: 'replace' })
}

/** The elements by `id` when every element is an object with a unique string `id`; an empty array qualifies. */
function indexById(values: readonly unknown[]): Map<string, unknown> | undefined {
	const index = new Map<string, unknown>()
	for (const value of values) {
		if (!isPlainObject(value) || typeof value.id !== 'string' || index.has(value.id)) return undefined
		index.set(value.id, value)
	}
	return index
}

/** Whether the ids both arrays hold appear in the same relative order. */
function keptInOrder(before: ReadonlyMap<string, unknown>, after: ReadonlyMap<string, unknown>): boolean {
	const kept = [...before.keys()].filter(id => after.has(id))
	const order = [...after.keys()].filter(id => before.has(id))
	return kept.every((id, index) => order[index] === id)
}

function equalValues(left: unknown, right: unknown): boolean {
	if (left === right) return true
	if (ArrayBuffer.isView(left) || ArrayBuffer.isView(right)) {
		if (!ArrayBuffer.isView(left) || !ArrayBuffer.isView(right)) return false
		const a = new Uint8Array(left.buffer, left.byteOffset, left.byteLength)
		const b = new Uint8Array(right.buffer, right.byteOffset, right.byteLength)
		return a.length === b.length && a.every((byte, index) => byte === b[index])
	}
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false
		return left.every((value, index) => equalValues(value, right[index]))
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		const keys = new Set([...Object.keys(left), ...Object.keys(right)])
		for (const key of keys) {
			if (!equalValues(left[key], right[key])) return false
		}
		return true
	}
	return false
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === 'object' && value !== null && !Array.isArray(value) && !ArrayBuffer.isView(value)
}

/** RFC 6901: `~` as `~0` and `/` as `~1` in each segment. */
function pointer(segments: readonly string[]): string {
	return segments.map(segment => `/${segment.replaceAll('~', '~0').replaceAll('/', '~1')}`).join('')
}

function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}
