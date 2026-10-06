import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const roots = (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).roots))
		? (body as { roots: unknown[] }).roots
		: []

	const result = await requestSession(event).exportHandoff({ roots: roots as never })
	// `auth.scope_denied` is 403; a schema block (`workspace.migration_required`) and a failed closure are 422.
	const code = 'code' in result ? result.code : undefined
	setResponseStatus(event, code === 'auth.scope_denied' ? 403 : result.status === 'exported' ? 200 : 422)
	return result
})
