import {
	jsonPointer,
	isCanonicalLocaleFilename,
	isCanonicalLocaleTag,
	rejectUnknownKeys,
	validateJsonValue,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../validation'
import type { I18nFieldMapping, TranslationResult, TranslationWarning } from '../../adapter-entry'

// The i18n field mapping, warning and result types are defined once, by the public Adapter authoring entry.
export type { I18nFieldMapping, TranslationResult }

export type I18nResource = Readonly<Record<string, string>>
export type I18nBinding = Readonly<{ $i18n: string }>
export type I18nWarning = TranslationWarning
export type MissingTranslationWarning = Extract<TranslationWarning, Readonly<{ code: 'missing-translation' }>>
export type UnresolvedKeyWarning = Extract<TranslationWarning, Readonly<{ code: 'unresolved-key' }>>
export type MissingParameterWarning = Extract<TranslationWarning, Readonly<{ code: 'missing-parameter' }>>
export type I18nOccurrence = Readonly<{
	warning: I18nWarning
	viewId: string
	variantName?: string
	widgetId: string
	resultProperty: string
	catalogField: string
}>

export function validateI18nResource(input: unknown, filename: string): ValidationResult<I18nResource> {
	const v = new Validator()
	const resource = v.object(input, '')
	if (!resource)
		return v.finish<I18nResource>(input)
	validateJsonValue(input, '', v)
	if (!isCanonicalLocaleFilename(filename))
		v.issue('i18n.invalid_locale_filename', '/filename', 'Locale resource filename must be a canonical BCP 47 tag followed by .json.')
	for (const [key, text] of Object.entries(resource)) {
		if (key.length === 0)
			v.issue('i18n.empty_key', '/', 'Locale resource keys must be non-empty strings.')
		if (typeof text !== 'string')
			v.issue('i18n.non_flat_value', jsonPointer('', key), 'Each locale resource value must be a string; nested objects are not supported.')
	}
	return v.finish<I18nResource>(input)
}

export function validateI18nBinding(input: unknown, path = ''): ValidationResult<I18nBinding> {
	const v = new Validator()
	const binding = v.object(input, path)
	if (!binding)
		return v.finish<I18nBinding>(input)
	if (Object.keys(binding).length !== 1 || !Object.hasOwn(binding, '$i18n'))
		v.issue('i18n.invalid_binding_shape', path, 'An i18n binding contains only the $i18n key.')
	v.string(binding.$i18n, `${path}/$i18n`, true)
	return v.finish<I18nBinding>(input)
}

/** A syntactically valid binding is accepted only on a Catalog-mapped field. */
export function validateI18nBindingEligibility(
	input: unknown,
	authorField: string,
	eligibleFields: Readonly<Record<string, I18nFieldMapping>>,
	path = '',
): ValidationResult<I18nBinding> {
	const result = validateI18nBinding(input, path)
	if (!result.ok) return result
	if (!Object.hasOwn(eligibleFields, authorField))
		return {
			ok: false,
			diagnostics: [{ code: 'i18n.field_not_eligible', path, message: 'Only Adapter Catalog fields explicitly mapped for $i18n accept a translation binding.' }],
		}
	return result
}

export type ResolvedI18nPropertyNames = Readonly<{ resultProperty: string; textProperty: string }>

/**
 * The Property names of a Catalog i18n field mapping (Clause 01a14e30-3676-7212-8cee-1ef84da6316c): a declared
 * name wins; an omitted `textProperty` is the authoring field's name and an omitted `resultProperty` that name
 * followed by `Result`. Every reader of a mapping's Property names goes through this, so a derived name is
 * validated and used exactly as a declared one.
 */
export function resolveI18nPropertyNames(authorField: string, mapping: I18nFieldMapping): ResolvedI18nPropertyNames {
	return {
		resultProperty: mapping.resultProperty ?? `${authorField}Result`,
		textProperty: mapping.textProperty ?? authorField,
	}
}

/** ` (derived)` for a Property name the mapping omits, so a diagnostic says where the name came from; else empty. */
export function derivedI18nPropertyNote(mapping: I18nFieldMapping, role: string): string {
	return (role === 'resultProperty' || role === 'textProperty') && mapping[role] === undefined ? ' (derived)' : ''
}

export function validateI18nFieldMapping(input: unknown, path = ''): ValidationResult<I18nFieldMapping> {
	const v = new Validator()
	const mapping = v.object(input, path)
	if (!mapping)
		return v.finish<I18nFieldMapping>(input)
	rejectUnknownKeys(mapping, ['configField', 'resultProperty', 'textProperty', 'params'], path, v)
	v.string(mapping.configField, `${path}/configField`, true)
	// Either Property name may be omitted and is then derived (resolveI18nPropertyNames); a declared one is a
	// non-empty string.
	for (const key of ['resultProperty', 'textProperty'] as const)
		if (Object.hasOwn(mapping, key)) v.string(mapping[key], `${path}/${key}`, true)
	if (Object.hasOwn(mapping, 'params')) {
		const params = v.object(mapping.params, `${path}/params`)
		if (params) {
			for (const [parameter, property] of Object.entries(params)) {
				if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(parameter))
					v.issue('i18n.invalid_parameter_name', jsonPointer(`${path}/params`, parameter),
						'Parameter names must match the canonical ASCII placeholder identifier grammar.')
				v.string(property, jsonPointer(`${path}/params`, parameter), true)
			}
		}
	}
	return v.finish<I18nFieldMapping>(input)
}

export function validateI18nWarning(input: unknown, path = ''): ValidationResult<I18nWarning> {
	const v = new Validator()
	const warning = v.object(input, path)
	if (!warning)
		return v.finish<I18nWarning>(input)
	v.string(warning.key, `${path}/key`, true)
	if (!isCanonicalLocaleTag(warning.requestedLocale))
		v.issue('i18n.invalid_requested_locale', `${path}/requestedLocale`, 'requestedLocale must be a canonical BCP 47 tag.')
	switch (warning.code) {
		case 'missing-translation':
			rejectUnknownKeys(warning, ['code', 'key', 'requestedLocale', 'fallbackLocale'], path, v)
			if (!isCanonicalLocaleTag(warning.fallbackLocale))
				v.issue('i18n.invalid_fallback_locale', `${path}/fallbackLocale`, 'fallbackLocale must be a canonical BCP 47 tag.')
			break
		case 'unresolved-key':
			rejectUnknownKeys(warning, ['code', 'key', 'requestedLocale'], path, v)
			break
		case 'missing-parameter':
			rejectUnknownKeys(warning, ['code', 'key', 'requestedLocale', 'parameter'], path, v)
			v.string(warning.parameter, `${path}/parameter`, true)
			break
		default:
			v.issue('i18n.unknown_warning_code', `${path}/code`, 'Unknown translation warning code.')
	}
	return v.finish<I18nWarning>(input)
}

export function validateTranslationResult(input: unknown, path = ''): ValidationResult<TranslationResult> {
	const v = new Validator()
	const result = v.object(input, path)
	if (!result)
		return v.finish<TranslationResult>(input)
	rejectUnknownKeys(result, ['text', 'warnings'], path, v)
	v.string(result.text, `${path}/text`)
	const warnings = v.array(result.warnings, `${path}/warnings`)
	warnings?.forEach((warning, index) => v.diagnostics.push(...validateI18nWarning(warning, jsonPointer(`${path}/warnings`, index)).diagnostics))
	return v.finish<TranslationResult>(input)
}

export function validateI18nOccurrence(input: unknown, path = ''): ValidationResult<I18nOccurrence> {
	const v = new Validator()
	const occurrence = v.object(input, path)
	if (!occurrence)
		return v.finish<I18nOccurrence>(input)
	rejectUnknownKeys(occurrence, ['warning', 'viewId', 'variantName', 'widgetId', 'resultProperty', 'catalogField'], path, v)
	v.diagnostics.push(...validateI18nWarning(occurrence.warning, `${path}/warning`).diagnostics)
	validateUuid(occurrence.viewId, `${path}/viewId`, v, 'View identity')
	for (const key of ['widgetId', 'resultProperty', 'catalogField'] as const) v.string(occurrence[key], `${path}/${key}`, true)
	if (Object.hasOwn(occurrence, 'variantName')) v.string(occurrence.variantName, `${path}/variantName`, true)
	return v.finish<I18nOccurrence>(input)
}

/** Handoff keeps locale JSON byte-semantics: empty and whitespace strings survive unchanged. */
export type I18nHandoffSnapshot = Readonly<{ locale: string; resource: I18nResource }>

export function makeI18nHandoffSnapshot(locale: string, resource: I18nResource): I18nHandoffSnapshot {
	return { locale, resource: { ...resource } }
}
