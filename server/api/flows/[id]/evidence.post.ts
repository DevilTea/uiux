import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../../src/server/request-session'
import { captureFlowEvidenceForHttp } from '../../../../src/server/flows-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const result = await captureFlowEvidenceForHttp(requestSession(event), id, await readBody(event))
	setResponseStatus(event, result.status)
	return result.body
})
