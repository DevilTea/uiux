import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

/**
 * The kit modules each kit build output generation imports anew (Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2,
 * `src/adapters/kit-output-imports.ts`), whatever the module system that loads them. Node's own
 * loader runs these, in a child process: a Vitest run of the source does not use it for `import()`.
 */

const MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'adapters', 'kit-output-imports.ts')).href
const roots: string[] = []
afterEach(async () => {
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function write(path: string, content: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true })
	await writeFile(path, content)
}

/** Counts the module's evaluations; `loaded(name)` is then `<name>-<generation>-<evaluations>`. */
function count(name: string): string {
	return `globalThis.__kitLoads ??= {}\nglobalThis.__kitLoads.${name} = (globalThis.__kitLoads.${name} ?? 0) + 1\n`
}

function loaded(name: string, generation: string): string {
	return `${JSON.stringify(`${name}-${generation}-`)} + globalThis.__kitLoads.${name}`
}

/** The kit's output for `generation`, by path in `kit/`: an Adapter module that reaches every other module. */
function output(generation: string): Record<string, string> {
	return {
		'dist/uiux.js': [
			`import { value as esm } from './esm.js'`,
			`import bridge from './bridge.cjs'`,
			`import { createRequire } from 'node:module'`,
			`import { value as pkg } from 'kit-package'`,
			`const require = createRequire(import.meta.url)`,
			`export const read = async () => ({ esm, pkg, bridge: bridge.value, required: bridge.required, imported: await bridge.imported(), createRequired: require('./created.cjs').value, requiredEsm: bridge.requiredEsm })`,
			'',
		].join('\n'),
		'dist/esm.js': `${count('esm')}export const value = ${loaded('esm', generation)}\n`,
		// A CommonJS module that requires CommonJS and ES modules and imports an ES module dynamically.
		'dist/bridge.cjs': [
			`${count('bridge')}exports.value = ${loaded('bridge', generation)}`,
			`exports.required = require('./required.cjs').value`,
			`exports.requiredEsm = require('./required-esm.js').value`,
			`exports.imported = () => import('./imported.js').then(module => module.value)`,
			'',
		].join('\n'),
		'dist/required.cjs': `${count('required')}exports.value = ${loaded('required', generation)}\n`,
		'dist/required-esm.js': `${count('requiredEsm')}export const value = ${loaded('requiredEsm', generation)}\n`,
		'dist/imported.js': `import { value as nested } from './nested.js'\n${count('imported')}export const value = ${loaded('imported', generation)} + '/' + nested\n`,
		'dist/nested.js': `${count('nested')}export const value = ${loaded('nested', generation)}\n`,
		'dist/created.cjs': `${count('created')}exports.value = ${loaded('created', generation)}\n`,
	}
}

async function kit(): Promise<string> {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'uiux-kit-imports-')))
	roots.push(root)
	const directory = join(root, 'kit')
	await write(join(directory, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module' }))
	await write(join(directory, 'node_modules', 'kit-package', 'package.json'), JSON.stringify({ name: 'kit-package', version: '1.0.0', type: 'module', exports: './index.js' }))
	await write(join(directory, 'node_modules', 'kit-package', 'index.js'), `${count('pkg')}export const value = ${loaded('pkg', 'installed')}\n`)
	return directory
}

/**
 * Imports the Adapter module of each generation in one Node process, as the server does: the kit's
 * output is written for the generation, as a build would, then the generation's version is shared
 * and the Adapter module is imported under it.
 */
async function importGenerations(directory: string, generations: readonly string[]): Promise<Record<string, unknown>[]> {
	const driver = join(directory, '..', 'driver.mjs')
	await writeFile(driver, [
		`import { mkdirSync, writeFileSync } from 'node:fs'`,
		`import { dirname, join } from 'node:path'`,
		`import { pathToFileURL } from 'node:url'`,
		`import { shareVersionWithKitImports } from ${JSON.stringify(MODULE)}`,
		`const directory = ${JSON.stringify(directory)}`,
		`const outputs = ${JSON.stringify(generations.map(generation => [generation, output(generation)]))}`,
		`const results = []`,
		`for (const [generation, files] of outputs) {`,
		`	for (const [path, content] of Object.entries(files)) {`,
		`		mkdirSync(dirname(join(directory, path)), { recursive: true })`,
		`		writeFileSync(join(directory, path), content)`,
		`	}`,
		`	shareVersionWithKitImports(directory, generation)`,
		`	const adapter = await import(pathToFileURL(join(directory, 'dist', 'uiux.js')).href + '?v=' + generation)`,
		`	results.push(await adapter.read())`,
		`}`,
		`process.stdout.write(JSON.stringify(results))`,
		'',
	].join('\n'))
	const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings', driver], { cwd: directory })
	return JSON.parse(stdout) as Record<string, unknown>[]
}

describe('kit modules per kit build output generation (Rule 01a11bb1-9df8)', () => {
	it('imports anew each kit module that an ES or CommonJS kit module loads by import, import() or require, and keeps one copy of an installed package', async () => {
		const results = await importGenerations(await kit(), ['1', '2', '3'])
		expect(results).toEqual(['1', '2', '3'].map(generation => expect.objectContaining({
			esm: `esm-${generation}-${generation}`,
			pkg: 'pkg-installed-1',
			bridge: `bridge-${generation}-${generation}`,
			required: `required-${generation}-${generation}`,
			imported: `imported-${generation}-${generation}/nested-${generation}-${generation}`,
			createRequired: `created-${generation}-${generation}`,
		})))
	}, 30_000)

	it('keeps the first copy of a kit ES module that require() loads, which Node 24 caches by its file URL (Implementation gap on Rule 01a11bb1-9df8)', async () => {
		const results = await importGenerations(await kit(), ['1', '2'])
		expect(results.map(result => result.requiredEsm)).toEqual(['requiredEsm-1-1', 'requiredEsm-1-1'])
	}, 30_000)
})
