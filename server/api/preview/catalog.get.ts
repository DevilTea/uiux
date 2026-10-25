import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { readSelectedWorkspaceWidgetCatalog } from '../../../src/server/widget-catalog'
import { denyUnlessAllowed } from '../../../src/server/access/http'

/** The active Adapters' Widget types with their declarations and Catalog entries (metadata only), for the Workbench's Catalog view. */
export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPreview')
	if (denied) return denied
	const workspaceRuntime = getSelectedWorkspaceServerRuntime()
	return await readSelectedWorkspaceWidgetCatalog(workspaceRuntime.root, workspaceRuntime.persistence.layout)
})
