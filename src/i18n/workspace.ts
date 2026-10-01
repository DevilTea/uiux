import type { Diagnostic } from '../domain/validation'
import type { I18nResource } from '../domain/i18n/schema'
import { createTranslationRuntime, type I18nCheckFinding, type TranslationRuntimeState } from './runtime'

export type InspectedLocaleResource = Readonly<{
	resource: I18nResource
	diagnostics: readonly Diagnostic[]
}>

export interface LocaleResourceSource {
	discoverInspected(): Promise<Readonly<{ locales: readonly string[]; diagnostics: readonly Diagnostic[] }>>
	readInspected(locale: string): Promise<InspectedLocaleResource | undefined>
}

export type WorkspaceI18nInspection = Readonly<{
	locales: readonly string[]
	resources: ReadonlyMap<string, I18nResource>
	resourceDiagnostics: readonly Diagnostic[]
	runtime: TranslationRuntimeState
}>

/** Reads filesystem-discovered locale identities; no supported-locale list is duplicated in Workspace config. */
export async function inspectWorkspaceI18n(defaultLocale: string, source: LocaleResourceSource): Promise<WorkspaceI18nInspection> {
	const discovery = await source.discoverInspected()
	const resources = new Map<string, I18nResource>()
	const resourceDiagnostics: Diagnostic[] = [...discovery.diagnostics]
	for (const locale of discovery.locales) {
		const read = await source.readInspected(locale)
		if (!read) continue
		resourceDiagnostics.push(...read.diagnostics.map(item => ({ ...item, path: `/i18n/${escapePointer(locale)}${item.path}` })))
		if (read.diagnostics.length === 0) resources.set(locale, read.resource)
	}
	const runtime = createTranslationRuntime(defaultLocale, resources)
	return {
		locales: [...discovery.locales],
		resources,
		resourceDiagnostics,
		runtime: appendResourceFindings(runtime, resourceDiagnostics, defaultLocale),
	}
}

function appendResourceFindings(state: TranslationRuntimeState, diagnostics: readonly Diagnostic[], defaultLocale: string): TranslationRuntimeState {
	if (diagnostics.length === 0) return state
	const findings: I18nCheckFinding[] = [
		...state.findings,
		...diagnostics.map(diagnostic => ({
			diagnostic,
			severity: 'error' as const,
			blocksTranslationExecution: isLocaleDiagnostic(diagnostic.path, defaultLocale),
		})),
	]
	if (findings.some(item => item.blocksTranslationExecution)) return { state: 'blocked', findings }
	return state.state === 'ready' ? { ...state, findings } : { state: 'blocked', findings }
}

function isLocaleDiagnostic(path: string, locale: string): boolean {
	const prefix = `/i18n/${escapePointer(locale)}`
	return path === prefix || path.startsWith(`${prefix}/`)
}

function escapePointer(value: string): string {
	return value.replaceAll('~', '~0').replaceAll('/', '~1')
}
