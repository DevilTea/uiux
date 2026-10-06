import type { ViewResource } from '../domain/views/schema'
import type { ViewportPreset, WorkspaceManifest } from '../domain/workspace/schema'

export type ViewportOption = Readonly<{
	id: string
	width: number
	height: number
	/** Authored preset label from workspace.json; absent for unlabeled presets and the built-in default. */
	label?: string
	/** True only for the built-in fallback viewport used when the Workspace defines no presets. */
	isDefault?: boolean
}>

export type ThemeOption = Readonly<{
	id: string
	/** Authored theme label from workspace.json, when present. */
	label?: string
}>

/**
 * Machine-readable state of one render-context dimension. User interfaces map
 * the code to localized copy; this module deliberately carries no UI strings.
 * - `none`: nothing authored, the built-in default applies
 * - `selected`: `value` is a valid authored selection
 * - `invalid`: `value` is not among the authored options
 */
export type RenderContextStatus = Readonly<{
	code: 'none' | 'selected' | 'invalid'
	value?: string
}>

export type RenderContextOptionState = Readonly<{
	variants: Readonly<{
		available: readonly string[]
		selected?: string
		hasVariants: boolean
		isInvalid: boolean
		status: RenderContextStatus
	}>
	locales: Readonly<{
		available: readonly string[]
		defaultLocale: string
		selected: string
		hasAdditionalLocales: boolean
		isInvalid: boolean
		status: RenderContextStatus
	}>
	viewports: Readonly<{
		available: readonly ViewportOption[]
		selectedId: string
		selectedDimensions: Readonly<{ width: number; height: number }>
		isEmpty: boolean
		isInvalid: boolean
		status: RenderContextStatus
	}>
	themes: Readonly<{
		available: readonly string[]
		options: readonly ThemeOption[]
		selected: string
		isEmpty: boolean
		isInvalid: boolean
		status: RenderContextStatus
	}>
}>

export const DEFAULT_VIEWPORT: ViewportOption = Object.freeze({
	id: 'default',
	width: 1280,
	height: 800,
	isDefault: true,
})

/** Theme id used when the Workspace defines no themes. */
export const FALLBACK_THEME_ID = 'light'
/** Locale used when the Workspace manifest is unavailable. */
export const FALLBACK_LOCALE = 'en-US'

/** The Workspace default locale, the locale a preview renders when none is selected. */
export function resolveDefaultLocale(workspace?: Pick<WorkspaceManifest, 'i18n'>): string {
	return workspace?.i18n?.defaultLocale || FALLBACK_LOCALE
}

/** The theme a preview renders when none is selected: the first authored theme id in sorted order. */
export function resolveDefaultThemeId(workspace?: Pick<WorkspaceManifest, 'themes'>): string {
	const keys = Object.keys(workspace?.themes ?? {}).sort()
	return keys[0] ?? FALLBACK_THEME_ID
}

/** The viewport a preview renders when none is selected: the widest authored preset, else the built-in default. */
export function resolveDefaultViewport(workspace?: Pick<WorkspaceManifest, 'viewports'>): ViewportOption {
	return deriveViewportOptions(workspace)[0] ?? DEFAULT_VIEWPORT
}

function deriveViewportOptions(workspace?: Pick<WorkspaceManifest, 'viewports'>): readonly ViewportOption[] {
	const entries = Object.entries(workspace?.viewports ?? {})
	if (!entries.length) return Object.freeze([DEFAULT_VIEWPORT])
	return Object.freeze(entries.map(([id, preset]: [string, ViewportPreset]) => {
		const width = typeof preset.dimensions?.width === 'number' ? preset.dimensions.width : DEFAULT_VIEWPORT.width
		const height = typeof preset.dimensions?.height === 'number' ? preset.dimensions.height : DEFAULT_VIEWPORT.height
		const label = typeof preset.label === 'string' && preset.label.trim() ? preset.label : undefined
		return Object.freeze({ id, width, height, ...(label ? { label } : {}) })
	})
		// Canonical JSON stores registry keys sorted, so authored order is not available.
		// Present presets widest first, with the stable id as tiebreak.
		.sort((a, b) => b.width - a.width || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)))
}

export function deriveRenderContextOptions(input: Readonly<{
	workspace?: WorkspaceManifest
	view?: ViewResource
	discoveredLocales?: readonly string[]
	selectedVariant?: string
	selectedLocale?: string
	selectedViewportId?: string
	selectedThemeId?: string
}>): RenderContextOptionState {
	// 1. Variants
	const variantKeys = input.view?.variants ? Object.keys(input.view.variants).sort() : []
	const hasVariants = variantKeys.length > 0
	const selectedVariant = input.selectedVariant || undefined
	const isVariantInvalid = selectedVariant !== undefined && !variantKeys.includes(selectedVariant)
	const variantStatus: RenderContextStatus = isVariantInvalid
		? { code: 'invalid', value: selectedVariant }
		: selectedVariant
			? { code: 'selected', value: selectedVariant }
			: { code: 'none' }

	// 2. Locales
	const defaultLocale = resolveDefaultLocale(input.workspace)
	const allLocales = new Set<string>([defaultLocale])
	if (input.discoveredLocales) {
		for (const locale of input.discoveredLocales) {
			if (locale) allLocales.add(locale)
		}
	}
	const availableLocales = Object.freeze([...allLocales])
	const hasAdditionalLocales = availableLocales.length > 1
	const selectedLocale = input.selectedLocale || defaultLocale
	const isLocaleInvalid = !availableLocales.includes(selectedLocale)
	const localeStatus: RenderContextStatus = isLocaleInvalid
		? { code: 'invalid', value: selectedLocale }
		: { code: 'selected', value: selectedLocale }

	// 3. Viewports
	const hasViewports = Object.keys(input.workspace?.viewports ?? {}).length > 0
	const availableViewports = deriveViewportOptions(input.workspace)

	const selectedViewportId = input.selectedViewportId
		|| (hasViewports ? availableViewports[0]!.id : DEFAULT_VIEWPORT.id)
	const matchedViewport = availableViewports.find(v => v.id === selectedViewportId)
	const isViewportInvalid = hasViewports && matchedViewport === undefined
	const selectedDimensions = matchedViewport
		? { width: matchedViewport.width, height: matchedViewport.height }
		: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }
	const viewportStatus: RenderContextStatus = !hasViewports
		? { code: 'none' }
		: isViewportInvalid
			? { code: 'invalid', value: selectedViewportId }
			: { code: 'selected', value: selectedViewportId }

	// 4. Themes
	const rawThemes = input.workspace?.themes ?? {}
	const themeKeys = Object.keys(rawThemes).sort()
	const hasThemes = themeKeys.length > 0
	const themeOptions = Object.freeze(themeKeys.map((id) => {
		const label = rawThemes[id]?.label
		return Object.freeze({ id, ...(typeof label === 'string' && label.trim() ? { label } : {}) })
	}))
	const selectedTheme = input.selectedThemeId || resolveDefaultThemeId(input.workspace)
	const isThemeInvalid = hasThemes && !themeKeys.includes(selectedTheme)
	const themeStatus: RenderContextStatus = !hasThemes
		? { code: 'none', value: selectedTheme }
		: isThemeInvalid
			? { code: 'invalid', value: selectedTheme }
			: { code: 'selected', value: selectedTheme }

	return Object.freeze({
		variants: Object.freeze({
			available: Object.freeze(variantKeys),
			selected: selectedVariant,
			hasVariants,
			isInvalid: isVariantInvalid,
			status: Object.freeze(variantStatus),
		}),
		locales: Object.freeze({
			available: availableLocales,
			defaultLocale,
			selected: selectedLocale,
			hasAdditionalLocales,
			isInvalid: isLocaleInvalid,
			status: Object.freeze(localeStatus),
		}),
		viewports: Object.freeze({
			available: availableViewports,
			selectedId: selectedViewportId,
			selectedDimensions: Object.freeze(selectedDimensions),
			isEmpty: !hasViewports,
			isInvalid: isViewportInvalid,
			status: Object.freeze(viewportStatus),
		}),
		themes: Object.freeze({
			available: Object.freeze(themeKeys),
			options: themeOptions,
			selected: selectedTheme,
			isEmpty: !hasThemes,
			isInvalid: isThemeInvalid,
			status: Object.freeze(themeStatus),
		}),
	})
}
