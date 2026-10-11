import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import type { HostVersionRecord } from '../src/domain/history/schema'
import { blobDigest, HostHistoryStore } from '../src/persistence/history/host-store'
import { acquireServerHold } from '../src/persistence/server-hold'
import { verifyCredential } from '../src/server/access/roster'
import { AccessStore, copyHostHistory, hostHistoryPaths, planHostHistoryCopy } from '../src/server/access/store'
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
			return loginWithCredential(file, verified, { origin: 'http://127.0.0.1:3700', userAgent: 'Playwright' })
		})
		expect((await run('session', 'list', '--workspace', workspace)).out).toMatch(/ORIGIN[\s\S]*mei\s+http:\/\/127\.0\.0\.1:3700/u)
		expect(await run('session', 'revoke', '--workspace', workspace)).toMatchObject({ code: 2 })
		expect(await run('session', 'revoke', '--member', 'mei', '--workspace', workspace)).toMatchObject({ code: 0, out: expect.stringContaining('Revoked 1 session') })
	})

	it('names the loopback origin on the server\'s port when invite create has no --origin', async () => {
		const { workspace, run, runWithEnv } = await setup()
		await run('member', 'add', 'mei', '--role', 'reviewer', '--workspace', workspace)
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
		const hold = (await acquireServerHold(worktree, { layout: CURRENT_TEST_LAYOUT }))!
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

	it('copies the history before the roster, so a failed history copy leaves the target unchanged', async () => {
		const { base, workspace, home, run } = await setup()
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)
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
		await run('member', 'add', 'deviltea', '--role', 'owner', '--workspace', workspace)
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
		const result = spawnSync(process.execPath, [CLI, 'member', 'add', 'mei', '--role', 'viewer', '--workspace', workspace], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status).toBe(0)
		expect(result.stdout).toContain('Added human member mei (viewer)')
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' }).stdout
		for (const command of ['member add', 'token create', 'invite create', 'session list', 'access copy'])
			expect(help).toContain(command)
		expect(help).toMatch(/Copy members, tokens and host history from another\s+Workspace path, once/u)
		expect(help).not.toContain('--lan')
	}, 30_000)
})
