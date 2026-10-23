import { defineEventHandler, getQuery, setResponseHeader, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { denyUnlessAllowed } from '../../../src/server/access/http'
import { resolvePreviewAssetsForHttp } from '../../../src/server/preview-assets-http'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPreview')
	if (denied) return denied
	const runtime = getSelectedWorkspaceServerRuntime()
	const result = await resolvePreviewAssetsForHttp(runtime.persistence, getQuery(event).ids)
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body
})
