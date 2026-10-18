import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import ts from 'typescript'

import {
	STRING_VALUE_CONTRACT_ID,
	TRANSLATION_RESULT_VALUE_CONTRACT_ID,
	WIDGET_ID_ATTRIBUTE,
} from '../src/adapter-entry'
import { UIUX_STRING_VALUE_CONTRACT_ID, UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID } from '../src/i18n/widget-contracts'
import { adapterGraphDigest } from '../src/adapters/adapter-graph-digest'
import { adapterResolutionBase } from '../src/adapters/resolution'
import { V5_LAYOUT } from '../src/persistence/paths'
import { clearPreviewBundleCache } from '../src/server/preview-bundler'
import { getSelectedWorkspacePreviewBundle, resolveSelectedWorkspaceAdapters } from '../src/server/workspace-adapters'
import { writeCurrentWorkspace } from './support/workspace-layout'

/**
 * The public Adapter authoring entry `@deviltea/uiux/adapter` (Clauses 01a11a5a-462c-7f59-af78-6d01787a275f,
 * 01a11a5a-46ac-75d1-99a4-1b06c8480028, 01a11a5a-472a-74f0-9d70-81a3b7f477a6 and
 * 01a11a5a-47bf-7a84-acc5-5ac420b500b1). `scripts/smoke-package.mjs` checks the same entry in the packed
 * tarball; these checks run against the repository's own package.
 */

const REPOSITORY_ROOT = process.cwd()
const ENTRY_TYPES = join(REPOSITORY_ROOT, 'src', 'adapter-entry', 'index.d.ts')
const ENTRY_MODULE = join(REPOSITORY_ROOT, 'src', 'adapter-entry', 'index.js')
const HOST_ENTRY_HOOK = join(REPOSITORY_ROOT, 'src', 'adapters', 'host-adapter-entry.ts')
const TSC = join(REPOSITORY_ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const temporaryRoots: string[] = []
afterAll(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

/** A minimal third-party Adapter that imports only the entry and the peer packages. */
const CONSUMER_SOURCE = join(REPOSITORY_ROOT, 'tests', 'fixtures', 'adapter-consumer', 'adapter.ts')

/** A consumer project whose `node_modules/` holds this package and the peer packages, each as a link. */
async function consumerProject(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-adapter-entry-'))
	temporaryRoots.push(root)
	await mkdir(join(root, 'node_modules', '@deviltea'), { recursive: true })
	await symlink(REPOSITORY_ROOT, join(root, 'node_modules', '@deviltea', 'uiux'))
	for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
		await symlink(join(REPOSITORY_ROOT, 'node_modules', name), join(root, 'node_modules', name))
	await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'consumer-adapter', private: true, type: 'module' }))
	return root
}

describe('the public Adapter authoring entry @deviltea/uiux/adapter', () => {
	it('is the only subpath the exports map exposes, besides package.json', async () => {
		const packageJson = JSON.parse(await readFile(join(REPOSITORY_ROOT, 'package.json'), 'utf8'))
		expect(packageJson.exports).toEqual({
			'./adapter': { types: './src/adapter-entry/index.d.ts', import: './src/adapter-entry/index.js' },
			'./package.json': './package.json',
		})
		expect(packageJson.bin).toEqual({ uiux: './bin/uiux.mjs' })
		expect(packageJson.files).toContain('src')
	})

	it('resolves for ESM importers and refuses every other module of the package', async () => {
		const root = await consumerProject()
		const read = spawnSync(process.execPath, ['--input-type=module', '-e', `
			const entry = await import('@deviltea/uiux/adapter')
			const results = { exports: Object.fromEntries(Object.entries(entry)) }
			for (const specifier of ['@deviltea/uiux', '@deviltea/uiux/src/domain/adapters/schema.ts', '@deviltea/uiux/src/adapter-entry/index.js']) {
				try { await import(specifier); results[specifier] = 'resolved' }
				catch (error) { results[specifier] = error.code }
			}
			results.packageJson = (await import('@deviltea/uiux/package.json', { with: { type: 'json' } })).default.name
			console.log(JSON.stringify(results))
		`], { cwd: root, encoding: 'utf8' })
		expect(read.stderr).toBe('')
		expect(JSON.parse(read.stdout)).toEqual({
			exports: {
				STRING_VALUE_CONTRACT_ID: 'deviltea.uiux/string@1',
				TRANSLATION_RESULT_VALUE_CONTRACT_ID: 'deviltea.uiux/translation-result@1',
				WIDGET_ID_ATTRIBUTE: 'data-widget-id',
			},
			'@deviltea/uiux': 'ERR_PACKAGE_PATH_NOT_EXPORTED',
			'@deviltea/uiux/src/domain/adapters/schema.ts': 'ERR_PACKAGE_PATH_NOT_EXPORTED',
			'@deviltea/uiux/src/adapter-entry/index.js': 'ERR_PACKAGE_PATH_NOT_EXPORTED',
			packageJson: '@deviltea/uiux',
		})
	})

	it('exports only the three string constants at runtime, which UIUX itself uses', () => {
		expect({ STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID, WIDGET_ID_ATTRIBUTE }).toEqual({
			STRING_VALUE_CONTRACT_ID: 'deviltea.uiux/string@1',
			TRANSLATION_RESULT_VALUE_CONTRACT_ID: 'deviltea.uiux/translation-result@1',
			WIDGET_ID_ATTRIBUTE: 'data-widget-id',
		})
		expect(UIUX_STRING_VALUE_CONTRACT_ID).toBe(STRING_VALUE_CONTRACT_ID)
		expect(UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID).toBe(TRANSLATION_RESULT_VALUE_CONTRACT_ID)
	})

	it('ships an ESM module that imports nothing, and declarations that import types only from the peer packages', async () => {
		const built = await esbuild.build({ entryPoints: [ENTRY_MODULE], bundle: false, write: false, format: 'esm', metafile: true, logLevel: 'silent' })
		const inputs = Object.values(built.metafile.inputs)
		expect(inputs).toHaveLength(1)
		expect(inputs[0]!.imports).toEqual([])
		expect(inputs[0]!.format).toBe('esm')

		const declarations = await readFile(ENTRY_TYPES, 'utf8')
		const imported = ts.preProcessFile(declarations, true, true).importedFiles.map(file => file.fileName)
		expect(imported.length).toBeGreaterThan(0)
		for (const specifier of imported) expect(['@deviltea/widget-core', '@deviltea/widget-vue', 'vue']).toContain(specifier)
		const source = ts.createSourceFile(ENTRY_TYPES, declarations, ts.ScriptTarget.Latest, true)
		for (const statement of source.statements) {
			if (ts.isImportDeclaration(statement)) expect(statement.importClause?.isTypeOnly).toBe(true)
		}
	})

	it('declares exactly the listed types and constants, and no value naming the host API version', () => {
		const program = ts.createProgram([ENTRY_TYPES], { strict: true, noEmit: true, skipLibCheck: true, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [] })
		const checker = program.getTypeChecker()
		const moduleSymbol = checker.getSymbolAtLocation(program.getSourceFile(ENTRY_TYPES)!)!
		const exported = checker.getExportsOfModule(moduleSymbol)
		expect(exported.map(symbol => symbol.name).sort()).toEqual([
			'AdapterApiVersion',
			'AdapterAssetCapability',
			'AdapterCatalog',
			'AdapterManifest',
			'AdapterProviderContext',
			'AdapterWidgetCatalogEntry',
			'I18nFieldMapping',
			'JsonValue',
			'RootShellInterfaces',
			'STRING_VALUE_CONTRACT_ID',
			'TRANSLATION_RESULT_VALUE_CONTRACT_ID',
			'TranslationResult',
			'TranslationWarning',
			'WIDGET_ID_ATTRIBUTE',
		])
		const values = exported.filter(symbol => symbol.flags & ts.SymbolFlags.Value).map(symbol => symbol.name).sort()
		expect(values).toEqual(['STRING_VALUE_CONTRACT_ID', 'TRANSLATION_RESULT_VALUE_CONTRACT_ID', 'WIDGET_ID_ATTRIBUTE'])
		// The checked-in declarations and runtime module each state the constants (Discussion #241 owner
		// decision 1 during review of #251): each declared literal type is the runtime value.
		const declaredLiterals = Object.fromEntries(exported.filter(symbol => symbol.flags & ts.SymbolFlags.Value).map(symbol => {
			const type = checker.getTypeOfSymbol(symbol)
			return [symbol.name, type.isStringLiteral() ? type.value : undefined]
		}))
		expect(declaredLiterals).toEqual({ STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID, WIDGET_ID_ATTRIBUTE })
		expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
	})

	it('exports the Adapter author types that a minimal third-party Adapter type-checks against', async () => {
		const root = await consumerProject()
		await writeFile(join(root, 'adapter.ts'), await readFile(CONSUMER_SOURCE, 'utf8'))
		await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
			compilerOptions: {
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				lib: ['ES2022', 'DOM'],
				strict: true,
				noEmit: true,
				skipLibCheck: false,
				types: [],
			},
			files: ['adapter.ts'],
		}))
		const result = spawnSync(process.execPath, [TSC, '-p', resolve(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' })
		expect(`${result.stdout}${result.stderr}`).toBe('')
		expect(result.status).toBe(0)

		// A deep import of UIUX's sources is not part of the contract and does not resolve.
		await writeFile(join(root, 'adapter.ts'), `import type { AdapterManifest } from '@deviltea/uiux/src/domain/adapters/schema'\nexport type M = AdapterManifest\n`)
		const deep = spawnSync(process.execPath, [TSC, '-p', resolve(root, 'tsconfig.json')], { cwd: root, encoding: 'utf8' })
		expect(deep.status).not.toBe(0)
		expect(deep.stdout).toContain('TS2307')
	}, 60_000)
})

/** An Adapter module that imports the entry's constants at runtime, as the reference Adapter does. */
const HOSTED_ENTRY_ADAPTER = `
import { createWidgetPlugin } from '@deviltea/widget-core'
import { defineComponent, h } from 'vue'
import { useWidget } from '@deviltea/widget-vue'
import { STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID, WIDGET_ID_ATTRIBUTE } from '@deviltea/uiux/adapter'

const plugin = createWidgetPlugin('HostedLabel')
	.interfaces()
	.state(state => state.text({ authorWritable: true, validate: value => typeof value === 'string', default: () => '' }))
	.done()

const HostedLabel = defineComponent({
	setup() {
		const { useState } = useWidget(plugin)
		const state = useState()
		return () => h('span', { [WIDGET_ID_ATTRIBUTE]: 'label' }, state.text.value)
	},
})

export const manifest = {
	id: 'hosted-entry',
	apiVersion: '1',
	widgetPlugins: [plugin],
	catalog: { widgets: { HostedLabel: { contracts: [STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID, WIDGET_ID_ATTRIBUTE] } } },
	renderers: [{ type: 'HostedLabel', component: HostedLabel }],
	providers: [],
}
`

describe('the host supplies @deviltea/uiux/adapter (Discussion #241 owner decision 2 during review of #251)', () => {
	afterAll(() => clearPreviewBundleCache())

	/**
	 * A Workspace whose kit declares its own `kit/package.json` and installs the peer packages, but not
	 * `@deviltea/uiux`: no package scope or `node_modules/` above the kit names UIUX, so only the host can
	 * supply the entry.
	 */
	async function kitWithoutUiux(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'uiux-hosted-entry-'))
		temporaryRoots.push(root)
		await writeCurrentWorkspace(root, { adapters: [{ moduleSpecifier: './adapters/hosted.mjs' }] })
		const kit = join(root, 'kit')
		await mkdir(join(kit, 'node_modules', '@deviltea'), { recursive: true })
		await mkdir(join(kit, 'adapters'), { recursive: true })
		await writeFile(join(kit, 'package.json'), JSON.stringify({ name: 'kit', private: true, type: 'module' }))
		for (const name of ['@deviltea/widget-core', '@deviltea/widget-vue', 'vue'])
			await symlink(join(REPOSITORY_ROOT, 'node_modules', name), join(kit, 'node_modules', name))
		await writeFile(join(kit, 'adapters', 'hosted.mjs'), HOSTED_ENTRY_ADAPTER)
		return root
	}

	it('resolves it, under Node\'s loader on the server, to UIUX\'s own entry', async () => {
		const root = await kitWithoutUiux()
		// Node's loader runs the hook in a child process: a Vitest run of the source does not use it for `import()`.
		const driver = (hook: boolean) => [
			`import { pathToFileURL } from 'node:url'`,
			`import { supplyAdapterEntryOnServer } from ${JSON.stringify(pathToFileURL(HOST_ENTRY_HOOK).href)}`,
			hook ? `supplyAdapterEntryOnServer(${JSON.stringify(REPOSITORY_ROOT)})` : '',
			`try {`,
			`	const { manifest } = await import(pathToFileURL(${JSON.stringify(join(root, 'kit', 'adapters', 'hosted.mjs'))}).href)`,
			`	process.stdout.write(JSON.stringify({ catalog: manifest.catalog, entry: import.meta.resolve('@deviltea/uiux/adapter') }))`,
			`} catch (error) { process.stdout.write(JSON.stringify({ error: error.code })) }`,
			'',
		].join('\n')
		const run = async (hook: boolean) => {
			const path = join(root, hook ? 'hooked.mjs' : 'plain.mjs')
			await writeFile(path, driver(hook))
			const result = spawnSync(process.execPath, ['--no-warnings', path], { cwd: join(root, 'kit'), encoding: 'utf8' })
			expect(result.stderr).toBe('')
			return JSON.parse(result.stdout) as unknown
		}
		// The kit cannot resolve the entry itself: no package scope or `node_modules/` above it names UIUX.
		expect(await run(false)).toEqual({ error: 'ERR_MODULE_NOT_FOUND' })
		expect(await run(true)).toEqual({
			catalog: { widgets: { HostedLabel: { contracts: [STRING_VALUE_CONTRACT_ID, TRANSLATION_RESULT_VALUE_CONTRACT_ID, WIDGET_ID_ATTRIBUTE] } } },
			entry: pathToFileURL(ENTRY_MODULE).href,
		})
	}, 60_000)

	it('resolves it to UIUX\'s own entry in the Preview bundle and in the Adapter graph digest', async () => {
		const root = await kitWithoutUiux()
		const resolution = await resolveSelectedWorkspaceAdapters(root)
		expect(resolution.diagnostics).toEqual([])
		if (resolution.state !== 'valid') return

		// The bundle builds, and the server-side check evaluates it, with the entry aliased like the peer packages.
		const bundle = await getSelectedWorkspacePreviewBundle(root)
		expect(bundle.state === 'invalid' ? bundle.diagnostics : []).toEqual([])
		if (bundle.state !== 'valid') return
		expect(bundle.adapterCheck).toBe('passed')

		// The digest leaves the host-supplied entry out of the graph, as it leaves out the peer packages.
		const entry = resolution.set.entries[0]!.resolvedModule.resolvedPath
		const digest = await adapterGraphDigest({ workspaceRoot: root, moduleBase: adapterResolutionBase(root, V5_LAYOUT), entry })
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u)
	}, 60_000)
})
