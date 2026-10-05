import type { ViewResource } from '../domain/views/schema'
import type { ViewportPreset, WorkspaceManifest } from '../domain/workspace/schema'

export type ViewportOption = Readonly<{
	id: string
	width: number
	height: number
	label: string
}>

export type RenderContextOptionState = Readonly<{
	variants: Readonly<{
		available: readonly string[]
		selected?: string
		hasVariants: boolean
		isInvalid: boolean
		statusMessage: string
	}>
	locales: Readonly<{
		available: readonly string[]
		defaultLocale: string
		selected: string
		hasAdditionalLocales: boolean
		isInvalid: boolean
		statusMessage: string
	}>
	viewports: Readonly<{
		available: readonly ViewportOption[]
		selectedId: string
		selectedDimensions: Readonly<{ width: number; height: number }>
		isEmpty: boolean
		isInvalid: boolean
		statusMessage: string
	}>
	themes: Readonly<{
		available: readonly string[]
		selected: string
		isEmpty: boolean
		isInvalid: boolean
		statusMessage: string
	}>
}>

export const DEFAULT_VIEWPORT: ViewportOption = Object.freeze({
	id: 'default',
	width: 1280,
	height: 800,
	label: 'Desktop (1280 × 800)',
})

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
	const variantStatusMessage = !hasVariants
		? 'Default (no variants authored)'
		: isVariantInvalid
			? `Invalid variant "${selectedVariant}"`
			: selectedVariant ?? 'Default'

	// 2. Locales
	const defaultLocale = input.workspace?.i18n.defaultLocale || 'en-US'
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
	const localeStatusMessage = isLocaleInvalid
		? `Invalid locale "${selectedLocale}"`
		: selectedLocale

	// 3. Viewports
	const rawViewports = input.workspace?.viewports ?? {}
	const viewportEntries = Object.entries(rawViewports)
	const hasViewports = viewportEntries.length > 0

	let availableViewports: readonly ViewportOption[]
	if (hasViewports) {
		availableViewports = Object.freeze(viewportEntries.map(([id, preset]: [string, ViewportPreset]) => {
			const width = typeof preset.dimensions?.width === 'number' ? preset.dimensions.width : 1280
			const height = typeof preset.dimensions?.height === 'number' ? preset.dimensions.height : 800
			return {
				id,
				width,
				height,
				label: `${id} (${width} × ${height})`,
			}
		}))
	}
	else {
		availableViewports = Object.freeze([DEFAULT_VIEWPORT])
	}

	const selectedViewportId = input.selectedViewportId
		|| (hasViewports ? availableViewports[0]!.id : DEFAULT_VIEWPORT.id)
	const matchedViewport = availableViewports.find(v => v.id === selectedViewportId)
	const isViewportInvalid = hasViewports && matchedViewport === undefined
	const selectedDimensions = matchedViewport
		? { width: matchedViewport.width, height: matchedViewport.height }
		: { width: DEFAULT_VIEWPORT.width, height: DEFAULT_VIEWPORT.height }
	const viewportStatusMessage = !hasViewports
		? 'No presets in workspace.json (using default)'
		: isViewportInvalid
			? `Invalid viewport "${selectedViewportId}"`
			: matchedViewport?.label ?? selectedViewportId

	// 4. Themes
	const rawThemes = input.workspace?.themes ?? {}
	const themeKeys = Object.keys(rawThemes).sort()
	const hasThemes = themeKeys.length > 0
	const selectedTheme = input.selectedThemeId || (hasThemes ? themeKeys[0]! : 'light')
	const isThemeInvalid = hasThemes && !themeKeys.includes(selectedTheme)
	const themeStatusMessage = !hasThemes
		? 'Default (no themes defined)'
		: isThemeInvalid
			? `Invalid theme "${selectedTheme}"`
			: selectedTheme

	return Object.freeze({
		variants: Object.freeze({
			available: Object.freeze(variantKeys),
			selected: selectedVariant,
			hasVariants,
			isInvalid: isVariantInvalid,
			statusMessage: variantStatusMessage,
		}),
		locales: Object.freeze({
			available: availableLocales,
			defaultLocale,
			selected: selectedLocale,
			hasAdditionalLocales,
			isInvalid: isLocaleInvalid,
			statusMessage: localeStatusMessage,
		}),
		viewports: Object.freeze({
			available: availableViewports,
			selectedId: selectedViewportId,
			selectedDimensions: Object.freeze(selectedDimensions),
			isEmpty: !hasViewports,
			isInvalid: isViewportInvalid,
			statusMessage: viewportStatusMessage,
		}),
		themes: Object.freeze({
			available: Object.freeze(themeKeys),
			selected: selectedTheme,
			isEmpty: !hasThemes,
			isInvalid: isThemeInvalid,
			statusMessage: themeStatusMessage,
		}),
	})
}
