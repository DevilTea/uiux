import { defineEventHandler, setHeader, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { getSelectedWorkspacePreviewBundle } from '../../../src/server/workspace-adapters'

export default defineEventHandler(async (event) => {
	setHeader(event, 'content-type', 'text/javascript; charset=utf-8')
	setHeader(event, 'cache-control', 'no-store')

	const workspaceRuntime = getSelectedWorkspaceServerRuntime()
	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRuntime.root)

	if (bundle.state === 'invalid') {
		setResponseStatus(event, 409)
		return `throw new Error('Workspace adapters failed validation: ${JSON.stringify(bundle.diagnostics)}');`
	}

	return bundle.bundleJs
})
