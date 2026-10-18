import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import esbuild from 'esbuild'
import ts from 'typescript'

import {
	STRING_VALUE_CONTRACT_ID,
	TRANSLATION_RESULT_VALUE_CONTRACT_ID,
	WIDGET_ID_ATTRIBUTE,
} from '../src/adapter-entry'
import { UIUX_STRING_VALUE_CONTRACT_ID, UIUX_TRANSLATION_RESULT_VALUE_CONTRACT_ID } from '../src/i18n/widget-contracts'

/**
 * The public Adapter authoring entry `@deviltea/uiux/adapter` (Clauses 01a11a5a-462c-7f59-af78-6d01787a275f,
 * 01a11a5a-46ac-75d1-99a4-1b06c8480028, 01a11a5a-472a-74f0-9d70-81a3b7f477a6 and
 * 01a11a5a-47bf-7a84-acc5-5ac420b500b1). `scripts/smoke-package.mjs` checks the same entry in the packed
 * tarball; these checks run against the repository's own package.
 */

const REPOSITORY_ROOT = process.cwd()
const ENTRY_TYPES = join(REPOSITORY_ROOT, 'src', 'adapter-entry', 'index.d.ts')
const ENTRY_MODULE = join(REPOSITORY_ROOT, 'src', 'adapter-entry', 'index.js')
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
