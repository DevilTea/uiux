import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
	CREDENTIAL_PATTERN,
	credentialMatchesHash,
	generateCredential,
	hashCredential,
	parseCredential,
	redactCredentials,
	sessionCookieName,
} from '../src/server/access/credentials'
import {
	AccessError,
	addMember,
	applyUsage,
	copyRoster,
	createEmptyAccessFile,
	createInvite,
	createToken,
	loginWithCredential,
	removeMember,
	revokeSessions,
	revokeToken,
	sanitizeNickname,
	setMember,
	validateAccessFile,
	verifyCredential,
	DAY_MS,
	SESSION_IDLE_MS,
	type AccessFile,
} from '../src/server/access/roster'
import { sessionServesOrigin } from '../src/server/access/service'
import { AccessStore, accessStorePaths, workspaceStoreId } from '../src/server/access/store'

const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function tempDir(prefix: string): Promise<string> {
	const path = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	cleanup.push(path)
	return path
}

async function workspaceAndHome() {
	const base = await tempDir('uiux-access-')
	const workspace = join(base, 'ws')
	await mkdir(join(workspace, '.uiux'), { recursive: true })
	await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
	const home = join(base, 'home')
	return { base, workspace, home }
}

const NOW = new Date('2026-10-05T12:00:00Z')

function rosterWithOwner(): AccessFile {
	let file = createEmptyAccessFile('/work/design', 'k3x7')
	file = addMember(file, { nickname: 'deviltea', role: 'owner' }, NOW).file
	file = addMember(file, { nickname: 'claude', role: 'editor', kind: 'agent' }, NOW).file
	return file
}

function expectAccessError(run: () => unknown, code: string) {
	try {
		run()
	}
	catch (error) {
		expect(error).toBeInstanceOf(AccessError)
		expect((error as AccessError).code).toBe(code)
		return
	}
	throw new Error(`Expected AccessError ${code}`)
}

describe('credential format', () => {
	it('mints fixed-shape lowercase base32 credentials and stores only their sha256', () => {
		for (const kind of ['token', 'invite', 'session'] as const) {
			const credential = generateCredential(kind, 'k3x7')
			expect(credential.value).toMatch(CREDENTIAL_PATTERN)
			expect(credential.value).toMatch(new RegExp(`^uiux_${kind[0]}_k3x7_[a-z2-7]{10}_[a-z2-7]{52}$`, 'u'))
			expect(parseCredential(credential.value)).toEqual({ kind, hint: 'k3x7', id: credential.id, value: credential.value })
			expect(credential.hash).toBe(hashCredential(credential.value))
			expect(credential.hash).toMatch(/^sha256:[0-9a-f]{64}$/u)
			expect(credentialMatchesHash(credential.value, credential.hash)).toBe(true)
			expect(credentialMatchesHash(`${credential.value.slice(0, -1)}a`, credential.hash)).toBe(credential.value.endsWith('a'))
		}
		expect(parseCredential('uiux_t_K3X7_aaaaaaaaaa_' + 'a'.repeat(52))).toBeUndefined()
		expect(parseCredential('uiux_x_k3x7_aaaaaaaaaa_' + 'a'.repeat(52))).toBeUndefined()
		expect(parseCredential('uiux_t_k3x7_aaaaaaaaaa_' + 'a'.repeat(51))).toBeUndefined()
		expect(sessionCookieName('k3x7')).toBe('uiux_session_k3x7')
	})

	it('redacts credentials, Authorization values and session cookies from log text', () => {
		const token = generateCredential('token', 'k3x7').value
		const text = `request Authorization: Bearer ${token} cookie uiux_session_k3x7=abc123; other=1 body ${token}`
		const redacted = redactCredentials(text)
		expect(redacted).not.toContain(token)
		expect(redacted).not.toContain('abc123')
		expect(redacted).toContain('uiux_session_k3x7=<redacted>')
		expect(redactCredentials('{"authorization":"Bearer secret-value"}')).not.toContain('secret-value')
	})
})

describe('roster rules', () => {
	it('enforces nickname shape and case-insensitive uniqueness, and sanitizes OS user names', () => {
		const file = rosterWithOwner()
		expectAccessError(() => addMember(file, { nickname: 'Bad Name', role: 'viewer' }), 'access.invalid_nickname')
		expectAccessError(() => addMember(file, { nickname: '-dash', role: 'viewer' }), 'access.invalid_nickname')
		expectAccessError(() => addMember(file, { nickname: 'a'.repeat(33), role: 'viewer' }), 'access.invalid_nickname')
		expectAccessError(() => addMember(file, { nickname: 'claude', role: 'viewer' }), 'access.nickname_taken')
		expectAccessError(() => addMember(file, { nickname: 'x', role: 'admin' }), 'access.invalid_role')
		expectAccessError(() => addMember(file, { nickname: 'x', role: 'viewer', kind: 'robot' }), 'access.invalid_kind')
		expect(addMember(file, { nickname: 'mei.l_2-x', role: 'reviewer' }).result).toMatchObject({ kind: 'human', role: 'reviewer' })
		expect(sanitizeNickname('William Chen')).toBe('william-chen')
		expect(sanitizeNickname('___')).toBe('owner')
		expect(sanitizeNickname(undefined)).toBe('owner')
	})

	it('caps agents at Editor, keeps kind immutable and protects the last human Owner', () => {
		const file = rosterWithOwner()
		expectAccessError(() => addMember(file, { nickname: 'bot', role: 'owner', kind: 'agent' }), 'access.agent_role_cap')
		expectAccessError(() => setMember(file, 'claude', { role: 'owner' }), 'access.agent_role_cap')
		expectAccessError(() => setMember(file, 'claude', { kind: 'human' }), 'access.kind_immutable')
		expectAccessError(() => setMember(file, 'deviltea', { role: 'editor' }), 'auth.last_owner')
		expectAccessError(() => removeMember(file, 'deviltea'), 'auth.last_owner')
		const withSecond = addMember(file, { nickname: 'mei', role: 'owner' }).file
		expect(setMember(withSecond, 'deviltea', { role: 'editor' }).result.role).toBe('editor')
		expect(setMember(file, 'claude', { nickname: 'claude-main' }).result.nickname).toBe('claude-main')
		expectAccessError(() => setMember(file, 'claude', { nickname: 'deviltea' }), 'access.nickname_taken')
		expectAccessError(() => setMember(file, 'ghost', { role: 'viewer' }), 'access.member_not_found')
	})

	it('issues 90-day tokens by default, honours --expires never, and verifies by id + hash', () => {
		const file = rosterWithOwner()
		const issued = createToken(file, { nickname: 'claude', label: 'laptop' }, NOW)
		expect(issued.result.entry).toMatchObject({ label: 'laptop', lastUsedAt: null, revokedAt: null, expiresAt: new Date(NOW.getTime() + 90 * DAY_MS).toISOString() })
		// The LAN flag is gone (Discussion #174): a Token works on every accepted origin.
		expect(issued.result.entry).not.toHaveProperty('lan')
		expect(JSON.stringify(issued.file)).not.toContain(issued.result.credential)
		expect(createToken(file, { nickname: 'claude', expiresInDays: null }, NOW).result.entry).toMatchObject({ expiresAt: null })
		expectAccessError(() => createToken(file, { nickname: 'claude', expiresInDays: 0 }, NOW), 'access.invalid_expiry')

		const now = NOW.getTime()
		const ok = verifyCredential(issued.file, issued.result.credential, now)
		expect(ok).toMatchObject({ ok: true, kind: 'token', member: { nickname: 'claude' } })
		expect(verifyCredential(issued.file, issued.result.credential, now + 91 * DAY_MS)).toMatchObject({ ok: false, reason: 'expired' })
		const revoked = revokeToken(issued.file, issued.result.entry.id, NOW).file
		expect(verifyCredential(revoked, issued.result.credential, now)).toMatchObject({ ok: false, reason: 'expired' })
		expect(verifyCredential(issued.file, 'nope', now)).toMatchObject({ ok: false, reason: 'malformed' })
		const forged = issued.result.credential.replace(/.$/u, c => c === 'a' ? 'b' : 'a')
		expect(verifyCredential(issued.file, forged, now)).toMatchObject({ ok: false, reason: 'unknown' })
		const foreign = generateCredential('token', 'zzzz').value
		expect(verifyCredential(issued.file, foreign, now)).toMatchObject({ ok: false, reason: 'unknown', foreignHint: 'zzzz' })
		// Removing a member removes its tokens, invites and sessions.
		const removed = removeMember(issued.file, 'claude').file
		expect(removed.tokens).toEqual([])
		expect(verifyCredential(removed, issued.result.credential, now).ok).toBe(false)
	})

	it('makes invites single-use, human-only and 24 hours by default, and mints fresh sessions with idle and absolute expiry', () => {
		const file = rosterWithOwner()
		expectAccessError(() => createInvite(file, { nickname: 'claude' }, NOW), 'access.invite_human_only')
		const invite = createInvite(file, { nickname: 'deviltea' }, NOW)
		expect(invite.result.entry.expiresAt).toBe(new Date(NOW.getTime() + DAY_MS).toISOString())
		const now = NOW.getTime()
		const verified = verifyCredential(invite.file, invite.result.credential, now)
		if (!verified.ok) throw new Error('invite should verify')
		const login = loginWithCredential(invite.file, verified, { origin: 'http://127.0.0.1:3000', userAgent: 'test' }, NOW)
		expect(login.result.cookieValue).toMatch(/^uiux_s_k3x7_/u)
		expect(verifyCredential(login.file, invite.result.credential, now)).toMatchObject({ ok: false, reason: 'expired' })
		// A token sign-in mints another fresh session and the token stays valid.
		const ownerToken = createToken(login.file, { nickname: 'deviltea' }, NOW)
		const byToken = verifyCredential(ownerToken.file, ownerToken.result.credential, now)
		if (!byToken.ok) throw new Error('token should verify')
		const second = loginWithCredential(ownerToken.file, byToken, { origin: 'https://uiux.corp.example', userAgent: 'x' }, NOW)
		expect(second.result.session.id).not.toBe(login.result.session.id)
		expect(verifyCredential(second.file, ownerToken.result.credential, now)).toMatchObject({ ok: true, kind: 'token' })
		expect(verifyCredential(invite.file, invite.result.credential, now + DAY_MS + 1)).toMatchObject({ ok: false, reason: 'expired' })

		const session = login.result
		expect(verifyCredential(login.file, session.cookieValue, now + SESSION_IDLE_MS - 1)).toMatchObject({ ok: true, kind: 'session' })
		expect(verifyCredential(login.file, session.cookieValue, now + SESSION_IDLE_MS + 1)).toMatchObject({ ok: false, reason: 'expired' })
		// In-memory last-seen keeps an active session alive up to the 30-day absolute limit.
		const lastSeen = () => now + 25 * DAY_MS
		expect(verifyCredential(login.file, session.cookieValue, now + 26 * DAY_MS, { lastSeen })).toMatchObject({ ok: true })
		expect(verifyCredential(login.file, session.cookieValue, now + 31 * DAY_MS, { lastSeen: () => now + 30 * DAY_MS })).toMatchObject({ ok: false })
		const flushed = applyUsage(login.file, { tokens: new Map(), sessions: new Map([[session.session.id, now + 5 * DAY_MS]]) })
		expect(flushed.sessions.find(item => item.id === session.session.id)?.lastSeenAt).toBe(new Date(now + 5 * DAY_MS).toISOString())
		expect(revokeSessions(login.file, { nickname: 'deviltea' }).file.sessions).toEqual([])
		expectAccessError(() => revokeSessions(login.file, { sessionId: 'aaaaaaaaaa' }), 'access.session_not_found')
	})

	it('copies members and token hashes, never invites or sessions, under a new hint and root', () => {
		let file = rosterWithOwner()
		const token = createToken(file, { nickname: 'claude' }, NOW)
		file = token.file
		file = createInvite(file, { nickname: 'deviltea' }, NOW).file
		const copied = copyRoster(file, { workspaceRoot: '/work/wt/design', hint: 'abcd' })
		expect(copied).toMatchObject({ workspaceRoot: '/work/wt/design', hint: 'abcd', invites: [], sessions: [] })
		expect(copied.members).toEqual(file.members)
		expect(copied.tokens.map(item => item.hash)).toEqual(file.tokens.map(item => item.hash))
		// A token minted under the old hint keeps working in the copy.
		expect(verifyCredential(copied, token.result.credential, NOW.getTime())).toMatchObject({ ok: true, member: { nickname: 'claude' } })
	})
})

describe('host-local access store', () => {
	it('lets Workspaces open their rosters concurrently under a fresh UIUX_HOME', async () => {
		const { base, home } = await workspaceAndHome()
		const roots = await Promise.all(Array.from({ length: 6 }, async (_, index) => {
			const root = join(base, `ws-${index}`)
			await mkdir(join(root, '.uiux'), { recursive: true })
			await writeFile(join(root, '.uiux', 'workspace.json'), '{}\n')
			return root
		}))
		const stores = await Promise.all(roots.map(workspaceRoot => AccessStore.open({ workspaceRoot, home, create: true })))
		expect(stores.every(store => !!store)).toBe(true)
		for (const dir of [home, join(home, 'workspaces')]) expect((await lstat(dir)).mode & 0o777).toBe(0o700)
	})

	it('keys the roster by sha256(realpath), writes 0700 directories and a 0600 file, and records the root', async () => {
		const { base, workspace, home } = await workspaceAndHome()
		const link = join(base, 'link')
		await symlink(workspace, link)
		const store = (await AccessStore.open({ workspaceRoot: link, home, create: true }))!
		expect(store.realRoot).toBe(workspace)
		const paths = accessStorePaths(home, workspace)
		expect(paths.dir).toBe(join(home, 'workspaces', workspaceStoreId(workspace)))
		for (const dir of [home, join(home, 'workspaces'), paths.dir]) expect((await lstat(dir)).mode & 0o777).toBe(0o700)
		expect((await lstat(paths.file)).mode & 0o777).toBe(0o600)
		const file = JSON.parse(await readFile(paths.file, 'utf8')) as AccessFile
		expect(file).toMatchObject({ version: 1, workspaceRoot: workspace, members: [], tokens: [], invites: [], sessions: [] })
		expect(file.hint).toMatch(/^[a-z2-7]{4}$/u)
		// Opening through the target shares the roster.
		expect((await AccessStore.open({ workspaceRoot: workspace, home }))!.data.hint).toBe(file.hint)
		expect(await AccessStore.open({ workspaceRoot: join(base, 'other'), home }).catch((error: AccessError) => error.code)).toBe('access.workspace_invalid')
	})

	it('keeps loading rosters written before configured origins: Token LAN flags and session listeners', async () => {
		const { workspace, home } = await workspaceAndHome()
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		const paths = accessStorePaths(home, workspace)
		let file = JSON.parse(await readFile(paths.file, 'utf8')) as AccessFile
		file = addMember(file, { nickname: 'deviltea', role: 'owner' }, NOW).file
		file = addMember(file, { nickname: 'claude', role: 'editor', kind: 'agent' }, NOW).file
		const token = createToken(file, { nickname: 'claude' }, NOW)
		const invite = createInvite(token.file, { nickname: 'deviltea' }, NOW)
		const verified = verifyCredential(invite.file, invite.result.credential, NOW.getTime())
		if (!verified.ok) throw new Error('invite should verify')
		const login = loginWithCredential(invite.file, verified, { origin: 'http://127.0.0.1:3000', userAgent: 'old' }, NOW)
		// The shape an earlier UIUX wrote: `lan` on every Token, `listener` instead of `origin` on sessions.
		const legacy = {
			...login.file,
			tokens: login.file.tokens.map(item => ({ ...item, lan: true })),
			sessions: login.file.sessions.map(item => ({ ...item, origin: undefined, listener: 'loopback' as const })),
		}
		await writeFile(paths.file, `${JSON.stringify(legacy, null, 2)}\n`)
		const reopened = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const now = NOW.getTime()
		expect(verifyCredential(reopened.data, token.result.credential, now)).toMatchObject({ ok: true, kind: 'token' })
		const session = verifyCredential(reopened.data, login.result.cookieValue, now)
		expect(session).toMatchObject({ ok: true, kind: 'session' })
		// A Token created with --lan behaves like any other; a legacy session is a loopback session.
		if (!session.ok) throw new Error('session should verify')
		expect(sessionServesOrigin(session.session!, { origin: 'http://localhost:3000', loopbackHost: true })).toBe(true)
		expect(sessionServesOrigin(session.session!, { origin: 'https://uiux.corp.example', loopbackHost: false })).toBe(false)
		expect(sessionServesOrigin({ ...session.session!, listener: 'lan' }, { origin: 'http://localhost:3000', loopbackHost: true })).toBe(false)
		// Writing keeps the legacy fields it does not understand, and new sessions carry their origin.
		await reopened.update(current => ({ file: current, result: undefined }))
		expect(JSON.parse(await readFile(paths.file, 'utf8')).tokens[0]).toMatchObject({ lan: true })

		const invalid = { ...legacy, sessions: legacy.sessions.map(item => ({ ...item, listener: undefined })) }
		expectAccessError(() => validateAccessFile(invalid), 'access.store_invalid')
		expectAccessError(() => validateAccessFile({ ...legacy, tokens: legacy.tokens.map(item => ({ ...item, lan: 'yes' })) }), 'access.store_invalid')
	})

	it('binds a session to the origin it was created on, with loopback origins sharing one scope', () => {
		const at = (origin: string) => ({ id: 'aaaaaaaaaa', memberId: '11111111-1111-4111-8111-111111111111', hash: '', origin, userAgent: '', createdAt: '', lastSeenAt: '', expiresAt: '' })
		const loopback = { origin: 'http://127.0.0.1:3000', loopbackHost: true }
		const proxied = { origin: 'https://uiux.corp.example', loopbackHost: false }
		const lan = { origin: 'http://10.0.0.5:3000', loopbackHost: false }
		expect(sessionServesOrigin(at('http://127.0.0.1:3000'), loopback)).toBe(true)
		// The browser keeps one cookie per host name, so a loopback session serves every loopback origin.
		expect(sessionServesOrigin(at('http://localhost:4000'), loopback)).toBe(true)
		expect(sessionServesOrigin(at('http://127.0.0.1:3000'), proxied)).toBe(false)
		expect(sessionServesOrigin(at('https://uiux.corp.example'), proxied)).toBe(true)
		expect(sessionServesOrigin(at('https://uiux.corp.example'), loopback)).toBe(false)
		// A cookie captured on a plain-HTTP origin authenticates nothing on the https origin.
		expect(sessionServesOrigin(at('http://10.0.0.5:3000'), proxied)).toBe(false)
		expect(sessionServesOrigin(at('http://10.0.0.5:3000'), lan)).toBe(true)
	})

	it('refuses symlinked or group/other-writable stores, a mismatched root and a UIUX_HOME inside the Workspace', async () => {
		const { base, workspace, home } = await workspaceAndHome()
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		const paths = accessStorePaths(home, workspace)

		await chmod(paths.file, 0o666)
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_unsafe' })
		await chmod(paths.file, 0o600)
		await chmod(paths.dir, 0o770)
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_unsafe' })
		await chmod(paths.dir, 0o700)

		const original = await readFile(paths.file, 'utf8')
		await writeFile(paths.file, original.replace(workspace, '/somewhere/else'))
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_root_mismatch' })
		await writeFile(paths.file, '{ not json')
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_invalid' })

		const linkedHome = join(base, 'linked-home')
		await symlink(home, linkedHome)
		await expect(AccessStore.open({ workspaceRoot: workspace, home: linkedHome })).rejects.toMatchObject({ code: 'access.store_unsafe' })

		await expect(AccessStore.open({ workspaceRoot: workspace, home: join(workspace, '.uiux-home'), create: true })).rejects.toMatchObject({ code: 'access.home_inside_workspace' })
		await expect(AccessStore.open({ workspaceRoot: workspace, home: workspace, create: true })).rejects.toMatchObject({ code: 'access.home_inside_workspace' })
	})

	it('serializes concurrent writers under the store lock and lets readers pick up changes on refresh', async () => {
		const { workspace, home } = await workspaceAndHome()
		const first = (await AccessStore.open({ workspaceRoot: workspace, home, create: true }))!
		const second = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		await Promise.all(Array.from({ length: 12 }, (_, index) => (index % 2 ? first : second).update(file => addMember(file, { nickname: `m${index}`, role: 'viewer' }))))
		await second.refresh({ force: true })
		await first.refresh({ force: true })
		expect(first.data.members.map(member => member.nickname).sort()).toEqual(Array.from({ length: 12 }, (_, index) => `m${index}`).sort())
		expect(second.data.members).toHaveLength(12)

		const reader = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		await first.update(file => removeMember(file, 'm0'))
		// Throttled: at most one stat per second, unless forced.
		expect(await reader.refresh()).toBe(false)
		expect(await reader.refresh({ force: true })).toBe(true)
		expect(reader.data.members).toHaveLength(11)
	})
})
