import { randomUUID } from 'node:crypto'

import { isAccessRole, isMemberKind, type AccessRole, type MemberKind } from '../../application/access/principal'
import { isFullUuid } from '../../domain/validation'
import {
	CREDENTIAL_ID_PATTERN,
	HINT_PATTERN,
	credentialMatchesHash,
	generateCredential,
	parseCredential,
	type CredentialKind,
} from './credentials'

/**
 * Host-local roster format (`$UIUX_HOME/workspaces/<wsid>/access.json`, `version: 1`). It is not a
 * Workspace schema: it never lives in the Workspace and holds only hashes of secrets.
 */
export const ACCESS_FILE_VERSION = 1

export type StoredMember = Readonly<{ id: string; nickname: string; kind: MemberKind; role: AccessRole; createdAt: string }>
export type StoredToken = Readonly<{
	id: string
	memberId: string
	label: string
	hash: string
	/** Written before the LAN listener design was retired (Discussion #174): kept when read, never written, without effect. */
	lan?: boolean
	createdAt: string
	expiresAt: string | null
	lastUsedAt: string | null
	revokedAt: string | null
}>
export type StoredInvite = Readonly<{ id: string; memberId: string; hash: string; createdAt: string; expiresAt: string; usedAt: string | null }>
export type StoredSession = Readonly<{
	id: string
	memberId: string
	hash: string
	/**
	 * The origin the session was created on (Rule 01a11485-ed4a-766b-a51c-af2b9ffb1fcb). A session
	 * written before configured origins existed has `listener` instead and is a loopback session.
	 */
	origin?: string
	/** Legacy (before Discussion #174): `'loopback'`, or `'lan'` for the never-shipped LAN listener. */
	listener?: 'loopback' | 'lan'
	userAgent: string
	createdAt: string
	lastSeenAt: string
	expiresAt: string
}>

export type AccessFile = Readonly<{
	version: typeof ACCESS_FILE_VERSION
	workspaceRoot: string
	hint: string
	members: readonly StoredMember[]
	tokens: readonly StoredToken[]
	invites: readonly StoredInvite[]
	sessions: readonly StoredSession[]
}>

export const NICKNAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,31}$/u
export const DAY_MS = 24 * 60 * 60 * 1000
export const DEFAULT_TOKEN_EXPIRY_DAYS = 90
export const DEFAULT_INVITE_EXPIRY_HOURS = 24
export const SESSION_IDLE_MS = 14 * DAY_MS
export const SESSION_ABSOLUTE_MS = 30 * DAY_MS

export type AccessErrorCode =
	| 'access.invalid_nickname'
	| 'access.nickname_taken'
	| 'access.invalid_role'
	| 'access.invalid_kind'
	| 'access.agent_role_cap'
	| 'access.kind_immutable'
	| 'access.member_not_found'
	| 'access.token_not_found'
	| 'access.session_not_found'
	| 'access.invite_human_only'
	| 'access.invalid_expiry'
	| 'access.invalid_label'
	| 'access.store_invalid'
	| 'access.store_unsafe'
	| 'access.store_root_mismatch'
	| 'access.home_inside_workspace'
	| 'access.roster_exists'
	| 'access.roster_missing'
	| 'access.lock_busy'
	| 'access.workspace_invalid'
	| 'auth.last_owner'

/** Status codes used when an AccessError reaches HTTP. */
export const ACCESS_ERROR_HTTP_STATUS: Readonly<Partial<Record<AccessErrorCode, number>>> = {
	'access.member_not_found': 404,
	'access.token_not_found': 404,
	'access.session_not_found': 404,
	'access.nickname_taken': 409,
	'auth.last_owner': 409,
}

export class AccessError extends Error {
	readonly code: AccessErrorCode
	constructor(code: AccessErrorCode, message: string) {
		super(message)
		this.name = 'AccessError'
		this.code = code
	}
}

export function createEmptyAccessFile(workspaceRoot: string, hint: string): AccessFile {
	return { version: ACCESS_FILE_VERSION, workspaceRoot, hint, members: [], tokens: [], invites: [], sessions: [] }
}

const isoOrNull = (value: unknown) => value === null || (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
const iso = (value: unknown) => typeof value === 'string' && !Number.isNaN(Date.parse(value))
const hash = (value: unknown) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value)

/** A session names its origin, or (written before configured origins existed) its listener. */
function sessionOriginValid(session: Record<string, unknown>): boolean {
	if (session.origin !== undefined) return typeof session.origin === 'string' && session.origin.length > 0 && session.origin.length <= 300
	return session.listener === 'loopback' || session.listener === 'lan'
}

/** Strict structural validation of a parsed `access.json`. */
export function validateAccessFile(value: unknown): AccessFile {
	const fail = (detail: string): never => { throw new AccessError('access.store_invalid', `The access store is invalid: ${detail}.`) }
	if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('expected a JSON object')
	const file = value as Record<string, unknown>
	if (file.version !== ACCESS_FILE_VERSION) fail(`unsupported version ${JSON.stringify(file.version)}`)
	if (typeof file.workspaceRoot !== 'string' || !file.workspaceRoot) fail('workspaceRoot is missing')
	if (typeof file.hint !== 'string' || !HINT_PATTERN.test(file.hint)) fail('hint must be 4 base32 characters')
	for (const name of ['members', 'tokens', 'invites', 'sessions'] as const)
		if (!Array.isArray(file[name])) fail(`${name} must be an array`)
	const members = file.members as Record<string, unknown>[]
	for (const member of members) {
		if (typeof member !== 'object' || member === null) fail('member entry is not an object')
		if (!isFullUuid(member.id)) fail('member id must be a full UUID')
		if (typeof member.nickname !== 'string' || !NICKNAME_PATTERN.test(member.nickname)) fail(`member nickname ${JSON.stringify(member.nickname)} is invalid`)
		if (!isMemberKind(member.kind)) fail('member kind is invalid')
		if (!isAccessRole(member.role)) fail('member role is invalid')
		if (!iso(member.createdAt)) fail('member createdAt is invalid')
	}
	for (const token of file.tokens as Record<string, unknown>[]) {
		if (typeof token !== 'object' || token === null) fail('token entry is not an object')
		if (typeof token.id !== 'string' || !CREDENTIAL_ID_PATTERN.test(token.id) || !isFullUuid(token.memberId) || typeof token.label !== 'string' || !hash(token.hash) || (token.lan !== undefined && typeof token.lan !== 'boolean') || !iso(token.createdAt) || !isoOrNull(token.expiresAt) || !isoOrNull(token.lastUsedAt) || !isoOrNull(token.revokedAt))
			fail('token entry is invalid')
	}
	for (const invite of file.invites as Record<string, unknown>[]) {
		if (typeof invite !== 'object' || invite === null) fail('invite entry is not an object')
		if (typeof invite.id !== 'string' || !CREDENTIAL_ID_PATTERN.test(invite.id) || !isFullUuid(invite.memberId) || !hash(invite.hash) || !iso(invite.createdAt) || !iso(invite.expiresAt) || !isoOrNull(invite.usedAt))
			fail('invite entry is invalid')
	}
	for (const session of file.sessions as Record<string, unknown>[]) {
		if (typeof session !== 'object' || session === null) fail('session entry is not an object')
		if (typeof session.id !== 'string' || !CREDENTIAL_ID_PATTERN.test(session.id) || !isFullUuid(session.memberId) || !hash(session.hash) || !sessionOriginValid(session) || typeof session.userAgent !== 'string' || !iso(session.createdAt) || !iso(session.lastSeenAt) || !iso(session.expiresAt))
			fail('session entry is invalid')
	}
	const nicknames = new Set<string>()
	for (const member of members) {
		const key = String(member.nickname).toLowerCase()
		if (nicknames.has(key)) fail(`nickname ${JSON.stringify(member.nickname)} is duplicated`)
		nicknames.add(key)
	}
	return value as AccessFile
}

export function assertNickname(nickname: string): string {
	if (!NICKNAME_PATTERN.test(nickname))
		throw new AccessError('access.invalid_nickname', `Nickname ${JSON.stringify(nickname)} must match ^[a-z0-9][a-z0-9._-]{0,31}$ (lowercase letters, digits, ".", "_" and "-", up to 32 characters).`)
	return nickname
}

/** Derives a valid nickname from an OS user name (first-run bootstrap), falling back to `owner`. */
export function sanitizeNickname(raw: string | undefined): string {
	const cleaned = (raw ?? '').toLowerCase().replace(/[^a-z0-9._-]+/gu, '-').replace(/^[^a-z0-9]+/u, '').slice(0, 32)
	return NICKNAME_PATTERN.test(cleaned) ? cleaned : 'owner'
}

export function findMemberByNickname(file: AccessFile, nickname: string): StoredMember | undefined {
	const key = nickname.toLowerCase()
	return file.members.find(member => member.nickname.toLowerCase() === key)
}

export function requireMember(file: AccessFile, nickname: string): StoredMember {
	const member = findMemberByNickname(file, nickname)
	if (!member) throw new AccessError('access.member_not_found', `No member named ${JSON.stringify(nickname)} in this Workspace's roster.`)
	return member
}

function humanOwners(file: AccessFile): readonly StoredMember[] {
	return file.members.filter(member => member.kind === 'human' && member.role === 'owner')
}

export function hasHumanOwner(file: AccessFile): boolean {
	return humanOwners(file).length > 0
}

function assertRole(role: unknown): AccessRole {
	if (!isAccessRole(role)) throw new AccessError('access.invalid_role', `Role must be one of owner, editor, reviewer or viewer (received ${JSON.stringify(role)}).`)
	return role
}

export type Mutation<T> = Readonly<{ file: AccessFile; result: T }>

export function addMember(
	file: AccessFile,
	input: Readonly<{ nickname: string; role: unknown; kind?: unknown }>,
	now: Date = new Date(),
): Mutation<StoredMember> {
	const nickname = assertNickname(input.nickname)
	const role = assertRole(input.role)
	const kind = input.kind ?? 'human'
	if (!isMemberKind(kind)) throw new AccessError('access.invalid_kind', `Kind must be human or agent (received ${JSON.stringify(kind)}).`)
	if (kind === 'agent' && role === 'owner') throw new AccessError('access.agent_role_cap', 'An agent cannot be Owner; agents are capped at Editor.')
	if (findMemberByNickname(file, nickname)) throw new AccessError('access.nickname_taken', `Nickname ${JSON.stringify(nickname)} is already used in this roster.`)
	const member: StoredMember = { id: randomUUID(), nickname, kind, role, createdAt: now.toISOString() }
	return { file: { ...file, members: [...file.members, member] }, result: member }
}

export function setMember(
	file: AccessFile,
	nickname: string,
	changes: Readonly<{ role?: unknown; nickname?: string; kind?: unknown }>,
): Mutation<StoredMember> {
	const member = requireMember(file, nickname)
	if (changes.kind !== undefined && changes.kind !== member.kind)
		throw new AccessError('access.kind_immutable', 'A member\'s kind is fixed at creation and cannot be changed.')
	let next: StoredMember = member
	if (changes.role !== undefined) {
		const role = assertRole(changes.role)
		if (member.kind === 'agent' && role === 'owner') throw new AccessError('access.agent_role_cap', 'An agent cannot be Owner; agents are capped at Editor.')
		if (member.kind === 'human' && member.role === 'owner' && role !== 'owner' && humanOwners(file).length <= 1)
			throw new AccessError('auth.last_owner', `${member.nickname} is the last human Owner of this roster and cannot be demoted.`)
		next = { ...next, role }
	}
	if (changes.nickname !== undefined && changes.nickname !== member.nickname) {
		const renamed = assertNickname(changes.nickname)
		const clash = findMemberByNickname(file, renamed)
		if (clash && clash.id !== member.id) throw new AccessError('access.nickname_taken', `Nickname ${JSON.stringify(renamed)} is already used in this roster.`)
		next = { ...next, nickname: renamed }
	}
	return { file: { ...file, members: file.members.map(item => item.id === member.id ? next : item) }, result: next }
}

export function removeMember(file: AccessFile, nickname: string): Mutation<StoredMember> {
	const member = requireMember(file, nickname)
	if (member.kind === 'human' && member.role === 'owner' && humanOwners(file).length <= 1)
		throw new AccessError('auth.last_owner', `${member.nickname} is the last human Owner of this roster and cannot be removed.`)
	return {
		file: {
			...file,
			members: file.members.filter(item => item.id !== member.id),
			tokens: file.tokens.filter(item => item.memberId !== member.id),
			invites: file.invites.filter(item => item.memberId !== member.id),
			sessions: file.sessions.filter(item => item.memberId !== member.id),
		},
		result: member,
	}
}

export type IssuedCredential<T> = Readonly<{ entry: T; credential: string }>

export function createToken(
	file: AccessFile,
	input: Readonly<{ nickname: string; label?: string; expiresInDays?: number | null }>,
	now: Date = new Date(),
): Mutation<IssuedCredential<StoredToken>> {
	const member = requireMember(file, input.nickname)
	const label = (input.label ?? '').trim()
	if (label.length > 120 || /[\r\n\0]/u.test(label)) throw new AccessError('access.invalid_label', 'Token labels are single-line text of at most 120 characters.')
	const days = input.expiresInDays === undefined ? DEFAULT_TOKEN_EXPIRY_DAYS : input.expiresInDays
	if (days !== null && (!Number.isInteger(days) || days < 1 || days > 3650))
		throw new AccessError('access.invalid_expiry', 'Token expiry must be a whole number of days from 1 to 3650, or never.')
	const issued = generateCredential('token', file.hint, uniqueId(file))
	const entry: StoredToken = {
		id: issued.id,
		memberId: member.id,
		label,
		hash: issued.hash,
		createdAt: now.toISOString(),
		expiresAt: days === null ? null : new Date(now.getTime() + days * DAY_MS).toISOString(),
		lastUsedAt: null,
		revokedAt: null,
	}
	return { file: { ...file, tokens: [...file.tokens, entry] }, result: { entry, credential: issued.value } }
}

export function revokeToken(file: AccessFile, tokenId: string, now: Date = new Date()): Mutation<StoredToken> {
	const token = file.tokens.find(item => item.id === tokenId)
	if (!token) throw new AccessError('access.token_not_found', `No token with id ${JSON.stringify(tokenId)} in this Workspace's roster.`)
	const next: StoredToken = token.revokedAt ? token : { ...token, revokedAt: now.toISOString() }
	return { file: { ...file, tokens: file.tokens.map(item => item.id === tokenId ? next : item) }, result: next }
}

export function createInvite(
	file: AccessFile,
	input: Readonly<{ nickname: string; expiresInHours?: number }>,
	now: Date = new Date(),
): Mutation<IssuedCredential<StoredInvite>> {
	const member = requireMember(file, input.nickname)
	if (member.kind !== 'human') throw new AccessError('access.invite_human_only', 'Invites sign a browser in and are for human members only; give an agent a token.')
	const hours = input.expiresInHours ?? DEFAULT_INVITE_EXPIRY_HOURS
	if (!Number.isInteger(hours) || hours < 1 || hours > 24 * 30)
		throw new AccessError('access.invalid_expiry', 'Invite expiry must be a whole number of hours from 1 to 720.')
	const issued = generateCredential('invite', file.hint, uniqueId(file))
	const entry: StoredInvite = {
		id: issued.id,
		memberId: member.id,
		hash: issued.hash,
		createdAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString(),
		usedAt: null,
	}
	// Spent and expired invites are pruned when a new one is issued.
	const invites = file.invites.filter(item => item.usedAt === null && Date.parse(item.expiresAt) > now.getTime())
	return { file: { ...file, invites: [...invites, entry] }, result: { entry, credential: issued.value } }
}

export function revokeSessions(
	file: AccessFile,
	selector: Readonly<{ sessionId: string } | { nickname: string }>,
): Mutation<readonly StoredSession[]> {
	let removed: StoredSession[]
	if ('sessionId' in selector) {
		removed = file.sessions.filter(item => item.id === selector.sessionId)
		if (removed.length === 0) throw new AccessError('access.session_not_found', `No session with id ${JSON.stringify(selector.sessionId)} in this Workspace's roster.`)
	}
	else {
		const member = requireMember(file, selector.nickname)
		removed = file.sessions.filter(item => item.memberId === member.id)
	}
	const ids = new Set(removed.map(item => item.id))
	return { file: { ...file, sessions: file.sessions.filter(item => !ids.has(item.id)) }, result: removed }
}

function uniqueId(file: AccessFile): string {
	const used = new Set([...file.tokens, ...file.invites, ...file.sessions].map(item => item.id))
	for (;;) {
		const candidate = generateCredential('token', file.hint).id
		if (!used.has(candidate)) return candidate
	}
}

export function isTokenActive(token: StoredToken, now: number): boolean {
	return token.revokedAt === null && (token.expiresAt === null || Date.parse(token.expiresAt) > now)
}

export function isSessionActive(session: StoredSession, now: number, lastSeenMs?: number): boolean {
	const seen = Math.max(Date.parse(session.lastSeenAt), lastSeenMs ?? 0)
	return Date.parse(session.expiresAt) > now && seen + SESSION_IDLE_MS > now
}

export type CredentialVerification =
	| Readonly<{ ok: true; kind: CredentialKind; member: StoredMember; token?: StoredToken; invite?: StoredInvite; session?: StoredSession }>
	| Readonly<{ ok: false; reason: 'malformed' | 'unknown' | 'expired'; foreignHint?: string; kind?: CredentialKind }>

/**
 * Verifies a presented credential against this roster only. Lookup is by public `<id>`, then a
 * constant-time hash comparison; `<ws>` never decides validity and only explains a miss.
 */
export function verifyCredential(
	file: AccessFile,
	value: string,
	now: number,
	options: Readonly<{ lastSeen?: (sessionId: string) => number | undefined }> = {},
): CredentialVerification {
	const parsed = parseCredential(value)
	if (!parsed) return { ok: false, reason: 'malformed' }
	const miss = (reason: 'unknown' | 'expired'): CredentialVerification => ({
		ok: false,
		reason,
		kind: parsed.kind,
		...(reason === 'unknown' && parsed.hint !== file.hint ? { foreignHint: parsed.hint } : {}),
	})
	const memberFor = (memberId: string) => file.members.find(member => member.id === memberId)
	switch (parsed.kind) {
		case 'token': {
			const token = file.tokens.find(item => item.id === parsed.id)
			if (!token || !credentialMatchesHash(value, token.hash)) return miss('unknown')
			const member = memberFor(token.memberId)
			if (!member) return miss('unknown')
			if (!isTokenActive(token, now)) return miss('expired')
			return { ok: true, kind: 'token', member, token }
		}
		case 'invite': {
			const invite = file.invites.find(item => item.id === parsed.id)
			if (!invite || !credentialMatchesHash(value, invite.hash)) return miss('unknown')
			const member = memberFor(invite.memberId)
			if (!member) return miss('unknown')
			if (invite.usedAt !== null || Date.parse(invite.expiresAt) <= now) return miss('expired')
			return { ok: true, kind: 'invite', member, invite }
		}
		case 'session': {
			const session = file.sessions.find(item => item.id === parsed.id)
			if (!session || !credentialMatchesHash(value, session.hash)) return miss('unknown')
			const member = memberFor(session.memberId)
			if (!member) return miss('unknown')
			if (!isSessionActive(session, now, options.lastSeen?.(session.id))) return miss('expired')
			return { ok: true, kind: 'session', member, session }
		}
	}
}

export type LoginOutcome = Readonly<{ member: StoredMember; session: StoredSession; cookieValue: string }>

/**
 * Exchanges an invite (single use) or a member token for a fresh session. A fresh session id is
 * minted at every sign-in, so a pre-set cookie cannot fix the session.
 */
export function loginWithCredential(
	file: AccessFile,
	verification: Extract<CredentialVerification, { ok: true }>,
	meta: Readonly<{ origin: string; userAgent: string }>,
	now: Date = new Date(),
): Mutation<LoginOutcome> {
	if (verification.kind === 'session') throw new Error('A session cannot be exchanged for another session.')
	const issued = generateCredential('session', file.hint, uniqueId(file))
	const session: StoredSession = {
		id: issued.id,
		memberId: verification.member.id,
		hash: issued.hash,
		origin: meta.origin,
		userAgent: meta.userAgent.slice(0, 200),
		createdAt: now.toISOString(),
		lastSeenAt: now.toISOString(),
		expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS).toISOString(),
	}
	const nowMs = now.getTime()
	const invites = verification.invite
		? file.invites.map(item => item.id === verification.invite!.id ? { ...item, usedAt: now.toISOString() } : item)
		: file.invites
	// Expired sessions are pruned whenever a new one is created.
	const sessions = file.sessions.filter(item => isSessionActive(item, nowMs))
	return {
		file: { ...file, invites, sessions: [...sessions, session] },
		result: { member: verification.member, session, cookieValue: issued.value },
	}
}

/** Applies buffered `lastUsedAt` / `lastSeenAt` values (flushed at most once a minute per credential). */
export function applyUsage(
	file: AccessFile,
	usage: Readonly<{ tokens: ReadonlyMap<string, number>; sessions: ReadonlyMap<string, number> }>,
): AccessFile {
	const later = (stored: string | null, seen: number | undefined) => seen !== undefined && (stored === null || Date.parse(stored) < seen) ? new Date(seen).toISOString() : stored
	return {
		...file,
		tokens: file.tokens.map(token => {
			const lastUsedAt = later(token.lastUsedAt, usage.tokens.get(token.id))
			return lastUsedAt === token.lastUsedAt ? token : { ...token, lastUsedAt }
		}),
		sessions: file.sessions.map(session => {
			const lastSeenAt = later(session.lastSeenAt, usage.sessions.get(session.id)) ?? session.lastSeenAt
			return lastSeenAt === session.lastSeenAt ? session : { ...session, lastSeenAt }
		}),
	}
}

/** `uiux access copy`: members and tokens (hashes included), a new hint and root, no invites or sessions. */
export function copyRoster(source: AccessFile, target: Readonly<{ workspaceRoot: string; hint: string }>): AccessFile {
	return {
		version: ACCESS_FILE_VERSION,
		workspaceRoot: target.workspaceRoot,
		hint: target.hint,
		members: source.members.map(member => ({ ...member })),
		tokens: source.tokens.map(token => ({ ...token, lastUsedAt: null })),
		invites: [],
		sessions: [],
	}
}

export type MemberSummary = Readonly<StoredMember & { activeTokens: number; activeSessions: number }>

export function summarizeMembers(file: AccessFile, now: number): readonly MemberSummary[] {
	return file.members.map(member => ({
		...member,
		activeTokens: file.tokens.filter(token => token.memberId === member.id && isTokenActive(token, now)).length,
		activeSessions: file.sessions.filter(session => session.memberId === member.id && isSessionActive(session, now)).length,
	}))
}
