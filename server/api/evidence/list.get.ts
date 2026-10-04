import { defineEventHandler, getQuery } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'

export default defineEventHandler(async (event) => {
	const query = getQuery(event)
	const viewId = typeof query.viewId === 'string' && query.viewId ? query.viewId : undefined
	const runtime = getSelectedWorkspaceServerRuntime()
	const items = await runtime.app.listEvidence(viewId)
	return { items }
})
