import { z } from 'zod'

import type { ScopedWorkspaceSession } from '../application/access/scoped-session'
import { CHANGE_BASES, type ChangeBlobOutcome, type ChangeDiffOutcome, type ListChangesOutcome } from '../application/services/git-changes'
import { detectSignatureMediaType } from '../domain/assets/schema'
import type { AuthoringHttpResult } from './authoring-http'
import { storedContentSecurityHeaders } from './stored-content-headers'

/**
 * The Workbench's read routes for the changes since a Git base (Feature
 * 01a1ece7-8d4e-763c-8897-2c35ef129a4d). There is no HTTP Contract and no MCP surface, so the
 * query shapes are implementation-defined. Each needs `workspace.read`, answers
 * `Cache-Control: no-store`, and has no write counterpart.
 */

const baseSchema = z.enum(CHANGE_BASES).optional()
const listQuerySchema = z.object({ base: baseSchema }).strict()
const diffQuerySchema = z.object({ base: baseSchema, kind: z.string().min(1), key: z.string().min(1) }).strict()
const blobQuerySchema = z.object({ base: baseSchema, key: z.string().min(1), digest: z.string().min(1) }).strict()

const NO_STORE = { 'Cache-Control': 'no-store' } as const

function invalid(issues: readonly Readonly<{ path: readonly PropertyKey[]; message: string }>[]): AuthoringHttpResult<Readonly<Record<string, unknown>>> {
	const diagnostics = issues.map(issue => ({ code: 'transport.malformed_payload', path: issue.path.length > 0 ? `/${issue.path.map(String).join('/')}` : '/', message: issue.message }))
	return { status: 400, body: { status: 'invalid', code: 'malformed_payload', message: 'Request query failed structural validation.', diagnostics }, headers: NO_STORE }
}

function statusOf(outcome: Readonly<{ status: string }>): number {
	switch (outcome.status) {
		case 'listed':
		case 'compared':
		case 'found': return 200
		case 'invalid': return 400
		case 'not_found': return 404
		default: return 503
	}
}

/** `GET /api/changes?base=head|merge-base`: the changed resources. Git that cannot supply the base answers 200 with `status: "unavailable"`. */
export async function listChangesForHttp(session: ScopedWorkspaceSession, query: unknown): Promise<AuthoringHttpResult<ListChangesOutcome | Readonly<Record<string, unknown>>>> {
	const parsed = listQuerySchema.safeParse(query)
	if (!parsed.success) return invalid(parsed.error.issues)
	const outcome = await session.listChanges(parsed.data.base === undefined ? {} : { base: parsed.data.base })
	return { status: 200, body: outcome, headers: NO_STORE }
}

/** `GET /api/changes/diff?base=&kind=&key=`: the semantic difference of one resource between the base and the working tree. */
export async function readChangeDiffForHttp(session: ScopedWorkspaceSession, query: unknown): Promise<AuthoringHttpResult<ChangeDiffOutcome | Readonly<Record<string, unknown>>>> {
	const parsed = diffQuerySchema.safeParse(query)
	if (!parsed.success) return invalid(parsed.error.issues)
	const { base, kind, key } = parsed.data
	const outcome = await session.readChangeDiff({ ...(base === undefined ? {} : { base }), kind, key })
	return { status: statusOf(outcome), body: outcome, headers: NO_STORE }
}

/**
 * `GET /api/changes/blob?base=&key=&digest=`: one file of an Asset as the base has it, found by its
 * content digest, for the before image of an Asset change. An image is served as the image type its
 * byte signature shows, sandboxed, never as a document.
 */
export async function readChangeBlobForHttp(session: ScopedWorkspaceSession, query: unknown): Promise<AuthoringHttpResult<Uint8Array | Exclude<ChangeBlobOutcome, { status: 'found' }> | Readonly<Record<string, unknown>>>> {
	const parsed = blobQuerySchema.safeParse(query)
	if (!parsed.success) return invalid(parsed.error.issues)
	const { base, key, digest } = parsed.data
	const outcome = await session.readChangeBlob({ ...(base === undefined ? {} : { base }), key, digest })
	if (outcome.status !== 'found') return { status: statusOf(outcome), body: outcome, headers: NO_STORE }
	const detected = detectSignatureMediaType(outcome.bytes)
	return {
		status: 200,
		body: outcome.bytes,
		headers: {
			'Content-Type': detected?.startsWith('image/') ? detected : 'application/octet-stream',
			'Content-Length': String(outcome.bytes.byteLength),
			'X-Content-Type-Options': 'nosniff',
			'Content-Disposition': 'attachment',
			...NO_STORE,
			...storedContentSecurityHeaders('application/octet-stream', outcome.bytes),
		},
	}
}
