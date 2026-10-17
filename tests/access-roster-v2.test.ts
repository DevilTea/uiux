import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { BUILT_IN_ACCESS_PRESETS, HUMAN_ONLY_PERMISSION_KEYS, PERMISSION_KEYS } from '../src/application/access/keys'
import { memberLabel } from '../src/application/access/labels'
import { createLeaseManager } from '../src/application/access/leases'
import { authorizeOperation, effectiveKeys } from '../src/application/access/policy'
import { generateCredential, generateHint } from '../src/server/access/credentials'
import {
	AccessError,
	addMember,
	createEmptyAccessFile,
	createToken,
	removeMember,
	setMember,
	validateAccessFile,
	DAY_MS,
	type AccessFile,
	type StoredMember,
} from '../src/server/access/roster'
import { AccessService, memberPrincipal } from '../src/server/access/service'
import { AccessStore, accessStorePaths, assertReplacementKeepsManager, workspaceStoreId, writeNewRoster } from '../src/server/access/store'
import { presetKeys } from './support/access'

/**
 * Roster `version: 2` (issue #142, Discussion #140 Part 15): members store permission keys, any
 * other roster version is refused and never rewritten (Discussion #231, Part 17), every write keeps
 * the key invariants, a roster file edited by hand never grants more than the rules allow, and
 * labels come from the built-in presets below `schemaVersion` 6.
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
const withoutHumanOnly = (keys: readonly string[]) => keys.filter(key => !(HUMAN_ONLY_PERMISSION_KEYS as readonly string[]).includes(key))

/**
 * A roster as an earlier UIUX wrote it: `version: 1`, members with `role`, a Token with the
 * retired `lan` flag and a session with `listener` instead of `origin`. This UIUX refuses it.
 */
function versionOneRoster(workspaceRoot: string, members: readonly Readonly<{ nickname: string; kind: 'human' | 'agent'; role: string }>[]) {
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

describe('only roster version 2 is read (Clause 01a14917-7898)', () => {
	it('refuses a version 1 roster on open, naming the file and its version, and never rewrites it or backs it up (Scenario 01a14917-8c6c)', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const original = await writeRoster(workspace, home, versionOneRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }, { nickname: 'claude', kind: 'agent', role: 'editor' }]).file)
		const refusal = expect.objectContaining({ code: 'access.store_invalid', message: expect.stringContaining(`The access store ${paths.file} is invalid: it is roster version 1, and this UIUX reads only roster version 2`) })
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toEqual(refusal)
		await expect(AccessStore.open({ workspaceRoot: workspace, home, create: true })).rejects.toEqual(refusal)
		// `access copy --from` reads the source the same way.
		await expect(AccessStore.readRoster(home, workspace)).rejects.toEqual(refusal)
		expect(await readFile(paths.file, 'utf8')).toBe(original)
		expect(await readdir(paths.dir)).not.toContain('access.v1.json')
	})

	it('refuses a version 1 roster that appears while a store is open, on refresh and on a write, and leaves it unchanged', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const store = (await AccessStore.open({ workspaceRoot: workspace, home, create: true }))!
		const text = `${JSON.stringify(versionOneRoster(workspace, [{ nickname: 'deviltea', kind: 'human', role: 'owner' }]).file, null, 2)}\n`
		await writeFile(paths.file, text)
		await expect(store.refresh({ force: true })).rejects.toMatchObject({ code: 'access.store_invalid' })
		await expect(store.update(file => createToken(file, { nickname: 'deviltea' }))).rejects.toMatchObject({ code: 'access.store_invalid' })
		expect(await readFile(paths.file, 'utf8')).toBe(text)
		expect(await readdir(paths.dir)).not.toContain('access.v1.json')
	})

	it('refuses a roster written by a newer UIUX, and writes nothing (an older UIUX refuses version 2 the same way)', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const future = { ...v2Roster(workspace, []), version: 3 }
		const text = await writeRoster(workspace, home, future)
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toMatchObject({ code: 'access.store_invalid', message: expect.stringContaining(`The access store ${paths.file} is invalid: it is roster version 3, and this UIUX reads only roster version 2`) })
		expect(await readFile(paths.file, 'utf8')).toBe(text)
	})

	it('refuses a roster whose version is not 2, such as "2", 0 or 1.5, and writes nothing', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		for (const version of ['2', 0, 1.5, -1, null]) {
			const text = await writeRoster(workspace, home, { ...v2Roster(workspace, []), version })
			await expect(AccessStore.open({ workspaceRoot: workspace, home }), String(version)).rejects.toMatchObject({ code: 'access.store_invalid', message: expect.stringContaining(`The access store ${paths.file} is invalid: it is roster version ${JSON.stringify(version)}`) })
			expectAccessError(() => validateAccessFile({ ...v2Roster(workspace, []), version }), 'access.store_invalid', /it is roster version/u)
			expect(await readFile(paths.file, 'utf8')).toBe(text)
		}
	})
})

describe('recovery from a refused roster', () => {
	it('names the roster file and the README recovery section when it refuses a roster', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		expect(paths.file).toBe(join(home, 'workspaces', workspaceStoreId(workspace), 'access.json'))
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('claude', 'agent', ['workspace.read', 'members.manage'])]))
		const refusal = await AccessStore.open({ workspaceRoot: workspace, home }).catch((error: AccessError) => error)
		expect(refusal).toMatchObject({ code: 'access.store_invalid' })
		expect((refusal as AccessError).message).toBe(`The access store ${paths.file} is invalid: Agent member "claude" holds the humanOnly key members.manage, which an Agent never holds; remove it from the roster file. See "Recovering a roster" in the UIUX README.`)
		await writeFile(paths.file, '{ broken')
		await expect(AccessStore.open({ workspaceRoot: workspace, home })).rejects.toThrow(`The access store ${paths.file} is not valid JSON. See "Recovering a roster" in the UIUX README.`)
	})

	it('removes the temporary files a killed writer left, and nothing else', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		const leftovers = ['access.json.0123456789ab.tmp']
		const kept = ['access.json.backup', 'access.json.xyz.tmp', 'access.v1.json.ba9876543210.tmp', 'notes.tmp']
		for (const name of [...leftovers, ...kept]) await writeFile(join(paths.dir, name), 'x', { mode: 0o600 })
		await AccessStore.open({ workspaceRoot: workspace, home })
		const names = await readdir(paths.dir)
		for (const name of leftovers) expect(names).not.toContain(name)
		for (const name of kept) expect(names).toContain(name)
	})

	it('leaves the temporary files when another process holds the lock, and still opens the roster without waiting', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		await AccessStore.open({ workspaceRoot: workspace, home, create: true })
		const leftover = join(paths.dir, 'access.json.0123456789ab.tmp')
		await writeFile(leftover, 'x', { mode: 0o600 })
		// A live holder: this process.
		await writeFile(paths.lock, JSON.stringify({ pid: process.pid, token: 'held' }), { mode: 0o600 })
		const started = Date.now()
		const store = await AccessStore.open({ workspaceRoot: workspace, home })
		expect(store?.data.version).toBe(2)
		// Far below the lock's wait, which would end in `access.lock_busy`.
		expect(Date.now() - started).toBeLessThan(2_000)
		expect(await readdir(paths.dir)).toContain('access.json.0123456789ab.tmp')
		await rm(paths.lock)
		await AccessStore.open({ workspaceRoot: workspace, home })
		expect(await readdir(paths.dir)).not.toContain('access.json.0123456789ab.tmp')
	})
})

describe('roster invariants on write', () => {
	it('keeps the last human manager through a roster replacement, and lets a roster without one be replaced', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const agentsOnly = (root: string) => v2Roster(root, [v2Member('claude', 'agent', presetKeys('editor', 'agent'))])
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner'))]))
		const before = await readFile(paths.file, 'utf8')
		await expect(writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: agentsOnly })).rejects.toMatchObject({ code: 'access.last_manager', message: expect.stringContaining('deviltea is the last human holder') })
		await expect(assertReplacementKeepsManager(home, workspace, agentsOnly(workspace))).rejects.toMatchObject({ code: 'access.last_manager' })
		expect(await readFile(paths.file, 'utf8')).toBe(before)
		// A replacement with a human manager is fine, and so is replacing a roster that had none, or one the store refuses.
		await writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: root => v2Roster(root, [v2Member('mei', 'human', presetKeys('owner'))]) })
		await writeRoster(workspace, home, agentsOnly(workspace))
		await writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: agentsOnly })
		// A damaged roster is replaced, and the caller is told the last-manager check was skipped.
		const skipped: string[] = []
		for (const damaged of ['{ broken', JSON.stringify({ ...v2Roster(workspace, []), members: 'none' })]) {
			await writeFile(paths.file, damaged)
			await writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: agentsOnly, onManagerCheckSkipped: reason => skipped.push(reason) })
			expect(JSON.parse(await readFile(paths.file, 'utf8')).members).toMatchObject([{ nickname: 'claude' }])
		}
		expect(skipped).toEqual([`${paths.file} is not valid JSON`, expect.stringContaining(`${paths.file}: The access store is invalid: members must be an array`)])
		// A replacement of a manager-less roster that is readable warns about nothing.
		await writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: agentsOnly, onManagerCheckSkipped: reason => skipped.push(reason) })
		expect(skipped).toHaveLength(2)
	})

	it('refuses to replace a roster written by a newer UIUX, asking for it (owner ruling of 2026-10-11)', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const newer = await writeRoster(workspace, home, { ...v2Roster(workspace, []), version: 3 })
		const replacement = (root: string) => v2Roster(root, [v2Member('mei', 'human', presetKeys('owner'))])
		const message = `The roster ${paths.file} is roster version 3, written by a newer UIUX; this UIUX will not replace it. Run uiux access copy with that newer UIUX.`
		await expect(writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: replacement })).rejects.toMatchObject({ code: 'access.store_invalid', message })
		await expect(assertReplacementKeepsManager(home, workspace, replacement(workspace))).rejects.toMatchObject({ code: 'access.store_invalid', message })
		expect(await readFile(paths.file, 'utf8')).toBe(newer)
	})

	it('refuses to replace a roster the store refuses, never rewriting it (Clause 01a14917-7898-72fa-a8ad-ed737e4a9eae)', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		const replacement = (root: string) => v2Roster(root, [v2Member('mei', 'human', presetKeys('owner'))])
		const skipped: string[] = []
		for (const refused of [{ ...v2Roster(workspace, []), version: 1 }, (({ version: _version, ...rest }) => rest)(v2Roster(workspace, [])), { ...v2Roster(workspace, []), sessions: [{ id: 'ses_abcdefghijkl', listener: 'lan' }] }]) {
			const text = await writeRoster(workspace, home, refused)
			await expect(writeNewRoster({ workspaceRoot: workspace, home, replace: true, file: replacement, onManagerCheckSkipped: reason => skipped.push(reason) })).rejects.toMatchObject({ code: 'access.store_invalid', message: expect.stringContaining(`The roster ${paths.file} is refused: `) })
			await expect(assertReplacementKeepsManager(home, workspace, replacement(workspace))).rejects.toMatchObject({ code: 'access.store_invalid' })
			expect(await readFile(paths.file, 'utf8')).toBe(text)
		}
		expect(skipped).toEqual([])
	})

	it('refuses any write that changes an existing member\'s kind, whatever the mutation', async () => {
		const { workspace, home, paths } = await workspaceAndHome()
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner')), v2Member('claude', 'agent', ['workspace.read'])]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const before = await readFile(paths.file, 'utf8')
		// A forged write turning the Agent into a human, even with keys unchanged, is refused.
		for (const keys of [['workspace.read'], presetKeys('owner')]) {
			const forged = store.update(file => ({ file: { ...file, members: file.members.map(member => member.nickname === 'claude' ? { ...member, kind: 'human' as const, keys } : member) }, result: undefined }))
			await expect(forged).rejects.toMatchObject({ code: 'access.kind_immutable', message: expect.stringContaining('claude\'s kind is agent') })
		}
		expect(await readFile(paths.file, 'utf8')).toBe(before)
	})

	const HUMAN_KEYS = presetKeys('owner')

	it('stores a key set only with its requirements, and never a humanOnly key on an Agent', () => {
		let file = v2Roster('/work/design', [v2Member('deviltea', 'human', HUMAN_KEYS)])
		expectAccessError(() => addMember(file, { nickname: 'bot', kind: 'agent', keys: ['workspace.read', 'reviews.write', 'reviews.resolve'] }), 'access.key_human_only', /`reviews\.resolve`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['reviews.submit', 'workspace.read'] }), 'access.key_requires', /`reviews\.submit` requires `reviews\.write`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['views.write'] }), 'access.key_requires', /`views\.write` requires `workspace\.read`/u)
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: ['Views.Write'] }), 'access.invalid_keys')
		expectAccessError(() => addMember(file, { nickname: 'mei', keys: 'views.write' }), 'access.invalid_keys')
		expectAccessError(() => addMember(file, { nickname: 'mei' }), 'access.invalid_keys')

		// Rule 01a11c09-b85c: the manager may give any valid set, even keys it does not hold.
		file = addMember(file, { nickname: 'mei', keys: ['views.write', 'workspace.read', 'views.write'] }).file
		expect(file.members[1]!.keys).toEqual(['workspace.read', 'views.write'])
		file = addMember(file, { nickname: 'bot', kind: 'agent', keys: ['workspace.read'] }).file
		expectAccessError(() => setMember(file, 'bot', { keys: ['workspace.read', 'members.manage'] }), 'access.key_human_only')
		expectAccessError(() => setMember(file, 'bot', { kind: 'human' }), 'access.kind_immutable')
		// A key outside the catalog is never newly given (owner ruling 1 of 2026-10-11).
		expectAccessError(() => setMember(file, 'mei', { keys: ['future.capability', 'workspace.read'] }), 'access.unknown_key', /`future\.capability` is not a permission key of this UIUX version/u)
		expectAccessError(() => addMember(file, { nickname: 'rui', keys: ['workspace.read', 'future.capability', 'other.thing'] }), 'access.unknown_key', /`future\.capability`, `other\.thing` are not permission keys/u)
	})

	it('keeps an unknown key a member already holds when its keys are written, but refuses a new one on every write path', async () => {
		const held = v2Member('mei', 'human', ['workspace.read', 'future.capability'])
		const file = v2Roster('/work/design', [v2Member('deviltea', 'human', presetKeys('owner')), held])
		// Keys unknown to this version that the member holds are kept, after the catalog keys.
		expect(setMember(file, 'mei', { keys: ['future.capability', 'workspace.read', 'history.read'] }).result.keys).toEqual(['workspace.read', 'history.read', 'future.capability'])
		expectAccessError(() => setMember(file, 'mei', { keys: ['workspace.read', 'future.capability', 'future.other'] }), 'access.unknown_key', /`future\.other`/u)

		// The store refuses a new unknown key whatever the mutation, and the service's key input too.
		const { workspace, home, paths } = await workspaceAndHome()
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('deviltea', 'human', presetKeys('owner')), { ...held, id: randomUUID() }]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const before = await readFile(paths.file, 'utf8')
		const forged = store.update(current => ({ file: { ...current, members: current.members.map(member => member.nickname === 'deviltea' ? { ...member, keys: [...member.keys, 'future.capability'] } : member) }, result: undefined }))
		await expect(forged).rejects.toMatchObject({ code: 'access.unknown_key' })
		const service = new AccessService({ store, leases: createLeaseManager() })
		await expect(service.addMember({ nickname: 'rui', keys: ['workspace.read', 'future.capability'] })).rejects.toMatchObject({ code: 'access.unknown_key' })
		await expect(service.setMember(store.data.members[0]!.id, { keys: [...presetKeys('owner'), 'future.capability'] })).rejects.toMatchObject({ code: 'access.unknown_key' })
		expect(await readFile(paths.file, 'utf8')).toBe(before)
		// The member that holds it keeps it through a write of its own keys.
		await service.setMember(store.data.members[1]!.id, { keys: ['workspace.read', 'history.read', 'future.capability'] })
		expect(store.data.members[1]!.keys).toEqual(['workspace.read', 'history.read', 'future.capability'])
	})

	it('refuses any write that leaves no human holding members.manage (Scenario 01a118a1-d128)', () => {
		const file = v2Roster('/work/design', [v2Member('deviltea', 'human', HUMAN_KEYS), v2Member('claude', 'agent', presetKeys('editor', 'agent'))])
		expectAccessError(() => setMember(file, 'deviltea', { keys: HUMAN_KEYS.filter(key => key !== 'members.manage') }), 'access.last_manager', /deviltea is the last human holder of `members\.manage`/u)
		expectAccessError(() => removeMember(file, 'deviltea'), 'access.last_manager')
		// With a second human manager, either may lose it.
		const two = addMember(file, { nickname: 'mei', keys: HUMAN_KEYS }).file
		expect(setMember(two, 'deviltea', { keys: presetKeys('viewer') }).result.keys).toEqual(presetKeys('viewer'))
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
		await store.update(file => addMember(file, { nickname: 'mei', keys: presetKeys('viewer') }))
		expect(store.data.members[1]!.keys).toEqual(['views.write'])
		await expect(store.update(file => setMember(file, 'claude', { keys: ['views.write'] }))).rejects.toMatchObject({ code: 'access.key_requires' })
	})

	it('loads a roster with no human manager, grants nobody more than its keys, and bootstraps a manager with every key (Scenario 01a118a1-d172)', async () => {
		const { workspace, home } = await workspaceAndHome()
		// Agents only, plus a human without `members.manage`.
		await writeRoster(workspace, home, v2Roster(workspace, [v2Member('claude', 'agent', presetKeys('editor', 'agent')), v2Member('mei', 'human', presetKeys('editor'))]))
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		expect(effectiveKeys(memberPrincipal(store.data.members[1]!, 'session', 'aaaaaaaaaa'))).not.toContain('members.manage')
		// Writes that do not concern a manager are not refused: there was none to lose.
		await store.update(file => addMember(file, { nickname: 'rui', keys: presetKeys('reviewer') }))

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
			// Labeled from the stored keys, which no preset matches once its humanOnly keys are ignored.
			expect(principal.label).toEqual({ custom: true })
		}
	})

	it('resolves exactly the stored catalog keys for a human member, labeled from them', () => {
		const mei = v2Member('mei', 'human', ['workspace.read', 'reviews.write', 'checkpoints.delete'])
		const principal = memberPrincipal(mei, 'session', 'aaaaaaaaaa')
		expect(principal.keys).toEqual(['workspace.read', 'reviews.write', 'checkpoints.delete'])
		expect(principal.label).toEqual({ custom: true })
		expect(memberPrincipal(v2Member('lead', 'human', presetKeys('owner')), 'session', 'aaaaaaaaaa').label).toEqual({ preset: { id: 'owner', name: 'Owner' } })
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

	it('computes labels from the keys alone, so a member holding a built-in preset\'s keys is labeled by that preset', () => {
		const members = [
			v2Member('a', 'human', presetKeys('viewer')),
			v2Member('b', 'human', presetKeys('reviewer')),
			v2Member('c', 'agent', presetKeys('editor', 'agent')),
			v2Member('d', 'human', presetKeys('owner')),
		]
		expect(members.map(member => memberLabel(member))).toEqual(['viewer', 'reviewer', 'editor', 'owner'].map(id => ({ preset: { id, name: id[0]!.toUpperCase() + id.slice(1) } })))
	})
})
