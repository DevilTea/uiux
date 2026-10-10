import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'

import { readVersionBlobForHttp } from '../../../../src/server/history-http'
import { requestSession } from '../../../../src/server/request-session'
import { setStoredContentHeaders } from '../../../../src/server/stored-content-headers'

export default defineEventHandler(async (event) => {
	const digest = getRouterParam(event, 'digest', { decode: true }) ?? ''
	const result = await readVersionBlobForHttp(requestSession(event), digest)
	setResponseStatus(event, result.status)
	setStoredContentHeaders(event, result.headers ?? { 'Cache-Control': 'no-store' })
	if (result.status === 200 && result.body instanceof Uint8Array) return Buffer.from(result.body)
	return result.body
})
