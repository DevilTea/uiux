import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../src/server/request-session'
import { captureInteractionEvidenceForHttp } from '../../../src/server/interactions-http'

export default defineEventHandler(async (event) => {
	const result = await captureInteractionEvidenceForHttp(requestSession(event), await readBody(event))
	setResponseStatus(event, result.status)
	return result.body
})
