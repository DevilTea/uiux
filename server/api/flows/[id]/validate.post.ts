import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { requestSession } from '../../../../src/server/request-session'
import { validateFlowForHttp } from '../../../../src/server/flows-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const result = await validateFlowForHttp(requestSession(event), id)
	setResponseStatus(event, result.status)
	return result.body
})
