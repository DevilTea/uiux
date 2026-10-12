import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

/** The repository's own Workspace locations: the dogfood in `design/` and, once relocated, `<repo>/.uiux/`. */
const REPOSITORY_ROOT = join(import.meta.dirname, '..', '..')
const GUARDED = [join(REPOSITORY_ROOT, '.uiux'), join(REPOSITORY_ROOT, 'design')]

/**
 * Every directory under `path`, and every file with its size and modification time, or `absent`
 * (directory times are left out: a read lock adds and removes a lock file). A test that
 * writes into the repository's Workspaces, such as a `uiux init` or `uiux dev` run without
 * `--workspace` from the repository, which discovery would point at `<repo>/.uiux/`, changes it.
 */
function fingerprint(path: string): string {
	if (!existsSync(path)) return 'absent'
	const lines: string[] = []
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const full = join(directory, entry.name)
			const stat = lstatSync(full)
			lines.push(entry.isDirectory() ? `${relative(path, full)}/` : `${relative(path, full)} ${stat.size} ${stat.mtimeMs}`)
			if (entry.isDirectory()) walk(full)
		}
	}
	walk(path)
	return lines.join('\n')
}

/**
 * Every test run gets a private `UIUX_HOME`, so no test (or server a test spawns, which inherits
 * `process.env`) can ever read or write the developer's real `~/.uiux` access rosters. The run also
 * fails when any test changed the repository's own Workspaces (AGENTS.md: tests use temporary
 * Workspaces and never write the dogfood).
 *
 * Vitest reports an error thrown from a global teardown but still exits 0, so the guard sets
 * `process.exitCode = 1` before throwing. Its limits: it compares one fingerprint before the run
 * with one after it, so a test that creates and then deletes a file (or restores the same size
 * and modification time) goes unnoticed; and it covers only `vitest` runs, not the smoke scripts
 * (`scripts/smoke-*.mjs`), which run outside it.
 */
export default function setup(): () => void {
	const home = mkdtempSync(join(tmpdir(), 'uiux-test-home-'))
	process.env.UIUX_HOME = home
	const before = GUARDED.map(fingerprint)
	return () => {
		rmSync(home, { recursive: true, force: true })
		const changed = GUARDED.filter((path, index) => fingerprint(path) !== before[index])
		if (changed.length > 0) {
			process.exitCode = 1
			throw new Error(`A test changed the repository's own Workspace in ${changed.map(path => relative(REPOSITORY_ROOT, path)).join(' and ')}; tests must use a temporary --workspace.`)
		}
	}
}
