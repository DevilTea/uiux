import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { resolveSelectedWorkspaceAdapters, getSelectedWorkspacePreviewBundle } from '../../../src/server/workspace-adapters'
import { denyUnlessAllowed } from '../../../src/server/access/http'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPreview')
	if (denied) return denied
	const workspaceRuntime = getSelectedWorkspaceServerRuntime()
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRuntime.root, workspaceRuntime.persistence.layout)

	if (resolution.state === 'invalid') {
		return {
			state: 'invalid',
			diagnostics: resolution.diagnostics,
			summaries: resolution.summaries,
		}
	}

	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRuntime.root, workspaceRuntime.persistence.layout)
	if (bundle.state === 'invalid') {
		return {
			state: 'invalid',
			diagnostics: bundle.diagnostics,
			summaries: resolution.summaries,
		}
	}

	return {
		state: 'valid',
		diagnostics: [],
		summaries: resolution.summaries,
		bundleUrl: `/api/preview/runtime?v=${bundle.hash}`,
	}
})
