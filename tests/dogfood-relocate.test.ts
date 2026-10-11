import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdtemp, readdir, readFile, realpath, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { runAccessCommand } from '../src/cli/access'
import { runMigrateCommand } from '../src/cli/migrate'
import { FileNativePersistence } from '../src/persistence/file-native'
import { HostHistoryStore } from '../src/persistence/history/host-store'
import { LEGACY_LAYOUT, V5_LAYOUT } from '../src/persistence/paths'
import { checkWorkspaceSelection } from '../src/persistence/workspace-selection'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { AccessStore, hostHistoryPaths } from '../src/server/access/store'
import { resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { HEAVY_SERVER_SUITE_TIMEOUT_MS } from './support/timeouts'

/**
 * The D1 relocation script (`scripts/dogfood-relocate.mjs`), which the owner runs on the dogfood
 * (owner ruling 4 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627),
 * rehearsed on a private copy of `design/` in a temporary repository: never on `design/` itself.
 * While the dogfood is still the schemaVersion 4 Workspace in `design/`, the copy goes through the
 * Adapter preparation, `uiux migrate`, the move to `<repo>/.uiux/` and `uiux access copy`.
 */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'dogfood-relocate.mjs')
const DOGFOOD = join(REPOSITORY_ROOT, 'design')
const DOGFOOD_MANIFEST = join(DOGFOOD, ...LEGACY_LAYOUT.manifestPath.split('/'))
const OLD_DOGFOOD = existsSync(DOGFOOD_MANIFEST) && (JSON.parse(readFileSync(DOGFOOD_MANIFEST, 'utf8')) as { schemaVersion?: unknown }).schemaVersion === 4
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A temporary repository holding a copy of design/ (one artifact file kept, as the migration tests do) and the repository's node_modules. */
async function rehearsalRepository(): Promise<Readonly<{ repo: string; home: string }>> {
	const repo = await realpath(await mkdtemp(join(tmpdir(), 'uiux-dogfood-relocate-')))
	roots.push(repo)
	const shards = join(DOGFOOD, LEGACY_LAYOUT.artifactsDir, 'sha256')
	const [witnessShard] = (await readdir(shards)).sort()
	const [witnessFile] = (await readdir(join(shards, witnessShard!))).sort()
	const keep = new Set([join(shards, witnessShard!), join(shards, witnessShard!, witnessFile!)])
	await cp(DOGFOOD, join(repo, 'design'), { recursive: true, filter: source => !source.startsWith(`${shards}${sep}`) || keep.has(source) })
	await symlink(join(REPOSITORY_ROOT, 'node_modules'), join(repo, 'node_modules'))
	return { repo, home: join(repo, 'home') }
}

async function tree(root: string): Promise<string[]> {
	return (await readdir(root, { recursive: true })).map(path => path.split(sep).join('/')).sort()
}

describe.skipIf(!OLD_DOGFOOD)('scripts/dogfood-relocate.mjs on a copy of the schemaVersion 4 dogfood', () => {
	it('--check changes nothing', async () => {
		const { repo, home } = await rehearsalRepository()
		const before = await tree(repo)
		const result = spawnSync(process.execPath, [SCRIPT, '--check', '--repo', repo], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status, result.stderr).toBe(0)
		expect(result.stdout).toContain('Nothing was changed.')
		expect(await tree(repo)).toEqual(before)
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS)

	it('relocates the Workspace to <repo>/.uiux/ at schemaVersion 5, keeps its roster and history, and leaves a Workspace whose Adapter resolves from kit/', async () => {
		const { repo, home } = await rehearsalRepository()
		const design = join(repo, 'design')
		const added = await runAccessCommand({ argv: ['member', 'add', 'owner', '--preset', 'Owner', '--workspace', design], env: { UIUX_HOME: home }, stdout: () => undefined, stderr: () => undefined })
		expect(added).toBe(0)

		const result = spawnSync(process.execPath, [SCRIPT, '--repo', repo], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: home } })
		expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
		expect(result.stdout).toContain('steps: uiux.v4-to-v5')
		expect(result.stdout).toContain('git add --all -- design .uiux')

		const root = join(repo, '.uiux')
		expect(existsSync(design)).toBe(false)
		expect(checkWorkspaceSelection(root, PRODUCT_WORKSPACE_SCHEMA_POLICY)).toEqual({ ok: true, layout: V5_LAYOUT })
		const manifest = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf8')) as Record<string, unknown>
		expect(manifest).toMatchObject({ schemaVersion: 5 })
		expect(manifest).not.toHaveProperty('adapters')
		expect(JSON.parse(await readFile(join(root, 'product-kit.json'), 'utf8'))).toMatchObject({ adapters: [{ moduleSpecifier: './adapters/reference.ts' }] })
		const adapter = await readFile(join(root, 'kit', 'adapters', 'reference.ts'), 'utf8')
		expect(adapter).toContain('from \'../../../src/domain/adapters/schema\'')
		expect(await tree(root)).toEqual(expect.arrayContaining(['views', 'flows', 'reviews', 'i18n', 'assets', 'history/checkpoints']))

		// The Workspace is current, every Review reads, and the Adapter resolves from kit/.
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		expect((await persistence.inspectWorkspace()).inspection.state).toBe('current')
		for (const key of await persistence.reviews.discoverKeys())
			expect((await persistence.reviews.readInspected(key))?.diagnostics, key).toEqual([])
		expect(await resolveSelectedWorkspaceAdapters(root)).toMatchObject({ state: 'valid' })
		const lines: string[] = []
		expect(await runMigrateCommand({ workspaceRoot: root, dryRun: false, home, stdout: line => lines.push(line), stderr: line => lines.push(line) })).toBe(0)
		expect(lines.join('\n')).toContain('already at schemaVersion 5; nothing to migrate.')

		// The roster and the host history, with the migration's system version, came over to the new root.
		const roster = await AccessStore.readRoster(home, root)
		expect(roster?.members.map(member => member.nickname)).toEqual(['owner'])
		const host = await HostHistoryStore.open({ paths: hostHistoryPaths(home, root) })
		expect((await host!.listVersions()).records.map(record => [record.type, record.actor])).toContainEqual(['system', { type: 'system', id: 'system:migrate' }])
	}, HEAVY_SERVER_SUITE_TIMEOUT_MS * 2)
})
