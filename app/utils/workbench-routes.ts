import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import type { ViewPanelTab, ViewRouteContext } from '../composables/workbench-types'

/**
 * The Workbench route and deep-link contract (brief a, section 5).
 *
 * Render context rides in the query so a link reproduces exactly what its author saw.
 * Workbench chrome language and theme never ride in the URL.
 */
export const VIEW_PANEL_TABS: readonly ViewPanelTab[] = ['comments', 'inspect', 'spec', 'readiness']

export type ViewLinkOptions = Partial<ViewRouteContext> & Readonly<{ thread?: string; panel?: ViewPanelTab }>

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
