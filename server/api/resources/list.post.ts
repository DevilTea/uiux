import { defineEventHandler, readBody, setResponseStatus } from 'h3'

import { requestSession } from '../../../src/server/request-session'
import { listResourcesForHttp } from '../../../src/server/resource-discovery'

export default defineEventHandler(async (event) => {
	const result = await listResourcesForHttp(requestSession(event), await readBody(event))
	setResponseStatus(event, result.status)
	return result.body
})
