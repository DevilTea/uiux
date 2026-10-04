import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../../src/server/selected-workspace'
import { readAssetContentForHttp } from '../../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const runtime = getSelectedWorkspaceServerRuntime()
	const result = await readAssetContentForHttp(runtime.persistence, id)
	setResponseStatus(event, result.status)
	if (result.headers) {
		for (const [key, value] of Object.entries(result.headers)) {
			setResponseHeader(event, key, value)
		}
	}
	if (result.status === 200 && result.body instanceof Uint8Array)
		return Buffer.from(result.body)
	return result.body
})
