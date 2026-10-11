import { afterEach, describe, expect, it } from 'vitest'
import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'

import type { AdapterManifest } from '../src/domain/adapters/schema'
import type { WorkspaceAdapterSelection } from '../src/domain/workspace/schema'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../src/product/workspace-schema'
import {
	CANONICAL_WORKSPACE_DATA_DIRECTORIES,
	LEGACY_LAYOUT,
	V5_LAYOUT,
	WORKSPACE_DATA_DIRECTORY,
	WORKSPACE_MANIFEST_PATH,
} from '../src/persistence/paths'
import {
	adapterResolutionBase,
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	resolveAndInstallWorkspaceAdapterSet,
	resolveWorkspaceAdapterSet,
	resolvedPathEntersWorkspaceDataDirectory,
	statFileIdentity,
	type AdapterApiCompatibilityPolicy,
	type AdapterManifestLoader,
	type AdapterRegistryInspector,
	type FileIdentity,
	type FileIdentityReader,
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

	it('refuses a bare specifier that resolves into a SIBLING Workspace data directory', async () => {
		const resolver = new NodeWorkspaceAdapterModuleResolver()
		// Two Workspaces share one enclosing package; node_modules/app symlinks back to that package.
		const base = await makeRoot()
		const pkg = join(base, 'packages', 'app')
		const wsA = join(pkg, 'ws-a')
		const wsB = join(pkg, 'ws-b')
		for (const ws of [wsA, wsB]) {
			await mkdir(join(ws, '.uiux'), { recursive: true })
			await writeFile(join(ws, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		}
		await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
		await mkdir(join(wsB, 'assets', 'u'), { recursive: true })
		await writeFile(join(wsB, 'assets', 'u', 'x.mjs'), 'export const marker = true\n')
		await mkdir(join(wsB, 'lib'), { recursive: true })
		await writeFile(join(wsB, 'lib', 'ok.mjs'), 'export const marker = true\n')
		await mkdir(join(base, 'node_modules'), { recursive: true })
		await symlink(pkg, join(base, 'node_modules', 'app'))

		// From ws-a, reaching ws-b's assets/ through the shared package is refused.
		await expect(resolver.resolve(wsA, 'app/ws-b/assets/u/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		// A non-data directory of the sibling Workspace is not a data directory, so it stays resolvable.
		const ok = await resolver.resolve(wsA, 'app/ws-b/lib/ok.mjs')
		expect(ok.resolvedPath).toBe(join(wsB, 'lib', 'ok.mjs'))
	})

	it('refuses a specifier that resolves into an ENCLOSING Workspace data directory', async () => {
		const resolver = new NodeWorkspaceAdapterModuleResolver()
		// Workspace B encloses the selected Workspace A; B is itself a package reachable by name.
		const outer = await makeRoot()
		await mkdir(join(outer, '.uiux'), { recursive: true })
		await writeFile(join(outer, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		await writeFile(join(outer, 'package.json'), JSON.stringify({ name: 'outer', type: 'module' }))
		await mkdir(join(outer, 'assets', 'u'), { recursive: true })
		await writeFile(join(outer, 'assets', 'u', 'x.mjs'), 'export const marker = true\n')
		await mkdir(join(outer, '.uiux', 'nested'), { recursive: true })
		await writeFile(join(outer, '.uiux', 'nested', 'y.mjs'), 'export const marker = true\n')
		await mkdir(join(outer, 'lib'), { recursive: true })
		await writeFile(join(outer, 'lib', 'ok.mjs'), 'export const marker = true\n')
		const inner = join(outer, 'packages', 'app')
		await mkdir(join(inner, '.uiux'), { recursive: true })
		await writeFile(join(inner, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		await mkdir(join(outer, 'node_modules'), { recursive: true })
		await symlink(outer, join(outer, 'node_modules', 'outer'))

		// From the inner Workspace, reaching the enclosing Workspace's assets/ and .uiux/ is refused.
		await expect(resolver.resolve(inner, 'outer/assets/u/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		await expect(resolver.resolve(inner, 'outer/.uiux/nested/y.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		// The enclosing Workspace's non-data directory still resolves.
		const ok = await resolver.resolve(inner, 'outer/lib/ok.mjs')
		expect(ok.resolvedPath).toBe(join(outer, 'lib', 'ok.mjs'))
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

describe('Canonical Workspace data-directory membership is decided by file identity', () => {
	const root = '/virtual/ws'
	const identity = (dev: number, ino: number): FileIdentity => ({ dev: BigInt(dev), ino: BigInt(ino) })
	const readerFor = (entries: ReadonlyMap<string, FileIdentity>): FileIdentityReader =>
		async path => entries.get(path)

	it('refuses a non-canonical-case segment whose inode matches a canonical data directory', async () => {
		// `assets` and `ASSETS` share one inode (a case-insensitive volume). A name comparison would
		// miss `ASSETS`; identity catches it. This holds on any OS because `stat` is injected.
		const reader = readerFor(new Map([
			[join(root, 'ASSETS'), identity(1, 42)],
			[join(root, 'assets'), identity(1, 42)],
		]))
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'ASSETS', 'u', 'x.mjs'), root, reader)).toBe(true)
	})

	it('allows a top-level segment that is not identical to any canonical data directory', async () => {
		const reader = readerFor(new Map([
			[join(root, 'docs'), identity(1, 7)],
			[join(root, 'assets'), identity(1, 42)],
		]))
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'docs', 'x.mjs'), root, reader)).toBe(false)
	})

	it('fails closed when an identity read errors with anything other than absence', async () => {
		const reader: FileIdentityReader = async () => {
			const error = new Error('permission denied') as NodeJS.ErrnoException
			error.code = 'EACCES'
			throw error
		}
		await expect(resolvedPathEntersWorkspaceDataDirectory(join(root, 'assets', 'x.mjs'), root, reader))
			.rejects.toThrow(/permission denied/)
	})

	it('treats a genuinely absent path as not inside a data directory via the default reader', async () => {
		expect(await statFileIdentity(join(root, 'definitely-missing'))).toBeUndefined()
	})

	const runsAsRoot = process.getuid?.() === 0
	const chmodUnsupported = process.platform === 'win32'
	it.skipIf(runsAsRoot || chmodUnsupported)('default statFileIdentity rejects (does not swallow) a permission error', async () => {
		// Guards against a regression where statFileIdentity reverts to treating every error as absence.
		const base = await mkdtemp(join(tmpdir(), 'uiux-stat-perm-'))
		temporaryRoots.push(base)
		const locked = join(base, 'locked')
		await mkdir(locked)
		await writeFile(join(locked, 'x.mjs'), 'export const marker = true\n')
		await chmod(locked, 0o000)
		try {
			await expect(statFileIdentity(join(locked, 'x.mjs'))).rejects.toMatchObject({ code: 'EACCES' })
		}
		finally {
			await chmod(locked, 0o700)
		}
	})

	it('derives both exports from the same source of truth and excludes adapters/', () => {
		expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).toEqual(Object.values(WORKSPACE_DATA_DIRECTORY))
		expect(CANONICAL_WORKSPACE_DATA_DIRECTORIES).not.toContain('adapters')
	})
})

describe('the data boundary of a schemaVersion 5 Workspace root (only kit/ may hold Adapter code)', () => {
	const MODULE = 'export const marker = true\n'
	const V5_MANIFEST = JSON.stringify({ schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
	const KIT = JSON.stringify({ designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} })
	/**
	 * A resolver given the below-5 base (the Workspace root) on purpose, so specifiers reach every
	 * path of a v5 root: these tests prove the data boundary alone holds, whatever the base. The
	 * resolver of a v5 Workspace resolves from kit/ (see the next describe block).
	 */
	const rootBasedResolver = () => new NodeWorkspaceAdapterModuleResolver({ layout: LEGACY_LAYOUT })

	async function v5Root(root: string): Promise<string> {
		await mkdir(root, { recursive: true })
		await writeFile(join(root, 'workspace.json'), V5_MANIFEST)
		await writeFile(join(root, 'product-kit.json'), KIT)
		return root
	}

	async function put(path: string): Promise<string> {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, MODULE)
		return path
	}

	it('refuses every path of a selected v5 root but kit/, also through a symlink out of kit/', async () => {
		const root = await v5Root(await makeRoot())
		const resolver = rootBasedResolver()
		const ok = await put(join(root, 'kit', 'dist', 'uiux.mjs'))
		expect((await resolver.resolve(root, './kit/dist/uiux.mjs')).resolvedPath).toBe(ok)
		for (const relative of ['views/x.mjs', 'flows/x.mjs', 'reviews/x.mjs', 'i18n/x.mjs', 'assets/u/x.mjs', 'artifacts/sha256/ab/x.mjs', 'history/checkpoints/x.mjs', '.transactions/t/staged/x.mjs', 'adapter.mjs', 'lib/x.mjs']) {
			await put(join(root, relative))
			await expect(resolver.resolve(root, `./${relative}`), relative).rejects.toThrow(/canonical Workspace data directory/i)
		}
		await symlink(join(root, 'views', 'x.mjs'), join(root, 'kit', 'linked.mjs'))
		await expect(resolver.resolve(root, './kit/linked.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
	})

	it('keeps kit/ of a v5 root at the default <repo>/.uiux/ location reachable, and its data refused from elsewhere', async () => {
		const repo = await makeRoot()
		const root = await v5Root(join(repo, '.uiux'))
		await put(join(root, 'kit', 'adapter.mjs'))
		await put(join(root, 'views', 'x.mjs'))
		// <repo> holds `.uiux/workspace.json`, but that `.uiux/` is a relocated root, not old-layout metadata.
		const resolver = rootBasedResolver()
		expect((await resolver.resolve(root, './kit/adapter.mjs')).resolvedPath).toBe(join(root, 'kit', 'adapter.mjs'))
		// Another Workspace reaching into it through a package symlink.
		const other = await makeRoot()
		await mkdir(join(other, 'node_modules'), { recursive: true })
		await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'repo', type: 'module' }))
		await symlink(repo, join(other, 'node_modules', 'repo'))
		await expect(resolver.resolve(other, 'repo/.uiux/views/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		expect((await resolver.resolve(other, 'repo/.uiux/kit/adapter.mjs')).resolvedPath).toBe(join(root, 'kit', 'adapter.mjs'))
	})

	it('refuses a sibling v5 root\'s data but not its kit/, and still refuses an old-layout .uiux/kit/', async () => {
		const base = await makeRoot()
		const pkg = join(base, 'packages', 'app')
		const selected = await v5Root(join(pkg, 'ws-a'))
		const sibling = await v5Root(join(pkg, 'ws-b'))
		await put(join(sibling, 'assets', 'u', 'x.mjs'))
		await put(join(sibling, 'kit', 'ok.mjs'))
		const legacy = join(pkg, 'ws-old')
		await mkdir(join(legacy, '.uiux'), { recursive: true })
		await writeFile(join(legacy, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		await put(join(legacy, '.uiux', 'kit', 'x.mjs'))
		await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'app', type: 'module' }))
		await mkdir(join(base, 'node_modules'), { recursive: true })
		await symlink(pkg, join(base, 'node_modules', 'app'))
		const resolver = rootBasedResolver()
		await expect(resolver.resolve(selected, 'app/ws-b/assets/u/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		expect((await resolver.resolve(selected, 'app/ws-b/kit/ok.mjs')).resolvedPath).toBe(join(sibling, 'kit', 'ok.mjs'))
		// Below schemaVersion 5 the whole .uiux/ stays data (Clause 01a115cd-d109, below-5 half).
		await expect(resolver.resolve(selected, 'app/ws-old/.uiux/kit/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
	})

	it('does not treat another tool\'s workspace.json alone as a Workspace root', async () => {
		const base = await makeRoot()
		const tool = join(base, 'tool')
		await mkdir(tool, { recursive: true })
		await writeFile(join(tool, 'workspace.json'), JSON.stringify({ version: 2, projects: {} }))
		await writeFile(join(tool, 'package.json'), JSON.stringify({ name: 'tool', type: 'module' }))
		await put(join(tool, 'views', 'x.mjs'))
		const selected = await v5Root(join(base, 'ws'))
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(tool, 'views', 'x.mjs'), selected)).toBe(false)
	})

	it('treats a directory whose name begins with two dots as inside the root', async () => {
		const resolver = rootBasedResolver()
		const root = await v5Root(await makeRoot())
		await put(join(root, '..dotted', 'x.mjs'))
		await expect(resolver.resolve(root, './..dotted/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, '..dotted', 'x.mjs'), root)).toBe(true)
		// In the old layout such a directory is an ordinary local directory, not an escape.
		const legacy = await makeRoot()
		const local = await put(join(legacy, '..dotted', 'adapter.mjs'))
		expect((await resolver.resolve(legacy, './..dotted/adapter.mjs')).resolvedPath).toBe(local)
	})

	it('does not accept a symbolic link named kit as the code directory', async () => {
		const root = await v5Root(await makeRoot())
		await put(join(root, 'views', 'x.mjs'))
		await symlink(join(root, 'views'), join(root, 'kit'))
		await expect(rootBasedResolver().resolve(root, './kit/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'views', 'x.mjs'), root)).toBe(true)
		// The resolver of the v5 Workspace refuses the linked kit/ as its base before resolving anything.
		await expect(new NodeWorkspaceAdapterModuleResolver().resolve(root, './x.mjs')).rejects.toThrow(/no kit\/ directory/i)
	})

	it('refuses ./kit/ when kit is a symbolic link to artifacts/, a directory outside the old-layout data directories', async () => {
		const root = await v5Root(await makeRoot())
		await put(join(root, 'artifacts', 'x.mjs'))
		await symlink(join(root, 'artifacts'), join(root, 'kit'))
		await expect(rootBasedResolver().resolve(root, './kit/x.mjs')).rejects.toThrow(/canonical Workspace data directory/i)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'artifacts', 'x.mjs'), root)).toBe(true)
		// Followed through the link, kit/ would look like artifacts/ itself: only the lstat reader keeps it out.
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'artifacts', 'x.mjs'), root, statFileIdentity, statFileIdentity)).toBe(false)
	})

	it('decides kit/ membership by file identity', async () => {
		const root = '/virtual/v5'
		const identity = (dev: number, ino: number): FileIdentity => ({ dev: BigInt(dev), ino: BigInt(ino) })
		const reader: FileIdentityReader = async path => new Map([
			[join(root, 'workspace.json'), identity(1, 1)],
			[join(root, 'product-kit.json'), identity(1, 2)],
			[join(root, 'kit'), identity(1, 3)],
			[join(root, 'KIT'), identity(1, 3)],
			[join(root, 'views'), identity(1, 4)],
			[join(root, 'Kit2'), identity(1, 5)],
		]).get(path)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'KIT', 'x.mjs'), root, reader, reader)).toBe(false)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'Kit2', 'x.mjs'), root, reader, reader)).toBe(true)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'views', 'x.mjs'), root, reader, reader)).toBe(true)
		// An unselected v5 root met on the way up is a boundary too.
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'Kit2', 'x.mjs'), '/elsewhere', reader, reader)).toBe(true)
		expect(await resolvedPathEntersWorkspaceDataDirectory(join(root, 'kit', 'x.mjs'), '/elsewhere', reader, reader)).toBe(false)
	})
})

describe('Adapter resolution from kit/ in a schemaVersion 5 Workspace (Clause 01a115cd-d109, from-5 half)', () => {
	const MODULE = 'export const marker = true\n'
	const V5_MANIFEST = JSON.stringify({ schemaVersion: 5, i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} })
	const KIT = JSON.stringify({ designSystems: [], adapters: [], styles: [], themes: {}, components: {}, widgets: {} })

	/** A v5 Workspace root with an empty kit/ (the resolver detects the layout from its manifest). */
	async function v5Workspace(root: string): Promise<string> {
		await mkdir(join(root, 'kit'), { recursive: true })
		await writeFile(join(root, 'workspace.json'), V5_MANIFEST)
		await writeFile(join(root, 'product-kit.json'), KIT)
		return root
	}

	async function put(path: string, content = MODULE): Promise<string> {
		await mkdir(dirname(path), { recursive: true })
		await writeFile(path, content)
		return path
	}

	async function putJson(path: string, value: unknown): Promise<string> {
		return put(path, JSON.stringify(value))
	}

	/** A package `<directory>` with `package.json` fields (by default `main` is its `index.mjs`) and that `index.mjs`. */
	async function putPackage(directory: string, fields: Record<string, unknown>): Promise<string> {
		await putJson(join(directory, 'package.json'), { type: 'module', main: './index.mjs', ...fields })
		return put(join(directory, 'index.mjs'))
	}

	const resolver = () => new NodeWorkspaceAdapterModuleResolver()

	it('resolves a ./ specifier from kit/, never from the Workspace root (minimal form: no kit package file)', async () => {
		const root = await v5Workspace(await makeRoot())
		const inKit = await put(join(root, 'kit', 'adapter.mjs'))
		await put(join(root, 'adapter.mjs'))
		expect((await resolver().resolve(root, './adapter.mjs')).resolvedPath).toBe(inKit)
		expect((await new NodeWorkspaceAdapterModuleResolver({ layout: V5_LAYOUT }).resolve(root, './adapter.mjs')).resolvedPath).toBe(inKit)
		const nested = await put(join(root, 'kit', 'src', 'wrapper', 'uiux.mjs'))
		expect((await resolver().resolve(root, './src/wrapper/uiux.mjs')).resolvedPath).toBe(nested)
		// The root-relative spelling of the same file names kit/kit/…, which does not exist.
		await expect(resolver().resolve(root, './kit/adapter.mjs')).rejects.toThrow()
		// A directory whose name begins with two dots is inside kit/, not an escape.
		const dotted = await put(join(root, 'kit', '..dotted', 'x.mjs'))
		expect((await resolver().resolve(root, './..dotted/x.mjs')).resolvedPath).toBe(dotted)
	})

	it('refuses resolution when kit/ is missing or is not a real directory', async () => {
		const missing = await makeRoot()
		await writeFile(join(missing, 'workspace.json'), V5_MANIFEST)
		await writeFile(join(missing, 'product-kit.json'), KIT)
		await put(join(missing, 'adapter.mjs'))
		await expect(resolver().resolve(missing, './adapter.mjs')).rejects.toThrow(/no kit\/ directory/i)
		await rm(join(missing, 'adapter.mjs'))
		await writeFile(join(missing, 'kit'), MODULE)
		await expect(resolver().resolve(missing, './adapter.mjs')).rejects.toThrow(/no kit\/ directory/i)
	})

	it('keeps a ./ specifier inside kit/, as written and by its real path', async () => {
		const root = await v5Workspace(await makeRoot())
		await put(join(root, 'views', 'x.mjs'))
		await put(join(root, 'lib', 'x.mjs'))
		await put(join(root, 'adapter.mjs'))
		for (const specifier of ['./../views/x.mjs', './../adapter.mjs', './src/../../lib/x.mjs', './.'])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/escapes kit\//i)
		// Percent-encoded dot segments pass the lexical check but resolve, as URLs, out of kit/.
		await mkdir(join(root, 'kit', 'src'), { recursive: true })
		await expect(resolver().resolve(root, './src/%2e%2e/%2e%2e/views/x.mjs')).rejects.toThrow(/resolves outside kit\//i)
		// A file link and a directory link out of kit/.
		await symlink(join(root, 'views', 'x.mjs'), join(root, 'kit', 'linked.mjs'))
		await expect(resolver().resolve(root, './linked.mjs')).rejects.toThrow(/resolves outside kit\//i)
		await symlink(join(root, 'lib'), join(root, 'kit', 'lib'))
		await expect(resolver().resolve(root, './lib/x.mjs')).rejects.toThrow(/resolves outside kit\//i)
	})

	it('keeps a ./ specifier outside kit/node_modules/, as written, by its real path and by identity', async () => {
		const root = await v5Workspace(await makeRoot())
		await putPackage(join(root, 'kit', 'node_modules', 'pkg'), { name: 'pkg' })
		for (const specifier of ['./node_modules/pkg/index.mjs', './NODE_MODULES/pkg/index.mjs', './src/../node_modules/pkg/index.mjs'])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/names a file in kit\/node_modules\//i)
		await mkdir(join(root, 'kit', 'src'), { recursive: true })
		await symlink(join(root, 'kit', 'node_modules', 'pkg', 'index.mjs'), join(root, 'kit', 'src', 'linked.mjs'))
		await expect(resolver().resolve(root, './src/linked.mjs')).rejects.toThrow(/resolves inside kit\/node_modules\//i)

		// node_modules linked to another directory of kit/: that directory is the dependency directory.
		const other = await v5Workspace(await makeRoot())
		await putPackage(join(other, 'kit', 'deps', 'pkg'), { name: 'pkg' })
		await symlink(join(other, 'kit', 'deps'), join(other, 'kit', 'node_modules'))
		await expect(resolver().resolve(other, './deps/pkg/index.mjs')).rejects.toThrow(/resolves inside kit\/node_modules\//i)
	})

	it('resolves a bare specifier only when kit/package.json declares its package (the dependency guard)', async () => {
		const root = await v5Workspace(await makeRoot())
		const modules = join(root, 'kit', 'node_modules')
		const declared = await putPackage(join(modules, '@fixture', 'declared'), {
			name: '@fixture/declared', version: '2.3.0', exports: { '.': './index.mjs', './sub': './sub.mjs' },
		})
		const sub = await put(join(modules, '@fixture', 'declared', 'sub.mjs'))
		const devOnly = await putPackage(join(modules, 'dev-only'), { name: 'dev-only' })
		await putPackage(join(modules, 'legacy-main'), { name: 'legacy-main', main: './index.mjs' })
		await putPackage(join(modules, 'undeclared'), { name: 'undeclared' })
		await putPackage(join(modules, 'legacy-main-evil'), { name: 'legacy-main-evil' })

		// Without kit/package.json no package is declared.
		await expect(resolver().resolve(root, '@fixture/declared')).rejects.toThrow(/does not declare/i)

		await putJson(join(root, 'kit', 'package.json'), {
			private: true,
			dependencies: { '@fixture/declared': '^2.3.0', 'legacy-main': '1.0.0' },
			devDependencies: { 'dev-only': '1.0.0' },
			imports: { '#internal': './internal.mjs' },
		})
		await put(join(root, 'kit', 'internal.mjs'))
		const resolved = await resolver().resolve(root, '@fixture/declared')
		expect(resolved).toMatchObject({ resolvedPath: declared, packageName: '@fixture/declared', packageVersion: '2.3.0' })
		expect((await resolver().resolve(root, '@fixture/declared/sub')).resolvedPath).toBe(sub)
		expect((await resolver().resolve(root, 'dev-only')).resolvedPath).toBe(devOnly)

		for (const specifier of [
			'undeclared',
			'legacy-main-evil',
			'@fixture/undeclared',
		])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/does not declare/i)
		// A subpath that would walk from a declared package to an undeclared one, and a `#` import.
		for (const specifier of [
			'legacy-main/../undeclared/index.mjs',
			'legacy-main/%2e%2e/undeclared/index.mjs',
			'legacy-main/./index.mjs',
			'legacy-main/',
			'#internal',
			'@fixture',
		])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/does not name an npm package/i)
	})

	it('fails closed when kit/package.json is malformed or is not a regular file', async () => {
		const root = await v5Workspace(await makeRoot())
		await putPackage(join(root, 'kit', 'node_modules', 'dep'), { name: 'dep' })
		const packageFile = join(root, 'kit', 'package.json')
		for (const content of [
			'{',
			'[]',
			JSON.stringify({ dependencies: ['dep'] }),
			// A malformed member fails the whole file, even when another member declares the package.
			JSON.stringify({ dependencies: 'dep', devDependencies: { dep: '1.0.0' } }),
		]) {
			await writeFile(packageFile, content)
			await expect(resolver().resolve(root, 'dep'), content).rejects.toThrow(/kit\/package\.json (could not be read|is not a JSON object|member)/i)
		}
		// A link standing in for the package file (here to a data file an Editor could write) is refused.
		await rm(packageFile)
		await putJson(join(root, 'views', 'deps.json'), { dependencies: { dep: '1.0.0' } })
		await symlink(join(root, 'views', 'deps.json'), packageFile)
		await expect(resolver().resolve(root, 'dep')).rejects.toThrow(/not a regular file/i)
	})

	it('refuses a declared package whose main, exports target or link leads into the Workspace root outside kit/', async () => {
		const root = await v5Workspace(await makeRoot())
		const modules = join(root, 'kit', 'node_modules')
		await put(join(root, 'views', 'x.mjs'))
		await put(join(root, 'lib', 'x.mjs'))
		await put(join(root, 'assets', 'u', 'index.mjs'))
		await putJson(join(root, 'assets', 'u', 'package.json'), { name: 'linked-into-data', type: 'module', main: './index.mjs' })
		const kitSource = await put(join(root, 'kit', 'src', 'a.mjs'))
		await putJson(join(root, 'kit', 'src', 'package.json'), { name: 'linked-into-kit', type: 'module', main: './a.mjs' })
		await putJson(join(modules, 'main-into-data', 'package.json'), { name: 'main-into-data', main: '../../../views/x.mjs' })
		await putJson(join(modules, 'main-into-root', 'package.json'), { name: 'main-into-root', main: '../../../lib/x.mjs' })
		await putJson(join(modules, 'main-into-kit', 'package.json'), { name: 'main-into-kit', main: '../../src/a.mjs' })
		await putJson(join(modules, 'exports-dotdot', 'package.json'), { name: 'exports-dotdot', exports: { '.': '../../../views/x.mjs' } })
		await putJson(join(modules, 'exports-link', 'package.json'), { name: 'exports-link', exports: { '.': './entry.mjs' } })
		await symlink(join(root, 'views', 'x.mjs'), join(modules, 'exports-link', 'entry.mjs'))
		await symlink(join(root, 'assets', 'u'), join(modules, 'linked-into-data'))
		await symlink(join(root, 'kit', 'src'), join(modules, 'linked-into-kit'))
		await putPackage(join(root, 'node_modules', 'hoisted-in-root'), { name: 'hoisted-in-root' })
		const names = ['main-into-data', 'main-into-root', 'main-into-kit', 'exports-dotdot', 'exports-link', 'linked-into-data', 'linked-into-kit', 'hoisted-in-root']
		await putJson(join(root, 'kit', 'package.json'), { dependencies: Object.fromEntries(names.map(name => [name, '*'])) })

		for (const specifier of ['main-into-data', 'exports-link', 'linked-into-data'])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/outside kit\/|canonical Workspace data directory/i)
		for (const specifier of ['main-into-root', 'hoisted-in-root'])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/inside the selected Workspace root but outside kit\//i)
		// Node refuses an exports target that leaves its package before any path exists.
		await expect(resolver().resolve(root, 'exports-dotdot')).rejects.toThrow(/package target|exports/i)
		// A declared package may lead into kit/ itself (a linked kit package, a main into kit/src/).
		expect((await resolver().resolve(root, 'main-into-kit')).resolvedPath).toBe(kitSource)
		expect((await resolver().resolve(root, 'linked-into-kit')).resolvedPath).toBe(kitSource)
	})

	it('allows a declared package hoisted above the Workspace root, and still refuses an enclosing Workspace\'s data', async () => {
		const outer = await makeRoot()
		const root = await v5Workspace(join(outer, 'packages', 'app', '.uiux'))
		const hoisted = await putPackage(join(outer, 'node_modules', 'hoisted'), { name: 'hoisted' })
		await putJson(join(root, 'kit', 'package.json'), { dependencies: { hoisted: '*', 'into-outer-data': '*' } })
		expect((await resolver().resolve(root, 'hoisted')).resolvedPath).toBe(hoisted)

		// The directory above is an old-layout Workspace; a hoisted link into its assets/ is refused.
		await mkdir(join(outer, '.uiux'), { recursive: true })
		await writeFile(join(outer, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		await putPackage(join(outer, 'assets', 'pkg'), { name: 'into-outer-data' })
		await symlink(join(outer, 'assets', 'pkg'), join(outer, 'node_modules', 'into-outer-data'))
		await expect(resolver().resolve(root, 'into-outer-data')).rejects.toThrow(/canonical Workspace data directory/i)
	})

	it('refuses a module in the data of a Workspace nested inside kit/', async () => {
		const root = await v5Workspace(await makeRoot())
		const nestedV5 = await v5Workspace(join(root, 'kit', 'vendor'))
		await put(join(nestedV5, 'views', 'x.mjs'))
		const nestedOld = join(root, 'kit', 'old')
		await mkdir(join(nestedOld, '.uiux'), { recursive: true })
		await writeFile(join(nestedOld, WORKSPACE_MANIFEST_PATH), JSON.stringify({ schemaVersion: CURRENT_WORKSPACE_SCHEMA_VERSION, i18n: { defaultLocale: 'en-US' }, adapters: [], viewports: {}, themes: {} }))
		await put(join(nestedOld, 'assets', 'u', 'x.mjs'))
		await put(join(nestedOld, '.uiux', 'x.mjs'))
		for (const specifier of ['./vendor/views/x.mjs', './old/assets/u/x.mjs', './old/.uiux/x.mjs'])
			await expect(resolver().resolve(root, specifier), specifier).rejects.toThrow(/canonical Workspace data directory/i)
		const nestedCode = await put(join(nestedV5, 'kit', 'ok.mjs'))
		expect((await resolver().resolve(root, './vendor/kit/ok.mjs')).resolvedPath).toBe(nestedCode)
	})

	it('keeps the selected root\'s non-kit paths out when the v5 layout is given for a root without its marker files', async () => {
		// Persistence passes its own layout; the boundary must not depend on the manifest and the
		// Product Kit file both being present for the data-boundary walk to recognize the root.
		const root = await makeRoot()
		await put(join(root, 'lib', 'x.mjs'))
		await putJson(join(root, 'kit', 'node_modules', 'main-into-root', 'package.json'), { name: 'main-into-root', main: '../../../lib/x.mjs' })
		await putJson(join(root, 'kit', 'package.json'), { dependencies: { 'main-into-root': '*' } })
		const v5 = new NodeWorkspaceAdapterModuleResolver({ layout: V5_LAYOUT })
		await expect(v5.resolve(root, 'main-into-root')).rejects.toThrow(/inside the selected Workspace root but outside kit\//i)
		const inKit = await put(join(root, 'kit', 'adapter.mjs'))
		expect((await v5.resolve(root, './adapter.mjs')).resolvedPath).toBe(inKit)
	})

	it('names the resolution base: kit/ from schemaVersion 5, the Workspace root below it', () => {
		expect(adapterResolutionBase('/w', V5_LAYOUT)).toBe(join('/w', 'kit'))
		expect(adapterResolutionBase('/w', LEGACY_LAYOUT)).toBe(join('/w'))
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
