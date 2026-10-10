import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { readSelectedWorkspaceDeclaredWidgetEvents } from '../../../src/server/declared-widget-events'
import { denyUnlessAllowed } from '../../../src/server/access/http'

/** Declared Widget Events per adapter Widget type (metadata only), for the Flow editor's Event picker. */
export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPreview')
	if (denied) return denied
	const workspaceRuntime = getSelectedWorkspaceServerRuntime()
	return await readSelectedWorkspaceDeclaredWidgetEvents(workspaceRuntime.root, workspaceRuntime.persistence.layout)
})
