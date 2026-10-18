import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { canonicalJsonBytes } from '../src/persistence'
import { startWorkbenchServer, type WorkbenchServer } from './support/workbench-server'

/**
 * The kit build in the built server (issue #214, Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2): each
 * settled output reaches the server-side Adapter resolution together with the kit modules the
 * Adapter module imports. The server imports Adapter modules with Node's own loader, which a
 * Vitest run of the source does not use, so this runs against `.output/server/index.mjs`.
 */

let server: WorkbenchServer

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/**
 * Writes `dist/uiux.js`, the same each time, whose Adapter ID comes from the ES module
 * `dist/parts/id.js`, the CommonJS module `dist/parts/suffix.cjs` and the ES module
 * `dist/parts/late.js` that it imports with `import()` (all named by `version.txt`), and from how
 * many times the installed package `kit-counter` was evaluated.
 */
const BUILD_SPLIT = `
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
const version = existsSync('version.txt') ? readFileSync('version.txt', 'utf8').trim() : '1'
mkdirSync('dist/parts', { recursive: true })
writeFileSync('dist/parts/late.js', "export const late = 'l" + version + "'\\n")
writeFileSync('dist/parts/suffix.cjs', "exports.suffix = 'c" + version + "'\\nexports.late = () => import('./late.js').then(module => module.late)\\n")
writeFileSync('dist/parts/id.js', "import { loads } from 'kit-counter'\\nimport { suffix, late } from './suffix.cjs'\\nexport const id = 'kit-split-" + version + "-' + loads() + '-' + suffix + '-' + await late()\\n")
writeFileSync('dist/uiux.js', "import { id } from './parts/id.js'\\nexport const manifest = { id, apiVersion: '1', widgetPlugins: [], catalog: { widgets: {} }, renderers: [], providers: [] }\\n")
`

async function prepareKit(root: string): Promise<void> {
	const kit = join(root, 'kit')
	await write(join(kit, 'package.json'), JSON.stringify({
		name: 'kit',
		private: true,
		type: 'module',
		dependencies: { 'kit-counter': '1.0.0' },
		uiux: { output: 'dist', build: { command: [process.execPath, 'build.mjs'] } },
	}))
	await write(join(kit, 'build.mjs'), BUILD_SPLIT)
	await write(join(kit, 'node_modules', 'kit-counter', 'package.json'), JSON.stringify({ name: 'kit-counter', version: '1.0.0', type: 'module', exports: './index.js' }))
	await write(join(kit, 'node_modules', 'kit-counter', 'index.js'), 'globalThis.__uiuxKitCounter = (globalThis.__uiuxKitCounter ?? 0) + 1\nexport const loads = () => globalThis.__uiuxKitCounter\n')
	const productKitPath = join(root, 'product-kit.json')
	const productKit = JSON.parse(await readFile(productKitPath, 'utf8')) as Record<string, unknown>
	await writeFile(productKitPath, canonicalJsonBytes({ ...productKit, adapters: [{ moduleSpecifier: './dist/uiux.js' }], styles: [] }))
}

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: Record<string, unknown> }> {
	const response = await fetch(`${server.origin}${path}`, { ...init, headers: { authorization: `Bearer ${server.token}`, ...init.headers } })
	return { status: response.status, body: await response.json() as Record<string, unknown> }
}

async function buildState(): Promise<string> {
	const { body } = await api('/api/product-kit/build')
	return (body.build as { state: string }).state
}

async function settled(): Promise<string> {
	const deadline = Date.now() + 20_000
	for (;;) {
		const state = await buildState()
		if (state === 'ready' || state === 'failed') return state
		if (Date.now() > deadline) throw new Error(`the kit build did not settle; last state ${state}`)
		await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
	}
}

async function adapterId(): Promise<unknown> {
	const { body } = await api('/api/preview/adapters')
	expect(body.state, JSON.stringify(body.diagnostics)).toBe('valid')
	return (body.summaries as { adapterId?: string }[])[0]?.adapterId
}

beforeAll(async () => {
	server = await startWorkbenchServer({ prepare: prepareKit })
}, 60_000)

afterAll(async () => {
	await server?.close()
})

describe('settled kit build output in the built server (Rule 01a11bb1-9df8)', () => {
	it('imports anew the ES and CommonJS kit modules the Adapter module imports, also by import() from CommonJS, and keeps one copy of an installed package', async () => {
		expect(await settled()).toBe('ready')
		expect(await adapterId()).toBe('kit-split-1-1-c1-l1')
		const entry = await readFile(join(server.workspaceRoot, 'kit', 'dist', 'uiux.js'), 'utf8')

		// Only the module the Adapter imports changes; the Adapter module is the same file.
		await writeFile(join(server.workspaceRoot, 'kit', 'version.txt'), '2')
		const restarted = await api('/api/product-kit/build/restart', { method: 'POST' })
		expect(restarted.status, JSON.stringify(restarted.body)).toBe(200)
		expect(await settled()).toBe('ready')
		expect(await readFile(join(server.workspaceRoot, 'kit', 'dist', 'uiux.js'), 'utf8')).toBe(entry)
		expect(await adapterId()).toBe('kit-split-2-1-c2-l2')
	}, 60_000)
})
