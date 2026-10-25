import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PRODUCT_KIT_FILENAME } from '../domain/product-kit/schema'
import {
	CANONICAL_WORKSPACE_DATA_DIRECTORIES,
	V5_CODE_DIRECTORY,
	V5_LAYOUT,
	V5_MANIFEST_PATH,
	WORKSPACE_DATA_DIRECTORY,
	WORKSPACE_MANIFEST_PATH,
	type WorkspaceLayout,
} from '../persistence/paths'
import { maskHostPaths } from './host-paths'
import { allowStyleAndAssetImportsOnServer } from './style-imports'
import { supplyAdapterEntryOnServer } from './host-adapter-entry'
import { resolvePackageRoot } from './package-root'
import { KIT_OUTPUT_VERSION_PARAMETER, shareVersionWithKitImports } from './kit-output-imports'
import { bareKitSpecifierProblem, bareSpecifierPackageName, readDeclaredKitDependencies, relativeKitSpecifierProblem } from './kit-dependencies'

import { resolve as resolveImport } from 'import-meta-resolve'
import {
	validateAdapterConfig,
	validateAdapterConfigSchema,
	validateAdapterManifest,
	evaluateAdapterThemeSupport,
	validateAdapterProviders,
	validateAdapterThemeSupport,
	validateResolvedAdapterSet,
	type AdapterManifest,
	type ResolvedAdapterRegistries,
} from '../domain/adapters/schema'
import type { Diagnostic } from '../domain/validation'
import { validateAdapterSources } from '../domain/adapters/sources'
import { isPortableAdapterModuleSpecifier, type WorkspaceAdapterSelection } from '../domain/workspace/schema'

export type ResolvedAdapterModule = Readonly<{
	moduleSpecifier: string
	resolvedPath: string
	moduleIdentity: string
	packageName?: string
	packageVersion?: string
}>

export type AdapterResolutionSummary = Readonly<{
	index: number
	moduleSpecifier: string
	resolvedModule?: ResolvedAdapterModule
	adapterId?: string
	apiVersion?: string
	/**
	 * For an Adapter that declares `themeSupport`, in a valid set: the Workspace theme IDs it does not
	 * support, in registry order (Rule 01a11a5a-5769-721b-ad33-d068c7edeb41).
	 */
	unsupportedThemeIds?: readonly string[]
}>

/**
 * The theme support of a valid Adapter set, evaluated once per resolution for every theme in the
 * Workspace registry (Rules 01a11a5a-5464-7797-82d3-f8ece37457e5 and 01a11add-f46d-7e92-8f5a-9d10dba6473d).
 * It is set-level: a theme is unsupported as soon as any Adapter rejects it (Rule
 * 01a11a5a-55ee-737a-9970-cb9228a2de30). An unsupported theme leaves the set valid (Rule
 * 01a11a5a-56e8-71c8-905a-62ed0476fd8f); `diagnostics` are the non-blocking Adapter diagnostics of
 * predicates that threw or returned a non-boolean (Rule 01a11a5a-555f-7b4c-8fcc-311c31a99b7a).
 */
export type AdapterSetThemeSupport = Readonly<{
	/** The Workspace theme IDs asked about. */
	themeIds: readonly string[]
	/** The theme IDs some Adapter of the set does not support, in registry order. */
	unsupportedThemeIds: readonly string[]
	diagnostics: readonly Diagnostic[]
}>

/** The theme support of a set that rejects no theme, such as an empty one. */
export function allThemesSupported(themeIds: readonly string[] = []): AdapterSetThemeSupport {
	return { themeIds: [...themeIds], unsupportedThemeIds: [], diagnostics: [] }
}

export interface AdapterModuleResolver {
	resolve(workspaceRoot: string, moduleSpecifier: string): Promise<ResolvedAdapterModule>
}

/**
 * The canonical architecture fixes one manifest entrypoint but not its JavaScript export name.
 * Integration code owns extracting that manifest from the resolved module.
 */
export interface AdapterManifestLoader {
	loadManifest(resolved: ResolvedAdapterModule): Promise<unknown>
}

export type AdapterManifestExtractor = (moduleNamespace: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>

/**
 * Loads ESM using the resolved identity while leaving export-name semantics to the integration boundary.
 *
 * `version`, when given, is appended to the identity of each `./` Adapter module as `?v=<version>`:
 * Node caches a module by its URL, so each kit build output generation is imported anew (Rule
 * 01a11bb1-9df8-762d-b5e5-306f9898aae2). With `versionScope`, the real kit directory, the modules it
 * imports from inside that directory, outside `node_modules/`, are imported anew with it
 * (`shareVersionWithKitImports`); without it they keep their own URLs and cache.
 */
export class NodeAdapterManifestLoader implements AdapterManifestLoader {
	constructor(private readonly extractManifest: AdapterManifestExtractor, private readonly options: Readonly<{ version?: string; versionScope?: string }> = {}) {}

	async loadManifest(resolved: ResolvedAdapterModule): Promise<unknown> {
		const version = resolved.moduleSpecifier.startsWith('./') ? this.options.version : undefined
		const identity = version !== undefined
			? `${resolved.moduleIdentity}?${KIT_OUTPUT_VERSION_PARAMETER}=${encodeURIComponent(version)}`
			: resolved.moduleIdentity
		if (version !== undefined && this.options.versionScope !== undefined) shareVersionWithKitImports(this.options.versionScope, version)
		allowStyleAndAssetImportsOnServer()
		supplyAdapterEntryOnServer(resolvePackageRoot())
		const namespace = await import(identity) as Readonly<Record<string, unknown>>
		return this.extractManifest(namespace)
	}
}

/** Product integration owns the concrete supported adapter API versions. */
export interface AdapterApiCompatibilityPolicy {
	isCompatible(apiVersion: string): boolean
}

export type AdapterRegistryOwnership = Readonly<{
	widgetTypes: readonly string[]
	rendererKeys: readonly string[]
}>

/** Widget/runtime integration owns extracting semantic registry identities from opaque manifest members. */
export interface AdapterRegistryInspector {
	inspect(manifest: AdapterManifest): AdapterRegistryOwnership | Promise<AdapterRegistryOwnership>
}

export type ValidatedAdapterEntry = Readonly<{
	index: number
	selection: WorkspaceAdapterSelection
	resolvedModule: ResolvedAdapterModule
	manifest: AdapterManifest
	ownership: AdapterRegistryOwnership
}>

const validatedAdapterSetBrand: unique symbol = Symbol('ValidatedAdapterSet')

export type ValidatedAdapterSet = Readonly<{
	entries: readonly ValidatedAdapterEntry[]
	[validatedAdapterSetBrand]: true
}>

export type AdapterSetResolutionResult =
	| Readonly<{ state: 'valid'; diagnostics: readonly []; summaries: readonly AdapterResolutionSummary[]; set: ValidatedAdapterSet; themeSupport: AdapterSetThemeSupport }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[]; summaries: readonly AdapterResolutionSummary[] }>

export type ResolveWorkspaceAdapterSetInput = Readonly<{
	workspaceRoot: string
	adapters: readonly WorkspaceAdapterSelection[]
	resolver: AdapterModuleResolver
	loader: AdapterManifestLoader
	apiCompatibility: AdapterApiCompatibilityPolicy
	registryInspector: AdapterRegistryInspector
	/**
	 * The Workspace theme registry's IDs, each asked about by every Adapter's theme-support predicate
	 * (Rule 01a11a5a-5464-7797-82d3-f8ece37457e5); omitted, no theme is asked about.
	 */
	themeIds?: readonly string[]
}>

export interface AdapterSetInstaller<Result> {
	install(set: ValidatedAdapterSet): Promise<Result>
}

export type NodeWorkspaceAdapterModuleResolverOptions = Readonly<{
	/** The selected Workspace's layout (a caller holding a persistence passes `persistence.layout`); omitted, the only one. */
	layout?: WorkspaceLayout
}>

/**
 * The base a `./` Adapter specifier resolves from, which is also the root of a `./` Adapter's file
 * references (Clauses 01a115cd-d109-76d3-9622-85d0080c60b6 and 01a11a5a-45a7-7139-ac1c-d3881976eb71):
 * `kit/`.
 */
export function adapterResolutionBase(workspaceRoot: string, layout: WorkspaceLayout): string {
	return join(resolve(workspaceRoot), layout.codeDir)
}

export class NodeWorkspaceAdapterModuleResolver implements AdapterModuleResolver {
	constructor(private readonly options: NodeWorkspaceAdapterModuleResolverOptions = {}) {}

	async resolve(workspaceRoot: string, moduleSpecifier: string): Promise<ResolvedAdapterModule> {
		if (!isPortableAdapterModuleSpecifier(moduleSpecifier))
			throw new Error('Adapter module specifier is not a canonical portable module reference.')

		const root = resolve(workspaceRoot)
		const layout = this.options.layout ?? V5_LAYOUT
		return resolveFromCodeDirectory(root, layout.codeDir, moduleSpecifier)
	}
}

/** `kit/node_modules/`, which a `./` specifier never names or resolves into. */
const KIT_DEPENDENCY_DIRECTORY = 'node_modules'

/**
 * Clause 01a115cd-d109-76d3-9622-85d0080c60b6 (Discussion #139 decision 3
 * and owner ruling 3 of 2026-10-08): the base is `kit/`, which must be a real directory, never a
 * symbolic link standing in for one. A `./` specifier stays inside `kit/` and outside
 * `kit/node_modules/`, both as written and by its real path. A bare specifier names a dependency
 * that `kit/package.json` declares (the dependency guard) and resolves through Node module
 * resolution and package `exports` from `kit/`. Whatever the kind, a module whose real path lies
 * inside the selected root lies inside its `kit/`, and the same holds for every other Workspace
 * root on the module's path.
 */
async function resolveFromCodeDirectory(root: string, codeDirectoryName: string, moduleSpecifier: string): Promise<ResolvedAdapterModule> {
	const realRoot = await realpath(root)
	const codeDirectory = join(realRoot, codeDirectoryName)
	if (!await realDirectoryIdentity(codeDirectory))
		throw new Error(`The selected Workspace has no ${codeDirectoryName}/ directory (a real directory, not a symbolic link) to resolve Adapter modules from.`)

	const relativeSelection = moduleSpecifier.startsWith('./')
	// The as-written rules, which the Product Kit authoring operations also apply before storing a specifier.
	const problem = relativeSelection
		? relativeKitSpecifierProblem(codeDirectoryName, moduleSpecifier)
		: bareSpecifierPackageName(moduleSpecifier) === undefined
			? bareKitSpecifierProblem(codeDirectoryName, moduleSpecifier, new Set())
			: bareKitSpecifierProblem(codeDirectoryName, moduleSpecifier, await readDeclaredKitDependencies(codeDirectory))
	if (problem !== undefined)
		throw new Error(problem)

	const parentUrl = pathToFileURL(join(codeDirectory, '.uiux-adapter-resolution.mjs')).href
	// A `./` specifier that does not resolve and one that resolves outside `kit/` get one answer,
	// naming no path: a link inside `kit/` may point anywhere, and its target is not described.
	const unresolvedInKit = () => new Error(`Adapter module specifier ${moduleSpecifier} does not resolve to a file inside ${codeDirectoryName}/.`)
	let resolvedPath: string
	let modulePath: string | undefined
	try {
		const moduleIdentity = resolveImport(moduleSpecifier, parentUrl)
		if (!moduleIdentity.startsWith('file:'))
			throw new Error('Adapter module must resolve to a file-backed module.')
		modulePath = fileURLToPath(moduleIdentity)
		resolvedPath = await realpath(modulePath)
	}
	catch (error) {
		if (relativeSelection) throw unresolvedInKit()
		// A bare specifier's module behind a link out of the root, or a dangling one, names no path.
		if (modulePath !== undefined && await passesUnresolvedLink(realRoot, modulePath))
			throw new AdapterModuleBehindLinkError(moduleSpecifier)
		throw error
	}

	if (relativeSelection) {
		const resolved = relative(codeDirectory, resolvedPath)
		if (resolved === '' || escapesBase(resolved))
			throw unresolvedInKit()
		if (await liesInKitDependencies(codeDirectory, resolvedPath))
			throw new Error(`Adapter module specifier ${moduleSpecifier} resolves inside ${codeDirectoryName}/${KIT_DEPENDENCY_DIRECTORY}/.`)
	}
	// The selected root is a boundary whatever files it holds: inside it, only kit/ is code.
	if (await liesOutsideCodeDirectory(realRoot, resolvedPath, statFileIdentity, realDirectoryIdentity))
		throw new Error(`Adapter module resolves inside the selected Workspace root but outside ${codeDirectoryName}/, which is Workspace data like a canonical Workspace data directory; Adapter code must live outside authored data that Editors and Agents can write.`)
	await assertOutsideWorkspaceData(resolvedPath, realRoot)
	return resolvedAdapterModule(moduleSpecifier, resolvedPath, relativeSelection)
}

/**
 * A bare Adapter specifier whose module file, inside the selected root as Node module resolution
 * names it, cannot be read and lies behind a link whose target is outside the root or does not
 * resolve. Its message names no path, so what lies behind the link is not described.
 */
export class AdapterModuleBehindLinkError extends Error {
	constructor(moduleSpecifier: string) {
		super(`Adapter module specifier ${moduleSpecifier} does not resolve to a readable module file.`)
		this.name = 'AdapterModuleBehindLinkError'
	}
}

/**
 * Whether `path`, inside `realRoot` as written, passes a link (itself or a directory above it, below
 * the root) whose target lies outside `realRoot` or does not resolve.
 */
async function passesUnresolvedLink(realRoot: string, path: string): Promise<boolean> {
	const rel = relative(realRoot, path)
	if (rel === '' || escapesBase(rel)) return false
	for (let current = path; current !== realRoot && current !== dirname(current); current = dirname(current)) {
		const info = await lstat(current).catch(() => undefined)
		if (!info?.isSymbolicLink()) continue
		const target = await realpath(current).catch(() => undefined)
		if (target === undefined || !isContainedPath(realRoot, target)) return true
	}
	return false
}

async function assertOutsideWorkspaceData(resolvedPath: string, realRoot: string): Promise<void> {
	// Applies to every specifier, not only `./` ones, and to every Workspace on the resolved
	// path (the selected root, a sibling, or an enclosing one): a bare specifier can resolve via
	// a monorepo symlink or a self-reference `exports`/`imports` into any Workspace's data.
	if (await resolvedPathEntersWorkspaceDataDirectory(resolvedPath, realRoot))
		throw new Error('Adapter module resolves inside a canonical Workspace data directory (in a schemaVersion 5 Workspace root, anywhere outside kit/); Adapter code must live outside authored data that Editors and Agents can write.')
}

async function resolvedAdapterModule(moduleSpecifier: string, resolvedPath: string, relativeSelection: boolean): Promise<ResolvedAdapterModule> {
	const packageMetadata = relativeSelection ? {} : await findNearestPackageMetadata(resolvedPath)
	return {
		moduleSpecifier,
		resolvedPath,
		moduleIdentity: pathToFileURL(resolvedPath).href,
		...(packageMetadata.name ? { packageName: packageMetadata.name } : {}),
		...(packageMetadata.version ? { packageVersion: packageMetadata.version } : {}),
	}
}

/**
 * True when `resolvedPath` (a real path) lies in `<codeDirectory>/node_modules/`. Membership is
 * decided by file identity, so a differently cased spelling on a case-insensitive volume, or a
 * directory inside `kit/` that `node_modules` links to, still counts.
 */
async function liesInKitDependencies(codeDirectory: string, resolvedPath: string): Promise<boolean> {
	const rel = relative(codeDirectory, resolvedPath)
	if (rel === '' || escapesBase(rel))
		return false
	const firstSegment = firstSegmentOf(rel)
	if (firstSegment === '' || rel === firstSegment)
		return false
	const topIdentity = await statFileIdentity(join(codeDirectory, firstSegment))
	const dependencyIdentity = await statFileIdentity(join(codeDirectory, KIT_DEPENDENCY_DIRECTORY))
	return topIdentity !== undefined && dependencyIdentity !== undefined
		&& topIdentity.dev === dependencyIdentity.dev && topIdentity.ino === dependencyIdentity.ino
}

function firstSegmentOf(rel: string): string {
	return rel.split(/[/\\]/u)[0] ?? ''
}

export async function resolveWorkspaceAdapterSet(input: ResolveWorkspaceAdapterSetInput): Promise<AdapterSetResolutionResult> {
	const diagnostics: Diagnostic[] = []
	const summaries: AdapterResolutionSummary[] = []
	const entries: ValidatedAdapterEntry[] = []
	const ownership: ResolvedAdapterRegistries[] = []
	// A cause's message names host paths: the Workspace root, as given and by its real path, reads `<workspace>`.
	const givenRoot = resolve(input.workspaceRoot)
	const realRoot = await realpath(givenRoot).catch(() => undefined)
	const roots = realRoot === undefined ? [givenRoot] : [givenRoot, realRoot]

	for (const [index, selection] of input.adapters.entries()) {
		const basePath = `/adapters/${index}`
		if (!isPortableAdapterModuleSpecifier(selection.moduleSpecifier)) {
			diagnostics.push({
				code: 'workspace.invalid_adapter_specifier',
				path: `${basePath}/moduleSpecifier`,
				message: 'Adapter moduleSpecifier must be a bare package specifier or a ./ Workspace-relative specifier.',
			})
			summaries.push({ index, moduleSpecifier: String(selection.moduleSpecifier) })
			continue
		}
		let resolvedModule: ResolvedAdapterModule
		try {
			resolvedModule = await input.resolver.resolve(input.workspaceRoot, selection.moduleSpecifier)
		}
		catch (cause) {
			diagnostics.push({
				code: 'adapter.resolution_failed',
				path: `${basePath}/moduleSpecifier`,
				message: diagnosticMessage('Adapter module could not be resolved from the selected Workspace root.', cause, roots),
			})
			summaries.push({ index, moduleSpecifier: selection.moduleSpecifier })
			continue
		}

		let manifestValue: unknown
		try {
			manifestValue = await input.loader.loadManifest(resolvedModule)
		}
		catch (cause) {
			diagnostics.push({
				code: 'adapter.manifest_load_failed',
				path: `${basePath}/moduleSpecifier`,
				message: diagnosticMessage('Resolved adapter module did not provide a readable canonical manifest.', cause, roots),
			})
			summaries.push({ index, moduleSpecifier: selection.moduleSpecifier, resolvedModule })
			continue
		}

		const manifestValidation = validateAdapterManifest(manifestValue)
		if (!manifestValidation.ok) {
			diagnostics.push(...prefixDiagnostics(manifestValidation.diagnostics, `${basePath}/manifest`))
			summaries.push({ index, moduleSpecifier: selection.moduleSpecifier, resolvedModule })
			continue
		}
		const manifest = manifestValidation.value
		const summary: AdapterResolutionSummary = {
			index,
			moduleSpecifier: selection.moduleSpecifier,
			resolvedModule,
			adapterId: manifest.id,
			apiVersion: manifest.apiVersion,
		}
		summaries.push(summary)

		if (!input.apiCompatibility.isCompatible(manifest.apiVersion)) {
			diagnostics.push({
				code: 'adapter.api_version_incompatible',
				path: `${basePath}/manifest/apiVersion`,
				message: `Adapter ${manifest.id} declares a malformed or unsupported UIUX adapter API version.`,
			})
			continue
		}

		// Each provider entry's shape (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a); no provider runs here.
		const providersValidation = validateAdapterProviders(manifest)
		if (!providersValidation.ok) {
			diagnostics.push(...prefixDiagnostics(providersValidation.diagnostics, `${basePath}/manifest`))
			continue
		}

		// The shape of `themeSupport` (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a); it is asked once the set is valid.
		const themeSupportValidation = validateAdapterThemeSupport(manifest)
		if (!themeSupportValidation.ok) {
			diagnostics.push(...prefixDiagnostics(themeSupportValidation.diagnostics, `${basePath}/manifest`))
			continue
		}

		const configSchemaValidation = validateAdapterConfigSchema(manifest.configSchema)
		if (!configSchemaValidation.ok) {
			diagnostics.push(...prefixDiagnostics(configSchemaValidation.diagnostics, `${basePath}/manifest`))
			continue
		}

		const configValidation = validateAdapterConfig(selection.config, manifest.configSchema)
		if (!configValidation.ok) {
			diagnostics.push(...prefixDiagnostics(configValidation.diagnostics, basePath))
			continue
		}

		let registryOwnership: AdapterRegistryOwnership
		try {
			registryOwnership = await input.registryInspector.inspect(manifest)
		}
		catch (cause) {
			diagnostics.push({
				code: 'adapter.registry_inspection_failed',
				path: `${basePath}/manifest`,
				message: diagnosticMessage('Adapter registry ownership could not be inspected.', cause, roots),
			})
			continue
		}

		const registryRecord: ResolvedAdapterRegistries = {
			id: manifest.id,
			...registryOwnership,
			catalogKeys: Object.keys(manifest.catalog.widgets),
		}
		const localRegistryValidation = validateResolvedAdapterSet([registryRecord])
		if (!localRegistryValidation.ok) {
			diagnostics.push(...prefixDiagnostics(localRegistryValidation.diagnostics, `${basePath}/registries`))
			continue
		}

		// The shape and ownership of `sources` (Rule 01a11a5a-4c2c-7330-8fac-11a6c970713a); only Handoff reads it.
		const sourcesValidation = validateAdapterSources(manifest, registryOwnership.widgetTypes)
		if (!sourcesValidation.ok) {
			diagnostics.push(...prefixDiagnostics(sourcesValidation.diagnostics, `${basePath}/manifest`))
			continue
		}

		entries.push({ index, selection, resolvedModule, manifest, ownership: registryOwnership })
		ownership.push(registryRecord)
	}

	const completeSetValidation = validateResolvedAdapterSet(ownership)
	if (!completeSetValidation.ok)
		diagnostics.push(...mapSetDiagnosticsToWorkspaceAdapters(completeSetValidation.diagnostics, entries))

	if (diagnostics.length > 0 || entries.length !== input.adapters.length)
		return { state: 'invalid', diagnostics, summaries }

	const set = Object.freeze({
		entries: Object.freeze([...entries]),
		[validatedAdapterSetBrand]: true as const,
	})
	const themeSupport = evaluateSetThemeSupport(entries, input.themeIds ?? [])
	const evaluatedSummaries = summaries.map((summary) => {
		const unsupported = themeSupport.byAdapterIndex.get(summary.index)
		return unsupported ? { ...summary, unsupportedThemeIds: unsupported } : summary
	})
	return { state: 'valid', diagnostics: [], summaries: evaluatedSummaries, set, themeSupport: themeSupport.result }
}

/**
 * Asks every Adapter of a valid set that declares `themeSupport` about every Workspace theme ID, once
 * (Rule 01a11a5a-5464-7797-82d3-f8ece37457e5), with the entry's validated configuration. Diagnostic
 * paths name the Product Kit index.
 */
function evaluateSetThemeSupport(entries: readonly ValidatedAdapterEntry[], themeIds: readonly string[]): Readonly<{
	result: AdapterSetThemeSupport
	byAdapterIndex: ReadonlyMap<number, readonly string[]>
}> {
	const unsupported = new Set<string>()
	const diagnostics: Diagnostic[] = []
	const byAdapterIndex = new Map<number, readonly string[]>()
	for (const entry of entries) {
		if (!entry.manifest.themeSupport) continue
		const evaluation = evaluateAdapterThemeSupport(entry.manifest, entry.selection.config, themeIds, `/adapters/${entry.index}/manifest`)
		byAdapterIndex.set(entry.index, evaluation.unsupportedThemeIds)
		for (const themeId of evaluation.unsupportedThemeIds) unsupported.add(themeId)
		diagnostics.push(...evaluation.diagnostics)
	}
	return {
		result: { themeIds: [...themeIds], unsupportedThemeIds: themeIds.filter(themeId => unsupported.has(themeId)), diagnostics },
		byAdapterIndex,
	}
}

export async function installValidatedAdapterSet<Result>(
	set: ValidatedAdapterSet,
	installer: AdapterSetInstaller<Result>,
): Promise<Result> {
	return installer.install(set)
}

export type AdapterSetInstallationResult<Result> =
	| Extract<AdapterSetResolutionResult, { state: 'invalid' }>
	| Readonly<{ state: 'installed'; diagnostics: readonly []; summaries: readonly AdapterResolutionSummary[]; set: ValidatedAdapterSet; installed: Result }>

export async function resolveAndInstallWorkspaceAdapterSet<Result>(
	input: ResolveWorkspaceAdapterSetInput,
	installer: AdapterSetInstaller<Result>,
): Promise<AdapterSetInstallationResult<Result>> {
	const resolved = await resolveWorkspaceAdapterSet(input)
	if (resolved.state === 'invalid') return resolved
	const installed = await installValidatedAdapterSet(resolved.set, installer)
	return { state: 'installed', diagnostics: [], summaries: resolved.summaries, set: resolved.set, installed }
}

function prefixDiagnostics(diagnostics: readonly Diagnostic[], prefix: string): Diagnostic[] {
	return diagnostics.map(diagnostic => ({
		...diagnostic,
		path: `${prefix}${diagnostic.path || ''}`,
	}))
}

function mapSetDiagnosticsToWorkspaceAdapters(
	diagnostics: readonly Diagnostic[],
	entries: readonly ValidatedAdapterEntry[],
): Diagnostic[] {
	return diagnostics.map(diagnostic => {
		const match = /^\/(\d+)(\/.*)?$/u.exec(diagnostic.path)
		if (!match) return { ...diagnostic, path: '/adapters' }
		const resolvedIndex = Number(match[1])
		const workspaceIndex = entries[resolvedIndex]?.index
		return {
			...diagnostic,
			path: workspaceIndex === undefined ? '/adapters' : `/adapters/${workspaceIndex}${match[2] ?? ''}`,
		}
	})
}

/** `prefix`, then the cause's message with its host paths masked (`maskHostPaths`) against the Workspace roots. */
function diagnosticMessage(prefix: string, cause: unknown, roots: readonly string[]): string {
	return cause instanceof Error && cause.message ? `${prefix} ${maskHostPaths(cause.message, roots)}` : prefix
}

function isContainedPath(root: string, candidate: string): boolean {
	const path = relative(root, candidate)
	return path === '' || !escapesBase(path)
}

export type FileIdentity = Readonly<{ dev: bigint; ino: bigint }>

/** Reads a path's filesystem identity, or `undefined` when it is absent (never swallowing other errors). */
export type FileIdentityReader = (path: string) => Promise<FileIdentity | undefined>

/**
 * `stat`-backed identity reader. Only a genuinely absent path (`ENOENT`/`ENOTDIR`) yields `undefined`;
 * every other error (`EACCES`, `ELOOP`, `EIO`, …) propagates so resolution fails closed rather than
 * silently treating an unreadable directory as "not a data directory".
 */
export const statFileIdentity: FileIdentityReader = async (path) => {
	try {
		const info = await stat(path, { bigint: true })
		return { dev: info.dev, ino: info.ino }
	}
	catch (error) {
		if (isAbsentError(error))
			return undefined
		throw error
	}
}

/**
 * The identity of a code directory (`kit/`) only when it is a real directory: `lstat`, so a symbolic
 * link named `kit` never stands in for the directory it points to. Absence and any other entry type
 * yield `undefined` (nothing counts as inside `kit/`); other errors propagate, failing closed.
 */
export const realDirectoryIdentity: FileIdentityReader = async (path) => {
	try {
		const info = await lstat(path, { bigint: true })
		return info.isDirectory() && !info.isSymbolicLink() ? { dev: info.dev, ino: info.ino } : undefined
	}
	catch (error) {
		if (isAbsentError(error))
			return undefined
		throw error
	}
}

/** True when a `relative()` result leaves its base: `..` itself, a `../` prefix, or an absolute path (another drive). */
function escapesBase(rel: string): boolean {
	return rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith('../') || isAbsolute(rel)
}

function isAbsentError(error: unknown): boolean {
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Would importing `resolvedPath` (an already realpath-resolved module path) read authored data that an
 * Editor or Agent can write, letting uploaded data run as host code? It would when the module sits
 * inside the canonical data directories (see `CANONICAL_WORKSPACE_DATA_DIRECTORIES`) of ANY Workspace
 * on its path — the selected root, a sibling sharing an enclosing package, or an enclosing Workspace —
 * reachable through a monorepo symlink or a self-reference `exports`/`imports`.
 *
 * The selected Workspace root (`selectedWorkspaceRoot`, a realpath) is always a boundary. Every OTHER
 * ancestor directory that holds a Workspace manifest is treated as a Workspace root too. In the
 * schemaVersion 5 layout, where the former `.uiux/` directory is the root, the whole root but its
 * `kit/` code directory counts as data: the data directories, `artifacts/`, `history/` and the files
 * beside them. (Resolving from `kit/`, the `kit/node_modules/` exclusion and the `kit/package.json`
 * dependency guard belong to the resolver, `resolveFromCodeDirectory`.) Membership is
 * decided by file identity (`dev`/`ino`), never by name: a case-insensitive file system (WSL drvfs,
 * Docker Desktop bind mounts, exFAT/CIFS, ext4 casefold) can leave a realpath spelled `…/ASSETS/…`
 * that a string comparison against `assets` would miss.
 */
export async function resolvedPathEntersWorkspaceDataDirectory(
	resolvedPath: string,
	selectedWorkspaceRoot?: string,
	readIdentity: FileIdentityReader = statFileIdentity,
	readCodeDirectoryIdentity: FileIdentityReader = realDirectoryIdentity,
): Promise<boolean> {
	if (selectedWorkspaceRoot !== undefined) {
		if (await firstSegmentIsCanonicalDataDirectory(selectedWorkspaceRoot, resolvedPath, readIdentity))
			return true
		// A selected root in the schemaVersion 5 layout (its manifest directly under it, as persistence
		// detects it) keeps everything but `kit/` as Workspace data.
		if (await readIdentity(join(selectedWorkspaceRoot, V5_MANIFEST_PATH)) !== undefined
			&& await readIdentity(join(selectedWorkspaceRoot, WORKSPACE_MANIFEST_PATH)) === undefined
			&& await liesOutsideCodeDirectory(selectedWorkspaceRoot, resolvedPath, readIdentity, readCodeDirectoryIdentity))
			return true
	}
	// Scope: this guards data that Editors and Agents can author through the product. A data
	// directory that the host operator has symlinked or bind-mounted outside a Workspace is out of
	// scope — Editors and Agents cannot create such links, so only the operator can place one.
	let directory = dirname(resolvedPath)
	while (true) {
		if (directory !== selectedWorkspaceRoot) {
			const relocated = await isRelocatedWorkspaceRoot(directory, readIdentity)
			if (relocated && await liesOutsideCodeDirectory(directory, resolvedPath, readIdentity, readCodeDirectoryIdentity))
				return true
			// An old-layout Workspace keeps its manifest in `.uiux/`; a `.uiux/` that is itself a
			// relocated root is checked as one when the walk reaches it.
			if (!relocated && await readIdentity(join(directory, WORKSPACE_MANIFEST_PATH)) !== undefined
				&& !await isRelocatedWorkspaceRoot(join(directory, WORKSPACE_DATA_DIRECTORY.workspaceMeta), readIdentity)
				&& await firstSegmentIsCanonicalDataDirectory(directory, resolvedPath, readIdentity))
				return true
		}
		const parent = dirname(directory)
		if (parent === directory)
			return false
		directory = parent
	}
}

/**
 * A Workspace root in the schemaVersion 5 layout, recognized by the two files only such a root has
 * directly under it: the manifest `workspace.json` and the Product Kit file. Requiring both keeps an
 * unrelated `workspace.json` (other tools use the name) from turning a directory into a root.
 */
async function isRelocatedWorkspaceRoot(directory: string, readIdentity: FileIdentityReader): Promise<boolean> {
	return await readIdentity(join(directory, V5_MANIFEST_PATH)) !== undefined
		&& await readIdentity(join(directory, PRODUCT_KIT_FILENAME)) !== undefined
}

/**
 * Discussion #139 owner ruling 3 (2026-10-08), Clause 01a115cd-d109-76d3-9622-85d0080c60b6: from
 * schemaVersion 5, inside a Workspace root a module may lie only in that Workspace's `kit/`. Every
 * other path in the root (the data directories, `artifacts/`, `history/`, the runtime files, the
 * root files) is Workspace data. Membership in `kit/` is decided by file identity, like the
 * data-directory check.
 */
async function liesOutsideCodeDirectory(
	workspaceRoot: string,
	resolvedPath: string,
	readIdentity: FileIdentityReader,
	readCodeDirectoryIdentity: FileIdentityReader,
): Promise<boolean> {
	const rel = relative(workspaceRoot, resolvedPath)
	if (rel === '' || escapesBase(rel))
		return false
	const firstSegment = rel.split(/[/\\]/u)[0]
	if (firstSegment === undefined || firstSegment === '' || rel === firstSegment)
		return true
	const topIdentity = await readIdentity(join(workspaceRoot, firstSegment))
	const codeIdentity = await readCodeDirectoryIdentity(join(workspaceRoot, V5_CODE_DIRECTORY))
	return !topIdentity || !codeIdentity || topIdentity.dev !== codeIdentity.dev || topIdentity.ino !== codeIdentity.ino
}

async function firstSegmentIsCanonicalDataDirectory(
	workspaceRoot: string,
	resolvedPath: string,
	readIdentity: FileIdentityReader,
): Promise<boolean> {
	const rel = relative(workspaceRoot, resolvedPath)
	if (rel === '' || escapesBase(rel))
		return false
	const firstSegment = rel.split(/[/\\]/u)[0]
	if (firstSegment === undefined || firstSegment === '')
		return false
	const topIdentity = await readIdentity(join(workspaceRoot, firstSegment))
	if (!topIdentity)
		return false
	for (const name of CANONICAL_WORKSPACE_DATA_DIRECTORIES) {
		const dataIdentity = await readIdentity(join(workspaceRoot, name))
		if (dataIdentity && dataIdentity.dev === topIdentity.dev && dataIdentity.ino === topIdentity.ino)
			return true
	}
	return false
}

async function findNearestPackageMetadata(resolvedPath: string): Promise<Readonly<{ name?: string; version?: string }>> {
	let directory = dirname(resolvedPath)
	while (true) {
		try {
			const parsed = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as unknown
			if (isPackageMetadata(parsed))
				return {
					...(parsed.name ? { name: parsed.name } : {}),
					...(parsed.version ? { version: parsed.version } : {}),
				}
		}
		catch {
			// Keep walking: local adapter files need not have package metadata.
		}
		const parent = dirname(directory)
		if (parent === directory) return {}
		directory = parent
	}
}

function isPackageMetadata(value: unknown): value is Readonly<{ name?: string; version?: string }> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const record = value as Record<string, unknown>
	return (record.name === undefined || typeof record.name === 'string')
		&& (record.version === undefined || typeof record.version === 'string')
}
