import { randomUUID } from 'node:crypto'

import { inCatalogOrder, isCatalogKey, isHumanOnlyKey, isPermissionKeyName, keysForRole, missingRequirements, type PermissionKey } from '../../application/access/keys'
import { compatibilityRole } from '../../application/access/labels'
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
 * Host-local roster format (`$UIUX_HOME/workspaces/<wsid>/access.json`, `version: 2`, Clause
 * 01a11485-f895-7a0c-94d1-ed2b9cb092a9). It is not a Workspace schema: it never lives in the
 * Workspace and holds only hashes of secrets. A `version: 1` roster, whose members carry `role`,
 * is upgraded to `version: 2` when opened (Clause 01a11c09-a195-768b-ba6e-a64eb7f05eca; see
 * `upgradeAccessFile` and the store).
 */
export const ACCESS_FILE_VERSION = 2
export const LEGACY_ACCESS_FILE_VERSION = 1

/**
 * Clause 01a11485-f8b6-7b96-aa48-e6ff70b3facd: `{ id, nickname, kind, keys, createdAt }`. `keys`
 * are unique permission key names; a key unknown to this UIUX version is kept and grants nothing
 * (Rule 01a11c09-b7ec-786f-9723-eda32404d421).
 */
export type StoredMember = Readonly<{ id: string; nickname: string; kind: MemberKind; keys: readonly string[]; createdAt: string }>
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
	| 'access.invalid_keys'
	| 'access.invalid_kind'
	| 'access.key_requires'
	| 'access.key_human_only'
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
	| 'access.last_manager'

/** Status codes used when an AccessError reaches HTTP (Clause 01a114ec-ea2d-7f54-97d1-f981d48795fb: `access.last_manager` is 409). */
export const ACCESS_ERROR_HTTP_STATUS: Readonly<Partial<Record<AccessErrorCode, number>>> = {
	'access.member_not_found': 404,
	'access.token_not_found': 404,
	'access.session_not_found': 404,
	'access.nickname_taken': 409,
	'access.last_manager': 409,
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

const storeInvalid = (detail: string): never => { throw new AccessError('access.store_invalid', `The access store is invalid: ${detail}.`) }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** A `version: 2` member's `keys`: unique key names, and no `humanOnly` key on an Agent. */
function validateStoredKeys(member: Record<string, unknown>): void {
	const nickname = JSON.stringify(member.nickname)
	if (!Array.isArray(member.keys)) storeInvalid(`member ${nickname} has no keys array`)
	const keys = member.keys as unknown[]
	const invalid = keys.filter(key => !isPermissionKeyName(key))
	if (invalid.length > 0) storeInvalid(`member ${nickname} holds ${invalid.map(key => JSON.stringify(key)).join(', ')}, which ${invalid.length > 1 ? 'are not permission key names' : 'is not a permission key name'}`)
	if (new Set(keys).size !== keys.length) storeInvalid(`member ${nickname} lists a key more than once`)
	// Rule 01a11485-eac6-730b-b66b-309cc9efb169: a `humanOnly` key is never stored on an Agent. A
	// roster that says otherwise was not written by UIUX, so it is refused rather than trusted.
	const humanOnly = (keys as string[]).filter(isHumanOnlyKey)
	if (member.kind === 'agent' && humanOnly.length > 0)
		storeInvalid(`Agent member ${nickname} holds the humanOnly key${humanOnly.length > 1 ? 's' : ''} ${humanOnly.join(', ')}, which an Agent never holds; remove ${humanOnly.length > 1 ? 'them' : 'it'} from the roster file`)
}

/** Strict structural validation of a parsed roster of `version` (members carry `role` in version 1 and `keys` in version 2). */
function validateRoster(value: unknown, version: typeof ACCESS_FILE_VERSION | typeof LEGACY_ACCESS_FILE_VERSION): void {
	const fail = storeInvalid
	if (!isRecord(value)) fail('expected a JSON object')
	const file = value as Record<string, unknown>
	if (file.version !== version) fail(`unsupported version ${JSON.stringify(file.version)}`)
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
		if (version === LEGACY_ACCESS_FILE_VERSION) {
			if (!isAccessRole(member.role)) fail('member role is invalid')
		}
		else {
			validateStoredKeys(member)
		}
		if (!iso(member.createdAt)) fail('member createdAt is invalid')
	}
	if (new Set(members.map(member => member.id)).size !== members.length) fail('a member id is duplicated')
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
}

/** Strict structural validation of a parsed `version: 2` `access.json`. */
export function validateAccessFile(value: unknown): AccessFile {
	validateRoster(value, ACCESS_FILE_VERSION)
	return value as AccessFile
}

/**
 * Clause 01a11c09-a195-768b-ba6e-a64eb7f05eca: a validated `version: 1` roster as `version: 2`.
 * Each member gets the keys its `role` maps to (Clause 01a11bb1-b427-777e-8175-fa24d61d434b),
 * without `humanOnly` keys for an Agent (Rule 01a11c09-b698-7ee3-861b-f02eaba61269), so an Agent
 * written as Owner by hand gets the Editor keys it could hold. Any `keys` a version 1 member
 * carries are not trusted and are replaced. Fields this version does not know are kept.
 */
export function upgradeAccessFile(legacy: Readonly<Record<string, unknown>>): Record<string, unknown> {
	const members = (legacy.members as Record<string, unknown>[]).map(({ role, keys: _untrusted, ...member }) => {
		void _untrusted
		return { ...member, keys: [...keysForRole(member.kind as MemberKind, role as AccessRole)] }
	})
	return { ...legacy, version: ACCESS_FILE_VERSION, members }
}

/**
 * Parses a roster of either version: a `version: 2` roster is validated, and a `version: 1`
 * roster is validated as written, then upgraded in memory (`legacy` says so; the store writes the
 * upgrade and its backup). Any other version is refused, so an older roster format is never
 * misread and a newer one is never silently rewritten.
 */
export function readAccessFile(value: unknown): Readonly<{ file: AccessFile; legacy: boolean }> {
	if (isRecord(value) && value.version === LEGACY_ACCESS_FILE_VERSION) {
		validateRoster(value, LEGACY_ACCESS_FILE_VERSION)
		return { file: validateAccessFile(upgradeAccessFile(value)), legacy: true }
	}
	return { file: validateAccessFile(value), legacy: false }
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

const MANAGE_KEY: PermissionKey = 'members.manage'

function isHumanManager(member: StoredMember): boolean {
	return member.kind === 'human' && member.keys.includes(MANAGE_KEY)
}

/** Whether a human member holds `members.manage` (Rule 01a11485-eae3-7080-8f02-da27fc260e09). */
export function hasHumanManager(file: AccessFile): boolean {
	return file.members.some(isHumanManager)
}

function assertRole(role: unknown): AccessRole {
	if (!isAccessRole(role)) throw new AccessError('access.invalid_role', `Role must be one of owner, editor, reviewer or viewer (received ${JSON.stringify(role)}).`)
	return role
}

const keyList = (keys: readonly string[]) => keys.map(key => `\`${key}\``).join(', ')

/**
 * An explicit key set: an array of permission key names (Clause
 * 01a11c09-a200-754a-ac85-48b52dfe7bdc), stored once each, catalog keys in catalog order and then
 * any key unknown to this version, which is kept (Rule 01a11c09-b7ec-786f-9723-eda32404d421).
 */
export function normalizeKeys(value: unknown): string[] {
	if (!Array.isArray(value)) throw new AccessError('access.invalid_keys', 'Keys must be an array of permission key names.')
	const invalid = value.filter(key => !isPermissionKeyName(key))
	if (invalid.length > 0)
		throw new AccessError('access.invalid_keys', `${invalid.map(key => JSON.stringify(key)).join(', ')} ${invalid.length > 1 ? 'are not permission key names' : 'is not a permission key name'}: a key is <domain>.<capability>, such as views.write.`)
	const unique = [...new Set(value as string[])]
	return [...inCatalogOrder(unique.filter(isCatalogKey)), ...unique.filter(key => !isCatalogKey(key))]
}

/**
 * Clause 01a11c09-a349-721b-bef5-ef7e63954bb6: a key set is stored only when it gives an Agent no
 * `humanOnly` key (`access.key_human_only`, Rule 01a11485-eac6-730b-b66b-309cc9efb169) and holds
 * every requirement of each key in it (`access.key_requires`, Rule
 * 01a11c09-b707-7138-91af-0542ea1b8b89); each refusal names the offending keys.
 */
export function assertStorableKeys(member: Readonly<{ nickname: string; kind: MemberKind; keys: readonly string[] }>): void {
	const humanOnly = member.kind === 'agent' ? member.keys.filter(isHumanOnlyKey) : []
	if (humanOnly.length > 0)
		throw new AccessError('access.key_human_only', `${member.nickname} is an Agent and cannot hold ${keyList(humanOnly)}: ${humanOnly.length > 1 ? 'these keys are' : 'this key is'} humanOnly, for human members on a Workbench session.`)
	const gaps = missingRequirements(member.keys)
	if (gaps.length > 0)
		throw new AccessError('access.key_requires', `The keys of ${member.nickname} lack requirements: ${gaps.map(gap => `\`${gap.key}\` requires ${keyList(gap.missing)}`).join('; ')}.`)
}

function sameKeys(left: readonly string[], right: readonly string[]): boolean {
	const set = new Set(left)
	return set.size === new Set(right).size && right.every(key => set.has(key))
}

/**
 * The invariants of a roster write, checked against the roster it replaces (`before`):
 * - each new member, and each member whose kind or keys change, has a storable key set
 *   (`assertStorableKeys`); an unchanged member keeps its keys, so a set written by hand that
 *   lacks a requirement stays as it is and grants only the keys it lists (Rule
 *   01a11c09-b779-7f5f-ba47-170a584a09ce);
 * - a write that would leave no human member holding `members.manage` where one held it is
 *   refused with `access.last_manager` (Rule 01a11485-eae3-7080-8f02-da27fc260e09, Clause
 *   01a114ec-ea2d-7f54-97d1-f981d48795fb), whether it removes a member or changes keys. A roster
 *   that has no such member yet (a new roster, or one with Agents only) is not refused for it:
 *   `uiux dev` bootstraps its manager (Rule 01a11485-eb1a-77fb-a91e-b54c505344da).
 */
export function assertRosterWrite(before: AccessFile | undefined, after: AccessFile): void {
	const previous = new Map((before?.members ?? []).map(member => [member.id, member]))
	for (const member of after.members) {
		const prior = previous.get(member.id)
		if (prior && prior.kind === member.kind && sameKeys(prior.keys, member.keys)) continue
		assertStorableKeys(member)
	}
	if (!before || hasHumanManager(after)) return
	const lost = before.members.filter(isHumanManager)
	if (lost.length === 0) return
	const names = lost.map(member => member.nickname).join(', ')
	throw new AccessError('access.last_manager', `${names} ${lost.length > 1 ? 'are the last human holders' : 'is the last human holder'} of \`members.manage\` in this roster; this change would leave none. Give another human member \`members.manage\` first.`)
}

/**
 * The key set a member write asks for: explicit `keys`, or a `role`, which the CLI's `--role` and
 * the Members page still send and which stands for the keys of the built-in preset with that
 * `id` (Clause 01a11bb1-b427-777e-8175-fa24d61d434b), without `humanOnly` keys for an Agent. An
 * Agent asking for the Owner role is refused: its keys are the human-only administration keys.
 */
function requestedKeys(kind: MemberKind, nickname: string, input: Readonly<{ keys?: unknown; role?: unknown }>): string[] | undefined {
	if (input.keys !== undefined && input.role !== undefined) throw new AccessError('access.invalid_keys', 'Give either keys or a role, not both.')
	if (input.keys !== undefined) return normalizeKeys(input.keys)
	if (input.role === undefined) return undefined
	const role = assertRole(input.role)
	if (kind === 'agent' && role === 'owner')
		assertStorableKeys({ nickname, kind, keys: keysForRole('human', 'owner') })
	return [...keysForRole(kind, role)]
}

export type Mutation<T> = Readonly<{ file: AccessFile; result: T }>

export type MemberAccessInput = Readonly<{ keys?: unknown; role?: unknown }>

export function addMember(
	file: AccessFile,
	input: Readonly<{ nickname: string; kind?: unknown } & MemberAccessInput>,
	now: Date = new Date(),
): Mutation<StoredMember> {
	const nickname = assertNickname(input.nickname)
	const kind = input.kind ?? 'human'
	if (!isMemberKind(kind)) throw new AccessError('access.invalid_kind', `Kind must be human or agent (received ${JSON.stringify(kind)}).`)
	const keys = requestedKeys(kind, nickname, input)
	if (keys === undefined) throw new AccessError('access.invalid_keys', `A new member needs its keys (or a role) (received none for ${nickname}).`)
	if (findMemberByNickname(file, nickname)) throw new AccessError('access.nickname_taken', `Nickname ${JSON.stringify(nickname)} is already used in this roster.`)
	const member: StoredMember = { id: randomUUID(), nickname, kind, keys, createdAt: now.toISOString() }
	const next: AccessFile = { ...file, members: [...file.members, member] }
	assertRosterWrite(file, next)
	return { file: next, result: member }
}

export function setMember(
	file: AccessFile,
	nickname: string,
	changes: Readonly<{ nickname?: string; kind?: unknown } & MemberAccessInput>,
): Mutation<StoredMember> {
	const member = requireMember(file, nickname)
	// Rule 01a11485-ea75-7964-bc21-29aa78049abf: the kind is fixed at creation.
	if (changes.kind !== undefined && changes.kind !== member.kind)
		throw new AccessError('access.kind_immutable', 'A member\'s kind is fixed at creation and cannot be changed.')
	let next: StoredMember = member
	const keys = requestedKeys(member.kind, member.nickname, changes)
	if (keys !== undefined) {
		// Writing a member's keys stores them anew, so they must be storable even when unchanged.
		assertStorableKeys({ nickname: member.nickname, kind: member.kind, keys })
		next = { ...next, keys }
	}
	if (changes.nickname !== undefined && changes.nickname !== member.nickname) {
		const renamed = assertNickname(changes.nickname)
		const clash = findMemberByNickname(file, renamed)
		if (clash && clash.id !== member.id) throw new AccessError('access.nickname_taken', `Nickname ${JSON.stringify(renamed)} is already used in this roster.`)
		next = { ...next, nickname: renamed }
	}
	const written: AccessFile = { ...file, members: file.members.map(item => item.id === member.id ? next : item) }
	assertRosterWrite(file, written)
	return { file: written, result: next }
}

export function removeMember(file: AccessFile, nickname: string): Mutation<StoredMember> {
	const member = requireMember(file, nickname)
	const next: AccessFile = {
		...file,
		members: file.members.filter(item => item.id !== member.id),
		tokens: file.tokens.filter(item => item.memberId !== member.id),
		invites: file.invites.filter(item => item.memberId !== member.id),
		sessions: file.sessions.filter(item => item.memberId !== member.id),
	}
	assertRosterWrite(file, next)
	return { file: next, result: member }
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

/**
 * `uiux access copy`: members and tokens (hashes included), a new hint and root, no invites or
 * sessions. The copy is always `version: 2`: a `version: 1` source is read through its upgrade
 * (Clause 01a1144e-56bd-7988-8d2a-87b23954ca49).
 */
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

/**
 * A member as roster administration lists it. `role` is derived from the stored keys
 * (`compatibilityRole`) for the Members page and `uiux member list`, which still show roles until
 * they show keys and labels (issue #142).
 */
export type MemberSummary = Readonly<{
	id: string
	nickname: string
	kind: MemberKind
	role: AccessRole
	createdAt: string
	activeTokens: number
	activeSessions: number
}>

export function summarizeMembers(file: AccessFile, now: number): readonly MemberSummary[] {
	return file.members.map(member => ({
		id: member.id,
		nickname: member.nickname,
		kind: member.kind,
		role: compatibilityRole(member),
		createdAt: member.createdAt,
		activeTokens: file.tokens.filter(token => token.memberId === member.id && isTokenActive(token, now)).length,
		activeSessions: file.sessions.filter(session => session.memberId === member.id && isSessionActive(session, now)).length,
	}))
}
