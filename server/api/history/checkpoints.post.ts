import { defineEventHandler, readBody, setResponseHeader, setResponseStatus } from 'h3'

import { createCheckpointForHttp } from '../../../src/server/history-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createCheckpointForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body
})
