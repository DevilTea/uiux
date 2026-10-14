import { defineEventHandler, setResponseStatus } from 'h3'

import { listKitFilesForHttp } from '../../../src/server/kit-source-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await listKitFilesForHttp(requestSession(event))
	setResponseStatus(event, result.status)
	return result.body
})
