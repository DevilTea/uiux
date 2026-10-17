import {
	asRecord,
	diffJson,
	diffJsonExcept,
	diffKeyed,
	omit,
	valueChange,
	type JsonPointerChange,
	type KeyedChanges,
	type Side,
	type ValueChange,
} from './json-pointer'

/**
 * The semantic diff of the Workspace settings, the manifest (Rule
 * 01a11a5e-102f-7caa-b63f-d7c6fb5189c0): `i18n.defaultLocale`, and viewports and themes by key.
 * The manifest holds no Adapters (they are the Product Kit file's). The manifest `schemaVersion`
 * is never reported (Rule 01a11a5e-1085-71ec-ac82-d60263ae8173): it is removed from both sides
 * before anything is compared, including the structural fallback.
 */
export type WorkspaceSettingsDiff = Readonly<{
	type: 'workspace'
	defaultLocale?: ValueChange
	/** `i18n` members other than `defaultLocale`, relative to `i18n`. */
	i18nChanges?: readonly JsonPointerChange[]
	viewports?: KeyedChanges
	themes?: KeyedChanges
	/** Other manifest members, relative to the manifest; never `schemaVersion`. */
	otherChanges?: readonly JsonPointerChange[]
}>

const SETTINGS_MEMBERS = ['schemaVersion', 'i18n', 'viewports', 'themes'] as const

export function diffWorkspaceSettings(before: Side, after: Side): WorkspaceSettingsDiff {
	const leftManifest = asRecord(before)
	const rightManifest = asRecord(after)
	if ((before !== undefined && !leftManifest) || (after !== undefined && !rightManifest))
		return withOther({ type: 'workspace' }, diffJson(omit(before, ['schemaVersion']), omit(after, ['schemaVersion'])))
	const left = leftManifest ?? {}
	const right = rightManifest ?? {}
	// A member that is not an object on both sides is left to the structural diff of the manifest.
	const objects = (member: string) => (left[member] === undefined || asRecord(left[member]) !== undefined) && (right[member] === undefined || asRecord(right[member]) !== undefined)
	const semantic = SETTINGS_MEMBERS.filter(member => member === 'schemaVersion' || objects(member))
	const leftI18n = asRecord(left.i18n)
	const rightI18n = asRecord(right.i18n)
	const defaultLocale = objects('i18n') ? valueChange(leftI18n?.defaultLocale, rightI18n?.defaultLocale) : undefined
	const i18nChanges = objects('i18n') ? diffJsonExcept(left.i18n, right.i18n, ['defaultLocale']) : []
	const viewports = objects('viewports') ? diffKeyed(left.viewports, right.viewports) : undefined
	const themes = objects('themes') ? diffKeyed(left.themes, right.themes) : undefined
	const other = diffJsonExcept(left, right, semantic)
	return withOther({
		type: 'workspace',
		...(defaultLocale ? { defaultLocale } : {}),
		...(i18nChanges.length > 0 ? { i18nChanges } : {}),
		...(viewports ? { viewports } : {}),
		...(themes ? { themes } : {}),
	}, other)
}

function withOther(diff: WorkspaceSettingsDiff, other: readonly JsonPointerChange[]): WorkspaceSettingsDiff {
	return other.length > 0 ? { ...diff, otherChanges: other } : diff
}
