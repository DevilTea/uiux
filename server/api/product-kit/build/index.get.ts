import { defineEventHandler, setResponseStatus } from 'h3'

import { readKitBuildForHttp } from '../../../../src/server/authoring-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler((event) => {
	const result = readKitBuildForHttp(requestSession(event))
	setResponseStatus(event, result.status)
	return result.body
})
