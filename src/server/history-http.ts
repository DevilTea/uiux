import { z } from 'zod'

import type { AccessRefusal, ScopedWorkspaceSession } from '../application/access/scoped-session'
import { isFullUuid } from '../domain/validation'
import { VERSION_DIFF_DETAILS, type DiffVersionsCommand, type VersionDiffOutcome } from '../application/services/history-diff'
import type { CreateCheckpointOutcome, DeleteCheckpointOutcome, ListVersionsOutcome, ReadVersionOutcome } from '../application/services/history-service'
import type { HistoryVersionType } from '../domain/history/constants'
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

/**
 * `GET /api/history/versions` (Clause 01a11485-fa00-72da-bc46-98302a3c106e; the query shape is
 * implementation-defined). It takes the arguments of the MCP tool `list_versions` as query
 * parameters, plus the Workbench's actor filter, and answers the object the tool returns:
 *
 * - `type`: repeated, each `autosave`, `checkpoint`, `external` or `system`;
 * - `resource`: `<kind>:<key>` (split at the first colon), the per-resource projection;
 * - `actor`: an actor ID (`member:<id>`, `system:migrate`, `system:baseline`) or `external`;
 * - `limit`: 1 to 200 (default 50); `cursor`: the `nextCursor` of the previous page.
 */
const listVersionsQuerySchema = z.object({
	type: z.union([z.string(), z.array(z.string())]).optional(),
	resource: z.string().optional(),
	actor: z.string().min(1).optional(),
	limit: z.string().regex(/^[1-9]\d{0,3}$/u, 'limit is a positive integer.').optional(),
	cursor: z.string().min(1).optional(),
}).strict()

export async function listVersionsForHttp(session: ScopedWorkspaceSession, query: unknown): Promise<AuthoringHttpResult<ListVersionsOutcome | AccessRefusal | Readonly<Record<string, unknown>>>> {
	const parsed = listVersionsQuerySchema.safeParse(query)
	if (!parsed.success) return invalid(zodDiagnostics(parsed.error.issues))
	const { type, resource, actor, limit, cursor } = parsed.data
	let identity: { kind: string; key: string } | undefined
	if (resource !== undefined) {
		identity = parseResourceParameter(resource)
		if (!identity) return invalid([{ code: 'transport.malformed_payload', path: '/resource', message: 'resource is <kind>:<key>.' }])
	}
	const outcome = await session.listVersions({
		...(type === undefined ? {} : { types: [type].flat() as HistoryVersionType[] }),
		...(identity ? { resource: identity } : {}),
		...(actor === undefined ? {} : { actor }),
		...(limit === undefined ? {} : { limit: Number(limit) }),
		...(cursor === undefined ? {} : { cursor }),
	})
	return historyHttpResult(outcome)
}

/** `GET /api/history/versions/:id`: the record the version Resource holds, plus its merged-timeline parent. */
export async function readVersionForHttp(session: ScopedWorkspaceSession, id: string): Promise<AuthoringHttpResult<ReadVersionOutcome | AccessRefusal>> {
	return historyHttpResult(await session.readVersion(id))
}

const createCheckpointBodySchema = z.object({
	name: z.string(),
	note: z.string().optional(),
}).strict()

/** `POST /api/history/checkpoints` `{ name, note? }`, answering what `create_checkpoint` returns (Clause 01a11a5e-265d-7f71-80a3-5dae7f788ae1). */
export async function createCheckpointForHttp(session: ScopedWorkspaceSession, body: unknown): Promise<AuthoringHttpResult<CreateCheckpointOutcome | AccessRefusal | Readonly<Record<string, unknown>>>> {
	const parsed = createCheckpointBodySchema.safeParse(body)
	if (!parsed.success) return invalid(zodDiagnostics(parsed.error.issues), 'Request body failed structural validation.')
	return historyHttpResult(await session.createCheckpoint({ name: parsed.data.name, ...(parsed.data.note === undefined ? {} : { note: parsed.data.note }) }))
}

/** `DELETE /api/history/checkpoints/:id`: removes the record only. There is no route that changes a Checkpoint (Rule 01a11a5e-09bb-755c-9253-3cbff9f65da9). */
export async function deleteCheckpointForHttp(session: ScopedWorkspaceSession, id: string): Promise<AuthoringHttpResult<DeleteCheckpointOutcome | AccessRefusal>> {
	return historyHttpResult(await session.deleteCheckpoint(id))
}

function historyHttpResult<T extends Readonly<{ status: string; code?: string; retryAfterSeconds?: number }>>(outcome: T): AuthoringHttpResult<T> {
	const status = historyHttpStatus(outcome)
	return {
		status,
		body: outcome,
		...(status === 503 && outcome.retryAfterSeconds !== undefined ? { headers: { 'Retry-After': String(outcome.retryAfterSeconds) } } : {}),
	}
}

export function historyHttpStatus(outcome: Readonly<{ status: string; code?: string }>): number {
	if (outcome.code === 'auth.scope_denied') return 403
	switch (outcome.status) {
		case 'listed':
		case 'found':
		case 'deleted': return 200
		case 'created': return 201
		case 'invalid': return 400
		case 'not_found': return 404
		case 'blocked': return 422
		case 'unavailable': return 503
		default: return 500
	}
}

function parseResourceParameter(value: string): { kind: string; key: string } | undefined {
	const separator = value.indexOf(':')
	if (separator <= 0 || separator === value.length - 1) return undefined
	return { kind: value.slice(0, separator), key: value.slice(separator + 1) }
}

function zodDiagnostics(issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[]): Readonly<{ code: string; path: string; message: string }>[] {
	return issues.map(issue => ({
		code: 'transport.malformed_payload',
		path: issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '/',
		message: issue.message,
	}))
}

function invalid(diagnostics: readonly Readonly<{ code: string; path: string; message: string }>[], message = 'Request query failed structural validation.'): AuthoringHttpResult<Readonly<Record<string, unknown>>> {
	return { status: 400, body: { status: 'invalid', code: 'malformed_payload', message, diagnostics } }
}
