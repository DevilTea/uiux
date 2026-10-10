import { createHash } from 'node:crypto'
import { userInfo } from 'node:os'

import { keysForRole, writeKeyForKind } from '../../application/access/keys'
import type { LeaseManager } from '../../application/access/leases'
import {
	effectiveRole,
	type MemberPrincipal,
	type Principal,
	type SystemPrincipal,
	type SystemPrincipalId,
} from '../../application/access/principal'
import { isLoopbackHostname } from '../network-access'
import { generateCredential, parseCredential, sessionCookieName } from './credentials'
import {
	AccessError,
	addMember,
	applyUsage,
	createInvite,
	createToken,
	hasHumanOwner,
	isSessionActive,
	isTokenActive,
	loginWithCredential,
	removeMember,
	revokeSessions,
	revokeToken,
	sanitizeNickname,
	setMember,
	summarizeMembers,
	verifyCredential,
	SESSION_ABSOLUTE_MS,
	type AccessFile,
	type MemberSummary,
	type Mutation,
	type StoredMember,
	type StoredSession,
	type StoredToken,
} from './roster'
import type { AccessStore } from './store'

/**
 * The live server's view of its Workspace roster: authentication of every request, sign-in,
 * the in-memory system principals, rate limiting, the "MCP clients without a token" notice and
 * Owner administration (accepted identity decisions 1-4, 8, 10 and 12).
 */
export type AuthSurface = 'api' | 'mcp'

/** The origin a request's `Host` matched (see `MatchedOrigin` in `src/server/loopback-guard.ts`). */
export type RequestOrigin = Readonly<{ origin: string; loopbackHost: boolean }>

export type AuthenticateInput = Readonly<{
	surface: AuthSurface
	authorization?: string
	cookieHeader?: string
	remoteAddress?: string
	userAgent?: string
	/** The matched origin; a session cookie is accepted only on the origin it was created on, and never without one. */
	origin?: RequestOrigin
}>

export type AuthFailureCode = 'auth.required' | 'auth.invalid_credential' | 'auth.rate_limited'

export type AuthFailure = Readonly<{
	ok: false
	status: 401 | 429
	code: AuthFailureCode
	message: string
	/** The presented session cookie is no longer valid; the response should clear it. */
	clearCookie?: boolean
	retryAfterSeconds?: number
}>

export type AuthResult = Readonly<{ ok: true; principal: Principal }> | AuthFailure

/** A rejected `/mcp` attempt, with the origin its `Host` matched (Rule 01a11485-ed7e-7866-bec2-6deca0ec6cb1). */
export type McpAttempt = Readonly<{ at: string; userAgent: string; origin: string; code: AuthFailureCode }>

export type AccessServiceOptions = Readonly<{
	store: AccessStore
	leases: LeaseManager
	now?: () => number
	/** Shown in 401 messages; defaults to the Workspace root. */
	workspaceLabel?: string
}>

const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 10
const USAGE_FLUSH_MS = 60_000
const MAX_MCP_ATTEMPTS = 50

export const SESSION_COOKIE_MAX_AGE_SECONDS = Math.floor(SESSION_ABSOLUTE_MS / 1000)

export class AccessService {
	readonly store: AccessStore
	private readonly leases: LeaseManager
	private readonly now: () => number
	private readonly system = new Map<string, SystemPrincipal>()
	private readonly failures = new Map<string, Map<string, number>>()
	private readonly tokenUsage = new Map<string, number>()
	private readonly sessionUsage = new Map<string, number>()
	private readonly flushedAt = new Map<string, number>()
	private flushing: Promise<void> | undefined
	private readonly attempts: McpAttempt[] = []
	private attemptCount = 0
	readonly captureCredential: string

	constructor(options: AccessServiceOptions) {
		this.store = options.store
		this.leases = options.leases
		this.now = options.now ?? (() => Date.now())
		this.captureCredential = generateCredential('session', this.store.data.hint).value
		this.system.set(this.captureCredential, systemPrincipal('system:capture'))
	}

	get hint(): string {
		return this.store.data.hint
	}

	get cookieName(): string {
		return sessionCookieName(this.store.data.hint)
	}

	get workspaceRoot(): string {
		return this.store.data.workspaceRoot
	}

	/** Re-reads the roster when it changed on disk, then drops leases of removed members and lost write keys. */
	async refresh(force = false): Promise<void> {
		const changed = await this.store.refresh({ force })
		if (changed) this.reconcileLeases()
	}

	/**
	 * Rule 01a11485-f074-7d3c-80f4-f4ced35ef8f2: a lease ends when its holder is removed or loses the
	 * write key of the leased resource's kind (Clause 01a11c09-a42a-7d6b-bb5e-01d7cf1ce2de).
	 */
	private reconcileLeases(): void {
		const members = new Map(this.store.data.members.map(member => [member.id, member]))
		for (const lease of this.leases.list()) {
			const member = members.get(lease.holder.memberId)
			const writeKey = writeKeyForKind(lease.kind)
			if (!member || !writeKey || !memberKeys(member).includes(writeKey)) this.leases.forceRelease(lease)
		}
	}

	private async mutate<T>(mutation: (file: AccessFile) => Mutation<T>): Promise<T> {
		const result = await this.store.update(mutation)
		this.reconcileLeases()
		return result
	}

	private rateLimited(address: string): boolean {
		const entries = this.failures.get(address)
		if (!entries) return false
		const cutoff = this.now() - RATE_WINDOW_MS
		for (const [key, at] of entries) if (at <= cutoff) entries.delete(key)
		if (entries.size === 0) this.failures.delete(address)
		return entries.size >= RATE_LIMIT
	}

	/** Counts distinct failed credentials per address, so a stale credential retried does not lock anyone out. */
	private recordFailure(address: string, presented: string): void {
		const entries = this.failures.get(address) ?? new Map<string, number>()
		entries.set(createHash('sha256').update(presented).digest('hex'), this.now())
		this.failures.set(address, entries)
	}

	private rateLimitFailure(): AuthFailure {
		return { ok: false, status: 429, code: 'auth.rate_limited', message: 'Too many failed sign-in attempts from this address. Wait a minute and try again.', retryAfterSeconds: 60 }
	}

	private invalid(presented: string, surface: AuthSurface, clearCookie = false): AuthFailure {
		const parsed = parseCredential(presented)
		const foreign = parsed && parsed.hint !== this.hint && !this.isKnownId(parsed.id)
		const message = foreign
			? `This credential belongs to roster ${parsed.hint}; this server serves roster ${this.hint}. Create a ${surface === 'mcp' ? 'token' : 'credential'} for this Workspace, or run uiux access copy.`
			: surface === 'mcp'
				? `The bearer token is malformed, unknown, expired or revoked. Create a token with \`uiux token create --workspace ${this.workspaceRoot} --member <agent>\` and send it as \`Authorization: Bearer <token>\`.`
				: 'The credential is malformed, unknown, expired or revoked. Sign in again.'
		return { ok: false, status: 401, code: 'auth.invalid_credential', message, ...(clearCookie ? { clearCookie } : {}) }
	}

	private isKnownId(id: string): boolean {
		const file = this.store.data
		return file.tokens.some(item => item.id === id) || file.sessions.some(item => item.id === id) || file.invites.some(item => item.id === id)
	}

	private required(surface: AuthSurface): AuthFailure {
		return {
			ok: false,
			status: 401,
			code: 'auth.required',
			message: surface === 'mcp'
				? `/mcp requires a bearer token. Create a token with \`uiux token create --workspace ${this.workspaceRoot} --member <agent>\` and send it as \`Authorization: Bearer <token>\`.`
				: 'Sign in to the UIUX Workbench, or send Authorization: Bearer <token>.',
		}
	}

	private recordMcpAttempt(code: AuthFailureCode, userAgent: string | undefined, origin: RequestOrigin | undefined): void {
		this.attemptCount += 1
		this.attempts.push({ at: new Date(this.now()).toISOString(), userAgent: (userAgent ?? '').slice(0, 200), origin: origin?.origin ?? '', code })
		if (this.attempts.length > MAX_MCP_ATTEMPTS) this.attempts.splice(0, this.attempts.length - MAX_MCP_ATTEMPTS)
	}

	mcpAttempts(): Readonly<{ total: number; recent: readonly McpAttempt[] }> {
		return { total: this.attemptCount, recent: [...this.attempts].reverse() }
	}

	async authenticate(input: AuthenticateInput): Promise<AuthResult> {
		const result = await this.authenticateInner(input)
		if (!result.ok && input.surface === 'mcp') this.recordMcpAttempt(result.code, input.userAgent, input.origin)
		return result
	}

	private async authenticateInner(input: AuthenticateInput): Promise<AuthResult> {
		await this.refresh()
		const address = input.remoteAddress ?? 'unknown'
		const bearer = parseBearer(input.authorization)
		const cookie = input.surface === 'api' ? readCookie(input.cookieHeader, this.cookieName) : undefined
		const presented = bearer.value ?? cookie
		if (bearer.malformed) {
			if (this.rateLimited(address)) return this.rateLimitFailure()
			this.recordFailure(address, input.authorization ?? '')
			return this.invalid('', input.surface)
		}
		if (presented === undefined) return this.required(input.surface)

		// System credentials: in-memory, read routes only, never on /mcp. They are exact in-process
		// secrets, so the per-address limiter (shared by every loopback client) never blocks them.
		const system = this.system.get(presented)
		if (system) {
			if (input.surface === 'mcp') return this.invalid(presented, input.surface)
			return { ok: true, principal: system }
		}
		if (this.rateLimited(address)) return this.rateLimitFailure()

		const now = this.now()
		let verification = verifyCredential(this.store.data, presented, now, { lastSeen: id => this.sessionUsage.get(id) })
		// A credential of this roster that is not known yet was usually just created by the CLI
		// (reloads are throttled to once a second): re-read the store once before refusing it.
		if (!verification.ok && verification.reason === 'unknown' && parseCredential(presented)?.hint === this.hint) {
			await this.refresh(true)
			verification = verifyCredential(this.store.data, presented, now, { lastSeen: id => this.sessionUsage.get(id) })
		}
		const expectedKind = bearer.value !== undefined ? 'token' : 'session'
		if (!verification.ok || verification.kind !== expectedKind) {
			this.recordFailure(address, presented)
			return this.invalid(presented, input.surface, bearer.value === undefined)
		}
		if (verification.kind === 'token') {
			this.recordUsage(this.tokenUsage, verification.token!.id, now)
			return { ok: true, principal: memberPrincipal(verification.member, 'token', verification.token!.id) }
		}
		// A session belongs to the origin where it was created (Rule 01a11485-ed4a-766b-a51c-af2b9ffb1fcb):
		// a cookie presented on another origin, or with no matched origin, authenticates nothing. It is
		// not a guess, so it does not count toward the rate limit, and the cookie is kept for its own origin.
		if (!input.origin || !sessionServesOrigin(verification.session!, input.origin))
			return { ok: false, status: 401, code: 'auth.invalid_credential', message: 'This session was created on another origin of this server. Sign in again here.' }
		this.recordUsage(this.sessionUsage, verification.session!.id, now)
		return { ok: true, principal: memberPrincipal(verification.member, 'session', verification.session!.id) }
	}

	private recordUsage(map: Map<string, number>, id: string, now: number): void {
		map.set(id, now)
		if (now - (this.flushedAt.get(id) ?? 0) < USAGE_FLUSH_MS) return
		this.flushedAt.set(id, now)
		void this.flushUsage()
	}

	/** Writes buffered `lastUsedAt` / `lastSeenAt` (at most once a minute per credential). */
	async flushUsage(): Promise<void> {
		if (!this.store.persistent) return
		if (this.flushing) return this.flushing
		const tokens = new Map(this.tokenUsage)
		const sessions = new Map(this.sessionUsage)
		this.flushing = this.store.update(file => ({ file: applyUsage(file, { tokens, sessions }), result: undefined }))
			.catch((error: unknown) => { console.warn(`uiux: could not record credential usage: ${error instanceof Error ? error.message : String(error)}`) })
			.finally(() => { this.flushing = undefined })
		return this.flushing
	}

	/** `POST /api/session/login`: an invite (single use) or a member token becomes a fresh session. */
	async login(credential: unknown, meta: Readonly<{ remoteAddress?: string; userAgent?: string; origin: string }>): Promise<
		| Readonly<{ ok: true; member: StoredMember; cookieValue: string; cookieName: string; maxAgeSeconds: number }>
		| AuthFailure
	> {
		await this.refresh()
		const address = meta.remoteAddress ?? 'unknown'
		if (typeof credential !== 'string' || credential.trim() === '') return this.required('api')
		const presented = credential.trim()
		if (this.rateLimited(address)) return this.rateLimitFailure()
		let check = verifyCredential(this.store.data, presented, this.now())
		if (!check.ok && check.reason === 'unknown' && parseCredential(presented)?.hint === this.hint) {
			await this.refresh(true)
			check = verifyCredential(this.store.data, presented, this.now())
		}
		if (!check.ok || check.kind === 'session') {
			this.recordFailure(address, presented)
			return this.invalid(presented, 'api')
		}
		try {
			const outcome = await this.mutate<Readonly<{ member: StoredMember; cookieValue: string }>>((file) => {
				const fresh = verifyCredential(file, presented, this.now())
				if (!fresh.ok || fresh.kind === 'session') throw new AccessError('access.store_invalid', 'credential no longer valid')
				return loginWithCredential(file, fresh, { origin: meta.origin, userAgent: meta.userAgent ?? '' }, new Date(this.now()))
			})
			return { ok: true, member: outcome.member, cookieValue: outcome.cookieValue, cookieName: this.cookieName, maxAgeSeconds: SESSION_COOKIE_MAX_AGE_SECONDS }
		}
		catch (error) {
			if (error instanceof AccessError && error.code === 'access.store_invalid') {
				this.recordFailure(address, presented)
				return this.invalid(presented, 'api')
			}
			throw error
		}
	}

	async logout(principal: Principal): Promise<void> {
		if (principal.type !== 'member' || principal.credential !== 'session') return
		await this.mutate(file => {
			try { return revokeSessions(file, { sessionId: principal.credentialId }) }
			catch { return { file, result: [] } }
		})
		this.sessionUsage.delete(principal.credentialId)
	}

	/**
	 * First-run bootstrap (decision 8): when the roster has no human Owner, create one named after
	 * the OS user and mint a 24-hour single-use invite. Returns the banner lines, or undefined.
	 */
	async bootstrap(origins: readonly string[]): Promise<readonly string[] | undefined> {
		await this.refresh(true)
		if (hasHumanOwner(this.store.data)) return undefined
		let username: string | undefined
		try { username = userInfo().username }
		catch { username = undefined }
		const outcome = await this.mutate<Readonly<{ nickname: string; invite: string; created: boolean }>>((file) => {
			if (hasHumanOwner(file)) return { file, result: { nickname: '', invite: '', created: false } }
			let nickname = sanitizeNickname(username)
			if (file.members.some(member => member.nickname === nickname)) nickname = uniqueNickname(file, nickname)
			const added = addMember(file, { nickname, role: 'owner', kind: 'human' }, new Date(this.now()))
			const invite = createInvite(added.file, { nickname }, new Date(this.now()))
			return { file: invite.file, result: { nickname, invite: invite.result.credential, created: true } }
		})
		if (!outcome.created) return undefined
		const root = this.workspaceRoot
		return [
			`UIUX access: created Owner "${outcome.nickname}" for ${root} (roster ${this.hint}, first run).`,
			// One single-use invite, offered on the loopback URL and on each configured origin (Rule 01a12515-9c61-7916-a0d0-4bcf2537dfc9).
			origins.length > 1
				? '  Sign in on any one of these (one single-use invite, expires in 24 h):'
				: '  Sign in (single use, expires in 24 h):',
			...origins.map(origin => `    ${origin}/login#${outcome.invite}`),
			'/mcp requires a token. For an agent:',
			`  uiux member add claude --workspace ${root} --kind agent --role editor`,
			`  uiux token create --workspace ${root} --member claude`,
			'Moved, renamed, or a git worktree? Reuse the old roster instead:',
			`  uiux access copy --from <old-dir> --workspace ${root} --replace`,
		]
	}

	// ---- Owner administration (loopback, human Owner, cookie session) ----

	roster(): Readonly<{ workspaceRoot: string; hint: string; members: readonly MemberSummary[] }> {
		return { workspaceRoot: this.workspaceRoot, hint: this.hint, members: summarizeMembers(this.store.data, this.now()) }
	}

	tokens(): readonly (Omit<StoredToken, 'hash'> & Readonly<{ member: string; active: boolean }>)[] {
		const file = this.store.data
		const now = this.now()
		return file.tokens.map(({ hash: _hash, ...token }) => {
			void _hash
			const lastUsed = this.tokenUsage.get(token.id)
			return {
				...token,
				lastUsedAt: lastUsed && (!token.lastUsedAt || Date.parse(token.lastUsedAt) < lastUsed) ? new Date(lastUsed).toISOString() : token.lastUsedAt,
				member: file.members.find(member => member.id === token.memberId)?.nickname ?? '(removed)',
				active: isTokenActive({ ...token, hash: '' }, now),
			}
		})
	}

	sessions(currentSessionId?: string) {
		const file = this.store.data
		const now = this.now()
		return file.sessions
			.filter(session => isSessionActive(session, now, this.sessionUsage.get(session.id)))
			.map(({ hash: _hash, ...session }) => {
				void _hash
				const seen = this.sessionUsage.get(session.id)
				return {
					...session,
					lastSeenAt: seen && Date.parse(session.lastSeenAt) < seen ? new Date(seen).toISOString() : session.lastSeenAt,
					member: file.members.find(member => member.id === session.memberId)?.nickname ?? '(removed)',
					current: session.id === currentSessionId,
				}
			})
	}

	addMember(input: Readonly<{ nickname: string; role: unknown; kind?: unknown }>) {
		return this.mutate<StoredMember>(file => addMember(file, input, new Date(this.now())))
	}

	setMember(memberId: string, changes: Readonly<{ role?: unknown; nickname?: string; kind?: unknown }>) {
		return this.mutate<StoredMember>(file => setMember(file, nicknameOf(file, memberId), changes))
	}

	removeMember(memberId: string) {
		return this.mutate<StoredMember>(file => removeMember(file, nicknameOf(file, memberId)))
	}

	createToken(input: Readonly<{ memberId: string; label?: string; expiresInDays?: number | null }>) {
		return this.mutate<Readonly<{ entry: StoredToken; credential: string }>>(file => createToken(file, { ...input, nickname: nicknameOf(file, input.memberId) }, new Date(this.now())))
	}

	revokeToken(tokenId: string) {
		return this.mutate<StoredToken>(file => revokeToken(file, tokenId, new Date(this.now())))
	}

	createInvite(input: Readonly<{ memberId: string; expiresInHours?: number }>) {
		return this.mutate<Readonly<{ credential: string; entry: { expiresAt: string } }>>(file => createInvite(file, { ...input, nickname: nicknameOf(file, input.memberId) }, new Date(this.now())))
	}

	revokeSession(sessionId: string) {
		return this.mutate(file => revokeSessions(file, { sessionId }))
	}

	member(memberId: string): StoredMember | undefined {
		return this.store.data.members.find(member => member.id === memberId)
	}
}

function nicknameOf(file: AccessFile, memberId: string): string {
	const member = file.members.find(item => item.id === memberId)
	if (!member) throw new AccessError('access.member_not_found', `No member with id ${JSON.stringify(memberId)} in this Workspace's roster.`)
	return member.nickname
}

function uniqueNickname(file: AccessFile, base: string): string {
	for (let index = 2; ; index += 1) {
		const candidate = `${base.slice(0, 28)}-${index}`
		if (!file.members.some(member => member.nickname === candidate)) return candidate
	}
}

export function systemPrincipal(id: SystemPrincipalId): SystemPrincipal {
	return { type: 'system', id, credential: 'system' }
}

/**
 * A member's permission keys, derived from its roster `role` through the built-in Access preset
 * of that `id` (Clause 01a11bb1-b427-777e-8175-fa24d61d434b), with no `humanOnly` key for an
 * Agent, until the roster stores keys (issue #142).
 */
export function memberKeys(member: Pick<StoredMember, 'kind' | 'role'>) {
	return keysForRole(member.kind, member.role)
}

export function memberPrincipal(member: StoredMember, credential: 'session' | 'token', credentialId: string): MemberPrincipal {
	return {
		type: 'member',
		memberId: member.id,
		nickname: member.nickname,
		kind: member.kind,
		role: effectiveRole(member.kind, member.role),
		keys: memberKeys(member),
		credential,
		credentialId,
	}
}

function isLoopbackOrigin(origin: string): boolean {
	try { return isLoopbackHostname(new URL(origin).hostname) }
	catch { return false }
}

/**
 * Whether a session serves a request on `origin`. Loopback sessions (a loopback host name, or a
 * session written before configured origins existed) serve every loopback origin, where the
 * browser already keeps one cookie per host name; a session created on any other origin serves
 * only that origin.
 */
export function sessionServesOrigin(session: StoredSession, origin: RequestOrigin): boolean {
	if (session.origin === undefined) return session.listener === 'loopback' && origin.loopbackHost
	if (origin.loopbackHost && isLoopbackOrigin(session.origin)) return true
	return session.origin === origin.origin
}

function parseBearer(header: string | undefined): { value?: string; malformed: boolean } {
	if (header === undefined || header.trim() === '') return { malformed: false }
	const match = /^Bearer\s+(\S+)\s*$/iu.exec(header.trim())
	if (!match) return { malformed: true }
	return { value: match[1], malformed: false }
}

export function readCookie(header: string | undefined, name: string): string | undefined {
	if (!header) return undefined
	for (const part of header.split(';')) {
		const index = part.indexOf('=')
		if (index < 0) continue
		if (part.slice(0, index).trim() === name) {
			const value = part.slice(index + 1).trim()
			return value === '' ? undefined : value
		}
	}
	return undefined
}
