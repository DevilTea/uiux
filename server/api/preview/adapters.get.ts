import { defineEventHandler } from 'h3'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { resolveSelectedWorkspaceAdapters, getSelectedWorkspacePreviewBundle } from '../../../src/server/workspace-adapters'
import { PREVIEW_BUNDLE_ENTRY, previewRuntimeFileUrl } from '../../../src/server/preview-bundler'
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
		bundleUrl: previewRuntimeFileUrl(bundle.hash, PREVIEW_BUNDLE_ENTRY),
		// The Product Kit stylesheet a construction links first (Rule 01a11a5a-4d38-7f2c-98be-755d8c404d98).
		...(bundle.stylesheet ? { stylesheetUrl: previewRuntimeFileUrl(bundle.hash, bundle.stylesheet) } : {}),
		// The Product Kit themes' root attributes (Rule 01a11bb1-ada4-7dd7-b3da-733de7a85df4).
		themes: bundle.themes,
		// The server-side Adapter check could not run on the bundle; the Preview's guard decides (Clause 01a116f0-cae2-7c64-9c76-d472f252789a).
		...(bundle.warnings.length > 0 ? { warnings: bundle.warnings } : {}),
	}
})
