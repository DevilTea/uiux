import { defineEventHandler, readBody, setResponseStatus } from 'h3'

import { updateAccessPresetsForHttp } from '../../../src/server/access-presets-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await updateAccessPresetsForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	return result.body
})
