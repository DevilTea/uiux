import { readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { CANONICAL_WORKSPACE_DATA_DIRECTORIES, WORKSPACE_MANIFEST_PATH } from '../persistence/paths'

import { resolve as resolveImport } from 'import-meta-resolve'
import {
	validateAdapterConfig,
	validateAdapterConfigSchema,
	validateAdapterManifest,
	validateResolvedAdapterSet,
	type AdapterManifest,
	type ResolvedAdapterRegistries,
} from '../domain/adapters/schema'
import type { Diagnostic } from '../domain/validation'
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
}>

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

/** Loads ESM using the resolved identity while leaving export-name semantics to the integration boundary. */
export class NodeAdapterManifestLoader implements AdapterManifestLoader {
	constructor(private readonly extractManifest: AdapterManifestExtractor) {}

	async loadManifest(resolved: ResolvedAdapterModule): Promise<unknown> {
		const namespace = await import(resolved.moduleIdentity) as Readonly<Record<string, unknown>>
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
	| Readonly<{ state: 'valid'; diagnostics: readonly []; summaries: readonly AdapterResolutionSummary[]; set: ValidatedAdapterSet }>
	| Readonly<{ state: 'invalid'; diagnostics: readonly Diagnostic[]; summaries: readonly AdapterResolutionSummary[] }>

export type ResolveWorkspaceAdapterSetInput = Readonly<{
	workspaceRoot: string
	adapters: readonly WorkspaceAdapterSelection[]
	resolver: AdapterModuleResolver
	loader: AdapterManifestLoader
	apiCompatibility: AdapterApiCompatibilityPolicy
	registryInspector: AdapterRegistryInspector
}>

export interface AdapterSetInstaller<Result> {
	install(set: ValidatedAdapterSet): Promise<Result>
}

export class NodeWorkspaceAdapterModuleResolver implements AdapterModuleResolver {
	async resolve(workspaceRoot: string, moduleSpecifier: string): Promise<ResolvedAdapterModule> {
		if (!isPortableAdapterModuleSpecifier(moduleSpecifier))
			throw new Error('Adapter module specifier is not a canonical portable module reference.')

		const root = resolve(workspaceRoot)
		const relativeSelection = moduleSpecifier.startsWith('./')
		if (relativeSelection) {
			const authoredTarget = resolve(root, moduleSpecifier)
			if (!isContainedPath(root, authoredTarget))
				throw new Error('Workspace-relative adapter module specifier escapes the selected Workspace root.')
		}

		const parentUrl = pathToFileURL(join(root, '.uiux-adapter-resolution.mjs')).href
		const moduleIdentity = resolveImport(moduleSpecifier, parentUrl)
		if (!moduleIdentity.startsWith('file:'))
			throw new Error('Adapter module must resolve to a file-backed module.')
		const resolvedPath = await realpath(fileURLToPath(moduleIdentity))

		const realRoot = await realpath(root)
		if (relativeSelection && !isContainedPath(realRoot, resolvedPath))
			throw new Error('Workspace-relative adapter module resolves outside the selected Workspace root.')
		// Applies to every specifier, not only `./` ones, and to every Workspace on the resolved
		// path (the selected root, a sibling, or an enclosing one): a bare specifier can resolve via
		// a monorepo symlink or a self-reference `exports`/`imports` into any Workspace's data.
		if (await resolvedPathEntersWorkspaceDataDirectory(resolvedPath, realRoot))
			throw new Error('Adapter module resolves inside a canonical Workspace data directory; Adapter code must live outside authored data directories that Editors and Agents can write.')

		const packageMetadata = relativeSelection ? {} : await findNearestPackageMetadata(resolvedPath)
		return {
			moduleSpecifier,
			resolvedPath,
			moduleIdentity: pathToFileURL(resolvedPath).href,
			...(packageMetadata.name ? { packageName: packageMetadata.name } : {}),
			...(packageMetadata.version ? { packageVersion: packageMetadata.version } : {}),
		}
	}
}

export async function resolveWorkspaceAdapterSet(input: ResolveWorkspaceAdapterSetInput): Promise<AdapterSetResolutionResult> {
	const diagnostics: Diagnostic[] = []
	const summaries: AdapterResolutionSummary[] = []
	const entries: ValidatedAdapterEntry[] = []
	const ownership: ResolvedAdapterRegistries[] = []

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
				message: diagnosticMessage('Adapter module could not be resolved from the selected Workspace root.', cause),
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
				message: diagnosticMessage('Resolved adapter module did not provide a readable canonical manifest.', cause),
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
				message: `Adapter ${manifest.id} declares an unsupported UIUX adapter API version.`,
			})
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
				message: diagnosticMessage('Adapter registry ownership could not be inspected.', cause),
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
	return { state: 'valid', diagnostics: [], summaries, set }
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

function diagnosticMessage(prefix: string, cause: unknown): string {
	return cause instanceof Error && cause.message ? `${prefix} ${cause.message}` : prefix
}

function isContainedPath(root: string, candidate: string): boolean {
	const path = relative(root, candidate)
	return path === '' || (!path.startsWith('..') && !isAbsolute(path))
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
 * ancestor directory that holds a Workspace manifest is treated as a Workspace root too. Membership is
 * decided by file identity (`dev`/`ino`), never by name: a case-insensitive file system (WSL drvfs,
 * Docker Desktop bind mounts, exFAT/CIFS, ext4 casefold) can leave a realpath spelled `…/ASSETS/…`
 * that a string comparison against `assets` would miss.
 */
export async function resolvedPathEntersWorkspaceDataDirectory(
	resolvedPath: string,
	selectedWorkspaceRoot?: string,
	readIdentity: FileIdentityReader = statFileIdentity,
): Promise<boolean> {
	if (selectedWorkspaceRoot !== undefined
		&& await firstSegmentIsCanonicalDataDirectory(selectedWorkspaceRoot, resolvedPath, readIdentity))
		return true
	let directory = dirname(resolvedPath)
	while (true) {
		if (directory !== selectedWorkspaceRoot) {
			const manifest = await readIdentity(join(directory, WORKSPACE_MANIFEST_PATH))
			if (manifest !== undefined && await firstSegmentIsCanonicalDataDirectory(directory, resolvedPath, readIdentity))
				return true
		}
		const parent = dirname(directory)
		if (parent === directory)
			return false
		directory = parent
	}
}

async function firstSegmentIsCanonicalDataDirectory(
	workspaceRoot: string,
	resolvedPath: string,
	readIdentity: FileIdentityReader,
): Promise<boolean> {
	const rel = relative(workspaceRoot, resolvedPath)
	if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
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
