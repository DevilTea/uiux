import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { BUILT_IN_ACCESS_PRESETS, HUMAN_ONLY_PERMISSION_KEYS, keysForRole, PERMISSION_KEYS } from '../src/application/access/keys'
import { createLeaseManager } from '../src/application/access/leases'
import { runAccessCommand } from '../src/cli/access'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { blobDigest, HostHistoryStore } from '../src/persistence/history/host-store'
import { acquireServerHold } from '../src/persistence/server-hold'
import { verifyCredential } from '../src/server/access/roster'
import { AccessService, agentAccessOption } from '../src/server/access/service'
import { AccessStore, accessStorePaths, copyHostHistory, hostHistoryPaths, planHostHistoryCopy } from '../src/server/access/store'
import { CURRENT_TEST_LAYOUT } from './support/workspace-layout'

const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function setup() {
	const base = await realpath(await mkdtemp(join(tmpdir(), 'uiux-access-cli-')))
	cleanup.push(base)
	const home = join(base, 'home')
	const workspace = join(base, 'design')
	await mkdir(join(workspace, '.uiux'), { recursive: true })
	await writeFile(join(workspace, '.uiux', 'workspace.json'), '{}\n')
	async function runWithEnv(env: Readonly<Record<string, string>>, ...argv: string[]) {
		const out: string[] = []
		const err: string[] = []
		const code = await runAccessCommand({ argv, env: { UIUX_HOME: home, ...env }, cwd: base, stdout: line => out.push(line), stderr: line => err.push(line) })
		return { code, out: out.join('\n'), err: err.join('\n') }
	}
	const run = (...argv: string[]) => runWithEnv({}, ...argv)
	return { base, home, workspace, run, runWithEnv }
}

async function initWorkspace(base: string, name: string): Promise<string> {
	const root = join(base, name, 'design')
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), '{}\n')
	return root
}

function hostVersion(files?: Record<string, string>): HostVersionRecord {
	const at = new Date().toISOString()
	const resources = files ? [{ kind: 'view', key: '11111111-1111-4111-8111-111111111111', revision: 'r_x', files }] : []
	return { historySchemaVersion: 1, id: randomUUID(), type: 'external', actor: { type: 'external' }, at, workspaceSchemaVersion: 4, resources, startedAt: at, netChange: true, events: [] }
}

/** Every directory and file under `root`, with its permission bits (and a file's bytes). */
async function historyTree(root: string): Promise<Record<string, { directory: boolean; mode: number; bytes?: Buffer }>> {
	const tree: Record<string, { directory: boolean; mode: number; bytes?: Buffer }> = {}
	for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
		const path = join(entry.parentPath, entry.name)
		const mode = (await lstat(path)).mode & 0o777
		tree[relative(root, path)] = entry.isDirectory() ? { directory: true, mode } : { directory: false, mode, bytes: await readFile(path) }
	}
	return Object.fromEntries(Object.entries(tree).sort(([left], [right]) => left.localeCompare(right)))
}

describe('uiux access commands', () => {
	it('adds, lists, changes and removes members of one Workspace roster', async () => {
		const { workspace, run } = await setup()
		expect((await run('member', 'list', '--workspace', workspace)).out).toContain('No roster yet')
		expect(await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('uiux token create') })
		const list = await run('member', 'list', '--workspace', workspace)
		expect(list.out).toMatch(/Roster [a-z2-7]{4} for /u)
		expect(list.out).toContain(workspace)
		expect(list.out).toMatch(/NICKNAME\s+KIND\s+ACCESS\s+TOKENS\s+SESSIONS\s+KEYS/u)
		expect(list.out).toMatch(new RegExp(`claude\\s+agent\\s+Editor\\s+0\\s+0\\s+${keysForRole('agent', 'editor').length}$`, 'mu'))
		expect(await run('member', 'set', 'deviltea', '--preset', 'Editor', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('last human holder of `members.manage`') })
		expect(await run('member', 'set', 'claude', '--nickname', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'set', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('member', 'remove', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect((await run('member', 'list', '--workspace', workspace)).out).not.toContain('claude')
	})

	it('creates a token once, lists it without the secret, and revokes it', async () => {
		const { workspace, home, run } = await setup()
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		const created = await run('token', 'create', '--member', 'claude', '--label', 'laptop', '--workspace', workspace)
		expect(created.code).toBe(0)
		const token = created.out.match(/uiux_t_[a-z2-7]{4}_[a-z2-7]{10}_[a-z2-7]{52}/u)?.[0]
		expect(token).toBeDefined()
		expect(created.out).toContain('never commit it')
		const id = token!.split('_')[3]!
		const listed = await run('token', 'list', '--workspace', workspace)
		expect(listed.out).toContain(id)
		expect(listed.out).toContain('laptop')
		expect(listed.out).not.toContain(token!)
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		expect(verifyCredential(store.data, token!, Date.now()).ok).toBe(true)
		// The LAN flag is gone (Discussion #174): every Token works on every accepted origin.
		expect(await run('token', 'create', '--member', 'claude', '--expires', 'never', '--lan', '--workspace', workspace)).toMatchObject({ code: 2, err: expect.stringContaining('Unknown option --lan.') })
		expect((await run('token', 'create', '--member', 'claude', '--expires', 'never', '--workspace', workspace)).out).not.toMatch(/LAN|loopback only/u)
		expect((await run('token', 'list', '--workspace', workspace)).out).not.toContain('LAN')
		expect(await run('token', 'create', '--member', 'claude', '--expires', 'soon', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('token', 'revoke', id, '--workspace', workspace)).toMatchObject({ code: 0 })
		await store.refresh({ force: true })
		expect(verifyCredential(store.data, token!, Date.now()).ok).toBe(false)
		expect((await run('token', 'list', '--workspace', workspace)).out).not.toContain(id)
		expect((await run('token', 'list', '--all', '--workspace', workspace)).out).toMatch(new RegExp(`${id}.*revoked`, 'u'))
	})

	it('creates human-only sign-in links and lists and revokes sessions', async () => {
		const { workspace, home, run } = await setup()
		await run('member', 'add', 'mei', '--preset', 'Reviewer', '--workspace', workspace)
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		expect(await run('invite', 'create', '--member', 'claude', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('human members only') })
		const invite = await run('invite', 'create', '--member', 'mei', '--origin', 'http://127.0.0.1:3700/x', '--workspace', workspace)
		expect(invite.out).toMatch(/http:\/\/127\.0\.0\.1:3700\/login#uiux_i_[a-z2-7]{4}_/u)
		expect((await run('session', 'list', '--workspace', workspace)).out).toContain('(no sessions)')
		// Sign a browser in through the store, as POST /api/session/login does.
		const { loginWithCredential } = await import('../src/server/access/roster')
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const credential = invite.out.match(/uiux_i_\S+/u)![0]
		await store.update((file) => {
			const verified = verifyCredential(file, credential, Date.now())
			if (!verified.ok) throw new Error('invite')
			return loginWithCredential(file, verified, { origin: 'http://127.0.0.1:3700', userAgent: 'Playwright' })
		})
		expect((await run('session', 'list', '--workspace', workspace)).out).toMatch(/ORIGIN[\s\S]*mei\s+http:\/\/127\.0\.0\.1:3700/u)
		expect(await run('session', 'revoke', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('session', 'revoke', '--member', 'mei', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Revoked 1 session') })
	})

	it('names the loopback origin on the server\'s port when invite create has no --origin', async () => {
		const { workspace, run, runWithEnv } = await setup()
		await run('member', 'add', 'mei', '--preset', 'Reviewer', '--workspace', workspace)
		const link = (output: string) => output.match(/(\S+)\/login#uiux_i_/u)?.[1]
		expect(link((await run('invite', 'create', '--member', 'mei', '--workspace', workspace)).out)).toBe('http://127.0.0.1:3000')
		// The port uiux dev would use, as Nitro reads it.
		expect(link((await runWithEnv({ PORT: '4555' }, 'invite', 'create', '--member', 'mei', '--workspace', workspace)).out)).toBe('http://127.0.0.1:4555')
		expect(link((await runWithEnv({ PORT: '4555', NITRO_PORT: '4666' }, 'invite', 'create', '--member', 'mei', '--workspace', workspace)).out)).toBe('http://127.0.0.1:4666')
		// A server running for this Workspace records its loopback origin; that port wins.
		const hold = (await acquireServerHold(workspace, { origin: 'http://[::1]:4777', layout: CURRENT_TEST_LAYOUT }))!
		try {
			expect(link((await runWithEnv({ PORT: '4555' }, 'invite', 'create', '--member', 'mei', '--workspace', workspace)).out)).toBe('http://[::1]:4777')
		}
		finally { await hold.release() }
		// An explicit --origin still wins.
		expect(link((await run('invite', 'create', '--member', 'mei', '--origin', 'https://uiux.corp.example', '--workspace', workspace)).out)).toBe('https://uiux.corp.example')
	})

	it('copies a roster to a new Workspace path once, keeping tokens and dropping sessions', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		const token = (await run('token', 'create', '--member', 'claude', '--workspace', workspace)).out.match(/uiux_t_\S+/u)![0]
		await run('invite', 'create', '--member', 'deviltea', '--workspace', workspace)
		const worktree = join(base, 'worktree', 'design')
		await mkdir(join(worktree, '.uiux'), { recursive: true })
		await writeFile(join(worktree, '.uiux', 'workspace.json'), '{}\n')
		// The target already has a roster (for example one uiux dev bootstrapped): --replace is required.
		await run('member', 'add', 'someone', '--preset', 'Owner', '--workspace', worktree)
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('--replace') })
		const copied = await run('access', 'copy', '--from', workspace, '--workspace', worktree, '--replace')
		expect(copied.code).toBe(0)
		expect(copied.out).toContain(`Source roster: ${workspace}`)
		const source = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const target = (await AccessStore.open({ workspaceRoot: worktree, home }))!
		expect(target.data.hint).not.toBe(source.data.hint)
		expect(target.data.workspaceRoot).toBe(worktree)
		expect(target.data.members.map(member => member.nickname)).toEqual(['deviltea', 'claude'])
		expect(target.data.invites).toEqual([])
		expect(target.data.sessions).toEqual([])
		expect(verifyCredential(target.data, token, Date.now())).toMatchObject({ ok: true, member: { nickname: 'claude' } })
		// One-time copy: a revoke in one roster does not reach the other.
		await run('token', 'revoke', token.split('_')[3]!, '--workspace', worktree)
		await source.refresh({ force: true })
		expect(verifyCredential(source.data, token, Date.now()).ok).toBe(true)
		// The old directory may already be gone.
		await rm(workspace, { recursive: true, force: true })
		const third = join(base, 'third')
		await mkdir(join(third, '.uiux'), { recursive: true })
		await writeFile(join(third, '.uiux', 'workspace.json'), '{}\n')
		expect(await run('access', 'copy', '--from', workspace, '--workspace', third)).toMatchObject({ code: 0 })
		expect(await run('access', 'copy', '--from', join(base, 'never-existed'), '--workspace', join(base, 'third'), '--replace')).toMatchObject({ code: 1, err: expect.stringContaining('No roster recorded') })
	})

	it('copies a version 1 roster as version 2 with the keys the upgrade maps, leaving the source as it was (Clause 01a1144e-56bd)', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const paths = accessStorePaths(home, workspace)
		const current = JSON.parse(await readFile(paths.file, 'utf8')) as { members: { id: string; nickname: string; createdAt: string }[] }
		const owner = current.members[0]!
		const legacy = {
			...current,
			version: 1,
			members: [
				{ id: owner.id, nickname: 'deviltea', kind: 'human', role: 'owner', createdAt: owner.createdAt },
				{ id: randomUUID(), nickname: 'claude', kind: 'agent', role: 'editor', createdAt: owner.createdAt },
			],
		}
		const legacyText = `${JSON.stringify(legacy, null, 2)}\n`
		await writeFile(paths.file, legacyText)
		const target = await initWorkspace(base, 'moved')
		expect(await run('access', 'copy', '--from', workspace, '--workspace', target)).toMatchObject({ code: 0 })
		const copied = JSON.parse(await readFile(accessStorePaths(home, target).file, 'utf8')) as { version: number; members: { nickname: string; keys: string[] }[] }
		expect(copied.version).toBe(2)
		expect(copied.members).toMatchObject([{ nickname: 'deviltea', keys: [...keysForRole('human', 'owner')] }, { nickname: 'claude', keys: [...keysForRole('agent', 'editor')] }])
		expect(copied.members.every(member => !('role' in member))).toBe(true)
		// Reading a copy source writes nothing to it; the source upgrades when it is next opened.
		expect(await readFile(paths.file, 'utf8')).toBe(legacyText)
		expect(await run('member', 'list', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringMatching(/claude\s+agent\s+Editor/u) })
		expect(JSON.parse(await readFile(paths.file, 'utf8')).version).toBe(2)
		expect(await readFile(paths.v1Backup, 'utf8')).toBe(legacyText)
	})

	it('refuses an access copy --replace that would drop the target\'s last human manager, before copying anything', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		await sourceHost.writeVersion(hostVersion())
		const target = await initWorkspace(base, 'moved')
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', target)
		const rosterBefore = await readFile(accessStorePaths(home, target).file, 'utf8')
		expect(await run('access', 'copy', '--from', workspace, '--workspace', target, '--replace')).toMatchObject({ code: 1, err: expect.stringContaining('deviltea is the last human holder of `members.manage`') })
		expect(await readFile(accessStorePaths(home, target).file, 'utf8')).toBe(rosterBefore)
		await expect(lstat(hostHistoryPaths(home, target).dir)).rejects.toMatchObject({ code: 'ENOENT' })
	})

	it('refuses to replace a roster written by a newer UIUX, and replaces a damaged one with a warning (owner ruling of 2026-10-11)', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		await sourceHost.writeVersion(hostVersion())
		const target = await initWorkspace(base, 'moved')
		await run('member', 'add', 'mei', '--preset', 'Owner', '--workspace', target)
		const targetFile = accessStorePaths(home, target).file
		const newer = JSON.stringify({ ...JSON.parse(await readFile(targetFile, 'utf8')), version: 3 })
		await writeFile(targetFile, newer)
		expect(await run('access', 'copy', '--from', workspace, '--workspace', target, '--replace')).toMatchObject({ code: 1, err: expect.stringContaining('written by a newer UIUX; this UIUX will not replace it. Run uiux access copy with that newer UIUX.') })
		expect(await readFile(targetFile, 'utf8')).toBe(newer)
		await expect(lstat(hostHistoryPaths(home, target).dir)).rejects.toMatchObject({ code: 'ENOENT' })

		await writeFile(targetFile, '{ damaged')
		const repaired = await run('access', 'copy', '--from', workspace, '--workspace', target, '--replace')
		expect(repaired).toMatchObject({ code: 0, err: expect.stringContaining(`uiux: warning: the roster being replaced is damaged (${targetFile} is not valid JSON); --replace repairs it without checking that a human member keeps members.manage.`) })
		expect(JSON.parse(await readFile(targetFile, 'utf8')).members).toMatchObject([{ nickname: 'deviltea' }])
	})

	it('refuses an uninitialized Workspace, a missing --workspace and a UIUX_HOME inside the Workspace', async () => {
		const { base, workspace, run } = await setup()
		expect(await run('member', 'list', '--workspace', join(base, 'typo'))).toMatchObject({ code: 2, err: expect.stringContaining('not an initialized UIUX Workspace') })
		expect(await run('member', 'list')).toMatchObject({ code: 2, err: expect.stringContaining('requires --workspace') })
		expect(await run('member', 'frobnicate', '--workspace', workspace)).toMatchObject({ code: 2 })
		const out: string[] = []
		const inside = await runAccessCommand({ argv: ['member', 'add', 'x', '--preset', 'Owner', '--workspace', workspace], env: { UIUX_HOME: join(workspace, 'home') }, stdout: () => {}, stderr: line => out.push(line) })
		expect(inside).toBe(2)
		expect(out.join('\n')).toContain('resolves inside the Workspace')
	})

	it('copies the host history once with the roster, with the roster\'s permissions, and replaces it only with --replace', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		await sourceHost.putBlob(new TextEncoder().encode('{"blob":1}\n'))
		await sourceHost.writeVersion(hostVersion())
		await sourceHost.appendOpenEntry({ type: 'begin', id: randomUUID(), startedAt: new Date().toISOString() })
		// An interrupted temporary write of the source store is not history.
		await writeFile(join(sourceHost.paths.versions, '.interrupted.tmp'), 'partial', { mode: 0o600 })

		const worktree = await initWorkspace(base, 'worktree')
		const copied = await run('access', 'copy', '--from', workspace, '--workspace', worktree)
		expect(copied).toMatchObject({ code: 0, err: '' })
		const target = hostHistoryPaths(home, worktree)
		expect(copied.out).toContain(`Copied the host history (3 file(s)) from ${sourceHost.paths.dir} to ${target.dir}.`)
		const sourceTree = await historyTree(sourceHost.paths.dir)
		const targetTree = await historyTree(target.dir)
		expect(Object.keys(targetTree)).toEqual(Object.keys(sourceTree).filter(path => !path.endsWith('.interrupted.tmp')))
		for (const [path, entry] of Object.entries(targetTree)) {
			expect(entry.mode, path).toBe(entry.directory ? 0o700 : 0o600)
			if (!entry.directory) expect(entry.bytes, path).toEqual(sourceTree[path]!.bytes)
		}
		expect((await lstat(target.dir)).mode & 0o777).toBe(0o700)
		const targetHost = (await HostHistoryStore.open({ paths: target }))!
		expect((await targetHost.listVersions()).records).toHaveLength(1)
		expect((await targetHost.readOpenJournal())!.entries.map(entry => entry.type)).toEqual(['begin'])

		// Once: later source history stays in the source.
		await sourceHost.writeVersion(hostVersion())
		expect((await targetHost.listVersions()).records).toHaveLength(1)
		// The target now has history (and a roster): only --replace copies again, and it discards the target's own.
		await targetHost.writeVersion(hostVersion())
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('Pass --replace') })
		// Without a roster, the target's own history alone still refuses the copy.
		const rosterless = await initWorkspace(base, 'rosterless')
		await (await HostHistoryStore.open({ paths: hostHistoryPaths(home, rosterless), create: true }))!.writeVersion(hostVersion())
		expect(await run('access', 'copy', '--from', workspace, '--workspace', rosterless)).toMatchObject({ code: 1, err: expect.stringContaining('already has host history') })
		const replaced = await run('access', 'copy', '--from', workspace, '--workspace', worktree, '--replace')
		expect(replaced.code).toBe(0)
		// The target held the first copy's version plus one of its own: --replace says how many it discards.
		expect(replaced.out).toContain('--replace discarded the target\'s own host history: 2 version(s)')
		expect((await targetHost.listVersions()).records.map(record => record.id).sort()).toEqual((await sourceHost.listVersions()).records.map(record => record.id).sort())
		expect((await readdir(dirname(target.dir))).filter(name => name.startsWith('.history-'))).toEqual([])
	})

	it('refuses a source history holding a symbolic link, and a target a running server holds, before writing anything', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		await sourceHost.writeVersion(hostVersion())
		const outside = join(base, 'outside.json')
		await writeFile(outside, '{}\n', { mode: 0o600 })
		const link = join(sourceHost.paths.versions, `${randomUUID()}.json`)
		await symlink(outside, link)

		const worktree = await initWorkspace(base, 'worktree')
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('it is a symbolic link') })
		expect(await AccessStore.open({ workspaceRoot: worktree, home })).toBeUndefined()
		expect(await lstat(hostHistoryPaths(home, worktree).dir).catch(() => undefined)).toBeUndefined()

		// The history directory itself as a link.
		await rm(link)
		const moved = join(base, 'moved-history')
		await rename(sourceHost.paths.dir, moved)
		await symlink(moved, sourceHost.paths.dir)
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('it is a symbolic link') })
		expect(await AccessStore.open({ workspaceRoot: worktree, home })).toBeUndefined()
		await rm(sourceHost.paths.dir)
		await rename(moved, sourceHost.paths.dir)

		// A running server keeps the target's history in memory.
		const hold = (await acquireServerHold(worktree, { layout: CURRENT_TEST_LAYOUT }))!
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('Stop that server') })
		expect(await AccessStore.open({ workspaceRoot: worktree, home })).toBeUndefined()
		await hold.release()
		expect((await run('access', 'copy', '--from', workspace, '--workspace', worktree)).code).toBe(0)

		// A source without host history copies the roster alone.
		const third = await initWorkspace(base, 'third')
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', third)
		const fourth = await initWorkspace(base, 'fourth')
		expect(await run('access', 'copy', '--from', third, '--workspace', fourth)).toMatchObject({ code: 0, out: expect.stringContaining(`No host history recorded for ${third}; none copied.`) })
		expect(await lstat(hostHistoryPaths(home, fourth).dir).catch(() => undefined)).toBeUndefined()
	})

	it('copies the history before the roster, so a failed history copy leaves the target unchanged', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		const digest = await sourceHost.putBlob(new TextEncoder().encode('unreadable\n'))
		const blob = join(sourceHost.paths.objects, digest.slice(7, 9), digest.slice(7))
		await chmod(blob, 0o000)
		try {
			const worktree = await initWorkspace(base, 'worktree')
			const failed = await run('access', 'copy', '--from', workspace, '--workspace', worktree)
			expect(failed).toMatchObject({ code: 1, err: expect.stringContaining('Could not copy the host history') })
			expect(failed.err).toContain('Nothing was copied.')
			expect(await AccessStore.open({ workspaceRoot: worktree, home })).toBeUndefined()
			expect(await lstat(hostHistoryPaths(home, worktree).workspaceDir).catch(() => undefined)).toBeUndefined()
		}
		finally {
			await chmod(blob, 0o600)
		}
	})

	it('checks the copied versions\' blobs before replacing anything, and re-checks the server hold right before the swap', async () => {
		const { base, workspace, home } = await setup()
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		const bytes = new TextEncoder().encode('{"view":1}\n')
		const digest = blobDigest(bytes)
		await sourceHost.writeVersion(hostVersion({ 'views/11111111-1111-4111-8111-111111111111.view.json': digest }))
		const worktree = await initWorkspace(base, 'worktree')
		const plan = await planHostHistoryCopy(home, workspace, worktree)

		// A source writer stores the blob after it was listed: the copy raced it, so it is refused and removed.
		await expect(copyHostHistory(plan, {
			replace: false,
			async blobAvailableElsewhere() {
				await sourceHost.putBlob(bytes)
				return false
			},
		})).rejects.toThrow('changed while it was copied')
		expect(await lstat(plan.target.dir).catch(() => undefined)).toBeUndefined()
		expect((await readdir(plan.target.workspaceDir).catch(() => [])).filter(name => name.startsWith('.history-'))).toEqual([])

		// A server that started meanwhile refuses the swap; the target stays without history.
		await expect(copyHostHistory(plan, { replace: false, beforeSwap: async () => { throw new Error('a server holds the target') } })).rejects.toThrow('a server holds the target')
		expect(await lstat(plan.target.dir).catch(() => undefined)).toBeUndefined()

		// Consistent now: the blob is copied with its version.
		expect(await copyHostHistory(plan, { replace: false })).toMatchObject({ files: 2, missingBlobs: [] })

		// A blob the source lacks too is reported, not refused: the copy is faithful to an incomplete source.
		const other = await initWorkspace(base, 'other')
		await sourceHost.writeVersion(hostVersion({ 'views/11111111-1111-4111-8111-111111111111.view.json': `sha256:${'f'.repeat(64)}` }))
		const run = async (...argv: string[]) => {
			const out: string[] = []
			const err: string[] = []
			const code = await runAccessCommand({ argv, env: { UIUX_HOME: home }, cwd: base, stdout: line => out.push(line), stderr: line => err.push(line) })
			return { code, out: out.join('\n'), err: err.join('\n') }
		}
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		const copied = await run('access', 'copy', '--from', workspace, '--workspace', other)
		expect(copied.code).toBe(0)
		expect(copied.err).toContain('1 blob(s) that copied versions name are missing from the source host history too')
	})

	it('checks the blobs the open autosave\'s events name too, not only the versions\'', async () => {
		const { base, workspace, home } = await setup()
		const sourceHost = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, workspace), create: true }))!
		const bytes = new TextEncoder().encode('{"view":"open"}\n')
		const digest = blobDigest(bytes)
		const missing = `sha256:${'e'.repeat(64)}`
		const event = (afterRevision: string) => ({ at: new Date().toISOString(), actor: { type: 'agent' as const, id: 'member:m-agent', displayName: 'claude' }, source: 'mcp' as const, operation: 'updateViewSpec' as const, resource: { kind: 'view' as const, key: '11111111-1111-4111-8111-111111111111' }, beforeRevision: null, afterRevision })
		await sourceHost.appendOpenEntry({ type: 'begin', id: randomUUID(), startedAt: new Date().toISOString() })
		await sourceHost.appendOpenEntry({ type: 'event', event: event('r_a'), files: { 'views/11111111-1111-4111-8111-111111111111.view.json': digest } })
		const worktree = await initWorkspace(base, 'worktree')
		const plan = await planHostHistoryCopy(home, workspace, worktree)

		// No version names the blob; only the open autosave's event does. A source writer stores it after it was listed.
		await expect(copyHostHistory(plan, {
			replace: false,
			async blobAvailableElsewhere() {
				await sourceHost.putBlob(bytes)
				return false
			},
		})).rejects.toThrow('changed while it was copied')
		expect(await lstat(plan.target.dir).catch(() => undefined)).toBeUndefined()

		// An event's blob the source lacks too is reported, like a version's.
		await sourceHost.appendOpenEntry({ type: 'event', event: event('r_b'), files: { 'views/11111111-1111-4111-8111-111111111111.view.json': missing } })
		expect(await copyHostHistory(plan, { replace: false })).toMatchObject({ missingBlobs: [missing] })
		expect(await lstat(join(plan.target.dir, 'objects', 'sha256', digest.slice(7, 9), digest.slice(7)))).toBeDefined()
	})

	it('dispatches the access commands from the installed CLI and lists them in --help', async () => {
		const { home, workspace } = await setup()
		const result = spawnSync(process.execPath, [CLI, 'member', 'add', 'mei', '--preset', 'Viewer', '--workspace', workspace], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status).toBe(0)
		expect(result.stdout).toContain('Added human member mei (Viewer, 3 keys)')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
		for (const command of ['member add', '--preset <name>', '--all-keys', '--grant <k,...>', 'member list [--keys]', 'token create', 'invite create', 'session list', 'access copy'])
			expect(help).toContain(command)
		expect(help).toMatch(/Copy members, tokens and host history from another\s+Workspace path, once/u)
		expect(help).not.toContain('--lan')
		expect(help).not.toContain('--role')
	}, 30_000)
})

describe('uiux member on permission keys and Access presets (issue #142)', () => {
	const presetKeys = (id: string) => [...BUILT_IN_ACCESS_PRESETS.find(preset => preset.id === id)!.keys]
	async function storedMembers(home: string, workspace: string) {
		const store = (await AccessStore.open({ workspaceRoot: workspace, home, create: false }))!
		return store.data.members
	}

	it('refuses --role, naming --preset, and needs exactly one of --preset, --keys and --all-keys (Clauses 01a1144e-5660, 01a11c09-acaf)', async () => {
		const { home, workspace, run } = await setup()
		for (const argv of [['member', 'add', 'mei', '--role', 'editor'], ['member', 'set', 'mei', '--role', 'editor'], ['member', 'add', 'mei', '--role'], ['member', 'add', 'mei', '--role=editor'], ['member', 'set', 'mei', '--role=owner']]) {
			const refused = await run(...argv, '--workspace', workspace)
			expect(refused).toMatchObject({ code: 2, err: expect.stringContaining('--role was removed; give an Access preset with --preset <name>') })
		}
		expect(await run('member', 'add', 'mei', '--workspace', workspace)).toMatchObject({ code: 2, err: expect.stringContaining('exactly one of --preset <name>, --keys <k,...> or --all-keys') })
		expect(await run('member', 'add', 'mei', '--preset', 'Viewer', '--all-keys', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('member', 'add', 'mei', '--preset', 'Viewer', '--keys', 'workspace.read', '--workspace', workspace)).toMatchObject({ code: 2 })
		// Nothing was written, not even an empty roster.
		expect(await lstat(accessStorePaths(home, workspace).file).catch(() => undefined)).toBeUndefined()
	})

	it('resolves --preset by name, ignoring case, and names the available presets when none matches (Rules 01a11c09-ccc6, 01a11c09-cb79)', async () => {
		const { home, workspace, run } = await setup()
		const unknown = await run('member', 'add', 'mei', '--preset', 'Translator', '--workspace', workspace)
		expect(unknown).toMatchObject({ code: 1, err: expect.stringContaining('No Access preset named "Translator". The presets are Viewer, Reviewer, Editor, Owner.') })
		expect(await lstat(accessStorePaths(home, workspace).file).catch(() => undefined)).toBeUndefined()
		expect(await run('member', 'add', 'mei', '--preset', 'reviewer', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Added human member mei (Reviewer, 8 keys)') })
		// The preset's keys are copied; the member records no reference to the preset (Rule 01a11c09-b8c6).
		const [mei] = await storedMembers(home, workspace)
		expect(mei).toEqual({ id: expect.any(String), nickname: 'mei', kind: 'human', keys: presetKeys('reviewer'), createdAt: expect.any(String) })
		expect(await run('member', 'set', 'mei', '--preset', 'Nope', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('The presets are Viewer, Reviewer, Editor, Owner.') })
	})

	it('applies a preset to an Agent without its humanOnly keys, through add and set (Rule 01a11c74-26ef)', async () => {
		const { home, workspace, run } = await setup()
		const added = await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Owner', '--workspace', workspace)
		expect(added.code).toBe(0)
		expect(added.out).toContain(`Applied the Owner preset without ${HUMAN_ONLY_PERMISSION_KEYS.filter(key => presetKeys('owner').includes(key)).join(', ')}: an Agent cannot hold humanOnly keys.`)
		// The Owner keys an Agent can hold are the Editor keys an Agent can hold, so the label is Editor.
		expect(added.out).toContain(`Added agent member claude (Editor, ${keysForRole('agent', 'editor').length} keys)`)
		expect((await storedMembers(home, workspace))[0]!.keys).toEqual(keysForRole('agent', 'owner'))
		expect((await storedMembers(home, workspace))[0]!.keys.some(key => HUMAN_ONLY_PERMISSION_KEYS.includes(key as never))).toBe(false)
		const set = await run('member', 'set', 'claude', '--preset', 'Reviewer', '--workspace', workspace)
		expect(set).toMatchObject({ code: 0, out: expect.stringContaining('Applied the Reviewer preset without reviews.resolve') })
		expect((await storedMembers(home, workspace))[0]!.keys).toEqual(presetKeys('reviewer').filter(key => key !== 'reviews.resolve'))
		// A preset without humanOnly keys applies whole, without a note.
		expect((await run('member', 'set', 'claude', '--preset', 'Viewer', '--workspace', workspace)).out).not.toContain('Applied the')
	})

	it('takes explicit keys and --all-keys under the roster invariants (Clauses 01a11c09-a349, 01a128be-9a51)', async () => {
		const { home, workspace, run } = await setup()
		const root = await run('member', 'add', 'root', '--all-keys', '--workspace', workspace)
		expect(root).toMatchObject({ code: 0, out: expect.stringContaining(`(Owner, ${PERMISSION_KEYS.length} keys)`) })
		expect(root.out).not.toContain('without')
		// --all-keys names the humanOnly keys it leaves out for an Agent, as a preset does.
		const bot = await run('member', 'add', 'bot', '--kind', 'agent', '--all-keys', '--workspace', workspace)
		expect(bot).toMatchObject({ code: 0, out: expect.stringContaining(`Gave every catalog key without ${HUMAN_ONLY_PERMISSION_KEYS.join(', ')}: an Agent cannot hold humanOnly keys.`) })
		expect((await storedMembers(home, workspace)).map(member => member.keys)).toEqual([[...PERMISSION_KEYS], PERMISSION_KEYS.filter(key => !HUMAN_ONLY_PERMISSION_KEYS.includes(key))])
		const translator = await run('member', 'add', 'lin', '--keys', ' locales.write , workspace.read,reviews.write', '--workspace', workspace)
		expect(translator).toMatchObject({ code: 0, out: expect.stringContaining('Added human member lin (Custom, 3 keys)') })
		expect((await storedMembers(home, workspace))[2]!.keys).toEqual(['workspace.read', 'reviews.write', 'locales.write'])
		expect(await run('member', 'add', 'x1', '--keys', 'views.write', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('`views.write` requires `workspace.read`') })
		expect(await run('member', 'add', 'x2', '--kind', 'agent', '--keys', 'workspace.read,members.manage', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('is an Agent and cannot hold `members.manage`') })
		// A key outside this version's catalog is refused on input (owner ruling 1 of 2026-10-11).
		expect(await run('member', 'add', 'x3', '--keys', 'workspace.read,widgets.paint', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('`widgets.paint` is not a permission key of this UIUX version') })
		expect(await run('member', 'add', 'x4', '--keys', 'Views', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('is not a permission key name') })
		expect((await storedMembers(home, workspace)).map(member => member.nickname)).toEqual(['root', 'bot', 'lin'])
	})

	it('grants and revokes keys with member set, keeping the invariants (Rules 01a11c09-b932, 01a11485-ea91)', async () => {
		const { home, workspace, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		await run('member', 'add', 'mei', '--preset', 'Viewer', '--workspace', workspace)
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		// A host user restores a manager with --grant (Rule 01a11c09-b932).
		expect(await run('member', 'set', 'mei', '--grant', 'members.manage', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Updated mei: human, Custom, 4 keys.') })
		expect(await run('member', 'set', 'deviltea', '--revoke', 'members.manage', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'set', 'mei', '--revoke', 'members.manage', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('last human holder of `members.manage`') })
		expect(await run('member', 'set', 'claude', '--grant', 'reviews.resolve', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('humanOnly') })
		expect(await run('member', 'set', 'claude', '--revoke', 'reviews.write', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('`reviews.submit` requires `reviews.write`') })
		expect(await run('member', 'set', 'claude', '--grant', 'widgets.paint', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('`widgets.paint` is not a permission key of this UIUX version') })
		expect(await run('member', 'set', 'claude', '--grant', 'views.write', '--revoke', 'views.write', '--workspace', workspace)).toMatchObject({ code: 2, err: expect.stringContaining('--grant and --revoke both name views.write') })
		// A preset, then an adjustment, in one write; a revoke of a key not held only warns.
		const adjusted = await run('member', 'set', 'claude', '--preset', 'Reviewer', '--grant', 'locales.write', '--revoke', 'reviews.promote,flows.write', '--nickname', 'claude-l10n', '--workspace', workspace)
		expect(adjusted).toMatchObject({ code: 0, err: 'uiux: warning: claude-l10n did not hold flows.write; nothing to revoke there.' })
		expect((await storedMembers(home, workspace))[2]).toMatchObject({ nickname: 'claude-l10n', keys: ['workspace.read', 'history.read', 'product-kit.source.read', 'reviews.write', 'reviews.submit', 'locales.write', 'checkpoints.create'] })
	})

	it('applies a service key edit to the roster read under the lock, keeping a CLI change it has not refreshed', async () => {
		const { home, workspace, run } = await setup()
		expect(await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'add', 'mei', '--preset', 'Editor', '--workspace', workspace)).toMatchObject({ code: 0 })
		const store = (await AccessStore.open({ workspaceRoot: workspace, home }))!
		const service = new AccessService({ store, leases: createLeaseManager() })
		const mei = store.data.members.find(member => member.nickname === 'mei')!
		expect(mei.keys).toEqual(expect.arrayContaining(['views.write', 'flows.write']))

		// The CLI revokes views.write; the service does not refresh, so its snapshot still holds it.
		expect(await run('member', 'set', 'mei', '--revoke', 'views.write', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(store.data.members.find(member => member.id === mei.id)!.keys).toContain('views.write')

		const expected = keysForRole('human', 'editor').filter(key => key !== 'views.write' && key !== 'flows.write')
		expect((await service.setMember(mei.id, { revoke: ['flows.write'] })).keys).toEqual(expected)
		expect((await storedMembers(home, workspace)).find(member => member.nickname === 'mei')).toMatchObject({ keys: expected })
	})

	it('keeps a stored key unknown to this version through grants and shows it in member list --keys (Rule 01a11c09-b7ec)', async () => {
		const { home, workspace, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		await run('member', 'add', 'mei', '--preset', 'Viewer', '--workspace', workspace)
		// A newer UIUX stored a key this version does not know (written by hand: this version refuses to give it).
		const rosterFile = accessStorePaths(home, workspace).file
		const roster = JSON.parse(await readFile(rosterFile, 'utf8')) as { members: { nickname: string; keys: string[] }[] }
		roster.members.find(member => member.nickname === 'mei')!.keys.push('future.capability')
		await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`)
		expect(await run('member', 'set', 'mei', '--grant', 'reviews.write,future.capability', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Updated mei: human, Custom, 5 keys.') })
		expect((await storedMembers(home, workspace))[1]!.keys).toEqual([...presetKeys('viewer'), 'reviews.write', 'future.capability'])
		const list = await run('member', 'list', '--workspace', workspace)
		expect(list.out).toMatch(/deviltea\s+human\s+Owner\s+0\s+0\s+22$/mu)
		expect(list.out).toMatch(/mei\s+human\s+Custom\s+0\s+0\s+5$/mu)
		const full = await run('member', 'list', '--keys', '--workspace', workspace)
		expect(full.out).toMatch(/mei\s+human\s+Custom\s+0\s+0\s+workspace\.read, history\.read, product-kit\.source\.read, reviews\.write, future\.capability \(unknown\)$/mu)
		expect(full.out).toMatch(new RegExp(`deviltea\\s+human\\s+Owner\\s+0\\s+0\\s+${PERMISSION_KEYS.join(', ').replaceAll('.', '\\.')}$`, 'mu'))
	})

	it('keeps a stored key unknown to this version when a preset is applied, so the label is Custom (owner ruling of 2026-10-11 on PR #189)', async () => {
		const { home, workspace, run } = await setup()
		await run('member', 'add', 'deviltea', '--preset', 'Owner', '--workspace', workspace)
		await run('member', 'add', 'mei', '--preset', 'Editor', '--workspace', workspace)
		const rosterFile = accessStorePaths(home, workspace).file
		const roster = JSON.parse(await readFile(rosterFile, 'utf8')) as { members: { nickname: string; keys: string[] }[] }
		roster.members.find(member => member.nickname === 'mei')!.keys.push('future.key')
		await writeFile(rosterFile, `${JSON.stringify(roster, null, 2)}\n`)
		// The preset replaces only the keys this version knows.
		expect(await run('member', 'set', 'mei', '--preset', 'Viewer', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Updated mei: human, Custom, 4 keys.') })
		expect((await storedMembers(home, workspace))[1]!.keys).toEqual([...presetKeys('viewer'), 'future.key'])
		expect((await run('member', 'list', '--workspace', workspace)).out).toMatch(/mei\s+human\s+Custom\s+0\s+0\s+4$/mu)
		// --grant and --revoke of known keys keep it too.
		expect(await run('member', 'set', 'mei', '--grant', 'reviews.write', '--revoke', 'history.read', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect((await storedMembers(home, workspace))[1]!.keys).toEqual(['workspace.read', 'product-kit.source.read', 'reviews.write', 'future.key'])
	})

	it('says a humanOnly key revoked from an Agent was never granted to it, not that it was not held', async () => {
		const { workspace, run } = await setup()
		await run('member', 'add', 'claude', '--kind', 'agent', '--preset', 'Editor', '--workspace', workspace)
		const revoked = await run('member', 'set', 'claude', '--preset', 'Owner', '--revoke', 'members.manage,handoff.export', '--workspace', workspace)
		expect(revoked.code).toBe(0)
		expect(revoked.err).toBe('uiux: warning: members.manage is a humanOnly key, not granted to an Agent such as claude; nothing to revoke there.')
		expect(revoked.out).not.toContain('did not hold')
		const notHeld = await run('member', 'set', 'claude', '--revoke', 'handoff.export,reviews.resolve', '--workspace', workspace)
		expect(notHeld.err).toBe([
			'uiux: warning: claude did not hold handoff.export; nothing to revoke there.',
			'uiux: warning: reviews.resolve is a humanOnly key, not granted to an Agent such as claude; nothing to revoke there.',
		].join('\n'))
	})

	it('prints a bootstrap command for an Agent that works as printed (Rule 01a11c09-b9a6)', async () => {
		const { home, workspace, run } = await setup()
		const store = (await AccessStore.open({ workspaceRoot: workspace, home, create: true }))!
		const banner = await new AccessService({ store, leases: createLeaseManager() }).bootstrap(['http://127.0.0.1:3000'])
		const command = banner!.find(line => line.includes('uiux member add claude'))!.trim()
		expect(command).toBe(`uiux member add claude --workspace ${workspace} --kind agent --preset Editor`)
		expect(await run(...command.split(' ').slice(1))).toMatchObject({ code: 0, out: expect.stringContaining('Added agent member claude (Editor,') })
		// A Workspace without presets gets --keys instead, which works too.
		const fallback = agentAccessOption([])
		expect(fallback).toBe(`--keys ${keysForRole('agent', 'editor').join(',')}`)
		expect(await run('member', 'add', 'claude-2', '--kind', 'agent', ...fallback.split(' '), '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('(Editor,') })
		expect(agentAccessOption([{ id: 'qa', name: 'QA team' }])).toBe('--preset \'QA team\'')
	})
})
