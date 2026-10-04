import { defineEventHandler, readBody, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../src/server/selected-workspace'
import { createAssetForHttp } from '../../src/server/authoring-http'

export default defineEventHandler(async (event) => {
	const body = await readBody(event)
	const result = await createAssetForHttp(getSelectedWorkspaceServerRuntime().app, body)
	setResponseStatus(event, result.status)
	return result.body
})
