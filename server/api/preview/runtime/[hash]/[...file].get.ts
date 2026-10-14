import { defineEventHandler, getRouterParam, setResponseStatus } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../../../src/server/selected-workspace'
import { readPreviewRuntimeFile } from '../../../../../src/server/preview-runtime-http'
import { denyUnlessAllowed } from '../../../../../src/server/access/http'
import { setStoredContentHeaders } from '../../../../../src/server/stored-content-headers'

/** A file of the Preview bundle: `/api/preview/runtime/<hash>/<file>`. */
export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPreview')
	if (denied) return denied
	const hash = getRouterParam(event, 'hash', { decode: true }) ?? ''
	const file = getRouterParam(event, 'file', { decode: true }) ?? ''
	const runtime = getSelectedWorkspaceServerRuntime()
	const result = await readPreviewRuntimeFile(runtime.root, runtime.persistence.layout, hash, file)
	setResponseStatus(event, result.status)
	if (result.status !== 200) return result.body
	setStoredContentHeaders(event, result.headers)
	return Buffer.from(result.file.contents)
})
