#!/usr/bin/env node

/**
 * D1: relocates this repository's dogfood Workspace from `design/` (schemaVersion 4, old layout)
 * to `<repo>/.uiux/` (schemaVersion 5). Run by the owner on the owner's host only, because
 * `uiux migrate` writes the pre-migration Checkpoint into the repository and records host history
 * under $UIUX_HOME (owner ruling 4 of https://github.com/DevilTea/uiux/discussions/139#discussioncomment-18851627;
 * AGENTS.md: agents never run uiux migrate or uiux dev against design/).
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
 * `--repo <dir>` runs on another checkout (tests use a temporary copy). The script uses this
 * checkout's bin/uiux.mjs and the environment's UIUX_HOME (default ~/.uiux).
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../bin/uiux.mjs', import.meta.url))
const OLD_SPECIFIER = './adapters/reference.ts'
const KIT_SPECIFIER = './.uiux/kit/adapters/reference.ts'
const OLD_TYPE_IMPORT = 'from \'../../src/'
const NEW_TYPE_IMPORT = 'from \'../../../src/'

function fail(message) {
	console.error(`dogfood-relocate: ${message}`)
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

function uiux(args) {
	console.log(`\n$ uiux ${args.join(' ')}`)
	const result = spawnSync(process.execPath, [CLI, ...args], { stdio: 'inherit' })
	if (result.status !== 0) fail(`uiux ${args[0]} exited with ${result.status ?? result.signal}; stopped here (see above).`)
}

/** The manifest bytes with the Adapter specifier replaced, exactly once, or undefined when already replaced. */
function relocatedSpecifierManifest(text) {
	const from = `"moduleSpecifier":${JSON.stringify(OLD_SPECIFIER)}`
	const to = `"moduleSpecifier":${JSON.stringify(KIT_SPECIFIER)}`
	if (text.includes(to)) return undefined
	if (text.split(from).length !== 2) fail(`design/.uiux/workspace.json does not name ${OLD_SPECIFIER} exactly once; edit its Adapter specifier by hand to ${KIT_SPECIFIER}.`)
	return text.replace(from, to)
}

const options = parseArguments(process.argv.slice(2))
const design = join(options.repo, 'design')
const oldMetadata = join(design, '.uiux')
const oldManifest = join(oldMetadata, 'workspace.json')
const oldAdapter = join(design, 'adapters', 'reference.ts')
const preparedAdapter = join(oldMetadata, 'kit', 'adapters', 'reference.ts')
const newRoot = join(options.repo, '.uiux')
const movedAdapter = join(newRoot, 'kit', 'adapters', 'reference.ts')

// Preconditions: the dogfood is still the schemaVersion 4 old-layout Workspace in design/.
if (!existsSync(oldManifest)) fail(`${oldManifest} does not exist; nothing to relocate (was it relocated already?).`)
if (existsSync(newRoot)) fail(`${newRoot} already exists; move it aside first.`)
let manifest
try { manifest = JSON.parse(readFileSync(oldManifest, 'utf8')) }
catch (error) { fail(`${oldManifest} is not JSON: ${error.message}`) }
if (manifest.schemaVersion !== 4) fail(`${oldManifest} has schemaVersion ${manifest.schemaVersion}; this script relocates a schemaVersion 4 Workspace.`)
if (!existsSync(oldAdapter) && !existsSync(preparedAdapter)) fail(`neither ${oldAdapter} nor ${preparedAdapter} exists.`)

console.log(`Dogfood relocation for ${options.repo}`)
console.log(`  from: ${design} (schemaVersion 4, manifest in design/.uiux/)`)
console.log(`  to:   ${newRoot} (schemaVersion 5)`)
console.log(`  UIUX_HOME: ${process.env.UIUX_HOME || '~/.uiux (default)'}`)
if (options.check) {
	console.log('\n--check: the preconditions hold. A real run moves the Adapter into design/.uiux/kit/, edits its specifier, runs uiux migrate --workspace design, moves design/.uiux to .uiux, fixes the Adapter\'s type import, and runs uiux access copy --from design --workspace .uiux. Nothing was changed.')
	process.exit(0)
}

// 0. The Adapter must already be a module under .uiux/kit/ for uiux.v4-to-v5 (Rule 01a11bb1-9658).
if (existsSync(oldAdapter)) {
	mkdirSync(join(oldMetadata, 'kit', 'adapters'), { recursive: true })
	renameSync(oldAdapter, preparedAdapter)
	const adaptersDirectory = join(design, 'adapters')
	if (readdirSync(adaptersDirectory).length === 0) rmdirSync(adaptersDirectory)
	console.log(`\nMoved design/adapters/reference.ts to design/.uiux/kit/adapters/reference.ts`)
}
const edited = relocatedSpecifierManifest(readFileSync(oldManifest, 'utf8'))
if (edited !== undefined) {
	writeFileSync(oldManifest, edited)
	console.log(`Pointed the Adapter specifier at ${KIT_SPECIFIER} (owner ruling 3, one-time edit)`)
}

// 1. Migrate in place: design/.uiux/ becomes the schemaVersion 5 root.
uiux(['migrate', '--workspace', design])

// 2. Move the new root to <repo>/.uiux/ and drop the empty old root.
renameSync(oldMetadata, newRoot)
const leftovers = existsSync(design) ? readdirSync(design) : []
if (leftovers.length === 0 && existsSync(design)) rmdirSync(design)
console.log(`\nMoved design/.uiux to .uiux${leftovers.length > 0 ? `; design/ still holds ${leftovers.join(', ')}, left as is` : ' and removed the empty design/'}`)

// 3. The Adapter's relative type import, for .uiux/kit/adapters/ instead of design/adapters/.
const adapterSource = readFileSync(movedAdapter, 'utf8')
if (adapterSource.includes(OLD_TYPE_IMPORT)) {
	writeFileSync(movedAdapter, adapterSource.split(OLD_TYPE_IMPORT).join(NEW_TYPE_IMPORT))
	console.log('Rebased the Adapter\'s import of ../../src/ to ../../../src/')
}
else {
	console.warn(`dogfood-relocate: warning: ${movedAdapter} has no import from '../../src/'; check its relative imports by hand.`)
}

// 4. Roster and host history, keyed by the old root's path, before the first uiux dev there.
uiux(['access', 'copy', '--from', design, '--workspace', newRoot])

// 5. What the owner commits.
console.log(`
Done. Next, in ${options.repo}:
  git status
  git add --all -- design .uiux
  git commit -m "chore(dogfood): relocate the dogfood Workspace to .uiux/ (schemaVersion 5)"
The commit holds the moved files, product-kit.json and the pre-migration Checkpoint in .uiux/history/checkpoints/.
Consider the suggested .gitignore rules uiux migrate printed above for .uiux/ (it writes none).
Then an agent PR updates AGENTS.md (design/ -> .uiux/, the reference Adapter path .uiux/kit/adapters/reference.ts), README and the test comments that name design/.`)
