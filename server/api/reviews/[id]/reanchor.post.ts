import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../../src/server/request-session'
import { reanchorReviewThreadForHttp } from '../../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await reanchorReviewThreadForHttp(requestSession(event), id, body)
	setResponseStatus(event, result.status)
	return result.body
})
