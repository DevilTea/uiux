import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { builtInAccessPresetsFile } from '../src/domain/access-presets/schema'
import { emptyProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, checkWorkspaceSelection, FileNativePersistence, V5_LAYOUT, viewRelativePath } from '../src/persistence'
import { CURRENT_WORKSPACE_SCHEMA_VERSION, PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { currentManifest, writeManifest } from './support/workspace-layout'

/**
 * The entry check (Clause 01a126c7-7c2a-7bb7-b4db-c86fa04ac9e9): a selected directory whose manifest is
 * not at the current `schemaVersion`, older or newer, is refused before any lock, hold, recovery, read
 * or write, with the message of Clause 01a14928-275b-74d5-ad43-c82932e39cb3; and the
 * `product-kit.json` requirement of a root (Clause 01a11bb1-8d67-71c5-929f-138afd0c66ec).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const CLI = resolve(process.cwd(), 'bin/uiux.mjs')
const SERVER = resolve(process.cwd(), '.output/server/index.mjs')
const POLICY = PRODUCT_WORKSPACE_SCHEMA_POLICY

const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function makeRoot(prefix = 'uiux-selection-'): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), prefix)))
	roots.push(root)
	return root
}

async function exists(path: string): Promise<boolean> {
	return lstat(path).then(() => true, () => false)
}

/** Every file under `root` with its bytes, to show a refused command wrote nothing. */
async function tree(root: string): Promise<Record<string, string>> {
	const files: Record<string, string> = {}
	async function walk(directory: string): Promise<void> {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) await walk(path)
			else files[relative(root, path)] = (await readFile(path)).toString('base64')
		}
	}
	await walk(root)
	return files
}

function view(name: string) {
	return {
		id: VIEW_ID,
		name,
		ir: { type: 'RootShell', id: 'root', slots: { content: [] } },
		variants: {},
		spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], requirements: [], decisions: [] },
	}
}

/** A current-schema root at `<parent>/.uiux/` with one View; `schemaVersion` rewrites its manifest's version. */
async function workspace(schemaVersion = CURRENT_WORKSPACE_SCHEMA_VERSION): Promise<Readonly<{ parent: string; root: string }>> {
	const parent = await makeRoot()
	const root = join(parent, '.uiux')
	await writeManifest(root, canonicalJsonBytes({ ...currentManifest(), schemaVersion }), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(emptyProductKit()))
	await writeFile(join(root, 'access-presets.json'), canonicalJsonBytes(builtInAccessPresetsFile()))
	await mkdir(join(root, 'views'))
	await writeFile(join(root, viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Now')))
	return { parent, root }
}

/** A Workspace an old build wrote: `<X>/.uiux/workspace.json` at schemaVersion 4, with its data directories in `<X>/`. */
async function oldBuildWorkspace(): Promise<string> {
	const x = await makeRoot()
	await mkdir(join(x, '.uiux'))
	await writeFile(join(x, '.uiux', 'workspace.json'), canonicalJsonBytes({ schemaVersion: 4, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
	await mkdir(join(x, 'views'))
	await writeFile(join(x, viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Now')))
	return x
}

/** A pending (uncommitted) transaction whose backup restores the View to `Before`, in the format given. */
async function pendingJournal(transactionsDir: string, journal: (entries: unknown[]) => unknown): Promise<string> {
	const id = randomUUID()
	const directory = join(transactionsDir, id)
	await mkdir(join(directory, 'backup', 'views'), { recursive: true })
	await writeFile(join(directory, 'backup', viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Before')))
	await writeFile(join(directory, 'journal.json'), JSON.stringify(journal([{ path: viewRelativePath(VIEW_ID), existed: true }])))
	return join(directory, 'journal.json')
}

/** The refusal message of Clause 01a14928-275b-74d5-ad43-c82932e39cb3 for a manifest at `version`. */
function expectSchemaRefusal(message: string, version: number): void {
	expect(message).toContain('workspace.schema_unsupported')
	expect(message).toContain(`schemaVersion ${version} `)
	expect(message).toContain(`schemaVersion ${CURRENT_WORKSPACE_SCHEMA_VERSION}`)
	expect(message).toContain('uiux init')
	expect(message).not.toContain('migrat')
}

describe('checkWorkspaceSelection', () => {
	it('accepts a current root and an uninitialized directory', async () => {
		expect(checkWorkspaceSelection((await workspace()).root, POLICY)).toEqual({ ok: true, layout: V5_LAYOUT })
		expect(checkWorkspaceSelection(await makeRoot(), POLICY)).toEqual({ ok: true, layout: V5_LAYOUT })
	})

	it('refuses a manifest at any other schemaVersion, older or newer, naming it, the current one and uiux init', async () => {
		for (const version of [1, 2, 3, 4, 5, CURRENT_WORKSPACE_SCHEMA_VERSION + 1]) {
			const { root } = await workspace(version)
			const refused = checkWorkspaceSelection(root, POLICY)
			expect(refused, String(version)).toMatchObject({ ok: false, reason: 'unsupported_schema' })
			expectSchemaRefusal(refused.ok ? '' : refused.message, version)
		}
	})

	it('refuses the directory above a root at another schemaVersion with that refusal, not as the root\'s parent', async () => {
		for (const version of [4, 5]) {
			const { parent, root } = await workspace(version)
			const refused = checkWorkspaceSelection(parent, POLICY)
			expect(refused, String(version)).toMatchObject({ ok: false, reason: 'unsupported_schema', message: expect.stringContaining(join(root, 'workspace.json')) })
			expectSchemaRefusal(refused.ok ? '' : refused.message, version)
		}
		const x = await oldBuildWorkspace()
		const refused = checkWorkspaceSelection(x, POLICY)
		expect(refused).toMatchObject({ ok: false, reason: 'unsupported_schema' })
		expectSchemaRefusal(refused.ok ? '' : refused.message, 4)
	})

	it('refuses each other selection with a reason a caller can act on', async () => {
		const foreign = await makeRoot()
		await writeFile(join(foreign, 'workspace.json'), '{"version":2,"projects":{}}\n')
		expect(checkWorkspaceSelection(foreign, POLICY)).toEqual({ ok: false, reason: 'foreign_manifest', message: expect.stringContaining('is not a UIUX Workspace manifest') })

		const { parent } = await workspace()
		expect(checkWorkspaceSelection(parent, POLICY)).toEqual({ ok: false, reason: 'relocated_parent', message: expect.stringContaining(`its Workspace root is ${join(parent, '.uiux')}`) })
		// The `.uiux/` child decides when another tool's workspace.json sits beside it.
		await writeFile(join(parent, 'workspace.json'), '{"version":2,"projects":{}}\n')
		expect(checkWorkspaceSelection(parent, POLICY)).toMatchObject({ ok: false, reason: 'relocated_parent' })

		const { root: withoutKit } = await workspace()
		await rm(join(withoutKit, 'product-kit.json'))
		expect(checkWorkspaceSelection(withoutKit, POLICY)).toEqual({ ok: false, reason: 'missing_product_kit', message: expect.stringContaining('no product-kit.json') })
	})
})

describe('recovery refuses a journal not written for the Workspace layout, and keeps it', () => {
	for (const [name, format] of [
		['the { changes } format of the removed old layout', (entries: unknown[]) => ({ changes: entries })],
		['another layout', (entries: unknown[]) => ({ layout: 'legacy', entries })],
	] as const) {
		it(name, async () => {
			const { root } = await workspace()
			const journal = await pendingJournal(join(root, V5_LAYOUT.transactionsDir), format)
			const before = await tree(root)
			const persistence = new FileNativePersistence({ root, schemaPolicy: POLICY })
			await expect(persistence.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
			await expect(persistence.withLock(async () => undefined)).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
			expect(await exists(journal)).toBe(true)
			expect(await tree(root)).toEqual(before)
		})
	}

	it('recovers a journal of its own layout, which is what it writes', async () => {
		const { root } = await workspace()
		const seen: unknown[] = []
		const persistence = new FileNativePersistence({
			root,
			schemaPolicy: POLICY,
			async fault(point) {
				if (point !== 'transaction.before_apply') return
				const directory = join(root, V5_LAYOUT.transactionsDir)
				for (const id of await readdir(directory)) seen.push(JSON.parse(await readFile(join(directory, id, 'journal.json'), 'utf8')))
			},
		})
		await persistence.withLock(() => persistence.applyFileTransaction([{ path: viewRelativePath(VIEW_ID), bytes: canonicalJsonBytes(view('A')) }], 'asset'))
		expect(seen).toEqual([{ layout: 'v5', entries: [{ path: viewRelativePath(VIEW_ID), existed: true }] }])

		const journal = await pendingJournal(join(root, V5_LAYOUT.transactionsDir), entries => ({ layout: 'v5', entries }))
		const own = new FileNativePersistence({ root, schemaPolicy: POLICY })
		expect((await own.views.read(VIEW_ID))?.resource).toMatchObject({ name: 'Before' })
		expect(await exists(journal)).toBe(false)
	})
})

describe('a current-schema root without product-kit.json', () => {
	it('cannot be written', async () => {
		const { root } = await workspace()
		await rm(join(root, 'product-kit.json'))
		const persistence = new FileNativePersistence({ root, schemaPolicy: POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'unsupported', version: CURRENT_WORKSPACE_SCHEMA_VERSION })
		const current = (await persistence.views.read(VIEW_ID))!
		await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: current.revision, resource: view('Changed') as never })).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})
})

describe('entry points refuse a Workspace that is not current with exit status 2 before touching anything (Q4)', () => {
	/** Each refused selection: what is given, the directory it must leave unchanged and the version its message names. */
	async function refusedSelections(): Promise<readonly Readonly<{ name: string; selected: string; scope: string; version?: number }>[]> {
		const { parent: older } = await workspace(5)
		const x = await oldBuildWorkspace()
		const foreign = await makeRoot()
		await writeFile(join(foreign, 'workspace.json'), '{"version":2,"projects":{}}\n')
		const { parent: withoutKit } = await workspace()
		await rm(join(withoutKit, '.uiux', 'product-kit.json'))
		return [
			{ name: 'a Workspace at schemaVersion 5', selected: join(older, '.uiux'), scope: older, version: 5 },
			{ name: 'the directory above a Workspace at schemaVersion 5', selected: older, scope: older, version: 5 },
			{ name: 'an old build\'s Workspace (schemaVersion 4)', selected: x, scope: x, version: 4 },
			{ name: 'an old build\'s .uiux/ (schemaVersion 4)', selected: join(x, '.uiux'), scope: x, version: 4 },
			{ name: 'a foreign workspace.json', selected: foreign, scope: foreign },
			{ name: 'a root without product-kit.json', selected: join(withoutKit, '.uiux'), scope: withoutKit },
		]
	}

	it('every roster command, and both sides of access copy', async () => {
		const { root: current } = await workspace()
		for (const { name, selected, scope, version } of await refusedSelections()) {
			const before = await tree(scope)
			const currentBefore = await tree(current)
			const home = join(await makeRoot('uiux-selection-home-'), 'home')
			const run = async (argv: readonly string[]) => {
				const errors: string[] = []
				const status = await runAccessCommand({ argv, env: { UIUX_HOME: home }, stdout: () => undefined, stderr: line => errors.push(line) })
				const text = errors.join('\n')
				expect(text, `${name}: ${argv.join(' ')}`).not.toMatch(/at .*\(/)
				if (version !== undefined) expectSchemaRefusal(text, version)
				return status
			}
			for (const command of [['member', 'list'], ['token', 'list'], ['session', 'list'], ['invite', 'create', '--member', 'someone']])
				expect(await run([...command, '--workspace', selected]), `${name}: ${command.join(' ')}`).toBe(2)
			expect(await run(['access', 'copy', '--from', current, '--workspace', selected]), name).toBe(2)
			// A copy from a Workspace this UIUX cannot read is refused too, naming its version, whether --from
			// names the root or the directory above it, such as an old build's Workspace (issue #232); the
			// target is current.
			if (version !== undefined) expect(await run(['access', 'copy', '--from', selected, '--workspace', current]), name).toBe(2)
			expect(await tree(scope), name).toEqual(before)
			expect(await tree(current), name).toEqual(currentBefore)
			expect(await exists(home), name).toBe(false)
		}
	})

	it('uiux dev, with --workspace and by discovery from inside the old directory', async () => {
		const x = await oldBuildWorkspace()
		const { parent: older } = await workspace(5)
		for (const [args, cwd, scope, version] of [
			[['--workspace', x], process.cwd(), x, 4],
			[[], x, x, 4],
			[['--workspace', join(older, '.uiux')], process.cwd(), older, 5],
		] as const) {
			const before = await tree(scope)
			const home = join(await makeRoot('uiux-selection-home-'), 'home')
			const result = spawnSync(process.execPath, [CLI, 'dev', ...args], { cwd, encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
			expect(result.status, result.stderr).toBe(2)
			expectSchemaRefusal(result.stderr, version)
			expect(await tree(scope)).toEqual(before)
			expect(await exists(home)).toBe(false)
		}
	}, 60_000)

	it('the packaged server', async () => {
		const { parent: older } = await workspace(5)
		const before = await tree(older)
		const home = join(await makeRoot('uiux-selection-home-'), 'home')
		const server = spawn(process.execPath, [SERVER], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: '0', NITRO_PORT: '0', UIUX_WORKSPACE_ROOT: join(older, '.uiux'), UIUX_PACKAGE_ROOT: process.cwd(), UIUX_HOME: home },
		})
		let output = ''
		server.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		server.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		const code = await new Promise<number | null>(resolveExit => server.once('exit', resolveExit))
		expect(code, output).toBe(2)
		expectSchemaRefusal(output, 5)
		expect(await tree(older)).toEqual(before)
		expect(await exists(home)).toBe(false)
	}, 60_000)
})
