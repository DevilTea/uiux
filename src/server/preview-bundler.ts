import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import esbuild from 'esbuild'
import { resolve as resolveImport } from 'import-meta-resolve'

import type { ValidatedAdapterSet } from '../adapters/resolution'

export type PreviewBundleResult = Readonly<{
	bundleJs: string
	hash: string
}>

export function resolvePackageRoot(): string {
	if (process.env.UIUX_PACKAGE_ROOT) {
		return resolve(process.env.UIUX_PACKAGE_ROOT)
	}
	let dir = dirname(fileURLToPath(import.meta.url))
	while (true) {
		try {
			const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string }
			if (pkg.name === '@deviltea/uiux') {
				return dir
			}
		}
		catch {
			// keep searching
		}
		const parent = dirname(dir)
		if (parent === dir) break
		dir = parent
	}
	return process.cwd()
}

const bundleCache = new Map<string, { hash: string; bundleJs: string }>()

/**
 * The bundle's cache key. With `pin`, the kit build output generation the set was resolved from,
 * the files are not read: the bundle of that generation stays in use until the next settled output,
 * even when a failed build has changed the files since (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 */
export async function computeBundleContentHash(workspaceRoot: string, set: ValidatedAdapterSet, pin?: string): Promise<string> {
	const hash = createHash('sha256')
	hash.update(workspaceRoot)
	if (pin !== undefined) hash.update(`\0kit-build-output\0${pin}\0`)
	for (const entry of set.entries) {
		hash.update(entry.manifest.id)
		hash.update(entry.manifest.apiVersion)
		hash.update(entry.resolvedModule.resolvedPath)
		if (pin !== undefined) continue
		try {
			const statResult = await stat(entry.resolvedModule.resolvedPath)
			hash.update(String(statResult.mtimeMs))
			const content = await readFile(entry.resolvedModule.resolvedPath)
			hash.update(content)
		}
		catch (error) {
			throw new Error(`Failed to read adapter source file at '${entry.resolvedModule.resolvedPath}': ${error instanceof Error ? error.message : String(error)}`, { cause: error })
		}
	}
	return hash.digest('hex').slice(0, 16)
}

export function clearPreviewBundleCache(): void {
	bundleCache.clear()
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
	/** The kit build output generation the set was resolved from (see `computeBundleContentHash`). */
	pin?: string
}>): Promise<PreviewBundleResult> {
	const packageRoot = input.packageRoot ?? resolvePackageRoot()
	const hash = await computeBundleContentHash(input.workspaceRoot, input.set, input.pin)
	const cached = bundleCache.get(input.workspaceRoot)
	if (cached && cached.hash === hash) {
		return { bundleJs: cached.bundleJs, hash }
	}

	const browserRuntimePath = resolve(packageRoot, 'src/preview/browser-runtime.ts')
	const entrySource = generateBundleEntrySource(browserRuntimePath, input.set)

	const packageFileUrl = pathToFileURL(resolve(packageRoot, 'package.json')).href
	const vuePath = fileURLToPath(resolveImport('vue', packageFileUrl))
	const widgetCorePath = fileURLToPath(resolveImport('@deviltea/widget-core', packageFileUrl))
	const widgetCoreInspectionPath = fileURLToPath(resolveImport('@deviltea/widget-core/inspection', packageFileUrl))
	const widgetCoreIntegrationPath = fileURLToPath(resolveImport('@deviltea/widget-core/integration', packageFileUrl))
	const widgetVuePath = fileURLToPath(resolveImport('@deviltea/widget-vue', packageFileUrl))

	const coreResolvePlugin: esbuild.Plugin = {
		name: 'uiux-core-resolve',
		setup(build) {
			build.onResolve({ filter: /^vue$/ }, () => ({ path: vuePath }))
			build.onResolve({ filter: /^@deviltea\/widget-core$/ }, () => ({ path: widgetCorePath }))
			build.onResolve({ filter: /^@deviltea\/widget-core\/inspection$/ }, () => ({ path: widgetCoreInspectionPath }))
			build.onResolve({ filter: /^@deviltea\/widget-core\/integration$/ }, () => ({ path: widgetCoreIntegrationPath }))
			build.onResolve({ filter: /^@deviltea\/widget-vue$/ }, () => ({ path: widgetVuePath }))
		},
	}

	const buildResult = await esbuild.build({
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
		nodePaths: [
			join(packageRoot, 'node_modules'),
			join(input.moduleBase ?? input.workspaceRoot, 'node_modules'),
		],
		plugins: [coreResolvePlugin],
		define: {
			[['process', 'env', 'NODE_ENV'].join('.')]: JSON.stringify('production'),
		},
	})

	const bundleJs = buildResult.outputFiles?.[0]?.text ?? ''
	bundleCache.set(input.workspaceRoot, { hash, bundleJs })

	return { bundleJs, hash }
}

function generateBundleEntrySource(browserRuntimePath: string, set: ValidatedAdapterSet): string {
	const imports: string[] = [
		`import { createStandalonePreviewMount } from ${JSON.stringify(browserRuntimePath)};`,
	]

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
