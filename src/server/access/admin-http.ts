import { getRouterParam, readBody, setResponseHeader, setResponseStatus, type H3Event } from 'h3'
import { z } from 'zod'

import { ACCESS_ROLES, MEMBER_KINDS } from '../../application/access/principal'
import { getSelectedWorkspaceServerRuntime } from '../selected-workspace'
import { requestSession } from '../request-session'
import { accessErrorResponse, clearedCookie, denyUnlessAllowed, requestPrincipal, sessionCookie } from './http'
import { parseHttpPayload } from '../authoring-http'

/**
 * HTTP surface for sessions, edit leases and Owner administration (accepted identity decisions
 * 5, 11 and 12, *Session model*). Administration is human Owner + cookie session + loopback.
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
	lan: z.boolean().optional(),
}).strict()

const createInviteSchema = z.object({
	memberId: z.string(),
	expiresInHours: z.number().int().min(1).max(720).optional(),
	origin: z.string().url().optional(),
}).strict()

const loginSchema = z.object({ credential: z.string() }).strict()

function noStore(event: H3Event) {
	setResponseHeader(event, 'Cache-Control', 'no-store')
}

function isSecure(event: H3Event): boolean {
	return Boolean((event.node.req.socket as { encrypted?: boolean } | undefined)?.encrypted)
}

function respond(event: H3Event, status: number, body: unknown) {
	setResponseStatus(event, status)
	noStore(event)
	return body
}

const access = () => getSelectedWorkspaceServerRuntime().access()

export async function loginForHttp(event: H3Event) {
	const parsed = parseHttpPayload(loginSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	const service = await access()
	const outcome = await service.login(parsed.data.credential, {
		remoteAddress: event.node.req.socket?.remoteAddress,
		userAgent: event.node.req.headers['user-agent'],
	})
	if (!outcome.ok) {
		if (outcome.retryAfterSeconds) setResponseHeader(event, 'Retry-After', outcome.retryAfterSeconds)
		return respond(event, outcome.status, { status: 'rejected', code: outcome.code, message: outcome.message, diagnostics: [{ code: outcome.code, path: '/credential', message: outcome.message }] })
	}
	setResponseHeader(event, 'Set-Cookie', sessionCookie(outcome.cookieName, outcome.cookieValue, outcome.maxAgeSeconds, isSecure(event)))
	const { id, nickname, kind, role } = outcome.member
	return respond(event, 200, { member: { id, nickname, kind, role } })
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
		listener: principal.listener,
		workspaceRoot: service.workspaceRoot,
		hint: service.hint,
	})
}

export async function endSessionForHttp(event: H3Event) {
	const denied = denyUnlessAllowed(event, 'endSession')
	if (denied) return denied
	const service = await access()
	await service.logout(requestPrincipal(event))
	setResponseHeader(event, 'Set-Cookie', clearedCookie(service.cookieName))
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

async function admin<T>(event: H3Event, run: (service: Awaited<ReturnType<typeof access>>) => Promise<T> | T, status = 200) {
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
	const body = await readBody(event)
	const parsed = parseHttpPayload(addMemberSchema, body)
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async service => ({ member: await service.addMember(parsed.data) }), 201)
}

export async function setMemberForHttp(event: H3Event) {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	const parsed = parseHttpPayload(setMemberSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async service => ({ member: await service.setMember(id, parsed.data) }))
}

export function removeMemberForHttp(event: H3Event) {
	const id = getRouterParam(event, 'id', { decode: true }) ?? ''
	return admin(event, async service => ({ member: await service.removeMember(id) }))
}

export const listTokensForHttp = (event: H3Event) => admin(event, service => ({ tokens: service.tokens() }))

export async function createTokenForHttp(event: H3Event) {
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
	const parsed = parseHttpPayload(createInviteSchema, await readBody(event))
	if (!parsed.ok) return respond(event, parsed.result.status, parsed.result.body)
	return admin(event, async (service) => {
		const issued = await service.createInvite(parsed.data)
		const origin = parsed.data.origin ? new URL(parsed.data.origin).origin : getSelectedWorkspaceServerRuntime().serverOrigin
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
