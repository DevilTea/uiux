import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const runtime = getSelectedWorkspaceServerRuntime()
	const contexts = (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).contexts))
		? (body as { contexts: unknown[] }).contexts
		: []

	const result = await runtime.app.captureFormalEvidence({
		contexts: contexts as never,
	})

	setResponseStatus(event, result.status === 'ok' ? 200 : result.status === 'incomplete' ? 207 : 422)
	return result
})
