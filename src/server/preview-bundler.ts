import { createHash } from 'node:crypto'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { resolve as resolveImport } from 'import-meta-resolve'

import { PREVIEW_HOST_PACKAGES } from '../adapters/adapter-graph-digest'
import { resolvePackageRoot } from '../adapters/package-root'
import type { ValidatedAdapterSet } from '../adapters/resolution'
import { BUNDLED_ASSET_TYPES } from '../adapters/style-imports'

/** One output file of a Preview bundle: its bytes and the media type it is served with. */
export type PreviewBundleFile = Readonly<{
	contents: Uint8Array
	contentType: string
}>

export type PreviewBundleResult = Readonly<{
	/** The bundle's JavaScript module, `PREVIEW_BUNDLE_ENTRY`, for evaluation on the server: without its source map link. */
	bundleJs: string
	/** The content hash: the cache key and the URL segment every file is served under. */
	hash: string
	/**
	 * Every output file, by its path under `/api/preview/runtime/<hash>/`: the JavaScript module,
	 * the stylesheet when the module graph has CSS, the emitted fonts and images, and the source maps
	 * (Rules 01a11bb1-acdc-799f-aed7-c85ddbaf0d28 and 01a11bb1-ae8c-721f-b1e4-f6936ffe5d5a).
	 */
	files: ReadonlyMap<string, PreviewBundleFile>
	/** The stylesheet's path in `files`, when the module graph imports any CSS. */
	stylesheet?: string
}>

/** The route the files of a Preview bundle are served under: `<route>/<hash>/<file>`. */
export const PREVIEW_RUNTIME_ROUTE = '/api/preview/runtime'
export const PREVIEW_BUNDLE_ENTRY = 'runtime.js'
export const PREVIEW_BUNDLE_STYLESHEET = 'runtime.css'

/** The URL a Preview bundle file is served at. */
export function previewRuntimeFileUrl(hash: string, file: string): string {
	return `${PREVIEW_RUNTIME_ROUTE}/${hash}/${file}`
}

/** The fonts and images a stylesheet or a module imports, emitted as files of the bundle. */
const FILE_LOADER_TYPES = BUNDLED_ASSET_TYPES

const OUTPUT_TYPES: Readonly<Record<string, string>> = Object.freeze({
	...FILE_LOADER_TYPES,
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
})

/** UIUX's own package root (`src/adapters/package-root.ts`). */
export { resolvePackageRoot }

/** How many bundles the cache keeps: the current one and a few earlier ones a Preview may still load. */
const BUNDLE_CACHE_LIMIT = 8

/** The bundles built, by content hash, oldest first; a build in flight is shared by its callers. */
const bundleCache = new Map<string, Promise<PreviewBundleResult>>()

/**
 * The bundle's cache key, over the Workspace root, every Adapter module and every style entry. With
 * `pin`, the kit build output generation the set was resolved from, the files are not read: the
 * bundle of that generation stays in use until the next settled output, even when a failed build
 * has changed the files since (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 */
export async function computeBundleContentHash(workspaceRoot: string, set: ValidatedAdapterSet, pin?: string, styles: readonly string[] = []): Promise<string> {
	const hash = createHash('sha256')
	hash.update(workspaceRoot)
	if (pin !== undefined) hash.update(`\0kit-build-output\0${pin}\0`)
	for (const entry of set.entries) {
		hash.update(entry.manifest.id)
		hash.update(entry.manifest.apiVersion)
		hash.update(entry.resolvedModule.resolvedPath)
		if (pin !== undefined) continue
		await hashFile(hash, entry.resolvedModule.resolvedPath, 'adapter source')
	}
	for (const style of styles) {
		hash.update(`\0style\0${style}\0`)
		if (pin !== undefined) continue
		await hashFile(hash, style, 'style')
	}
	return hash.digest('hex').slice(0, 16)
}

async function hashFile(hash: ReturnType<typeof createHash>, path: string, label: string): Promise<void> {
	try {
		const statResult = await stat(path)
		hash.update(String(statResult.mtimeMs))
		hash.update(await readFile(path))
	}
	catch (error) {
		throw new Error(`Failed to read ${label} file at '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error })
	}
}

export function clearPreviewBundleCache(): void {
	bundleCache.clear()
}

/** A bundle already built, by its content hash, for serving its files. */
export async function cachedPreviewBundle(hash: string): Promise<PreviewBundleResult | undefined> {
	return await bundleCache.get(hash)?.catch(() => undefined)
}

export async function buildWorkspacePreviewBundle(input: Readonly<{
	workspaceRoot: string
	/**
	 * The Adapter resolution base (`adapterResolutionBase`): `kit/` from `schemaVersion` 5, the
	 * Workspace root (the default) below it. Its `node_modules/` is the Workspace entry of esbuild's
	 * `nodePaths`, the fallback consulted only after the `node_modules/` directories above each
	 * importing file; so from `schemaVersion` 5 only that fallback is `kit/node_modules/` instead of
	 * the root's `node_modules/`.
	 */
	moduleBase?: string
	packageRoot?: string
	set: ValidatedAdapterSet
	/**
	 * The resolved paths of the Product Kit `styles` entries, in order: the generated entry imports
	 * them before the Adapter modules, so their CSS leads the stylesheet.
	 */
	styles?: readonly string[]
	/** The kit build output generation the set was resolved from (see `computeBundleContentHash`). */
	pin?: string
}>): Promise<PreviewBundleResult> {
	const packageRoot = input.packageRoot ?? resolvePackageRoot()
	const styles = input.styles ?? []
	const hash = await computeBundleContentHash(input.workspaceRoot, input.set, input.pin, styles)
	const cached = bundleCache.get(hash)
	if (cached) {
		// Most recently used last.
		bundleCache.delete(hash)
		bundleCache.set(hash, cached)
		return await cached
	}
	const built = buildBundle({ ...input, packageRoot, styles, hash })
	bundleCache.set(hash, built)
	built.catch(() => {
		if (bundleCache.get(hash) === built) bundleCache.delete(hash)
	})
	while (bundleCache.size > BUNDLE_CACHE_LIMIT) bundleCache.delete(bundleCache.keys().next().value!)
	return await built
}

async function buildBundle(input: Readonly<{
	workspaceRoot: string
	moduleBase?: string
	packageRoot: string
	set: ValidatedAdapterSet
	styles: readonly string[]
	hash: string
}>): Promise<PreviewBundleResult> {
	const { packageRoot, hash } = input
	const browserRuntimePath = resolve(packageRoot, 'src/preview/browser-runtime.ts')
	const entrySource = generateBundleEntrySource(browserRuntimePath, input.set, input.styles)

	const packageFileUrl = pathToFileURL(resolve(packageRoot, 'package.json')).href
	// The host packages resolve to UIUX's own copies, one for every Adapter (`PREVIEW_HOST_PACKAGES`,
	// which an Adapter's content digest leaves out for the same reason).
	const hostPaths = new Map<string, string>(PREVIEW_HOST_PACKAGES.map(name => [name, fileURLToPath(resolveImport(name, packageFileUrl))]))
	// esbuild runs the filter as a Go regular expression, without flags; the names hold no metacharacter.
	const hostFilter = new RegExp(`^(?:${PREVIEW_HOST_PACKAGES.join('|')})$`)

	const coreResolvePlugin: esbuild.Plugin = {
		name: 'uiux-core-resolve',
		setup(build) {
			build.onResolve({ filter: hostFilter }, args => ({ path: hostPaths.get(args.path)! }))
		},
	}

	// Nothing is written: `outdir` only names where the output files lie relative to each other.
	const outdir = join(input.moduleBase ?? input.workspaceRoot, '.uiux-preview-bundle')
	const realWorkspaceRoot = await realpath(input.workspaceRoot).catch(() => resolve(input.workspaceRoot))
	const buildResult = await esbuild.build({
		// esbuild names a file in its messages relative to this directory, so a build error names a
		// Workspace file by its path inside the Workspace, never through the host's directories.
		absWorkingDir: realWorkspaceRoot,
		stdin: {
			contents: entrySource,
			resolveDir: packageRoot,
			loader: 'ts',
		},
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minifyWhitespace: true,
		legalComments: 'none',
		write: false,
		outdir,
		entryNames: 'runtime',
		assetNames: 'assets/[name]-[hash]',
		// Emitted files are referenced by absolute URL, so a module-imported image resolves from the
		// Preview document, not only from the stylesheet.
		publicPath: `${PREVIEW_RUNTIME_ROUTE}/${hash}/`,
		sourcemap: 'linked',
		loader: Object.fromEntries(Object.keys(FILE_LOADER_TYPES).map(extension => [extension, 'file' as const])),
		logLevel: 'silent',
		nodePaths: [
			join(packageRoot, 'node_modules'),
			join(input.moduleBase ?? input.workspaceRoot, 'node_modules'),
		],
		plugins: [coreResolvePlugin],
		define: {
			[['process', 'env', 'NODE_ENV'].join('.')]: JSON.stringify('production'),
		},
	})

	const files = new Map<string, PreviewBundleFile>()
	const labels = sourceLabels(realWorkspaceRoot, await realpath(packageRoot).catch(() => packageRoot))
	for (const output of buildResult.outputFiles) {
		const path = relative(outdir, output.path).split(sep).join('/')
		const contents = path.endsWith('.map') ? relabelSourceMap(output.text, outdir, labels) : output.contents
		files.set(path, { contents, contentType: OUTPUT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' })
	}
	// Evaluated on the server, the module has no source map to load: its link names a served URL.
	const bundleJs = new TextDecoder().decode(files.get(PREVIEW_BUNDLE_ENTRY)?.contents ?? new Uint8Array())
		.replace(/\n\/\/# sourceMappingURL=\S+\n?$/u, '\n')
	return {
		bundleJs,
		hash,
		files,
		...(files.has(PREVIEW_BUNDLE_STYLESHEET) ? { stylesheet: PREVIEW_BUNDLE_STYLESHEET } : {}),
	}
}

type SourceLabel = Readonly<{ base: string; label: string }>

/** The Workspace first, then UIUX: a source map names a source by one of these, never by its host path. */
function sourceLabels(workspaceRoot: string, packageRoot: string): readonly SourceLabel[] {
	return [
		{ base: resolve(workspaceRoot), label: 'workspace' },
		{ base: resolve(packageRoot), label: 'uiux' },
	]
}

/**
 * Rewrites a source map so it names no host path. A source inside the Workspace or UIUX's package
 * reads `<label>:///<path inside it>`, any other one `external:///<file name>`. The generated entry
 * (`<stdin>`) imports every style and Adapter module by its absolute path, so its `sourcesContent`
 * is dropped.
 */
function relabelSourceMap(text: string, outdir: string, labels: readonly SourceLabel[]): Uint8Array {
	const map = JSON.parse(text) as { sources?: unknown; sourcesContent?: unknown }
	if (Array.isArray(map.sources) && Array.isArray(map.sourcesContent)) {
		const contents = map.sourcesContent
		map.sources.forEach((source: unknown, index: number) => {
			if (source === '<stdin>' && index < contents.length) contents[index] = null
		})
	}
	if (Array.isArray(map.sources)) {
		map.sources = map.sources.map((source: unknown) => {
			if (typeof source !== 'string' || source === '<stdin>') return source
			const absolute = resolve(outdir, source)
			for (const { base, label } of labels) {
				const inside = relative(base, absolute)
				if (inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
					return `${label}:///${inside.split(sep).join('/')}`
			}
			return `external:///${basename(absolute)}`
		})
	}
	return new TextEncoder().encode(JSON.stringify(map))
}

function generateBundleEntrySource(browserRuntimePath: string, set: ValidatedAdapterSet, styles: readonly string[]): string {
	// The style entries first, then the Adapter modules (Rule 01a11bb1-acdc-799f-aed7-c85ddbaf0d28).
	const imports: string[] = styles.map(style => `import ${JSON.stringify(style)};`)
	imports.push(`import { createStandalonePreviewMount } from ${JSON.stringify(browserRuntimePath)};`)

	set.entries.forEach((entry, i) => {
		imports.push(`import * as adapter_${i} from ${JSON.stringify(entry.resolvedModule.resolvedPath)};`)
	})

	const descriptors = set.entries.map((entry, i) => `  {
    index: ${entry.index},
    id: ${JSON.stringify(entry.manifest.id)},
    apiVersion: ${JSON.stringify(entry.manifest.apiVersion)},
    widgetTypes: ${JSON.stringify(entry.ownership.widgetTypes)},
    rendererKeys: ${JSON.stringify(entry.ownership.rendererKeys)},
    namespace: adapter_${i},
  }`).join(',\n')

	return `${imports.join('\n')}

const adapterDescriptors = [
${descriptors}
];

export const { mountPreviewRuntime, describeDeclaredWidgetEvents } = createStandalonePreviewMount({
  adapterDescriptors,
});

if (typeof window !== 'undefined') {
  (window).__UIUX_PREVIEW_RUNTIME__ = { mountPreviewRuntime };
}
`
}
