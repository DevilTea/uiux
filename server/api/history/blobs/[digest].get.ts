import { defineEventHandler, getRouterParam, setResponseHeader, setResponseStatus } from 'h3'

import { readVersionBlobForHttp } from '../../../../src/server/history-http'
import { requestSession } from '../../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const digest = getRouterParam(event, 'digest', { decode: true }) ?? ''
	const result = await readVersionBlobForHttp(requestSession(event), digest)
	setResponseStatus(event, result.status)
	for (const [name, value] of Object.entries(result.headers ?? { 'Cache-Control': 'no-store' })) setResponseHeader(event, name, value)
	if (result.status === 200 && result.body instanceof Uint8Array) return Buffer.from(result.body)
	return result.body
})
