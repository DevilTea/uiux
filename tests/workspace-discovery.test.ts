import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { runInitCommand } from '../src/cli/init'
import { runSelectedMigrateCommand } from '../src/cli/migrate'
import { LEGACY_LAYOUT, V5_LAYOUT } from '../src/persistence/paths'
import { selectWorkspace } from '../src/persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * Workspace selection for every command that acts on a Workspace: the optional `--workspace <dir>`
 * (Clause 01a1144e-5584-7101-98c0-dc3cbadbacdf) and discovery without it (Clause
 * 01a11bb1-9847-751f-a1ba-943ad111a02a), with a found old-layout `.uiux/` mapped to its parent
 * before the entry check (Clause 01a11bb1-98a9-7881-8fa0-ee1e355a3a9a; Scenario
 * 01a11bb1-bf1b-7e2f-9256-170e5d400195).
 */
const CLI = join(fileURLToPath(new URL('..', import.meta.url)), 'bin', 'uiux.mjs')
const POLICY = PRODUCT_WORKSPACE_SCHEMA_POLICY
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

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

/** A repository holding an old-layout Workspace in `design/` (manifest `design/.uiux/workspace.json`). */
async function repositoryWithOldLayout(version = 4): Promise<Readonly<{ repository: string; root: string; nested: string }>> {
	const repository = await makeDirectory()
	const root = join(repository, 'design')
	await mkdir(join(root, '.uiux'), { recursive: true })
	await writeFile(join(root, ...LEGACY_LAYOUT.manifestPath.split('/')), `${JSON.stringify({ schemaVersion: version, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} })}\n`)
	const nested = join(root, 'views')
	await mkdir(nested, { recursive: true })
	return { repository, root, nested }
}

describe('Workspace discovery (no --workspace)', () => {
	it('selects the .uiux/ child of the nearest directory upward that has .uiux/workspace.json', async () => {
		const { repository, root, nested } = await repositoryWithWorkspace()
		for (const cwd of [nested, repository, root, join(root, 'kit')])
			expect(selectWorkspace({ cwd }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: true })
	})

	it('maps a found .uiux/ below schemaVersion 5 to its parent, the old-layout root, before the entry check', async () => {
		const { root, nested } = await repositoryWithOldLayout()
		for (const cwd of [nested, root, join(root, '.uiux')])
			expect(selectWorkspace({ cwd }, POLICY)).toEqual({ ok: true, root, layout: LEGACY_LAYOUT, discovered: true })
	})

	it('picks the nearest Workspace when Workspaces nest', async () => {
		const { repository, root } = await repositoryWithWorkspace()
		const inner = join(repository, 'packages', 'inner')
		expect(await runInitCommand({ cwd: repository, workspace: join(inner, '.uiux'), stdout: () => undefined })).toBe(0)
		expect(selectWorkspace({ cwd: join(inner, '.uiux', 'views') }, POLICY)).toMatchObject({ ok: true, root: join(inner, '.uiux') })
		expect(selectWorkspace({ cwd: join(repository, 'packages') }, POLICY)).toMatchObject({ ok: true, root })
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
		await writeFile(join(withoutKit, '.uiux', 'workspace.json'), '{"schemaVersion":5,"i18n":{"defaultLocale":"en-US"},"viewports":{},"themes":{}}\n')
		expect(selectWorkspace({ cwd: withoutKit }, POLICY)).toMatchObject({ ok: false, reason: 'missing_product_kit' })
	})
})

describe('explicit --workspace', () => {
	it('selects the root, or the schemaVersion 5 root in the .uiux/ child of the given directory', async () => {
		const { repository, root } = await repositoryWithWorkspace()
		expect(selectWorkspace({ cwd: repository, workspace: '.uiux' }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: false })
		expect(selectWorkspace({ cwd: repository, workspace: '.' }, POLICY)).toEqual({ ok: true, root, layout: V5_LAYOUT, discovered: false })
	})

	it('selects an old-layout root, and refuses its own .uiux/ directory, naming the parent', async () => {
		const { repository, root } = await repositoryWithOldLayout()
		expect(selectWorkspace({ cwd: repository, workspace: 'design' }, POLICY)).toEqual({ ok: true, root, layout: LEGACY_LAYOUT, discovered: false })
		expect(selectWorkspace({ cwd: repository, workspace: 'design/.uiux' }, POLICY)).toMatchObject({ ok: false, reason: 'legacy_metadata_dir', message: expect.stringContaining(`select its parent ${root}`) })
	})

	it('refuses a missing directory and a file', async () => {
		const base = await makeDirectory()
		await writeFile(join(base, 'file'), '')
		expect(selectWorkspace({ cwd: base, workspace: 'missing' }, POLICY)).toMatchObject({ ok: false, reason: 'not_found' })
		expect(selectWorkspace({ cwd: base, workspace: 'file' }, POLICY)).toMatchObject({ ok: false, reason: 'not_a_directory' })
	})
})

describe('commands without --workspace', () => {
	it('uiux migrate and the access commands act on the discovered Workspace', async () => {
		const { root, nested } = await repositoryWithWorkspace()
		const home = join(await makeDirectory(), 'home')
		const out: string[] = []
		expect(await runSelectedMigrateCommand({ cwd: nested, dryRun: true, home, stdout: line => out.push(line), stderr: line => out.push(line) })).toBe(0)
		expect(out.join('\n')).toContain(`UIUX Workspace ${root} is already at schemaVersion 5`)

		const access: string[] = []
		expect(await runAccessCommand({ argv: ['member', 'add', 'ada', '--preset', 'Owner'], cwd: nested, env: { UIUX_HOME: home }, stdout: line => access.push(line), stderr: line => access.push(line) })).toBe(0)
		expect(access.join('\n')).toContain(`for ${root}`)
	})

	it('a discovered old-layout Workspace is migrated in place by uiux migrate', async () => {
		const { root, nested } = await repositoryWithOldLayout()
		const home = join(await makeDirectory(), 'home')
		const out: string[] = []
		expect(await runSelectedMigrateCommand({ cwd: nested, dryRun: true, home, stdout: line => out.push(line), stderr: line => out.push(line) }), out.join('\n')).toBe(0)
		expect(out.join('\n')).toContain(`Migration plan for UIUX Workspace ${root} (dry run, nothing written)`)
		expect(out.join('\n')).toContain('uiux.v4-to-v5')
	})

	it('the access commands refuse when nothing is discovered, so no stray roster is created', async () => {
		const empty = await makeDirectory()
		const errors: string[] = []
		expect(await runAccessCommand({ argv: ['member', 'list'], cwd: empty, env: { UIUX_HOME: join(empty, 'home') }, stdout: () => undefined, stderr: line => errors.push(line) })).toBe(2)
		expect(errors.join('\n')).toContain('No UIUX Workspace found')
	})

	it('uiux dev without --workspace from a subdirectory serves the repository Workspace in .uiux/', async () => {
		const { root, nested } = await repositoryWithWorkspace()
		const port = await freePort()
		const child = spawn(process.execPath, [CLI, 'dev'], { cwd: nested, env: { ...process.env, UIUX_HOME: join(await makeDirectory(), 'home'), PORT: String(port), HOST: '', NITRO_HOST: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
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
