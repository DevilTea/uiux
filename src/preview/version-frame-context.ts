import type { ViewResource } from '../domain/views/schema'
import type { WorkspaceManifest } from '../domain/workspace/schema'
import { DEFAULT_VIEWPORT, FALLBACK_THEME_ID, resolveDefaultLocale, resolveDefaultThemeId, resolveDefaultViewport } from './render-context-options'

/**
 * The render context one frame of a canvas comparison renders (Rules 01a11a5e-1288-7f86-a1cc-9b2fd0d2bd62
 * and 01a11a5e-1331-7e9e-a98d-5ff9b265b0e8): both frames take the canvas's current selection, and a
 * Variant, Locale, viewport or theme that one side does not have renders that side's base state or
 * default instead, with a notice. Shared by the Workbench (which shows the notices) and Preview's
 * read-only version mode (which applies the same fallback when it is opened on its own).
 */

/** The canvas's current selection, already resolved against the current Workspace. */
export type FrameContextSelection = Readonly<{
	variant?: string
	locale: string
	viewportId: string
	width: number
	height: number
	themeId: string
}>

/** What one side holds: its manifest, its View and the Locales it has files for. */
export type FrameSide = Readonly<{
	manifest?: Pick<WorkspaceManifest, 'i18n' | 'viewports' | 'themes'>
	view?: Pick<ViewResource, 'variants'>
	locales: readonly string[]
}>

export type FrameContextDimension = 'variant' | 'locale' | 'viewport' | 'theme'

/** A selected key this side does not have; `used` is what renders instead (`''` is the base state). */
export type FrameContextNotice = Readonly<{ dimension: FrameContextDimension; requested: string; used: string }>

export type FrameContext = Readonly<{
	context: FrameContextSelection
	notices: readonly FrameContextNotice[]
}>

export function resolveFrameContext(selection: FrameContextSelection, side: FrameSide): FrameContext {
	const notices: FrameContextNotice[] = []

	let variant = selection.variant || undefined
	if (variant && !Object.hasOwn(side.view?.variants ?? {}, variant)) {
		notices.push({ dimension: 'variant', requested: variant, used: '' })
		variant = undefined
	}

	const defaultLocale = resolveDefaultLocale(side.manifest)
	let locale = selection.locale || defaultLocale
	if (locale !== defaultLocale && !side.locales.includes(locale)) {
		notices.push({ dimension: 'locale', requested: locale, used: defaultLocale })
		locale = defaultLocale
	}

	const presets = side.manifest?.viewports ?? {}
	let viewportId = selection.viewportId
	let width = selection.width
	let height = selection.height
	const preset = Object.hasOwn(presets, viewportId) ? presets[viewportId] : undefined
	if (preset) {
		// The version's own dimensions for the preset: the viewport is the same, its size may not be.
		width = typeof preset.dimensions?.width === 'number' ? preset.dimensions.width : DEFAULT_VIEWPORT.width
		height = typeof preset.dimensions?.height === 'number' ? preset.dimensions.height : DEFAULT_VIEWPORT.height
	}
	else if (Object.keys(presets).length > 0 || viewportId !== DEFAULT_VIEWPORT.id) {
		const fallback = resolveDefaultViewport(side.manifest)
		notices.push({ dimension: 'viewport', requested: viewportId, used: fallback.id })
		viewportId = fallback.id
		width = fallback.width
		height = fallback.height
	}

	const themes = Object.keys(side.manifest?.themes ?? {})
	let themeId = selection.themeId
	if (themes.length > 0 ? !themes.includes(themeId) : themeId !== FALLBACK_THEME_ID) {
		const fallback = resolveDefaultThemeId(side.manifest)
		notices.push({ dimension: 'theme', requested: themeId, used: fallback })
		themeId = fallback
	}

	return {
		context: Object.freeze({ ...(variant ? { variant } : {}), locale, viewportId, width, height, themeId }),
		notices: Object.freeze(notices),
	}
}
