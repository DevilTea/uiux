import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'

import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const response = await getSelectedWorkspaceServerRuntime().mcp.fetch(toWebRequest(event))
	return sendWebResponse(event, response)
})
