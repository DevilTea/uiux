import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const contexts = (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).contexts))
		? (body as { contexts: unknown[] }).contexts
		: []

	const result = await requestSession(event).captureFormalEvidence({
		contexts: contexts as never,
	})

	setResponseStatus(event, result.status === 'blocked' ? 403 : result.status === 'ok' ? 200 : result.status === 'incomplete' ? 207 : 422)
	return result
})
