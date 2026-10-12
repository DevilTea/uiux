import { defineEventHandler, setResponseStatus } from 'h3'

import { readAccessPresetsForHttp } from '../../../src/server/access-presets-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const result = await readAccessPresetsForHttp(requestSession(event))
	setResponseStatus(event, result.status)
	return result.body
})
