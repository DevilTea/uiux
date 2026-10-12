import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { parseKitBuildDeclaration, readKitBuildDeclaration } from '../src/adapters/kit-build-declaration'
import type { KitBuildControl, KitBuildStatus } from '../src/application/ports/kit-build'
import { createWorkspaceApplicationSession } from '../src/application/services/workspace-session'
import type { ResolvedRenderContext } from '../src/domain/render-context/schema'
import { emptyProductKit, type ProductKit } from '../src/domain/product-kit/schema'
import { canonicalJsonBytes, FileNativePersistence, V5_LAYOUT } from '../src/persistence'
import { readKitBuildForHttp, readKitBuildLogForHttp, readProductKitForHttp, restartKitBuildForHttp } from '../src/server/authoring-http'
import { createKitBuildRunner, KIT_BUILD_LOG_BYTES, KitBuildLog, kitBuildEnvironment, registerKitBuildRunner, type KitBuildRunner } from '../src/server/kit-build'
import { getSelectedWorkspacePreviewBundle, resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { connectMcp, scoped, testMember } from './support/access'
import { V5_TEST_SCHEMA_POLICY, v5Manifest, writeManifest } from './support/workspace-layout'

/**
 * The kit build (issue #141, unit K7): Feature 01a11bb1-8534-7f0f-b8d0-de7efabe31f7 and its Rules,
 * Product Kit Contract Clauses 01a11bb1-86af-…, 01a11bb1-8721-…, 01a11bb1-87ed-…, 01a11bb1-8856-…,
 * 01a11bb1-88ba-… and 01a11bb1-891e-…, MCP Contract Clauses 01a11bb1-b0f1-… and 01a11be8-5b64-…,
 * and the keys of Clauses 01a11bb1-b35a-… and 01a11bb1-b3c2-…. Builds are tiny Node scripts in a
 * temporary `schemaVersion` 5 Workspace.
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

function adapterModule(id: string): string {
	return `export const manifest = ${JSON.stringify({ id, apiVersion: '1', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [], styles: [], tokens: [] })}\n`
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
	await writeManifest(root, canonicalJsonBytes(v5Manifest()), V5_LAYOUT)
	await writeFile(join(root, 'product-kit.json'), canonicalJsonBytes({ ...emptyProductKit(), adapters }))
	await write(join(root, 'kit', 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module', ...(uiux === undefined ? {} : { uiux }) }))
	for (const [path, content] of Object.entries(files)) await write(join(root, 'kit', path), content)
	return root
}

function nodeBuild(script: string, extra: Readonly<Record<string, unknown>> = {}): Declaration {
	return { output: 'dist', build: { command: [process.execPath, script], ...extra } }
}

function runner(root: string, options: Readonly<{ env?: NodeJS.ProcessEnv; register?: boolean }> = {}) {
	const printed: string[] = []
	const build = createKitBuildRunner({ root, codeDirectoryName: 'kit', pollMs: 25, killGraceMs: 500, print: line => printed.push(line), ...(options.env ? { env: options.env } : {}) })
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
})

describe('the build process environment (Clause 01a11bb1-88ba)', () => {
	it('drops every UIUX_INTERNAL_* variable and puts only the node_modules/.bin of kit/ and of the Workspace root first on PATH', () => {
		const env = kitBuildEnvironment({ UIUX_INTERNAL_DEV_NETWORK: 'handoff', uiux_internal_lower: 'x', UIUX_HOME: '/h', KEEP: '1', PATH: '/usr/bin' }, '/w/.uiux/kit', '/w/.uiux')
		expect(Object.keys(env).some(name => name.toUpperCase().startsWith('UIUX_INTERNAL_'))).toBe(false)
		expect(env).toMatchObject({ UIUX_HOME: '/h', KEEP: '1' })
		// No ancestor of the Workspace root (owner ruling 1 of 2026-10-12).
		expect(env.PATH!.split(delimiter)).toEqual(['/w/.uiux/kit/node_modules/.bin', '/w/.uiux/node_modules/.bin', '/usr/bin'])
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
		expect(restarted.state).toBe('building')
		expect(processAlive(first)).toBe(false)
		expect(printed.at(-1)).toContain(JSON.stringify([process.execPath, 'build.mjs']))
		expect(await settledState(build)).toEqual({ state: 'ready' })
		expect(await readFile(join(root, 'kit', 'dist', 'uiux.js'), 'utf8')).toContain('kit-adapter-7')
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

	it('makes the Adapter set invalid while no build output exists', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
		const resolution = await resolveSelectedWorkspaceAdapters(root, V5_LAYOUT)
		expect(resolution).toMatchObject({ state: 'invalid', diagnostics: [expect.objectContaining({ code: 'kit.build_output_missing' })] })
		expect(resolution.diagnostics[0]?.message).not.toContain(root)
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }))
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
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }))
		const revision = (await app.readProductKit())!.revision
		const refused = await app.composeProductKit({ expectedRevision: revision, designSystems: [], adapters: ['./uiux.js'] })
		expect(refused).toMatchObject({ status: 'invalid', diagnostics: [expect.objectContaining({ code: 'product_kit.adapter_outside_build_output' })] })
		const composed = await app.composeProductKit({ expectedRevision: revision, designSystems: [], adapters: ['./dist/uiux.js'] })
		expect(composed).toMatchObject({ status: 'updated' })
	})

	it('takes the wrapper entry from the build output: a component importing it is flagged (Clause 01a11bb1-89e2)', async () => {
		const root = await kitWorkspace(nodeBuild('build.mjs'), {
			'build.mjs': BUILD_OK,
			'dist/uiux.js': adapterModule('built'),
			'src/card.ts': 'import \'../dist/uiux.js\'\nexport const card = 1\n',
		})
		const app = createWorkspaceApplicationSession(new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY }))
		const updated = await app.updateComponentRegistry({ expectedRevision: (await app.readProductKit())!.revision, components: { card: { files: ['src/card.ts'], layer: 'product' } }, widgets: {} })
		expect(updated).toMatchObject({ status: 'updated', findings: [expect.objectContaining({ code: 'kit.component_invalid', message: expect.stringContaining('kit/dist/uiux.js, a wrapper entry') })] })
	})
})

type StubControl = KitBuildControl & { restarts: number; current: KitBuildStatus }

function stubControl(state: KitBuildStatus['state']): StubControl {
	const control: StubControl = {
		restarts: 0,
		current: { state },
		status: () => control.current,
		async restart() {
			control.restarts++
			control.current = { state: 'building' }
			return control.current
		},
		log: () => 'error in <workspace>/kit/src/x.ts',
	}
	return control
}

async function sessionWith(control: KitBuildControl | undefined) {
	const root = await kitWorkspace(nodeBuild('build.mjs'), { 'build.mjs': BUILD_OK })
	const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
	return { root, app: createWorkspaceApplicationSession(persistence, control ? { kitBuild: control } : {}) }
}

const EDITOR_AGENT = testMember({ nickname: 'claude', kind: 'agent', role: 'editor', credential: 'token' })
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
		const persistence = new FileNativePersistence({ root, schemaPolicy: V5_TEST_SCHEMA_POLICY })
		const build = createKitBuildRunner({ root, codeDirectoryName: 'kit', print: () => {} })
		cleanups.push(() => build.stop())
		const app = createWorkspaceApplicationSession(persistence, { kitBuild: build })
		expect(await app.restartKitBuild()).toMatchObject({ status: 'no_build', build: { state: 'none' } })
		const without = createWorkspaceApplicationSession(persistence)
		expect(await without.restartKitBuild()).toMatchObject({ status: 'blocked', code: 'kit.build_unavailable' })
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
