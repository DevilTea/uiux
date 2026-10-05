import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../src/server/request-session'
import { updateLocaleForHttp } from '../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const locale = getRouterParam(event, 'locale', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await updateLocaleForHttp(requestSession(event), locale, body)
	setResponseStatus(event, result.status)
	return result.body
})
