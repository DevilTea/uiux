import type { JsonValue } from '../../validation'
import { asRecord, diffJson, jsonEqual, unionKeys, type JsonPointerChange, type Side } from './json-pointer'

/**
 * The semantic diff of a Locale (Rule 01a11a5e-0fd9-7b50-a7c1-41a3091d9e0d): the message keys
 * added, removed or changed. A Locale file added or removed is the summary status of the
 * resource. When a side is not a flat object the file is reported structurally in `changes`.
 */
export type LocaleDiff = Readonly<{
	type: 'locale'
	messages?: Readonly<{
		added: readonly Readonly<{ key: string; value: JsonValue }>[]
		removed: readonly Readonly<{ key: string; value: JsonValue }>[]
		changed: readonly Readonly<{ key: string; before: JsonValue; after: JsonValue }>[]
	}>
	changes?: readonly JsonPointerChange[]
}>

export function diffLocale(before: Side, after: Side): LocaleDiff {
	const left = before === undefined ? {} : asRecord(before)
	const right = after === undefined ? {} : asRecord(after)
	if (!left || !right) return { type: 'locale', changes: diffJson(before, after) }
	const added: { key: string; value: JsonValue }[] = []
	const removed: { key: string; value: JsonValue }[] = []
	const changed: { key: string; before: JsonValue; after: JsonValue }[] = []
	for (const key of unionKeys(left, right)) {
		const was = left[key]
		const now = right[key]
		if (was === undefined) added.push({ key, value: now! })
		else if (now === undefined) removed.push({ key, value: was })
		else if (!jsonEqual(was, now)) changed.push({ key, before: was, after: now })
	}
	return { type: 'locale', messages: { added, removed, changed } }
}
