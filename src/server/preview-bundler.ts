import { createHash, randomBytes } from 'node:crypto'
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

/** The output files that may name the bundle's URL: the module, the stylesheet and their source maps. */
const TEXT_OUTPUT_TYPES = new Set(['.js', '.css', '.map'])

/** UIUX's own package root (`src/adapters/package-root.ts`). */
export { resolvePackageRoot }

/** How many bundles the cache keeps: the current one and a few earlier ones a Preview may still load. */
const BUNDLE_CACHE_LIMIT = 8

/**
 * An input whose modification time is this close to the start of the build that read it, or later,
 * may have changed while esbuild read it, so its digest may not describe the bytes bundled (the
 * margin covers file systems that keep modification times to the second).
 */
const RACY_WINDOW_MS = 1000

/** The bundles built, by content hash, least recently used first. */
const bundleCache = new Map<string, PreviewBundleResult>()

/** One file of a bundle's module graph: its stat when its digest was taken, and the digest of its bytes. */
type GraphInput = { readonly path: string; size: number; mtimeMs: number; readonly digest: string }

/**
 * The module graph of the last bundle built from one input key: every file the build read for the
 * style entries and the Adapter modules, with the content hash computed from them. `racy` when an
 * input changed so close to the build that the bundle may hold other bytes than its digest: the next
 * use builds again.
 */
type BundleGraph = Readonly<{ hash: string; inputs: readonly GraphInput[]; racy: boolean }>

/** The last graph built, by input key, least recently used first. */
const graphCache = new Map<string, BundleGraph>()

/** The builds in flight, by input key, shared by their callers. */
const buildsInFlight = new Map<string, Promise<PreviewBundleResult>>()

/**
 * The input key of a bundle: the generated entry (the style entries, the Adapter modules and their
 * descriptors) and the build's roots, without reading any file.
 */
function bundleInputKey(input: Readonly<{ workspaceRoot: string; moduleBase?: string; packageRoot: string; entrySource: string; pin?: string }>): string {
	const hash = createHash('sha256')
	for (const part of [input.workspaceRoot, input.moduleBase ?? '', input.packageRoot, input.pin ?? '', input.entrySource])
		hash.update(`${part}\0`)
	return hash.digest('hex')
}

/**
 * The content hash of a bundle: the cache key and the URL segment its files are served under. It
 * covers the input key and, unless the bundle is pinned, the digest of every file in its module
 * graph (`readBundleGraph`), so a changed byte anywhere in the graph changes it. With `pin`, the
 * version of the kit build output generation the set was resolved from, no file is read: the bundle of
 * that generation stays in use until the next settled output, even when a failed build has changed
 * the files since (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 */
function contentHash(key: string, inputs: readonly GraphInput[]): string {
	const hash = createHash('sha256')
	hash.update(key)
	for (const input of inputs) hash.update(`\0${input.path}\0${input.digest}`)
	return hash.digest('hex').slice(0, 16)
}

export function clearPreviewBundleCache(): void {
	bundleCache.clear()
	graphCache.clear()
	buildsInFlight.clear()
}

/** A bundle already built, by its content hash, for serving its files. */
export async function cachedPreviewBundle(hash: string): Promise<PreviewBundleResult | undefined> {
	return bundleCache.get(hash)
}

/** Sets `key` as the most recently used entry of `cache`, dropping the least recently used ones over the limit. */
function remember<T>(cache: Map<string, T>, key: string, value: T): void {
	cache.delete(key)
	cache.set(key, value)
	while (cache.size > BUNDLE_CACHE_LIMIT) cache.delete(cache.keys().next().value!)
}

/**
 * The Workspace's Preview bundle. A bundle already built is reused while its module graph is
 * unchanged: each input is checked by its size and modification time, and one whose stat changed by
 * the digest of its bytes, so reuse builds nothing; a changed input builds the bundle again.
 */
export async function buildWorkspacePreviewBundle(input: Readonly<{
	workspaceRoot: string
	/**
	 * The Adapter resolution base (`adapterResolutionBase`): `kit/`. Its `node_modules/` is the
	 * Workspace entry of esbuild's `nodePaths`, the fallback consulted only after the `node_modules/`
	 * directories above each importing file.
	 */
	moduleBase?: string
	packageRoot?: string
	set: ValidatedAdapterSet
	/**
	 * The resolved paths of the Product Kit `styles` entries, in order: the generated entry imports
	 * them before the Adapter modules, so their CSS leads the stylesheet.
	 */
	styles?: readonly string[]
	/** The version (`outputVersion()`) of the kit build output generation the set was resolved from (`contentHash`). */
	pin?: string
}>): Promise<PreviewBundleResult> {
	const packageRoot = input.packageRoot ?? resolvePackageRoot()
	const styles = input.styles ?? []
	const browserRuntimePath = resolve(packageRoot, 'src/preview/browser-runtime.ts')
	const entrySource = generateBundleEntrySource(browserRuntimePath, input.set, styles)
	const key = bundleInputKey({ workspaceRoot: input.workspaceRoot, moduleBase: input.moduleBase, packageRoot, entrySource, pin: input.pin })

	if (input.pin !== undefined) {
		const hash = contentHash(key, [])
		const cached = bundleCache.get(hash)
		if (cached) {
			remember(bundleCache, hash, cached)
			return cached
		}
		return await shareBuild(key, async () => {
			const built = await buildBundle({ ...input, packageRoot, entrySource, browserRuntimePath })
			return built.finish(hash)
		})
	}

	const inFlight = buildsInFlight.get(key)
	if (inFlight) return await inFlight
	const graph = graphCache.get(key)
	if (graph && !graph.racy && await graphUnchanged(graph)) {
		const cached = bundleCache.get(graph.hash)
		if (cached) {
			remember(graphCache, key, graph)
			remember(bundleCache, graph.hash, cached)
			return cached
		}
	}
	return await shareBuild(key, async () => {
		// An entry that cannot be read fails the build with its own message, before esbuild runs.
		for (const entry of input.set.entries) await assertReadable(entry.resolvedModule.resolvedPath, 'adapter source')
		for (const style of styles) await assertReadable(style, 'style')
		const startedAt = Date.now()
		const built = await buildBundle({ ...input, packageRoot, entrySource, browserRuntimePath })
		const inputs = await readBundleGraph(built.metafile, built.workingDir, browserRuntimePath, startedAt)
		const hash = contentHash(key, inputs.inputs)
		remember(graphCache, key, { hash, inputs: inputs.inputs, racy: inputs.racy })
		return built.finish(hash)
	})
}

/** Runs the build for `key` unless one is in flight already, and keeps the bundle it builds. */
async function shareBuild(key: string, build: () => Promise<PreviewBundleResult>): Promise<PreviewBundleResult> {
	const inFlight = buildsInFlight.get(key)
	if (inFlight) return await inFlight
	const pending = build().then((bundle) => {
		remember(bundleCache, bundle.hash, bundle)
		return bundle
	})
	buildsInFlight.set(key, pending)
	try {
		return await pending
	}
	finally {
		if (buildsInFlight.get(key) === pending) buildsInFlight.delete(key)
	}
}

async function assertReadable(path: string, label: string): Promise<void> {
	try {
		await stat(path)
	}
	catch (error) {
		throw new Error(`Failed to read ${label} file at '${path}': ${error instanceof Error ? error.message : String(error)}`, { cause: error })
	}
}

/** Whether every input of `graph` still has the bytes it was digested from; an input whose stat is unchanged is not read. */
async function graphUnchanged(graph: BundleGraph): Promise<boolean> {
	const results = await Promise.all(graph.inputs.map(async (input) => {
		try {
			const before = await stat(input.path)
			if (before.size === input.size && before.mtimeMs === input.mtimeMs) return true
			if (sha256(await readFile(input.path)) !== input.digest) return false
			// The same bytes under a new stat: the next check need not read them again.
			input.size = before.size
			input.mtimeMs = before.mtimeMs
			return true
		}
		catch {
			return false
		}
	}))
	return results.every(Boolean)
}

/**
 * The module graph a build read for the style entries and the Adapter modules, from its metafile:
 * every input the generated entry reaches through them (modules, stylesheets, fonts and images,
 * however deep), sorted by path, with its stat and its digest. The UIUX browser runtime the entry
 * imports and the host packages the bundle aliases (`PREVIEW_HOST_PACKAGES`) are not followed; they
 * are UIUX's own files. `racy` when an input was modified at or after the build's start (`RACY_WINDOW_MS`)
 * or could not be read again.
 */
async function readBundleGraph(metafile: esbuild.Metafile, workingDir: string, browserRuntimePath: string, startedAt: number): Promise<{ inputs: GraphInput[]; racy: boolean }> {
	const hostPackages = new Set<string>(PREVIEW_HOST_PACKAGES)
	const reached = new Set<string>()
	const pending = ['<stdin>']
	while (pending.length > 0) {
		const imports = metafile.inputs[pending.pop()!]?.imports ?? []
		for (const edge of imports) {
			if (edge.external || reached.has(edge.path) || !(edge.path in metafile.inputs)) continue
			if (edge.original !== undefined && (hostPackages.has(edge.original) || edge.original === browserRuntimePath)) continue
			reached.add(edge.path)
			pending.push(edge.path)
		}
	}
	let racy = false
	const inputs: GraphInput[] = []
	// A namespaced input (`ns:path`) is not a file on disk; esbuild's file inputs are plain paths.
	for (const key of [...reached].filter(key => !(/^[a-z-]+:/iu.test(key) && !isAbsolute(key))).sort()) {
		const path = resolve(workingDir, key)
		try {
			const before = await stat(path)
			const digest = sha256(await readFile(path))
			if (before.mtimeMs >= startedAt - RACY_WINDOW_MS) racy = true
			inputs.push({ path, size: before.size, mtimeMs: before.mtimeMs, digest })
		}
		catch {
			racy = true
		}
	}
	return { inputs, racy }
}

function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex')
}

/** A bundle built and not yet named: `finish` gives it its content hash. */
type BuiltBundle = Readonly<{
	metafile: esbuild.Metafile
	/** The directory the metafile's input paths are relative to. */
	workingDir: string
	finish: (hash: string) => PreviewBundleResult
}>

async function buildBundle(input: Readonly<{
	workspaceRoot: string
	moduleBase?: string
	packageRoot: string
	entrySource: string
	browserRuntimePath: string
}>): Promise<BuiltBundle> {
	const { packageRoot, entrySource } = input

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

	// The content hash is known only once the build has listed its inputs, so the files are built
	// under a placeholder of the hash's length, replaced afterwards without moving any source map position.
	const placeholder = randomBytes(8).toString('hex')
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
		metafile: true,
		outdir,
		entryNames: 'runtime',
		assetNames: 'assets/[name]-[hash]',
		// Emitted files are referenced by absolute URL, so a module-imported image resolves from the
		// Preview document, not only from the stylesheet.
		publicPath: previewRuntimeFileUrl(placeholder, ''),
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

	const labels = sourceLabels(realWorkspaceRoot, await realpath(packageRoot).catch(() => packageRoot))
	return {
		metafile: buildResult.metafile,
		workingDir: realWorkspaceRoot,
		finish(hash) {
			const files = new Map<string, PreviewBundleFile>()
			for (const output of buildResult.outputFiles) {
				const path = relative(outdir, output.path).split(sep).join('/')
				const extension = extname(path).toLowerCase()
				let contents = output.contents
				if (TEXT_OUTPUT_TYPES.has(extension)) {
					const text = output.text.replaceAll(previewRuntimeFileUrl(placeholder, ''), previewRuntimeFileUrl(hash, ''))
					contents = extension === '.map' ? relabelSourceMap(text, outdir, labels) : new TextEncoder().encode(text)
				}
				files.set(path, { contents, contentType: OUTPUT_TYPES[extension] ?? 'application/octet-stream' })
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
		},
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

export const { mountPreviewRuntime, describeDeclaredWidgetEvents, describeAdapterDiagnostics } = createStandalonePreviewMount({
  adapterDescriptors,
});

if (typeof window !== 'undefined') {
  (window).__UIUX_PREVIEW_RUNTIME__ = { mountPreviewRuntime };
}
`
}
