import type { PermissionKey } from './keys'
import type { MemberLabel } from './labels'

/**
 * Authenticated principals (accepted identity decision 1). Every request on `/api/*` and `/mcp`
 * resolves to exactly one principal or to none; the shared application layer authorizes and
 * stamps from it, so transports never decide permissions themselves.
 */
export const MEMBER_KINDS = ['human', 'agent'] as const
export type MemberKind = typeof MEMBER_KINDS[number]

/** How the request authenticated: a browser cookie session, a bearer token, or an in-process system credential. */
export type PrincipalCredential = 'session' | 'token' | 'system'

export type MemberPrincipal = Readonly<{
	type: 'member'
	memberId: string
	nickname: string
	kind: MemberKind
	/**
	 * The member's permission keys, resolved from its stored keys on every request (Rule
	 * 01a11485-ebdd-70fc-b853-0621caf056b8): catalog keys only, and never a `humanOnly` key for an
	 * Agent (`grantedKeys`). Which of them take effect depends on the credential: see
	 * `effectiveKeys` in `policy.ts`.
	 */
	keys: readonly PermissionKey[]
	/**
	 * The member's label (Clause 01a11c09-a49b-78c7-9304-7b8239f8a8cf), computed from its stored
	 * keys when the request authenticates and never stored (Rule 01a11c09-c9be-736b-95a4-0b39d6f64cf0).
	 * It authorizes nothing.
	 */
	label: MemberLabel
	credential: 'session' | 'token'
	/** Public id of the token or session that authenticated the request. */
	credentialId: string
}>

export const SYSTEM_PRINCIPAL_IDS = ['system:capture'] as const
export type SystemPrincipalId = typeof SYSTEM_PRINCIPAL_IDS[number]

/**
 * Server-internal clients (formal capture): never members, never actors, holding no permission key
 * and no label (Clause 01a114ec-ea96-764e-876b-464e3319b3db); they may perform only a fixed
 * operation allowlist (Clause 01a11c09-a3bb-7ad4-a889-d50b124d3679).
 */
export type SystemPrincipal = Readonly<{
	type: 'system'
	id: SystemPrincipalId
	credential: 'system'
}>

export type Principal = MemberPrincipal | SystemPrincipal

export function isMemberKind(value: unknown): value is MemberKind {
	return typeof value === 'string' && (MEMBER_KINDS as readonly string[]).includes(value)
}

/** The server-stamped Review/Decision actor (decision 6). */
export type StampedActor = Readonly<{ type: MemberKind; id: string; displayName: string }>

export function principalActor(principal: MemberPrincipal): StampedActor {
	return { type: principal.kind, id: `member:${principal.memberId}`, displayName: principal.nickname }
}
