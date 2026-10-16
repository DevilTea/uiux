import { execFileSync, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { missingDefaultLocaleError } from '../src/application/services/default-locale-gate'
import { runInitCommand } from '../src/cli/init'
import { emptyProductKit } from '../src/domain/product-kit/schema'
import { FileNativePersistence } from '../src/persistence/file-native'
import { checkWorkspaceSelection } from '../src/persistence/workspace-selection'
import { V5_LAYOUT } from '../src/persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY, WORKSPACE_GITIGNORE_RULES } from '../src/product/workspace-schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * `uiux init` (Clauses 01a1144e-55a3-74c4-8bf8-3205e968e275 and 01a1144e-55be-785d-b494-7f7da834572a):
 * the default location inside and outside a Git repository, the files written, and the refusals.
 */
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeDirectory(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-init-')))
	roots.push(root)
	return root
}

function capture() {
	const stdout: string[] = []
	const stderr: string[] = []
	return { stdout, stderr, options: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } }
}

async function expectInitialized(root: string): Promise<void> {
	expect(JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8'))).toEqual({
		schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		i18n: { defaultLocale: 'en-US' },
		viewports: {},
		themes: {},
	})
	expect(JSON.parse(await readFile(join(root, 'product-kit.json'), 'utf8'))).toEqual(emptyProductKit())
	// Owner ruling 2 of https://github.com/DevilTea/uiux/issues/94#issuecomment-6218608568.
	expect(await readFile(join(root, 'i18n', 'en-US.json'), 'utf8')).toBe('{}\n')
	expect((await readFile(join(root, '.gitignore'), 'utf8')).split('\n').filter(Boolean)).toEqual([...WORKSPACE_GITIGNORE_RULES])
	expect(checkWorkspaceSelection(root, PRODUCT_WORKSPACE_SCHEMA_POLICY)).toEqual({ ok: true, layout: V5_LAYOUT })
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'current', version: CURRENT_WORKSPACE_SCHEMA_VERSION })
	// The default Locale has its file, so Preview and capture are not blocked by i18n.missing_default_locale.
	expect((await persistence.locales.read('en-US'))?.resource).toEqual({})
	expect(await missingDefaultLocaleError(persistence)).toBeUndefined()
}

describe('uiux init', () => {
	it('creates a schemaVersion 5 Workspace in <git toplevel>/.uiux/ from anywhere in a Git repository', async () => {
		const repository = await makeDirectory()
		execFileSync('git', ['init', '-q', repository])
		const nested = join(repository, 'packages', 'app')
		await mkdir(nested, { recursive: true })
		const result = spawnSync(process.execPath, [CLI, 'init'], { cwd: nested, encoding: 'utf8' })
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout).toContain(`Initialized UIUX Workspace at ${join(repository, '.uiux')}`)
		await expectInitialized(join(repository, '.uiux'))
		expect(await readdir(nested)).toEqual([])
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('creates the Workspace in <cwd>/.uiux/ outside a Git repository', async () => {
		const cwd = await makeDirectory()
		const run = capture()
		expect(await runInitCommand({ cwd, gitToplevel: () => undefined, ...run.options })).toBe(0)
		await expectInitialized(join(cwd, '.uiux'))
		expect(run.stdout.join('\n')).toContain('uiux dev')
	})

	it('creates the Workspace in a custom --workspace directory, which holds the manifest directly', async () => {
		const cwd = await makeDirectory()
		const run = capture()
		expect(await runInitCommand({ cwd, workspace: 'nested/ws', gitToplevel: () => { throw new Error('not consulted') }, ...run.options })).toBe(0)
		await expectInitialized(join(cwd, 'nested', 'ws'))
		expect(run.stdout.join('\n')).toContain(`uiux dev --workspace ${join(cwd, 'nested', 'ws')}`)
	})

	it('refuses an initialized Workspace, of either layout, and changes nothing', async () => {
		const cwd = await makeDirectory()
		expect(await runInitCommand({ cwd, workspace: 'ws', ...capture().options })).toBe(0)
		const before = await readFile(join(cwd, 'ws', 'workspace.json'), 'utf8')
		const again = capture()
		expect(await runInitCommand({ cwd, workspace: 'ws', ...again.options })).toBe(2)
		expect(again.stderr.join('\n')).toContain('already initialized')
		expect(await readFile(join(cwd, 'ws', 'workspace.json'), 'utf8')).toBe(before)

		// An old-layout root keeps its manifest in .uiux/: init never writes a second manifest beside it.
		const old = join(cwd, 'old')
		await mkdir(join(old, '.uiux'), { recursive: true })
		await writeFile(join(old, '.uiux', 'workspace.json'), '{"schemaVersion":4}\n')
		const legacy = capture()
		expect(await runInitCommand({ cwd, workspace: 'old', ...legacy.options })).toBe(2)
		expect(legacy.stderr.join('\n')).toContain('already initialized')
		expect(await readdir(old)).toEqual(['.uiux'])

		// Nor the default location when it is an old-layout metadata directory.
		const repository = join(cwd, 'repo')
		await mkdir(join(repository, '.uiux'), { recursive: true })
		await writeFile(join(repository, '.uiux', 'workspace.json'), '{"schemaVersion":4}\n')
		expect(await runInitCommand({ cwd: repository, gitToplevel: () => repository, ...capture().options })).toBe(2)
		expect(await readdir(join(repository, '.uiux'))).toEqual(['workspace.json'])
	})

	it('keeps an existing .gitignore and appends only the missing rules', async () => {
		const cwd = await makeDirectory()
		const root = join(cwd, 'ws')
		await mkdir(root)
		await writeFile(join(root, '.gitignore'), `# mine\n${WORKSPACE_GITIGNORE_RULES[0]}`)
		expect(await runInitCommand({ cwd, workspace: 'ws', ...capture().options })).toBe(0)
		expect(await readFile(join(root, '.gitignore'), 'utf8')).toBe(`# mine\n${WORKSPACE_GITIGNORE_RULES.join('\n')}\n`)
	})

	it('refuses an existing default-Locale file, or an i18n entry that is not a directory, before writing anything', async () => {
		const cwd = await makeDirectory()
		const root = join(cwd, 'ws')
		await mkdir(join(root, 'i18n'), { recursive: true })
		await writeFile(join(root, 'i18n', 'en-US.json'), '{"keep":"me"}\n')
		const run = capture()
		expect(await runInitCommand({ cwd, workspace: 'ws', ...run.options })).toBe(2)
		expect(run.stderr.join('\n')).toContain('already holds i18n/en-US.json')
		expect(await readdir(root)).toEqual(['i18n'])
		expect(await readFile(join(root, 'i18n', 'en-US.json'), 'utf8')).toBe('{"keep":"me"}\n')

		const other = join(cwd, 'other')
		await mkdir(other)
		await writeFile(join(other, 'i18n'), '')
		const file = capture()
		expect(await runInitCommand({ cwd, workspace: 'other', ...file.options })).toBe(2)
		expect(file.stderr.join('\n')).toContain(`${join(other, 'i18n')} is not a directory`)
		expect(await readdir(other)).toEqual(['i18n'])
	})

	it('refuses a .gitignore that is not a regular file before writing anything', async () => {
		const cwd = await makeDirectory()
		const root = join(cwd, 'ws')
		await mkdir(join(root, '.gitignore'), { recursive: true })
		const run = capture()
		expect(await runInitCommand({ cwd, workspace: 'ws', ...run.options })).toBe(2)
		expect(run.stderr.join('\n')).toContain('.gitignore is not a regular file')
		expect(await readdir(root)).toEqual(['.gitignore'])
	})

	// Owner ruling 2 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730
	// (Clause 01a1144e-5649-7ba2-bb90-ad49658f0400).
	it('refuses a directory that is UIUX_HOME, lies inside it or contains it, and creates nothing', async () => {
		const cwd = await makeDirectory()
		const home = join(cwd, 'host', 'uiux-home')
		await mkdir(home, { recursive: true })
		for (const [workspace, created] of [[home, home], [join(home, 'ws'), join(home, 'ws')], [join(cwd, 'host'), join(cwd, 'host')]] as const) {
			const run = capture()
			expect(await runInitCommand({ cwd, workspace, env: { UIUX_HOME: home }, ...run.options })).toBe(2)
			expect(run.stderr.join('\n')).toContain(`overlaps UIUX_HOME (${home})`)
			expect(run.stderr.join('\n')).toContain('--workspace <dir>, or set UIUX_HOME')
			expect(await readdir(created).catch(() => 'absent')).toEqual(created === join(home, 'ws') ? 'absent' : created === home ? [] : ['uiux-home'])
		}

		// The default location: `uiux init` in the home directory would create ~/.uiux, the default UIUX_HOME.
		const user = join(cwd, 'user')
		await mkdir(user)
		const run = capture()
		expect(await runInitCommand({ cwd: user, gitToplevel: () => undefined, env: { UIUX_HOME: join(user, '.uiux') }, ...run.options })).toBe(2)
		expect(await readdir(user)).toEqual([])

		// A sibling of UIUX_HOME is fine.
		expect(await runInitCommand({ cwd, workspace: join(cwd, 'host', 'ws'), env: { UIUX_HOME: home }, ...capture().options })).toBe(0)
	})

	it('refuses a --workspace that is a dangling symbolic link, or lies below one, without a stack trace', async () => {
		const cwd = await makeDirectory()
		const home = join(cwd, 'uiux-home')
		await mkdir(home)
		await symlink(join(home, 'missing'), join(cwd, 'link'))
		const run = capture()
		expect(await runInitCommand({ cwd, workspace: 'link', env: { UIUX_HOME: home }, ...run.options })).toBe(2)
		expect(run.stderr.join('\n')).toContain(`symbolic link whose target does not exist: ${join(cwd, 'link')}`)
		const below = capture()
		expect(await runInitCommand({ cwd, workspace: 'link/ws', env: { UIUX_HOME: home }, ...below.options })).toBe(2)
		expect(below.stderr.join('\n')).toContain(`cannot create the Workspace directory ${join(cwd, 'link', 'ws')}`)
		expect(await readdir(home)).toEqual([])
	})

	it('refuses a --workspace that is a file', async () => {
		const cwd = await makeDirectory()
		await writeFile(join(cwd, 'file'), '')
		const run = capture()
		expect(await runInitCommand({ cwd, workspace: 'file', ...run.options })).toBe(2)
		expect(run.stderr.join('\n')).toContain('not a directory')
	})
})
