import { execFileSync } from 'node:child_process'
import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import type { GitWorkTreeCheck } from '../../src/persistence/git'

/** Git with an identity and no user or system configuration, so a test repository never depends on the host's. */
const GIT_ENV = {
	...process.env,
	GIT_AUTHOR_NAME: 'Test',
	GIT_AUTHOR_EMAIL: 'test@example.com',
	GIT_COMMITTER_NAME: 'Test',
	GIT_COMMITTER_EMAIL: 'test@example.com',
	GIT_CONFIG_GLOBAL: '/dev/null',
	GIT_CONFIG_SYSTEM: '/dev/null',
}

/** Runs `git <args>` in `cwd` and returns its output. */
export function git(cwd: string, ...args: string[]): string {
	return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** Makes `directory` a Git work tree on `branch` (no commit yet). */
export function initGit(directory: string, branch = 'main'): void {
	git(directory, 'init', '-q', '-b', branch)
}

/** Commits everything under `directory`. */
export function commitAll(directory: string, message: string): void {
	git(directory, 'add', '-A')
	git(directory, 'commit', '-q', '-m', message)
}

/** A stand-in for the Git work tree check, for the commands that take one as a seam. */
export function insideGitWorkTree(toplevel: string): (path: string) => GitWorkTreeCheck {
	return () => ({ ok: true, toplevel })
}

/** The directory above a path, for a test that places a Workspace one level into a repository. */
export const parentOf = (path: string): string => dirname(path)

/**
 * A new directory outside every Git work tree. The test run points `TMPDIR` at a work tree of its own
 * (`tests/support/global-setup.ts`), so the system temporary directory it started from is the one to use.
 */
export async function makeDirectoryOutsideGit(prefix: string): Promise<string> {
	return await realpath(await mkdtemp(join(process.env.UIUX_TEST_OUTSIDE_GIT_TMPDIR ?? tmpdir(), prefix)))
}
