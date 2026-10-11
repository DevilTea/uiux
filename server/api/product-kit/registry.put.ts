import { defineEventHandler, readBody, setResponseStatus } from 'h3'

import { updateComponentRegistryForHttp } from '../../../src/server/authoring-http'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await updateComponentRegistryForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	return result.body
})
