import type { Diagnostic } from '../domain/validation'
import type { I18nResource, I18nWarning, TranslationResult } from '../domain/i18n/schema'

export type TranslationResourceMap = ReadonlyMap<string, I18nResource>

export type I18nCheckFinding = Readonly<{
	diagnostic: Diagnostic
	severity: 'error' | 'warning'
	blocksTranslationExecution: boolean
}>

export type TranslationRuntime = Readonly<{
	defaultLocale: string
	translate(requestedLocale: string, key: string, params?: Readonly<Record<string, string>>): TranslationResult
}>

export type TranslationRuntimeState =
	| Readonly<{ state: 'ready'; runtime: TranslationRuntime; findings: readonly I18nCheckFinding[] }>
	| Readonly<{ state: 'blocked'; findings: readonly I18nCheckFinding[] }>

export function createTranslationRuntime(
	defaultLocale: string,
	resources: TranslationResourceMap,
): TranslationRuntimeState {
	const findings = inspectTranslationResources(defaultLocale, resources)
	if (!resources.has(defaultLocale))
		return { state: 'blocked', findings }
	return {
		state: 'ready',
		findings,
		runtime: {
			defaultLocale,
			translate(requestedLocale, key, params) {
				return translate({ defaultLocale, resources, requestedLocale, key, params })
			},
		},
	}
}

export function inspectTranslationResources(
	defaultLocale: string,
	resources: TranslationResourceMap,
): readonly I18nCheckFinding[] {
	const findings: I18nCheckFinding[] = []
	if (!resources.has(defaultLocale)) {
		findings.push({
			diagnostic: {
				code: 'i18n.missing_default_locale',
				path: `/i18n/${escapePointer(defaultLocale)}`,
				message: `Workspace default locale ${defaultLocale} has no canonical locale resource.`,
			},
			severity: 'error',
			blocksTranslationExecution: true,
		})
	}
	for (const locale of [...resources.keys()].sort()) {
		const resource = resources.get(locale)!
		for (const key of Object.keys(resource).sort()) {
			const value = resource[key]!
			if (value === '') {
				findings.push(reminder('i18n.empty_translation', locale, key, 'Translation is intentionally blank; review completeness in the translation summary.'))
			}
			else if (value.trim() === '') {
				findings.push(reminder('i18n.whitespace_only_translation', locale, key, 'Translation contains only ECMAScript-trimmable whitespace.'))
			}
		}
	}
	return findings
}

export function translate(input: Readonly<{
	defaultLocale: string
	resources: TranslationResourceMap
	requestedLocale: string
	key: string
	params?: Readonly<Record<string, string>>
}>): TranslationResult {
	const warnings: I18nWarning[] = []
	const requested = input.resources.get(input.requestedLocale)
	const fallback = input.resources.get(input.defaultLocale)
	let template: string

	if (requested && Object.hasOwn(requested, input.key)) {
		template = requested[input.key]!
	}
	else if (fallback && Object.hasOwn(fallback, input.key)) {
		template = fallback[input.key]!
		if (input.requestedLocale !== input.defaultLocale) {
			warnings.push({
				code: 'missing-translation',
				key: input.key,
				requestedLocale: input.requestedLocale,
				fallbackLocale: input.defaultLocale,
			})
		}
	}
	else {
		return {
			text: `⟦missing:${input.key}⟧`,
			warnings: [{ code: 'unresolved-key', key: input.key, requestedLocale: input.requestedLocale }],
		}
	}

	const interpolation = interpolateTemplate(template, input.params ?? {}, input.key, input.requestedLocale)
	return { text: interpolation.text, warnings: [...warnings, ...interpolation.warnings] }
}

export function interpolateTemplate(
	template: string,
	params: Readonly<Record<string, string>>,
	key: string,
	requestedLocale: string,
): TranslationResult {
	let text = ''
	let cursor = 0
	const warnings: I18nWarning[] = []
	const warned = new Set<string>()

	while (cursor < template.length) {
		if (template[cursor] !== '{') {
			text += template[cursor++]
			continue
		}
		const fragmentStart = cursor
		while (template[cursor] === '{') cursor++
		const openCount = cursor - fragmentStart
		const identifierStart = cursor
		if (!isIdentifierStart(template[cursor])) {
			text += template.slice(fragmentStart, cursor)
			continue
		}
		cursor++
		while (isIdentifierContinue(template[cursor])) cursor++
		const name = template.slice(identifierStart, cursor)
		const closeStart = cursor
		while (template[cursor] === '}') cursor++
		const closeCount = cursor - closeStart

		if (closeCount === 0 || closeCount !== openCount) {
			text += template.slice(fragmentStart, cursor)
			continue
		}

		const literalPairs = Math.floor(openCount / 2)
		if (openCount % 2 === 0) {
			text += `${'{'.repeat(literalPairs)}${name}${'}'.repeat(literalPairs)}`
			continue
		}

		let value: string
		if (Object.hasOwn(params, name)) {
			value = params[name]!
		}
		else {
			value = `⟦missing-param:${name}⟧`
			if (!warned.has(name)) {
				warnings.push({ code: 'missing-parameter', key, requestedLocale, parameter: name })
				warned.add(name)
			}
		}
		text += `${'{'.repeat(literalPairs)}${value}${'}'.repeat(literalPairs)}`
	}

	return { text, warnings }
}

function reminder(code: 'i18n.empty_translation' | 'i18n.whitespace_only_translation', locale: string, key: string, message: string): I18nCheckFinding {
	return {
		diagnostic: { code, path: `/i18n/${escapePointer(locale)}/${escapePointer(key)}`, message },
		severity: 'warning',
		blocksTranslationExecution: false,
	}
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}

function isIdentifierStart(value: string | undefined): boolean {
	return value !== undefined && /^[A-Za-z_]$/u.test(value)
}

function isIdentifierContinue(value: string | undefined): boolean {
	return value !== undefined && /^[A-Za-z0-9_]$/u.test(value)
}
