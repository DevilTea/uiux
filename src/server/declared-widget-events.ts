import type { WorkspaceLayout } from '../persistence/paths'
import type { DeclaredWidgetEventsResult } from './preview-adapter-check'
import { getSelectedWorkspacePreviewBundle } from './workspace-adapters'

export type { DeclaredWidgetEventsResult } from './preview-adapter-check'

/**
 * Each adapter Widget type's declared Events, for the Flow editor's Event picker. Declaration
 * metadata only (`inspectPlugin(plugin).events`), from the selected Workspace's Preview bundle: the
 * bundle aliases widget-core to one authoritative copy, so the plugin brand check holds even when
 * the Workspace resolves its own widget-core. The server's worker reads them in the same one
 * evaluation of the bundle as the Adapter check (`evaluatePreviewBundle`); the main process never
 * evaluates the bundle (#249). No Runtime is created and nothing is persisted.
 */
export async function readSelectedWorkspaceDeclaredWidgetEvents(workspaceRoot: string, layout?: WorkspaceLayout): Promise<DeclaredWidgetEventsResult> {
	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRoot, layout)
	return bundle.state === 'valid' ? bundle.declaredWidgetEvents : { state: 'unavailable' }
}
