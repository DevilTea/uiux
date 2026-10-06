import type { DeclaredWidgetEvent, DeclaredWidgetEvents } from '../preview/browser-runtime'
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
export async function readSelectedWorkspaceDeclaredWidgetEvents(workspaceRoot: string): Promise<DeclaredWidgetEventsResult> {
	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRoot)
	if (bundle.state !== 'valid') return { state: 'unavailable' }
	if (cached?.hash === bundle.hash) return await cached.result
	const result = describe(bundle.bundleJs)
	cached = { hash: bundle.hash, result }
	return await result
}

async function describe(bundleJs: string): Promise<DeclaredWidgetEventsResult> {
	try {
		const url = `data:text/javascript;base64,${Buffer.from(bundleJs, 'utf8').toString('base64')}`
		const module = await import(/* @vite-ignore */ url) as { describeDeclaredWidgetEvents?: () => unknown }
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
