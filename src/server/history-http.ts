import { z } from 'zod'

import type { AccessRefusal, ScopedWorkspaceSession } from '../application/access/scoped-session'
import { isFullUuid } from '../domain/validation'
import { VERSION_DIFF_DETAILS, type DiffVersionsCommand, type VersionDiffOutcome } from '../application/services/history-diff'
import type { AuthoringHttpResult } from './authoring-http'

/**
 * `GET /api/history/diff` (named by Clause 01a11485-fa00-72da-bc46-98302a3c106e; there is no HTTP
 * Contract, so the query shape is implementation-defined). It takes the arguments of the MCP tool
 * `get_version_diff` as query parameters and answers the same object the tool returns:
 *
 * - `from`: a version ID, or `parent` to compare the `to` version with its parent, the predecessor
 *   on the merged timeline (the Workbench "compare with parent");
 * - `to`: a version ID or `current` (the default; required with `from=parent`);
 * - `resource`: repeated, each `<kind>:<key>` (split at the first colon);
 * - `detail`: `summary` (the default) or `semantic`.
 */
const diffQuerySchema = z.object({
	from: z.string().min(1),
	to: z.string().min(1).optional(),
	resource: z.union([z.string(), z.array(z.string())]).optional(),
	detail: z.enum(VERSION_DIFF_DETAILS).optional(),
}).strict()

export const PARENT_VERSION_SELECTOR = 'parent'

export async function diffVersionsForHttp(session: ScopedWorkspaceSession, query: unknown): Promise<AuthoringHttpResult<VersionDiffOutcome | AccessRefusal | Readonly<Record<string, unknown>>>> {
	const parsed = diffQuerySchema.safeParse(query)
	if (!parsed.success) {
		return invalid(parsed.error.issues.map(issue => ({
			code: 'transport.malformed_payload',
			path: issue.path.length > 0 ? `/${issue.path.join('/')}` : '/',
			message: issue.message,
		})))
	}
	const { from, to, resource, detail } = parsed.data
	const resources: { kind: string; key: string }[] = []
	for (const [index, value] of (resource === undefined ? [] : [resource].flat()).entries()) {
		const separator = value.indexOf(':')
		if (separator <= 0 || separator === value.length - 1)
			return invalid([{ code: 'transport.malformed_payload', path: `/resource/${index}`, message: 'Each resource is <kind>:<key>.' }])
		resources.push({ kind: value.slice(0, separator), key: value.slice(separator + 1) })
	}
	if (from === PARENT_VERSION_SELECTOR && (to === undefined || !isFullUuid(to)))
		return invalid([{ code: 'transport.malformed_payload', path: '/to', message: 'A comparison with the parent (from=parent) needs a version ID in to.' }])
	const command: DiffVersionsCommand = {
		from: from === PARENT_VERSION_SELECTOR ? { parentOf: to! } : from,
		...(to === undefined ? {} : { to }),
		...(resource === undefined ? {} : { resources }),
		...(detail === undefined ? {} : { detail }),
	}
	const outcome = await session.diffVersions(command)
	return { status: diffHttpStatus(outcome), body: outcome }
}

export function diffHttpStatus(outcome: VersionDiffOutcome | AccessRefusal): number {
	if (outcome.status === 'compared') return 200
	if (outcome.code === 'auth.scope_denied') return 403
	switch (outcome.status) {
		case 'invalid': return 400
		case 'not_found': return 404
		case 'blocked': return 422
		default: return 500
	}
}

function invalid(diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[]): AuthoringHttpResult<Readonly<Record<string, unknown>>> {
	return { status: 400, body: { status: 'invalid', code: 'malformed_payload', message: 'Request query failed structural validation.', diagnostics } }
}
