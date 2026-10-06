import { defineEventHandler, getQuery, setResponseStatus } from 'h3'
import {
	createPublicationSnapshot,
	sanitizePublicationAdapterDiagnostic,
	type PublicationPreviewInput,
} from '../../../src/application/services/publication-snapshot'
import { getSelectedWorkspaceServerRuntime } from '../../../src/server/selected-workspace'
import { getSelectedWorkspacePreviewBundle } from '../../../src/server/workspace-adapters'
import { computePublishedPreviewHash } from '../../../src/server/preview-bundler'
import { denyUnlessAllowed } from '../../../src/server/access/http'

export default defineEventHandler(async (event) => {
	const denied = denyUnlessAllowed(event, 'readPublicationSnapshot')
	if (denied) return denied
	const runtime = getSelectedWorkspaceServerRuntime()
	const bundle = await getSelectedWorkspacePreviewBundle(runtime.root)
	const preview: PublicationPreviewInput = bundle.state === 'valid'
		? { state: 'valid', hash: computePublishedPreviewHash(bundle.bundleJs) }
		: {
				state: 'invalid',
				diagnostics: bundle.diagnostics.map(sanitizePublicationAdapterDiagnostic),
			}

	const query = getQuery(event)
	const sourceRevision = typeof query.sourceRevision === 'string' && query.sourceRevision.trim()
		? query.sourceRevision.trim()
		: undefined

	try {
		return await createPublicationSnapshot(runtime.app, preview, { sourceRevision })
	}
	catch (cause) {
		setResponseStatus(event, 422)
		return {
			code: 'publication.snapshot_failed',
			message: cause instanceof Error ? cause.message : 'Publication snapshot could not be created.',
		}
	}
})
