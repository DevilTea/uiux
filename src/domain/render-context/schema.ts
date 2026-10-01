import {
	jsonPointer,
	isCanonicalLocaleTag,
	validateUuid,
	Validator,
	type ValidationResult,
} from '../validation'

export type ViewportDimensions = Readonly<{ width: number; height: number }>
export type ResolvedRenderContext = Readonly<{
	viewId: string
	variantName?: string
	locale: string
	viewportId: string
	viewport: ViewportDimensions
	themeId: string
}>

export type RenderContextRegistries = Readonly<{
	locales: ReadonlySet<string>
	viewports: Readonly<Record<string, ViewportDimensions>>
	themes: ReadonlySet<string>
	variantsByView?: ReadonlyMap<string, ReadonlySet<string>>
	themeIsCompatible?: (themeId: string) => boolean
}>

export function validateResolvedRenderContext(input: unknown, path = ''): ValidationResult<ResolvedRenderContext> {
	const v = new Validator()
	const context = v.object(input, path)
	if (!context) return v.finish<ResolvedRenderContext>(input)
	validateUuid(context.viewId, `${path}/viewId`, v, 'render-context viewId')
	if (Object.hasOwn(context, 'variantName')) v.string(context.variantName, `${path}/variantName`, true)
	validateCanonicalLocale(context.locale, `${path}/locale`, v)
	v.string(context.viewportId, `${path}/viewportId`, true)
	v.string(context.themeId, `${path}/themeId`, true)
	const viewport = v.object(context.viewport, `${path}/viewport`)
	if (viewport) {
		for (const dimension of ['width', 'height'] as const) {
			v.finiteNumber(viewport[dimension], `${path}/viewport/${dimension}`)
		}
	}
	return v.finish<ResolvedRenderContext>(input)
}

export function validateRenderContextSelection(
	input: unknown,
	registries?: RenderContextRegistries,
): ValidationResult<readonly ResolvedRenderContext[]> {
	const v = new Validator()
	const contexts = v.array(input, '')
	if (contexts && contexts.length === 0)
		v.issue('render_context.empty_selection', '', 'Formal execution uses an explicit list of resolved render contexts.')
	contexts?.forEach((candidate, index) => {
		const path = jsonPointer('', index)
		const result = validateResolvedRenderContext(candidate, path)
		v.diagnostics.push(...result.diagnostics)
		if (!registries || !result.ok) return
		const context = result.value
		if (!registries.locales.has(context.locale))
			v.issue('render_context.unknown_locale', `${path}/locale`, 'Requested locale is not available; no fallback is selected during context resolution.')
		const preset = registries.viewports[context.viewportId]
		if (!preset)
			v.issue('render_context.unknown_viewport', `${path}/viewportId`, 'Viewport preset identity does not exist.')
		else if (preset.width !== context.viewport.width || preset.height !== context.viewport.height)
			v.issue('render_context.viewport_snapshot_mismatch', `${path}/viewport`, 'Resolved numeric dimensions must match the selected Workspace viewport preset at resolution time.')
		if (!registries.themes.has(context.themeId))
			v.issue('render_context.unknown_theme', `${path}/themeId`, 'Theme identity does not exist; no fallback is selected.')
		else if (registries.themeIsCompatible && !registries.themeIsCompatible(context.themeId))
			v.issue('render_context.incompatible_theme', `${path}/themeId`, 'Selected theme is incompatible with the active Adapter set.')
		if (context.variantName !== undefined) {
			const variants = registries.variantsByView?.get(context.viewId)
			if (!variants?.has(context.variantName))
				v.issue('render_context.unknown_variant', `${path}/variantName`, 'Named Variant must exist on the referenced View.')
		}
	})
	return v.finish<readonly ResolvedRenderContext[]>(input)
}

function validateCanonicalLocale(value: unknown, path: string, v: Validator): void {
	if (!isCanonicalLocaleTag(value)) {
		v.issue('render_context.invalid_locale', path, 'Locale must be a canonical BCP 47 tag.')
	}
}
