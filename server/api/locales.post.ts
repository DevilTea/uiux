import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'
import { createLocaleForHttp } from '../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createLocaleForHttp(getSelectedWorkspaceServerRuntime().app, body)
	setResponseStatus(event, result.status)
	return result.body
})
