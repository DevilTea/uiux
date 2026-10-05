import { defineEventHandler, getRouterParam, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { updateLocaleForHttp } from '../../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const locale = getRouterParam(event, 'locale', { decode: true }) ?? ''
	const body = await readBody(event)
	const result = await updateLocaleForHttp(getSelectedWorkspaceServerRuntime().app, locale, body)
	setResponseStatus(event, result.status)
	return result.body
})
