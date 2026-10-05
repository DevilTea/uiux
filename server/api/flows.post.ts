import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../src/server/request-session'
import { createFlowForHttp } from '../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createFlowForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	return result.body
})
