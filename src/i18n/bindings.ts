import { validateI18nBindingEligibility, type I18nFieldMapping } from '../domain/i18n/schema'
import type { Diagnostic } from '../domain/validation'

export type LoweredI18nBinding = Readonly<{
	authorField: string
	configField: string
	key: string
	resultProperty: string
	textProperty: string
	params: Readonly<Record<string, string>>
}>

export type I18nBindingLoweringResult =
	| Readonly<{ state: 'ready'; value: LoweredI18nBinding; diagnostics: readonly [] }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

/** Lowers only Catalog-declared canonical $i18n authoring fields to runtime-facing key/config metadata. */
export function lowerI18nBinding(input: Readonly<{
	binding: unknown
	authorField: string
	fields: Readonly<Record<string, I18nFieldMapping>>
	path?: string
}>): I18nBindingLoweringResult {
	const validation = validateI18nBindingEligibility(input.binding, input.authorField, input.fields, input.path ?? '')
	if (!validation.ok) return { state: 'invalid', diagnostics: validation.diagnostics }
	const mapping = input.fields[input.authorField]!
	return {
		state: 'ready',
		diagnostics: [],
		value: {
			authorField: input.authorField,
			configField: mapping.configField,
			key: validation.value.$i18n,
			resultProperty: mapping.resultProperty,
			textProperty: mapping.textProperty,
			params: { ...(mapping.params ?? {}) },
		},
	}
}
