import { defineEventHandler, getQuery, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'

import { resolveVersionAssetsForHttp } from '../../../../../src/server/history-http'
import { requestSession } from '../../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const result = await resolveVersionAssetsForHttp(requestSession(event), id, getQuery(event).ids)
	setResponseStatus(event, result.status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	return result.body
})
