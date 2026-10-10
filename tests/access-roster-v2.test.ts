import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUILT_IN_ACCESS_PRESETS, HUMAN_ONLY_PERMISSION_KEYS, keysForRole, PERMISSION_KEYS } from '../src/application/access/keys'
import { compatibilityRole, memberLabel } from '../src/application/access/labels'
import { createLeaseManager } from '../src/application/access/leases'
import { authorizeOperation, effectiveKeys } from '../src/application/access/policy'
import { generateCredential, generateHint } from '../src/server/access/credentials'
import {
	AccessError,
	addMember,
	createEmptyAccessFile,
	createToken,
	readAccessFile,
	removeMember,
	setMember,
	validateAccessFile,
	verifyCredential,
	DAY_MS,
	type AccessFile,
	type StoredMember,
} from '../src/server/access/roster'
import { AccessService, memberPrincipal, sessionServesOrigin } from '../src/server/access/service'
import { AccessStore, accessStorePaths } from '../src/server/access/store'

/**
 * Roster `version: 2` (issue #142, Discussion #140 Part 15): members store permission keys, a
 * `version: 1` roster upgrades on first open with a backup, every write keeps the key invariants,
 * a roster file edited by hand never grants more than the rules allow, and labels come from the
 * built-in presets below `schemaVersion` 6.
 */

const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function workspaceAndHome() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-roster-v2-')))
	cleanup.push(base)
	const workspace = join(base, 'ws')
	await mkdir(join(workspace, '.uiux'), { recursive: true })
	await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
	const home = join(base, 'home')
	return { base, workspace, home, paths: accessStorePaths(home, workspace) }
}

/** Creates the store directories (and an empty roster) when missing, then replaces the roster file with `contents`. */
async function writeRoster(workspace: string, home: string, contents: unknown): Promise<string> {
	// A roster written earlier by this test may be one the store refuses; its directories exist then.
	await AccessStore.open({ workspaceRoot: workspace, home, create: true }).catch(() => undefined)
	const { file } = accessStorePaths(home, workspace)
	const text = `${JSON.stringify(contents, null, 2)}\n`
	await writeFile(file, text)
	return text
}

function expectAccessError(run: () => unknown, code: string, message?: string | RegExp) {
	try {
		run()
	}
	catch (error) {
		expect(error).toBeInstanceOf(AccessError)
		expect((error as AccessError).code).toBe(code)
		if (message !== undefined) expect((error as AccessError).message).toMatch(message)
		return
	}
	throw new Error(`Expected AccessError ${code}`)
}

const NOW = Date.now()
const iso = (offset = 0) => new Date(NOW + offset).toISOString()
const presetKeys = (id: string) => [...BUILT_IN_ACCESS_PRESETS.find(preset => preset.id === id)!.keys]
const withoutHumanOnly = (keys: readonly string[]) => keys.filter(key => !(HUMAN_ONLY_PERMISSION_KEYS as readonly string[]).includes(key))

/**
 * A roster as an earlier UIUX wrote it: `version: 1`, members with `role`, a Token with the
 * retired `lan` flag and a session with `listener` instead of `origin` (Part 16 compatibility).
 */
function legacyRoster(workspaceRoot: string, members: readonly Readonly<{ nickname: string; kind: 'human' | 'agent'; role: string; keys?: unknown }>[]) {
	const hint = generateHint()
	const stored = members.map(member => ({ id: randomUUID(), createdAt: iso(-DAY_MS), ...member }))
	const agent = stored.find(member => member.kind === 'agent')
	const human = stored.find(member => member.kind === 'human')
	const token = generateCredential('token', hint)
	const session = generateCredential('session', hint)
	const file = {
		version: 1,
		workspaceRoot,
		hint,
		members: stored,
		tokens: agent ? [{ id: token.id, memberId: agent.id, label: 'old laptop', hash: token.hash, lan: true, createdAt: iso(-DAY_MS), expiresAt: null, lastUsedAt: null, revokedAt: null }] : [],
		invites: [],
		sessions: human ? [{ id: session.id, memberId: human.id, hash: session.hash, listener: 'loopback', userAgent: 'old', createdAt: iso(-DAY_MS), lastSeenAt: iso(), expiresAt: iso(10 * DAY_MS) }] : [],
	}
	return { file, token: token.value, session: session.value }
}

function v2Member(nickname: string, kind: 'human' | 'agent', keys: readonly string[]): StoredMember {
	return { id: randomUUID(), nickname, kind, keys, createdAt: iso() }
}

function v2Roster(workspaceRoot: string, members: readonly StoredMember[]): AccessFile {
	return { ...createEmptyAccessFile(workspaceRoot, generateHint()), members }
}

describe('the version 1 roster upgrade (Scenario 01a11c09-d7ef)', () => {
	it('upgrades a version 1 roster on first open, keeps it as access.v1.json and keeps every credential working', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const legacy = legacyRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }, { nickname: 'claude', kind: 'agent', role: 'editor' }])
		const original = await writeRoster(workspace, home, legacy.file)

		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const onDisk = JSON.parse(await readFile(paths.file, 'utf8')) as AccessFile & { members: Record<string, unknown>[] }
		expect(onDisk.version).toBe(2)
		const human = onDisk.members.find(member => member.nickname === 'deviltea')!
		const agent = onDisk.members.find(member => member.nickname === 'claude')!
		// The human member holds the Owner preset's keys; the Agent the Editor keys except `reviews.resolve`.
		expect(human.keys).toEqual(presetKeys('owner'))
		expect(agent.keys).toEqual(presetKeys('editor').filter(key => key !== 'reviews.resolve'))
		expect(human).not.toHaveProperty('role')
		expect(store.data).toEqual(onDisk)

		// The version 1 file, byte for byte, beside the roster with mode 0600.
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(original)
		expect((await lstat(paths.v1Backup)).mode & 0o777).toBe(0o600)
		expect((await lstat(paths.file)).mode & 0o777).toBe(0o600)

		// No member's effective capabilities change (Rule 01a11c09-b698): the keys are the role's.
		expect(memberPrincipal(store.data.members.find(member => member.nickname === 'claude')!, 'token', 'aaaaaaaaaa').keys).toEqual(keysForRole('agent', 'editor'))
		expect(memberPrincipal(store.data.members.find(member => member.nickname === 'deviltea')!, 'session', 'aaaaaaaaaa').keys).toEqual(keysForRole('human', 'owner'))

		// The Token LAN flag and the session listener of the old shape still load and work.
		expect(verifyCredential(store.data, legacy.token, Date.now())).toMatchObject({ ok: true, kind: 'token', member: { nickname: 'claude' } })
		const session = verifyCredential(store.data, legacy.session, Date.now())
		expect(session).toMatchObject({ ok: true, kind: 'session', member: { nickname: 'deviltea' } })
		if (!session.ok) throw new Error('session should verify')
		expect(sessionServesOrigin(session.session!, { origin: 'http://127.0.0.1:3000', loopbackHost: true })).toBe(true)
		expect(onDisk.tokens[0]).toMatchObject({ lan: true })
		expect(onDisk.sessions[0]).toMatchObject({ listener: 'loopback' })

		// The upgrade happens once: a later open leaves both files alone.
		const before = await stat(paths.v1Backup)
		const reopened = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		expect(reopened.data).toEqual(onDisk)
		expect((await stat(paths.v1Backup)).mtimeMs).toBe(before.mtimeMs)
	})

	it('gives an Agent written as Owner by hand the Editor keys it can hold, and ignores keys a version 1 member carries', async () => {
		const { workspace, home } = await workspaceAndHome()
		const legacy = legacyRoster(workspace, [
			{ nickname: 'deviltea', kind: 'human', role: 'owner' },
			{ nickname: 'boss', kind: 'agent', role: 'owner' },
			// A version 1 member never had keys; a hand-added list is not trusted.
			{ nickname: 'peek', kind: 'agent', role: 'viewer', keys: ['members.manage', 'views.write'] },
		])
		await writeRoster(workspace, home, legacy.file)
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const boss = store.data.members.find(member => member.nickname === 'boss')!
		expect(boss.keys).toEqual(withoutHumanOnly(presetKeys('owner')))
		expect(memberLabel(boss)).toEqual({ preset: { id: 'editor', name: 'Editor' } })
		expect(store.data.members.find(member => member.nickname === 'peek')!.keys).toEqual(presetKeys('viewer'))
	})

	it('upgrades once when several processes open the version 1 roster at the same time, backing up only the version 1 file', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const original = await writeRoster(workspace, home, legacyRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }]).file)
		const stores = await Promise.all(Array.from({ length: 6 }, () => AccessStore.open({ workspaceRoot: workspace, home })))
		for (const store of stores) expect(store!.data.version).toBe(2)
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(original)
		expect(JSON.parse(await readFile(paths.file, 'utf8')).version).toBe(2)
	})

	it('finishes an upgrade that stopped after the backup, replacing the stale backup', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const original = await writeRoster(workspace, home, legacyRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }]).file)
		// The state a crash between the two writes leaves: the version 1 roster, and a backup.
		await writeFile(paths.v1Backup, 'partial', { mode: 0o600 })
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		expect(store.data.version).toBe(2)
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(original)
	})

	it('upgrades a version 1 roster that appears while a store is open, and on the first write', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const store = (await AccessStore.open({ workspaceRoot: workspace, home, create: true }))!
		const first = legacyRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }])
		const firstText = `${JSON.stringify(first.file, null, 2)}\n`
		await writeFile(paths.file, firstText)
		expect(await store.refresh({ force: true })).toBe(true)
		expect(store.data.members[0]!.keys).toEqual(presetKeys('owner'))
		expect(JSON.parse(await readFile(paths.file, 'utf8')).version).toBe(2)
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(firstText)

		// A write that finds a version 1 roster under the lock keeps its backup before writing.
		const second = legacyRoster(workspace, [{ nickname: 'mei', kind: 'human', role: 'owner' }])
		const secondText = `${JSON.stringify(second.file, null, 2)}\n`
		await writeFile(paths.file, secondText)
		await store.update(file => createToken(file, { nickname: 'mei' }))
		expect(JSON.parse(await readFile(paths.file, 'utf8'))).toMatchObject({ version: 2, members: [{ nickname: 'mei', keys: presetKeys('owner') }] })
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(secondText)
	})

	it('reads a version 1 copy source as its upgrade without writing it', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const original = await writeRoster(workspace, home, legacyRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }]).file)
		const read = await AccessStore.readRoster(home, workspace)
		expect(read).toMatchObject({ version: 2, members: [{ nickname: 'deviltea', keys: presetKeys('owner') }] })
		expect(await readFile(paths.file, 'utf8')).toBe(original)
		await expect(stat(paths.v1Backup)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('refuses a roster version it does not know, and writes nothing (an older UIUX refuses version 2 the same way)', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const future = { ...v2Roster(workspace, []), version: 3 }
		const text = await writeRoster(workspace, home, future)
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_invalid', message: expect.stringContaining('unsupported version 3') })
		expect(await readFile(paths.file, 'utf8')).toBe(text)
		await expect(stat(paths.v1Backup)).rejects.toMatchObject({ code: 'ENOENT' })
	})
})

describe('roster invariants on write', () => {
	const HUMAN_KEYS = presetKeys('owner')

	it('stores a key set only with its requirements, and never a humanOnly key on an Agent', () => {
		let file = v2Roster('/work/design', [v2Member('deviltea', 'human', HUMAN_KEYS)])
		expectAccessError(() => addMember(file, { nickname: 'bot', kind: 'agent', keys: ['workspace.read', 'reviews.write', 'reviews.resolve'] }), 'access.key_human_only', /`reviews\.resolve`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['reviews.submit', 'workspace.read'] }), 'access.key_requires', /`reviews\.submit` requires `reviews\.write`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['views.write'] }), 'access.key_requires', /`views\.write` requires `workspace\.read`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['Views.Write'] }), 'access.invalid_keys')
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: 'views.write' }), 'access.invalid_keys')
		expectAccessError(() => addMember(file, { nickname: 'mei' }), 'access.invalid_keys')
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['workspace.read'], role: 'viewer' }), 'access.invalid_keys')

		// Rule 01a11c09-b85c: the manager may give any valid set, even keys it does not hold.
		file = addMember(file, { nickname: 'mei', keys: ['views.write', 'workspace.read', 'views.write'] }).file
		expect(file.members[1]!.keys).toEqual(['workspace.read', 'views.write'])
		file = addMember(file, { nickname: 'bot', kind: 'agent', keys: ['workspace.read'] }).file
		expectAccessError(() => setMember(file, 'bot', { keys: ['workspace.read', 'members.manage'] }), 'access.key_human_only')
		expectAccessError(() => setMember(file, 'bot', { kind: 'human' }), 'access.kind_immutable')
		// Keys unknown to this version are kept when written, after the catalog keys.
		expect(setMember(file, 'mei', { keys: ['future.capability', 'workspace.read'] }).result.keys).toEqual(['workspace.read', 'future.capability'])
	})

	it('refuses any write that leaves no human holding members.manage (Scenario 01a118a1-d128)', () => {
		const file = v2Roster('/work/design', [v2Member('deviltea', 'human', HUMAN_KEYS), v2Member('claude', 'agent', keysForRole('agent', 'editor'))])
		expectAccessError(() => setMember(file, 'deviltea', { keys: HUMAN_KEYS.filter(key => key !== 'members.manage') }), 'access.last_manager', /deviltea is the last human holder of `members\.manage`/u)
		expectAccessError(() => removeMember(file, 'deviltea'), 'access.last_manager')
		// With a second human manager, either may lose it.
		const two = addMember(file, { nickname: 'mei', keys: HUMAN_KEYS }).file
		expect(setMember(two, 'deviltea', { role: 'viewer' }).result.keys).toEqual(presetKeys('viewer'))
		expect(removeMember(two, 'deviltea').file.members.map(member => member.nickname)).toEqual(['claude', 'mei'])
	})

	it('enforces the invariants on every store write, whatever the mutation, and leaves the roster unchanged when refused', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', HUMAN_KEYS), v2Member('claude', 'agent', ['workspace.read'])]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const before = await readFile(paths.file, 'utf8')
		const forge = (change: (member: StoredMember) => StoredMember) => store.update(file => ({ file: { ...file, members: file.members.map(change) }, result: undefined }))
		await expect(forge(member => member.nickname === 'deviltea' ? { ...member, keys: ['workspace.read'] } : member)).rejects.toMatchObject({ code: 'access.last_manager' })
		await expect(forge(member => member.nickname === 'claude' ? { ...member, keys: ['workspace.read', 'locks.force-release'] } : member)).rejects.toMatchObject({ code: 'access.store_invalid' })
		await expect(forge(member => member.nickname === 'claude' ? { ...member, keys: ['history.restore'] } : member)).rejects.toMatchObject({ code: 'access.key_requires' })
		expect(await readFile(paths.file, 'utf8')).toBe(before)
	})
})

describe('a roster file edited by hand never grants more than the rules allow', () => {
	it('refuses an Agent holding humanOnly keys at load, naming the member and the keys', async () => {
		const { workspace, home } = await workspaceAndHome()
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner')), v2Member('claude', 'agent', presetKeys('owner'))]))
		const opened = AccessStore.open({ workspaceRoot: workspace, home })
		await expect(opened).rejects.toMatchObject({ code: 'access.store_invalid' })
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toThrow(/Agent member "claude" holds the humanOnly keys reviews\.resolve, checkpoints\.delete, locks\.force-release, presets\.manage, members\.manage/u)
	})

	it('refuses malformed key lists at load: not key names, repeated keys, a missing list, or a version 2 member carrying only a role', async () => {
		const { workspace, home } = await workspaceAndHome()
		const human = v2Member('deviltea', 'human', presetKeys('owner'))
		for (const member of [
			{ ...human, keys: ['workspace.read', 'Members.Manage'] },
			{ ...human, keys: ['workspace.read', 7] },
			{ ...human, keys: ['workspace.read', 'workspace.read'] },
			{ ...human, keys: 'members.manage' },
			{ id: human.id, nickname: human.nickname, kind: 'human', role: 'owner', createdAt: human.createdAt },
		]) {
			await writeRoster(workspace, home, { ...v2Roster(workspace, []), members: [member] })
			await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_invalid' })
		}
		expectAccessError(() => validateAccessFile({ ...v2Roster(workspace, []), members: [human, { ...human, nickname: 'other' }] }), 'access.store_invalid', /member id is duplicated/u)
	})

	it('keeps keys unknown to this version, which grant nothing and make the member Custom', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const mei = v2Member('mei', 'human', [...presetKeys('viewer'), 'future.capability'])
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner')), mei]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const principal = memberPrincipal(store.data.members[1]!, 'session', 'aaaaaaaaaa')
		expect(principal.keys).toEqual(presetKeys('viewer'))
		expect(memberLabel(store.data.members[1]!)).toEqual({ custom: true })
		// An unrelated write keeps the unknown key.
		await store.update(file => createToken(file, { nickname: 'mei' }))
		expect(JSON.parse(await readFile(paths.file, 'utf8')).members[1].keys).toEqual([...presetKeys('viewer'), 'future.capability'])
	})

	it('lets a key set lacking a requirement grant only the keys it lists, until it is rewritten', async () => {
		const { workspace, home } = await workspaceAndHome()
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner')), v2Member('claude', 'agent', ['views.write'])]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const claude = memberPrincipal(store.data.members[1]!, 'token', 'aaaaaaaaaa')
		expect(claude.keys).toEqual(['views.write'])
		expect(authorizeOperation(claude, 'createView')).toBeUndefined()
		expect(authorizeOperation(claude, 'readPointResource')).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['workspace.read'] })
		// Other writes leave the incoherent set as written; writing that member's keys must make them whole.
		await store.update(file => addMember(file, { nickname: 'mei', role: 'viewer' }))
		expect(store.data.members[1]!.keys).toEqual(['views.write'])
		await expect(store.update(file => setMember(file, 'claude', { keys: ['views.write'] }))).rejects.toMatchObject({ code: 'access.key_requires' })
	})

	it('loads a roster with no human manager, grants nobody more than its keys, and bootstraps a manager with every key (Scenario 01a118a1-d172)', async () => {
		const { workspace, home } = await workspaceAndHome()
		// Agents only, plus a human without `members.manage`.
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('claude', 'agent', keysForRole('agent', 'editor')), v2Member('mei', 'human', presetKeys('editor'))]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		expect(effectiveKeys(memberPrincipal(store.data.members[1]!, 'session', 'aaaaaaaaaa'))).not.toContain('members.manage')
		// Writes that do not concern a manager are not refused: there was none to lose.
		await store.update(file => addMember(file, { nickname: 'rui', role: 'reviewer' }))

		const service = new AccessService({ store, leases: createLeaseManager() })
		const banner = await service.bootstrap(['http://127.0.0.1:3000'])
		expect(banner?.join('\n')).toMatch(/created member ".+" with every permission key/u)
		expect(banner?.join('\n')).toMatch(/\/login#uiux_i_/u)
		const created = store.data.members.find(member => !['claude', 'mei', 'rui'].includes(member.nickname))!
		expect(created).toMatchObject({ kind: 'human', keys: [...PERMISSION_KEYS] })
		// Later starts print nothing.
		expect(await service.bootstrap(['http://127.0.0.1:3000'])).toBeUndefined()
	})
})

describe('principals from stored keys', () => {
	it('never gives a live Agent principal a humanOnly key, even from stored keys that list them', () => {
		// Built by hand: the store refuses such a member at load, and the principal refuses it again.
		const agent = v2Member('claude', 'agent', presetKeys('owner'))
		for (const credential of ['token', 'session'] as const) {
			const principal = memberPrincipal(agent, credential, 'aaaaaaaaaa')
			expect(principal.keys).toEqual(withoutHumanOnly(presetKeys('owner')))
			for (const key of HUMAN_ONLY_PERMISSION_KEYS) expect(effectiveKeys(principal)).not.toContain(key)
			expect(authorizeOperation(principal, 'administerAccess')).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['members.manage'] })
			expect(authorizeOperation(principal, 'forceReleaseLease')).toMatchObject({ code: 'auth.scope_denied', requiredKeys: ['locks.force-release'] })
			expect(principal.role).toBe('editor')
		}
	})

	it('resolves exactly the stored catalog keys for a human member, with a role derived from them', () => {
		const mei = v2Member('mei', 'human', ['workspace.read', 'reviews.write', 'checkpoints.delete'])
		const principal = memberPrincipal(mei, 'session', 'aaaaaaaaaa')
		expect(principal.keys).toEqual(['workspace.read', 'reviews.write', 'checkpoints.delete'])
		expect(principal.role).toBe('viewer')
		expect(compatibilityRole(v2Member('lead', 'human', presetKeys('owner')))).toBe('owner')
		expect(compatibilityRole(v2Member('ed', 'human', [...presetKeys('editor'), 'members.manage']))).toBe('editor')
	})
})

describe('labels from the built-in presets (below schemaVersion 6)', () => {
	it('labels a human member by the preset whose keys equal its keys, otherwise Custom', () => {
		for (const preset of BUILT_IN_ACCESS_PRESETS)
			expect(memberLabel({ kind: 'human', keys: [...preset.keys].reverse() })).toEqual({ preset: { id: preset.id, name: preset.name } })
		expect(memberLabel({ kind: 'human', keys: presetKeys('editor').filter(key => key !== 'handoff.export') })).toEqual({ custom: true })
		expect(memberLabel({ kind: 'human', keys: [...presetKeys('reviewer'), 'views.write'] })).toEqual({ custom: true })
		// A human holding an Agent-style Editor set (no `reviews.resolve`) is not an Editor.
		expect(memberLabel({ kind: 'human', keys: withoutHumanOnly(presetKeys('editor')) })).toEqual({ custom: true })
		expect(memberLabel({ kind: 'human', keys: [] })).toEqual({ custom: true })
	})

	it('labels an Agent holding the Editor keys it can hold as Editor, preferring the preset with the fewest humanOnly keys (Scenario 01a11c09-d61f)', () => {
		// Editor and Owner without their humanOnly keys are the same set; Editor has fewer humanOnly keys.
		expect(memberLabel({ kind: 'agent', keys: presetKeys('editor').filter(key => key !== 'reviews.resolve') })).toEqual({ preset: { id: 'editor', name: 'Editor' } })
		expect(memberLabel({ kind: 'agent', keys: presetKeys('reviewer').filter(key => key !== 'reviews.resolve') })).toEqual({ preset: { id: 'reviewer', name: 'Reviewer' } })
		expect(memberLabel({ kind: 'agent', keys: presetKeys('viewer') })).toEqual({ preset: { id: 'viewer', name: 'Viewer' } })
		expect(memberLabel({ kind: 'agent', keys: ['workspace.read'] })).toEqual({ custom: true })
		// The earliest preset wins a tie on humanOnly keys; a preset holding an unknown key labels nobody.
		const presets = [
			{ id: 'a', name: 'A', keys: ['workspace.read', 'future.capability'] },
			{ id: 'b', name: 'B', keys: ['workspace.read', 'reviews.write', 'reviews.resolve'] },
			{ id: 'c', name: 'C', keys: ['workspace.read', 'reviews.write', 'checkpoints.delete', 'history.read'] },
			{ id: 'd', name: 'D', keys: ['workspace.read', 'reviews.write', 'members.manage'] },
		]
		expect(memberLabel({ kind: 'agent', keys: ['workspace.read', 'reviews.write'] }, presets)).toEqual({ preset: { id: 'b', name: 'B' } })
		expect(memberLabel({ kind: 'human', keys: ['workspace.read', 'future.capability'] }, presets)).toEqual({ custom: true })
	})

	it('computes labels from the keys alone, so a version 1 upgrade labels every member by its former role', () => {
		const upgraded = readAccessFile(legacyRoster('/work/design', [
			{ nickname: 'a', kind: 'human', role: 'viewer' },
			{ nickname: 'b', kind: 'human', role: 'reviewer' },
			{ nickname: 'c', kind: 'agent', role: 'editor' },
			{ nickname: 'd', kind: 'human', role: 'owner' },
		]).file)
		expect(upgraded.legacy).toBe(true)
		expect(upgraded.file.members.map(member => memberLabel(member))).toEqual(['viewer', 'reviewer', 'editor', 'owner'].map(id => ({ preset: { id, name: id[0]!.toUpperCase() + id.slice(1) } })))
	})
})
