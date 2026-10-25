import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createAdapterSourceResolver, MAX_EMBEDDED_SOURCE_BYTES } from '../src/application/services/adapter-sources'
import type { ValidatedAdapterEntry } from '../src/adapters/resolution'
import type { AdapterManifest } from '../src/domain/adapters/schema'
import { isContainedSourcePath, validateAdapterSources } from '../src/domain/adapters/sources'

const manifestWith = (sources?: unknown) => ({
	id: 'acme',
	apiVersion: '1',
	widgetPlugins: [],
	catalog: { widgets: {} },
	renderers: [],
	providers: [],
	...(sources === undefined ? {} : { sources }),
}) as unknown as AdapterManifest

describe('Adapter manifest sources (Clauses 01a11a5a-4511-… and 01a11a5a-45a7-…)', () => {
	it('accepts a manifest without sources and a valid mapping of an owned Widget type', () => {
		expect(validateAdapterSources(manifestWith(), ['Badge']).ok).toBe(true)
		const mapping = {
			Badge: {
				semantic: { path: 'src/badge.ts' },
				renderer: { path: 'src/Badge.vue', package: '@acme/ds', embed: false },
				designSystem: { url: 'https://example.com/badge' },
				supporting: [{ path: 'docs/badge.md' }, { url: 'http://example.com/x' }],
			},
		}
		expect(validateAdapterSources(manifestWith(mapping), ['Badge']).ok).toBe(true)
	})

	it.each([
		['a Widget type the Adapter does not own', { Other: { semantic: { path: 'a' }, renderer: { path: 'b' } } }],
		['a missing renderer', { Badge: { semantic: { path: 'a' } } }],
		['an unknown slot', { Badge: { semantic: { path: 'a' }, renderer: { path: 'b' }, extra: { path: 'c' } } }],
		['a path leaving its root', { Badge: { semantic: { path: '../a' }, renderer: { path: 'b' } } }],
		['an absolute path', { Badge: { semantic: { path: '/etc/passwd' }, renderer: { path: 'b' } } }],
		['a url with a path', { Badge: { semantic: { url: 'https://example.com', path: 'a' }, renderer: { path: 'b' } } }],
		['a non-http url', { Badge: { semantic: { url: 'javascript:alert(1)' }, renderer: { path: 'b' } } }],
		['a malformed package', { Badge: { semantic: { path: 'a', package: '../x' }, renderer: { path: 'b' } } }],
		['a non-boolean embed', { Badge: { semantic: { path: 'a', embed: 'no' }, renderer: { path: 'b' } } }],
		['a supporting entry that is not a list', { Badge: { semantic: { path: 'a' }, renderer: { path: 'b' }, supporting: { path: 'c' } } }],
		['sources that is not an object', ['Badge']],
	])('refuses %s as adapter.invalid_sources', (_name, sources) => {
		const result = validateAdapterSources(manifestWith(sources), ['Badge'])
		expect(result.ok).toBe(false)
		expect(result.diagnostics.length).toBeGreaterThan(0)
	})

	it('judges a path contained only when it is relative and has no empty, dot or parent segment', () => {
		expect(isContainedSourcePath('a/b.ts')).toBe(true)
		for (const bad of ['', '/a', 'a//b', './a', 'a/../b', '..', 'a\\b', 'C:/a', 'a\0b', 'a%2fb', 'a%2Fb', '%2e%2e/b', 'a%5cb'])
			expect(isContainedSourcePath(bad), bad).toBe(false)
	})
})

describe('Adapter source file resolution', () => {
	const roots: string[] = []
	afterEach(async () => {
		await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
	})
	async function temp(): Promise<string> {
		const root = await mkdtemp(join(tmpdir(), 'uiux-sources-'))
		roots.push(root)
		return root
	}
	const entryOf = (specifier: string, resolvedPath: string) => ({ selection: { moduleSpecifier: specifier }, resolvedModule: { resolvedPath } }) as unknown as ValidatedAdapterEntry
	/** A package Adapter `@acme/adapter` at `<base>/pkg` and a `./` Adapter over `<base>/kit`. */
	async function layout() {
		const base = await temp()
		await mkdir(join(base, 'pkg', 'dist'), { recursive: true })
		await mkdir(join(base, 'kit'), { recursive: true })
		await writeFile(join(base, 'pkg', 'package.json'), JSON.stringify({ name: '@acme/adapter', version: '3.0.0' }))
		await writeFile(join(base, 'pkg', 'dist', 'package.json'), JSON.stringify({ type: 'module' }))
		await writeFile(join(base, 'pkg', 'dist', 'index.js'), 'export {}')
		await writeFile(join(base, 'pkg', 'inside.txt'), 'inside')
		await writeFile(join(base, 'outside.txt'), 'outside')
		return {
			base,
			pkgEntry: entryOf('@acme/adapter', join(base, 'pkg', 'dist', 'index.js')),
			kitEntry: entryOf('./adapters/a.mjs', join(base, 'kit', 'a.mjs')),
			resolver: createAdapterSourceResolver(join(base, 'kit')),
		}
	}

	it('takes the nearest named package.json as the package root, not a nested type marker', async () => {
		const { pkgEntry, resolver } = await layout()
		const source = await resolver.resolve(pkgEntry, { path: 'inside.txt' })
		expect(source).toMatchObject({ availability: 'materialized', provenance: { package: '@acme/adapter', revision: '3.0.0' } })
	})

	it('resolves a ref naming the Adapter\'s own package against the Adapter root', async () => {
		const { pkgEntry, resolver } = await layout()
		const source = await resolver.resolve(pkgEntry, { package: '@acme/adapter', path: 'inside.txt' })
		expect(source).toMatchObject({ availability: 'materialized', provenance: { package: '@acme/adapter', path: 'inside.txt' } })
	})

	it('marks a symlinked file that leaves the root unavailable, and reads one that stays inside', async () => {
		const { base, kitEntry, resolver } = await layout()
		await symlink(join(base, 'outside.txt'), join(base, 'kit', 'escape.txt'))
		await writeFile(join(base, 'kit', 'real.txt'), 'real')
		await symlink(join(base, 'kit', 'real.txt'), join(base, 'kit', 'alias.txt'))
		expect((await resolver.resolve(kitEntry, { path: 'escape.txt' })).availability).toBe('unavailable')
		const alias = await resolver.resolve(kitEntry, { path: 'alias.txt' })
		expect(alias.availability).toBe('materialized')
		expect(new TextDecoder().decode(alias.bytes)).toBe('real')
	})

	it('treats a package ref whose root is a symlink as that package, and refuses a file link leaving it', async () => {
		const { base, kitEntry, resolver } = await layout()
		const real = join(base, 'store', 'ds')
		await mkdir(join(real, 'src'), { recursive: true })
		await writeFile(join(real, 'package.json'), JSON.stringify({ name: 'ds', version: '1.2.3' }))
		await writeFile(join(real, 'src', 'a.vue'), 'ds a')
		await symlink(join(base, 'outside.txt'), join(real, 'src', 'leak.vue'))
		await mkdir(join(base, 'kit', 'node_modules'), { recursive: true })
		await symlink(real, join(base, 'kit', 'node_modules', 'ds'))
		const inside = await resolver.resolve(kitEntry, { package: 'ds', path: 'src/a.vue' })
		expect(inside).toMatchObject({ availability: 'materialized', provenance: { package: 'ds', revision: '1.2.3' } })
		expect((await resolver.resolve(kitEntry, { package: 'ds', path: 'src/leak.vue' })).availability).toBe('unavailable')
	})

	it('marks a directory unavailable and a file over the size cap unavailable with its reason', async () => {
		const { base, kitEntry, resolver } = await layout()
		await mkdir(join(base, 'kit', 'dir'))
		await writeFile(join(base, 'kit', 'big.bin'), Buffer.alloc(MAX_EMBEDDED_SOURCE_BYTES + 1))
		await writeFile(join(base, 'kit', 'edge.bin'), Buffer.alloc(MAX_EMBEDDED_SOURCE_BYTES))
		expect((await resolver.resolve(kitEntry, { path: 'dir' })).availability).toBe('unavailable')
		expect(await resolver.resolve(kitEntry, { path: 'big.bin' })).toMatchObject({ availability: 'unavailable', provenance: { reason: 'too-large', maxBytes: MAX_EMBEDDED_SOURCE_BYTES } })
		expect((await resolver.resolve(kitEntry, { path: 'edge.bin' })).availability).toBe('materialized')
	})

	it.skipIf(process.platform === 'win32')('marks a FIFO unavailable without blocking', async () => {
		const { base, kitEntry, resolver } = await layout()
		execFileSync('mkfifo', [join(base, 'kit', 'pipe')])
		expect((await resolver.resolve(kitEntry, { path: 'pipe' })).availability).toBe('unavailable')
	})
})

describe('The Preview never reads Adapter source mappings', () => {
	it('names no `sources` member in the Preview runtime or in the bundle descriptor of an Adapter', async () => {
		// The Adapter module is bundled whole, so its own manifest literal is in the bundle; what the host
		// adds (the descriptor) and what the Preview runtime reads must never touch `sources`.
		const files = ['src/server/preview-bundler.ts', 'src/preview/browser-runtime.ts', 'src/preview/preview-runtime.ts']
		for (const file of files) {
			const text = await readFile(resolve(process.cwd(), file), 'utf8')
			expect(text, file).not.toMatch(/manifest\??\.sources|manifest\[['"]sources['"]\]|^\s*sources:/mu)
		}
	})
})
