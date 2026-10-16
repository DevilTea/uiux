import { readFile, realpath } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { maskHostPaths } from '../adapters/host-paths'
import { readKitBuildDeclaration, specifierInBuildOutput } from '../adapters/kit-build-declaration'
import { containedRealPath } from '../adapters/kit-registry'
import {
	adapterResolutionBase,
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	realDirectoryIdentity,
	resolveWorkspaceAdapterSet,
	type AdapterSetResolutionResult,
	type ValidatedAdapterSet,
} from '../adapters/resolution'
import { canonicalJsonStringify } from '../domain/canonical-json'
import type { Diagnostic } from '../domain/validation'
import type { WorkspaceAdapterSelection } from '../domain/workspace/schema'
import { kitBuildRunnerFor } from './kit-build'
import {
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
} from '../adapters/product-integration'
import {
	buildWorkspacePreviewBundle,
	type PreviewBundleResult,
} from './preview-bundler'
import { validateProductKit, type ProductKit } from '../domain/product-kit/schema'
import { validateWorkspaceManifest, type WorkspaceManifest } from '../domain/workspace/schema'
import { detectWorkspaceLayout, resolveWorkspacePath, type WorkspaceLayout } from '../persistence/paths'
import { CURRENT_WORKSPACE_SCHEMA_VERSION } from '../product/workspace-schema'

/**
 * The layout of the selected Workspace: the one given (a caller holding a persistence passes
 * `persistence.layout`), otherwise the one detected from where its manifest is.
 */
async function selectedLayout(workspaceRoot: string, layout: WorkspaceLayout | undefined): Promise<WorkspaceLayout> {
	return layout ?? detectWorkspaceLayout(workspaceRoot, CURRENT_WORKSPACE_SCHEMA_VERSION)
}

export async function readRawWorkspaceManifest(workspaceRoot: string, layout: WorkspaceLayout): Promise<WorkspaceManifest | undefined> {
	try {
		const content = await readFile(resolveWorkspacePath(workspaceRoot, layout.manifestPath), 'utf8')
		const parsed = JSON.parse(content)
		const validation = validateWorkspaceManifest(parsed)
		return validation.ok ? validation.value : undefined
	}
	catch {
		return undefined
	}
}

/** The Product Kit file of a `schemaVersion` 5 Workspace, or `undefined` when it is absent, unreadable or invalid. */
export async function readRawProductKit(workspaceRoot: string, productKitPath: string): Promise<ProductKit | undefined> {
	try {
		const content = await readFile(resolveWorkspacePath(workspaceRoot, productKitPath), 'utf8')
		const validation = validateProductKit(JSON.parse(content))
		return validation.ok ? validation.value : undefined
	}
	catch {
		return undefined
	}
}

export async function resolveSelectedWorkspaceAdapters(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<AdapterSetResolutionResult> {
	const layout = await selectedLayout(workspaceRoot, givenLayout)
	const manifest = await readRawWorkspaceManifest(workspaceRoot, layout)
	if (!manifest) {
		return {
			state: 'invalid',
			diagnostics: [{
				code: 'workspace.manifest_missing',
				path: '/workspace',
				message: `Could not read valid workspace manifest from ${layout.manifestPath}.`,
			}],
			summaries: [],
		}
	}

	// From schemaVersion 5 the Adapter list lives in the Product Kit file and resolves from `kit/`
	// (Clauses 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6).
	let adapters = manifest.adapters ?? []
	if (layout.productKitPath) {
		const productKit = await readRawProductKit(workspaceRoot, layout.productKitPath)
		if (!productKit) {
			return {
				state: 'invalid',
				diagnostics: [{
					code: 'product_kit.missing',
					path: '/product-kit',
					message: `Could not read a valid Product Kit file from ${layout.productKitPath}.`,
				}],
				summaries: [],
			}
		}
		adapters = productKit.adapters
	}
	let pin: KitOutputPin | undefined
	if (layout.codeDir) {
		const build = await kitBuildPin(workspaceRoot, layout.codeDir, adapters)
		if (build.state === 'invalid') return { state: 'invalid', diagnostics: build.diagnostics, summaries: [] }
		pin = build.pin
		if (pin?.resolution) return pin.resolution
	}
	if (adapters.length === 0) {
		const emptySet: ValidatedAdapterSet = Object.freeze({
			entries: Object.freeze([]),
		}) as unknown as ValidatedAdapterSet
		return {
			state: 'valid',
			diagnostics: [],
			summaries: [],
			set: emptySet,
		}
	}

	const resolution = resolveWorkspaceAdapterSet({
		workspaceRoot,
		adapters,
		resolver: new NodeWorkspaceAdapterModuleResolver({ layout }),
		loader: new NodeAdapterManifestLoader(extractProductAdapterManifest, pin ? { version: pin.version, versionScope: pin.kitDirectory } : {}),
		apiCompatibility: productAdapterApiCompatibility,
		registryInspector: productAdapterRegistryInspector,
	})
	pin?.remember(resolution)
	return await resolution
}

type KitOutputPin = Readonly<{
	/** The runner's `outputVersion()` of the generation. */
	version: string
	/** The real `kit/` directory: the modules the Adapter imports from it are imported anew per generation. */
	kitDirectory?: string
	/** The resolution made, or being made, from this generation for the same Adapter list, if any. */
	resolution?: Promise<AdapterSetResolutionResult>
	/** Keeps a resolution in progress for the callers that follow; dropped again unless it is valid. */
	remember(resolution: Promise<AdapterSetResolutionResult>): void
}>

type PinnedResolution = Readonly<{ version: string; adapters: string; resolution: Promise<AdapterSetResolutionResult> }>

/**
 * The resolution of the last good kit build output, per Workspace root: its output version, Adapter
 * list and result. A resolution in progress is kept too, so that the capture of a settled output
 * and a request arriving meanwhile share one resolution, and so one pinned Preview bundle.
 */
const pinnedResolutions = new Map<string, PinnedResolution>()

/**
 * The kit build's part in resolving a `schemaVersion` 5 Workspace's Adapters (Feature
 * 01a11bb1-8534-7f0f-b8d0-de7efabe31f7), when `kit/package.json` declares a build:
 *
 * - every `./` Adapter names a file inside the build output (Clause 01a11bb1-8721-721e-80b6-3cffed19e5ef);
 * - while no build output exists, the Adapter set is invalid (Rule 01a11bb1-9ec6-7cc0-9bfe-9d3003c5d0b6);
 * - under a running build (`uiux dev`), the Adapters resolve once per settled output generation
 *   (Rule 01a11bb1-9df8-762d-b5e5-306f9898aae2), and that resolution stays in use until the next one
 *   settles, also after a failed build (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 *
 * A malformed declaration also makes the set invalid: what the kit's output is cannot be known.
 */
async function kitBuildPin(workspaceRoot: string, codeDir: string, adapters: readonly WorkspaceAdapterSelection[]): Promise<
	| Readonly<{ state: 'valid'; pin?: KitOutputPin }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>
> {
	const root = resolve(workspaceRoot)
	const kitDirectory = join(root, codeDir)
	const read = await readKitBuildDeclaration(kitDirectory)
	if (read.state === 'none') return { state: 'valid' }
	if (read.state === 'invalid')
		return { state: 'invalid', diagnostics: [{ code: 'kit.build_declaration_invalid', path: '/product-kit', message: read.message }] }
	const { output } = read.declaration
	const outside = adapters.flatMap((entry, index) => entry.moduleSpecifier.startsWith('./') && !specifierInBuildOutput(entry.moduleSpecifier, output) ? [index] : [])
	if (outside.length > 0) {
		return { state: 'invalid', diagnostics: outside.map(index => ({
			code: 'product_kit.adapter_outside_build_output',
			path: `/adapters/${index}/moduleSpecifier`,
			message: `${codeDir}/package.json declares a build, so the ./ Adapter ${adapters[index]!.moduleSpecifier} must name a file in its output ${codeDir}/${output}/.`,
		})) }
	}
	const version = kitBuildRunnerFor(root)?.outputVersion()
	const key = canonicalJsonStringify(adapters)
	const pinned = pinnedResolutions.get(root)
	if (version !== undefined && pinned && pinned.version === version && pinned.adapters === key)
		return { state: 'valid', pin: { version, resolution: pinned.resolution, remember: () => {} } }
	if (!await buildOutputExists(kitDirectory, output)) {
		return { state: 'invalid', diagnostics: [{
			code: 'kit.build_output_missing',
			path: '/product-kit',
			message: `The kit build output ${codeDir}/${output}/ does not exist yet, so the Product Kit is invalid until a build produces it.`,
		}] }
	}
	if (version === undefined) return { state: 'valid' }
	const realKit = await realpath(kitDirectory).catch(() => undefined)
	return { state: 'valid', pin: {
		version,
		...(realKit ? { kitDirectory: realKit } : {}),
		remember(resolution) {
			// A generation that is no longer the runner's, such as one whose capture was abandoned, is never pinned.
			if (kitBuildRunnerFor(root)?.outputVersion() !== version) return
			const entry: PinnedResolution = { version, adapters: key, resolution }
			pinnedResolutions.set(root, entry)
			const drop = () => {
				if (pinnedResolutions.get(root) === entry) pinnedResolutions.delete(root)
			}
			resolution.then(result => result.state === 'valid' ? undefined : drop(), drop)
		},
	} }
}

async function buildOutputExists(kitDirectory: string, output: string): Promise<boolean> {
	const directory = join(kitDirectory, ...output.split('/'))
	if (!await realDirectoryIdentity(directory).catch(() => undefined)) return false
	const realKit = await realpath(kitDirectory).catch(() => undefined)
	return realKit !== undefined && await containedRealPath(realKit, directory) !== undefined
}

/** The active theme's root attributes come from this map: Workspace theme ID to attribute name and value. */
export type PreviewThemes = Readonly<Record<string, Readonly<Record<string, string>>>>

export async function getSelectedWorkspacePreviewBundle(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<
	| (PreviewBundleResult & { state: 'valid'; themes: PreviewThemes })
	| { state: 'invalid'; diagnostics: readonly Diagnostic[] }
> {
	const layout = await selectedLayout(workspaceRoot, givenLayout)
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot, layout)
	if (resolution.state === 'invalid') {
		return { state: 'invalid', diagnostics: resolution.diagnostics }
	}
	// The set of a pinned kit build output generation keeps its bundle until the next generation.
	const version = layout.codeDir ? kitBuildRunnerFor(resolve(workspaceRoot))?.outputVersion() : undefined
	const pinnedResolution = version !== undefined ? pinnedResolutions.get(resolve(workspaceRoot)) : undefined
	const pin = pinnedResolution?.version === version && await pinnedResolution?.resolution.catch(() => undefined) === resolution ? version : undefined
	// Below schemaVersion 5 there is no Product Kit file, so no style and no theme.
	const productKit = layout.productKitPath ? await readRawProductKit(workspaceRoot, layout.productKitPath) : undefined
	const styles = layout.codeDir && productKit
		? await resolveProductKitStyles(workspaceRoot, layout, productKit.styles, pin)
		: { state: 'valid' as const, paths: [] }
	if (styles.state === 'invalid') return { state: 'invalid', diagnostics: styles.diagnostics }
	try {
		const bundle = await buildWorkspacePreviewBundle({
			workspaceRoot,
			moduleBase: adapterResolutionBase(workspaceRoot, layout),
			set: resolution.set,
			styles: styles.paths,
			...(pin !== undefined ? { pin } : {}),
		})
		return { state: 'valid', ...bundle, themes: productKit?.themes ?? {} }
	}
	catch (error) {
		// A module graph esbuild cannot bundle (a missing import, a CSS `url()` that names no file, a
		// file type it has no loader for) makes the Preview invalid instead of failing the request.
		// The Workspace root by its real path too: esbuild reads files through it.
		const message = error instanceof Error ? error.message : String(error)
		const realRoot = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot))
		return { state: 'invalid', diagnostics: [{
			code: 'preview.bundle_failed',
			path: '/product-kit',
			message: maskHostPaths(`The Preview bundle could not be built: ${message}`, [resolve(workspaceRoot), realRoot]),
		}] }
	}
}

type StyleResolution =
	| Readonly<{ state: 'valid'; paths: readonly string[] }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>

/** The style resolution of a pinned kit build output generation, per Workspace root, like `pinnedResolutions`. */
const pinnedStyles = new Map<string, Readonly<{ version: string; styles: string; resolution: StyleResolution }>>()

/**
 * The Product Kit `styles` entries' files, in order. Each resolves like an Adapter module specifier
 * and names a CSS file (Clause 01a11bb1-8787-786a-a87e-49672393abd1); when `kit/package.json`
 * declares a build, a `./` style names a file of its output, otherwise an export of an external
 * package (Clause 01a11bb1-8e98-7270-9662-682c048f9929). Under a pinned output generation the
 * resolution of that generation stays in use, as the Adapters' does.
 */
async function resolveProductKitStyles(workspaceRoot: string, layout: WorkspaceLayout, styles: readonly string[], version: string | undefined): Promise<StyleResolution> {
	if (styles.length === 0) return { state: 'valid', paths: [] }
	const root = resolve(workspaceRoot)
	const key = canonicalJsonStringify(styles)
	const pinned = pinnedStyles.get(root)
	if (version !== undefined && pinned && pinned.version === version && pinned.styles === key) return pinned.resolution

	const codeDir = layout.codeDir!
	const declaration = await readKitBuildDeclaration(join(root, codeDir))
	const output = declaration.state === 'declared' ? declaration.declaration.output : undefined
	const resolver = new NodeWorkspaceAdapterModuleResolver({ layout })
	const paths: string[] = []
	const diagnostics: Diagnostic[] = []
	for (const [index, style] of styles.entries()) {
		const path = `/styles/${index}`
		if (output !== undefined && style.startsWith('./') && !specifierInBuildOutput(style, output)) {
			diagnostics.push({ code: 'product_kit.style_outside_build_output', path, message: `${codeDir}/package.json declares a build, so the ./ style ${style} must name a file in its output ${codeDir}/${output}/.` })
			continue
		}
		try {
			const resolved = await resolver.resolve(root, style)
			if (extname(resolved.resolvedPath).toLowerCase() !== '.css') {
				diagnostics.push({ code: 'product_kit.style_not_css', path, message: `The style ${style} does not name a CSS file.` })
				continue
			}
			paths.push(resolved.resolvedPath)
		}
		catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			diagnostics.push({ code: 'product_kit.style_unresolved', path, message: maskHostPaths(`The style ${style} does not resolve: ${message.replaceAll('Adapter module specifier', 'Style specifier')}`, [root]) })
		}
	}
	const resolution: StyleResolution = diagnostics.length > 0 ? { state: 'invalid', diagnostics } : { state: 'valid', paths }
	if (version !== undefined && kitBuildRunnerFor(root)?.outputVersion() === version) pinnedStyles.set(root, { version, styles: key, resolution })
	return resolution
}
