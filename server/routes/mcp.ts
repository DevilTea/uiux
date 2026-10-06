import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { defineEventHandler, sendWebResponse, toWebRequest } from 'h3'

import { sendAuthFailure } from '../../src/server/access/http'
import { LOOPBACK_HOSTNAMES } from '../../src/server/loopback-guard'
import { principalAuthInfo } from '../../src/mcp/server'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const request = toWebRequest(event)
	// The loopback guard plugin already enforces Host/Origin on every route. The SDK HTTP handler is
	// deliberately validation-free, so its own DNS-rebinding checks also stay directly in front of it.
	const rejected = hostHeaderValidationResponse(request, [...LOOPBACK_HOSTNAMES])
		?? originValidationResponse(request, [...LOOPBACK_HOSTNAMES])
	if (rejected) return sendWebResponse(event, rejected)
	// The access guard verified `Authorization: Bearer <token>` (cookies are ignored on /mcp) and
	// attached the member principal; it reaches the per-request server factory through authInfo.
	const principal = event.context.uiuxPrincipal
	if (!principal || principal.type !== 'member' || principal.credential !== 'token') {
		const access = await getSelectedWorkspaceServerRuntime().access()
		const result = await access.authenticate({ surface: 'mcp', authorization: event.node.req.headers.authorization, remoteAddress: event.node.req.socket?.remoteAddress, userAgent: event.node.req.headers['user-agent'] })
		if (!result.ok) return sendAuthFailure(event, result, { mcp: true })
		event.context.uiuxPrincipal = result.principal
	}
	const response = await getSelectedWorkspaceServerRuntime().mcp.fetch(request, { authInfo: principalAuthInfo(event.context.uiuxPrincipal!) })
	return sendWebResponse(event, response)
})
