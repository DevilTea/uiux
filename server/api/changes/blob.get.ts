import { defineEventHandler, getQuery, setResponseStatus } from 'h3'

import { readChangeBlobForHttp } from '../../../src/server/changes-http'
import { requestSession } from '../../../src/server/request-session'
import { setStoredContentHeaders } from '../../../src/server/stored-content-headers'

export default defineEventHandler(async (event) => {
	const result = await readChangeBlobForHttp(requestSession(event), getQuery(event))
	setResponseStatus(event, result.status)
	setStoredContentHeaders(event, result.headers ?? { 'Cache-Control': 'no-store' })
	if (result.status === 200 && result.body instanceof Uint8Array) return Buffer.from(result.body)
	return result.body
})
