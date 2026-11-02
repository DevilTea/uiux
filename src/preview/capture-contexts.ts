import type { ResolvedRenderContext } from '../domain/render-context/schema'
import type { WorkspaceManifest } from '../domain/workspace/schema'
import { deriveRenderContextOptions, FALLBACK_THEME_ID } from './render-context-options'

/** What a capture selection is resolved against: the Workspace's registries and each View's Variant names. */
export type CaptureWorkspaceFacts = Readonly<{
	workspace?: WorkspaceManifest
	/** The Locales with a file in the Workspace (the default Locale is added). */
	locales: readonly string[]
	views: readonly Readonly<{ id: string; variants: readonly string[] }>[]
}>

/**
 * A capture selection: every View at its base context across every Locale, viewport preset and
 * theme (`all`), or the named Views across the named values of each dimension. An omitted
 * dimension takes the Workspace default. Variants are captured only when named (`variants`), in
 * addition to each View's base context.
 */
export type CaptureSelection =
	| Readonly<{ all: true }>
	| Readonly<{
		all?: false
		views: readonly string[]
		variants?: readonly string[]
		locales?: readonly string[]
		viewports?: readonly string[]
		themes?: readonly string[]
	}>

export type CaptureContextsResult =
	| Readonly<{ ok: true; contexts: readonly ResolvedRenderContext[] }>
	| Readonly<{ ok: false; message: string }>

const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))

/**
 * Resolves a capture selection into the explicit list of resolved render contexts a formal capture
 * runs (Rules 01a115cd-c3c9-76fd-8ccd-4a8664e52e7d and 01a115cd-c3fd-7e82-aa05-737aac6c4354). This
 * is the one place a convenience selection turns into a list: nothing expands it again. A name the
 * Workspace lacks (a View, a Variant of a selected View, a Locale, a viewport preset or a theme)
 * refuses the whole selection, naming it. `--all` order is stable: Views, Locales, viewports and
 * themes sorted by id; named values keep the order given, without duplicates.
 */
export function resolveCaptureContexts(facts: CaptureWorkspaceFacts, selection: CaptureSelection): CaptureContextsResult {
	const options = deriveRenderContextOptions({ ...(facts.workspace ? { workspace: facts.workspace } : {}), discoveredLocales: facts.locales })
	const localeIds = sortedUnique(options.locales.available)
	const viewports = [...options.viewports.available].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	const themeIds = options.themes.available.length ? sortedUnique(options.themes.available) : [FALLBACK_THEME_ID]
	const viewById = new Map(facts.views.map(view => [view.id, view]))

	const chosen = (names: readonly string[] | undefined, all: readonly string[], fallback: string, kind: string): readonly string[] | string => {
		if (names === undefined || names.length === 0) return [fallback]
		const unique = [...new Set(names)]
		const unknown = unique.find(name => !all.includes(name))
		return unknown === undefined ? unique : `The Workspace has no ${kind} ${JSON.stringify(unknown)}${all.length ? ` (it has ${all.join(', ')})` : ''}.`
	}

	let viewIds: readonly string[]
	let locales: readonly string[]
	let viewportIds: readonly string[]
	let themes: readonly string[]
	let variants: readonly string[] = []
	if (selection.all === true) {
		viewIds = sortedUnique(facts.views.map(view => view.id))
		locales = localeIds
		viewportIds = viewports.map(viewport => viewport.id)
		themes = themeIds
	}
	else {
		viewIds = [...new Set(selection.views)]
		const missingView = viewIds.find(id => !viewById.has(id))
		if (missingView !== undefined) return { ok: false, message: `The Workspace has no View ${JSON.stringify(missingView)}.` }
		const pickedLocales = chosen(selection.locales, localeIds, options.locales.defaultLocale, 'Locale')
		if (typeof pickedLocales === 'string') return { ok: false, message: pickedLocales }
		const pickedViewports = chosen(selection.viewports, viewports.map(viewport => viewport.id), options.viewports.available[0]!.id, 'viewport preset')
		if (typeof pickedViewports === 'string') return { ok: false, message: pickedViewports }
		const pickedThemes = chosen(selection.themes, themeIds, options.themes.available.length ? options.themes.selected : FALLBACK_THEME_ID, 'theme')
		if (typeof pickedThemes === 'string') return { ok: false, message: pickedThemes }
		locales = pickedLocales
		viewportIds = pickedViewports
		themes = pickedThemes
		variants = [...new Set(selection.variants ?? [])]
		for (const id of viewIds) {
			const missing = variants.find(name => !viewById.get(id)!.variants.includes(name))
			if (missing !== undefined) return { ok: false, message: `View ${JSON.stringify(id)} has no Variant ${JSON.stringify(missing)}.` }
		}
	}

	const contexts: ResolvedRenderContext[] = []
	for (const viewId of viewIds) {
		for (const locale of locales) {
			for (const viewportId of viewportIds) {
				const viewport = viewports.find(candidate => candidate.id === viewportId)!
				for (const themeId of themes) {
					const base: ResolvedRenderContext = { viewId, locale, viewportId, viewport: { width: viewport.width, height: viewport.height }, themeId }
					contexts.push(base)
					for (const variantName of variants) contexts.push({ ...base, variantName })
				}
			}
		}
	}
	return { ok: true, contexts }
}
