import { defineEventHandler, setResponseStatus } from 'h3'

import { restartKitBuildForHttp } from '../../../../src/server/authoring-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await restartKitBuildForHttp(requestSession(event))
	setResponseStatus(event, result.status)
	return result.body
})
