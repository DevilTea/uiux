import { readFile, realpath } from 'node:fs/promises'
import { extname, join, resolve } from 'node:path'

import { maskHostPaths } from '../adapters/host-paths'
import { readDeclaredKitBuildDeclaration, readKitBuildDeclaration, specifierInBuildOutput } from '../adapters/kit-build-declaration'
import { containedRealPath } from '../adapters/kit-registry'
import {
	adapterResolutionBase,
	allThemesSupported,
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	realDirectoryIdentity,
	resolveWorkspaceAdapterSet,
	type AdapterSetResolutionResult,
	type AdapterSetThemeSupport,
	type ValidatedAdapterEntry,
	type ValidatedAdapterSet,
} from '../adapters/resolution'
import { adapterGraphDigest } from '../adapters/adapter-graph-digest'
import { canonicalJsonStringify } from '../domain/canonical-json'
import type { Diagnostic } from '../domain/validation'
import type { WorkspaceAdapterSelection } from '../domain/workspace/schema'
import { kitBuildRunnerFor } from './kit-build'
import { checkPreviewBundleAdapters, evaluatePreviewBundle, type DeclaredWidgetEventsResult, type PreviewAdapterCheck, type WidgetCatalogResult } from './preview-adapter-check'
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
import { withoutRequirementDiagnostics } from '../domain/requirements/schema'
import { resolveWorkspacePath, V5_LAYOUT, type WorkspaceLayout } from '../persistence/paths'

/** The layout of the selected Workspace: the one given (a caller holding a persistence passes `persistence.layout`), otherwise the only one. */
function selectedLayout(layout: WorkspaceLayout | undefined): WorkspaceLayout {
	return layout ?? V5_LAYOUT
}

export async function readRawWorkspaceManifest(workspaceRoot: string, layout: WorkspaceLayout): Promise<WorkspaceManifest | undefined> {
	try {
		const content = await readFile(resolveWorkspacePath(workspaceRoot, layout.manifestPath), 'utf8')
		const parsed = JSON.parse(content)
		const validation = validateWorkspaceManifest(parsed)
		// A requirement diagnostic never makes the Workspace unusable for rendering (Rule 01a18121-0018-…).
		return withoutRequirementDiagnostics(validation.diagnostics).length === 0 ? parsed as WorkspaceManifest : undefined
	}
	catch {
		return undefined
	}
}

/** The Product Kit file of a Workspace, or `undefined` when it is absent, unreadable or invalid. */
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

export function resolveSelectedWorkspaceAdapters(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<AdapterSetResolutionResult> {
	return resolveAdapters(workspaceRoot, givenLayout)
}

/**
 * Resolves `adapters` as the Preview resolves the selected Workspace's Adapters, for formal capture,
 * Evidence freshness and Handoff export (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42): the Product
 * Kit file's own list is the Preview's resolution itself, pinned to the last good kit build output
 * ({@link resolveSelectedWorkspaceAdapters}). Another list, such as the one Adapter Handoff export
 * resolves to read its catalog, resolves with the same output generation's module versions, asking
 * no theme support predicate, and is not pinned, so it never replaces the Preview's resolution.
 */
export function resolveSelectedWorkspaceAdapterList(workspaceRoot: string, givenLayout: WorkspaceLayout | undefined, adapters: readonly WorkspaceAdapterSelection[]): Promise<AdapterSetResolutionResult> {
	return resolveAdapters(workspaceRoot, givenLayout, adapters)
}

/**
 * The content digest of each Adapter of a pinned resolution (Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5),
 * computed as its kit build output generation is captured, alongside the Preview bundle, before a
 * later build can change the files: the content of the output the Preview renders, whatever is on
 * disk later (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42). `undefined` when it could not be computed
 * then; it is not computed again for that generation.
 */
const pinnedContentDigests = new WeakMap<ValidatedAdapterEntry, Promise<string | undefined>>()

/** Entries of a resolution of a selection that differs from the Product Kit file's list: not the Preview's resolution, so not pinned. */
const selectionOnlyEntries = new WeakSet<ValidatedAdapterEntry>()

/** Whether `entry` was resolved for a selection other than the Product Kit file's list, whose digest would be computed from the files on disk (issue #336). */
export function isSelectionOnlyAdapterEntry(entry: ValidatedAdapterEntry): boolean {
	return selectionOnlyEntries.has(entry)
}

/** The content digest of `entry` taken with its pinned output generation, or `undefined` when `entry` belongs to no pinned resolution. */
export function pinnedAdapterContentDigest(entry: ValidatedAdapterEntry): Promise<string | undefined> | undefined {
	return pinnedContentDigests.get(entry)
}

/**
 * The Product Kit file's Adapters, pinned per output generation with their content digests; or
 * `selection` when it differs from that list (compared with the same Product Kit read), resolved
 * with the current generation's module versions and not pinned.
 */
async function resolveAdapters(workspaceRoot: string, givenLayout: WorkspaceLayout | undefined, selection?: readonly WorkspaceAdapterSelection[]): Promise<AdapterSetResolutionResult> {
	const layout = selectedLayout(givenLayout)
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

	// The Adapter list lives in the Product Kit file and resolves from `kit/` (Clauses
	// 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6).
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
	const other = selection !== undefined && canonicalJsonStringify(selection) !== canonicalJsonStringify(productKit.adapters) ? selection : undefined
	const adapters = other ?? productKit.adapters
	// Every theme of the Workspace registry is asked about once per resolution (Rule 01a11a5a-5464-7797-82d3-f8ece37457e5);
	// a selection other than the Product Kit file's asks none.
	const themeIds = other ? [] : Object.keys(manifest.themes)
	const build = await kitBuildPin(workspaceRoot, layout.codeDir, adapters, themeIds)
	if (build.state === 'invalid') return { state: 'invalid', diagnostics: build.diagnostics, summaries: [] }
	const pin: KitOutputPin | undefined = build.pin
	if (pin?.resolution && !other) return pin.resolution
	if (adapters.length === 0) {
		const emptySet: ValidatedAdapterSet = Object.freeze({
			entries: Object.freeze([]),
		}) as unknown as ValidatedAdapterSet
		return {
			state: 'valid',
			diagnostics: [],
			summaries: [],
			set: emptySet,
			themeSupport: allThemesSupported(themeIds),
		}
	}

	const resolved = resolveWorkspaceAdapterSet({
		workspaceRoot,
		adapters,
		resolver: new NodeWorkspaceAdapterModuleResolver({ layout }),
		loader: new NodeAdapterManifestLoader(extractProductAdapterManifest, pin ? { version: pin.version, versionScope: pin.kitDirectory } : {}),
		apiCompatibility: productAdapterApiCompatibility,
		registryInspector: productAdapterRegistryInspector,
		themeIds,
	})
	if (other) {
		const result = await resolved
		if (result.state === 'valid') for (const entry of result.set.entries) selectionOnlyEntries.add(entry)
		return result
	}
	if (!pin) return await resolved
	// A pinned resolution settles once its Adapters are digested, so the capture of the output
	// generation, which the next build waits for, covers the digests too.
	const resolution = resolved.then(async (result) => {
		if (result.state !== 'valid') return result
		const moduleBase = adapterResolutionBase(workspaceRoot, layout)
		const digests = result.set.entries.map((entry) => {
			const digest = adapterGraphDigest({ workspaceRoot, moduleBase, entry: entry.resolvedModule.resolvedPath })
			pinnedContentDigests.set(entry, digest)
			return digest
		})
		await Promise.all(digests)
		return result
	})
	pin.remember(resolution)
	return await resolution
}

/**
 * The theme support of the selected Workspace's current Adapter resolution (Rule
 * 01a11add-f46d-7e92-8f5a-9d10dba6473d), for formal capture; `undefined` when the set is invalid or
 * cannot be resolved, where the Preview refuses every context itself.
 */
export async function selectedWorkspaceThemeSupport(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<AdapterSetThemeSupport | undefined> {
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot, givenLayout).catch(() => undefined)
	return resolution?.state === 'valid' ? resolution.themeSupport : undefined
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
async function kitBuildPin(workspaceRoot: string, codeDir: string, adapters: readonly WorkspaceAdapterSelection[], themeIds: readonly string[]): Promise<
	| Readonly<{ state: 'valid'; pin?: KitOutputPin }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[] }>
> {
	const root = resolve(workspaceRoot)
	const kitDirectory = join(root, codeDir)
	const read = await readKitBuildDeclarationFor(root, kitDirectory)
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
	// The theme support a resolution evaluated is part of it, so another theme registry resolves anew.
	const key = canonicalJsonStringify({ adapters, themeIds })
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

/**
 * The kit build declaration as a resolution reads it. While the running build has an output
 * generation, the build is known to be declared, so a missing or unparseable `kit/package.json`,
 * as a non-atomic host rewrite leaves it for a moment, is read again before the capture of that
 * output pins nothing (Rule 01a11bb1-9e5e-79ab-841e-c953e8b44bbf).
 */
function readKitBuildDeclarationFor(root: string, kitDirectory: string): ReturnType<typeof readKitBuildDeclaration> {
	return kitBuildRunnerFor(root)?.outputVersion() !== undefined
		? readDeclaredKitBuildDeclaration(kitDirectory)
		: readKitBuildDeclaration(kitDirectory)
}

async function buildOutputExists(kitDirectory: string, output: string): Promise<boolean> {
	const directory = join(kitDirectory, ...output.split('/'))
	if (!await realDirectoryIdentity(directory).catch(() => undefined)) return false
	const realKit = await realpath(kitDirectory).catch(() => undefined)
	return realKit !== undefined && await containedRealPath(realKit, directory) !== undefined
}

/** The active theme's root attributes come from this map: Workspace theme ID to attribute name and value. */
export type PreviewThemes = Readonly<Record<string, Readonly<Record<string, string>>>>

/**
 * The selected Workspace's Preview bundle with the result of the server-side Adapter check (Clause
 * 01a116f0-cae2-7c64-9c76-d472f252789a): `adapterCheck` is `passed` when the evaluated bundle
 * reported no mismatch, `unchecked` when it could not be evaluated in Node; then `warnings` says so
 * and the Preview's own guard decides in the browser. `declaredWidgetEvents` comes from the same
 * evaluation and is `unavailable` unless the check passed.
 */
export type SelectedWorkspacePreviewBundle =
	| (PreviewBundleResult & { state: 'valid'; themes: PreviewThemes; adapterCheck: 'passed' | 'unchecked'; warnings: readonly Diagnostic[]; declaredWidgetEvents: DeclaredWidgetEventsResult; widgetCatalog: WidgetCatalogResult })
	| { state: 'invalid'; diagnostics: readonly Diagnostic[]; widgetCatalog?: WidgetCatalogResult }

export async function getSelectedWorkspacePreviewBundle(workspaceRoot: string, givenLayout?: WorkspaceLayout): Promise<SelectedWorkspacePreviewBundle> {
	const layout = selectedLayout(givenLayout)
	const resolution = await resolveSelectedWorkspaceAdapters(workspaceRoot, layout)
	if (resolution.state === 'invalid') {
		return { state: 'invalid', diagnostics: resolution.diagnostics }
	}
	// The set of a pinned kit build output generation keeps its bundle until the next generation.
	const version = kitBuildRunnerFor(resolve(workspaceRoot))?.outputVersion()
	const pinnedResolution = version !== undefined ? pinnedResolutions.get(resolve(workspaceRoot)) : undefined
	const pin = pinnedResolution?.version === version && await pinnedResolution?.resolution.catch(() => undefined) === resolution ? version : undefined
	const productKit = await readRawProductKit(workspaceRoot, layout.productKitPath)
	const styles = productKit
		? await resolveProductKitStyles(workspaceRoot, layout, productKit.styles, pin)
		: { state: 'valid' as const, paths: [] }
	if (styles.state === 'invalid') return { state: 'invalid', diagnostics: styles.diagnostics }
	let bundle: PreviewBundleResult
	try {
		bundle = await buildWorkspacePreviewBundle({
			workspaceRoot,
			moduleBase: adapterResolutionBase(workspaceRoot, layout),
			set: resolution.set,
			styles: styles.paths,
			...(pin !== undefined ? { pin } : {}),
		})
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
	// The one server-side check of the Adapters' runtime members, plugin authenticity among them
	// (Clause 01a116f0-cae2-7c64-9c76-d472f252789a): a set the Preview would refuse is invalid here.
	// A bundle that cannot run in Node stays valid with a warning (owner decision during review of #248).
	// The same one evaluation also yields the declared Widget Events (#249).
	const { check, declaredWidgetEvents, widgetCatalog } = await evaluatePreviewBundle(bundle, workspaceRoot)
	if (check.state === 'invalid') return { state: 'invalid', diagnostics: check.diagnostics, widgetCatalog }
	return {
		state: 'valid',
		...bundle,
		themes: productKit?.themes ?? {},
		adapterCheck: check.state === 'valid' ? 'passed' : 'unchecked',
		warnings: check.state === 'unchecked' ? check.warnings : [],
		declaredWidgetEvents,
		widgetCatalog,
	}
}

/**
 * The server-side Adapter check (Clause 01a116f0-cae2-7c64-9c76-d472f252789a) of a given resolved
 * set, for Handoff export, which resolves only the Adapters its closure needs: the set's Preview
 * bundle, without the Product Kit styles, is built and checked as `getSelectedWorkspacePreviewBundle`
 * checks the Workspace's. A bundle that cannot be built leaves the check `unchecked`, like one that
 * cannot be evaluated. Unlike the Preview, where a build failure makes the set invalid, a Handoff
 * check-bundle build failure is reported as `unchecked` (non-blocking), because Handoff did not
 * build before this check. Diagnostic paths index the given set.
 */
export async function checkAdapterSetRuntime(workspaceRoot: string, givenLayout: WorkspaceLayout | undefined, set: ValidatedAdapterSet): Promise<PreviewAdapterCheck> {
	if (set.entries.length === 0) return { state: 'valid' }
	let bundle: PreviewBundleResult
	try {
		bundle = await buildWorkspacePreviewBundle({ workspaceRoot, moduleBase: adapterResolutionBase(workspaceRoot, selectedLayout(givenLayout)), set })
	}
	catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		const realRoot = await realpath(workspaceRoot).catch(() => resolve(workspaceRoot))
		return { state: 'unchecked', warnings: [{
			code: 'preview.bundle_failed',
			path: '/product-kit',
			message: maskHostPaths(`The server could not run the Adapter check: the Adapters' Preview bundle could not be built: ${message}`, [resolve(workspaceRoot), realRoot]),
		}] }
	}
	return await checkPreviewBundleAdapters(bundle, workspaceRoot)
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

	const codeDir = layout.codeDir
	const declaration = await readKitBuildDeclarationFor(root, join(root, codeDir))
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
