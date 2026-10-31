import type { ResourceRevision } from '../dto/revisions'
import { summarizeChange, type ChangeSummary } from '../dto/change-summary'
import { validateResourceRevision } from '../dto/revisions'
import { isCanonicalLocaleTag, type Diagnostic } from '../../domain/validation'
import { validateI18nResource, type I18nResource } from '../../domain/i18n/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'

export type CreateLocaleCommand = Readonly<{
	locale: string
	messages: I18nResource
}>

/**
 * Either `messages` (replaces every message) or `set` and/or `remove` (change only the named
 * keys), never both and never none (Clause 01a191cf-5734-73c7-9bf2-b437c39ae072).
 */
export type UpdateLocaleCommand = Readonly<{
	locale: string
	expectedRevision: string
	messages?: I18nResource
	set?: Readonly<Record<string, string>>
	remove?: readonly string[]
}>

export type LocaleAuthoringResult =
	| Readonly<{ status: 'created' | 'updated'; key: string; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; changeSummary: ChangeSummary }>
	| Readonly<{ status: 'already_exists'; key: string; currentRevision?: ResourceRevision }>
	| Readonly<{ status: 'not_found'; key: string }>
	| Readonly<{ status: 'conflict'; key: string; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: string; diagnostics: readonly Diagnostic[] }>

export type LocaleAuthoringService = Readonly<{
	createLocale(command: CreateLocaleCommand): Promise<LocaleAuthoringResult>
	updateLocale(command: UpdateLocaleCommand): Promise<LocaleAuthoringResult>
}>

function invalidUpdate(message: string): Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }> {
	return { ok: false, diagnostics: [{ code: 'i18n.invalid_locale_update', path: '/', message }] }
}

/** The messages an update leaves: `messages` verbatim, or the current ones with `set` applied and `remove` deleted. */
function resolveUpdatedMessages(
	command: UpdateLocaleCommand,
	current: I18nResource,
): Readonly<{ ok: true; messages: I18nResource }> | Readonly<{ ok: false; diagnostics: readonly Diagnostic[] }> {
	const partial = command.set !== undefined || command.remove !== undefined
	if (command.messages !== undefined) {
		if (partial) return invalidUpdate('Give either messages, or set and remove, not both.')
		return { ok: true, messages: command.messages }
	}
	if (!partial) return invalidUpdate('Give either messages, or set and/or remove.')

	const set = command.set ?? {}
	const remove = command.remove ?? []
	const removed = new Set(remove)
	const overlap = Object.keys(set).filter(key => removed.has(key))
	if (overlap.length > 0)
		return invalidUpdate(`A key cannot be in both set and remove: ${overlap.join(', ')}.`)

	const messages: Record<string, string> = { ...current, ...set }
	for (const key of removed) delete messages[key]
	return { ok: true, messages }
}

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
			return { status: 'created', key: command.locale, revision, diagnostics: inspected?.diagnostics ?? [], changeSummary: summarizeChange(undefined, command.messages) }
		}
		catch (error) {
			// A case-variant file (for example `zh-tw.json`) holding this locale's path on a
			// case-insensitive volume is reported as the same filename diagnostic discovery emits.
			if (error instanceof PersistenceError && error.code === 'persistence.path_rejected' && error.diagnostics.length > 0)
				return { status: 'invalid', key: command.locale, diagnostics: error.diagnostics }
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

		const next = resolveUpdatedMessages(command, current.resource)
		if (!next.ok)
			return { status: 'invalid', key: command.locale, diagnostics: next.diagnostics }

		const validation = validateI18nResource(next.messages, `${command.locale}.json`)
		if (!validation.ok)
			return { status: 'invalid', key: command.locale, diagnostics: validation.diagnostics }

		const commit = await persistence.locales.compareAndSwap({
			key: command.locale,
			expectedRevision: expectedRevision.value,
			resource: next.messages,
		})
		if (!commit.ok)
			return { status: 'conflict', key: command.locale, currentRevision: commit.conflict.currentRevision }
		const inspected = await persistence.locales.readInspected(command.locale)
		return { status: 'updated', key: command.locale, revision: commit.revision, diagnostics: inspected?.diagnostics ?? [], changeSummary: summarizeChange(current.resource, next.messages) }
	}

	return { createLocale, updateLocale }
}
