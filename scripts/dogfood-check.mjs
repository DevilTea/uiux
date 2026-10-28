#!/usr/bin/env node

/**
 * Dogfood drift check (issue #383, phase 4 of the closed loop of Discussion #379; owner acceptance:
 * https://github.com/DevilTea/uiux/discussions/379#discussioncomment-19234465, P4).
 *
 * It answers one question without the owner's host: is the dogfood Workspace `.uiux/` as checked in
 * still the Workspace its formal Evidence was captured against, and do the app, the Kit and the design
 * tokens still agree? It never recaptures anything and never touches the checked-out `.uiux/`:
 *
 *  1. copies `.uiux/` (without runtime files, `kit/dist/` and `kit/node_modules/`) into a temporary
 *     directory with a temporary `UIUX_HOME`; every command passes an explicit `--workspace`;
 *  2. starts `uiux dev` (the packaged server) on loopback against the copy, which runs the declared kit
 *     build there (`kit/dist/` is gitignored, so the copy builds its own);
 *  3. creates a read-only CI member and Token by CLI, reads what the Workbench reads (the formal Evidence
 *     list with the current Adapter and Product Kit provenance, the Handoff readiness assessment) and
 *     fails on any required render context without a fresh complete formal capture (stale or missing);
 *  4. runs the Kit import scan (`checkProductKitAgainstKit`), `uiux components diff --check` (app against
 *     Kit) and `design-tokens.mjs --check` (DESIGN.md against `tokens.css`);
 *  5. fails when the run changed any file under the checked-out `.uiux/`.
 *
 * Required render contexts: every View x every Locale of the Workspace x every viewport preset x every
 * theme, without Variants (the dogfood captures the base context of each View; a Variant is an explicit
 * extra capture, never an implied one, Part 10 of the Evidence design). A context passes when at least
 * one formal capture of it is fresh by the Workbench's own judgement: `evidenceFreshness`
 * (`app/utils/readiness.ts`), bundled from the repository source so this script holds no copy of it.
 * Older captures of a context that a fresh one supersedes are counted and ignored (`uiux artifacts gc`
 * collects them; records carry no capture time, so "latest" is not decidable here).
 *
 * Usage: node scripts/dogfood-check.mjs [--source <dir>] [--keep]
 *   --source <dir>  the Workspace to check: a `.uiux/` directory or the directory that holds one
 *                   (default: this repository's `.uiux/`); the tree-unchanged check applies to it
 *   --keep          keep the temporary directory and print its path (debugging)
 * Exit 0 when every check passes, 1 when one fails, 2 on a usage or environment error. With
 * GITHUB_STEP_SUMMARY set, the report is also appended there as Markdown.
 */

import { createHash } from 'node:crypto'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { makeScratch } from './dogfood-guard.mjs'

const REPOSITORY = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST = '127.0.0.1'
const CI_NICKNAME = 'dogfood-check'
const SERVER_START_TIMEOUT_MS = 60_000
const KIT_BUILD_TIMEOUT_MS = 150_000
/** The Handoff readiness diagnostics that say a View's Evidence is stale, missing or incomplete. */
export const EVIDENCE_DIAGNOSTIC_CODES = Object.freeze(['handoff.stale_view_evidence', 'handoff.missing_view_evidence', 'handoff.incomplete_view_evidence'])
/** How many findings of one check the report lists before it only counts the rest. */
const MAX_LISTED = 60

/** An environment or usage problem (exit 2), as distinct from a failed check (exit 1). */
export class CheckError extends Error {}

// ---------------------------------------------------------------------------------------------
// The copy: what leaves the checked-out `.uiux/`, and proof that nothing changed in it
// ---------------------------------------------------------------------------------------------

/**
 * True for a path (relative to `.uiux/`, with `/`) that never enters the copy: the host-local runtime
 * files of a running server (`.uiux/.gitignore`), and the kit's installed and built output, which the
 * copy installs by link and builds itself.
 */
export function isRuntimePath(path) {
	const [first = '', second = ''] = path.split('/')
	if (first === '.transactions' || first === '.persistence.lock') return true
	if (first.startsWith('.server-hold') || first.startsWith('.persistence-lock-')) return true
	if (first === '.DS_Store' || path.endsWith('/.DS_Store')) return true
	return first === 'kit' && (second === 'node_modules' || second === 'dist')
}

/** Copies the Workspace directory `source` (a `.uiux/`) to `destination`, leaving out {@link isRuntimePath}. Returns the number of files copied. */
export function copyWorkspace(source, destination) {
	let files = 0
	cpSync(source, destination, {
		recursive: true,
		verbatimSymlinks: true,
		preserveTimestamps: true,
		filter: (path) => {
			const rel = relative(source, path).split(sep).join('/')
			if (rel !== '' && isRuntimePath(rel)) return false
			if (rel !== '' && !lstatSync(path).isDirectory()) files += 1
			return true
		},
	})
	return files
}

/**
 * A content snapshot of the directory `root` for the unchanged-tree assertion: every entry, ignored
 * files included, as a Map from its `/` path to `d` (directory), `f:<exec bit>:<sha256>` (file) or
 * `l:<target>` (symbolic link). Modification times are not part of it: reading a file does not change
 * its content, and only a content change is a change of the Workspace.
 */
export function snapshotTree(root) {
	const snapshot = new Map()
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const path = join(directory, entry.name)
			const rel = relative(root, path).split(sep).join('/')
			if (entry.isSymbolicLink()) snapshot.set(rel, `l:${readlinkSync(path)}`)
			else if (entry.isDirectory()) {
				snapshot.set(rel, 'd')
				walk(path)
			}
			else {
				const info = lstatSync(path)
				snapshot.set(rel, `f:${info.mode & 0o111 ? 'x' : '-'}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
			}
		}
	}
	walk(root)
	return snapshot
}

/** What differs between two {@link snapshotTree} results: `{ added, removed, changed }` (sorted paths). */
export function diffSnapshots(before, after) {
	const added = [...after.keys()].filter(path => !before.has(path)).sort()
	const removed = [...before.keys()].filter(path => !after.has(path)).sort()
	const changed = [...before.keys()].filter(path => after.has(path) && after.get(path) !== before.get(path)).sort()
	return { added, removed, changed }
}

// ---------------------------------------------------------------------------------------------
// Evidence: which render contexts are required, and which of them are fresh
// ---------------------------------------------------------------------------------------------

const DEFAULT_VIEWPORT = Object.freeze({ id: 'default', width: 1280, height: 800 })
const FALLBACK_THEME_ID = 'light'
const FALLBACK_LOCALE = 'en-US'

/** The identity of a resolved render context; the same fields as `contextKey` in `app/utils/readiness.ts` (a test keeps them equal). */
export function contextKey(context) {
	return [context.viewId, context.variantName ?? '', context.locale, context.viewportId, `${context.viewport.width}x${context.viewport.height}`, context.themeId].join('\u0000')
}

/**
 * The render contexts the check requires fresh Evidence for: every View x Locale x viewport preset x
 * theme of the Workspace, without Variants. A Workspace without viewports or themes renders the
 * built-in `default` viewport and the `light` theme (`src/preview/render-context-options.ts`).
 * `views` are `{ key, name }`, `workspace` is the manifest, `locales` the Locale files discovered.
 */
export function requiredContexts({ views, workspace, locales }) {
	const sorted = values => [...new Set(values)].sort()
	const localeIds = sorted([...locales, ...(workspace?.i18n?.defaultLocale ? [workspace.i18n.defaultLocale] : [])])
	if (localeIds.length === 0) localeIds.push(FALLBACK_LOCALE)
	const viewports = Object.entries(workspace?.viewports ?? {}).map(([id, preset]) => ({
		id,
		width: typeof preset?.dimensions?.width === 'number' ? preset.dimensions.width : DEFAULT_VIEWPORT.width,
		height: typeof preset?.dimensions?.height === 'number' ? preset.dimensions.height : DEFAULT_VIEWPORT.height,
	})).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
	if (viewports.length === 0) viewports.push(DEFAULT_VIEWPORT)
	const themeIds = sorted(Object.keys(workspace?.themes ?? {}))
	if (themeIds.length === 0) themeIds.push(FALLBACK_THEME_ID)
	const contexts = []
	for (const view of [...views].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
		for (const locale of localeIds) {
			for (const viewport of viewports) {
				for (const themeId of themeIds) {
					const context = { viewId: view.key, locale, viewportId: viewport.id, viewport: { width: viewport.width, height: viewport.height }, themeId }
					contexts.push({ ...context, viewName: view.name ?? view.key, key: contextKey(context) })
				}
			}
		}
	}
	return { contexts, dimensions: { views: views.length, locales: localeIds.length, viewports: viewports.length, themes: themeIds.length } }
}

/**
 * The freshness reasons from the closest to fresh to the furthest: a capture that is stale only because the
 * Adapter or Product Kit changed passed every earlier condition (`evaluateEvidenceStaleness` judges the View,
 * Locale, viewport and theme first), so its reason says what to recapture for; a capture of an older View state
 * only repeats an older drift.
 */
const REASON_ORDER = ['adapterChanged', 'productKitChanged', 'incomplete', 'themeRemoved', 'viewportChanged', 'viewportRemoved', 'localeChanged', 'localeMissing', 'viewChanged', 'noRenderInputDigest', 'viewMissing']

/** The capture of a context with no fresh capture whose freshness best explains it: stale before unknown, then {@link REASON_ORDER}. */
function mostRelevant(captures) {
	const rank = (capture) => {
		const index = REASON_ORDER.indexOf(capture.freshness.reason)
		return (capture.freshness.state === 'stale' ? 0 : 1000) + (index < 0 ? REASON_ORDER.length : index)
	}
	return [...captures].sort((a, b) => rank(a) - rank(b))[0]
}

/**
 * Classifies each required context. `entries` are the formal captures with their Workbench freshness:
 * `{ digest, context?, freshness: { state: 'fresh' | 'stale' | 'unknown', reason?, subject? }, record? }`.
 * A context is `fresh` when any of its captures is fresh, `stale` when it has captures and none is
 * (a definite stale outranks an unknown one in the reason), and `missing` when it has none.
 * Returns `{ fresh, stale, missing, ignored }`; `ignored` counts the captures that satisfy no
 * required context, with how many of them are not fresh.
 */
export function assessEvidence({ required, entries }) {
	const byContext = new Map()
	for (const entry of entries) {
		if (!entry.context) continue
		const key = contextKey(entry.context)
		byContext.set(key, [...(byContext.get(key) ?? []), entry])
	}
	const fresh = []
	const stale = []
	const missing = []
	for (const context of required) {
		const captures = byContext.get(context.key) ?? []
		if (captures.length === 0) missing.push(context)
		else if (captures.some(capture => capture.freshness.state === 'fresh')) fresh.push(context)
		else stale.push({ context, freshness: mostRelevant(captures).freshness, captures })
	}
	const requiredKeys = new Set(required.map(context => context.key))
	const unmatched = entries.filter(entry => !entry.context || !requiredKeys.has(contextKey(entry.context)))
	const superseded = entries.filter(entry => entry.context && requiredKeys.has(contextKey(entry.context)) && entry.freshness.state !== 'fresh')
	return {
		fresh,
		stale,
		missing,
		ignored: { outsideRequired: unmatched.length, supersededNotFresh: superseded.length },
	}
}

const contextLabel = context => `${context.viewName} (${context.viewId.slice(0, 8)}) ${context.locale} ${context.viewportId} ${context.themeId}`

/**
 * The Adapter and Product Kit digests that the stale captures recorded against the current ones, as report lines,
 * when the captures are stale for that reason. This is how a kit build that is not byte-identical to the one the
 * Evidence was captured against (another OS or toolchain, or a Kit change without a recapture) shows up.
 */
export function describeProvenanceDrift(stale, current) {
	const reasons = new Set(stale.map(item => item.freshness.reason))
	const lines = []
	if (reasons.has('adapterChanged')) {
		const recorded = new Set(stale.flatMap(item => item.captures.filter(capture => capture.freshness.reason === 'adapterChanged').flatMap(capture => (capture.record?.provenance?.adapters ?? []).map(adapter => adapter.contentDigest))).filter(Boolean))
		lines.push(`Adapter contentDigest now ${(current.adapters ?? []).map(adapter => adapter.contentDigest).join(', ') || 'unavailable'}; the captures stale for that reason recorded ${[...recorded].join(', ') || 'none'}.`)
	}
	if (reasons.has('productKitChanged')) {
		const recorded = new Set(stale.flatMap(item => item.captures.filter(capture => capture.freshness.reason === 'productKitChanged').map(capture => capture.record?.provenance?.productKit?.outputDigest)).filter(Boolean))
		lines.push(`Product Kit outputDigest now ${current.productKit?.outputDigest ?? 'unavailable'}; the captures stale for that reason recorded ${[...recorded].join(', ') || 'none'}.`)
	}
	if (lines.length > 0) {
		lines.push('The kit build output differs from the one the Evidence was captured against: a Kit change without a recapture, or a build that is not byte-identical across OS or toolchain (compare the kit output digests listed above with those of the capturing host).')
	}
	return lines
}

/**
 * Reads a Handoff readiness assessment response (`POST /api/handoff/assess`). The check fails when the
 * assessment is refused or reports Evidence diagnostics; any other blocking diagnostic (an open Review, say) is
 * a note, since it is not drift between the Workspace and its Evidence.
 */
export function parseReadiness(response) {
	if (!response || response.status !== 'ok' || !response.readiness) {
		const detail = (response?.diagnostics ?? []).map(diagnostic => `${diagnostic.code ?? 'diagnostic'}: ${diagnostic.message}`).join('; ')
		return { ok: false, evidence: [], notes: [], summary: `the readiness assessment was refused (${response?.status ?? 'no response'}${detail ? `: ${detail}` : ''})` }
	}
	const diagnostics = response.readiness.blockingDiagnostics ?? []
	const evidence = diagnostics.filter(diagnostic => EVIDENCE_DIAGNOSTIC_CODES.includes(diagnostic.code))
	const notes = diagnostics.filter(diagnostic => !EVIDENCE_DIAGNOSTIC_CODES.includes(diagnostic.code))
	const evidenceComplete = response.readiness.coverage?.evidence?.complete === true && response.assessment?.requiredEvidenceComplete !== false
	return {
		ok: evidence.length === 0 && evidenceComplete,
		evidence,
		notes,
		summary: `implementationReady ${response.readiness.implementationReady === true}, evidence complete ${evidenceComplete}, ${evidence.length} Evidence diagnostic(s), ${notes.length} other diagnostic(s)`,
	}
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

/** Collects check results: `{ id, title, status: 'pass' | 'fail' | 'skip', lines }`. */
export function createReport() {
	const checks = []
	return {
		checks,
		add(id, title, status, lines = []) {
			checks.push({ id, title, status, lines })
		},
		get failed() {
			return checks.some(check => check.status === 'fail')
		},
	}
}

export function formatReport(report) {
	const out = []
	for (const check of report.checks) {
		out.push(`${check.status.toUpperCase().padEnd(4)}  ${check.title}`)
		for (const line of check.lines) out.push(`        ${line}`)
	}
	const failed = report.checks.filter(check => check.status === 'fail')
	out.push('', failed.length === 0 ? 'dogfood:check passed.' : `dogfood:check FAILED: ${failed.map(check => check.id).join(', ')}.`)
	return out.join('\n')
}

export function formatSummaryMarkdown(report, header = []) {
	const icon = { pass: 'pass', fail: '**FAIL**', skip: 'skip' }
	const out = ['## dogfood:check', '', ...header.map(line => `- ${line}`), '', '| Check | Result |', '| --- | --- |']
	for (const check of report.checks) out.push(`| ${check.title} | ${icon[check.status]} |`)
	for (const check of report.checks.filter(item => item.status !== 'pass' && item.lines.length > 0)) {
		out.push('', `### ${check.title}`, '', '```', ...check.lines, '```')
	}
	return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------
// Phase 3 hook
// ---------------------------------------------------------------------------------------------

/**
 * TODO(phase 3, #382): the checks that need requirement references (Workspace schema 7) are not built yet.
 * When #382 lands, replace each entry with a function that returns `{ status, lines }` and run it
 * with the others in `main`:
 *  - requirement coverage: every `.spec/` Rule that is not `noUi` is referenced by a View, Variant or Flow
 *    (the product's own coverage computation, read through the served copy);
 *  - route coverage: every route under `app/pages/` maps to at least one View or has an explicit exemption.
 * Until then they are listed as skipped, so the report says what it does not check.
 */
export const PHASE_3_CHECKS = Object.freeze([
	{ id: 'requirement-coverage', title: 'Requirement coverage (phase 3, #382)' },
	{ id: 'route-coverage', title: 'Route coverage of app/pages/ (phase 3, #382)' },
])

// ---------------------------------------------------------------------------------------------
// Running the pieces
// ---------------------------------------------------------------------------------------------

const redact = text => text.replace(/uiux_[it]_\S+/gu, '[redacted]')

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
	if (result.error) throw new CheckError(`Could not run ${command} ${args.join(' ')}: ${result.error.message}`)
	return result
}

const tail = (text, lines = 20) => redact(text.trim()).split('\n').slice(-lines)

async function selectPort() {
	const probe = createServer()
	await new Promise((resolvePromise, reject) => { probe.once('error', reject); probe.listen(0, HOST, resolvePromise) })
	const address = probe.address()
	if (!address || typeof address === 'string') throw new CheckError('Could not select a local port.')
	await new Promise((resolvePromise, reject) => probe.close(error => (error ? reject(error) : resolvePromise())))
	return address.port
}

const sleep = milliseconds => new Promise(resolvePromise => setTimeout(resolvePromise, milliseconds))

/** The Workspace directory at `input`: a `.uiux/` (it holds `workspace.json`) or the directory that holds one. */
export function locateWorkspace(input) {
	const path = resolve(input)
	if (existsSync(join(path, 'workspace.json'))) return path
	if (existsSync(join(path, '.uiux', 'workspace.json'))) return join(path, '.uiux')
	throw new CheckError(`${path} holds no Workspace (no workspace.json, and no .uiux/workspace.json).`)
}

/** Bundles the repository modules the check judges with (the Workbench's freshness, the Kit registry check) and imports them. */
async function loadRepositoryModules(scratch) {
	const { default: esbuild } = await import('esbuild')
	const directory = join(scratch, 'lib')
	mkdirSync(directory)
	// Bare imports of the bundle (zod, ajv, ...) resolve through this link to the repository's packages.
	symlinkSync(join(REPOSITORY, 'node_modules'), join(directory, 'node_modules'))
	const result = await esbuild.build({
		stdin: {
			contents: [
				'export { evidenceFreshness, contextFromRecord, contextKey } from \'./app/utils/readiness.ts\'',
				'export { checkProductKitAgainstKit } from \'./src/adapters/kit-registry.ts\'',
				'export { validateProductKit } from \'./src/domain/product-kit/schema.ts\'',
			].join('\n'),
			resolveDir: REPOSITORY,
			loader: 'js',
		},
		bundle: true,
		format: 'esm',
		platform: 'node',
		target: 'node24',
		packages: 'external',
		write: false,
		logLevel: 'silent',
	})
	const file = join(directory, 'repository-modules.mjs')
	writeFileSync(file, result.outputFiles[0].text)
	return await import(pathToFileURL(file).href)
}

/** Every child still running and every directory still to remove, for an interrupt (see the bottom of this file). */
const liveProcessGroups = new Set()
const liveDirectories = new Set()

/** The packaged server started with `uiux dev` for one Workspace, and what is needed to stop it again. */
async function startServer({ workspaceRoot, home, cwd }) {
	const port = await selectPort()
	const env = { ...process.env, UIUX_HOME: home, PORT: String(port) }
	for (const name of ['HOST', 'NITRO_HOST', 'NITRO_PORT', 'NITRO_UNIX_SOCKET', 'NITRO_SSL_CERT', 'NITRO_SSL_KEY']) delete env[name]
	// Detached, so the CLI and the Nitro server and kit build it spawns stop together as one process group.
	const child = spawn(process.execPath, [join(REPOSITORY, 'bin', 'uiux.mjs'), 'dev', '--workspace', workspaceRoot], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
	let output = ''
	child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk })
	child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk })
	let exited = false
	liveProcessGroups.add(child.pid)
	child.once('exit', () => { exited = true })
	const kill = (signal) => {
		try { process.kill(-child.pid, signal) }
		catch (error) { if (error.code !== 'ESRCH') throw error }
	}
	const server = {
		port,
		origin: `http://${HOST}:${port}`,
		log: () => output,
		async stop() {
			if (child.pid === undefined) return
			if (!exited) {
				const done = new Promise(resolvePromise => child.once('exit', resolvePromise))
				kill('SIGTERM')
				const force = setTimeout(() => kill('SIGKILL'), 10_000)
				await done
				clearTimeout(force)
			}
			kill('SIGKILL')
			liveProcessGroups.delete(child.pid)
		},
	}
	const deadline = Date.now() + SERVER_START_TIMEOUT_MS
	while (!output.includes(`Listening on http://${HOST}:${port}`)) {
		if (exited || Date.now() > deadline) {
			await server.stop()
			throw new CheckError(`uiux dev ${exited ? 'exited' : 'did not start within 60 s'}:\n${tail(output).join('\n')}`)
		}
		await sleep(100)
	}
	return server
}

/** An authenticated JSON request to the served copy. */
function client(origin, token) {
	const request = async (method, path, body) => {
		const response = await fetch(`${origin}${path}`, {
			method,
			headers: { 'authorization': `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		})
		const text = await response.text()
		let json
		try { json = JSON.parse(text) }
		catch { json = undefined }
		return { status: response.status, json, text }
	}
	return {
		async get(path) {
			const result = await request('GET', path)
			if (result.status !== 200) throw new CheckError(`GET ${path} returned HTTP ${result.status}: ${redact(result.text).slice(0, 300)}`)
			return result.json
		},
		/** A POST whose non-200 answer is still the answer (the readiness assessment answers 422 with its diagnostics). */
		async post(path, body) {
			return (await request('POST', path, body)).json
		},
		async list(kind) {
			const items = []
			let cursor
			do {
				const page = await this.post('/api/resources/list', { kinds: [kind], limit: 100, ...(cursor ? { cursor } : {}) })
				if (!page || !Array.isArray(page.items)) throw new CheckError(`POST /api/resources/list for ${kind} returned no items.`)
				items.push(...page.items)
				cursor = page.nextCursor
			} while (cursor)
			return items
		},
	}
}

async function waitForKitBuild(api) {
	const deadline = Date.now() + KIT_BUILD_TIMEOUT_MS
	let build
	// `ready` is the only success; `failed` ends the wait early, anything else (building) is waited out.
	do {
		build = (await api.get('/api/product-kit/build')).build
		if (build?.state === 'ready') return build
		if (build?.state === 'failed') break
		await sleep(250)
	} while (Date.now() < deadline)
	let log = ''
	try { log = (await api.get('/api/product-kit/build/log')).log ?? '' }
	catch { /* the state is the finding */ }
	throw new CheckError(`The kit build did not become ready (${JSON.stringify(build)}).${log ? `\n${tail(log, 15).join('\n')}` : ''}`)
}

function digestOutput(kitDirectory) {
	const packageFile = join(kitDirectory, 'package.json')
	const output = existsSync(packageFile) ? JSON.parse(readFileSync(packageFile, 'utf8'))?.uiux?.output : undefined
	if (typeof output !== 'string') return []
	const root = join(kitDirectory, output)
	if (!existsSync(root)) return []
	const lines = []
	const walk = (directory) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
			const path = join(directory, entry.name)
			if (entry.isDirectory()) walk(path)
			else if (!entry.name.endsWith('.map')) lines.push(`kit/${relative(kitDirectory, path).split(sep).join('/')} sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')} (${lstatSync(path).size} bytes)`)
		}
	}
	walk(root)
	return lines
}

function toolchainLines() {
	const version = (name) => {
		try { return JSON.parse(readFileSync(join(REPOSITORY, 'node_modules', name, 'package.json'), 'utf8')).version }
		catch { return 'unknown' }
	}
	return [`toolchain: node ${process.versions.node} on ${process.platform}-${process.arch}, esbuild ${version('esbuild')}, vue ${version('vue')}`]
}

/** Steps 2 and 3: serve the copy, read Evidence freshness and readiness, stop the server. Returns the check results. */
async function checkServedCopy({ report, scratch, copiedRoot, modules, header }) {
	const cli = (...args) => run(process.execPath, [join(REPOSITORY, 'bin', 'uiux.mjs'), ...args, '--workspace', copiedRoot], { cwd: scratch.base, env: { ...process.env, UIUX_HOME: scratch.home } })
	const added = cli('member', 'add', CI_NICKNAME, '--preset', 'viewer', '--kind', 'agent')
	if (added.status !== 0) throw new CheckError(`uiux member add failed:\n${tail(added.stderr || added.stdout).join('\n')}`)
	const created = cli('token', 'create', '--member', CI_NICKNAME, '--label', 'dogfood:check', '--expires', '1')
	const token = /uiux_t_\S+/u.exec(created.stdout)?.[0]
	if (created.status !== 0 || !token) throw new CheckError(`uiux token create failed:\n${tail(created.stderr || created.stdout).join('\n')}`)

	const server = await startServer({ workspaceRoot: copiedRoot, home: scratch.home, cwd: scratch.base })
	try {
		const api = client(server.origin, token)
		const build = await waitForKitBuild(api)
		header.push(`kit build in the copy: ${build.state}`)
		header.push(...digestOutput(join(copiedRoot, '.uiux', 'kit')))

		const workspace = await api.get('/api/resources/workspace/workspace')
		if (workspace.inspection?.state !== 'current') {
			report.add('evidence', 'Evidence freshness of the required render contexts', 'fail', [`the Workspace is not at the current schema (${workspace.inspection?.state ?? 'unknown'}): ${(workspace.inspection?.diagnostics ?? []).map(item => item.message).join('; ')}`])
			return
		}
		const views = (await api.list('view')).map(item => ({ key: item.key, name: item.summary?.name }))
		const localeItems = await api.list('locale')
		const evidence = await api.get('/api/evidence/list')
		header.push(`Adapter contentDigest: ${(evidence.adapters ?? []).map(adapter => adapter.contentDigest).join(', ') || 'unavailable'}`)
		header.push(`Product Kit outputDigest: ${evidence.productKit?.outputDigest ?? 'unavailable'}`)

		// What the Workbench judges freshness against (`useReadiness`), read the same way.
		const stalenessContext = {
			allViews: (evidence.views ?? []).map(view => ({ key: view.key, renderInputDigest: view.renderInputDigest })),
			workspace,
			discoveredLocales: localeItems.map(item => item.key),
			localeRevisions: Object.fromEntries(localeItems.map(item => [item.key, item.revision])),
			...(evidence.productKit ? { productKit: evidence.productKit } : {}),
			...(evidence.productKitUnavailable === true ? { productKitUnavailable: true } : {}),
			...(evidence.adapters ? { adapters: evidence.adapters } : {}),
			...(evidence.adaptersUnavailable === true ? { adaptersUnavailable: true } : {}),
		}
		const entries = (evidence.items ?? [])
			.filter(item => item?.record?.kind === 'formal_capture')
			.map((item) => {
				const context = modules.contextFromRecord(item.record)
				return { digest: item.digest, record: item.record, ...(context ? { context } : {}), freshness: modules.evidenceFreshness(item.record, stalenessContext) }
			})
		const { contexts, dimensions } = requiredContexts({ views, workspace: workspace.resource, locales: localeItems.map(item => item.key) })
		const assessed = assessEvidence({ required: contexts, entries })
		const total = contexts.length
		const lines = [
			`${assessed.fresh.length}/${total} required render contexts have a fresh formal capture (${dimensions.views} Views x ${dimensions.locales} Locales x ${dimensions.viewports} viewports x ${dimensions.themes} themes, no Variants); ${assessed.stale.length} stale, ${assessed.missing.length} missing.`,
			`${entries.length} formal captures read; ${assessed.ignored.supersededNotFresh} non-fresh capture(s) of required contexts and ${assessed.ignored.outsideRequired} capture(s) of other contexts are not listed (a context passes with one fresh capture; nothing is recaptured; uiux artifacts gc collects the rest).`,
		]
		const findings = [
			...assessed.stale.map(item => `STALE    ${contextLabel(item.context)}: ${item.freshness.state === 'unknown' ? 'freshness unknown' : 'stale'}, ${item.freshness.reason ?? 'no reason'}${item.freshness.subject ? ` (${item.freshness.subject})` : ''}`),
			...assessed.missing.map(context => `MISSING  ${contextLabel(context)}: no formal capture`),
		]
		lines.push(...findings.slice(0, MAX_LISTED))
		if (findings.length > MAX_LISTED) lines.push(`... and ${findings.length - MAX_LISTED} more.`)
		const reasons = new Map()
		for (const item of assessed.stale) reasons.set(item.freshness.reason ?? 'unknown', (reasons.get(item.freshness.reason ?? 'unknown') ?? 0) + 1)
		if (reasons.size > 0) lines.push(`Stale reasons: ${[...reasons].map(([reason, count]) => `${reason} x${count}`).join(', ')}.`)
		lines.push(...describeProvenanceDrift(assessed.stale, { adapters: evidence.adapters, productKit: evidence.productKit }))
		report.add('evidence', 'Evidence freshness of the required render contexts', findings.length === 0 && total > 0 ? 'pass' : 'fail', total === 0 ? ['no required render contexts (no Views)'] : lines)

		const readiness = parseReadiness(await api.post('/api/handoff/assess', { roots: [{ type: 'workspace' }] }))
		report.add('readiness', 'Handoff readiness of the Workspace (Evidence part)', readiness.ok ? 'pass' : 'fail', [
			readiness.summary,
			...readiness.evidence.map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`),
			...readiness.notes.map(diagnostic => `note, not judged: ${diagnostic.code}: ${diagnostic.message}`),
		])
	}
	finally {
		await server.stop()
	}
}

/** The Kit import scan and registry check of the copy (Rule 01a11bb1-a310-70a6-9f9b-c87ec2bcfaf9): any refusal or finding fails. */
async function checkKitRegistry({ report, copiedRoot, modules }) {
	const productKit = JSON.parse(readFileSync(join(copiedRoot, '.uiux', 'product-kit.json'), 'utf8'))
	const validated = modules.validateProductKit(productKit)
	if (validated.diagnostics?.length > 0) {
		report.add('kit-registry', 'Kit registry and import scan', 'fail', validated.diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`))
		return
	}
	const checked = await modules.checkProductKitAgainstKit({ root: join(copiedRoot, '.uiux'), codeDirectoryName: 'kit', next: productKit })
	const findings = [...checked.refusals, ...checked.findings]
	report.add('kit-registry', 'Kit registry and import scan', findings.length === 0 ? 'pass' : 'fail',
		findings.length === 0 ? ['0 refusals, 0 findings'] : findings.map(diagnostic => `${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`))
}

function checkComponentsDiff({ report, copiedRoot, scratch }) {
	// The product project is this repository (its uiux-components.json); the Kit is the copy's. `diff` only reads.
	const result = run(process.execPath, [join(REPOSITORY, 'bin', 'uiux.mjs'), 'components', 'diff', '--check', '--project', REPOSITORY, '--workspace', copiedRoot], { cwd: scratch.base, env: { ...process.env, UIUX_HOME: scratch.home } })
	report.add('components-diff', 'uiux components diff --check (app against Kit)', result.status === 0 ? 'pass' : 'fail', tail(`${result.stdout}\n${result.stderr}`, 30))
}

function checkDesignTokens({ report }) {
	const result = run(process.execPath, [join(REPOSITORY, 'scripts', 'design-tokens.mjs'), '--check'], { cwd: REPOSITORY })
	report.add('design-tokens', 'design:tokens --check (DESIGN.md against tokens.css)', result.status === 0 ? 'pass' : 'fail', result.status === 0 ? [] : tail(`${result.stdout}\n${result.stderr}`, 10))
}

/** Runs the whole check on the Workspace at `source` (a `.uiux/`); returns `{ report, header }`. */
export async function runCheck({ source, keep = false }) {
	const report = createReport()
	const header = [...toolchainLines()]
	const before = snapshotTree(source)
	const scratch = makeScratch('uiux-dogfood-check-')
	if (!keep) liveDirectories.add(scratch.base)
	try {
		if (!existsSync(join(REPOSITORY, '.output', 'server', 'index.mjs'))) {
			execFileSync('pnpm', ['build'], { cwd: REPOSITORY, stdio: 'inherit' })
		}
		const copiedRoot = scratch.workspaceRoot
		const files = copyWorkspace(source, join(copiedRoot, '.uiux'))
		// The kit build resolves esbuild and vue from node_modules; the copy lives outside the repository, so link them.
		if (existsSync(join(copiedRoot, '.uiux', 'kit', 'package.json'))) symlinkSync(join(REPOSITORY, 'node_modules'), join(copiedRoot, '.uiux', 'kit', 'node_modules'))
		header.push(`copy: ${files} files, temporary UIUX_HOME, --workspace ${copiedRoot}`)
		const modules = await loadRepositoryModules(scratch.base)

		const attempt = async (id, title, work) => {
			try { await work() }
			catch (error) { report.add(id, title, 'fail', [error instanceof CheckError ? error.message : `${error?.stack ?? error}`]) }
		}
		await attempt('evidence', 'Evidence freshness of the required render contexts', () => checkServedCopy({ report, scratch, copiedRoot, modules, header }))
		await attempt('kit-registry', 'Kit registry and import scan', () => checkKitRegistry({ report, copiedRoot, modules }))
		await attempt('components-diff', 'uiux components diff --check (app against Kit)', () => checkComponentsDiff({ report, copiedRoot, scratch }))
		await attempt('design-tokens', 'design:tokens --check (DESIGN.md against tokens.css)', () => checkDesignTokens({ report }))
		for (const check of PHASE_3_CHECKS) report.add(check.id, check.title, 'skip', ['not built yet: needs requirement references (schema 7), phase 3'])
	}
	finally {
		if (!keep) scratch.remove()
		liveDirectories.delete(scratch.base)
	}
	const changes = diffSnapshots(before, snapshotTree(source))
	const changed = [...changes.added.map(path => `added    ${path}`), ...changes.removed.map(path => `removed  ${path}`), ...changes.changed.map(path => `changed  ${path}`)]
	report.add('tree-unchanged', 'The checked-out .uiux/ is unchanged by the run', changed.length === 0 ? 'pass' : 'fail', changed.slice(0, MAX_LISTED))
	if (keep) header.push(`kept: ${scratch.base}`)
	return { report, header }
}

async function main() {
	const usage = 'Usage: node scripts/dogfood-check.mjs [--source <dir>] [--keep]'
	let values
	try {
		({ values } = parseArgs({ args: process.argv.slice(2), options: { source: { type: 'string' }, keep: { type: 'boolean' } }, allowPositionals: false, strict: true }))
	}
	catch (error) {
		console.error(`dogfood:check: ${error.message}\n${usage}`)
		return 2
	}
	try {
		const source = locateWorkspace(values.source ?? join(REPOSITORY, '.uiux'))
		const { report, header } = await runCheck({ source, keep: values.keep === true })
		console.log(header.join('\n'))
		console.log(`\n${formatReport(report)}`)
		if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, formatSummaryMarkdown(report, header))
		return report.failed ? 1 : 0
	}
	catch (error) {
		if (error instanceof CheckError) {
			console.error(`dogfood:check: ${error.message}`)
			return 2
		}
		throw error
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	// An interrupt must not leave the served copy running: stop its process groups and remove the temporary directories.
	const interrupted = (signal, code) => process.once(signal, () => {
		for (const pid of liveProcessGroups) {
			try { process.kill(-pid, 'SIGKILL') }
			catch { /* already gone */ }
		}
		for (const directory of liveDirectories) rmSync(directory, { recursive: true, force: true })
		process.exit(code)
	})
	interrupted('SIGINT', 130)
	interrupted('SIGTERM', 143)
	process.exitCode = await main()
}
