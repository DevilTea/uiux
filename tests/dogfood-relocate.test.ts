import { execFileSync, spawnSync } from 'node:child_process'
import { cp, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

/**
 * The D1 relocation script (`scripts/dogfood-relocate.mjs`), which the owner ran on the owner's host
 * (owner ruling 4 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627)
 * to move the dogfood from `design/` (schemaVersion 4) to `<repo>/.uiux/` (schemaVersion 5). The
 * repository keeps it as the record of that run. Its rehearsals needed the schemaVersion 4 `design/`,
 * which the relocation removed, so what is left to check is that the script refuses on the relocated
 * layout and changes nothing. It runs on a temporary Git repository holding a copy of `.uiux/`
 * (its artifact store left out), never on the repository itself, with a temporary UIUX_HOME.
 */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'dogfood-relocate.mjs')
const DOGFOOD = join(REPOSITORY_ROOT, '.uiux')
const roots: string[] = []

afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tree(root: string): Promise<string[]> {
	return (await readdir(root, { recursive: true })).map(path => path.split(sep).join('/')).filter(path => path !== '.git' && !path.startsWith('.git/')).sort()
}

describe('scripts/dogfood-relocate.mjs after the relocation', () => {
	it('refuses, in --check and in a real run, when design/ is gone and the dogfood is in .uiux/, and changes nothing', async () => {
		const repo = await realpath(await mkdtemp(join(tmpdir(), 'uiux-dogfood-relocated-')))
		roots.push(repo)
		const artifacts = join(DOGFOOD, 'artifacts')
		await cp(DOGFOOD, join(repo, '.uiux'), { recursive: true, filter: source => source !== artifacts && !source.startsWith(`${artifacts}${sep}`) })
		execFileSync('git', ['init', '-q', repo])
		await writeFile(join(repo, '.gitignore'), 'home/\n')
		execFileSync('git', ['-C', repo, 'add', '--all'])
		execFileSync('git', ['-C', repo, '-c', 'user.name=test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'relocated'])
		const before = await tree(repo)

		for (const args of [['--check'], []]) {
			const result = spawnSync(process.execPath, [SCRIPT, ...args, '--repo', repo], { encoding: 'utf8', env: { ...process.env, UIUX_HOME: join(repo, 'home') } })
			expect(result.status, result.stdout).toBe(1)
			expect(result.stderr).toContain(`${join(repo, 'design', '.uiux', 'workspace.json')} does not exist; nothing to relocate (was it relocated already?)`)
			expect(result.stderr).toContain('nothing was changed')
		}
		expect(await tree(repo)).toEqual(before)
		expect(execFileSync('git', ['-C', repo, 'status', '--porcelain'], { encoding: 'utf8' })).toBe('')
	})
})
