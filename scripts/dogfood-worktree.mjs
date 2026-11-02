#!/usr/bin/env node

/**
 * Worktree authoring helper for the dogfood Workspace `.uiux/` (issue #381; procedure in
 * docs/dogfood-worktree.md). Never run it, or `uiux dev`, in the owner's checkout.
 *
 *   node scripts/dogfood-worktree.mjs prepare [--home <dir>] [--no-build]
 *   node scripts/dogfood-worktree.mjs select [--stage]
 *
 * `prepare` (run in a linked `git worktree`) makes the worktree's `.uiux/` ready for `uiux dev`: a
 * temporary `UIUX_HOME`, the packaged server build when missing, and an Agent member with a Token in
 * that home. It prints the environment and the commands to start the server and to clean up.
 *
 * `select` (run after authoring, with the server stopped) lists what to commit: every changed
 * canonical resource under `.uiux/`, and only the Evidence blobs that survive `uiux artifacts gc
 * --dry-run` with an empty `UIUX_HOME` against the worktree's `.uiux/` as it would be committed (its
 * `history/` replaced by the one in HEAD). It never selects `.uiux/history/**` (the worktree's
 * Baseline Checkpoint and host history), an unreferenced blob or `.uiux/kit/node_modules` (a symlink
 * to the repository's, which the `kit/node_modules/` ignore rule does not match), prints the exact `git add` list
 * (and runs it with `--stage`), and changes nothing else.
 *
 * After a recapture it also lists the deletions of tracked blobs that the same gc dry-run would
 * collect (the Evidence the recapture superseded) as `git rm` lines; `--stage` runs them too.
 *
 * gc keeps every capture of a View's current revision, so a Kit, Adapter, Locale or Workspace
 * recapture leaves the old generation reachable. `select` therefore also lists, in a separate
 * "superseded by a fresh capture" section, the tracked formal captures that the Workbench's own
 * freshness judgement (`dogfood:check`'s, which needs the packaged server built) calls stale while a
 * fresh capture of the same render context stays, and the blobs that become unreferenced with them
 * (scripts/dogfood-superseded.mjs). `--no-superseded` skips that part (no server is started).
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

import { BLOB_DIR, DOGFOOD_DIR, GuardError, HISTORY_DIR, KIT_NODE_MODULES, blobPath, exportCommitted, git, isKitNodeModules, listGarbageBlobs, makeScratch } from './dogfood-guard.mjs'
import { planSupersededCaptures } from './dogfood-superseded.mjs'

const BLOB_PATH = /^\.uiux\/artifacts\/sha256\/[0-9a-f]{2}\/([0-9a-f]{64})$/
// The CLI that runs this script: in a worktree, the worktree's own bin/uiux.mjs.
const UIUX_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'uiux.mjs')
const AGENT_NICKNAME = 'dogfood-agent'
const STAGE_CHUNK = 200

function toplevel(cwd) {
	return git(cwd, ['rev-parse', '--show-toplevel']).trim()
}

/** True when `repo` is a linked worktree: its git dir differs from the repository's common git dir. */
export function isLinkedWorktree(repo) {
	const [gitDir, common] = git(repo, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n')
	return realpathSync(gitDir) !== realpathSync(common)
}

function runUiux(repo, home, args) {
	const result = spawnSync(process.execPath, [UIUX_BIN, ...args, '--workspace', join(repo, DOGFOOD_DIR)], {
		cwd: repo,
		env: { ...process.env, UIUX_HOME: home },
		encoding: 'utf8',
	})
	if (result.error || result.status !== 0) throw new GuardError(`uiux ${args.join(' ')} failed (${result.status}): ${(result.stderr || result.error?.message || '').trim()}`)
	return result.stdout
}

/** Prepares the worktree at `repo`; returns the lines to print. */
/** @param {string} repo @param {{ home?: string, build?: boolean }} [options] */
export function prepare(repo, { home, build = true } = {}) {
	if (!isLinkedWorktree(repo))
		throw new GuardError(`${repo} is the primary checkout. Author the dogfood in a linked worktree: git worktree add <dir> -b <branch> origin/main (see docs/dogfood-worktree.md).`)
	if (!existsSync(join(repo, DOGFOOD_DIR, 'workspace.json'))) throw new GuardError(`${join(repo, DOGFOOD_DIR)} holds no Workspace (no workspace.json).`)

	const directory = home ? resolve(home) : mkdtempSync(join(tmpdir(), 'uiux-dogfood-home-'))
	if (directory === join(realpathSync(homedir()), '.uiux') || directory === join(homedir(), '.uiux'))
		throw new GuardError('Refusing ~/.uiux: use a temporary UIUX_HOME.')
	if (!relative(repo, directory).startsWith('..')) throw new GuardError(`UIUX_HOME ${directory} must be outside the worktree.`)
	mkdirSync(directory, { recursive: true, mode: 0o700 })

	if (!existsSync(join(repo, '.output', 'server', 'index.mjs'))) {
		if (!build) throw new GuardError('The packaged server is not built (.output/server/index.mjs): run pnpm build in the worktree.')
		execFileSync('pnpm', ['build'], { cwd: repo, stdio: 'inherit' })
	}

	runUiux(repo, directory, ['member', 'add', AGENT_NICKNAME, '--preset', 'editor', '--kind', 'agent'])
	const created = runUiux(repo, directory, ['token', 'create', '--member', AGENT_NICKNAME, '--label', 'dogfood worktree', '--expires', '1']).split('\n')
	const credential = created[created.findIndex(line => line.startsWith('Created token')) + 1]?.trim()
	if (!credential) throw new GuardError('Could not read the Token from uiux token create.')

	const lines = [
		`Worktree ${repo} is ready. Temporary UIUX_HOME: ${directory}`,
		`Agent member ${AGENT_NICKNAME} (Editor preset) has a Token (1 day, shown once):`,
		`  export UIUX_MCP_TOKEN=${credential}`,
		'',
		'1. Start the server in a second terminal (loopback only; PORT=<n> picks the port):',
		`   UIUX_HOME=${directory} node bin/uiux.mjs dev --workspace ${join(repo, DOGFOOD_DIR)}`,
		'2. Author through MCP at http://127.0.0.1:<port>/mcp with Authorization: Bearer $UIUX_MCP_TOKEN.',
		'3. Stop the server, then: node scripts/dogfood-worktree.mjs select [--stage]',
		`4. Clean up when done: rm -rf ${directory}; git worktree remove <this worktree>`,
	]
	// The kit build resolves esbuild and vue by walking up from .uiux/kit/ to the worktree's own node_modules, so no
	// .uiux/kit/node_modules link is needed (dogfood:check links one only because its copy lives outside the repository).
	if (existsSync(join(repo, DOGFOOD_DIR, 'kit', 'package.json')) && !existsSync(join(repo, 'node_modules')))
		lines.push('', `Note: ${DOGFOOD_DIR}/kit/package.json declares a kit project but the worktree has no node_modules; run pnpm install --frozen-lockfile in it before uiux dev runs the declared build (the build finds esbuild and vue there). Do not link ${KIT_NODE_MODULES}: select skips it and dogfood:guard refuses it.`)
	return lines
}

/** `git status` entries under `.uiux/`: `{ status, path }` with no rename detection. */
export function dogfoodStatus(repo) {
	const entries = git(repo, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all', '--', DOGFOOD_DIR]).split('\0').filter(Boolean)
	return entries.map(entry => ({ status: entry.slice(0, 2), path: entry.slice(3) }))
}

/**
 * Builds in `destRoot` the `.uiux/` the worktree would commit: HEAD's, then the working-tree changes
 * in `entries` that would be staged (an added or changed file is copied, a deletion is removed).
 * History and a changed or deleted tracked blob keep HEAD's version.
 */
function buildCommittable(repo, destRoot, entries) {
	if (git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', DOGFOOD_DIR]).trim() !== '') exportCommitted(repo, 'HEAD', destRoot)
	for (const { status, path } of entries) {
		const isBlob = BLOB_PATH.test(path)
		if (path.startsWith(`${HISTORY_DIR}/`) || (isBlob && status !== '??' && status !== 'A ')) continue
		const source = join(repo, path)
		const target = join(destRoot, path)
		if (!existsSync(source)) {
			rmSync(target, { force: true })
		}
		else if (lstatSync(source).isFile()) {
			mkdirSync(dirname(target), { recursive: true })
			copyFileSync(source, target)
		}
	}
}

/**
 * Classifies the changes under `.uiux/` for committing. Returns `{ add, history, kitNodeModules, collectable, damaged }`:
 * `add` the paths to stage (deletions included), `history` the skipped history paths, `kitNodeModules`
 * the skipped `.uiux/kit/node_modules` paths, `collectable`
 * the skipped unreferenced new blobs, `damaged` the tracked blobs that were modified or deleted, and
 * `remove` the tracked blobs gc would collect from the as-committed tree (deletions to stage; a blob
 * whose deletion is already staged is left out, and a working-tree deletion of one is not damage), and
 * `superseded` the tracked captures a fresh capture of the same render context supersedes plus the blobs
 * that become unreferenced with them (`{ records, dependents, bytes }`, same deletion rules as `remove`).
 */
/** @param {string} repo @param {{ uiuxBin?: string, readFreshness?: (root: string) => Promise<readonly { digest: string, contextKey: string, state: string }[]>, superseded?: boolean }} [options] */
export async function select(repo, { uiuxBin, readFreshness = defaultReadFreshness, superseded: findSuperseded = true } = {}) {
	const status = dogfoodStatus(repo)
	// `.uiux/kit/node_modules` (a directory, a symlink or a file) is never selected, and never reaches gc's scratch tree.
	const kitNodeModules = status.filter(({ path }) => isKitNodeModules(path)).map(({ path }) => path)
	const entries = status.filter(({ path }) => !isKitNodeModules(path))
	const add = []
	const history = []
	const damaged = []
	const newBlobs = []
	const trackedBlobs = new Set(git(repo, ['ls-tree', '-r', '--name-only', 'HEAD', '--', BLOB_DIR]).split('\n').filter(path => BLOB_PATH.test(path)))
	const deleted = new Map()
	for (const { status, path } of entries) {
		const blob = BLOB_PATH.exec(path)
		if (path.startsWith(`${HISTORY_DIR}/`)) history.push(path)
		else if (blob && status.includes('D') && trackedBlobs.has(path)) deleted.set(path, status)
		else if (blob && status !== '??' && status !== 'A ') damaged.push(path)
		else if (blob) newBlobs.push({ path, hex: blob[1] })
		else add.push(path)
	}

	let collectable = []
	let blobs = newBlobs
	let remove = []
	let supersededPaths = { records: [], dependents: [], bytes: { records: 0, dependents: 0 } }
	if (newBlobs.length > 0 || trackedBlobs.size > 0) {
		const scratch = makeScratch()
		try {
			buildCommittable(repo, scratch.workspaceRoot, entries)
			const gcGarbage = listGarbageBlobs({ workspaceRoot: scratch.workspaceRoot, home: scratch.home, ...(uiuxBin ? { uiuxBin } : {}) })
			let garbage = gcGarbage
			const hexOf = path => BLOB_PATH.exec(path)[1]
			if (findSuperseded && trackedBlobs.size > 0) {
				const plan = await planSupersededCaptures({
					workspaceRoot: scratch.workspaceRoot,
					tracked: new Set([...trackedBlobs].map(hexOf)),
					garbage: gcGarbage,
					readFreshness,
					home: scratch.home,
					...(uiuxBin ? { uiuxBin } : {}),
				})
				garbage = plan.garbage
				const sum = hexes => hexes.reduce((total, hex) => total + (plan.sizes.get(hex) ?? 0), 0)
				supersededPaths = { records: plan.records.map(blobPath), dependents: plan.dependents.map(blobPath), bytes: { records: sum(plan.records), dependents: sum(plan.dependents) }, contexts: plan.contexts }
			}
			collectable = newBlobs.filter(blob => garbage.has(blob.hex)).map(blob => blob.path)
			blobs = newBlobs.filter(blob => !garbage.has(blob.hex))
			remove = [...trackedBlobs].filter(path => gcGarbage.has(hexOf(path)) && garbage.has(hexOf(path))).sort()
		}
		finally {
			scratch.remove()
		}
	}
	// A deleted tracked blob that gc would not collect, and no fresh capture supersedes, is damage; one it would collect is a wanted deletion.
	const wanted = new Set([...remove, ...supersededPaths.records, ...supersededPaths.dependents])
	for (const path of deleted.keys()) if (!wanted.has(path)) damaged.push(path)
	const notStaged = path => deleted.get(path)?.[0] !== 'D'
	remove = remove.filter(notStaged)
	const superseded = {
		records: supersededPaths.records.filter(notStaged),
		dependents: supersededPaths.dependents.filter(notStaged),
		bytes: supersededPaths.bytes,
		contexts: supersededPaths.contexts ?? 0,
	}
	return { add: [...add, ...blobs.map(blob => blob.path)].sort(), resources: add.length, blobs: blobs.length, history, kitNodeModules, collectable, damaged, remove, superseded }
}

/** The freshness of the formal captures of the Workspace at `root`, by the same judgement as `dogfood:check` (it serves a copy; the packaged server must be built). */
async function defaultReadFreshness(root) {
	const { CheckError, readFormalCaptureFreshness } = await import('./dogfood-check.mjs')
	try {
		return await readFormalCaptureFreshness({ workspaceRoot: root })
	}
	catch (error) {
		if (error instanceof CheckError) throw new GuardError(`could not judge Evidence freshness for the superseded captures (pass --no-superseded to skip): ${error.message}`)
		throw error
	}
}

const shellQuote = path => `'${path.replaceAll('\'', '\'\\\'\'')}'`

export function formatSelection(result) {
	const lines = [`${result.add.length} path(s) to commit: ${result.resources} canonical resource change(s), ${result.blobs} Evidence blob(s) they reach.`]
	if (result.history.length > 0) lines.push(`Skipped ${result.history.length} ${HISTORY_DIR}/ path(s): history and the Baseline Checkpoint are never committed.`)
	if (result.kitNodeModules.length > 0) lines.push(`Skipped ${result.kitNodeModules.length} ${KIT_NODE_MODULES} path(s): a local link or install of the kit's dependencies is never committed (a symlink is not covered by the kit/node_modules/ ignore rule).`)
	if (result.collectable.length > 0) lines.push(`Skipped ${result.collectable.length} new blob(s) that gc --dry-run (empty UIUX_HOME) would delete: no committed resource reaches them.`)
	if (result.damaged.length > 0) {
		lines.push(`WARNING: ${result.damaged.length} tracked blob(s) changed or vanished; blobs are content-addressed, so restore them:`)
		lines.push(`  git restore -- ${result.damaged.map(shellQuote).join(' ')}`)
	}
	if (result.add.length > 0) {
		lines.push('', 'git add -- \\')
		result.add.forEach((path, index) => lines.push(`  ${shellQuote(path)}${index < result.add.length - 1 ? ' \\' : ''}`))
	}
	if (result.remove.length > 0) {
		lines.push('', `${result.remove.length} tracked blob(s) that gc --dry-run (empty UIUX_HOME) would collect from the tree as committed (superseded Evidence); delete them in this PR:`)
		lines.push('git rm -q -- \\')
		result.remove.forEach((path, index) => lines.push(`  ${shellQuote(path)}${index < result.remove.length - 1 ? ' \\' : ''}`))
	}
	const superseded = result.superseded
	const count = superseded.records.length + superseded.dependents.length
	if (count > 0) {
		lines.push('', `superseded by a fresh capture: ${superseded.records.length} tracked formal capture(s) (${formatBytes(superseded.bytes.records)}) that the Workbench's freshness judgement calls stale while a fresh capture of the same render context stays, and ${superseded.dependents.length} blob(s) (${formatBytes(superseded.bytes.dependents)}) that become unreferenced with them. gc keeps these (their View revision is current), nothing else reaches them, and Git history keeps the old blobs; delete them in this PR:`)
		lines.push('git rm -q -- \\')
		const paths = [...superseded.records, ...superseded.dependents]
		paths.forEach((path, index) => lines.push(`  ${shellQuote(path)}${index < paths.length - 1 ? ' \\' : ''}`))
	}
	lines.push('', 'Then commit, and run pnpm dogfood:guard before opening the PR.')
	return lines
}

function formatBytes(bytes) {
	return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.ceil(bytes / 1024)} KiB`
}

/** Runs {@link select} and, with `stage`, stages its additions and deletions; returns the lines to print. */
/** @param {string} repo @param {{ stage?: boolean } & NonNullable<Parameters<typeof select>[1]>} [options] */
export async function runSelect(repo, { stage: doStage = false, ...options } = {}) {
	const result = await select(repo, options)
	const lines = formatSelection(result)
	const deletions = [...result.remove, ...result.superseded.records, ...result.superseded.dependents]
	if (doStage && (result.add.length > 0 || deletions.length > 0)) {
		stage(repo, result.add)
		stage(repo, deletions, ['rm', '-q', '--ignore-unmatch'])
		lines.push('', `Staged ${result.add.length} path(s) and ${deletions.length} deletion(s).`)
	}
	return lines
}

function stage(repo, paths, subcommand = ['add']) {
	for (let index = 0; index < paths.length; index += STAGE_CHUNK)
		execFileSync('git', [...subcommand, '--', ...paths.slice(index, index + STAGE_CHUNK)], { cwd: repo, stdio: 'ignore' })
}

async function main() {
	const [command, ...rest] = process.argv.slice(2)
	const usage = 'Usage: node scripts/dogfood-worktree.mjs prepare [--home <dir>] [--no-build] | select [--stage] [--no-superseded]'
	try {
		const repo = toplevel(process.cwd())
		if (command === 'prepare') {
			const { values } = parseArgs({ args: rest, options: { 'home': { type: 'string' }, 'no-build': { type: 'boolean' } }, allowPositionals: false, strict: true })
			console.log(prepare(repo, { ...(values.home ? { home: values.home } : {}), build: !values['no-build'] }).join('\n'))
			return 0
		}
		if (command === 'select') {
			const { values } = parseArgs({ args: rest, options: { 'stage': { type: 'boolean' }, 'no-superseded': { type: 'boolean' } }, allowPositionals: false, strict: true })
			if (!isLinkedWorktree(repo)) throw new GuardError(`${repo} is the primary checkout; select runs in the authoring worktree.`)
			console.log((await runSelect(repo, { stage: values.stage === true, superseded: !values['no-superseded'] })).join('\n'))
			return 0
		}
		console.error(`dogfood worktree: ${command === undefined ? 'a command is required' : `unknown command ${command}`}.\n${usage}`)
		return 2
	}
	catch (error) {
		if (error instanceof GuardError || error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') {
			console.error(`dogfood worktree: ${error.message}\n${usage}`)
			return 2
		}
		throw error
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	process.exitCode = await main()
