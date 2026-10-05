import { defineEventHandler, getQuery } from 'h3'
import { requestSession } from '../../../src/server/request-session'

export default defineEventHandler(async (event) => {
	const query = getQuery(event)
	const viewId = typeof query.viewId === 'string' && query.viewId ? query.viewId : undefined
	const items = await requestSession(event).listEvidence(viewId)
	return { items }
})
