import { defineEventHandler, getQuery, setResponseHeader, setResponseStatus } from 'h3'

import { denyUnlessAllowed } from '../../src/server/access/http'
import { requestSession } from '../../src/server/request-session'
import { listThumbnailsForHttp } from '../../src/server/thumbnails-http'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'listViewThumbnails')
	if (denied) return denied
	const result = await listThumbnailsForHttp(requestSession(event), getQuery(event).keys)
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body
})
