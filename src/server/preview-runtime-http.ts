import type { Diagnostic } from '../domain/validation'
import type { WorkspaceLayout } from '../persistence/paths'
import { cachedPreviewBundle, type PreviewBundleFile } from './preview-bundler'
import { STORED_CONTENT_SECURITY_POLICY } from './stored-content-headers'
import { getSelectedWorkspacePreviewBundle } from './workspace-adapters'

export type PreviewRuntimeFileResult =
	| Readonly<{ status: 200; file: PreviewBundleFile; headers: Readonly<Record<string, string>> }>
	| Readonly<{ status: 404; body: Readonly<{ error: string }> }>
	| Readonly<{ status: 409; body: Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }> }>

/** The media types a Preview document loads as code or as its stylesheet; every other file is an asset. */
const LOADED_TYPES = ['text/javascript', 'text/css', 'application/json']

/**
 * One file of the selected Workspace's Preview bundle, `/api/preview/runtime/<hash>/<file>`: the
 * JavaScript module, its stylesheet, an emitted font or image, or a source map. A bundle already
 * built is served by its content hash; otherwise the current bundle is built, and a hash that is not
 * its own names nothing.
 */
export async function readPreviewRuntimeFile(workspaceRoot: string, layout: WorkspaceLayout | undefined, hash: string, file: string): Promise<PreviewRuntimeFileResult> {
	let bundle = await cachedPreviewBundle(hash)
	if (!bundle) {
		const current = await getSelectedWorkspacePreviewBundle(workspaceRoot, layout)
		if (current.state === 'invalid') return { status: 409, body: { state: 'invalid', diagnostics: current.diagnostics } }
		if (current.hash === hash) bundle = current
	}
	const served = bundle?.files.get(file)
	if (!served) return { status: 404, body: { error: 'preview_runtime_file_not_found' } }
	const essence = served.contentType.split(';', 1)[0]!.trim()
	return {
		status: 200,
		file: served,
		headers: {
			'Content-Type': served.contentType,
			'Cache-Control': 'no-store',
			'X-Content-Type-Options': 'nosniff',
			// An asset opened as a document of its own (an SVG, say) runs no script on this origin.
			...(LOADED_TYPES.includes(essence) ? {} : { 'Content-Security-Policy': STORED_CONTENT_SECURITY_POLICY }),
		},
	}
}
