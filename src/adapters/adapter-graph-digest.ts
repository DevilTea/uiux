import { readFile, realpath } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import esbuild from 'esbuild'

import { canonicalJsonBytes } from '../domain/canonical-json'
import { sha256Identity } from '../domain/artifacts/schema'
import { fileDigest } from '../domain/product-kit/digest'
import { resolvePackageRoot } from './package-root'
import { ADAPTER_ENTRY_SPECIFIER } from './host-adapter-entry'
import { BUNDLED_ASSET_TYPES } from './style-imports'

/**
 * The host packages the Preview bundle aliases to UIUX's own copies (`src/server/preview-bundler.ts`):
 * one Vue and one Widget runtime serve every Adapter, and the host supplies the public Adapter authoring
 * entry from its own package (`ADAPTER_ENTRY_SPECIFIER`), so none of them is part of an Adapter's content.
 */
export const PREVIEW_HOST_PACKAGES = Object.freeze([
	'vue',
	'@deviltea/widget-core',
	'@deviltea/widget-core/inspection',
	'@deviltea/widget-core/integration',
	'@deviltea/widget-vue',
	ADAPTER_ENTRY_SPECIFIER,
] as const)

/**
 * The `contentDigest` of an Adapter (Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5, Rule
 * 01a115cd-cc70-751d-aac2-3306e6db4c24): a `sha256:` identity over the Adapter's whole bundled
 * module graph except the host packages the Preview bundle aliases. The graph is the one esbuild
 * bundles from the Adapter's resolved entry module with the Preview bundle's resolution (its
 * `nodePaths`, its file loaders for fonts and images), the host packages left external, and nothing
 * written; its metafile lists every input the bundle reads: modules, stylesheets and assets, however
 * deep. The digest is the `sha256:` identity of the canonical JSON of the map from each input's
 * label to its file digest, so any changed byte in the graph changes it, and no host path enters it:
 * an input inside the Workspace is labelled by its path relative to the Workspace root, one outside
 * by `external:` and its path from its last `node_modules/` (or its file name).
 *
 * `undefined` when the graph cannot be bundled or an input cannot be read: the Adapter then has no
 * content digest, as the Clause allows only with a package version.
 */
export async function adapterGraphDigest(input: Readonly<{
	workspaceRoot: string
	/** The Adapter resolution base (`kit/`), as the Preview bundle's `moduleBase`. */
	moduleBase?: string
	/** The resolved Adapter entry module. */
	entry: string
	packageRoot?: string
}>): Promise<string | undefined> {
	const packageRoot = input.packageRoot ?? resolvePackageRoot()
	const realWorkspaceRoot = await realpath(input.workspaceRoot).catch(() => resolve(input.workspaceRoot))
	let metafile: esbuild.Metafile
	try {
		const result = await esbuild.build({
			absWorkingDir: realWorkspaceRoot,
			entryPoints: [input.entry],
			bundle: true,
			format: 'esm',
			platform: 'browser',
			target: 'es2022',
			write: false,
			metafile: true,
			outdir: join(input.moduleBase ?? input.workspaceRoot, '.uiux-adapter-digest'),
			loader: Object.fromEntries(Object.keys(BUNDLED_ASSET_TYPES).map(extension => [extension, 'file' as const])),
			logLevel: 'silent',
			external: [...PREVIEW_HOST_PACKAGES],
			nodePaths: [
				join(packageRoot, 'node_modules'),
				join(input.moduleBase ?? input.workspaceRoot, 'node_modules'),
			],
			define: {
				[['process', 'env', 'NODE_ENV'].join('.')]: JSON.stringify('production'),
			},
		})
		metafile = result.metafile
	}
	catch {
		return undefined
	}
	const digests: Record<string, string> = {}
	for (const key of Object.keys(metafile.inputs)) {
		// A namespaced input (`ns:path`) is not a file on disk; esbuild's file inputs are plain paths.
		if (/^[a-z-]+:/iu.test(key) && !isAbsolute(key)) continue
		const path = resolve(realWorkspaceRoot, key)
		let bytes: Uint8Array
		try {
			bytes = await readFile(path)
		}
		catch {
			return undefined
		}
		digests[inputLabel(realWorkspaceRoot, path)] = await fileDigest(bytes)
	}
	return sha256Identity(canonicalJsonBytes(digests))
}

/** The label of the graph input at `path`: Workspace-relative inside the Workspace root, else `external:` and its path below its last `node_modules/`. */
function inputLabel(workspaceRoot: string, path: string): string {
	const inside = relative(workspaceRoot, path)
	if (inside !== '' && inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside))
		return inside.split(sep).join('/')
	const segments = path.split(sep)
	const last = segments.lastIndexOf('node_modules')
	return `external:${(last >= 0 ? segments.slice(last + 1) : segments.slice(-1)).join('/')}`
}
