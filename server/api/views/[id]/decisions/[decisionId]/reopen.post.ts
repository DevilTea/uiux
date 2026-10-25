import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../../../../src/server/request-session'
import { transitionDecisionForHttp } from '../../../../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const decisionId = getRouterParam(event, 'decisionId', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await transitionDecisionForHttp(requestSession(event), 'reopen', id, decisionId, body)
	setResponseStatus(event, result.status)
	return result.body
})
