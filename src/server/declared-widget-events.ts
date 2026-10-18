import type { WorkspaceLayout } from '../persistence/paths'
import type { DeclaredWidgetEvent, DeclaredWidgetEvents } from '../preview/browser-runtime'
import { evaluatePreviewBundle } from './preview-adapter-check'
import { getSelectedWorkspacePreviewBundle } from './workspace-adapters'

export type DeclaredWidgetEventsResult =
	| Readonly<{ state: 'valid'; widgets: DeclaredWidgetEvents }>
	| Readonly<{ state: 'unavailable' }>

let cached: { hash: string; result: Promise<DeclaredWidgetEventsResult> } | undefined

/**
 * Each adapter Widget type's declared Events, for the Flow editor's Event picker. Declaration
 * metadata only (`inspectPlugin(plugin).events`), read from the selected Workspace's Preview bundle:
 * the bundle aliases widget-core to one authoritative copy, so the plugin brand check holds even
 * when the Workspace resolves its own widget-core. No Runtime is created and nothing is persisted.
 */
export async function readSelectedWorkspaceDeclaredWidgetEvents(workspaceRoot: string, layout?: WorkspaceLayout): Promise<DeclaredWidgetEventsResult> {
	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRoot, layout)
	if (bundle.state !== 'valid') return { state: 'unavailable' }
	if (cached?.hash === bundle.hash) return await cached.result
	const result = describe(bundle)
	cached = { hash: bundle.hash, result }
	return await result
}

async function describe(bundle: Parameters<typeof evaluatePreviewBundle>[0]): Promise<DeclaredWidgetEventsResult> {
	try {
		// The module the server-side Adapter check evaluated (`preview-adapter-check.ts`).
		const module = await evaluatePreviewBundle(bundle)
		const widgets = module.describeDeclaredWidgetEvents?.()
		return isDeclaredWidgetEvents(widgets) ? { state: 'valid', widgets } : { state: 'unavailable' }
	}
	catch {
		return { state: 'unavailable' }
	}
}

function isDeclaredWidgetEvents(value: unknown): value is DeclaredWidgetEvents {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	return Object.values(value).every(list => Array.isArray(list) && list.every(isDeclaredEvent))
}

function isDeclaredEvent(value: unknown): value is DeclaredWidgetEvent {
	return !!value && typeof value === 'object'
		&& typeof (value as DeclaredWidgetEvent).name === 'string'
		&& typeof (value as DeclaredWidgetEvent).description === 'string'
}
