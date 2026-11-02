import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'

import { denyUnlessAllowed } from '../../../../src/server/access/http'
import { requestSession } from '../../../../src/server/request-session'
import { readThumbnailForHttp } from '../../../../src/server/thumbnails-http'

export default defineEventHandler(async (event) => {
	// `workspace.read` and no other key (Clause 01a19bb9-8f1f-7482-b6fd-f131a284178e): refused with 403 before anything is read.
	const denied = denyUnlessAllowed(event, 'readViewThumbnail')
	if (denied) return denied
	const result = await readThumbnailForHttp(requestSession(event), getRouterParam(event, 'id', { decode: true }) ?? '')
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body instanceof Uint8Array ? Buffer.from(result.body) : result.body
})
