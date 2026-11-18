import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'

import { runInitCommand } from '../src/cli/init'
import { checkGitWorkTree, runGit } from '../src/persistence/git'
import { initGit, makeDirectoryOutsideGit } from './support/git'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * Git is required (Clause 01a1ece9-97ec-736f-99a3-80b76efc800b, Rules 01a1ece9-98d4 and 01a1ece9-99b0;
 * Scenarios 01a1ece9-a3a5 and 01a1ece9-a482): `uiux init` and `uiux dev`, and the packaged server however
 * it is started, refuse a Workspace root outside a Git work tree, or when git cannot be run to tell,
 * with `workspace.git_required` and exit status 2, before writing, locking or listening. A root that
 * does not exist yet is checked in its nearest existing ancestor. Discovery and other commands never
 * need Git.
 */
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url))
const CLI = join(REPOSITORY, 'bin', 'uiux.mjs')
const SERVER = join(REPOSITORY, '.output', 'server', 'index.mjs')
const cleanup: string[] = []
afterEach(async () => {
	await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

/** A directory in no Git work tree. */
async function outsideGit(): Promise<string> {
	const directory = await makeDirectoryOutsideGit('uiux-git-required-')
	cleanup.push(directory)
	return directory
}

async function insideGit(): Promise<string> {
	const directory = await outsideGit()
	initGit(directory)
	return directory
}

/** Runs `operation` with `git` out of reach: PATH names a directory without it. */
async function withoutGit<T>(operation: () => Promise<T> | T): Promise<T> {
	const path = process.env.PATH
	process.env.PATH = join(tmpdir(), 'uiux-no-git-here')
	try {
		return await operation()
	}
	finally {
		process.env.PATH = path
	}
}

async function initCommand(options: Parameters<typeof runInitCommand>[0]) {
	const stdout: string[] = []
	const stderr: string[] = []
	const status = await runInitCommand({ ...options, env: { UIUX_HOME: join(await outsideGit(), 'home') }, stdout: line => stdout.push(line), stderr: line => stderr.push(line) })
	return { status, stdout: stdout.join('\n'), stderr: stderr.join('\n') }
}

describe('checking the Git work tree', () => {
	it('accepts a directory inside a work tree, a subdirectory of it, and a root that does not exist yet below it', async () => {
		const repo = await insideGit()
		await mkdir(join(repo, 'a', 'b'), { recursive: true })
		for (const path of [repo, join(repo, 'a', 'b'), join(repo, 'not', 'yet', '.uiux')])
			expect(checkGitWorkTree(path), path).toEqual({ ok: true, toplevel: repo })
	})

	it('refuses a directory outside every work tree, one that does not exist yet there, and the inside of .git', async () => {
		const directory = await outsideGit()
		expect(checkGitWorkTree(directory)).toMatchObject({ ok: false, message: expect.stringContaining('not inside a Git work tree') })
		expect(checkGitWorkTree(join(directory, 'not', 'yet'))).toMatchObject({ ok: false })
		const repo = await insideGit()
		expect(checkGitWorkTree(join(repo, '.git'))).toMatchObject({ ok: false })
	})

	it('refuses, saying so, when git cannot be run to tell', async () => {
		const repo = await insideGit()
		expect(await withoutGit(() => checkGitWorkTree(repo))).toMatchObject({ ok: false, message: expect.stringContaining('git cannot be run') })
	})

	it('ignores the environment variables that point git at another repository', async () => {
		const outside = await outsideGit()
		const repo = await insideGit()
		const saved = process.env.GIT_DIR
		process.env.GIT_DIR = join(repo, '.git')
		try {
			expect(checkGitWorkTree(outside).ok).toBe(false)
			expect((await runGit(repo, ['rev-parse', '--show-toplevel'])).ok).toBe(true)
		}
		finally {
			if (saved === undefined) delete process.env.GIT_DIR
			else process.env.GIT_DIR = saved
		}
	})
})

describe('uiux init needs Git', () => {
	it('initializes inside a work tree: by default at the top level, and at --workspace below it', async () => {
		const repo = await insideGit()
		await mkdir(join(repo, 'sub'), { recursive: true })
		const byDefault = await initCommand({ cwd: join(repo, 'sub') })
		expect(byDefault.status, byDefault.stderr).toBe(0)
		expect(existsSync(join(repo, '.uiux', 'workspace.json'))).toBe(true)
		expect(existsSync(join(repo, 'sub', '.uiux'))).toBe(false)
		const explicit = await initCommand({ cwd: repo, workspace: 'packages/design' })
		expect(explicit.status, explicit.stderr).toBe(0)
		expect(existsSync(join(repo, 'packages', 'design', 'workspace.json'))).toBe(true)
	})

	it('refuses --workspace outside a work tree with workspace.git_required and status 2, creating nothing, even for a directory that does not exist yet', async () => {
		const directory = await outsideGit()
		for (const workspace of [directory, join(directory, 'does', 'not', 'exist')]) {
			const run = await initCommand({ cwd: directory, workspace })
			expect(run.status, workspace).toBe(2)
			expect(run.stderr, workspace).toContain('workspace.git_required')
		}
		expect(await readdir(directory)).toEqual([])
	})

	it('refuses the default location outside a work tree and creates no <cwd>/.uiux/', async () => {
		const directory = await outsideGit()
		const run = await initCommand({ cwd: directory })
		expect(run.status).toBe(2)
		expect(run.stderr).toContain('workspace.git_required')
		expect(existsSync(join(directory, '.uiux'))).toBe(false)
		expect(await readdir(directory)).toEqual([])
	})

	it('refuses, creating nothing, when git cannot be run', async () => {
		const repo = await insideGit()
		const run = await withoutGit(() => initCommand({ cwd: repo }))
		expect(run.status).toBe(2)
		expect(run.stderr).toContain('workspace.git_required')
		expect(run.stderr).toContain('git cannot be run')
		expect(existsSync(join(repo, '.uiux'))).toBe(false)
	})

	it('refuses through the installed command, with the code on standard error and status 2', async () => {
		const directory = await outsideGit()
		const result = spawnSync(process.execPath, [CLI, 'init'], { cwd: directory, encoding: 'utf8', env: { ...process.env, UIUX_HOME: join(await outsideGit(), 'home') } })
		expect(result.status, result.stderr).toBe(2)
		expect(result.stderr).toContain('workspace.git_required')
		expect(await readdir(directory)).toEqual([])
		const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' })
		expect(help.stdout).toContain('Git is')
		expect(help.stdout).toContain('workspace.git_required')
	}, 30_000)
})

describe('uiux dev and the packaged server need Git', () => {
	it('refuses a Workspace copied outside a work tree, before any server hold, lock or listener', async () => {
		const directory = await outsideGit()
		const root = join(directory, 'design')
		await writeCurrentWorkspace(root)
		const home = join(await outsideGit(), 'home')
		const before = await readdir(root)
		const result = spawnSync(process.execPath, [CLI, 'dev', '--workspace', root], { cwd: directory, encoding: 'utf8', env: { ...process.env, UIUX_HOME: home, PORT: '0' }, timeout: 60_000 })
		expect(result.status, result.stdout + result.stderr).toBe(2)
		expect(result.stderr).toContain('workspace.git_required')
		expect(result.stdout).not.toContain('serving Workspace')
		expect(await readdir(root)).toEqual(before)
		expect(existsSync(join(root, '.server-hold.json'))).toBe(false)
		expect(existsSync(home)).toBe(false)
	}, 90_000)

	// `pnpm test` builds the packaged server first; a run of this file alone needs `pnpm build` before it.
	it.skipIf(!existsSync(SERVER))('refuses the packaged server run directly, however it is started', async () => {
		const directory = await outsideGit()
		const root = join(directory, 'design')
		await writeCurrentWorkspace(root)
		const child = spawn(process.execPath, [SERVER], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, UIUX_WORKSPACE_ROOT: root, UIUX_HOME: join(await outsideGit(), 'home'), PORT: '0', NITRO_PORT: '0', HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1' } })
		let output = ''
		child.stdout.on('data', chunk => { output += String(chunk) })
		child.stderr.on('data', chunk => { output += String(chunk) })
		const status = await new Promise<number | null>(resolve => child.once('exit', resolve))
		expect(status, output).toBe(2)
		expect(output).toContain('workspace.git_required')
		expect(output).not.toMatch(/Listening on/iu)
		expect(existsSync(join(root, '.server-hold.json'))).toBe(false)
	}, 60_000)
})

describe('other commands never need Git', () => {
	it('lists the members of a Workspace outside a work tree, and discovery selects it', async () => {
		const directory = await outsideGit()
		const root = join(directory, 'design')
		await writeCurrentWorkspace(root)
		await writeFile(join(directory, 'note.txt'), 'x')
		const result = spawnSync(process.execPath, [CLI, 'member', 'list', '--workspace', root], { cwd: directory, encoding: 'utf8', env: { ...process.env, UIUX_HOME: join(await outsideGit(), 'home') }, timeout: 60_000 })
		expect(result.stderr).not.toContain('workspace.git_required')
		const gc = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--dry-run', '--workspace', root], { cwd: directory, encoding: 'utf8', timeout: 60_000 })
		expect(gc.status, gc.stderr).toBe(0)
	}, 120_000)

	it('discovers the .uiux/ of the current directory without --workspace, outside a work tree, for a command that starts nothing', async () => {
		const directory = await outsideGit()
		await writeCurrentWorkspace(join(directory, '.uiux'))
		const home = join(await outsideGit(), 'home')
		const listed = spawnSync(process.execPath, [CLI, 'member', 'list'], { cwd: directory, encoding: 'utf8', env: { ...process.env, UIUX_HOME: home }, timeout: 60_000 })
		expect(listed.stderr).not.toContain('workspace.git_required')
		expect(listed.status, listed.stderr).toBe(0)
		expect(listed.stdout).toContain('No roster yet')
		const gc = spawnSync(process.execPath, [CLI, 'artifacts', 'gc', '--dry-run'], { cwd: directory, encoding: 'utf8', env: { ...process.env, UIUX_HOME: home }, timeout: 60_000 })
		expect(gc.stderr).not.toContain('workspace.git_required')
		expect(gc.status, gc.stderr).toBe(0)
	}, 120_000)
})
