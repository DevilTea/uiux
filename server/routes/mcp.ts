import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'

import { LOOPBACK_HOSTNAMES } from '../../src/server/loopback-guard'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const request = toWebRequest(event)
	// The loopback guard plugin already enforces Host/Origin on every route. The SDK HTTP handler is
	// deliberately validation-free, so its own DNS-rebinding checks also stay directly in front of it.
	const rejected = hostHeaderValidationResponse(request, [...LOOPBACK_HOSTNAMES])
		?? originValidationResponse(request, [...LOOPBACK_HOSTNAMES])
	if (rejected) return sendWebResponse(event, rejected)
	const response = await getSelectedWorkspaceServerRuntime().mcp.fetch(request)
	return sendWebResponse(event, response)
})
