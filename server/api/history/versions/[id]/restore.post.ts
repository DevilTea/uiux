import { defineEventHandler, getRouterParam, readBody, setResponseHeader, setResponseStatus } from 'h3'

import { restoreResourceVersionForHttp } from '../../../../../src/server/history-http'
import { requestSession } from '../../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await restoreResourceVersionForHttp(requestSession(event), id, body)
	setResponseStatus(event, result.status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	return result.body
})
