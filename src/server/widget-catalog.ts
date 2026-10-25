import type { WorkspaceLayout } from '../persistence/paths'
import type { WidgetCatalogResult } from './preview-adapter-check'
import { getSelectedWorkspacePreviewBundle } from './workspace-adapters'

export type { WidgetCatalogResult } from './preview-adapter-check'

/**
 * The active Adapters' Widget types with what each plugin declares and its Catalog entry, for the
 * Workbench's Catalog view (Discussion #241 owner ruling 2026-10-26). Read from the selected
 * Workspace's Preview bundle in the same one worker evaluation as the Adapter check and the declared
 * Events (#249); the main process never evaluates the bundle. A set invalid only by its checks still
 * lists its entries, so the view shows each problem against its entry; one that did not resolve or
 * whose bundle did not report has no list.
 */
export async function readSelectedWorkspaceWidgetCatalog(workspaceRoot: string, layout?: WorkspaceLayout): Promise<WidgetCatalogResult> {
	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRoot, layout)
	return bundle.state === 'valid' ? bundle.widgetCatalog : (bundle.widgetCatalog ?? { state: 'unavailable' })
}
