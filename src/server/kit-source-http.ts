import { z } from 'zod'

import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import { kitFileContent } from '../application/services/kit-source'
import { parseHttpPayload, type AuthoringHttpResult } from './authoring-http'

/**
 * The Workbench mirrors of the read-only kit source operations (Rule 01a11bb1-a184-7e00-a8de-c81056ad5a35):
 * `GET /api/product-kit/files` (`list_kit_files`), `GET /api/product-kit/file?path=` (the Resource
 * `uiux://product-kit/file/{path}`), `POST /api/product-kit/components/source` (`get_component_source`)
 * and `POST /api/product-kit/components/compare` (`compare_component_copies`). Each needs
 * `product-kit.source.read` (Clause 01a11bb1-b35a-7e69-bba5-978e3f47c4fa), checked before the request
 * is read, and answers with the body the MCP Tool returns: `auth.scope_denied` is 403, `not_found`
 * 404, an invalid path or input 400, and `kit.file_too_large` 422.
 */
const SUCCESS = new Set(['listed', 'found', 'compared'])

function httpStatus(result: Readonly<{ status: string; code?: unknown }>): number {
	if (result.code === 'auth.scope_denied') return 403
	if (SUCCESS.has(result.status)) return 200
	if (result.status === 'not_found') return 404
	if (result.status === 'invalid' || result.status === 'invalid_path') return 400
	return 422
}

function denied(app: ScopedWorkspaceSession): AuthoringHttpResult | undefined {
	const refusal = app.authorize('readKitSource')
	if (!refusal) return undefined
	return { status: 403, body: { status: 'blocked', key: 'product-kit', code: refusal.code, requiredKeys: refusal.requiredKeys, message: refusal.message, diagnostics: [{ code: refusal.code, path: '/', message: refusal.message }] } }
}

export async function listKitFilesForHttp(app: ScopedWorkspaceSession): Promise<AuthoringHttpResult> {
	const result = await app.listKitFiles()
	return { status: httpStatus(result), body: result }
}

/** One kit file as JSON: `{ status: "found", key, path, size, digest, content, encoding? }`, content as `get_component_source` gives it. */
export async function readKitFileForHttp(app: ScopedWorkspaceSession, path: unknown): Promise<AuthoringHttpResult> {
	const refused = denied(app)
	if (refused) return refused
	if (typeof path !== 'string')
		return { status: 400, body: { status: 'invalid_path', key: 'product-kit', message: 'Name one kit file with the query parameter path, relative to kit/.' } }
	const result = await app.readKitFile(path)
	if (result.status !== 'found') return { status: httpStatus(result), body: result }
	const { bytes, ...read } = result
	return { status: 200, body: { ...read, ...kitFileContent(bytes) } }
}

const getComponentSourceHttpSchema = z.object({ name: z.string(), withRequires: z.boolean().optional() }).strict()

export async function getComponentSourceForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const refused = denied(app)
	if (refused) return refused
	const parsed = parseHttpPayload(getComponentSourceHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.getComponentSource({ name: parsed.data.name, ...(parsed.data.withRequires === undefined ? {} : { withRequires: parsed.data.withRequires }) })
	return { status: httpStatus(result), body: result }
}

const compareComponentCopiesHttpSchema = z.object({
	copies: z.record(z.string(), z.object({
		target: z.string().optional(),
		componentDigest: z.string().optional(),
		exportedAt: z.string().optional(),
		files: z.record(z.string(), z.object({ source: z.string(), digest: z.string() }).strict()),
	}).strict()),
}).strict()

export async function compareComponentCopiesForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	const refused = denied(app)
	if (refused) return refused
	const parsed = parseHttpPayload(compareComponentCopiesHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.compareComponentCopies({ copies: parsed.data.copies })
	return { status: httpStatus(result), body: result }
}
