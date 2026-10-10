import { getRouterParam, readBody, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import { z } from 'zod'

import { compatibilityRole } from '../../application/access/labels'
import { ACCESS_ROLES, MEMBER_KINDS } from '../../application/access/principal'
import { getSelectedWorkspaceServerRuntime } from '../selected-workspace'
import { requestOrigin, servesRosterAdministration } from '../loopback-guard'
import { requestSession } from '../request-session'
import { accessErrorResponse, clearedCookie, denyUnlessAllowed, requestPrincipal, secureCookieFor, sessionCookie } from './http'
import { parseHttpPayload } from '../authoring-http'
import type { StoredMember } from './roster'

/**
 * HTTP surface for sessions, edit leases and Owner administration (accepted identity decisions
 * 5, 11 and 12, *Session model*). Administration is a human Owner's cookie session on a loopback
 * origin or an `https` configured origin (Rule 01a12500-b105-7773-822f-359d4dcbd1da).
 */
const addMemberSchema = z.object({
	nickname: z.string(),
	role: z.enum(ACCESS_ROLES),
	kind: z.enum(MEMBER_KINDS).optional(),
}).strict()

const setMemberSchema = z.object({
	role: z.enum(ACCESS_ROLES).optional(),
	nickname: z.string().optional(),
}).strict()

const createTokenSchema = z.object({
	memberId: z.string(),
	label: z.string().max(120).optional(),
	expiresInDays: z.union([z.number().int().min(1).max(3650), z.null()]).optional(),
}).strict()

const createInviteSchema = z.object({
	memberId: z.string(),
	expiresInHours: z.number().int().min(1).max(720).optional(),
}).strict()

const loginSchema = z.object({ credential: z.string() }).strict()

function noStore(event: H3Event) {
	setResponseHeader(event, 'Cache-Control', 'no-store')
}

/** The origin the gate matched; a sign-in link names it (Rule 01a12500-bdc9-7f2d-9e29-4a0c4a6d1277). */
function matchedOrigin(event: H3Event): string {
	const origin = requestOrigin(event)
	if (!origin) throw new Error('No matched origin is attached to this request; the request gate must run first.')
	return origin.origin
}

function respond(event: H3Event, status: number, body: unknown) {
	setResponseStatus(event, status)
	noStore(event)
	return body
}

const access = () => getSelectedWorkspaceServerRuntime().access()

/**
 * A stored member on the administration wire, with the role the Members page still shows,
 * derived from its keys (`compatibilityRole`) until the page edits keys (issue #142).
 */
function memberBody(member: StoredMember) {
	return { ...member, role: compatibilityRole(member) }
}

export async function loginForHttp(event: H3Event) {
	const parsed = parseHttpPayload(loginSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	const service = await access()
	const outcome = await service.login(parsed.data.credential, {
		remoteAddress: event.node.req.socket?.remoteAddress,
		userAgent: event.node.req.headers['user-agent'],
		origin: matchedOrigin(event),
	})
	if (!outcome.ok) {
		if (outcome.retryAfterSeconds) setResponseHeader(event, 'Retry-After', outcome.retryAfterSeconds)
		return respond(event, outcome.status, { status: 'rejected', code: outcome.code, message: outcome.message, diagnostics: [{ code: outcome.code, path: '/credential', message: outcome.message }] })
	}
	setResponseHeader(event, 'Set-Cookie', sessionCookie(outcome.cookieName, outcome.cookieValue, outcome.maxAgeSeconds, secureCookieFor(event)))
	const { id, nickname, kind } = outcome.member
	return respond(event, 200, { member: { id, nickname, kind, role: compatibilityRole(outcome.member) } })
}

export async function readSessionForHttp(event: H3Event) {
	const denied = denyUnlessAllowed(event, 'readSession')
	if (denied) return denied
	const principal = requestPrincipal(event)
	if (principal.type !== 'member') return respond(event, 403, { status: 'blocked', code: 'auth.scope_denied', message: 'Not a member session.' })
	const service = await access()
	return respond(event, 200, {
		member: { id: principal.memberId, nickname: principal.nickname, kind: principal.kind, role: principal.role },
		credential: principal.credential,
		workspaceRoot: service.workspaceRoot,
		hint: service.hint,
	})
}

export async function endSessionForHttp(event: H3Event) {
	const denied = denyUnlessAllowed(event, 'endSession')
	if (denied) return denied
	const service = await access()
	await service.logout(requestPrincipal(event))
	setResponseHeader(event, 'Set-Cookie', clearedCookie(service.cookieName, secureCookieFor(event)))
	return respond(event, 200, { status: 'signed_out' })
}

export function listLocksForHttp(event: H3Event) {
	const denied = denyUnlessAllowed(event, 'listLeases')
	if (denied) return denied
	return respond(event, 200, { locks: requestSession(event).listLeases() })
}

export function forceReleaseLockForHttp(event: H3Event) {
	const kind = getRouterParam(event, 'kind', { decode: true }) ?? ''
	const key = getRouterParam(event, 'key', { decode: true }) ?? ''
	const outcome = requestSession(event).forceReleaseLease({ kind, key })
	const status = outcome.status === 'released' ? 200
		: outcome.status === 'not_found' ? 404
			: outcome.status === 'invalid' ? 400
				: 403
	return respond(event, status, outcome)
}

/**
 * The origin refusal of roster administration (Clause 01a12500-a619-7fa5-b7f6-797adaf52f34). It
 * does not depend on who asks, so it comes before the permission check and before the body is read.
 */
function refuseAdminOrigin(event: H3Event) {
	if (servesRosterAdministration(requestOrigin(event))) return undefined
	const code = 'access.admin_origin_rejected'
	const message = 'Roster administration (members, Tokens, invites and sessions) is not served on a plain-HTTP network origin. Use the loopback URL on the server host, an https origin, or the uiux member, token, invite and session commands.'
	return respond(event, 403, { status: 'blocked', code, message, diagnostics: [{ code, path: '/', message }] })
}

async function admin<T>(event: H3Event, run: (service: Awaited<ReturnType<typeof access>>) => Promise<T> | T, status = 200) {
	const refused = refuseAdminOrigin(event)
	if (refused) return refused
	const denied = denyUnlessAllowed(event, 'administerAccess')
	if (denied) return denied
	try {
		const service = await access()
		await service.refresh(true)
		return respond(event, status, await run(service))
	}
	catch (error) {
		noStore(event)
		return accessErrorResponse(event, error)
	}
}

export const listMembersForHttp = (event: H3Event) => admin(event, service => service.roster())

export async function addMemberForHttp(event: H3Event) {
	const refused = refuseAdminOrigin(event)
	if (refused) return refused
	const body = await readBody(event)
	const parsed = parseHttpPayload(addMemberSchema, body)
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async service => ({ member: memberBody(await service.addMember(parsed.data)) }), 201)
}

export async function setMemberForHttp(event: H3Event) {
	const refused = refuseAdminOrigin(event)
	if (refused) return refused
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const parsed = parseHttpPayload(setMemberSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async service => ({ member: memberBody(await service.setMember(id, parsed.data)) }))
}

export function removeMemberForHttp(event: H3Event) {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	return admin(event, async service => ({ member: memberBody(await service.removeMember(id)) }))
}

export const listTokensForHttp = (event: H3Event) => admin(event, service => ({ tokens: service.tokens() }))

export async function createTokenForHttp(event: H3Event) {
	const refused = refuseAdminOrigin(event)
	if (refused) return refused
	const parsed = parseHttpPayload(createTokenSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async (service) => {
		const issued = await service.createToken(parsed.data)
		const { hash: _hash, ...token } = issued.entry
		void _hash
		// The plaintext is shown once, here; only its hash is stored.
		return { token, credential: issued.credential }
	}, 201)
}

export function revokeTokenForHttp(event: H3Event) {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	return admin(event, async (service) => {
		const { hash: _hash, ...token } = await service.revokeToken(id)
		void _hash
		return { token }
	})
}

export async function createInviteForHttp(event: H3Event) {
	const refused = refuseAdminOrigin(event)
	if (refused) return refused
	const parsed = parseHttpPayload(createInviteSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async (service) => {
		const issued = await service.createInvite(parsed.data)
		const origin = matchedOrigin(event)
		// Invites travel in the URL fragment, so they never reach server logs or Referer headers.
		return { url: `${origin}/login#${issued.credential}`, expiresAt: issued.entry.expiresAt }
	}, 201)
}

export const listSessionsForHttp = (event: H3Event) => admin(event, (service) => {
	const principal = requestPrincipal(event)
	return { sessions: service.sessions(principal.type === 'member' ? principal.credentialId : undefined) }
})

export function revokeSessionForHttp(event: H3Event) {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	return admin(event, async service => ({ revoked: (await service.revokeSession(id)).map(session => session.id) }))
}

export const mcpAttemptsForHttp = (event: H3Event) => admin(event, service => service.mcpAttempts())
