import { readFile, realpath } from 'node:fs/promises'
import { join, resolve } from 'node:path'

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

	const resolution = await resolveWorkspaceAdapterSet({
		workspaceRoot,
		adapters,
		resolver: new NodeWorkspaceAdapterModuleResolver({ layout }),
		loader: new NodeAdapterManifestLoader(extractProductAdapterManifest, pin ? { version: String(pin.generation) } : {}),
		apiCompatibility: productAdapterApiCompatibility,
		registryInspector: productAdapterRegistryInspector,
	})
	if (pin && resolution.state === 'valid') pin.remember(resolution)
	return resolution
}

type KitOutputPin = Readonly<{
	generation: number
	/** The resolution already made from this generation for the same Adapter list, if any. */
	resolution?: AdapterSetResolutionResult
	remember(resolution: AdapterSetResolutionResult): void
}>

/** The resolution of the last good kit build output, per Workspace root: its generation, Adapter list and result. */
const pinnedResolutions = new Map<string, Readonly<{ generation: number; adapters: string; resolution: AdapterSetResolutionResult }>>()

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
	const generation = kitBuildRunnerFor(root)?.outputGeneration()
	const key = canonicalJsonStringify(adapters)
	const pinned = pinnedResolutions.get(root)
	if (generation !== undefined && pinned && pinned.generation === generation && pinned.adapters === key)
		return { state: 'valid', pin: { generation, resolution: pinned.resolution, remember: () => {} } }
	if (!await buildOutputExists(kitDirectory, output)) {
		return { state: 'invalid', diagnostics: [{
			code: 'kit.build_output_missing',
			path: '/product-kit',
			message: `The kit build output ${codeDir}/${output}/ does not exist yet, so the Product Kit is invalid until a build produces it.`,
		}] }
	}
	if (generation === undefined) return { state: 'valid' }
	return { state: 'valid', pin: { generation, remember: resolution => pinnedResolutions.set(root, { generation, adapters: key, resolution }) } }
}

async function buildOutputExists(kitDirectory: string, output: string): Promise<boolean> {
	const directory = join(kitDirectory, ...output.split('/'))
	if (!await realDirectoryIdentity(directory).catch(() => undefined)) return false
	const realKit = await realpath(kitDirectory).catch(() => undefined)
	return realKit !== undefined && await containedRealPath(realKit, directory) !== undefined
}

export async function getSelectedWorkspacePreviewBundle(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<
	| (PreviewBundleResult & { state: 'valid' })
	| { state: 'invalid'; diagnostics: readonly unknown[] }
> {
	const layout = await selectedLayout(workspaceRoot, givenLayout)
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot, layout)
	if (resolution.state === 'invalid') {
		return { state: 'invalid', diagnostics: resolution.diagnostics }
	}
	// The set of a pinned kit build output generation keeps its bundle until the next generation.
	const generation = layout.codeDir ? kitBuildRunnerFor(resolve(workspaceRoot))?.outputGeneration() : undefined
	const pinned = generation !== undefined && pinnedResolutions.get(resolve(workspaceRoot))?.resolution === resolution
	const bundle = await buildWorkspacePreviewBundle({
		workspaceRoot,
		moduleBase: adapterResolutionBase(workspaceRoot, layout),
		set: resolution.set,
		...(pinned ? { pin: String(generation) } : {}),
	})
	return { state: 'valid', ...bundle }
}
