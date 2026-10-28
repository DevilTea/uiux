#!/usr/bin/env node

/**
 * Dogfood CI guards (issue #381, Discussion #379 owner ruling 1:
 * https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19236211).
 *
 * The dogfood Workspace `.uiux/` is authored in a `git worktree` (docs/dogfood-worktree.md). A pull
 * request that changes it must carry only canonical resources and the Evidence blobs they reach:
 *
 * 1. History guard: the PR adds or changes no `.uiux/history/**` file (the worktree's Baseline
 *    Checkpoint and host history are local state; only the owner's host commits one).
 * 2. Blob guard: `uiux artifacts gc --dry-run`, run against an export of the PR head's committed
 *    `.uiux/` with an empty `UIUX_HOME`, lists none of the blobs the PR adds (an added blob that
 *    gc would collect is unreferenced, so nothing in the PR needs it).
 *
 * Usage: node scripts/dogfood-guard.mjs [--base <ref>] [--head <ref>] [--allow-history]
 * `--allow-history` skips the history guard only (the owner's host legitimately commits Baseline
 * Checkpoints and history; CI passes it for a PR labeled `dogfood-history`, which only the owner applies).
 * The blob guard has no escape hatch.
 * `--head` defaults to HEAD. `--base` defaults to `origin/$GITHUB_BASE_REF` in a CI pull request,
 * else `origin/main`, else `main`. The PR's changes are `merge-base(base, head)..head`. Both guards
 * read the committed state of the head, so commit before running them locally. Exit 0 when both
 * pass, 1 when one fails, 2 on a usage or environment error.
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

export const DOGFOOD_DIR = '.uiux'
export const HISTORY_DIR = `${DOGFOOD_DIR}/history`
export const BLOB_DIR = `${DOGFOOD_DIR}/artifacts/sha256`
const BLOB_PATH = /^\.uiux\/artifacts\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})$/
const BLOB_IDENTITY = /^sha256:([0-9a-f]{64})$/
const DEFAULT_UIUX_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'uiux.mjs')

/** An environment or usage problem (exit 2), as distinct from a guard violation (exit 1). */
export class GuardError extends Error {}

/** Runs git in `repo` and returns stdout. */
export function git(repo, args) {
	try {
		return execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
	}
	catch (error) {
		const detail = error.stderr ? String(error.stderr).trim() : error.message
		throw new GuardError(`git ${args.join(' ')} failed: ${detail}`)
	}
}

function revExists(repo, ref) {
	try {
		execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: repo, stdio: 'ignore' })
		return true
	}
	catch {
		return false
	}
}

/** The base ref: `--base`, else the CI pull request base, else `origin/main`, else `main`. */
/** @param {string} repo @param {{ base?: string, env?: Record<string, string | undefined> }} [options] */
export function resolveBase(repo, { base, env = process.env } = {}) {
	if (base) return base
	const candidates = [...(env.GITHUB_BASE_REF ? [`origin/${env.GITHUB_BASE_REF}`] : []), 'origin/main', 'main']
	const found = candidates.find(ref => revExists(repo, ref))
	if (!found) throw new GuardError(`No base ref found (tried ${candidates.join(', ')}); pass --base <ref>. A CI checkout needs fetch-depth: 0.`)
	return found
}

export function mergeBase(repo, base, head) {
	for (const ref of [base, head]) {
		if (!revExists(repo, ref)) throw new GuardError(`Unknown ref: ${ref}`)
	}
	return git(repo, ['merge-base', base, head]).trim()
}

/** Paths under `pathspec` that `from..to` changed with one of the diff `filter` letters (no rename detection: a rename is a delete plus an add). */
export function changedPaths(repo, from, to, filter, pathspec) {
	return git(repo, ['diff', '--no-renames', `--diff-filter=${filter}`, '--name-only', '-z', from, to, '--', pathspec]).split('\0').filter(Boolean)
}

/** Guard 1: the history paths the PR adds or changes (deleting one is not a violation). */
export function checkHistory(repo, { from, to }) {
	return changedPaths(repo, from, to, 'AMT', HISTORY_DIR)
}

/** The blobs the PR adds, as `{ hex, path }`. */
export function addedBlobs(repo, { from, to }) {
	return changedPaths(repo, from, to, 'A', BLOB_DIR).flatMap((path) => {
		const match = BLOB_PATH.exec(path)
		return match ? [{ hex: match[1], path }] : []
	})
}

/** The repository-relative path of a stored blob. */
export function blobPath(hex) {
	return `${BLOB_DIR}/${hex.slice(0, 2)}/${hex}`
}

/**
 * The blobs `uiux artifacts gc --dry-run` would delete from the Workspace at `workspaceRoot`
 * (a directory whose `.uiux/` holds one), with `home` as an empty `UIUX_HOME`. Returns a Set of
 * hex digests.
 */
export function listGarbageBlobs({ workspaceRoot, home, uiuxBin = DEFAULT_UIUX_BIN }) {
	const result = spawnSync(process.execPath, [uiuxBin, 'artifacts', 'gc', '--dry-run', '--workspace', workspaceRoot], {
		cwd: dirname(workspaceRoot),
		env: { ...process.env, UIUX_HOME: home },
		encoding: 'utf8',
		maxBuffer: 256 * 1024 * 1024,
	})
	if (result.error) throw new GuardError(`Could not run uiux artifacts gc: ${result.error.message}`)
	if (result.status !== 0) throw new GuardError(`uiux artifacts gc --dry-run exited ${result.status}:\n${result.stderr.trim()}`)
	const garbage = new Set()
	for (const line of result.stdout.split('\n')) {
		const match = BLOB_IDENTITY.exec(line.trim())
		if (match) garbage.add(match[1])
	}
	return garbage
}

/** A private temporary directory with `ws/` (the Workspace root to fill) and an empty `home/` for UIUX_HOME. */
export function makeScratch(prefix = 'uiux-dogfood-') {
	const base = mkdtempSync(join(tmpdir(), prefix))
	const workspaceRoot = join(base, 'ws')
	const home = join(base, 'home')
	mkdirSync(workspaceRoot, { mode: 0o755 })
	mkdirSync(home, { mode: 0o700 })
	return { base, workspaceRoot, home, remove: () => rmSync(base, { recursive: true, force: true }) }
}

/** Extracts `path` (all of `.uiux/` by default) as committed at `ref` into `destRoot`. */
export function exportCommitted(repo, ref, destRoot, path = DOGFOOD_DIR) {
	const scratch = mkdtempSync(join(tmpdir(), 'uiux-dogfood-tar-'))
	try {
		const archive = join(scratch, 'dogfood.tar')
		git(repo, ['archive', '--format=tar', `--output=${archive}`, ref, path])
		execFileSync('tar', ['-xf', archive, '-C', destRoot], { stdio: 'ignore' })
	}
	finally {
		rmSync(scratch, { recursive: true, force: true })
	}
}

/**
 * Guard 2: the blobs the PR adds that gc would collect. Skips the gc run when the PR adds no blob.
 * Returns `{ added, collectable }` (`collectable` is a list of repository-relative paths).
 */
/** @param {string} repo @param {{ from: string, to: string, head: string, uiuxBin?: string }} options */
export function checkBlobs(repo, { from, to, head, uiuxBin }) {
	const added = addedBlobs(repo, { from, to })
	if (added.length === 0) return { added: 0, collectable: [] }
	const scratch = makeScratch()
	try {
		exportCommitted(repo, head, scratch.workspaceRoot)
		const garbage = listGarbageBlobs({ workspaceRoot: scratch.workspaceRoot, home: scratch.home, ...(uiuxBin ? { uiuxBin } : {}) })
		return { added: added.length, collectable: added.filter(blob => garbage.has(blob.hex)).map(blob => blob.path) }
	}
	finally {
		scratch.remove()
	}
}

/** Runs both guards; returns `{ ok, lines }` for the caller to print. */
/** @param {string} repo @param {{ base?: string, head?: string, env?: Record<string, string | undefined>, uiuxBin?: string, allowHistory?: boolean }} [options] */
export function runGuard(repo, { base, head = 'HEAD', env, uiuxBin, allowHistory = false } = {}) {
	const baseRef = resolveBase(repo, { base, env })
	const from = mergeBase(repo, baseRef, head)
	const lines = [`dogfood guard: ${baseRef} (merge base ${from.slice(0, 9)}) .. ${head}`]
	let ok = true

	const history = checkHistory(repo, { from, to: head })
	if (allowHistory) {
		lines.push(`SKIP  history: skipped because --allow-history was given (CI: the PR carries the dogfood-history label, applied only by the owner); the PR adds or changes ${history.length} ${HISTORY_DIR}/ file(s). The blob guard still runs.`)
	}
	else if (history.length === 0) {
		lines.push(`ok    history: the PR adds or changes no ${HISTORY_DIR}/ file`)
	}
	else {
		ok = false
		lines.push(`FAIL  history: the PR adds or changes ${history.length} ${HISTORY_DIR}/ file(s); history and the worktree's Baseline Checkpoint are never committed:`)
		for (const path of history) lines.push(`        ${path}`)
		lines.push(`      Remove them from the PR, for example: git rm --cached -- <path> (an added file) or git checkout ${from.slice(0, 9)} -- <path> (a changed one).`)
	}

	const blobs = checkBlobs(repo, { from, to: head, head, uiuxBin })
	if (blobs.collectable.length === 0) {
		lines.push(`ok    blobs: gc --dry-run (empty UIUX_HOME) lists none of the ${blobs.added} blob(s) the PR adds`)
	}
	else {
		ok = false
		lines.push(`FAIL  blobs: gc --dry-run (empty UIUX_HOME) would delete ${blobs.collectable.length} of the ${blobs.added} blob(s) the PR adds; no committed resource reaches them:`)
		for (const path of blobs.collectable) lines.push(`        ${path}`)
		lines.push('      Remove them from the PR, for example: git rm --cached -- <path>.')
	}
	return { ok, lines }
}

async function main() {
	let values
	try {
		values = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, 'allow-history': { type: 'boolean' } }, allowPositionals: false, strict: true }).values
	}
	catch (error) {
		console.error(`dogfood guard: ${error.message}\nUsage: node scripts/dogfood-guard.mjs [--base <ref>] [--head <ref>] [--allow-history]`)
		return 2
	}
	try {
		const { ok, lines } = runGuard(git(resolve('.'), ['rev-parse', '--show-toplevel']).trim(), { ...(values.base ? { base: values.base } : {}), ...(values.head ? { head: values.head } : {}), ...(values['allow-history'] ? { allowHistory: true } : {}) })
		console.log(lines.join('\n'))
		return ok ? 0 : 1
	}
	catch (error) {
		if (!(error instanceof GuardError)) throw error
		console.error(`dogfood guard: ${error.message}`)
		return 2
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exitCode = await main()
