import { defineEventHandler, readBody, setResponseHeader, setResponseStatus } from 'h3'

import { denyUnlessAllowed } from '../../../src/server/access/http'
import { requestSession } from '../../../src/server/request-session'
import { requestThumbnailsForHttp } from '../../../src/server/thumbnails-http'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'requestViewThumbnails')
	if (denied) return denied
	const result = await requestThumbnailsForHttp(requestSession(event), await readBody(event))
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body
})
