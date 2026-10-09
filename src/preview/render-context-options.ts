import type { ViewResource } from '../domain/views/schema'
import type { ReviewRenderContext } from '../domain/reviews/schema'
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

// ---------------------------------------------------------------------------------------------
// A Review thread's recorded render context (Workbench IA Rules 01a1170f-c0ce, 01a1170f-c165)
// ---------------------------------------------------------------------------------------------

/** One member of a thread's recorded `renderContext`. */
export type RenderContextMember = 'locale' | 'viewportId' | 'themeId'
export const RENDER_CONTEXT_MEMBERS: readonly RenderContextMember[] = Object.freeze(['locale', 'viewportId', 'themeId'])

/**
 * The Workspace-local keys of each member (Clause 01a11e0d-d2d0): the Locales with an i18n file
 * plus `i18n.defaultLocale`, and the IDs in the manifest's `viewports` and `themes`. Built-in
 * fallbacks (the `default` viewport, the `light` theme, `en-US` without a manifest) are not keys.
 */
export type RenderContextKeys = Readonly<{
	locales: ReadonlySet<string>
	viewportIds: ReadonlySet<string>
	themeIds: ReadonlySet<string>
}>

export function workspaceRenderContextKeys(
	workspace: Pick<WorkspaceManifest, 'i18n' | 'viewports' | 'themes'> | undefined,
	localeFiles: readonly string[],
): RenderContextKeys {
	const locales = new Set(localeFiles.filter(Boolean))
	const defaultLocale = workspace?.i18n?.defaultLocale
	if (typeof defaultLocale === 'string' && defaultLocale) locales.add(defaultLocale)
	return Object.freeze({
		locales,
		viewportIds: new Set(Object.keys(workspace?.viewports ?? {})),
		themeIds: new Set(Object.keys(workspace?.themes ?? {})),
	})
}

function isKey(keys: RenderContextKeys, member: RenderContextMember, value: string): boolean {
	return member === 'locale' ? keys.locales.has(value) : member === 'viewportId' ? keys.viewportIds.has(value) : keys.themeIds.has(value)
}

/**
 * What a new canvas thread records (Rule 01a1170f-c0ce): each current member that is a
 * Workspace-local key, and nothing (`undefined`) when none is.
 */
export function captureRenderContext(
	keys: RenderContextKeys,
	current: Readonly<{ locale?: string; viewportId?: string; themeId?: string }>,
): ReviewRenderContext | undefined {
	const recorded: { locale?: string; viewportId?: string; themeId?: string } = {}
	for (const member of RENDER_CONTEXT_MEMBERS) {
		const value = current[member]
		if (value && isKey(keys, member, value)) recorded[member] = value
	}
	return Object.keys(recorded).length ? Object.freeze(recorded) : undefined
}

export type MissingRenderContextKey = Readonly<{ member: RenderContextMember; key: string }>

/**
 * Splits a recorded render context into the members that still exist (`applied`) and the stale
 * ones (`missing`), which open with their default and a notice (Rule 01a1170f-c165). A stale key
 * is never rebound; members the thread does not record appear in neither list.
 */
export function resolveRecordedContext(
	recorded: ReviewRenderContext | undefined,
	keys: RenderContextKeys,
): Readonly<{ applied: ReviewRenderContext; missing: readonly MissingRenderContextKey[] }> {
	const applied: { locale?: string; viewportId?: string; themeId?: string } = {}
	const missing: MissingRenderContextKey[] = []
	for (const member of RENDER_CONTEXT_MEMBERS) {
		const value = recorded?.[member]
		if (value === undefined) continue
		if (isKey(keys, member, value)) applied[member] = value
		else missing.push(Object.freeze({ member, key: value }))
	}
	return Object.freeze({ applied: Object.freeze(applied), missing: Object.freeze(missing) })
}

/**
 * The Locale, viewport and theme a selection actually shows, with its empty members resolved to
 * their defaults, so two selections can be compared by what the Preview renders.
 */
export function effectiveRenderContext(
	workspace: WorkspaceManifest | undefined,
	discoveredLocales: readonly string[],
	selection: Readonly<{ locale?: string; viewport?: string; theme?: string }>,
): Readonly<{ locale: string; viewportId: string; themeId: string }> {
	const options = deriveRenderContextOptions({
		workspace,
		discoveredLocales,
		selectedLocale: selection.locale,
		selectedViewportId: selection.viewport,
		selectedThemeId: selection.theme,
	})
	return Object.freeze({ locale: options.locales.selected, viewportId: options.viewports.selectedId, themeId: options.themes.selected })
}
