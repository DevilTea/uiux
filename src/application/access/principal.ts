/**
 * Authenticated principals (accepted identity decision 1). Every request on `/api/*` and `/mcp`
 * resolves to exactly one principal or to none; the shared application layer authorizes and
 * stamps from it, so transports never decide roles themselves.
 */
export const ACCESS_ROLES = ['viewer', 'reviewer', 'editor', 'owner'] as const
export type AccessRole = typeof ACCESS_ROLES[number]

export const MEMBER_KINDS = ['human', 'agent'] as const
export type MemberKind = typeof MEMBER_KINDS[number]

/** How the request authenticated: a browser cookie session, a bearer token, or an in-process system credential. */
export type PrincipalCredential = 'session' | 'token' | 'system'

export type MemberPrincipal = Readonly<{
	type: 'member'
	memberId: string
	nickname: string
	kind: MemberKind
	role: AccessRole
	credential: 'session' | 'token'
	/** Public id of the token or session that authenticated the request. */
	credentialId: string
	/** The accepting listener. Only the loopback listener ships. */
	listener: 'loopback'
}>

export const SYSTEM_PRINCIPAL_IDS = ['system:capture'] as const
export type SystemPrincipalId = typeof SYSTEM_PRINCIPAL_IDS[number]

/** Server-internal clients (formal capture): Viewer scope, never members, never actors. */
export type SystemPrincipal = Readonly<{
	type: 'system'
	id: SystemPrincipalId
	role: 'viewer'
	credential: 'system'
}>

export type Principal = MemberPrincipal | SystemPrincipal

export function isAccessRole(value: unknown): value is AccessRole {
	return typeof value === 'string' && (ACCESS_ROLES as readonly string[]).includes(value)
}

export function isMemberKind(value: unknown): value is MemberKind {
	return typeof value === 'string' && (MEMBER_KINDS as readonly string[]).includes(value)
}

/** Agents are capped at Editor whatever the roster says (decision 1, default D3). */
export function effectiveRole(kind: MemberKind, role: AccessRole): AccessRole {
	return kind === 'agent' && role === 'owner' ? 'editor' : role
}

export function roleAtLeast(role: AccessRole, minimum: AccessRole): boolean {
	return ACCESS_ROLES.indexOf(role) >= ACCESS_ROLES.indexOf(minimum)
}

export function principalRole(principal: Principal): AccessRole {
	return principal.type === 'system' ? 'viewer' : effectiveRole(principal.kind, principal.role)
}

/** The server-stamped Review/Decision actor (decision 6). */
export type StampedActor = Readonly<{ type: MemberKind; id: string; displayName: string }>

export function principalActor(principal: MemberPrincipal): StampedActor {
	return { type: principal.kind, id: `member:${principal.memberId}`, displayName: principal.nickname }
}

export function principalLabel(principal: Principal): string {
	return principal.type === 'system' ? principal.id : `${principal.nickname} (${principal.kind}, ${principalRole(principal)})`
}
