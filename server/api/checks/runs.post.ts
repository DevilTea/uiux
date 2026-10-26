import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../src/server/request-session'
import { recordChecksRunForHttp } from '../../../src/server/checks-http'

export default defineEventHandler(async (event) => {
	const result = await recordChecksRunForHttp(requestSession(event), await readBody(event))
	setResponseStatus(event, result.status)
	return result.body
})
