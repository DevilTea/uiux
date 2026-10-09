import { canonicalJsonStringify } from '../../canonical-json'
import { isRecord, jsonPointer, type JsonValue } from '../../validation'

/**
 * The JSON-pointer structural diff (Rule 01a11a5e-1134-755c-a740-a619a7943fe0): where no semantic
 * diff applies, a comparison reports the members that were added, removed or replaced, each named
 * by its JSON pointer (RFC 6901), never a line diff. The semantic diffs reuse it for the parts of a
 * resource whose meaning is open (Widget config, State overrides, viewport presets).
 *
 * A `$i18n` or `$asset` binding (an object whose only member is that key) is one value: a changed
 * binding is reported as the binding before and after, never as its inner string, so a diff shows
 * the reference and not a resolved text or file (Rule 01a11a5e-0e8d-7d8a-84f1-3195ac7719e7).
 */
export type JsonPointerChange =
	| Readonly<{ op: 'add'; path: string; after: JsonValue }>
	| Readonly<{ op: 'remove'; path: string; before: JsonValue }>
	| Readonly<{ op: 'replace'; path: string; before: JsonValue; after: JsonValue }>

/** A value on one side of a comparison; `undefined` means the member is absent on that side. */
export type Side = JsonValue | undefined

/** Structural diff of two JSON values, rooted at `base` (the empty pointer is the whole value). */
export function diffJson(before: Side, after: Side, base = ''): JsonPointerChange[] {
	const changes: JsonPointerChange[] = []
	walk(before, after, base, changes)
	return changes
}

function walk(before: Side, after: Side, path: string, changes: JsonPointerChange[]): void {
	if (before === undefined && after === undefined) return
	if (before === undefined) {
		changes.push({ op: 'add', path, after: after! })
		return
	}
	if (after === undefined) {
		changes.push({ op: 'remove', path, before })
		return
	}
	if (jsonEqual(before, after)) return
	if (isRecord(before) && isRecord(after) && !isBinding(before) && !isBinding(after)) {
		for (const key of unionKeys(before, after))
			walk(before[key] as Side, after[key] as Side, jsonPointer(path, key), changes)
		return
	}
	if (Array.isArray(before) && Array.isArray(after)) {
		const length = Math.max(before.length, after.length)
		for (let index = 0; index < length; index++)
			walk(before[index], after[index], jsonPointer(path, index), changes)
		return
	}
	changes.push({ op: 'replace', path, before, after })
}

/** True for a `{ "$i18n": … }` or `{ "$asset": … }` binding. */
export function isBinding(value: unknown): boolean {
	if (!isRecord(value)) return false
	const keys = Object.keys(value)
	return keys.length === 1 && (keys[0] === '$i18n' || keys[0] === '$asset')
}

/** Deep JSON equality, independent of object member order. */
export function jsonEqual(left: Side, right: Side): boolean {
	if (left === right) return true
	if (left === undefined || right === undefined) return false
	return canonicalJsonStringify(left) === canonicalJsonStringify(right)
}

/** Object member names of both sides, in code unit order, so a diff never depends on member order. */
export function unionKeys(before: Readonly<Record<string, unknown>>, after: Readonly<Record<string, unknown>>): string[] {
	return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort(compareCodeUnits)
}

/** The structural diff of `before` and `after` without the listed top-level members. */
export function diffJsonExcept(before: Side, after: Side, excluded: readonly string[], base = ''): JsonPointerChange[] {
	return diffJson(omit(before, excluded), omit(after, excluded), base)
}

export function omit(value: Side, excluded: readonly string[]): Side {
	if (!isRecord(value)) return value
	const rest: Record<string, JsonValue> = {}
	for (const [key, member] of Object.entries(value)) if (!excluded.includes(key)) rest[key] = member as JsonValue
	return rest
}

/**
 * Item-level comparison of two lists whose items have no identity of their own (Spec section
 * items, Flow transitions): items are matched by value, counting repeats, so `added` and `removed`
 * list what one side has more of. `reordered` is true when the same items appear in another order.
 */
export type ListItemChanges<Item> = Readonly<{ added: readonly Item[]; removed: readonly Item[]; reordered?: true }>

export function diffListItems<Item extends JsonValue>(before: readonly Item[], after: readonly Item[]): ListItemChanges<Item> | undefined {
	const removed = itemsNotIn(before, after)
	const added = itemsNotIn(after, before)
	if (added.length > 0 || removed.length > 0) return { added, removed }
	return canonicalJsonStringify(before) === canonicalJsonStringify(after) ? undefined : { added, removed, reordered: true }
}

/** The items of `items` left over after matching each one, by value and with repeats, against `other`. */
function itemsNotIn<Item extends JsonValue>(items: readonly Item[], other: readonly Item[]): Item[] {
	const available = new Map<string, number>()
	for (const item of other) {
		const key = canonicalJsonStringify(item)
		available.set(key, (available.get(key) ?? 0) + 1)
	}
	const leftover: Item[] = []
	for (const item of items) {
		const key = canonicalJsonStringify(item)
		const count = available.get(key) ?? 0
		if (count > 0) available.set(key, count - 1)
		else leftover.push(item)
	}
	return leftover
}

/**
 * Members of two keyed records (viewports, themes, Locale messages): `added` and `removed` carry
 * the whole member, `changed` the structural diff inside it.
 */
export type KeyedChanges = Readonly<{
	added: readonly Readonly<{ key: string; value: JsonValue }>[]
	removed: readonly Readonly<{ key: string; value: JsonValue }>[]
	changed: readonly Readonly<{ key: string; changes: readonly JsonPointerChange[] }>[]
}>

export function diffKeyed(before: Side, after: Side): KeyedChanges | undefined {
	const left = isRecord(before) ? before : {}
	const right = isRecord(after) ? after : {}
	const added: { key: string; value: JsonValue }[] = []
	const removed: { key: string; value: JsonValue }[] = []
	const changed: { key: string; changes: JsonPointerChange[] }[] = []
	for (const key of unionKeys(left, right)) {
		const was = left[key] as Side
		const now = right[key] as Side
		if (was === undefined) added.push({ key, value: now! })
		else if (now === undefined) removed.push({ key, value: was })
		else if (!jsonEqual(was, now)) changed.push({ key, changes: diffJson(was, now) })
	}
	return added.length + removed.length + changed.length > 0 ? { added, removed, changed } : undefined
}

/** A value that changed as a whole, such as a name or a status. */
export type ValueChange<Value = JsonValue> = Readonly<{ before?: Value; after?: Value }>

export function valueChange<Value extends JsonValue>(before: Value | undefined, after: Value | undefined): ValueChange<Value> | undefined {
	if (jsonEqual(before, after)) return undefined
	return { ...(before === undefined ? {} : { before }), ...(after === undefined ? {} : { after }) }
}

export function compareCodeUnits(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0
}

/** Returns `value` as a JSON object member list when it is one, else `undefined`. */
export function asRecord(value: unknown): Readonly<Record<string, JsonValue>> | undefined {
	return isRecord(value) ? value as Record<string, JsonValue> : undefined
}

export function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined
}
