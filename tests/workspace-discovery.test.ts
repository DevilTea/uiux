import { spawn } from 'node:child_process'
import { lstatSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { runInitCommand } from '../src/cli/init'
import { V5_LAYOUT } from '../src/persistence/paths'
import { type DiscoveryHost, selectWorkspace } from '../src/persistence/workspace-selection'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * Workspace selection for every command that acts on a Workspace: the optional `--workspace <dir>`
 * (Clause 01a1144e-5584-7101-98c0-dc3cbadbacdf) and discovery without it (Clause
 * 01a11bb1-9847-751f-a1ba-943ad111a02a; Scenario 01a11bb1-bf1b-7e2f-9256-170e5d400195), then the
 * entry check (Clause 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9).
 */
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const POLICY = PRODUCT_WORKSPACE_SCHEMA_POLICY
const roots: string[] = []

afterEach(async () => {
	vi.unstubAllEnvs()
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

const uid = process.getuid?.()
const posix = uid !== undefined

/**
 * A discovery host over the real `lstat` with `homeDirectory` as the home directory (the temporary
 * directories lie outside the real one, where discovery examines only the current directory),
 * reporting `foreignOwned` paths as owned by another user.
 */
function host(homeDirectory: string, foreignOwned: readonly string[] = []): DiscoveryHost {
	return {
		homeDirectory,
		userId: uid,
		lstat: (path) => {
			const entry = lstatSync(path)
			return {
				uid: foreignOwned.includes(path) ? (uid ?? 0) + 1 : entry.uid,
				mode: entry.mode,
				isDirectory: () => entry.isDirectory(),
				isSymbolicLink: () => entry.isSymbolicLink(),
			}
		},
	}
}

async function makeDirectory(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-discovery-')))
	roots.push(root)
	return root
}

/** A repository holding a schemaVersion 5 Workspace in `.uiux/`, with a nested subdirectory. */
async function repositoryWithWorkspace(): Promise<Readonly<{ repository: string; root: string; nested: string }>> {
	const repository = await makeDirectory()
	expect(await runInitCommand({ cwd: repository, gitToplevel: () => repository, stdout: () => undefined })).toBe(0)
	const nested = join(repository, 'packages', 'app', 'src')
	await mkdir(nested, { recursive: true })
	return { repository, root: join(repository, '.uiux'), nested }
}

/** A repository holding a Workspace from an old build in `design/` (manifest `design/.uiux/workspace.json`). */
async function repositoryWithOldLayout(version = 4): Promise<Readonly<{ repository: string; root: string; nested: string }>> {
	const repository = await makeDirectory()
	const root = join(repository, 'design')
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, '.uiux', 'workspace.json'), `${JSON.stringify({ schemaVersion: version, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })}\n`)
	const nested = join(root, 'views')
	await mkdir(nested, { recursive: true })
	return { repository, root, nested }
}

describe('Workspace discovery (no --workspace)', () => {
	it('selects the .uiux/ child of the nearest directory upward that has .uiux/workspace.json', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		for (const cwd of [nested, repository, root, join(root, 'kit')])
			expect(selectWorkspace({ cwd, discoveryHost: host(repository) }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: true })
	})

	it('selects a found .uiux/ at an older schemaVersion as the root, which the entry check refuses', async () => {
		const { repository, root, nested } = await repositoryWithOldLayout()
		for (const cwd of [nested, root, join(root, '.uiux')]) {
			const selected = selectWorkspace({ cwd, discoveryHost: host(repository) }, POLICY)
			expect(selected).toMatchObject({ ok: false, reason: 'unsupported_schema', message: expect.stringContaining(join(root, '.uiux', 'workspace.json')) })
			expect(selected).toMatchObject({ message: expect.stringMatching(/workspace\.schema_unsupported.*schemaVersion 4 .*schemaVersion 7.*uiux init/u) })
		}
	})

	it('picks the nearest Workspace when Workspaces nest', async () => {
		const { repository, root } = await repositoryWithWorkspace()
		const inner = join(repository, 'packages', 'inner')
		expect(await runInitCommand({ cwd: repository, workspace: join(inner, '.uiux'), stdout: () => undefined })).toBe(0)
		expect(selectWorkspace({ cwd: join(inner, '.uiux', 'views'), discoveryHost: host(repository) }, POLICY)).toMatchObject({ ok: true, root: join(inner, '.uiux') })
		expect(selectWorkspace({ cwd: join(repository, 'packages'), discoveryHost: host(repository) }, POLICY)).toMatchObject({ ok: true, root })
	})

	it('refuses when no Workspace is found, and runs the entry check on what it finds', async () => {
		const empty = await makeDirectory()
		// The temporary directory's ancestors hold no Workspace.
		expect(selectWorkspace({ cwd: empty }, POLICY)).toMatchObject({ ok: false, reason: 'not_discovered', message: expect.stringContaining('No UIUX Workspace found') })

		const foreign = await makeDirectory()
		await mkdir(join(foreign, '.uiux'))
		await writeFile(join(foreign, '.uiux', 'workspace.json'), '{"name":"not a manifest"}\n')
		expect(selectWorkspace({ cwd: foreign }, POLICY)).toMatchObject({ ok: false, reason: 'foreign_manifest' })

		const withoutKit = await makeDirectory()
		await mkdir(join(withoutKit, '.uiux'))
		await writeFile(join(withoutKit, '.uiux', 'workspace.json'), `${JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })}\n`)
		expect(selectWorkspace({ cwd: withoutKit }, POLICY)).toMatchObject({ ok: false, reason: 'missing_product_kit' })
	})
})

/**
 * The trust boundary of discovery (owner ruling 1 of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18870730): the walk ends at the
 * home directory, and a candidate `.uiux/` that another user owns, or that sits in a directory
 * others can write and the current user does not own, is refused. Tests cannot chown, so they stub
 * the owner that `lstat` reports through the discovery host seam.
 */
describe('discovery trust boundary', () => {
	it('examines the home directory but stops there when the walk would cross it', async () => {
		const base = await makeDirectory()
		expect(await runInitCommand({ cwd: base, gitToplevel: () => base, stdout: () => undefined })).toBe(0)
		const home = join(base, 'home')
		const project = join(home, 'project')
		await mkdir(project, { recursive: true })

		// With the home directory higher up, the walk from the project finds the Workspace in base/.
		expect(selectWorkspace({ cwd: project, discoveryHost: host(base) }, POLICY)).toMatchObject({ ok: true, root: join(base, '.uiux') })
		for (const cwd of [project, home]) {
			expect(selectWorkspace({ cwd, discoveryHost: host(home) }, POLICY)).toMatchObject({
				ok: false,
				reason: 'not_discovered',
				message: expect.stringContaining(`does not search above the home directory ${home}`),
			})
		}

		expect(await runInitCommand({ cwd: home, gitToplevel: () => home, stdout: () => undefined })).toBe(0)
		expect(selectWorkspace({ cwd: project, discoveryHost: host(home) }, POLICY)).toEqual({ ok: true, root: join(home, '.uiux'), layout: V5_LAYOUT, discovered: true })
	})

	// Owner ruling https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18871377.
	it('examines only the current directory when it is outside the home directory, with the trust check', async () => {
		const base = await makeDirectory()
		expect(await runInitCommand({ cwd: base, gitToplevel: () => base, stdout: () => undefined })).toBe(0)
		const home = join(base, 'home')
		const elsewhere = join(base, 'elsewhere')
		await mkdir(home)
		await mkdir(elsewhere)

		// A Workspace in an ancestor of a directory outside the home directory is not discovered.
		expect(selectWorkspace({ cwd: elsewhere, discoveryHost: host(home) }, POLICY)).toMatchObject({
			ok: false,
			reason: 'not_discovered',
			message: expect.stringContaining(`discovery outside the home directory ${home} examines only the current directory`),
		})
		// One in the current directory itself is, also when that directory is above the home directory.
		expect(selectWorkspace({ cwd: base, discoveryHost: host(home) }, POLICY)).toEqual({ ok: true, root: join(base, '.uiux'), layout: V5_LAYOUT, discovered: true })
		if (posix) {
			expect(selectWorkspace({ cwd: base, discoveryHost: host(home, [join(base, '.uiux')]) }, POLICY)).toMatchObject({
				ok: false,
				reason: 'untrusted_candidate',
				message: expect.stringContaining('Pass --workspace <dir>'),
			})
		}
	})

	it.skipIf(!posix)('refuses a schemaVersion 5 .uiux/ in a mode 1777 directory that another user owns', async () => {
		const base = await makeDirectory()
		const shared = join(base, 'shared')
		await mkdir(shared)
		await chmod(shared, 0o1777)
		expect(await runInitCommand({ cwd: base, workspace: join(shared, '.uiux'), stdout: () => undefined })).toBe(0)
		const nested = join(shared, 'project')
		await mkdir(nested)

		const refused = selectWorkspace({ cwd: nested, discoveryHost: host(base, [shared]) }, POLICY)
		expect(refused).toMatchObject({ ok: false, reason: 'untrusted_candidate', message: expect.stringContaining('Pass --workspace <dir>') })
		expect(refused.ok ? '' : refused.message).toContain(`${shared} is writable by other users and not owned by the current user`)
		// The same directory is trusted when the current user owns it.
		expect(selectWorkspace({ cwd: nested, discoveryHost: host(base) }, POLICY)).toMatchObject({ ok: true, root: join(shared, '.uiux') })
		// An explicit --workspace is unaffected.
		expect(selectWorkspace({ cwd: nested, workspace: join(shared, '.uiux'), discoveryHost: host(base, [shared]) }, POLICY)).toMatchObject({ ok: true, root: join(shared, '.uiux'), discovered: false })
	})

	it.skipIf(!posix)('refuses a .uiux/ or a manifest that another user owns, and an explicit --workspace still selects it', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		for (const foreign of [root, join(root, 'workspace.json')]) {
			expect(selectWorkspace({ cwd: nested, discoveryHost: host(repository, [foreign]) }, POLICY)).toMatchObject({
				ok: false,
				reason: 'untrusted_candidate',
				message: expect.stringContaining(`${foreign} is not owned by the current user`),
			})
			expect(selectWorkspace({ cwd: nested, workspace: root, discoveryHost: host(repository, [foreign]) }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: false })
		}
	})

	it.skipIf(!posix)('refuses a .uiux/ that others can write, even one the current user owns', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		await chmod(root, 0o777)
		expect(selectWorkspace({ cwd: nested, discoveryHost: host(repository) }, POLICY)).toMatchObject({
			ok: false,
			reason: 'untrusted_candidate',
			message: expect.stringContaining(`${root} is writable by other users`),
		})
	})

	it('refuses a .uiux that is a symbolic link, without following it', async () => {
		const { root } = await repositoryWithWorkspace()
		const elsewhere = await makeDirectory()
		await symlink(root, join(elsewhere, '.uiux'), 'dir')
		expect(selectWorkspace({ cwd: elsewhere, discoveryHost: host(elsewhere) }, POLICY)).toMatchObject({
			ok: false,
			reason: 'untrusted_candidate',
			message: expect.stringContaining('is a symbolic link'),
		})
	})

	it.skipIf(!posix || uid === 0)('passes over a .uiux/ it cannot read and goes on upward', async () => {
		const { repository, root } = await repositoryWithWorkspace()
		const inner = join(repository, 'packages', 'locked')
		await mkdir(join(inner, '.uiux'), { recursive: true })
		await writeFile(join(inner, '.uiux', 'workspace.json'), '{}\n')
		await chmod(join(inner, '.uiux'), 0o000)
		try {
			expect(selectWorkspace({ cwd: inner, discoveryHost: host(repository) }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: true })
		}
		finally {
			await chmod(join(inner, '.uiux'), 0o755)
		}
	})
})

describe('explicit --workspace', () => {
	it('selects the root, or the schemaVersion 5 root in the .uiux/ child of the given directory', async () => {
		const { repository, root } = await repositoryWithWorkspace()
		expect(selectWorkspace({ cwd: repository, workspace: '.uiux' }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: false })
		expect(selectWorkspace({ cwd: repository, workspace: '.' }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: false })
	})

	it('refuses a Workspace at an older schemaVersion, given as its .uiux/ or as the directory above it', async () => {
		const { repository, root } = await repositoryWithOldLayout()
		for (const workspace of ['design', 'design/.uiux']) {
			expect(selectWorkspace({ cwd: repository, workspace }, POLICY), workspace).toMatchObject({
				ok: false,
				reason: 'unsupported_schema',
				message: expect.stringMatching(/workspace\.schema_unsupported.*schemaVersion 4 .*uiux init/u),
			})
			expect(selectWorkspace({ cwd: repository, workspace }, POLICY)).toMatchObject({ message: expect.stringContaining(join(root, '.uiux')) })
		}
	})

	it('refuses a missing directory and a file', async () => {
		const base = await makeDirectory()
		await writeFile(join(base, 'file'), '')
		expect(selectWorkspace({ cwd: base, workspace: 'missing' }, POLICY)).toMatchObject({ ok: false, reason: 'not_found' })
		expect(selectWorkspace({ cwd: base, workspace: 'file' }, POLICY)).toMatchObject({ ok: false, reason: 'not_a_directory' })
	})
})

describe('commands without --workspace', () => {
	it('the access commands act on the discovered Workspace', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		vi.stubEnv('HOME', repository)
		const home = join(await makeDirectory(), 'home')
		const access: string[] = []
		expect(await runAccessCommand({ argv: ['member', 'add', 'ada', '--preset', 'Owner'], cwd: nested, env: { UIUX_HOME: home }, stdout: line => access.push(line), stderr: line => access.push(line) })).toBe(0)
		expect(access.join('\n')).toContain(`for ${root}`)
	})

	it('the access commands refuse when nothing is discovered, so no stray roster is created', async () => {
		const empty = await makeDirectory()
		const errors: string[] = []
		expect(await runAccessCommand({ argv: ['member', 'list'], cwd: empty, env: { UIUX_HOME: join(empty, 'home') }, stdout: () => undefined, stderr: line => errors.push(line) })).toBe(2)
		expect(errors.join('\n')).toContain('No UIUX Workspace found')
	})

	it('uiux dev without --workspace from a subdirectory serves the repository Workspace in .uiux/', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		const port = await freePort()
		const child = spawn(process.execPath, [CLI, 'dev'], { cwd: nested, env: { ...process.env, HOME: repository, UIUX_HOME: join(await makeDirectory(), 'home'), PORT: String(port), HOST: '', NITRO_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
		let output = ''
		try {
			const healthy = await new Promise<boolean>((resolve) => {
				const timer = setTimeout(() => resolve(false), 30_000)
				child.stdout.on('data', (chunk: Buffer) => {
					output += chunk.toString('utf8')
					if (output.includes('uiux: access roster')) {
						clearTimeout(timer)
						resolve(true)
					}
				})
				child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
				child.once('exit', () => { clearTimeout(timer); resolve(false) })
			})
			expect(healthy, output).toBe(true)
			expect(output).toContain(`uiux: serving Workspace ${root} on 127.0.0.1`)
			expect(output).toContain(`for ${root} (`)
		}
		finally {
			child.kill('SIGTERM')
			await new Promise(resolve => child.exitCode !== null || child.signalCode !== null ? resolve(undefined) : child.once('exit', resolve))
		}
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS * 2)
})

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer()
		server.once('error', reject)
		server.listen(0, '127.0.0.1', () => {
			const address = server.address()
			const port = typeof address === 'object' && address ? address.port : 0
			server.close(() => resolve(port))
		})
	})
}
