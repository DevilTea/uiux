import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { readArtifactForHttp } from '../../../src/server/authoring-http'
import { denyUnlessAllowed } from '../../../src/server/access/http'
import { setStoredContentHeaders } from '../../../src/server/stored-content-headers'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readArtifact')
	if (denied) return denied
	const digest = getRouterParam(event, 'digest', { decode: true }) ?? ''
	const runtime = getSelectedWorkspaceServerRuntime()
	const result = await readArtifactForHttp(runtime.persistence, digest)
	setResponseStatus(event, result.status)
	if (result.headers) setStoredContentHeaders(event, result.headers)
	if (result.status === 200 && result.body instanceof Uint8Array)
		return Buffer.from(result.body)
	return result.body
})
