import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../src/server/request-session'
import { createAssetForHttp } from '../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createAssetForHttp(requestSession(event), body)
	setResponseStatus(event, result.status)
	return result.body
})
