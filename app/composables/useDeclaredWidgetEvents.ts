import { shallowRef } from 'vue'
import type { DeclaredWidgetEvent, DeclaredWidgetEvents } from '../../src/preview/browser-runtime'

type DeclaredWidgetEventsResponse =
	| Readonly<{ state: 'valid'; widgets: DeclaredWidgetEvents }>
	| Readonly<{ state: 'unavailable' }>

/** Shared across the Workbench: the selected Workspace's declared Events per Widget type. */
const catalog = shallowRef<DeclaredWidgetEvents | 'unavailable'>()
let pending: Promise<void> | undefined

/**
 * Each Widget type's declared Events (`inspectPlugin(plugin).events`, read from the Workspace's
 * Preview bundle), for the Flow editor's Event picker. Declaration metadata only: it observes no
 * Event and records nothing. Each use refreshes it in the background, so adapter edits show up.
 */
export function useDeclaredWidgetEvents() {
	function refresh(): void {
		if (pending) return
		pending = $fetch<DeclaredWidgetEventsResponse>('/api/preview/widget-events')
			.then((response) => { catalog.value = response.state === 'valid' ? response.widgets : 'unavailable' })
			.catch(() => { catalog.value ??= 'unavailable' })
			.finally(() => { pending = undefined })
	}
	refresh()

	/**
	 * The Events a Widget type declares: a list once the catalog is known (empty when the type
	 * declares none, like RootShell), undefined while it is loading or unavailable.
	 */
	function eventsOf(type: string | undefined): readonly DeclaredWidgetEvent[] | undefined {
		const value = catalog.value
		if (!value || value === 'unavailable' || !type) return undefined
		return value[type] ?? []
	}

	return { catalog, eventsOf, refresh }
}
