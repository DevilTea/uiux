import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'

import { getSelectedWorkspaceServerRuntime } from '../../../../src/server/selected-workspace'
import { readPointResourceForHttp } from '../../../../src/server/point-resource'

export default defineEventHandler(async (event) => {
	const kind = getRouterParam(event, 'kind', { decode: true }) ?? ''
	const key = getRouterParam(event, 'key', { decode: true }) ?? ''
	const result = await readPointResourceForHttp(getSelectedWorkspaceServerRuntime().app, kind, key)
	setResponseStatus(event, result.status)
	return result.body
})
