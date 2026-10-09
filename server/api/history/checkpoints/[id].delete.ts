import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'

import { deleteCheckpointForHttp } from '../../../../src/server/history-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const result = await deleteCheckpointForHttp(requestSession(event), id)
	setResponseStatus(event, result.status)
	return result.body
})
