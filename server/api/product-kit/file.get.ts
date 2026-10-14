import { defineEventHandler, getQuery, setResponseStatus } from 'h3'

import { readKitFileForHttp } from '../../../src/server/kit-source-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await readKitFileForHttp(requestSession(event), getQuery(event).path)
	setResponseStatus(event, result.status)
	return result.body
})
