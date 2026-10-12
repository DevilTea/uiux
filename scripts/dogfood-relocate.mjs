#!/usr/bin/env node

/**
 * D1: relocates this repository's dogfood Workspace from `design/` (schemaVersion 4, old layout)
 * to `<repo>/.uiux/` (schemaVersion 5). Run by the owner on the owner's host only, because
 * `uiux migrate` writes the pre-migration Checkpoint into the repository and records host history
 * under $UIUX_HOME (owner ruling 4 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627;
 * AGENTS.md: agents never run uiux migrate or uiux dev against design/).
 *
 * D1 is done: the owner ran this script on 2026-10-12 (commit da4a3ce). It stays as the record of
 * that run, and on this repository it now refuses with nothing changed, since design/ is gone.
 *
 * Usage, from the repository root, with no uiux dev running for design/:
 *
 *   node scripts/dogfood-relocate.mjs --check   # print the plan and check the preconditions; change nothing
 *   node scripts/dogfood-relocate.mjs           # run it
 *
 * Steps:
 *   0. Prepare the Adapter (ruling 3, the one-time hand edit): move design/adapters/reference.ts to
 *      design/.uiux/kit/adapters/reference.ts and point the manifest's specifier at
 *      ./.uiux/kit/adapters/reference.ts, which uiux.v4-to-v5 then rebases to ./adapters/reference.ts.
 *   1. uiux migrate --workspace design (the Workspace root becomes design/.uiux/).
 *   2. Move design/.uiux/ to .uiux/ and remove the then empty design/.
 *   3. Fix the Adapter's relative type import for its new depth.
 *   4. uiux access copy --from design --workspace .uiux (roster and host history; before the first uiux dev).
 *   5. Print the git steps.
 *
 * Before anything is written, both modes check every precondition: design/ and .uiux/ have no
 * uncommitted changes (`git status --porcelain -- design .uiux` is empty), the manifest names the
 * Adapter specifier exactly once (or already names the prepared one), design/'s roster exists under
 * $UIUX_HOME and .uiux/ has none yet, and `uiux migrate --dry-run` plans the migration. The dry run
 * runs on a temporary copy of design/ with step 0 applied, because on design/ itself it refuses the
 * not yet prepared Adapter; the copy is removed afterwards. When a step fails, the script prints the
 * steps that remain, with the commands to finish them by hand.
 *
 * `--repo <dir>` runs on another checkout (tests use a temporary copy). The script uses this
 * checkout's bin/uiux.mjs and the environment's UIUX_HOME (default ~/.uiux).
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/uiux.mjs', import.meta.url))
const OLD_SPECIFIER = './adapters/reference.ts'
const KIT_SPECIFIER = './.uiux/kit/adapters/reference.ts'
const OLD_TYPE_IMPORT = 'from \'../../src/'
const NEW_TYPE_IMPORT = 'from \'../../../src/'

/** The run's steps, by index; `fail` prints the ones from `nextStep` on. Filled in once the paths are known. */
let remainingSteps = []
let nextStep = undefined

function fail(message) {
	console.error(`dogfood-relocate: ${message}`)
	if (nextStep === undefined) {
		console.error('dogfood-relocate: nothing was changed; fix the above and run the script again.')
	}
	else {
		console.error('dogfood-relocate: stopped part way. Finish these steps by hand, from the repository root:')
		for (const step of remainingSteps.slice(nextStep)) console.error(`  ${step}`)
	}
	process.exit(1)
}

function parseArguments(argv) {
	const options = { repo: process.cwd(), check: false }
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index]
		if (argument === '--check') options.check = true
		else if (argument === '--repo' && argv[index + 1]) options.repo = argv[++index]
		else fail(`unknown argument ${argument}; usage: node scripts/dogfood-relocate.mjs [--check] [--repo <dir>]`)
	}
	return { ...options, repo: resolve(options.repo) }
}

/** Runs the CLI; returns its failure message, or undefined when it exited 0. */
function tryUiux(args) {
	console.log(`\n$ uiux ${args.join(' ')}`)
	const result = spawnSync(process.execPath, [CLI, ...args], { stdio: 'inherit' })
	return result.status === 0 ? undefined : `uiux ${args[0]} exited with ${result.status ?? result.signal}; stopped here (see above).`
}

function uiux(args) {
	const failure = tryUiux(args)
	if (failure !== undefined) fail(failure)
}

/** The manifest bytes with the Adapter specifier replaced, exactly once, or undefined when already replaced. */
function relocatedSpecifierManifest(text, path) {
	const from = `"moduleSpecifier":${JSON.stringify(OLD_SPECIFIER)}`
	const to = `"moduleSpecifier":${JSON.stringify(KIT_SPECIFIER)}`
	if (text.includes(to)) return undefined
	if (text.split(from).length !== 2) fail(`${path} does not name ${OLD_SPECIFIER} exactly once; edit its Adapter specifier by hand to ${KIT_SPECIFIER}.`)
	return text.replace(from, to)
}

/** Step 0 on `design`: the Adapter moves under `.uiux/kit/` and the manifest names it there. */
function prepareAdapter(design, editedManifest) {
	const adapter = join(design, 'adapters', 'reference.ts')
	const metadata = join(design, '.uiux')
	if (existsSync(adapter)) {
		mkdirSync(join(metadata, 'kit', 'adapters'), { recursive: true })
		renameSync(adapter, join(metadata, 'kit', 'adapters', 'reference.ts'))
		const adaptersDirectory = join(design, 'adapters')
		if (readdirSync(adaptersDirectory).length === 0) rmdirSync(adaptersDirectory)
	}
	if (editedManifest !== undefined) writeFileSync(join(metadata, 'workspace.json'), editedManifest)
}

/** `$UIUX_HOME` as the CLI resolves it. */
function uiuxHome() {
	const configured = process.env.UIUX_HOME?.trim()
	return resolve(configured ? configured : join(homedir(), '.uiux'))
}

/** The host-local directory of a Workspace's roster and history, keyed by its real root path. */
function hostDirectory(home, realRoot) {
	return join(home, 'workspaces', createHash('sha256').update(realRoot, 'utf8').digest('hex'))
}

function git(repo, args) {
	const result = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8' })
	if (result.status !== 0) fail(`git ${args.join(' ')} failed in ${repo}: ${(result.stderr || result.error?.message || '').trim()}`)
	return result.stdout
}

// Any unexpected error still reports where the run stopped and what remains.
process.on('uncaughtException', error => fail(error instanceof Error ? error.message : String(error)))

const options = parseArguments(process.argv.slice(2))
const design = join(options.repo, 'design')
const oldMetadata = join(design, '.uiux')
const oldManifest = join(oldMetadata, 'workspace.json')
const oldAdapter = join(design, 'adapters', 'reference.ts')
const preparedAdapter = join(oldMetadata, 'kit', 'adapters', 'reference.ts')
const newRoot = join(options.repo, '.uiux')
const movedAdapter = join(newRoot, 'kit', 'adapters', 'reference.ts')
const home = uiuxHome()
const homePrefix = process.env.UIUX_HOME?.trim() ? `UIUX_HOME=${home} ` : ''
remainingSteps = [
	`0. mkdir -p design/.uiux/kit/adapters && git mv design/adapters/reference.ts design/.uiux/kit/adapters/reference.ts; in design/.uiux/workspace.json set the Adapter moduleSpecifier to ${KIT_SPECIFIER}`,
	`1. ${homePrefix}node ${CLI} migrate --workspace ${design}`,
	'2. mv design/.uiux .uiux, then remove design/ once it is empty',
	'3. in .uiux/kit/adapters/reference.ts, rewrite the relative imports of ../../src/ to ../../../src/',
	`4. ${homePrefix}node ${CLI} access copy --from ${design} --workspace ${newRoot}`,
	'5. git status, then commit design/ and .uiux/ (see the end of a successful run)',
]

// Preconditions, all checked before anything is written.
const dirty = git(options.repo, ['status', '--porcelain', '--', 'design', '.uiux'])
if (dirty.trim() !== '') fail(`design/ or .uiux/ has uncommitted changes; commit or stash them first:\n${dirty.trimEnd()}`)
if (!existsSync(oldManifest)) fail(`${oldManifest} does not exist; nothing to relocate (was it relocated already?).`)
if (existsSync(newRoot)) fail(`${newRoot} already exists; move it aside first.`)
const manifestText = readFileSync(oldManifest, 'utf8')
let manifest
try { manifest = JSON.parse(manifestText) }
catch (error) { fail(`${oldManifest} is not JSON: ${error.message}`) }
if (manifest.schemaVersion !== 4) fail(`${oldManifest} has schemaVersion ${manifest.schemaVersion}; this script relocates a schemaVersion 4 Workspace.`)
if (!existsSync(oldAdapter) && !existsSync(preparedAdapter)) fail(`neither ${oldAdapter} nor ${preparedAdapter} exists.`)
const editedManifest = relocatedSpecifierManifest(manifestText, oldManifest)
const sourceHost = hostDirectory(home, realpathSync.native(design))
if (!existsSync(join(sourceHost, 'access.json'))) fail(`no roster for ${design} under ${home} (${join(sourceHost, 'access.json')}); run the script with the UIUX_HOME that serves the dogfood.`)
const targetHost = hostDirectory(home, join(realpathSync.native(options.repo), '.uiux'))
if (existsSync(targetHost)) fail(`${newRoot} already has a roster or host history under ${home} (${targetHost}); move it aside first.`)
if (!readFileSync(existsSync(oldAdapter) ? oldAdapter : preparedAdapter, 'utf8').includes(OLD_TYPE_IMPORT))
	console.warn(`dogfood-relocate: warning: the Adapter has no import from '../../src/'; check its relative imports by hand after the move.`)

console.log(`Dogfood relocation for ${options.repo}`)
console.log(`  from: ${design} (schemaVersion 4, manifest in design/.uiux/)`)
console.log(`  to:   ${newRoot} (schemaVersion 5)`)
console.log(`  UIUX_HOME: ${home}${homePrefix ? '' : ' (default)'}`)

// The migration plan, from a dry run on a prepared temporary copy of design/.
const rehearsal = mkdtempSync(join(tmpdir(), 'uiux-dogfood-check-'))
let rehearsalFailure
try {
	const copy = join(rehearsal, 'design')
	cpSync(design, copy, { recursive: true })
	prepareAdapter(copy, editedManifest)
	console.log(`\nDry run on a copy of design/ with the Adapter prepared (${copy}):`)
	rehearsalFailure = tryUiux(['migrate', '--workspace', copy, '--dry-run'])
}
catch (error) {
	rehearsalFailure = `could not rehearse the migration on a copy of design/: ${error.message}`
}
finally {
	rmSync(rehearsal, { recursive: true, force: true })
}
if (rehearsalFailure !== undefined) fail(rehearsalFailure)

if (options.check) {
	console.log('\n--check: the preconditions hold. A real run moves the Adapter into design/.uiux/kit/, edits its specifier, runs uiux migrate --workspace design, moves design/.uiux to .uiux, fixes the Adapter\'s type import, and runs uiux access copy --from design --workspace .uiux. Nothing was changed.')
	process.exit(0)
}

// 0. The Adapter must already be a module under .uiux/kit/ for uiux.v4-to-v5 (Rule 01a11bb1-9658).
nextStep = 0
prepareAdapter(design, editedManifest)
console.log(`\nPrepared the Adapter: design/.uiux/kit/adapters/reference.ts, specifier ${KIT_SPECIFIER} (owner ruling 3, one-time edit)`)

// 1. Migrate in place: design/.uiux/ becomes the schemaVersion 5 root.
nextStep = 1
uiux(['migrate', '--workspace', design])

// 2. Move the new root to <repo>/.uiux/ and drop the empty old root.
nextStep = 2
try { renameSync(oldMetadata, newRoot) }
catch (error) { fail(`could not move ${oldMetadata} to ${newRoot}: ${error.message}`) }
const leftovers = existsSync(design) ? readdirSync(design) : []
if (leftovers.length === 0 && existsSync(design)) rmdirSync(design)
console.log(`\nMoved design/.uiux to .uiux${leftovers.length > 0 ? `; design/ still holds ${leftovers.join(', ')}, left as is` : ' and removed the empty design/'}`)

// 3. The Adapter's relative type import, for .uiux/kit/adapters/ instead of design/adapters/.
nextStep = 3
const adapterSource = readFileSync(movedAdapter, 'utf8')
if (adapterSource.includes(OLD_TYPE_IMPORT)) {
	writeFileSync(movedAdapter, adapterSource.split(OLD_TYPE_IMPORT).join(NEW_TYPE_IMPORT))
	console.log('Rebased the Adapter\'s import of ../../src/ to ../../../src/')
}
else {
	console.warn(`dogfood-relocate: warning: ${movedAdapter} has no import from '../../src/'; check its relative imports by hand.`)
}

// 4. Roster and host history, keyed by the old root's path, before the first uiux dev there.
nextStep = 4
uiux(['access', 'copy', '--from', design, '--workspace', newRoot])

// 5. What the owner commits.
nextStep = 5
console.log(`
Done. Next, in ${options.repo}:
  git status
  git add --all -- design .uiux
  git commit -m "chore(dogfood): relocate the dogfood Workspace to .uiux/ (schemaVersion 5)"
The commit holds the moved files, product-kit.json and the pre-migration Checkpoint in .uiux/history/checkpoints/.
Consider the suggested .gitignore rules uiux migrate printed above for .uiux/ (it writes none).
Then an agent PR updates AGENTS.md (design/ -> .uiux/, the reference Adapter path .uiux/kit/adapters/reference.ts), README and the test comments that name design/.`)
