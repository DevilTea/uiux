import { defineEventHandler, getQuery, setResponseHeader, setResponseStatus } from 'h3'

import { readChangeDiffForHttp } from '../../../src/server/changes-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await readChangeDiffForHttp(requestSession(event), getQuery(event))
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? {})) setResponseHeader(event, name, value)
	return result.body
})
