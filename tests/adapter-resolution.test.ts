import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AdapterManifest } from '../src/domain/adapters/schema'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
import {
	CANONICAL_WORKSPACE_DATA_DIRECTORIES,
	WORKSPACE_DATA_DIRECTORY,
	artifactRelativePath,
	assetDirectoryRelativePath,
	assetMetadataRelativePath,
	flowRelativePath,
	localeRelativePath,
	reviewRelativePath,
	viewRelativePath,
	workspaceRelativePath,
} from '../src/persistence/paths'
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

	it('refuses relative adapters that resolve inside canonical Workspace data directories while allowing adapters/', async () => {
		const root = await makeRoot()
		const resolver = new NodeWorkspaceAdapterModuleResolver()

		// A legitimate `./adapters/*` local Adapter (e.g. the reference Adapter) stays resolvable.
		await mkdir(join(root, 'adapters'), { recursive: true })
		await writeFile(join(root, 'adapters', 'reference.mjs'), 'export const marker = true\n')
		const ok = await resolver.resolve(root, './adapters/reference.mjs')
		expect(ok.resolvedPath).toBe(join(root, 'adapters', 'reference.mjs'))

		// Each authoring-writable data directory is refused: an Editor/Agent could upload an
		// executable module there and select it, escalating to host code execution on resolution.
		for (const relative of ['./assets/abc/x.mjs', './views/x.mjs', './flows/x.mjs', './reviews/x.mjs', './i18n/en-US.mjs', './.uiux/x.mjs']) {
			const absolute = join(root, relative.slice(2))
			await mkdir(dirname(absolute), { recursive: true })
			await writeFile(absolute, 'import { writeFileSync } from "node:fs"\nwriteFileSync(process.env.UIUX_TEST_MARKER, "pwned")\n')
			await expect(resolver.resolve(root, relative)).rejects.toThrow(/canonical Workspace data directory/i)
		}

		// A symlink from adapters/ into assets/ is caught via realpath, not just the literal path.
		await writeFile(join(root, 'assets', 'payload.mjs'), 'export const marker = true\n')
		await symlink(join(root, 'assets', 'payload.mjs'), join(root, 'adapters', 'linked.mjs'))
		await expect(resolver.resolve(root, './adapters/linked.mjs')).rejects.toThrow(/canonical Workspace data directory/i)

		// Root-level `./adapter.mjs` stays a legitimate accepted local Adapter.
		await writeFile(join(root, 'adapter.mjs'), 'export const marker = true\n')
		const rootLevel = await resolver.resolve(root, './adapter.mjs')
		expect(rootLevel.resolvedPath).toBe(join(root, 'adapter.mjs'))

		// A case-variant specifier is refused on a case-insensitive file system (identity, not name).
		if (await filesystemIsCaseInsensitive(root)) {
			await mkdir(join(root, 'assets', 'cv'), { recursive: true })
			await writeFile(join(root, 'assets', 'cv', 'x.mjs'), 'export const marker = true\n')
			await expect(resolver.resolve(root, './ASSETS/cv/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		}
	})

	it('refuses bare specifiers that resolve back inside a canonical Workspace data directory', async () => {
		const resolver = new NodeWorkspaceAdapterModuleResolver()

		// (a) Monorepo: node_modules/<pkg> is a symlink back to the package that contains the Workspace.
		const base = await makeRoot()
		const pkg = join(base, 'packages', 'app')
		const wsRoot = join(pkg, 'design')
		await mkdir(join(wsRoot, 'assets', 'u1'), { recursive: true })
		await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
		await writeFile(join(wsRoot, 'assets', 'u1', 'x.mjs'), 'export const marker = true\n')
		await mkdir(join(base, 'node_modules'), { recursive: true })
		await symlink(pkg, join(base, 'node_modules', 'app'))
		await expect(resolver.resolve(wsRoot, 'app/design/assets/u1/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)

		// (b) Self-reference: the Workspace root is itself a package whose exports/imports map `./*`.
		const selfRoot = await makeRoot()
		await mkdir(join(selfRoot, 'assets', 'u1'), { recursive: true })
		await writeFile(join(selfRoot, 'package.json'), JSON.stringify({
			name: 'selfref', type: 'module', exports: { './*': './*' }, imports: { '#*': './*' },
		}))
		await writeFile(join(selfRoot, 'assets', 'u1', 'x.mjs'), 'export const marker = true\n')
		await expect(resolver.resolve(selfRoot, 'selfref/assets/u1/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		await expect(resolver.resolve(selfRoot, '#assets/u1/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)

		// A bare package resolving to a genuine node_modules location outside the root stays allowed.
		const normalRoot = await makeRoot()
		const normalPkg = join(normalRoot, 'node_modules', '@fixture', 'ok-adapter')
		await mkdir(normalPkg, { recursive: true })
		await writeFile(join(normalPkg, 'package.json'), JSON.stringify({ name: '@fixture/ok-adapter', version: '1.0.0', type: 'module', exports: { import: './index.mjs' } }))
		await writeFile(join(normalPkg, 'index.mjs'), 'export const marker = true\n')
		const ok = await resolver.resolve(normalRoot, '@fixture/ok-adapter')
		expect(ok.resolvedPath).toBe(join(normalPkg, 'index.mjs'))
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

describe('Canonical Workspace data-directory boundary stays in sync with path helpers', () => {
	const SAMPLE_UUID = '00000000-0000-4000-8000-000000000000'
	const SAMPLE_DIGEST = `sha256:${'a'.repeat(64)}`
	const topSegment = (relativePath: string): string => relativePath.split('/')[0]!

	it('lists every top-level directory the persistence path helpers write to', () => {
		const writtenPaths = [
			workspaceRelativePath(),
			viewRelativePath(SAMPLE_UUID),
			flowRelativePath(SAMPLE_UUID),
			reviewRelativePath(SAMPLE_UUID),
			localeRelativePath('en-US'),
			assetDirectoryRelativePath(SAMPLE_UUID),
			assetMetadataRelativePath(SAMPLE_UUID),
			artifactRelativePath(SAMPLE_DIGEST),
		]
		for (const writtenPath of writtenPaths)
			expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).toContain(topSegment(writtenPath))
	})

	it('derives both exports from the same source of truth', () => {
		expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).toEqual(Object.values(WORKSPACE_DATA_DIRECTORY))
		expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).not.toContain('adapters')
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

async function filesystemIsCaseInsensitive(root: string): Promise<boolean> {
	const probe = join(root, '.case-probe')
	await mkdir(probe, { recursive: true })
	try {
		const lower = await stat(probe, { bigint: true })
		const upper = await stat(join(root, '.CASE-PROBE'), { bigint: true }).catch(() => undefined)
		return upper !== undefined && upper.dev === lower.dev && upper.ino === lower.ino
	}
	finally {
		await rm(probe, { recursive: true, force: true })
	}
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
