import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AdapterManifest } from '../src/domain/adapters/schema'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
import {
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	resolveAndInstallWorkspaceAdapterSet,
	resolveWorkspaceAdapterSet,
	type AdapterApiCompatibilityPolicy,
	type AdapterManifestLoader,
	type AdapterRegistryInspector,
	type ResolvedAdapterModule,
} from '../src/adapters'

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema'
const temporaryRoots: string[] = []

afterEach(async () => {
	await Promise.all(temporaryRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Workspace adapter resolution and validated-set installation', () => {
	it('resolves relative modules from the selected Workspace root and rejects root escape', async () => {
		const root = await makeRoot()
		const localPath = join(root, 'adapter.mjs')
		await writeFile(localPath, 'export const marker = true\n')
		const resolver = new NodeWorkspaceAdapterModuleResolver()

		const resolved = await resolver.resolve(root, './adapter.mjs')
		expect(resolved.resolvedPath).toBe(localPath)
		expect(resolved.moduleIdentity).toBe(new URL(`file://${localPath}`).href)

		const outsidePath = join(dirname(root), 'outside-adapter.mjs')
		await writeFile(outsidePath, 'export const marker = true\n')
		try {
			await expect(resolver.resolve(root, './../outside-adapter.mjs')).rejects.toThrow(/escapes/i)
		}
		finally {
			await rm(outsidePath, { force: true })
		}

		const outsideRoot = await makeRoot()
		const symlinkTarget = join(outsideRoot, 'symlink-adapter.mjs')
		await writeFile(symlinkTarget, 'export const marker = true\n')
		await symlink(symlinkTarget, join(root, 'linked-adapter.mjs'))
		await expect(resolver.resolve(root, './linked-adapter.mjs')).rejects.toThrow(/outside/i)
	})

	it('resolves bare packages from the Workspace package environment, not the UIUX process cwd', async () => {
		const root = await makeRoot()
		const packageRoot = join(root, 'node_modules', '@fixture', 'uiux-adapter')
		await mkdir(packageRoot, { recursive: true })
		await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
			name: '@fixture/uiux-adapter', version: '7.8.9', type: 'module', exports: { import: './index.mjs', require: './wrong.cjs' },
		}))
		await writeFile(join(packageRoot, 'index.mjs'), 'export const marker = true\n')
		await writeFile(join(packageRoot, 'wrong.cjs'), 'module.exports = { wrong: true }\n')

		const resolved = await new NodeWorkspaceAdapterModuleResolver().resolve(root, '@fixture/uiux-adapter')
		expect(resolved.resolvedPath).toBe(join(packageRoot, 'index.mjs'))
		expect(resolved.packageName).toBe('@fixture/uiux-adapter')
		expect(resolved.packageVersion).toBe('7.8.9')
	})

	it('loads ESM while leaving the canonical manifest export name to an injected extractor', async () => {
		const root = await makeRoot()
		const modulePath = join(root, 'named-adapter.mjs')
		await writeFile(modulePath, `export const customManifest = ${JSON.stringify(manifest('named'))}\n`)
		const resolved = await new NodeWorkspaceAdapterModuleResolver().resolve(root, './named-adapter.mjs')
		const loader = new NodeAdapterManifestLoader(namespace => namespace.customManifest)
		expect(await loader.loadManifest(resolved)).toMatchObject({ id: 'named' })
	})

	it('rejects non-portable authored module references before invoking an injected resolver', async () => {
		let resolverCalls = 0
		const input = fixtureInput([{ moduleSpecifier: '/absolute/adapter.mjs' }], {})
		input.resolver.resolve = async () => {
			resolverCalls++
			throw new Error('must not run')
		}
		const result = await resolveWorkspaceAdapterSet(input)
		expect(result.state).toBe('invalid')
		expect(result.diagnostics).toContainEqual(expect.objectContaining({
			code: 'workspace.invalid_adapter_specifier',
			path: '/adapters/0/moduleSpecifier',
		}))
		expect(resolverCalls).toBe(0)
		expect('set' in result).toBe(false)
	})

	it('collects resolution and manifest-load failures as repairable diagnostics without installing', async () => {
		const installerCalls: string[][] = []
		const result = await resolveAndInstallWorkspaceAdapterSet(
			fixtureInput(
				[{ moduleSpecifier: 'good' }, { moduleSpecifier: 'missing' }, { moduleSpecifier: 'loader-fails' }],
				{ good: manifest('good'), 'loader-fails': new Error('module exploded') },
			),
			{ async install(set) { installerCalls.push(set.entries.map(entry => entry.manifest.id)); return 'installed' } },
		)
		expect(result.state).toBe('invalid')
		if (result.state === 'invalid') {
			expect(result.diagnostics.some(item => item.code === 'adapter.resolution_failed' && item.path === '/adapters/1/moduleSpecifier')).toBe(true)
			expect(result.diagnostics.some(item => item.code === 'adapter.manifest_load_failed' && item.path === '/adapters/2/moduleSpecifier')).toBe(true)
		}
		expect(installerCalls).toEqual([])
	})

	it('blocks malformed manifests, incompatible API versions, and invalid adapter config', async () => {
		const schema = {
			$schema: DRAFT_2020_12,
			type: 'object',
			required: ['enabled'],
			properties: { enabled: { type: 'boolean' } },
			additionalProperties: false,
		}
		const result = await resolveWorkspaceAdapterSet(fixtureInput(
			[
				{ moduleSpecifier: 'malformed' },
				{ moduleSpecifier: 'incompatible' },
				{ moduleSpecifier: 'bad-config', config: { enabled: 'yes' } },
				{ moduleSpecifier: 'no-schema', config: { enabled: true } },
				{ moduleSpecifier: 'invalid-schema' },
			],
			{
				malformed: { apiVersion: 'compatible' },
				incompatible: manifest('incompatible', { apiVersion: 'not-supported' }),
				'bad-config': manifest('bad-config', { configSchema: schema }),
				'no-schema': manifest('no-schema'),
				'invalid-schema': manifest('invalid-schema', { configSchema: { $schema: DRAFT_2020_12, type: 42 } as never }),
			},
		))
		expect(result.state).toBe('invalid')
		expect(result.diagnostics.some(item => item.path.startsWith('/adapters/0/manifest'))).toBe(true)
		expect(result.diagnostics.some(item => item.code === 'adapter.api_version_incompatible' && item.path === '/adapters/1/manifest/apiVersion')).toBe(true)
		expect(result.diagnostics.some(item => item.code === 'adapter.config_schema_violation' && item.path.startsWith('/adapters/2/config'))).toBe(true)
		expect(result.diagnostics.some(item => item.code === 'adapter.config_schema_required' && item.path === '/adapters/3/config')).toBe(true)
		expect(result.diagnostics.some(item => item.code === 'adapter.invalid_config_schema' && item.path === '/adapters/4/manifest/configSchema')).toBe(true)
	})

	it('treats duplicate adapter and registry ownership as blocking without first/last-wins behavior', async () => {
		for (const collision of ['id', 'widgetTypes', 'rendererKeys', 'catalogKeys'] as const) {
			const manifests = collision === 'id'
				? { first: manifest('same'), second: manifest('same') }
				: collision === 'catalogKeys'
					? {
						first: manifest('first', { catalog: { widgets: { shared: {} } } }),
						second: manifest('second', { catalog: { widgets: { shared: {} } } }),
					}
					: { first: manifest('first'), second: manifest('second') }
			const inspector = ownershipInspector({
				first: collision === 'widgetTypes' ? { widgetTypes: ['shared'], rendererKeys: [] }
					: collision === 'rendererKeys' ? { widgetTypes: [], rendererKeys: ['shared'] } : emptyOwnership(),
				second: collision === 'widgetTypes' ? { widgetTypes: ['shared'], rendererKeys: [] }
					: collision === 'rendererKeys' ? { widgetTypes: [], rendererKeys: ['shared'] } : emptyOwnership(),
			})
			const result = await resolveWorkspaceAdapterSet(fixtureInput(
				[{ moduleSpecifier: 'first' }, { moduleSpecifier: 'second' }], manifests, { registryInspector: inspector },
			))
			expect(result.state, collision).toBe('invalid')
			expect(result.diagnostics.some(item => item.code === 'adapter.registry_collision'), collision).toBe(true)
		}
	})

	it('preserves canonical adapter order and invokes one installer only after the complete set validates', async () => {
		const installCalls: string[][] = []
		const result = await resolveAndInstallWorkspaceAdapterSet(
			fixtureInput(
				[{ moduleSpecifier: 'base' }, { moduleSpecifier: 'project' }],
				{ base: manifest('base'), project: manifest('project') },
				{
					registryInspector: ownershipInspector({
						base: { widgetTypes: ['Button'], rendererKeys: ['Button'] },
						project: { widgetTypes: ['ProductCard'], rendererKeys: ['ProductCard'] },
					}),
				},
			),
			{ async install(set) { const ids = set.entries.map(entry => entry.manifest.id); installCalls.push(ids); return ids } },
		)
		expect(result.state).toBe('installed')
		if (result.state === 'installed') {
			expect(result.set.entries.map(entry => entry.manifest.id)).toEqual(['base', 'project'])
			expect(result.installed).toEqual(['base', 'project'])
		}
		expect(installCalls).toEqual([['base', 'project']])
	})

	it('never partially installs when one adapter in an otherwise-valid set is bad', async () => {
		let installCalls = 0
		const result = await resolveAndInstallWorkspaceAdapterSet(
			fixtureInput(
				[{ moduleSpecifier: 'base' }, { moduleSpecifier: 'bad' }, { moduleSpecifier: 'project' }],
				{ base: manifest('base'), bad: manifest('bad', { apiVersion: 'incompatible' }), project: manifest('project') },
			),
			{ async install() { installCalls++; return undefined } },
		)
		expect(result.state).toBe('invalid')
		expect(installCalls).toBe(0)
	})

	it('does not retain an authoritative installed result when runtime construction fails', async () => {
		const input = fixtureInput([{ moduleSpecifier: 'base' }], { base: manifest('base') })
		await expect(resolveAndInstallWorkspaceAdapterSet(input, {
			async install() { throw new Error('runtime construction failed') },
		})).rejects.toThrow('runtime construction failed')
	})
})

async function makeRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), 'uiux-adapter-resolution-'))
	temporaryRoots.push(root)
	// The resolver reports canonical realpaths. Some platforms reach tmpdir()
	// through a symlink (macOS /var -> /private/var), so compare against the
	// realpath of the fixture root rather than the raw tmpdir() spelling.
	return realpath(root)
}

function fixtureInput(
	selections: readonly WorkspaceAdapterSelection[],
	manifests: Record<string, unknown | Error>,
	overrides: Partial<{ registryInspector: AdapterRegistryInspector; apiCompatibility: AdapterApiCompatibilityPolicy }> = {},
) {
	const resolver = {
		async resolve(_root: string, moduleSpecifier: string): Promise<ResolvedAdapterModule> {
			if (moduleSpecifier === 'missing') throw new Error('not found')
			return { moduleSpecifier, resolvedPath: `/virtual/${moduleSpecifier}.mjs`, moduleIdentity: `file:///virtual/${moduleSpecifier}.mjs` }
		},
	}
	const loader: AdapterManifestLoader = {
		async loadManifest(resolved) {
			const value = manifests[resolved.moduleSpecifier]
			if (value instanceof Error) throw value
			if (value === undefined) throw new Error('fixture manifest missing')
			return value
		},
	}
	return {
		workspaceRoot: '/virtual/workspace',
		adapters: selections,
		resolver,
		loader,
		apiCompatibility: overrides.apiCompatibility ?? { isCompatible: version => version === 'compatible' },
		registryInspector: overrides.registryInspector ?? ownershipInspector({}),
	}
}

function manifest(
	id: string,
	overrides: Partial<AdapterManifest> = {},
): AdapterManifest {
	return {
		id,
		apiVersion: 'compatible',
		widgetPlugins: [],
		catalog: { widgets: {} },
		renderers: [],
		providers: [],
		styles: [],
		tokens: [],
		...overrides,
	}
}

function emptyOwnership() {
	return { widgetTypes: [], rendererKeys: [] } as const
}

function ownershipInspector(byId: Record<string, ReturnType<typeof emptyOwnership> | { widgetTypes: readonly string[]; rendererKeys: readonly string[] }>): AdapterRegistryInspector {
	return { async inspect(adapter) { return byId[adapter.id] ?? emptyOwnership() } }
}
