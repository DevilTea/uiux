import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../src/server/request-session'
import { createViewForHttp } from '../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createViewForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	return result.body
})
