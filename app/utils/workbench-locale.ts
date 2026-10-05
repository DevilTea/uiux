/**
 * Workbench chrome locale resolution.
 *
 * These are the Workbench UI's own locales. They are unrelated to the locales a
 * Workspace authors under its i18n/ directory for preview rendering.
 */
export const WORKBENCH_LOCALES = ['en-US', 'zh-TW'] as const
export type WorkbenchLocale = typeof WORKBENCH_LOCALES[number]
export const DEFAULT_WORKBENCH_LOCALE: WorkbenchLocale = 'en-US'
export const WORKBENCH_LOCALE_STORAGE_KEY = 'uiux.workbench.locale'

export function isWorkbenchLocale(value: unknown): value is WorkbenchLocale {
	return typeof value === 'string' && (WORKBENCH_LOCALES as readonly string[]).includes(value)
}

/** Maps one BCP 47 language tag to a Workbench locale, if any matches. */
export function matchWorkbenchLocale(tag: string): WorkbenchLocale | undefined {
	const normalized = tag.trim().toLowerCase()
	if (!normalized) return undefined
	if (normalized === 'zh-tw' || normalized.startsWith('zh-tw-') || normalized === 'zh-hant' || normalized.startsWith('zh-hant-'))
		return 'zh-TW'
	if (normalized === 'en' || normalized.startsWith('en-'))
		return 'en-US'
	return undefined
}

/**
 * Resolves the initial Workbench locale: saved preference first, then the
 * browser language list (zh-TW / zh-Hant map to zh-TW), then en-US.
 */
export function resolveInitialWorkbenchLocale(
	saved: string | null | undefined,
	browserLanguages: readonly string[] = [],
): WorkbenchLocale {
	if (isWorkbenchLocale(saved)) return saved
	for (const tag of browserLanguages) {
		const matched = matchWorkbenchLocale(tag)
		if (matched) return matched
	}
	return DEFAULT_WORKBENCH_LOCALE
}

export function readSavedWorkbenchLocale(): string | null {
	try {
		return globalThis.localStorage?.getItem(WORKBENCH_LOCALE_STORAGE_KEY) ?? null
	}
	catch {
		return null
	}
}

export function saveWorkbenchLocale(locale: WorkbenchLocale): void {
	try {
		globalThis.localStorage?.setItem(WORKBENCH_LOCALE_STORAGE_KEY, locale)
	}
	catch {
		// Storage may be unavailable (private mode); the choice still applies for this session.
	}
}
