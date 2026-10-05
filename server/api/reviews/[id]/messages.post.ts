import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../../src/server/selected-workspace'
import { appendReviewMessageForHttp } from '../../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await appendReviewMessageForHttp(getSelectedWorkspaceServerRuntime().app, id, body)
	setResponseStatus(event, result.status)
	return result.body
})
