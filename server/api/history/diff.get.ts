import { defineEventHandler, getQuery, setResponseHeader, setResponseStatus } from 'h3'

import { diffVersionsForHttp } from '../../../src/server/history-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await diffVersionsForHttp(requestSession(event), getQuery(event))
	setResponseStatus(event, result.status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	return result.body
})
