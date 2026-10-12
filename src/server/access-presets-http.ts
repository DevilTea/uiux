import { z } from 'zod'

import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import { mapAuthoringResultToHttpStatus, parseHttpPayload, type AuthoringHttpResult } from './authoring-http'

/**
 * The Access presets on HTTP, their only transport (Rule 01a11c09-cbea-7341-9d5a-01719e9c5d94; MCP
 * offers no Tool or Resource for them):
 *
 * - `GET /api/access-presets` answers the Access presets resource `{ kind, key, resource, revision,
 *   diagnostics }`, needing `workspace.read` (Clause 01a11485-fa00-72da-bc46-98302a3c106e); 404
 *   below `schemaVersion` 6, where a Workspace keeps no presets file. From 6 a missing file answers
 *   200 with `resource` and `revision` `null` and `access.presets_missing` (Clause
 *   01a12f98-f466-7c86-af94-5887f1d1b50d).
 * - `PUT /api/access-presets` is `update_access_presets { expectedRevision, presets }` (Clause
 *   01a11c09-a50e-7531-b16e-74ba685c6bad), needing `presets.manage` (Clause
 *   01a11485-fa66-7cde-a10f-b8b796d01469), a `humanOnly` key that takes effect only on a human
 *   member's Workbench cookie session. An `expectedRevision` of `null` creates the missing file
 *   (201). The preset members are checked by the domain validator, so the transport checks only
 *   the request's outer shape.
 */
const updateAccessPresetsHttpSchema = z.object({
	expectedRevision: z.string().nullable(),
	presets: z.array(z.unknown()),
}).strict()

function resultCode(result: { status: string }): string | undefined {
	const code = (result as { code?: unknown }).code
	return typeof code === 'string' ? code : undefined
}

export async function readAccessPresetsForHttp(app: ScopedWorkspaceSession): Promise<AuthoringHttpResult> {
	const denied = app.authorize('readAccessPresets')
	if (denied) return { status: 403, body: { status: 'blocked', key: 'access-presets', code: denied.code, requiredKeys: denied.requiredKeys, message: denied.message, diagnostics: [{ code: denied.code, path: '/', message: denied.message }] } }
	const read = await app.readAccessPresets()
	if (!read) return { status: 404, body: { status: 'not_found', key: 'access-presets' } }
	return { status: 200, body: read }
}

export async function updateAccessPresetsForHttp(app: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult> {
	// The permission check comes before the body is examined, so a caller without the key learns nothing from it.
	const denied = app.authorize('updateAccessPresets')
	if (denied) return { status: 403, body: { status: 'blocked', key: 'access-presets', code: denied.code, requiredKeys: denied.requiredKeys, message: denied.message, diagnostics: [{ code: denied.code, path: '/', message: denied.message }] } }
	const parsed = parseHttpPayload(updateAccessPresetsHttpSchema, body)
	if (!parsed.ok) return parsed.result
	const result = await app.updateAccessPresets(parsed.data)
	return { status: mapAuthoringResultToHttpStatus(result.status, resultCode(result)), body: result }
}
