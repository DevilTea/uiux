import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { KIT_BUILD_DECLARATION_READ_ATTEMPTS, KIT_BUILD_DECLARATION_RETRY_DELAY_MS, parseKitBuildDeclaration, readDeclaredKitBuildDeclaration, readKitBuildDeclaration } from '../src/adapters/kit-build-declaration'
import type { KitBuildControl, KitBuildStatus } from '../src/application/ports/kit-build'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { ACCESS_PRESETS_FILENAME, builtInAccessPresetsFile } from '../src/domain/access-presets/schema'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, FileNativePersistence, V5_LAYOUT } from '../src/persistence'
import { PRODUCT_WORKSPACE_SCHEMA_POLICY } from '../src/product/workspace-schema'
import { readKitBuildForHttp, readKitBuildLogForHttp, readProductKitForHttp, restartKitBuildForHttp } from '../src/server/authoring-http'
import { createKitBuildRunner, KIT_BUILD_GENERATION_WARNING, KIT_BUILD_LOG_BYTES, KIT_BUILD_RESTART_INTERVAL_MS, KitBuildLog, kitBuildEnvironment, registerKitBuildRunner, type KitBuildRunner } from '../src/server/kit-build'
import { getSelectedWorkspacePreviewBundle, resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { connectMcp, scoped, testMember } from './support/access'
import { currentManifest, writeManifest } from './support/workspace-layout'

/**
 * The kit build (issue #141, unit K7): Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7 and its Rules,
 * Product Kit Contract Clauses 01a11bb1-86af-…, 01a11bb1-8721-…, 01a11bb1-87ed-…, 01a11bb1-8856-…,
 * 01a11bb1-88ba-… and 01a11bb1-891e-…, MCP Contract Clauses 01a11bb1-b0f1-… and 01a11be8-5b64-…,
 * and the keys of Clauses 01a11bb1-b35a-… and 01a11bb1-b3c2-…. Builds are tiny Node scripts in a
 * temporary current-schema Workspace.
 */

const roots: string[] = []
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/**
 * Replaces a file at once, as an editor's atomic save does: a reader sees the old or the new
 * content, never the empty file `writeFile` leaves between truncating and writing. A capture in
 * progress reads `kit/package.json`, and an empty one makes its resolution invalid.
 */
async function replace(path: string, content: string): Promise<void> {
	const staged = `${path}.${process.pid}.tmp`
	await writeFile(staged, content)
	await rename(staged, path)
}

function adapterModule(id: string): string {
	return `export const manifest = ${JSON.stringify({ id, apiVersion: '1', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [] })}\n`
}

/** Writes `dist/uiux.js` (an Adapter named by `version.txt`), and what the process saw, then exits. */
const BUILD_OK = `
import { mkdirSync, readFileSync, readSync, writeFileSync, existsSync } from 'node:fs'
const version = existsSync('version.txt') ? readFileSync('version.txt', 'utf8').trim() : '1'
let stdinBytes
try { stdinBytes = readSync(0, Buffer.alloc(16), 0, 16, null) } catch (error) { stdinBytes = String(error.code) }
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', ${JSON.stringify(adapterModule('kit-adapter-'))}.replace('kit-adapter-', 'kit-adapter-' + version))
writeFileSync('seen.json', JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv.slice(2), stdinBytes }))
console.log('built version', version)
`

/** Corrupts the output, then fails. */
const BUILD_FAIL = `
import { writeFileSync, mkdirSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', 'throw new Error("half-written output")\\n')
console.error('error TS2304: Cannot find name broken in ' + process.cwd() + '/src/broken.ts')
process.exit(1)
`

/** Writes the output once, then again 1.5 s later, and stays alive like a watcher. */
const WATCH = `
import { mkdirSync, writeFileSync } from 'node:fs'
writeFileSync('watch.pid', String(process.pid))
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', ${JSON.stringify(adapterModule('kit-watch-1'))})
setTimeout(() => writeFileSync('dist/uiux.js', ${JSON.stringify(adapterModule('kit-watch-2'))}), 1500)
setInterval(() => {}, 1000)
`

const HANG = `
import { writeFileSync } from 'node:fs'
writeFileSync('hang.pid', String(process.pid))
setTimeout(() => writeFileSync('late.txt', 'still running'), 4000)
setInterval(() => {}, 1000)
`

const NO_OUTPUT = 'console.log("nothing to build")\n'

type Declaration = Readonly<{ output?: string; build?: Record<string, unknown> }> | undefined

async function kitWorkspace(uiux: unknown, files: Readonly<Record<string, string>> = {}, adapters: ProductKit['adapters'] = [{ moduleSpecifier: './dist/uiux.js' }], at?: string) {
	const root = at ?? await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-build-')))
	if (!at) roots.push(root)
	await mkdir(root, { recursive: true })
	await writeManifest(root, canonicalJsonBytes(currentManifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes({ ...emptyProductKit(), adapters }))
	await writeFile(join(root, ACCESS_PRESETS_FILENAME), canonicalJsonBytes(builtInAccessPresetsFile()))
	await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module', ...(uiux === undefined ? {} : { uiux }) }))
	for (const [path, content] of Object.entries(files)) await write(join(root, 'kit', path), content)
	return root
}

function nodeBuild(script: string, extra: Readonly<Record<string, unknown>> = {}): Declaration {
	return { output: 'dist', build: { command: [process.execPath, script], ...extra } }
}

function runner(root: string, options: Readonly<{ env?: NodeJS.ProcessEnv; register?: boolean; capture?: boolean; captureOutput?: () => Promise<unknown>; captureWaitMs?: number; restartIntervalMs?: number }> = {}) {
	const printed: string[] = []
	const build = createKitBuildRunner({
		root,
		codeDirectoryName: 'kit',
		pollMs: 25,
		killGraceMs: 500,
		print: line => printed.push(line),
		...(options.env ? { env: options.env } : {}),
		// As the selected Workspace runtime does under `uiux dev`.
		...(options.capture ? { captureOutput: () => getSelectedWorkspacePreviewBundle(root, V5_LAYOUT) } : {}),
		...(options.captureOutput ? { captureOutput: options.captureOutput } : {}),
		...(options.captureWaitMs !== undefined ? { captureWaitMs: options.captureWaitMs } : {}),
		...(options.restartIntervalMs !== undefined ? { restartIntervalMs: options.restartIntervalMs } : {}),
	})
	const unregister = options.register ? registerKitBuildRunner(root, build) : () => {}
	cleanups.push(async () => {
		unregister()
		await build.stop()
	})
	return { build, printed }
}

async function waitFor<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
	const deadline = Date.now() + timeoutMs
	for (;;) {
		const value = await read()
		if (accept(value)) return value
		if (Date.now() > deadline) throw new Error(`waitFor timed out; last value ${JSON.stringify(value)}`)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 25))
	}
}

const settledState = (build: KitBuildRunner) => waitFor(() => build.status(), status => status.state === 'ready' || status.state === 'failed')

function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	}
	catch {
		return false
	}
}

describe('the kit build declaration (Clause 01a11bb1-86af)', () => {
	it('reads { output, build: { command, watch?, timeoutSeconds? } } with a 300 s default timeout', () => {
		expect(parseKitBuildDeclaration({ uiux: { output: './dist/', build: { command: ['vite', 'build'], watch: ['vite', 'build', '--watch'] } } })).toEqual({
			state: 'declared',
			declaration: { output: 'dist', command: ['vite', 'build'], watch: ['vite', 'build', '--watch'], timeoutSeconds: 300 },
		})
		expect(parseKitBuildDeclaration({ name: 'kit' })).toEqual({ state: 'none' })
	})

	it.each([
		['a shell string command', { output: 'dist', build: { command: 'vite build && rm -rf /' } }],
		['an empty command', { output: 'dist', build: { command: [] } }],
		['a command with an empty executable', { output: 'dist', build: { command: [''] } }],
		['a non-string argument', { output: 'dist', build: { command: ['node', 1] } }],
		['a shell string watch', { output: 'dist', build: { command: ['node'], watch: 'node --watch' } }],
		['a timeout of 0', { output: 'dist', build: { command: ['node'], timeoutSeconds: 0 } }],
		['a timeout above 3600', { output: 'dist', build: { command: ['node'], timeoutSeconds: 3601 } }],
		['a fractional timeout', { output: 'dist', build: { command: ['node'], timeoutSeconds: 1.5 } }],
		['an output escaping kit/', { output: '../dist', build: { command: ['node'] } }],
		['an absolute output', { output: '/tmp/dist', build: { command: ['node'] } }],
		['an output in kit/node_modules/', { output: 'node_modules/x', build: { command: ['node'] } }],
		['no build', { output: 'dist' }],
		['an unknown member', { output: 'dist', build: { command: ['node'] }, shell: true }],
		['an unknown build member', { output: 'dist', build: { command: ['node'], env: { X: '1' } } }],
	])('refuses %s', (_label, uiux) => {
		expect(parseKitBuildDeclaration({ uiux })).toMatchObject({ state: 'invalid' })
	})

	it('declares nothing without kit/package.json and refuses a package file that is a link', async () => {
		const root = await kitWorkspace(undefined)
		await rm(join(root, 'kit', 'package.json'))
		expect(await readKitBuildDeclaration(join(root, 'kit'))).toEqual({ state: 'none' })
		const { symlink } = await import('node:fs/promises')
		await write(join(root, 'elsewhere.json'), JSON.stringify({ uiux: nodeBuild('build.mjs') }))
		await symlink(join(root, 'elsewhere.json'), join(root, 'kit', 'package.json'))
		expect(await readKitBuildDeclaration(join(root, 'kit'))).toMatchObject({ state: 'invalid' })
	})

	it('reads a declared build\'s kit/package.json again while it is half-written, a bounded number of times', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'))
		const packagePath = join(root, 'kit', 'package.json')
		await writeFile(packagePath, '')
		const reading = readDeclaredKitBuildDeclaration(join(root, 'kit'))
		await new Promise(resolve => setTimeout(resolve, KIT_BUILD_DECLARATION_RETRY_DELAY_MS / 2))
		await writeFile(packagePath, JSON.stringify({ name: 'kit', uiux: nodeBuild('build.mjs') }))
		expect(await reading).toMatchObject({ state: 'declared', declaration: { output: 'dist' } })

		// A file that stays unreadable keeps its message once the reads are spent.
		await writeFile(packagePath, '{"name": "ki')
		const started = Date.now()
		expect(await readDeclaredKitBuildDeclaration(join(root, 'kit'))).toEqual({ state: 'invalid', message: 'kit/package.json could not be read as JSON.' })
		expect(Date.now() - started).toBeGreaterThanOrEqual((KIT_BUILD_DECLARATION_READ_ATTEMPTS - 1) * KIT_BUILD_DECLARATION_RETRY_DELAY_MS - 10)
		await rm(packagePath)
		expect(await readDeclaredKitBuildDeclaration(join(root, 'kit'))).toEqual({ state: 'none' })
	})
})

describe('the build process environment (Clause 01a11bb1-88ba)', () => {
	it('drops every UIUX_INTERNAL_* variable and puts only the node_modules/.bin of kit/ and of the Workspace root first on PATH', () => {
		const env = kitBuildEnvironment({ UIUX_INTERNAL_DEV_NETWORK: 'handoff', uiux_internal_lower: 'x', UIUX_HOME: '/h', KEEP: '1', PATH: '/usr/bin' }, '/w/.uiux/kit', '/w/.uiux')
		expect(Object.keys(env).some(name => name.toUpperCase().startsWith('UIUX_INTERNAL_'))).toBe(false)
		expect(env).toMatchObject({ UIUX_HOME: '/h', KEEP: '1' })
		// No ancestor of the Workspace root (owner ruling 1 of 2026-10-12).
		expect(env.PATH!.split(delimiter)).toEqual(['/w/.uiux/kit/node_modules/.bin', '/w/.uiux/node_modules/.bin', '/usr/bin'])
	})

	it('drops UIUX_MCP_TOKEN, in any case, from the build environment', () => {
		const env = kitBuildEnvironment({ UIUX_MCP_TOKEN: 'uiux_agent_token_value', uiux_mcp_token: 'lower-case-token', UIUX_HOME: '/h', PATH: '/usr/bin' }, '/w/.uiux/kit', '/w/.uiux')
		expect(Object.keys(env).sort()).toEqual(['PATH', 'UIUX_HOME'])
	})

	it('masks the secrets of the build environment and of the server environment, 8 characters or longer, in the build log', async () => {
		const leaky = `
import { mkdirSync, writeFileSync } from 'node:fs'
console.log('api key=' + process.env.MY_API_KEY)
console.log('db password=' + process.env.db_password)
console.log('short token=' + process.env.SHORT_TOKEN)
console.log('plain=' + process.env.PLAIN_SETTING)
console.log('mcp token=' + process.env.UIUX_MCP_TOKEN)
console.log('server secret=server-own-secret-value-42')
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', 'export {}\\n')
`
		const root = await kitWorkspace(nodeBuild('leaky.mjs'), { 'leaky.mjs': leaky })
		// A secret only in the server's own environment, not in the build's.
		process.env.KIT_BUILD_TEST_SERVER_SECRET = 'server-own-secret-value-42'
		cleanups.push(() => { delete process.env.KIT_BUILD_TEST_SERVER_SECRET })
		const { build } = runner(root, { env: { PATH: process.env.PATH, MY_API_KEY: 'sk-live-0123456789', db_password: 'hunter2hunter2', SHORT_TOKEN: 'abc1234', PLAIN_SETTING: 'visible-setting-value', UIUX_MCP_TOKEN: 'uiux_mcp_token_value' } })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const log = build.log()
		expect(log).toContain('api key=<secret>')
		expect(log).toContain('db password=<secret>')
		expect(log).toContain('server secret=<secret>')
		// Under 8 characters, or a name that names no secret, stays as written.
		expect(log).toContain('short token=abc1234')
		expect(log).toContain('plain=visible-setting-value')
		// The Agent Token never reaches the build.
		expect(log).toContain('mcp token=undefined')
		for (const value of ['sk-live-0123456789', 'hunter2hunter2', 'server-own-secret-value-42', 'uiux_mcp_token_value']) expect(log).not.toContain(value)
	})

	it('never runs a node planted in the node_modules/.bin of an ancestor of the Workspace root', async () => {
		const outer = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-build-outer-')))
		roots.push(outer)
		const marker = join(outer, 'planted-ran')
		for (const bin of [join(outer, 'node_modules', '.bin'), join(outer, 'project', 'node_modules', '.bin')]) {
			await write(join(bin, 'node'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`)
			await chmod(join(bin, 'node'), 0o755)
		}
		const root = join(outer, 'project', '.uiux')
		await kitWorkspace({ output: 'dist', build: { command: ['node', 'build.mjs'] } }, { 'build.mjs': BUILD_OK }, undefined, root)
		// The real node is found on the inherited PATH, after kit/ and the Workspace root.
		const { build } = runner(root, { env: { ...process.env, PATH: [dirname(process.execPath), process.env.PATH ?? ''].join(delimiter) } })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(existsSync(marker)).toBe(false)
		const seen = JSON.parse(await readFile(join(root, 'kit', 'seen.json'), 'utf8'))
		expect(seen.env.PATH.split(delimiter).slice(0, 3)).toEqual([join(root, 'kit', 'node_modules', '.bin'), join(root, 'node_modules', '.bin'), dirname(process.execPath)])
	})

	it('runs the build in the real kit/ directory with that environment and standard input closed', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const { build } = runner(root, { env: { ...process.env, UIUX_INTERNAL_DEV_NETWORK: 'secret-handoff', UIUX_INTERNAL_OTHER: 'x', KIT_BUILD_TEST_KEEP: 'kept' } })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const seen = JSON.parse(await readFile(join(root, 'kit', 'seen.json'), 'utf8'))
		expect(Object.keys(seen.env).filter((name: string) => name.startsWith('UIUX_INTERNAL_'))).toEqual([])
		expect(JSON.stringify(seen.env)).not.toContain('secret-handoff')
		expect(seen.env.KIT_BUILD_TEST_KEEP).toBe('kept')
		expect(seen.env.PATH.split(delimiter)[0]).toBe(join(root, 'kit', 'node_modules', '.bin'))
		expect(seen.cwd).toBe(join(root, 'kit'))
		expect(seen.stdinBytes).toBe(0)
	})
})

describe('the kit build runner (Feature 01a11bb1-8534)', () => {
	it('prints the argument array, runs the command once, and is ready once the output settled (Rules 01a11bb1-a05b and 01a11bb1-9d90, Clauses 01a11bb1-87ed and 01a11bb1-8856)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const { build, printed } = runner(root)
		const started = await build.start()
		expect(started.state).toBe('building')
		expect(printed[0]).toBe(`uiux: kit build: running ${JSON.stringify([process.execPath, 'build.mjs'])} in kit/`)
		const startedAt = Date.now()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		// Settled means 500 ms without a change in the output directory.
		expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500)
		expect(build.outputGeneration()).toBe(1)
		expect(build.log()).toContain('built version 1')
	})

	it('passes shell metacharacters in the argument array literally, running no shell', async () => {
		const root = await kitWorkspace({ output: 'dist', build: { command: [process.execPath, 'build.mjs', '$(touch pwned)', ';touch x', '`touch y`', '&& touch z'] } }, { 'build.mjs': BUILD_OK })
		const { build } = runner(root)
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const seen = JSON.parse(await readFile(join(root, 'kit', 'seen.json'), 'utf8'))
		expect(seen.argv).toEqual(['$(touch pwned)', ';touch x', '`touch y`', '&& touch z'])
		for (const name of ['pwned', 'x', 'y', 'z', 'touch']) {
			expect(existsSync(join(root, 'kit', name))).toBe(false)
			expect(existsSync(join(root, name))).toBe(false)
		}
	})

	it('is none and spawns nothing when kit/ is a symbolic link', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const { symlink } = await import('node:fs/promises')
		await rename(join(root, 'kit'), join(root, 'kit-real'))
		await symlink(join(root, 'kit-real'), join(root, 'kit'))
		const { build, printed } = runner(root)
		expect(await build.start()).toEqual({ state: 'none' })
		expect(build.status()).toEqual({ state: 'none' })
		expect(printed).toEqual([])
		await new Promise(resolveDelay => setTimeout(resolveDelay, 300))
		expect(existsSync(join(root, 'kit-real', 'seen.json'))).toBe(false)
		expect(existsSync(join(root, 'kit-real', 'dist'))).toBe(false)
	})

	it('is none and runs nothing when kit/package.json declares no build', async () => {
		const root = await kitWorkspace(undefined)
		const { build, printed } = runner(root)
		expect(await build.start()).toEqual({ state: 'none' })
		expect(printed).toEqual([])
	})

	it('fails without running anything when the declaration is malformed', async () => {
		const root = await kitWorkspace({ output: 'dist', build: { command: 'node build.mjs' } }, { 'build.mjs': BUILD_OK })
		const { build, printed } = runner(root)
		expect(await build.start()).toMatchObject({ state: 'failed', message: expect.stringContaining('never a shell string') })
		expect(printed.some(line => line.includes('running'))).toBe(false)
		expect(existsSync(join(root, 'kit', 'seen.json'))).toBe(false)
	})

	it('fails a build that exits with an error, keeping its log', async () => {
		const root = await kitWorkspace(nodeBuild('fail.mjs'), { 'fail.mjs': BUILD_FAIL })
		const { build } = runner(root)
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'failed', message: 'The build process exited with code 1.' })
		expect(build.outputGeneration()).toBeUndefined()
		expect(build.log()).toContain('error TS2304')
	})

	it('fails a build that exits cleanly without output', async () => {
		const root = await kitWorkspace(nodeBuild('none.mjs'), { 'none.mjs': NO_OUTPUT })
		const { build } = runner(root)
		await build.start()
		expect(await settledState(build)).toMatchObject({ state: 'failed', message: expect.stringContaining('produced no output in kit/dist/') })
	})

	it('stops and fails a run that exceeds its timeout (Rule 01a11bb1-9f91)', async () => {
		const root = await kitWorkspace(nodeBuild('hang.mjs', { timeoutSeconds: 1 }), { 'hang.mjs': HANG })
		const { build } = runner(root)
		await build.start()
		const pid = Number(await waitFor(() => readFile(join(root, 'kit', 'hang.pid'), 'utf8').catch(() => ''), text => text !== ''))
		expect(await settledState(build)).toEqual({ state: 'failed', message: 'The build timed out after 1 s and was stopped.' })
		await waitFor(() => processAlive(pid), alive => !alive)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 3500))
		expect(existsSync(join(root, 'kit', 'late.txt'))).toBe(false)
	}, 20_000)

	it('applies the timeout to a watch build only until its first settled output (Rule 01a11bb1-9f91)', async () => {
		const lateWatch = `
import { mkdirSync, writeFileSync } from 'node:fs'
setTimeout(() => {
	mkdirSync('dist', { recursive: true })
	writeFileSync('dist/uiux.js', 'export {}\\n')
}, 100)
setInterval(() => {}, 1000)
`
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'late-watch.mjs'], timeoutSeconds: 1 }), { 'build.mjs': BUILD_OK, 'late-watch.mjs': lateWatch })
		const { build } = runner(root)
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		// Well past the 1 s timeout, the watch process runs on and its output stays ready.
		await new Promise(resolveDelay => setTimeout(resolveDelay, 1500))
		expect(build.status()).toEqual({ state: 'ready' })
	})

	it('makes a watch build ready only after its output changes, so an output left from before the start is not taken (Rule 01a12f9d-a14e)', async () => {
		const idleWatch = `
import { writeFileSync } from 'node:fs'
writeFileSync('idle.pid', String(process.pid))
setInterval(() => {}, 1000)
`
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'idle-watch.mjs'], timeoutSeconds: 1 }), { 'build.mjs': BUILD_OK, 'idle-watch.mjs': idleWatch, 'dist/uiux.js': adapterModule('stale-output') })
		const { build } = runner(root)
		await build.start()
		// The stale output is quiet for well over 500 ms, yet the build is not ready; the timeout fails it.
		await new Promise(resolveDelay => setTimeout(resolveDelay, 700))
		expect(build.status()).toEqual({ state: 'building' })
		expect(await settledState(build)).toEqual({ state: 'failed', message: 'The watch command produced no settled output within 1 s and was stopped.' })
		const pid = Number(await readFile(join(root, 'kit', 'idle.pid'), 'utf8'))
		await waitFor(() => processAlive(pid), alive => !alive)
	})

	it('runs the watch command, not the build command, and settles each rebuild (Rule 01a11bb1-9d90)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'watch.mjs'] }), { 'build.mjs': BUILD_OK, 'watch.mjs': WATCH })
		const { build, printed } = runner(root)
		await build.start()
		expect(printed[0]).toContain(JSON.stringify([process.execPath, 'watch.mjs']))
		await waitFor(() => build.outputGeneration(), generation => generation === 2)
		expect(build.status()).toEqual({ state: 'ready' })
		expect(existsSync(join(root, 'kit', 'seen.json'))).toBe(false)
	})

	it('keeps only the last 256 KiB of output, in memory, and masks host paths when read (Clause 01a11bb1-891e)', async () => {
		const noisy = `
import { mkdirSync, writeFileSync } from 'node:fs'
process.stdout.write('x'.repeat(300 * 1024) + '\\n')
console.log('compiled ' + process.cwd() + '/src/button.ts')
console.log('linked /opt/secret/host/file.js')
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', 'export {}\\n')
`
		const root = await kitWorkspace(nodeBuild('noisy.mjs'), { 'noisy.mjs': noisy })
		const { build } = runner(root)
		await build.start()
		await settledState(build)
		const log = build.log()
		expect(Buffer.byteLength(log)).toBeLessThanOrEqual(KIT_BUILD_LOG_BYTES)
		expect(log).toContain('compiled <workspace>/kit/src/button.ts')
		expect(log).toContain('linked <path>')
		expect(log).not.toContain(root)
		expect(log).not.toContain('/opt/secret')
	})

	it.skipIf(process.platform === 'win32')('kills the process group once as the build exits, and never signals it after that', async () => {
		const leaving = `
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
const straggler = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync('straggler.pid', String(straggler.pid))
straggler.unref()
mkdirSync('dist', { recursive: true })
writeFileSync('dist/uiux.js', 'export {}\\n')
`
		const root = await kitWorkspace(nodeBuild('leaving.mjs'), { 'leaving.mjs': leaving })
		const kill = vi.spyOn(process, 'kill')
		cleanups.push(() => kill.mockRestore())
		const groupSignals = () => kill.mock.calls.filter(([pid]) => typeof pid === 'number' && pid < 0)
		const { build } = runner(root)
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const straggler = Number(await readFile(join(root, 'kit', 'straggler.pid'), 'utf8'))
		// What the build left running dies with its group.
		await waitFor(() => processAlive(straggler), alive => !alive)
		expect(groupSignals()).toEqual([[expect.any(Number), 'SIGKILL']])
		// The group's ID may be reused by now, so neither stop signals it again.
		await build.stop()
		build.stopSync()
		expect(groupSignals()).toHaveLength(1)
	})

	it('keeps a ring of the last bytes written', () => {
		const ring = new KitBuildLog(8)
		ring.write('abcdef')
		ring.write('ghij')
		expect(ring.text()).toBe('cdefghij')
		ring.write('0123456789')
		expect(ring.text()).toBe('23456789')
		expect(ring.byteLength()).toBe(8)
	})

	it('restarts: stops the running process and starts the declared build again, read anew (Clause 01a11be8-5b64)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'watch.mjs'] }), { 'build.mjs': BUILD_OK, 'watch.mjs': WATCH })
		const { build, printed } = runner(root)
		await build.start()
		const first = Number(await waitFor(() => readFile(join(root, 'kit', 'watch.pid'), 'utf8').catch(() => ''), text => text !== ''))
		await waitFor(() => build.status().state, state => state === 'ready')

		// The host edits kit/package.json; a restart reads it anew.
		await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('build.mjs') }))
		await write(join(root, 'kit', 'version.txt'), '7')
		const restarted = await build.restart()
		expect(restarted).toEqual({ outcome: 'started', build: { state: 'building' } })
		expect(processAlive(first)).toBe(false)
		expect(printed.at(-1)).toContain(JSON.stringify([process.execPath, 'build.mjs']))
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('kit-adapter-7')
	})

	it('shares a queued restart with a second request and refuses a restart within 2 s of the previous one (Rule 01a12f9a-f31e, Clause 01a12f9a-ef7c)', async () => {
		expect(KIT_BUILD_RESTART_INTERVAL_MS).toBe(2000)
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'watch.mjs'] }), { 'build.mjs': BUILD_OK, 'watch.mjs': WATCH })
		const { build, printed } = runner(root)
		const runs = () => printed.filter(line => line.includes('kit build: running')).length
		await build.start()
		await waitFor(() => build.status().state, state => state === 'ready')
		expect(runs()).toBe(1)

		const first = build.restart()
		const second = build.restart()
		expect(second).toBe(first)
		expect(await first).toEqual({ outcome: 'started', build: { state: 'building' } })
		expect(runs()).toBe(2)

		const early = await build.restart()
		expect(early).toMatchObject({ outcome: 'throttled', retryAfterMs: expect.any(Number) })
		const wait = early.outcome === 'throttled' ? early.retryAfterMs : 0
		expect(wait).toBeGreaterThan(0)
		expect(wait).toBeLessThanOrEqual(KIT_BUILD_RESTART_INTERVAL_MS)
		expect(runs()).toBe(2)
		await new Promise(resolveDelay => setTimeout(resolveDelay, wait + 50))
		expect(await build.restart()).toMatchObject({ outcome: 'started' })
		expect(runs()).toBe(3)
	}, 20_000)

	it('prints a warning once the output generations pass the threshold', async () => {
		expect(KIT_BUILD_GENERATION_WARNING).toBe(50)
		const rebuilding = `
import { mkdirSync, writeFileSync } from 'node:fs'
mkdirSync('dist', { recursive: true })
let round = 0
const timer = setInterval(() => {
	writeFileSync('dist/uiux.js', 'export const round = ' + round + '\\n')
	if (++round >= 8) clearInterval(timer)
}, 150)
setInterval(() => {}, 1000)
`
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'rebuilding.mjs'] }), { 'build.mjs': BUILD_OK, 'rebuilding.mjs': rebuilding })
		const printed: string[] = []
		const build = createKitBuildRunner({ root, codeDirectoryName: 'kit', pollMs: 5, settleMs: 40, killGraceMs: 500, generationWarning: 2, print: line => printed.push(line) })
		cleanups.push(() => build.stop())
		await build.start()
		await waitFor(() => build.outputGeneration() ?? 0, generation => generation >= 5)
		const warnings = printed.filter(line => line.startsWith('uiux: warning:'))
		expect(warnings).toEqual([expect.stringContaining('more than 2 outputs')])
	})
})

describe('settled output and the Adapters (Rules 01a11bb1-9df8, 01a11bb1-9e5e and 01a11bb1-9ec6, Clause 01a11bb1-8721)', () => {
	it('resolves the Adapters anew for each settled output without a server restart', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs', { watch: [process.execPath, 'watch.mjs'] }), { 'build.mjs': BUILD_OK, 'watch.mjs': WATCH })
		const { build } = runner(root, { register: true })
		await build.start()
		await waitFor(() => build.outputGeneration(), generation => generation === 1)
		const first = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(first.state, JSON.stringify(first.diagnostics)).toBe('valid')
		expect(first.summaries[0]?.adapterId).toBe('kit-watch-1')
		await waitFor(() => build.outputGeneration(), generation => generation === 2)
		const second = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(second.summaries[0]?.adapterId).toBe('kit-watch-2')
	})

	it('keeps using the last good output, Adapters and Preview bundle after a failed build', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		const { build } = runner(root, { register: true })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const good = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(good.summaries[0]?.adapterId).toBe('kit-adapter-1')
		const goodBundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(goodBundle.state).toBe('valid')

		await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))
		await build.restart()
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')

		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after).toBe(good)
		const afterBundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(afterBundle).toMatchObject({ state: 'valid', hash: (goodBundle as { hash: string }).hash })
	}, 30_000)

	it('captures each settled output at once, so a failed restart before any request still leaves the last good output in use', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		const { build } = runner(root, { register: true, capture: true })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })

		// No request resolves the good output before the failing build runs. The capture may still be
		// reading kit/package.json, so the declaration is replaced at once.
		await replace(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))
		await build.restart()
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')

		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after.state, JSON.stringify(after.diagnostics)).toBe('valid')
		expect(after.summaries[0]?.adapterId).toBe('kit-adapter-1')
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle.state).toBe('valid')
		expect((bundle as { bundleJs: string }).bundleJs).toContain('kit-adapter-1')
		expect((bundle as { bundleJs: string }).bundleJs).not.toContain('half-written output')
	}, 30_000)

	it('keeps the captured output in use when kit/package.json is replaced while the capture runs', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		let replaced = false
		// The declaration of the failing build replaces the old one after the capture of generation 1 began, before it ends.
		const captureOutput = vi.fn(async () => {
			const capturing = getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
			if (!replaced) {
				replaced = true
				await replace(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))
			}
			return capturing
		})
		const { build } = runner(root, { register: true, captureOutput })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(captureOutput).toHaveBeenCalledTimes(1)
		// The restart reads the declaration before it waits for the capture, so the replacement ends first.
		await captureOutput.mock.results[0]!.value

		await build.restart()
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')
		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after.state, JSON.stringify(after.diagnostics)).toBe('valid')
		expect(after.summaries[0]?.adapterId).toBe('kit-adapter-1')
	}, 30_000)

	it('reads kit/package.json again when the capture finds it half-written by a non-atomic host write (issue #214)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		const packagePath = join(root, 'kit', 'package.json')
		let rewritten = false
		// The capture of generation 1 starts while the host is in the middle of rewriting the declaration in place.
		const captureOutput = vi.fn(async () => {
			if (rewritten) return getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
			rewritten = true
			await writeFile(packagePath, '{"name": "ki')
			const capturing = getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
			await new Promise(resolve => setTimeout(resolve, KIT_BUILD_DECLARATION_RETRY_DELAY_MS / 2))
			await writeFile(packagePath, JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))
			return capturing
		})
		const { build } = runner(root, { register: true, captureOutput })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(captureOutput).toHaveBeenCalledTimes(1)
		const captured = await captureOutput.mock.results[0]!.value
		expect(captured.state, JSON.stringify(captured.diagnostics)).toBe('valid')

		await build.restart()
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')
		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after.state, JSON.stringify(after.diagnostics)).toBe('valid')
		expect(after.summaries[0]?.adapterId).toBe('kit-adapter-1')
	}, 30_000)

	it('keeps using the last good output after a restart of the server whose new build fails', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		const before = runner(root, { register: true, capture: true })
		await before.build.start()
		expect(await settledState(before.build)).toEqual({ state: 'ready' })
		// The server stops; the host breaks the kit; `uiux dev` starts again with a new runner.
		await cleanups.pop()!()
		await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))

		const { build } = runner(root, { register: true, capture: true })
		await build.start()
		expect(build.outputGeneration()).toBe(0)
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')

		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after.state, JSON.stringify(after.diagnostics)).toBe('valid')
		expect(after.summaries[0]?.adapterId).toBe('kit-adapter-1')
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle.state).toBe('valid')
		expect((bundle as { bundleJs: string }).bundleJs).toContain('kit-adapter-1')
		expect((bundle as { bundleJs: string }).bundleJs).not.toContain('half-written output')
	}, 30_000)

	it('spawns the build only once the capture of the output found at the start has finished', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'dist/uiux.js': adapterModule('kit-adapter-old') })
		let finishCapture!: () => void
		const captureOutput = vi.fn(() => new Promise<void>(resolveCapture => {
			finishCapture = resolveCapture
		}))
		const { build, printed } = runner(root, { captureOutput })
		// The runner prints the argument array right before it spawns, so the lines count the spawns.
		const spawns = () => printed.filter(line => line.includes('kit build: running')).length
		let begun = false
		const started = build.start().then(status => {
			begun = true
			return status
		})
		// The capture starts after the output is listed; from there to the spawn the run awaits only the capture.
		await waitFor(() => captureOutput.mock.calls.length, calls => calls === 1)
		expect(build.status()).toEqual({ state: 'building' })
		expect(spawns()).toBe(0)
		expect(begun).toBe(false)
		finishCapture()
		await started
		expect(spawns()).toBe(1)
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(build.outputGeneration()).toBe(1)
	}, 30_000)

	it('abandons a capture of the output found at the start that exceeds the wait, so the build starts with no last good output', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'dist/uiux.js': adapterModule('kit-adapter-old') })
		const captureOutput = vi.fn(() => new Promise<void>(() => {}))
		const { build, printed } = runner(root, { captureOutput, captureWaitMs: 200 })
		await build.start()
		expect(captureOutput).toHaveBeenCalledTimes(1)
		expect(printed.some(line => line.includes('was abandoned'))).toBe(true)
		// The capture still runs, but its generation is not the last good output.
		expect(build.outputGeneration()).toBeUndefined()
		expect(build.outputVersion()).toBeUndefined()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(build.outputGeneration()).toBe(1)
		expect(captureOutput).toHaveBeenCalledTimes(2)
	}, 30_000)

	it('stops at once, spawning nothing, while the capture of the output found at the start is in progress', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'dist/uiux.js': adapterModule('kit-adapter-old') })
		const captureOutput = vi.fn(() => new Promise<void>(() => {}))
		// A wait far past the test timeout: only the stop request can end it.
		const { build, printed } = runner(root, { captureOutput, captureWaitMs: 60 * 60_000 })
		const started = build.start()
		await waitFor(() => captureOutput.mock.calls.length, calls => calls === 1)
		await build.stop()
		await started
		// The run has returned without printing the argument array, which it prints right before it spawns.
		expect(printed.some(line => line.includes('kit build: running'))).toBe(false)
		expect(printed.some(line => line.includes('was abandoned'))).toBe(false)
		expect(build.outputGeneration()).toBe(0)
	})

	it('keeps the previous output as the last good output when a later capture is abandoned (Rule 01a11bb1-9e5e)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'fail.mjs': BUILD_FAIL })
		let hang = false
		const captureOutput = vi.fn(() => hang ? new Promise<void>(() => {}) : getSelectedWorkspacePreviewBundle(root, V5_LAYOUT))
		const { build, printed } = runner(root, { register: true, captureOutput, captureWaitMs: 200, restartIntervalMs: 0 })
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(build.outputGeneration()).toBe(1)
		await captureOutput.mock.results[0]!.value
		const good = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(good.summaries[0]?.adapterId).toBe('kit-adapter-1')

		// Generation 2 settles, but its capture never finishes.
		hang = true
		await write(join(root, 'kit', 'version.txt'), '2')
		expect(await build.restart()).toMatchObject({ outcome: 'started' })
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(build.outputGeneration()).toBe(2)

		// The next restart abandons that capture: generation 1 is the last good output again.
		await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', type: 'module', uiux: nodeBuild('fail.mjs') }))
		expect(await build.restart()).toMatchObject({ outcome: 'started' })
		expect(printed.some(line => line.includes('was abandoned; the build starts with the previous output as the last good output'))).toBe(true)
		expect(build.outputGeneration()).toBe(1)
		expect(await settledState(build)).toMatchObject({ state: 'failed' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('half-written output')

		const after = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(after).toBe(good)
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle.state).toBe('valid')
		expect((bundle as { bundleJs: string }).bundleJs).toContain('kit-adapter-1')
		expect((bundle as { bundleJs: string }).bundleJs).not.toContain('half-written output')
	}, 30_000)

	it('starts nothing for a restart queued before a stop, and reports it stopped', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const { build, printed } = runner(root, { restartIntervalMs: 0 })
		const spawns = () => printed.filter(line => line.includes('kit build: running')).length
		await build.start()
		expect(await settledState(build)).toEqual({ state: 'ready' })
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const app = createWorkspaceApplicationSession(persistence, { kitBuild: build })

		const restarted = build.restart()
		const stopped = build.stop()
		expect(await restarted).toEqual({ outcome: 'stopped' })
		await stopped
		const refused = app.restartKitBuild()
		await build.stop()
		expect(await refused).toMatchObject({ status: 'blocked', code: 'kit.build_unavailable' })
		expect(spawns()).toBe(1)
	})

	it('makes the Adapter set invalid while no build output exists', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const resolution = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(resolution).toMatchObject({ state: 'invalid', diagnostics: [expect.objectContaining({ code: 'kit.build_output_missing' })] })
		expect(resolution.diagnostics[0]?.message).not.toContain(root)
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle.state).toBe('invalid')
		expect((await app.readProductKit())?.build).toEqual({ state: 'none' })
	})

	it('requires a ./ Adapter in the build output when a build is declared, in resolution and in compose_product_kit', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK, 'uiux.js': adapterModule('plain') }, [{ moduleSpecifier: './uiux.js' }])
		await write(join(root, 'kit', 'dist', 'uiux.js'), adapterModule('built'))
		expect(await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)).toMatchObject({ state: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.adapter_outside_build_output', path: '/adapters/0/moduleSpecifier' })] })

		// A composition that adds a ./ Adapter outside the output is refused, one inside it stored.
		await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes(emptyProductKit()))
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		const revision = (await app.readProductKit())!.revision
		const refused = await app.composeProductKit({ expectedRevision: revision, designSystems: [], adapters: ['./uiux.js'] })
		expect(refused).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.adapter_outside_build_output' })] })
		const composed = await app.composeProductKit({ expectedRevision: revision, designSystems: [], adapters: ['./dist/uiux.js'] })
		expect(composed).toMatchObject({ status: 'updated' })
	})

	it('requires a ./ style in the build output when a build is declared, in the Preview bundle and in update_product_kit (Clause 01a11bb1-8e98)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), {
			'build.mjs': BUILD_OK,
			'dist/uiux.js': adapterModule('built'),
			'dist/kit.css': '.kit-built { color: red; }\n',
			'src/kit.css': '.kit-source { color: blue; }\n',
		}, [{ moduleSpecifier: './dist/uiux.js' }])
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		const revision = (await app.readProductKit())!.revision
		const refused = await app.updateProductKit({ expectedRevision: revision, adapters: [{ moduleSpecifier: './dist/uiux.js' }], styles: ['./src/kit.css'], themes: {} })
		expect(refused).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.style_outside_build_output', path: '/styles/0' })] })
		const updated = await app.updateProductKit({ expectedRevision: revision, adapters: [{ moduleSpecifier: './dist/uiux.js' }], styles: ['./dist/kit.css'], themes: {} })
		expect(updated).toMatchObject({ status: 'updated' })
		const bundle = await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)
		expect(bundle).toMatchObject({ state: 'valid', stylesheet: 'runtime.css' })
		if (bundle.state === 'valid') expect(new TextDecoder().decode(bundle.files.get('runtime.css')!.contents)).toContain('.kit-built')

		// A file that names a style outside the output anyway makes the Preview invalid.
		const kitFile = JSON.parse(await readFile(join(root, 'product-kit.json'), 'utf8')) as Record<string, unknown>
		await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes({ ...kitFile, styles: ['./src/kit.css'] }))
		expect(await getSelectedWorkspacePreviewBundle(root, V5_LAYOUT)).toMatchObject({ state: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.style_outside_build_output', path: '/styles/0' })] })
	})

	it('takes the wrapper entry from the build output: a component importing it is flagged (Clause 01a11bb1-89e2)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), {
			'build.mjs': BUILD_OK,
			'dist/uiux.js': adapterModule('built'),
			'src/card.ts': 'import \'../dist/uiux.js\'\nexport const card = 1\n',
		})
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY }))
		const updated = await app.updateComponentRegistry({ expectedRevision: (await app.readProductKit())!.revision, components: { card: { files: ['src/card.ts'], layer: 'product' } }, widgets: {} })
		expect(updated).toMatchObject({ status: 'updated', findings: [expect.objectContaining({ code: 'kit.component_invalid', message: expect.stringContaining('kit/dist/uiux.js, a wrapper entry') })] })
	})
})

type StubControl = KitBuildControl & { restarts: number; current: KitBuildStatus; throttled?: boolean }

function stubControl(state: KitBuildStatus['state']): StubControl {
	const control: StubControl = {
		restarts: 0,
		current: { state },
		status: () => control.current,
		async restart() {
			if (control.throttled) return { outcome: 'throttled', retryAfterMs: 1200 }
			control.restarts++
			control.current = { state: 'building' }
			return { outcome: 'started', build: control.current }
		},
		log: () => 'error in <workspace>/kit/src/x.ts',
	}
	return control
}

async function sessionWith(control: KitBuildControl | undefined) {
	const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
	const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
	return { root, app: createWorkspaceApplicationSession(persistence, control ? { kitBuild: control } : {}) }
}

const EDITOR_AGENT = testMember({ nickname: 'claude', kind: 'agent', preset: 'editor', credential: 'token' })
const READER_AGENT = testMember({ nickname: 'reader', kind: 'agent', credential: 'token', keys: ['workspace.read', 'product-kit.source.read'] })
const BARE_READER = testMember({ nickname: 'bare', kind: 'human', credential: 'session', keys: ['workspace.read'] })

describe('restart_kit_build and the build state over MCP and HTTP (Clauses 01a11be8-5b64, 01a11bb1-b0f1, 01a11bb1-b35a and 01a11bb1-b3c2)', () => {
	it('restarts with product-kit.write and refuses without it, naming the key and starting nothing', async () => {
		const control = stubControl('failed')
		const { app } = await sessionWith(control)
		const refusedMcp = await connectMcp(app, READER_AGENT)
		try {
			const refused = await refusedMcp.client.callTool({ name: 'restart_kit_build', arguments: {} })
			expect(refused.isError).toBe(true)
			expect(refused.structuredContent).toMatchObject({ status: 'blocked', code: 'auth.scope_denied', requiredKeys: ['product-kit.write'] })
		}
		finally { await refusedMcp.close() }
		const refusedHttp = await restartKitBuildForHttp(scoped(app, BARE_READER))
		expect(refusedHttp).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.write'] } })
		expect(control.restarts).toBe(0)

		const mcp = await connectMcp(app, EDITOR_AGENT)
		try {
			const restarted = await mcp.client.callTool({ name: 'restart_kit_build', arguments: {} })
			expect(restarted.isError, JSON.stringify(restarted.structuredContent)).not.toBe(true)
			expect(restarted.structuredContent).toMatchObject({ status: 'restarted', key: 'product-kit', build: { state: 'building' }, resourceUri: 'uiux://product-kit' })
		}
		finally { await mcp.close() }
		expect(control.restarts).toBe(1)
	})

	it('takes no command or argument from the caller (Rule 01a11bb1-9d17)', async () => {
		const control = stubControl('ready')
		const { app } = await sessionWith(control)
		const mcp = await connectMcp(app, EDITOR_AGENT)
		try {
			const tools = await mcp.client.listTools()
			const tool = tools.tools.find(item => item.name === 'restart_kit_build')
			expect(tool?.inputSchema.properties ?? {}).toEqual({})
			const attempt = await mcp.client.callTool({ name: 'restart_kit_build', arguments: { command: ['sh', '-c', 'touch pwned'] } }).catch((error: unknown) => ({ isError: true, error }))
			expect(attempt.isError).toBe(true)
		}
		finally { await mcp.close() }
		expect(control.restarts).toBe(0)
	})

	it('reports no_build when kit/package.json declares none, and is blocked when no build runs here', async () => {
		const root = await kitWorkspace(undefined)
		const persistence = new FileNativePersistence({ root, schemaPolicy: PRODUCT_WORKSPACE_SCHEMA_POLICY })
		const build = createKitBuildRunner({ root, codeDirectoryName: 'kit', print: () => {} })
		cleanups.push(() => build.stop())
		const app = createWorkspaceApplicationSession(persistence, { kitBuild: build })
		expect(await app.restartKitBuild()).toMatchObject({ status: 'no_build', build: { state: 'none' } })
		const without = createWorkspaceApplicationSession(persistence)
		expect(await without.restartKitBuild()).toMatchObject({ status: 'blocked', code: 'kit.build_unavailable' })
	})

	it('refuses a throttled restart with kit.build_restart_throttled over MCP (blocked) and HTTP (429) (Clause 01a12f9a-ef7c)', async () => {
		const control = stubControl('ready')
		control.throttled = true
		const { app } = await sessionWith(control)
		const mcp = await connectMcp(app, EDITOR_AGENT)
		try {
			const refused = await mcp.client.callTool({ name: 'restart_kit_build', arguments: {} })
			expect(refused.isError).toBe(true)
			expect(refused.structuredContent).toMatchObject({ status: 'blocked', code: 'kit.build_restart_throttled', diagnostics: [{ code: 'kit.build_restart_throttled' }] })
		}
		finally { await mcp.close() }
		expect(await restartKitBuildForHttp(scoped(app, EDITOR_AGENT))).toMatchObject({ status: 429, body: { code: 'kit.build_restart_throttled', message: expect.stringContaining('Try again in 2 s') } })
		expect(control.restarts).toBe(0)
	})

	it('reads the build state with workspace.read, in uiux://product-kit and GET /api/product-kit/build', async () => {
		const control = stubControl('failed')
		control.current = { state: 'failed', message: 'The build process exited with code 1.' }
		const { app } = await sessionWith(control)
		expect(readKitBuildForHttp(scoped(app, BARE_READER))).toEqual({ status: 200, body: { key: 'product-kit', build: { state: 'failed', message: 'The build process exited with code 1.' } } })
		expect((await readProductKitForHttp(scoped(app, BARE_READER))).body).toMatchObject({ build: { state: 'failed' } })
		const mcp = await connectMcp(app, READER_AGENT)
		try {
			const read = await mcp.client.readResource({ uri: 'uiux://product-kit' })
			const content = read.contents[0]
			expect(content && 'text' in content ? JSON.parse(content.text).build : undefined).toEqual({ state: 'failed', message: 'The build process exited with code 1.' })
		}
		finally { await mcp.close() }
	})

	it('reads the build log only with product-kit.source.read', async () => {
		const { app } = await sessionWith(stubControl('ready'))
		expect(readKitBuildLogForHttp(scoped(app, BARE_READER))).toMatchObject({ status: 403, body: { code: 'auth.scope_denied', requiredKeys: ['product-kit.source.read'] } })
		expect(readKitBuildLogForHttp(scoped(app, READER_AGENT))).toEqual({ status: 200, body: { key: 'product-kit', log: 'error in <workspace>/kit/src/x.ts' } })
	})
})

describe('formal capture and the kit build (Rule 01a11bb1-9f2f)', () => {
	const context: ResolvedRenderContext = { viewId: '11111111-1111-4111-8111-111111111111', locale: 'en-US', viewportId: 'desktop', viewport: { width: 800, height: 600 }, themeId: 'light' }

	it.each(['building', 'failed'] as const)('refuses while the build is %s, before launching a browser', async (state) => {
		const { app } = await sessionWith(stubControl(state))
		const result = await app.captureFormalEvidence({ contexts: [context] })
		expect(result).toMatchObject({ status: 'failed', summary: { total: 1, captured: 0, failed: 1 } })
		expect(result.results[0]?.diagnostics).toEqual([expect.objectContaining({ code: 'capture.kit_build_not_ready' })])
	})
})
