import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'
import { isCanonicalLocaleTag, type Diagnostic } from '../../domain/validation'
import { validateI18nResource, type I18nResource } from '../../domain/i18n/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateLocaleCommand = Readonly<{
	locale: string
	messages: I18nResource
}>

export type UpdateLocaleCommand = Readonly<{
	locale: string
	expectedRevision: string
	messages: I18nResource
}>

export type LocaleAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type LocaleAuthoringService = Readonly<{
	createLocale(command: CreateLocaleCommand): Promise<LocaleAuthoringResult>
	updateLocale(command: UpdateLocaleCommand): Promise<LocaleAuthoringResult>
}>

export function createLocaleAuthoringService(persistence: FileNativePersistence): LocaleAuthoringService {
	async function createLocale(command: CreateLocaleCommand): Promise<LocaleAuthoringResult> {
		if (!isCanonicalLocaleTag(command.locale))
			return {
				status: 'invalid',
				key: command.locale,
				diagnostics: [{ code: 'i18n.invalid_locale_tag', path: '/locale', message: 'Locale must be a canonical BCP 47 language tag.' }],
			}

		const validation = validateI18nResource(command.messages, `${command.locale}.json`)
		if (!validation.ok)
			return { status: 'invalid', key: command.locale, diagnostics: validation.diagnostics }

		try {
			const revision = await persistence.locales.create(command.locale, command.messages)
			const inspected = await persistence.locales.readInspected(command.locale)
			return { status: 'created', key: command.locale, revision, diagnostics: inspected?.diagnostics ?? [] }
		}
		catch (error) {
			if (!(error instanceof PersistenceError) || error.code !== 'persistence.resource_exists') throw error
			const currentRevision = await persistence.locales.readRevision(command.locale)
			return { status: 'already_exists', key: command.locale, ...(currentRevision ? { currentRevision } : {}) }
		}
	}

	async function updateLocale(command: UpdateLocaleCommand): Promise<LocaleAuthoringResult> {
		if (!isCanonicalLocaleTag(command.locale))
			return {
				status: 'invalid',
				key: command.locale,
				diagnostics: [{ code: 'i18n.invalid_locale_tag', path: '/locale', message: 'Locale must be a canonical BCP 47 language tag.' }],
			}

		const expectedRevision = validateResourceRevision(command.expectedRevision, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: command.locale, diagnostics: expectedRevision.diagnostics }

		const current = await persistence.locales.read(command.locale)
		if (!current) return { status: 'not_found', key: command.locale }
		if (current.revision !== expectedRevision.value)
			return { status: 'conflict', key: command.locale, currentRevision: current.revision }

		const validation = validateI18nResource(command.messages, `${command.locale}.json`)
		if (!validation.ok)
			return { status: 'invalid', key: command.locale, diagnostics: validation.diagnostics }

		const commit = await persistence.locales.compareAndSwap({
			key: command.locale,
			expectedRevision: expectedRevision.value,
			resource: command.messages,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.locale, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.locales.readInspected(command.locale)
		return { status: 'updated', key: command.locale, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [] }
	}

	return { createLocale, updateLocale }
}
