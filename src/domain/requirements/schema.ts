import { hasAsciiControlCharacter, isRecord, jsonPointer, Validator } from '../validation'

/**
 * Requirement references (Feature 01a18120-f2dd-72a2-bc50-cea327cf1b4d, schemaVersion 7): opaque
 * requirement IDs that a View's Spec, a Variant entry or a UX Flow lists, and the manifest's
 * `requirements` setting (a provider and the `noUi` map). The shapes and limits are those of
 * Clauses 01a18120-f403-796d-9ae7-7889fa233bca, 01a18120-f49d-7b42-bad5-69d727f6a33a and
 * 01a18120-f52d-7448-bf25-13e37a8d791c.
 */

/** Clause 01a18120-f403-…: an ID has 1 to 200 characters. */
export const REQUIREMENT_ID_MAX_LENGTH = 200
/** Clause 01a18120-f403-…: one `requirements` array holds at most 100 IDs. */
export const REQUIREMENTS_PER_ARRAY_MAX = 100
/** Clause 01a18120-f52d-…: a `noUi` reason has 1 to 500 characters. */
export const NO_UI_REASON_MAX_LENGTH = 500
/** Clause 01a18120-f52d-…: the `noUi` map holds at most 10,000 entries. */
export const NO_UI_MAX_ENTRIES = 10_000

/** The diagnostic codes of the requirement shapes (Clauses 01a18120-f403-…, f49d-… and f52d-…). */
export const REQUIREMENT_DIAGNOSTIC_CODES = Object.freeze({
	invalidId: 'requirements.invalid_id',
	duplicateId: 'requirements.duplicate_id',
	tooMany: 'requirements.too_many',
	providerInvalid: 'requirements.provider_invalid',
	noUiInvalid: 'requirements.no_ui_invalid',
	/** Clause 01a18120-f5b9-…: an ID the `spec` provider lacks (a diagnostic of a read or a write result, never of a shape). */
	unresolved: 'requirements.unresolved',
	/** Clause 01a18120-f5b9-…: a `spec` provider that cannot be read. */
	providerUnavailable: 'requirements.provider_unavailable',
} as const)

/**
 * Rule 01a18121-0018-7013-9c5d-16e1efbb55a0: a requirement diagnostic never makes a View, a Variant or a
 * UX Flow unusable for rendering, capture or playback, so the code that decides whether one is usable
 * sets these aside.
 */
export function isRequirementDiagnostic(diagnostic: Readonly<{ code: string }>): boolean {
	return diagnostic.code.startsWith('requirements.')
}

export function withoutRequirementDiagnostics<T extends Readonly<{ code: string }>>(diagnostics: readonly T[]): readonly T[] {
	return diagnostics.filter(diagnostic => !isRequirementDiagnostic(diagnostic))
}

export type SpecRequirementsProvider = Readonly<{ provider: 'spec'; path: string }>
export type UrlRequirementsProvider = Readonly<{ provider: 'url'; template: string }>
export type RequirementsProvider = SpecRequirementsProvider | UrlRequirementsProvider

/** The manifest's `requirements` setting (Clause 01a18120-f49d-…): a provider and an optional `noUi` map. */
export type RequirementsSetting = RequirementsProvider & Readonly<{ noUi?: Readonly<Record<string, string>> }>

/** The member of a `url` provider's `template` that a link replaces with the percent-encoded ID. */
export const URL_TEMPLATE_PLACEHOLDER = '{id}'

function codePointLength(value: string): number {
	return [...value].length
}

/**
 * A write trims each ID before checking (Clause 01a18120-f403-…). Anything that is not an array of
 * strings is returned as given, so the validator reports it.
 */
export function trimRequirementIds<T>(value: T): T {
	if (!Array.isArray(value)) return value
	return value.map(item => typeof item === 'string' ? item.trim() : item) as T
}

/** A write trims `noUi` IDs and reasons (Clause 01a18120-f52d-…); a non-map is returned as given. */
export function trimNoUi<T>(value: T): T {
	if (!isRecord(value)) return value
	// `Object.fromEntries` defines each key as an own property, so a key named `__proto__` is kept.
	return Object.fromEntries(Object.entries(value).map(([id, reason]) => [id.trim(), typeof reason === 'string' ? reason.trim() : reason])) as T
}

/** A write trims the IDs of `setting` (Clause 01a18120-f49d-…), so the validator sees the stored form. */
export function trimRequirementsSetting<T>(value: T): T {
	if (!isRecord(value) || !Object.hasOwn(value, 'noUi')) return value
	return { ...value, noUi: trimNoUi(value.noUi) } as T
}

function validateRequirementId(value: unknown, path: string, v: Validator): value is string {
	if (typeof value !== 'string') {
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.invalidId, path, 'A requirement ID is a string.')
		return false
	}
	if (value.length === 0 || codePointLength(value) > REQUIREMENT_ID_MAX_LENGTH || value !== value.trim()) {
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.invalidId, path, `A requirement ID is 1 to ${REQUIREMENT_ID_MAX_LENGTH} characters with no leading or trailing white space.`)
		return false
	}
	return true
}

/**
 * Clause 01a18120-f403-796d-9ae7-7889fa233bca: `value` is an array of at most 100 requirement IDs, each
 * 1 to 200 characters with no leading or trailing white space, unique when compared exactly. A value
 * that is not an array is reported as `schema.expected_array`.
 */
export function validateRequirementIds(value: unknown, path: string, v: Validator): readonly string[] | undefined {
	const items = v.array(value, path)
	if (!items) return undefined
	if (items.length > REQUIREMENTS_PER_ARRAY_MAX)
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.tooMany, path, `One requirements array holds at most ${REQUIREMENTS_PER_ARRAY_MAX} IDs.`)
	const seen = new Set<string>()
	items.forEach((item, index) => {
		const itemPath = jsonPointer(path, index)
		if (!validateRequirementId(item, itemPath, v)) return
		if (seen.has(item))
			v.issue(REQUIREMENT_DIAGNOSTIC_CODES.duplicateId, itemPath, 'The IDs of one requirements array are unique.')
		seen.add(item)
	})
	return items as string[]
}

/** A `/`-separated relative path (`.` and `..` segments allowed) that is not absolute and has no empty segment. */
export function isRelativeProviderPath(path: unknown): path is string {
	return typeof path === 'string'
		&& path.length > 0
		&& !path.includes('\\')
		&& !path.includes('\0')
		&& !hasAsciiControlCharacter(path)
		&& !path.startsWith('/')
		&& !/^[A-Za-z]:/u.test(path)
		&& path.split('/').every(segment => segment.length > 0)
}

/** An `http` or `https` URL template holding exactly one `{id}`. */
export function isUrlTemplate(template: unknown): template is string {
	if (typeof template !== 'string' || template.length === 0 || /\s/u.test(template) || hasAsciiControlCharacter(template)) return false
	if (template.split(URL_TEMPLATE_PLACEHOLDER).length !== 2) return false
	try {
		const parsed = new URL(template.replace(URL_TEMPLATE_PLACEHOLDER, 'id'))
		return parsed.protocol === 'http:' || parsed.protocol === 'https:'
	}
	catch {
		return false
	}
}

/** The link of a `url` provider for `id`: its template with `{id}` replaced by the percent-encoded ID. */
export function requirementLink(template: string, id: string): string {
	return template.replace(URL_TEMPLATE_PLACEHOLDER, encodeURIComponent(id))
}

/**
 * Clause 01a18120-f49d-7b42-bad5-69d727f6a33a (`provider`, `path` or `template`, any other shape is
 * `requirements.provider_invalid`) and Clause 01a18120-f52d-7448-bf25-13e37a8d791c (`noUi`).
 */
export function validateRequirementsSetting(value: unknown, path: string, v: Validator): void {
	if (!isRecord(value)) {
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, path, 'The requirements setting is an object with a provider.')
		return
	}
	const allowed = value.provider === 'spec' ? ['provider', 'path', 'noUi'] : value.provider === 'url' ? ['provider', 'template', 'noUi'] : ['provider', 'noUi']
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key))
			v.issue(REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, jsonPointer(path, key), 'This member is not part of the requirements setting of its provider.')
	}
	if (value.provider === 'spec') {
		if (!isRelativeProviderPath(value.path))
			v.issue(REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, jsonPointer(path, 'path'), 'A spec provider\'s path is a non-empty relative path with / separators from the Workspace root.')
	}
	else if (value.provider === 'url') {
		if (!isUrlTemplate(value.template))
			v.issue(REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, jsonPointer(path, 'template'), 'A url provider\'s template is an http or https URL holding exactly one {id}.')
	}
	else {
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.providerInvalid, jsonPointer(path, 'provider'), 'The requirements provider is spec or url.')
	}
	if (Object.hasOwn(value, 'noUi')) validateNoUi(value.noUi, jsonPointer(path, 'noUi'), v)
}

function validateNoUi(value: unknown, path: string, v: Validator): void {
	if (!isRecord(value)) {
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.noUiInvalid, path, 'noUi maps requirement IDs to reasons.')
		return
	}
	const entries = Object.entries(value)
	if (entries.length > NO_UI_MAX_ENTRIES)
		v.issue(REQUIREMENT_DIAGNOSTIC_CODES.noUiInvalid, path, `noUi holds at most ${NO_UI_MAX_ENTRIES} entries.`)
	for (const [id, reason] of entries) {
		const entryPath = jsonPointer(path, id)
		// An ID breaking Clause 01a18120-f403-… is `requirements.no_ui_invalid` here, the code of the map.
		const idIssues = new Validator()
		validateRequirementId(id, entryPath, idIssues)
		for (const issue of idIssues.diagnostics) v.issue(REQUIREMENT_DIAGNOSTIC_CODES.noUiInvalid, issue.path, issue.message)
		if (typeof reason !== 'string' || reason.length === 0 || codePointLength(reason) > NO_UI_REASON_MAX_LENGTH || reason !== reason.trim())
			v.issue(REQUIREMENT_DIAGNOSTIC_CODES.noUiInvalid, entryPath, `A noUi reason is 1 to ${NO_UI_REASON_MAX_LENGTH} characters with no leading or trailing white space.`)
	}
}
