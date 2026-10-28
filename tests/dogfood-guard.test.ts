import { randomUUID } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { createChecksRunEvidenceService } from '../src/application/services/checks-run-evidence'
import { FileNativePersistence } from '../src/persistence/file-native'
import { CheckpointStore } from '../src/persistence/history/checkpoint-store'
import type { CheckpointRecord } from '../src/domain/history/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'
import { createCurrentWorkspace } from './support/workspace-layout'
import { GuardError, addedBlobs, blobPath, checkBlobs, checkHistory, resolveBase, runGuard } from '../scripts/dogfood-guard.mjs'
import { dogfoodStatus, formatSelection, isLinkedWorktree, prepare, select } from '../scripts/dogfood-worktree.mjs'

/**
 * The dogfood CI guards and the worktree authoring helper (issue #381, Discussion #379 owner ruling 1:
 * https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19236211): scripts/dogfood-guard.mjs,
 * scripts/dogfood-worktree.mjs and the `.gitattributes` `-merge` of `.uiux/**\/*.json`. Every test works in
 * temporary git repositories and a temporary `UIUX_HOME` (the global setup), never the repository's `.uiux/`.
 */
const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..')
const GUARD_SCRIPT = join(REPOSITORY, 'scripts', 'dogfood-guard.mjs')
const WORKTREE_SCRIPT = join(REPOSITORY, 'scripts', 'dogfood-worktree.mjs')
const directories: string[] = []

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function scratch(): string {
	const directory = realpathSync(mkdtempSync(join(tmpdir(), 'uiux-dogfood-test-')))
	directories.push(directory)
	return directory
}

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }

function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function commitAll(cwd: string, message: string): void {
	git(cwd, 'add', '-A')
	git(cwd, 'commit', '-q', '-m', message)
}

const encoder = new TextEncoder()

function checkpoint(): CheckpointRecord {
	return {
		historySchemaVersion: 1,
		id: randomUUID(),
		type: 'checkpoint',
		actor: { type: 'human', id: 'member:owner', displayName: 'Owner' },
		at: '2026-10-18T12:00:00Z',
		workspaceSchemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION,
		resources: [],
		name: 'Owner baseline',
		source: 'workbench',
	}
}

/** A repository on `main` whose `.uiux/` is a current Workspace, plus the persistence over it. */
async function makeRepository(): Promise<{ repo: string; persistence: FileNativePersistence }> {
	const repo = scratch()
	git(repo, 'init', '-q', '-b', 'main')
	const persistence = new FileNativePersistence({ root: join(repo, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	await createCurrentWorkspace(persistence)
	copyFileSync(join(REPOSITORY, '.uiux', '.gitignore'), join(repo, '.uiux', '.gitignore'))
	copyFileSync(join(REPOSITORY, '.gitattributes'), join(repo, '.gitattributes'))
	return { repo, persistence }
}

/** A canonical resource change: one more theme in the Workspace settings. */
function addTheme(manifestPath: string): void {
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { themes: Record<string, unknown> }
	manifest.themes.light = { label: 'Light' }
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, '\t')}\n`)
}

/** A blob no root reaches: `gc --dry-run` lists it. */
async function garbageBlob(persistence: FileNativePersistence, text: string): Promise<string> {
	return hexOf((await persistence.artifacts.put(encoder.encode(text))).identity)
}

/** A `checks_run` Evidence record, one of the newest that gc keeps as a root: `gc --dry-run` leaves it. */
async function keptBlob(persistence: FileNativePersistence, minute = 0): Promise<string> {
	const sources = ['validation', 'translation', 'catalog', 'product-kit'].map(source => ({ source, state: 'completed' }))
	const result = await createChecksRunEvidenceService(persistence).record({ ranAt: `2026-10-20T10:${String(minute).padStart(2, '0')}:00Z`, sources, findings: [] })
	if (result.status !== 'recorded') throw new Error(JSON.stringify(result))
	return hexOf(result.evidenceDigest)
}

const hexOf = (identity: string): string => identity.replace('sha256:', '')

/** Commits the main state, then branches `pr`. */
async function repositoryWithBase(prepareBase?: (context: { repo: string; persistence: FileNativePersistence }) => Promise<void>) {
	const context = await makeRepository()
	await prepareBase?.(context)
	commitAll(context.repo, 'base')
	git(context.repo, 'switch', '-q', '-c', 'pr')
	return context
}

function guardCli(repo: string, ...args: string[]) {
	const result = spawnSync(process.execPath, [GUARD_SCRIPT, ...args], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
	return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

describe('dogfood guard: history', () => {
	it('fails a PR that adds a history file, and says which', async () => {
		const { repo } = await repositoryWithBase()
		mkdirSync(join(repo, '.uiux', 'history', 'checkpoints'), { recursive: true })
		writeFileSync(join(repo, '.uiux', 'history', 'checkpoints', 'baseline.json'), '{}\n')
		commitAll(repo, 'adds history')
		expect(checkHistory(repo, { from: 'main', to: 'HEAD' })).toEqual(['.uiux/history/checkpoints/baseline.json'])
		const run = runGuard(repo, { base: 'main' })
		expect(run.ok).toBe(false)
		expect(run.lines.join('\n')).toContain('FAIL  history')
		expect(run.lines.join('\n')).toContain('.uiux/history/checkpoints/baseline.json')
	})

	it('fails a PR that changes a history file the base already has', async () => {
		const { repo } = await repositoryWithBase(async ({ repo: root }) => {
			mkdirSync(join(root, '.uiux', 'history', 'checkpoints'), { recursive: true })
			writeFileSync(join(root, '.uiux', 'history', 'checkpoints', 'owner.json'), '{"a":1}\n')
		})
		writeFileSync(join(repo, '.uiux', 'history', 'checkpoints', 'owner.json'), '{"a":2}\n')
		commitAll(repo, 'edits history')
		expect(checkHistory(repo, { from: 'main', to: 'HEAD' })).toEqual(['.uiux/history/checkpoints/owner.json'])
	})

	it('skips only the history guard with allowHistory / --allow-history, and says so; the blob guard still fails', async () => {
		const { repo, persistence } = await repositoryWithBase()
		await new CheckpointStore(persistence).create(checkpoint(), new Map())
		commitAll(repo, 'owner commits history')
		const skipped = runGuard(repo, { base: 'main', allowHistory: true })
		expect(skipped.ok).toBe(true)
		expect(skipped.lines.join('\n')).toContain('SKIP  history: skipped because --allow-history was given')
		expect(skipped.lines.join('\n')).toContain('1 .uiux/history/ file(s)')
		const cli = guardCli(repo, '--base', 'main', '--allow-history')
		expect(cli.status, cli.stdout + cli.stderr).toBe(0)
		expect(cli.stdout).toContain('SKIP  history')
		expect(guardCli(repo, '--base', 'main').status).toBe(1)
		// No escape hatch for the blob guard: a collectable blob still fails with the flag.
		await garbageBlob(persistence, 'unreferenced with history allowed')
		commitAll(repo, 'adds garbage')
		const run = runGuard(repo, { base: 'main', allowHistory: true })
		expect(run.ok).toBe(false)
		expect(run.lines.join('\n')).toContain('SKIP  history')
		expect(run.lines.join('\n')).toContain('FAIL  blobs')
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('passes a PR that changes only canonical resources, and one that deletes history', async () => {
		const { repo } = await repositoryWithBase(async ({ repo: root }) => {
			mkdirSync(join(root, '.uiux', 'history', 'checkpoints'), { recursive: true })
			writeFileSync(join(root, '.uiux', 'history', 'checkpoints', 'owner.json'), '{"a":1}\n')
		})
		const manifest = join(repo, '.uiux', 'workspace.json')
		addTheme(manifest)
		git(repo, 'rm', '-q', '.uiux/history/checkpoints/owner.json')
		commitAll(repo, 'resource change')
		expect(checkHistory(repo, { from: 'main', to: 'HEAD' })).toEqual([])
		expect(runGuard(repo, { base: 'main' }).ok).toBe(true)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)
})

describe('dogfood guard: blobs', () => {
	it('fails a PR that adds a blob gc would collect, and lists only that blob', async () => {
		const { repo, persistence } = await repositoryWithBase()
		const garbage = await garbageBlob(persistence, 'unreferenced screenshot')
		const kept = await keptBlob(persistence)
		commitAll(repo, 'adds blobs')
		expect(addedBlobs(repo, { from: 'main', to: 'HEAD' }).map(blob => blob.hex).sort()).toEqual([garbage, kept].sort())
		const result = checkBlobs(repo, { from: 'main', to: 'HEAD', head: 'HEAD' })
		expect(result).toEqual({ added: 2, collectable: [blobPath(garbage)] })
		const cli = guardCli(repo, '--base', 'main')
		expect(cli.status, cli.stdout + cli.stderr).toBe(1)
		expect(cli.stdout).toContain('FAIL  blobs')
		expect(cli.stdout).toContain(blobPath(garbage))
		expect(cli.stdout).not.toContain(blobPath(kept))
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('passes a PR whose added blobs a committed resource reaches (exit 0)', async () => {
		const { repo, persistence } = await repositoryWithBase()
		const kept = await keptBlob(persistence)
		commitAll(repo, 'adds a reached blob')
		expect(checkBlobs(repo, { from: 'main', to: 'HEAD', head: 'HEAD' })).toEqual({ added: 1, collectable: [] })
		const cli = guardCli(repo, '--base', 'main')
		expect(cli.status, cli.stdout + cli.stderr).toBe(0)
		expect(cli.stdout).toContain('ok    blobs')
		expect(existsSync(join(repo, blobPath(kept)))).toBe(true)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('does not blame a PR for a collectable blob the base already holds, and skips gc when no blob is added', async () => {
		const { repo } = await repositoryWithBase(async ({ persistence }) => {
			await garbageBlob(persistence, 'already on main')
		})
		writeFileSync(join(repo, 'README.md'), 'a PR without blobs\n')
		commitAll(repo, 'no blobs')
		// A uiux binary that fails proves gc is not run when the PR adds no blob.
		expect(checkBlobs(repo, { from: 'main', to: 'HEAD', head: 'HEAD', uiuxBin: join(repo, 'does-not-exist.mjs') })).toEqual({ added: 0, collectable: [] })
	})

	it('reports an environment problem (exit 2), not a violation, when there is no base ref', async () => {
		const repo = scratch()
		git(repo, 'init', '-q', '-b', 'trunk')
		writeFileSync(join(repo, 'a'), 'a')
		commitAll(repo, 'first')
		const cli = guardCli(repo)
		expect(cli.status).toBe(2)
		expect(cli.stderr).toContain('No base ref found')
		expect(() => resolveBase(repo, { env: {} })).toThrow(GuardError)
	})
})

describe('dogfood guard: base resolution', () => {
	it('prefers the CI base ref, then origin/main, then main', async () => {
		const { repo } = await repositoryWithBase()
		expect(resolveBase(repo, { env: {} })).toBe('main')
		expect(resolveBase(repo, { env: { GITHUB_BASE_REF: 'release' } })).toBe('main')
		expect(resolveBase(repo, { base: 'x', env: {} })).toBe('x')
		git(repo, 'update-ref', 'refs/remotes/origin/release', 'main')
		expect(resolveBase(repo, { env: { GITHUB_BASE_REF: 'release' } })).toBe('origin/release')
	})
})

describe('dogfood worktree', () => {
	async function worktreeRepository() {
		let ownerCheckpoint = ''
		let trackedBlob = ''
		const context = await repositoryWithBase(async ({ persistence }) => {
			// The owner's committed Checkpoint: a valid record, which gc reads.
			const record = checkpoint()
			await new CheckpointStore(persistence).create(record, new Map())
			ownerCheckpoint = `.uiux/history/checkpoints/${record.id}.json`
			trackedBlob = blobPath(await keptBlob(persistence, 1))
		})
		git(context.repo, 'switch', '-q', 'main')
		const worktree = join(scratch(), 'author')
		git(context.repo, 'worktree', 'add', '-q', '-b', 'author', worktree, 'main')
		const persistence = new FileNativePersistence({ root: join(worktree, '.uiux'), schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		return { ...context, worktree, persistence, ownerCheckpoint, trackedBlob }
	}

	it('refuses the primary checkout and accepts a linked worktree', async () => {
		const { repo, worktree } = await worktreeRepository()
		expect(isLinkedWorktree(repo)).toBe(false)
		expect(isLinkedWorktree(worktree)).toBe(true)
		expect(() => prepare(repo, { build: false })).toThrow(/primary checkout/)
		const cli = spawnSync(process.execPath, [WORKTREE_SCRIPT, 'select'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
		expect(cli.status).toBe(2)
		expect(cli.stderr).toContain('primary checkout')
	})

	it('prepares a worktree: a temporary UIUX_HOME with an Agent member and a Token', async () => {
		const { worktree } = await worktreeRepository()
		expect(() => prepare(worktree, { build: false })).toThrow(/not built/)
		mkdirSync(join(worktree, '.output', 'server'), { recursive: true })
		writeFileSync(join(worktree, '.output', 'server', 'index.mjs'), '')
		const home = join(scratch(), 'home')
		const lines = prepare(worktree, { home, build: false })
		const text = lines.join('\n')
		expect(text).toContain(`Temporary UIUX_HOME: ${home}`)
		expect(text).toMatch(/export UIUX_MCP_TOKEN=\S{20,}/)
		expect(text).toContain(`UIUX_HOME=${home} node bin/uiux.mjs dev --workspace ${join(worktree, '.uiux')}`)
		expect(existsSync(home)).toBe(true)
		expect(() => prepare(worktree, { home: join(worktree, 'inside'), build: false })).toThrow(/outside the worktree/)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('selects the resources and the reached blobs, and never history or unreferenced blobs', async () => {
		const { worktree, persistence, ownerCheckpoint } = await worktreeRepository()
		const manifest = join(worktree, '.uiux', 'workspace.json')
		addTheme(manifest)
		mkdirSync(join(worktree, '.uiux', 'flows'), { recursive: true })
		const kept = await keptBlob(persistence)
		const garbage = await garbageBlob(persistence, 'unreferenced in the worktree')
		// The worktree's Baseline Checkpoint and host history: untracked, and a tracked one changed.
		writeFileSync(join(worktree, '.uiux', 'history', 'checkpoints', 'baseline.json'), '{}\n')
		writeFileSync(join(worktree, ownerCheckpoint), `${readFileSync(join(worktree, ownerCheckpoint), 'utf8')}\n`)

		const result = select(worktree)
		expect(result.add).toEqual(['.uiux/workspace.json', blobPath(kept)].sort())
		expect(result.collectable).toEqual([blobPath(garbage)])
		expect(result.history.sort()).toEqual(['.uiux/history/checkpoints/baseline.json', ownerCheckpoint].sort())
		expect(result.damaged).toEqual([])
		const text = formatSelection(result).join('\n')
		expect(text).toContain('git add -- \\')
		expect(text).toContain(`'${blobPath(kept)}'`)
		expect(text).not.toContain(garbage)
		expect(text).not.toContain('history/checkpoints/baseline.json\'')
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('stages exactly the selected paths with --stage, and flags a tracked blob that changed', async () => {
		const { worktree, persistence, trackedBlob } = await worktreeRepository()
		const kept = await keptBlob(persistence, 2)
		await garbageBlob(persistence, 'left over')
		writeFileSync(join(worktree, trackedBlob), 'tampered')
		const cli = spawnSync(process.execPath, [WORKTREE_SCRIPT, 'select', '--stage'], { cwd: worktree, env: GIT_ENV, encoding: 'utf8' })
		expect(cli.status, cli.stderr).toBe(0)
		expect(cli.stdout).toContain('WARNING: 1 tracked blob(s) changed')
		expect(cli.stdout).toContain(`git restore -- '${trackedBlob}'`)
		expect(git(worktree, 'diff', '--cached', '--name-only').trim().split('\n')).toEqual([blobPath(kept)])
		expect(dogfoodStatus(worktree).filter(entry => entry.status === '??').length).toBe(1)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)
})

describe('.gitattributes -merge of .uiux/**/*.json', () => {
	const lines = (prefix: string, changed?: Record<number, string>) => `${Array.from({ length: 12 }, (_, index) => changed?.[index] ?? `${prefix}${index}`).join('\n')}\n`

	function mergeExperiment(attributes: string | undefined, file: string): { status: number | null; unmerged: string; content: string } {
		const repo = scratch()
		git(repo, 'init', '-q', '-b', 'main')
		if (attributes !== undefined) writeFileSync(join(repo, '.gitattributes'), attributes)
		mkdirSync(dirname(join(repo, file)), { recursive: true })
		writeFileSync(join(repo, file), lines('line'))
		commitAll(repo, 'base')
		git(repo, 'switch', '-q', '-c', 'one')
		writeFileSync(join(repo, file), lines('line', { 1: 'edited by one' }))
		commitAll(repo, 'one')
		git(repo, 'switch', '-q', 'main')
		git(repo, 'switch', '-q', '-c', 'two')
		writeFileSync(join(repo, file), lines('line', { 10: 'edited by two' }))
		commitAll(repo, 'two')
		const merge = spawnSync('git', ['merge', '--no-edit', 'one'], { cwd: repo, env: GIT_ENV, encoding: 'utf8' })
		return { status: merge.status, unmerged: git(repo, 'diff', '--name-only', '--diff-filter=U'), content: readFileSync(join(repo, file), 'utf8') }
	}

	const attributes = readFileSync(join(REPOSITORY, '.gitattributes'), 'utf8')

	it('conflicts at file level when two branches edit different lines of one .uiux JSON file', () => {
		for (const file of ['.uiux/workspace.json', '.uiux/views/0b0f0000-0000-4000-8000-000000000000.json', '.uiux/reviews/deep/a.json']) {
			const merge = mergeExperiment(attributes, file)
			expect(merge.status, file).toBe(1)
			expect(merge.unmerged.trim(), file).toBe(file)
			// `-merge` keeps the current branch's version as the tentative result: no merged-in text, no markers.
			expect(merge.content, file).toContain('edited by two')
			expect(merge.content, file).not.toContain('edited by one')
		}
	})

	it('control: without the attribute the same edits merge cleanly, and a non-.uiux JSON file still merges', () => {
		const merge = mergeExperiment(undefined, '.uiux/workspace.json')
		expect(merge.status).toBe(0)
		expect(merge.content).toContain('edited by one')
		expect(merge.content).toContain('edited by two')
		expect(mergeExperiment(attributes, 'package.json').status).toBe(0)
	})
})
