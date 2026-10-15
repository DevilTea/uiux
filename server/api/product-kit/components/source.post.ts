import { defineEventHandler, readBody, setResponseStatus } from 'h3'

import { getComponentSourceForHttp } from '../../../../src/server/kit-source-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const app = requestSession(event)
	// The key is checked before the body is read (getComponentSourceForHttp refuses again without it).
	const body = app.authorize('readKitSource') ? undefined : await readBody(event)
	const result = await getComponentSourceForHttp(app, body)
	setResponseStatus(event, result.status)
	return result.body
})
