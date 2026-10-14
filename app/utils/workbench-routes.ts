import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { ViewPanelTab, ViewRouteContext } from '../composables/workbench-types'
import { historyQuery, type HistoryAddress } from './version-history'

/**
 * The Workbench route and deep-link contract (brief a, section 5).
 *
 * Render context rides in the query so a link reproduces exactly what its author saw.
 * Workbench chrome language and theme never ride in the URL.
 */
export const VIEW_PANEL_TABS: readonly ViewPanelTab[] = ['comments', 'inspect', 'spec', 'readiness', 'history']

/**
 * `history` is the history panel's selection (Clause 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41):
 * `version`, `compare` and `canvas`, carried only with `panel=history`.
 */
export type ViewLinkOptions = Partial<ViewRouteContext> & Readonly<{ thread?: string; panel?: ViewPanelTab; history?: HistoryAddress }>

function single(value: LocationQuery[string] | undefined): string {
	const first = Array.isArray(value) ? value[0] : value
	return typeof first === 'string' ? first : ''
}

export function viewPath(viewId: string): string {
	return `/views/${encodeURIComponent(viewId)}`
}

export function flowPath(flowId: string): string {
	return `/flows/${encodeURIComponent(flowId)}`
}

/** The one list of every View: the Overview's Views tab (`/views` redirects here). */
export const VIEWS_LOCATION = { path: '/', query: { tab: 'views' } } as const

/**
 * The sections of the Product Kit page (Clause 01a11be8-5cab-7e50-89fe-b89c243d773d) that this build
 * has. Components, Styles & themes and Files are not built yet (issue #141), so their `section`
 * values open the page at its top, like an unknown value.
 */
export type ProductKitSectionId = 'overview'
export const PRODUCT_KIT_SECTIONS: readonly ProductKitSectionId[] = ['overview']
export const PRODUCT_KIT_PATH = '/workspace/product-kit'

/** The section a `section` query names, if this build has it. */
export function parseProductKitSection(query: LocationQuery): ProductKitSectionId | undefined {
	const value = single(query.section)
	return (PRODUCT_KIT_SECTIONS as readonly string[]).includes(value) ? value as ProductKitSectionId : undefined
}

/** The fragment of the Adapters block, inside the Overview section of the Product Kit page. */
export const ADAPTERS_HASH = '#product-kit-adapters'

/**
 * Adapters: the Overview section of the Product Kit page (Rule 01a116f0-8a46-76bc-a29f-affaa302c44c),
 * scrolled to the Adapters block. `/workspace/adapters` and `/workspace/settings?section=adapters`
 * redirect here (Clause 01a116f0-9739-754b-b024-346b1c16a866).
 */
export const ADAPTERS_LOCATION = { path: PRODUCT_KIT_PATH, query: { section: 'overview' }, hash: ADAPTERS_HASH } as const

/** Builds the query for a View deep link; empty values mean "the effective default" and are omitted. */
export function viewQuery(options: ViewLinkOptions): LocationQueryRaw {
	const query: LocationQueryRaw = {}
	if (options.variant) query.variant = options.variant
	if (options.locale) query.locale = options.locale
	if (options.viewport) query.viewport = options.viewport
	if (options.theme) query.theme = options.theme
	if (options.widget && options.widget !== 'root') query.widget = options.widget
	if (options.thread) query.thread = options.thread
	if (options.panel) query.panel = options.panel
	if (options.panel === 'history' && options.history) Object.assign(query, historyQuery(options.history, ['version', 'compare', 'canvas']))
	return query
}

export function viewLocation(viewId: string, options: ViewLinkOptions = {}) {
	return { path: viewPath(viewId), query: viewQuery(options) }
}

export function parseViewRouteContext(query: LocationQuery): ViewRouteContext {
	return {
		variant: single(query.variant),
		locale: single(query.locale),
		viewport: single(query.viewport),
		theme: single(query.theme),
		widget: single(query.widget) || 'root',
	}
}

export function parseViewPanel(query: LocationQuery): ViewPanelTab | undefined {
	const value = single(query.panel)
	return (VIEW_PANEL_TABS as readonly string[]).includes(value) ? value as ViewPanelTab : undefined
}

export function parseThread(query: LocationQuery): string | undefined {
	return single(query.thread) || undefined
}

/** True when two queries carry the same values (order-insensitive, empty values ignored). */
export function sameQuery(a: LocationQueryRaw | LocationQuery, b: LocationQueryRaw | LocationQuery): boolean {
	const normalize = (query: LocationQueryRaw | LocationQuery) => Object.entries(query)
		.map(([key, value]) => [key, Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '')] as const)
		.filter(([, value]) => value !== '')
		.sort(([left], [right]) => left.localeCompare(right))
	return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b))
}
