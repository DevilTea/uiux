import { hostHeaderValidationResponse, originValidationResponse } from '@modelcontextprotocol/server'
import { defineEventHandler, getRequestURL, getRequestWebStream, sendWebResponse, type H3Event } from 'h3'

import { sendAuthFailure } from '../../src/server/access/http'
import { getServerNetwork, LOOPBACK_HOSTNAMES } from '../../src/server/network-access'
import { principalAuthInfo } from '../../src/mcp/server'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'

/**
 * The Web Request handed to the SDK. Its URL is built on the origin the request gate matched,
 * never on `X-Forwarded-Host` or `X-Forwarded-Proto`, which h3's `toWebRequest` would trust (Rule
 * 01a12500-ba1c-7a07-8341-2a8b0691e8c5).
 */
function webRequest(event: H3Event): Request {
	const matched = event.context.uiuxOrigin?.origin
	const url = matched
		? new URL((event.node.req.originalUrl || event.path).replace(/^[/\\]+/gu, '/'), matched)
		: getRequestURL(event, { xForwardedHost: false, xForwardedProto: false })
	return new Request(url, { duplex: 'half', method: event.method, headers: event.headers, body: getRequestWebStream(event) } as RequestInit)
}

export default defineEventHandler(async (event) => {
	const request = webRequest(event)
	// The request gate plugin already enforces Host/Origin on every route, against the exact origin
	// the `Host` matched. The SDK HTTP handler is deliberately validation-free, so its own
	// (host-name-only) DNS-rebinding checks also stay directly in front of it, over the same allowlist.
	const hostnames = [...LOOPBACK_HOSTNAMES, ...getServerNetwork().origins.map(origin => origin.hostname)]
	const rejected = hostHeaderValidationResponse(request, hostnames)
		?? originValidationResponse(request, hostnames)
	if (rejected) return sendWebResponse(event, rejected)
	// The access guard verified `Authorization: Bearer <token>` (cookies are ignored on /mcp) and
	// attached the member principal; it reaches the per-request server factory through authInfo.
	const principal = event.context.uiuxPrincipal
	if (!principal || principal.type !== 'member' || principal.credential !== 'token') {
		const access = await getSelectedWorkspaceServerRuntime().access()
		const result = await access.authenticate({
			surface: 'mcp',
			authorization: event.node.req.headers.authorization,
			remoteAddress: event.node.req.socket?.remoteAddress,
			userAgent: event.node.req.headers['user-agent'],
			...(event.context.uiuxOrigin ? { origin: event.context.uiuxOrigin } : {}),
		})
		if (!result.ok) return sendAuthFailure(event, result, { mcp: true })
		event.context.uiuxPrincipal = result.principal
	}
	const response = await getSelectedWorkspaceServerRuntime().mcp.fetch(request, { authInfo: principalAuthInfo(event.context.uiuxPrincipal!) })
	return sendWebResponse(event, response)
})
