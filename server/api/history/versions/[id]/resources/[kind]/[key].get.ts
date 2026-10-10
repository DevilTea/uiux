import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'

import { readVersionResourceForHttp } from '../../../../../../../src/server/history-http'
import { requestSession } from '../../../../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const kind = getRouterParam(event, 'kind', { decode: true }) ?? ''
	const key = getRouterParam(event, 'key', { decode: true }) ?? ''
	const result = await readVersionResourceForHttp(requestSession(event), id, kind, key)
	setResponseStatus(event, result.status)
	setResponseHeader(event, 'Cache-Control', 'no-store')
	return result.body
})
