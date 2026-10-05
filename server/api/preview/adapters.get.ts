import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { resolveSelectedWorkspaceAdapters, getSelectedWorkspacePreviewBundle } from '../../../src/server/workspace-adapters'

export default defineEventHandler(async () => {
	const workspaceRuntime = getSelectedWorkspaceServerRuntime()
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRuntime.root)

	if (resolution.state === 'invalid') {
		return {
			state: 'invalid',
			diagnostics: resolution.diagnostics,
			summaries: resolution.summaries,
		}
	}

	const bundle = await getSelectedWorkspacePreviewBundle(workspaceRuntime.root)
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
