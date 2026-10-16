import { missingDefaultLocaleDiagnostic } from '../../i18n/runtime'
import type { Diagnostic } from '../../domain/validation'
import type { FileNativePersistence } from '../../persistence'

/**
 * The persistent Workspace configuration error that blocks Locale-dependent capture: the Workspace
 * `i18n.defaultLocale` names a Locale without its Locale file (Rules
 * 01a115cd-b2ad-7989-8faa-07d48bc8ee30 and 01a115cd-b30b-706e-b8a2-46e62259156e). `undefined` while
 * the file exists, or when no manifest can be read (the caller reports that on its own).
 */
export async function missingDefaultLocaleError(persistence: FileNativePersistence): Promise<Diagnostic | undefined> {
	const manifest = (await persistence.workspace.readInspected()).resource
	const defaultLocale = manifest?.i18n?.defaultLocale
	if (!defaultLocale) return undefined
	if (await persistence.locales.readRevision(defaultLocale)) return undefined
	return missingDefaultLocaleDiagnostic(defaultLocale)
}
