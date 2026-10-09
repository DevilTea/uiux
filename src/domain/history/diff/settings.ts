import type { JsonValue } from '../../validation'
import {
	asRecord,
	asString,
	diffJson,
	diffJsonExcept,
	diffKeyed,
	jsonEqual,
	omit,
	valueChange,
	type JsonPointerChange,
	type KeyedChanges,
	type Side,
	type ValueChange,
} from './json-pointer'

/**
 * The semantic diff of the Workspace settings, the manifest (Rule
 * 01a11a5e-102f-7caa-b63f-d7c6fb5189c0): `i18n.defaultLocale`, viewports and themes by key, and
 * Adapters by member, matched by `moduleSpecifier`. The manifest `schemaVersion` is never reported
 * (Rule 01a11a5e-1085-71ec-ac82-d60263ae8173): it is removed from both sides before anything is
 * compared, including the structural fallback.
 */
export type AdapterChanges = Readonly<{
	added: readonly Readonly<{ moduleSpecifier: string; adapter: JsonValue }>[]
	removed: readonly Readonly<{ moduleSpecifier: string; adapter: JsonValue }>[]
	/** Pointers relative to the Adapter selection (so `/config/...`). */
	changed: readonly Readonly<{ moduleSpecifier: string; changes: readonly JsonPointerChange[] }>[]
	/** True when the kept Adapters are listed in another order. */
	reordered?: true
}>

export type WorkspaceSettingsDiff = Readonly<{
	type: 'workspace'
	defaultLocale?: ValueChange
	/** `i18n` members other than `defaultLocale`, relative to `i18n`. */
	i18nChanges?: readonly JsonPointerChange[]
	viewports?: KeyedChanges
	themes?: KeyedChanges
	adapters?: AdapterChanges
	/** Set when `adapters` cannot be matched by `moduleSpecifier`, relative to `adapters`. */
	adaptersChanges?: readonly JsonPointerChange[]
	/** Other manifest members, relative to the manifest; never `schemaVersion`. */
	otherChanges?: readonly JsonPointerChange[]
}>

const SETTINGS_MEMBERS = ['schemaVersion', 'i18n', 'viewports', 'themes', 'adapters'] as const

export function diffWorkspaceSettings(before: Side, after: Side): WorkspaceSettingsDiff {
	const leftManifest = asRecord(before)
	const rightManifest = asRecord(after)
	if ((before !== undefined && !leftManifest) || (after !== undefined && !rightManifest))
		return withOther({ type: 'workspace' }, diffJson(omit(before, ['schemaVersion']), omit(after, ['schemaVersion'])))
	const left = leftManifest ?? {}
	const right = rightManifest ?? {}
	// A member that is not an object on both sides is left to the structural diff of the manifest.
	const objects = (member: string) => (left[member] === undefined || asRecord(left[member]) !== undefined) && (right[member] === undefined || asRecord(right[member]) !== undefined)
	const semantic = SETTINGS_MEMBERS.filter(member => member === 'schemaVersion' || member === 'adapters' || objects(member))
	const leftI18n = asRecord(left.i18n)
	const rightI18n = asRecord(right.i18n)
	const defaultLocale = objects('i18n') ? valueChange(leftI18n?.defaultLocale, rightI18n?.defaultLocale) : undefined
	const i18nChanges = objects('i18n') ? diffJsonExcept(left.i18n, right.i18n, ['defaultLocale']) : []
	const viewports = objects('viewports') ? diffKeyed(left.viewports, right.viewports) : undefined
	const themes = objects('themes') ? diffKeyed(left.themes, right.themes) : undefined
	const adapters = diffAdapters(left.adapters, right.adapters)
	const other = diffJsonExcept(left, right, semantic)
	return withOther({
		type: 'workspace',
		...(defaultLocale ? { defaultLocale } : {}),
		...(i18nChanges.length > 0 ? { i18nChanges } : {}),
		...(viewports ? { viewports } : {}),
		...(themes ? { themes } : {}),
		...(adapters === undefined ? {} : 'changes' in adapters ? (adapters.changes.length > 0 ? { adaptersChanges: adapters.changes } : {}) : { adapters }),
	}, other)
}

function withOther(diff: WorkspaceSettingsDiff, other: readonly JsonPointerChange[]): WorkspaceSettingsDiff {
	return other.length > 0 ? { ...diff, otherChanges: other } : diff
}

/** Adapters by `moduleSpecifier`; `{ changes }` (structural) when they cannot be matched that way. */
function diffAdapters(before: Side, after: Side): AdapterChanges | Readonly<{ changes: readonly JsonPointerChange[] }> | undefined {
	if (jsonEqual(before, after)) return undefined
	const left = indexAdapters(before)
	const right = indexAdapters(after)
	if (!left || !right) return { changes: diffJson(before, after) }
	const added: { moduleSpecifier: string; adapter: JsonValue }[] = []
	const removed: { moduleSpecifier: string; adapter: JsonValue }[] = []
	const changed: { moduleSpecifier: string; changes: JsonPointerChange[] }[] = []
	for (const [moduleSpecifier, adapter] of left) if (!right.has(moduleSpecifier)) removed.push({ moduleSpecifier, adapter })
	for (const [moduleSpecifier, adapter] of right) {
		const was = left.get(moduleSpecifier)
		if (was === undefined) added.push({ moduleSpecifier, adapter })
		else if (!jsonEqual(was, adapter)) changed.push({ moduleSpecifier, changes: diffJson(was, adapter) })
	}
	const keptBefore = [...left.keys()].filter(key => right.has(key))
	const keptAfter = [...right.keys()].filter(key => left.has(key))
	const reordered = keptBefore.some((key, index) => keptAfter[index] !== key)
	return { added, removed, changed, ...(reordered ? { reordered: true as const } : {}) }
}

function indexAdapters(value: Side): Map<string, JsonValue> | undefined {
	if (value === undefined) return new Map()
	if (!Array.isArray(value)) return undefined
	const adapters = new Map<string, JsonValue>()
	for (const item of value) {
		const moduleSpecifier = asString(asRecord(item)?.moduleSpecifier)
		if (moduleSpecifier === undefined || adapters.has(moduleSpecifier)) return undefined
		adapters.set(moduleSpecifier, item)
	}
	return adapters
}
