import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { verifyCredential } from '../src/server/access/roster'
import { AccessStore } from '../src/server/access/store'

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

	it('dispatches the access commands from the installed CLI and lists them in --help', async () => {
		const { home, workspace } = await setup()
		const result = spawnSync(process.execPath, [CLI, 'member', 'add', 'mei', '--role', 'viewer', '--workspace', workspace], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status).toBe(0)
		expect(result.stdout).toContain('Added human member mei (viewer)')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
		for (const command of ['member add', 'token create', 'invite create', 'session list', 'access copy'])
			expect(help).toContain(command)
	}, 30_000)
})
