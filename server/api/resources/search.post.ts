import { defineEventHandler, readBody, setResponseStatus } from 'h3'

import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { searchResourcesForHttp } from '../../../src/server/resource-discovery'

export default defineEventHandler(async (event) => {
	const result = await searchResourcesForHttp(getSelectedWorkspaceServerRuntime().app, await readBody(event))
	setResponseStatus(event, result.status)
	return result.body
})
