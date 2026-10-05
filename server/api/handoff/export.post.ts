import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const runtime = getSelectedWorkspaceServerRuntime()
	const roots = (body && typeof body === 'object' && Array.isArray((body as Record<string, unknown>).roots))
		? (body as { roots: unknown[] }).roots
		: []

	const result = await runtime.app.exportHandoff({ roots: roots as never })
	setResponseStatus(event, result.status === 'exported' ? 200 : 422)
	return result
})
