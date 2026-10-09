import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { HostHistoryStore } from '../src/persistence/history/host-store'
import { acquireServerHold } from '../src/persistence/server-hold'
import { verifyCredential } from '../src/server/access/roster'
import { AccessStore, hostHistoryPaths } from '../src/server/access/store'

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
	async function run(...argv: string[]) {
		const out: string[] = []
		const err: string[] = []
		const code = await runAccessCommand({ argv, env: { UIUX_HOME: home }, cwd: base, stdout: line => out.push(line), stderr: line => err.push(line) })
		return { code, out: out.join('\n'), err: err.join('\n') }
	}
	return { base, home, workspace, run }
}

async function initWorkspace(base: string, name: string): Promise<string> {
	const root = join(base, name, 'design')
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), '{}\n')
	return root
}

function hostVersion(): HostVersionRecord {
	const at = new Date().toISOString()
	return { historySchemaVersion: 1, id: randomUUID(), type: 'external', actor: { type: 'external' }, at, workspaceSchemaVersion: 4, resources: [], startedAt: at, netChange: true, events: [] }
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
		expect(await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'add', 'claude', '--kind', 'agent', '--role', 'editor', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('uiux token create') })
		expect(await run('member', 'add', 'bot', '--kind', 'agent', '--role', 'owner', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('capped at Editor') })
		const list = await run('member', 'list', '--workspace', workspace)
		expect(list.out).toMatch(/Roster [a-z2-7]{4} for /u)
		expect(list.out).toContain(workspace)
		expect(list.out).toMatch(/claude\s+agent\s+editor\s+0\s+0/u)
		expect(await run('member', 'set', 'deviltea', '--role', 'editor', '--workspace', workspace)).toMatchObject({ code: 1, err: expect.stringContaining('last human Owner') })
		expect(await run('member', 'set', 'claude', '--nickname', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect(await run('member', 'set', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('member', 'remove', 'claude-main', '--workspace', workspace)).toMatchObject({ code: 0 })
		expect((await run('member', 'list', '--workspace', workspace)).out).not.toContain('claude')
	})

	it('creates a token once, lists it without the secret, and revokes it', async () => {
		const { workspace, home, run } = await setup()
		await run('member', 'add', 'claude', '--kind', 'agent', '--role', 'editor', '--workspace', workspace)
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
		expect(await run('token', 'create', '--member', 'claude', '--expires', 'never', '--lan', '--workspace', workspace)).toMatchObject({ code: 0, err: expect.stringContaining('ships no LAN listener') })
		expect(await run('token', 'create', '--member', 'claude', '--expires', 'soon', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('token', 'revoke', id, '--workspace', workspace)).toMatchObject({ code: 0 })
		await store.refresh({ force: true })
		expect(verifyCredential(store.data, token!, Date.now()).ok).toBe(false)
		expect((await run('token', 'list', '--workspace', workspace)).out).not.toContain(id)
		expect((await run('token', 'list', '--all', '--workspace', workspace)).out).toMatch(new RegExp(`${id}.*revoked`, 'u'))
	})

	it('creates human-only sign-in links and lists and revokes sessions', async () => {
		const { workspace, home, run } = await setup()
		await run('member', 'add', 'mei', '--role', 'reviewer', '--workspace', workspace)
		await run('member', 'add', 'claude', '--kind', 'agent', '--role', 'editor', '--workspace', workspace)
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
			return loginWithCredential(file, verified, { listener: 'loopback', userAgent: 'Playwright' })
		})
		expect((await run('session', 'list', '--workspace', workspace)).out).toMatch(/mei\s+loopback/u)
		expect(await run('session', 'revoke', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('session', 'revoke', '--member', 'mei', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Revoked 1 session') })
	})

	it('copies a roster to a new Workspace path once, keeping tokens and dropping sessions', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)
		await run('member', 'add', 'claude', '--kind', 'agent', '--role', 'editor', '--workspace', workspace)
		const token = (await run('token', 'create', '--member', 'claude', '--workspace', workspace)).out.match(/uiux_t_\S+/u)![0]
		await run('invite', 'create', '--member', 'deviltea', '--workspace', workspace)
		const worktree = join(base, 'worktree', 'design')
		await mkdir(join(worktree, '.uiux'), { recursive: true })
		await writeFile(join(worktree, '.uiux', 'workspace.json'), '{}\n')
		// The target already has a roster (for example one uiux dev bootstrapped): --replace is required.
		await run('member', 'add', 'someone', '--role', 'owner', '--workspace', worktree)
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

	it('refuses an uninitialized Workspace, a missing --workspace and a UIUX_HOME inside the Workspace', async () => {
		const { base, workspace, run } = await setup()
		expect(await run('member', 'list', '--workspace', join(base, 'typo'))).toMatchObject({ code: 2, err: expect.stringContaining('not an initialized UIUX Workspace') })
		expect(await run('member', 'list')).toMatchObject({ code: 2, err: expect.stringContaining('requires --workspace') })
		expect(await run('member', 'frobnicate', '--workspace', workspace)).toMatchObject({ code: 2 })
		const out: string[] = []
		const inside = await runAccessCommand({ argv: ['member', 'add', 'x', '--role', 'owner', '--workspace', workspace], env: { UIUX_HOME: join(workspace, 'home') }, stdout: () => {}, stderr: line => out.push(line) })
		expect(inside).toBe(2)
		expect(out.join('\n')).toContain('resolves inside the Workspace')
	})

	it('copies the host history once with the roster, with the roster\'s permissions, and replaces it only with --replace', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)
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
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('already has host history') })
		expect((await run('access', 'copy', '--from', workspace, '--workspace', worktree, '--replace')).code).toBe(0)
		expect((await targetHost.listVersions()).records.map(record => record.id).sort()).toEqual((await sourceHost.listVersions()).records.map(record => record.id).sort())
		expect((await readdir(dirname(target.dir))).filter(name => name.startsWith('.history-'))).toEqual([])
	})

	it('refuses a source history holding a symbolic link, and a target a running server holds, before writing anything', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)
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
		const hold = (await acquireServerHold(worktree))!
		expect(await run('access', 'copy', '--from', workspace, '--workspace', worktree)).toMatchObject({ code: 1, err: expect.stringContaining('Stop that server') })
		expect(await AccessStore.open({ workspaceRoot: worktree, home })).toBeUndefined()
		await hold.release()
		expect((await run('access', 'copy', '--from', workspace, '--workspace', worktree)).code).toBe(0)

		// A source without host history copies the roster alone.
		const third = await initWorkspace(base, 'third')
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', third)
		const fourth = await initWorkspace(base, 'fourth')
		expect(await run('access', 'copy', '--from', third, '--workspace', fourth)).toMatchObject({ code: 0, out: expect.stringContaining(`No host history recorded for ${third}; none copied.`) })
		expect(await lstat(hostHistoryPaths(home, fourth).dir).catch(() => undefined)).toBeUndefined()
	})

	it('dispatches the access commands from the installed CLI and lists them in --help', async () => {
		const { home, workspace } = await setup()
		const result = spawnSync(process.execPath, [CLI, 'member', 'add', 'mei', '--role', 'viewer', '--workspace', workspace], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status).toBe(0)
		expect(result.stdout).toContain('Added human member mei (viewer)')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
		for (const command of ['member add', 'token create', 'invite create', 'session list', 'access copy'])
			expect(help).toContain(command)
		expect(help).toMatch(/Copy members, tokens and host history from another\s+Workspace path, once/u)
	}, 30_000)
})
