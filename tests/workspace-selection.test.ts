import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { createHistoryRecorder, createMigrationHistoryRecorder, type HistoryRecorderClock } from '../src/application/services/history-recorder'
import { runAccessCommand } from '../src/cli/access'
import { runMigrateCommand } from '../src/cli/migrate'
import { emptyProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, checkWorkspaceSelection, FileNativePersistence, LEGACY_LAYOUT, V5_LAYOUT, viewRelativePath } from '../src/persistence'
import { blobDigest, CheckpointStore, HostHistoryStore, runWithDesignWriteContext } from '../src/persistence/history'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { hostHistoryPaths } from '../src/server/access/store'
import { currentManifest, V5_TEST_SCHEMA_POLICY, v5Manifest, writeManifest } from './support/workspace-layout'

/**
 * Layout mismatches at the entry points and in recovery (owner ruling of
 * https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18853316), and the
 * `product-kit.json` requirement of a schemaVersion 5 root (Clause 01a11bb1-8d67-71c5-929f-138afd0c66ec).
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const CLI = resolve(process.cwd(), 'bin/uiux.mjs')
const SERVER = resolve(process.cwd(), '.output/server/index.mjs')
const HUMAN = { type: 'human', id: 'member:m-owner', displayName: 'deviltea' } as const

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
		spec: { intent: 'Pay', entryConditions: [], interactionRules: [], constraints: [], accessibility: [], references: [], decisions: [] },
	}
}

/** An old-layout Workspace `X` at schemaVersion 4 with one View. */
async function legacyWorkspace(): Promise<string> {
	const root = await makeRoot()
	await writeManifest(root, canonicalJsonBytes(currentManifest()), LEGACY_LAYOUT)
	await mkdir(join(root, 'views'))
	await writeFile(join(root, viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Now')))
	return root
}

/** A schemaVersion 5 root at `<parent>/.uiux/` with one View. */
async function relocatedWorkspace(): Promise<Readonly<{ parent: string; root: string }>> {
	const parent = await makeRoot()
	const root = join(parent, '.uiux')
	await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(emptyProductKit()))
	await mkdir(join(root, 'views'))
	await writeFile(join(root, viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Now')))
	return { parent, root }
}

/** A pending (uncommitted) transaction whose backup restores the View to `Before`. */
async function pendingJournal(transactionsDir: string, layout?: string): Promise<string> {
	const id = randomUUID()
	const directory = join(transactionsDir, id)
	await mkdir(join(directory, 'backup', 'views'), { recursive: true })
	await writeFile(join(directory, 'backup', viewRelativePath(VIEW_ID)), canonicalJsonBytes(view('Before')))
	await writeFile(join(directory, 'journal.json'), JSON.stringify({ ...(layout ? { layout } : {}), changes: [{ path: viewRelativePath(VIEW_ID), existed: true }] }))
	return join(directory, 'journal.json')
}

describe('checkWorkspaceSelection', () => {
	it('accepts each layout with its own manifest, and an uninitialized directory', async () => {
		expect(checkWorkspaceSelection(await legacyWorkspace(), 4)).toEqual({ ok: true, layout: LEGACY_LAYOUT })
		expect(checkWorkspaceSelection((await relocatedWorkspace()).root, 4)).toEqual({ ok: true, layout: V5_LAYOUT })
		expect(checkWorkspaceSelection(await makeRoot(), 4)).toEqual({ ok: true, layout: LEGACY_LAYOUT })
		// The old-layout manifest decides when another tool's workspace.json sits beside it.
		const both = await legacyWorkspace()
		await writeFile(join(both, 'workspace.json'), '{"version":2,"projects":{}}\n')
		expect(checkWorkspaceSelection(both, 4)).toEqual({ ok: true, layout: LEGACY_LAYOUT })
	})

	it('refuses an old-layout .uiux/ directory, a foreign workspace.json, a mismatched schemaVersion and a v5 root without product-kit.json', async () => {
		const legacy = await legacyWorkspace()
		expect(checkWorkspaceSelection(join(legacy, '.uiux'), 4)).toEqual({ ok: false, message: expect.stringContaining(`select its parent ${legacy}`) })

		const foreign = await makeRoot()
		await writeFile(join(foreign, 'workspace.json'), '{"version":2,"projects":{}}\n')
		expect(checkWorkspaceSelection(foreign, 4)).toEqual({ ok: false, message: expect.stringContaining('is not a UIUX Workspace manifest') })

		const misplaced = await makeRoot()
		await writeManifest(misplaced, currentManifest(), V5_LAYOUT)
		expect(checkWorkspaceSelection(misplaced, 4)).toEqual({ ok: false, message: expect.stringContaining('is a schemaVersion 4 manifest') })

		const { parent } = await relocatedWorkspace()
		expect(checkWorkspaceSelection(parent, 4)).toEqual({ ok: false, message: expect.stringContaining(`whose Workspace root is ${join(parent, '.uiux')}`) })

		const { root: withoutKit } = await relocatedWorkspace()
		await rm(join(withoutKit, 'product-kit.json'))
		expect(checkWorkspaceSelection(withoutKit, 5)).toEqual({ ok: false, message: expect.stringContaining('no product-kit.json') })
	})
})

describe('recovery refuses a journal written for another layout', () => {
	it('keeps an old-layout journal when the Workspace\'s own .uiux/ is opened as a root', async () => {
		const x = await legacyWorkspace()
		const journal = await pendingJournal(join(x, '.uiux', '.transactions'))
		const before = await tree(x)
		const metadataDir = new FileNativePersistence({ root: join(x, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect(metadataDir.layout).toBe(V5_LAYOUT)
		await expect(metadataDir.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		await expect(metadataDir.withLock(async () => undefined)).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(await exists(journal)).toBe(true)
		expect(await tree(x)).toEqual(before)
		expect(await exists(join(x, '.uiux', 'views'))).toBe(false)

		// The Workspace's own root recovers it: the journal was valid all along.
		const own = new FileNativePersistence({ root: x, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await own.views.read(VIEW_ID))?.resource).toMatchObject({ name: 'Before' })
		expect(await exists(journal)).toBe(false)
	})

	it('keeps a v5 journal when the parent of a relocated root is opened in the old layout', async () => {
		const { parent, root } = await relocatedWorkspace()
		const journal = await pendingJournal(join(root, '.transactions'), 'v5')
		const before = await tree(parent)
		const legacyParent = new FileNativePersistence({ root: parent, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect(legacyParent.layout).toBe(LEGACY_LAYOUT)
		await expect(legacyParent.inspectWorkspace()).rejects.toMatchObject({ code: 'persistence.recovery_failed' })
		expect(await exists(journal)).toBe(true)
		expect(await tree(parent)).toEqual(before)
		expect(await exists(join(parent, 'views'))).toBe(false)

		const own = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect((await own.views.read(VIEW_ID))?.resource).toMatchObject({ name: 'Before' })
		expect(await exists(journal)).toBe(false)
	})

	it('records the v5 layout in the journals it writes, and none in the old layout', async () => {
		for (const [layout, policy, expected] of [[V5_LAYOUT, V5_TEST_SCHEMA_POLICY, 'v5'], [LEGACY_LAYOUT, PRODUCT_WORKSPACE_SCHEMA_POLICY, undefined]] as const) {
			const root = await makeRoot()
			const seen: unknown[] = []
			const persistence = new FileNativePersistence({
				root,
				schemaPolicy: policy,
				layout,
				async fault(point) {
					if (point !== 'transaction.before_apply') return
					const directory = join(root, layout.transactionsDir)
					for (const id of await readdir(directory)) seen.push(JSON.parse(await readFile(join(directory, id, 'journal.json'), 'utf8')))
				},
			})
			await persistence.withLock(() => persistence.applyFileTransaction([{ path: viewRelativePath(VIEW_ID), bytes: canonicalJsonBytes(view('A')) }], 'asset'))
			expect(seen).toEqual([{ ...(expected ? { layout: expected } : {}), changes: [{ path: viewRelativePath(VIEW_ID), existed: false }] }])
		}
	})
})

describe('a schemaVersion 5 root without product-kit.json', () => {
	it('cannot be written', async () => {
		const { root } = await relocatedWorkspace()
		await rm(join(root, 'product-kit.json'))
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection).toMatchObject({ state: 'unsupported', version: 5 })
		const current = (await persistence.views.read(VIEW_ID))!
		await expect(persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: current.revision, resource: view('Changed') as never })).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
	})
})

describe('entry points refuse a mismatched selection with exit status 2 before touching anything', () => {
	async function mismatchedSelections(): Promise<readonly Readonly<{ name: string; selected: string; scope: string }>[]> {
		const x = await legacyWorkspace()
		const foreign = await makeRoot()
		await writeFile(join(foreign, 'workspace.json'), '{"version":2,"projects":{}}\n')
		const { parent } = await relocatedWorkspace()
		const { root: withoutKit } = await relocatedWorkspace()
		await rm(join(withoutKit, 'product-kit.json'))
		return [
			{ name: 'an old-layout .uiux/ directory', selected: join(x, '.uiux'), scope: x },
			{ name: 'a foreign workspace.json', selected: foreign, scope: foreign },
			{ name: 'the parent of a relocated root', selected: parent, scope: parent },
			{ name: 'a v5 root without product-kit.json', selected: withoutKit, scope: withoutKit },
		]
	}

	it('uiux migrate and uiux migrate --dry-run', async () => {
		for (const { name, selected, scope } of await mismatchedSelections()) {
			const before = await tree(scope)
			const home = join(await makeRoot('uiux-selection-home-'), 'home')
			for (const dryRun of [false, true]) {
				const errors: string[] = []
				expect(await runMigrateCommand({ workspaceRoot: selected, dryRun, home, schemaPolicy: V5_TEST_SCHEMA_POLICY, stdout: () => undefined, stderr: line => errors.push(line) }), name).toBe(2)
				expect(errors.join('\n'), name).toMatch(/^uiux: /)
			}
			expect(await tree(scope), name).toEqual(before)
			expect(await exists(home), name).toBe(false)
		}
	})

	it('uiux access, for the selected Workspace and for access copy --from', async () => {
		for (const { name, selected, scope } of await mismatchedSelections()) {
			const before = await tree(scope)
			const home = join(await makeRoot('uiux-selection-home-'), 'home')
			const errors: string[] = []
			const run = (argv: readonly string[]) => runAccessCommand({ argv, env: { UIUX_HOME: home }, stdout: () => undefined, stderr: line => errors.push(line) })
			expect(await run(['member', 'list', '--workspace', selected]), name).toBe(2)
			const target = await legacyWorkspace()
			expect(await run(['access', 'copy', '--from', selected, '--workspace', target]), name).toBe(2)
			expect(errors.join('\n'), name).not.toMatch(/at .*\(/)
			expect(await tree(scope), name).toEqual(before)
			expect(await exists(home), name).toBe(false)
		}
	})

	it('uiux dev', async () => {
		const { selected, scope } = (await mismatchedSelections())[0]!
		const before = await tree(scope)
		const home = join(await makeRoot('uiux-selection-home-'), 'home')
		const result = spawnSync(process.execPath, [CLI, 'dev', '--workspace', selected], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status, result.stderr).toBe(2)
		expect(result.stderr).toContain('select its parent')
		expect(await tree(scope)).toEqual(before)
		expect(await exists(home)).toBe(false)
	}, 60_000)

	it('the packaged server', async () => {
		const { selected, scope } = (await mismatchedSelections())[0]!
		const before = await tree(scope)
		const home = join(await makeRoot('uiux-selection-home-'), 'home')
		const server = spawn(process.execPath, [SERVER], {
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, HOST: '127.0.0.1', NITRO_HOST: '127.0.0.1', PORT: '0', NITRO_PORT: '0', UIUX_WORKSPACE_ROOT: selected, UIUX_PACKAGE_ROOT: process.cwd(), UIUX_HOME: home },
		})
		let output = ''
		server.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		server.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
		const code = await new Promise<number | null>(resolveExit => server.once('exit', resolveExit))
		expect(code, output).toBe(2)
		expect(output).toContain('select its parent')
		expect(await tree(scope)).toEqual(before)
		expect(await exists(home)).toBe(false)
	}, 60_000)
})

describe('history records check their layout before storing anything', () => {
	const clock = (): HistoryRecorderClock => ({ now: () => Date.parse('2026-10-11T00:00:00.000Z'), setTimeout: () => Symbol('timer'), clearTimeout: () => undefined })

	/** An old-layout Workspace whose persistence and history stores are open, and a way to make the manifest belong to the v5 layout. */
	async function fixture() {
		const root = await legacyWorkspace()
		const home = join(await makeRoot('uiux-selection-home-'), 'home')
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const host = (await HostHistoryStore.open({ paths: hostHistoryPaths(home, root), create: true }))!
		const checkpoints = new CheckpointStore(persistence)
		const relocatedManifest = canonicalJsonBytes(v5Manifest())
		return {
			root,
			persistence,
			host,
			checkpoints,
			relocatedManifest,
			// The manifest now says schemaVersion 5, as after a relocation this persistence did not follow.
			makeStale: () => writeManifest(root, relocatedManifest, LEGACY_LAYOUT),
		}
	}

	it('an external version', async () => {
		const ctx = await fixture()
		const logs: string[] = []
		const recorder = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: clock(), log: line => logs.push(line) })
		await recorder.start()
		await ctx.makeStale()
		await recorder.closeOpenAutosave('checkpoint').catch(() => undefined)
		await recorder.stop().catch(() => undefined)
		expect((await ctx.host.listVersions()).records.filter(record => record.type === 'external')).toEqual([])
		expect(await ctx.host.hasBlob(blobDigest(ctx.relocatedManifest))).toBe(false)
	})

	it('an autosave', async () => {
		const ctx = await fixture()
		const recorder = createHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: clock(), log: () => undefined })
		await recorder.start()
		const current = (await ctx.persistence.views.read(VIEW_ID))!
		await runWithDesignWriteContext({ actor: HUMAN, source: 'workbench', operation: 'updateViewSpec' }, () =>
			ctx.persistence.views.compareAndSwap({ key: VIEW_ID, expectedRevision: current.revision, resource: view('Edited') as never }))
		expect(recorder.openAutosaveId).toBeDefined()
		await ctx.makeStale()
		await recorder.stop().catch(() => undefined)
		expect((await ctx.host.listVersions()).records.filter(record => record.type === 'autosave')).toEqual([])
	})

	it('the migration system version', async () => {
		const ctx = await fixture()
		const history = createMigrationHistoryRecorder({ persistence: ctx.persistence, stores: async () => ({ host: ctx.host, checkpoints: ctx.checkpoints }), clock: clock(), log: () => undefined })
		await ctx.persistence.withLock(() => history.beforeMigrationUnlocked(5))
		await ctx.makeStale()
		await expect(ctx.persistence.withLock(() => history.afterMigrationUnlocked())).rejects.toMatchObject({ code: 'workspace.schema_unsupported' })
		expect((await ctx.host.listVersions()).records.filter(record => record.type === 'system')).toEqual([])
		expect(await ctx.host.hasBlob(blobDigest(ctx.relocatedManifest))).toBe(false)
	})
})
