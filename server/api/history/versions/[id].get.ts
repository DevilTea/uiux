import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'

import { readVersionForHttp } from '../../../../src/server/history-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const result = await readVersionForHttp(requestSession(event), id)
	setResponseStatus(event, result.status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	return result.body
})
