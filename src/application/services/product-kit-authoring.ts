import { lstat, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

import { NodeWorkspaceAdapterModuleResolver } from '../../adapters/resolution'
import { checkProductKitAgainstKit, containedRealPath, locateKitProject, maskHostPaths, type KitProject } from '../../adapters/kit-registry'
import {
	PRODUCT_KIT_RESOURCE_KEY,
	PRODUCT_KIT_SCHEMA_VERSION,
	validateProductKit,
	type ProductKit,
	type ProductKitComponent,
	type ProductKitWidgetMapping,
} from '../../domain/product-kit/schema'
import { isRecord, type Diagnostic, type JsonValue } from '../../domain/validation'
import type { WorkspaceAdapterSelection } from '../../domain/workspace/schema'
import type { FileNativePersistence } from '../../persistence'
import { PersistenceError } from '../../persistence/errors'
import type { ResourceRevision } from '../dto/revisions'
import { validateResourceRevision } from '../dto/revisions'

/**
 * The Product Kit authoring operations (Clause 01a11bb1-b15c-734e-8968-c378db1444ca), shared by
 * `/api/product-kit/*` and the MCP Tools `compose_product_kit`, `update_product_kit` and
 * `update_component_registry`. Each writes only the Product Kit file, with `expectedRevision`
 * compare-and-swap, and only its own members:
 *
 * - `composeProductKit` sets `designSystems` and the Adapter specifiers and order. Each kept entry
 *   keeps its `config`: the entry holding the same specifier at the same occurrence; an added
 *   entry has none.
 * - `updateProductKit` sets the Adapters' `config` (the entries, by specifier and order, must be the
 *   current ones), `styles` and `themes`.
 * - `updateComponentRegistry` sets `components` and `widgets`.
 *
 * The result is validated like the file (`validateProductKit`) and against the kit project
 * (`checkProductKitAgainstKit`) before anything is stored. Access, the edit lease and the
 * design-write context belong to the scoped session; its key check runs here as the `guard`,
 * after the revision check and on the file the compare-and-swap replaces, so the keys checked are
 * those of the change written, and before the checks against the kit project, so a caller
 * without the keys causes no kit project I/O. A Workspace below `schemaVersion` 5 has no Product Kit file: the
 * operations refuse with `workspace.migration_required`.
 */
export type ProductKitAdapterSettings = Readonly<{ moduleSpecifier: string; config?: JsonValue }>

export type ComposeProductKitCommand = Readonly<{
	expectedRevision: string
	designSystems: readonly string[]
	/** The Adapter module specifiers, in order. */
	adapters: readonly string[]
}>

export type UpdateProductKitCommand = Readonly<{
	expectedRevision: string
	/** The current Adapters, by specifier and order, each with the `config` to store (none when absent). */
	adapters: readonly ProductKitAdapterSettings[]
	styles: readonly string[]
	themes: Readonly<Record<string, Readonly<Record<string, string>>>>
}>

export type UpdateComponentRegistryCommand = Readonly<{
	expectedRevision: string
	components: Readonly<Record<string, ProductKitComponent>>
	widgets: Readonly<Record<string, ProductKitWidgetMapping>>
}>

type Key = typeof PRODUCT_KIT_RESOURCE_KEY

export type ProductKitAuthoringResult =
	| Readonly<{ status: 'updated'; key: Key; revision: ResourceRevision; diagnostics: readonly Diagnostic[]; findings: readonly Diagnostic[] }>
	| Readonly<{ status: 'not_found'; key: Key }>
	| Readonly<{ status: 'conflict'; key: Key; currentRevision: ResourceRevision }>
	| Readonly<{ status: 'invalid_expected_revision'; key: Key; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'invalid'; key: Key; code?: string; diagnostics: readonly Diagnostic[] }>
	| Readonly<{ status: 'blocked'; key: Key; code: string; message: string; diagnostics: readonly Diagnostic[] }>

/** A caller's check of a Product Kit change against the file it replaces; see `WorkspaceSettingsGuard`. */
export type ProductKitGuard<R> = (change: Readonly<{ current: ProductKit; next: ProductKit }>) => R | undefined

/** The build state (Clause 01a11bb1-8856-737f-945c-e44c596f7782); UIUX runs no kit build yet, so it is `none`. */
export type ProductKitBuildState = 'none' | 'building' | 'ready' | 'failed'

export type ProductKitAdapterResolution =
	| Readonly<{ moduleSpecifier: string; status: 'resolved'; path?: string; packageName?: string; packageVersion?: string }>
	| Readonly<{ moduleSpecifier: string; status: 'failed'; message: string }>

export type ProductKitPackage = Readonly<{ package: string; status: 'resolved'; version?: string; linked: boolean } | { package: string; status: 'missing' }>

/** The Product Kit Resource (Clause 01a11bb1-b0f1-7e5d-85ad-230c43ad99fb). */
export type ProductKitRead = Readonly<{
	kind: 'product-kit'
	key: Key
	resource: ProductKit
	revision: ResourceRevision
	diagnostics: readonly Diagnostic[]
	build: Readonly<{ state: ProductKitBuildState }>
	adapters: readonly ProductKitAdapterResolution[]
	packages: readonly ProductKitPackage[]
	findings: readonly Diagnostic[]
}>

export type ProductKitAuthoringService = Readonly<{
	composeProductKit<R = never>(command: ComposeProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	updateProductKit<R = never>(command: UpdateProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	updateComponentRegistry<R = never>(command: UpdateComponentRegistryCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R>
	/** The Product Kit Resource, or `undefined` when the Workspace has no readable Product Kit file. */
	readProductKit(): Promise<ProductKitRead | undefined>
}>

const KEY: Key = PRODUCT_KIT_RESOURCE_KEY

type Build = (current: ProductKit) => Readonly<{ next: ProductKit }> | Readonly<{ diagnostics: readonly Diagnostic[] }>

export function createProductKitAuthoringService(persistence: FileNativePersistence): ProductKitAuthoringService {
	function kitLocation(): Readonly<{ directory: string; name: string }> | undefined {
		const name = persistence.layout.codeDir
		return name ? { directory: join(persistence.root, name), name } : undefined
	}

	function legacyRefusal(): ProductKitAuthoringResult {
		const message = `The Product Kit exists from Workspace schemaVersion ${PRODUCT_KIT_SCHEMA_VERSION}; this Workspace keeps its Adapters in the manifest. Run: uiux migrate --workspace <dir>`
		return { status: 'blocked', key: KEY, code: 'workspace.migration_required', message, diagnostics: [{ code: 'workspace.migration_required', path: '/schemaVersion', message }] }
	}

	function blocked(code: string, message: string, diagnostics: readonly Diagnostic[]): ProductKitAuthoringResult {
		return { status: 'blocked', key: KEY, code, message, diagnostics: diagnostics.length > 0 ? diagnostics : [{ code, path: '/schemaVersion', message }] }
	}

	async function mutate<R>(expected: string, build: Build, guard: ProductKitGuard<R> | undefined): Promise<ProductKitAuthoringResult | R> {
		const expectedRevision = validateResourceRevision(expected, '/expectedRevision')
		if (!expectedRevision.ok)
			return { status: 'invalid_expected_revision', key: KEY, diagnostics: expectedRevision.diagnostics }
		const kit = kitLocation()
		if (!persistence.layout.productKitPath || !kit) return legacyRefusal()

		try {
			const workspace = await persistence.workspace.readInspected()
			if (workspace.inspection.state === 'migration_required')
				return blocked('workspace.migration_required', 'The Workspace requires migration before the Product Kit can be changed. Run: uiux migrate --workspace <dir>', workspace.diagnostics)
			if (workspace.inspection.state !== 'current')
				return blocked('workspace.schema_unsupported', 'This UIUX build cannot change the Product Kit of this Workspace.', workspace.diagnostics)

			const current = await persistence.productKit.readInspected()
			if (!current) return { status: 'not_found', key: KEY }
			if (current.revision !== expectedRevision.value)
				return { status: 'conflict', key: KEY, currentRevision: current.revision }
			const currentKit = validateProductKit(current.resource)
			if (!currentKit.ok)
				return { status: 'invalid', key: KEY, code: 'product_kit.current_invalid', diagnostics: currentKit.diagnostics }

			const built = build(currentKit.value)
			if ('diagnostics' in built) return { status: 'invalid', key: KEY, diagnostics: built.diagnostics }
			const validation = validateProductKit(built.next)
			if (!validation.ok) return { status: 'invalid', key: KEY, diagnostics: validation.diagnostics }
			const next = validation.value

			const refused = guard?.({ current: currentKit.value, next })
			if (refused !== undefined) return refused

			const checked = await checkProductKitAgainstKit({ root: persistence.root, codeDirectoryName: kit.name, current: currentKit.value, next })
			if (checked.refusals.length > 0) {
				const registry = checked.refusals.some(item => item.code === 'kit.component_invalid')
				return { status: 'invalid', key: KEY, ...(registry ? { code: 'kit.component_invalid' } : {}), diagnostics: checked.refusals }
			}

			const commit = await persistence.productKit.compareAndSwap({ key: KEY, expectedRevision: expectedRevision.value, resource: next })
			if (!commit.ok) return { status: 'conflict', key: KEY, currentRevision: commit.conflict.currentRevision }
			const after = await persistence.productKit.readInspected()
			return { status: 'updated', key: KEY, revision: commit.revision, diagnostics: after?.diagnostics ?? [], findings: checked.findings }
		}
		catch (error) {
			if (!(error instanceof PersistenceError)) throw error
			switch (error.code) {
				case 'workspace.migration_required':
				case 'workspace.schema_unsupported':
					return blocked(error.code, error.message, error.diagnostics)
				case 'persistence.resource_not_found':
					return { status: 'not_found', key: KEY }
				case 'persistence.invalid_json':
					return blocked(error.code, `The current Product Kit file is not readable JSON, so it cannot be replaced. ${error.message}`, error.diagnostics)
				default:
					throw error
			}
		}
	}

	async function composeProductKit<R = never>(command: ComposeProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R> {
		return mutate(command.expectedRevision, current => ({
			next: { ...current, designSystems: [...command.designSystems], adapters: composeAdapters(current.adapters, command.adapters) },
		}), guard)
	}

	async function updateProductKit<R = never>(command: UpdateProductKitCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R> {
		return mutate(command.expectedRevision, (current) => {
			const currentSpecifiers = current.adapters.map(entry => entry.moduleSpecifier)
			const given = command.adapters.map(entry => entry.moduleSpecifier)
			if (currentSpecifiers.length !== given.length || currentSpecifiers.some((specifier, index) => specifier !== given[index])) {
				return { diagnostics: [{
					code: 'product_kit.adapters_not_current',
					path: '/adapters',
					message: `update_product_kit changes only the configuration of the current Adapters (${currentSpecifiers.join(', ') || 'none'}), in their order; change the specifiers or their order with compose_product_kit.`,
				}] }
			}
			return {
				next: {
					...current,
					adapters: command.adapters.map(entry => ({ moduleSpecifier: entry.moduleSpecifier, ...(entry.config === undefined ? {} : { config: entry.config }) })),
					styles: [...command.styles],
					themes: Object.fromEntries(Object.entries(command.themes).map(([id, attributes]) => [id, { ...attributes }])),
				},
			}
		}, guard)
	}

	async function updateComponentRegistry<R = never>(command: UpdateComponentRegistryCommand, guard?: ProductKitGuard<R>): Promise<ProductKitAuthoringResult | R> {
		return mutate(command.expectedRevision, current => ({
			next: { ...current, components: { ...command.components } as ProductKit['components'], widgets: { ...command.widgets } as ProductKit['widgets'] },
		}), guard)
	}

	async function readProductKit(): Promise<ProductKitRead | undefined> {
		const kit = kitLocation()
		if (!persistence.layout.productKitPath || !kit) return undefined
		const read = await persistence.productKit.readInspected()
		if (!read) return undefined
		const validation = validateProductKit(read.resource)
		const resource = read.resource
		const findings: Diagnostic[] = []
		let adapters: ProductKitAdapterResolution[] = []
		let packages: ProductKitPackage[] = []
		if (validation.ok) {
			const checked = await checkProductKitAgainstKit({ root: persistence.root, codeDirectoryName: kit.name, next: validation.value })
			findings.push(...checked.refusals, ...checked.findings)
			const project = await locateKitProject(persistence.root, kit.name)
			adapters = await resolveAdapters(project, validation.value.adapters)
			packages = await Promise.all(validation.value.designSystems.map(name => resolvePackage(project, name)))
		}
		return { kind: 'product-kit', key: KEY, resource, revision: read.revision, diagnostics: read.diagnostics, build: { state: 'none' }, adapters, packages, findings }
	}

	async function resolveAdapters(project: KitProject, entries: readonly WorkspaceAdapterSelection[]): Promise<ProductKitAdapterResolution[]> {
		const resolver = new NodeWorkspaceAdapterModuleResolver({ layout: persistence.layout })
		const roots = [...new Set([project.realRoot, persistence.root])]
		const results: ProductKitAdapterResolution[] = []
		for (const entry of entries) {
			try {
				const resolved = await resolver.resolve(persistence.root, entry.moduleSpecifier)
				const inKit = project.directory ? relative(project.directory, resolved.resolvedPath) : '..'
				const path = inKit !== '' && !inKit.startsWith('..') && !inKit.startsWith(sep) ? inKit.split(sep).join('/') : undefined
				// A module that resolves outside the Workspace (a linked or an ancestor's package) is
				// reported without the package name and version found there.
				const inWorkspace = await containedRealPath(project.realRoot, resolved.resolvedPath) !== undefined
				results.push({
					moduleSpecifier: entry.moduleSpecifier,
					status: 'resolved',
					// A host path is never reported: only a path inside the kit project.
					...(entry.moduleSpecifier.startsWith('./') && path ? { path } : {}),
					...(inWorkspace && resolved.packageName ? { packageName: resolved.packageName } : {}),
					...(inWorkspace && resolved.packageVersion ? { packageVersion: resolved.packageVersion } : {}),
				})
			}
			catch (error) {
				results.push({ moduleSpecifier: entry.moduleSpecifier, status: 'failed', message: maskHostPaths(error instanceof Error ? error.message : String(error), roots) })
			}
		}
		return results
	}

	return Object.freeze({ composeProductKit, updateProductKit, updateComponentRegistry, readProductKit })
}

/**
 * The Adapter list a composition writes: the given specifiers in order, each kept entry with the
 * `config` of the entry holding the same specifier at the same occurrence in `current`.
 */
export function composeAdapters(current: readonly WorkspaceAdapterSelection[], specifiers: readonly string[]): WorkspaceAdapterSelection[] {
	const configs = new Map<string, (JsonValue | undefined)[]>()
	for (const entry of current) configs.set(entry.moduleSpecifier, [...(configs.get(entry.moduleSpecifier) ?? []), entry.config as JsonValue | undefined])
	const seen = new Map<string, number>()
	return specifiers.map((moduleSpecifier) => {
		const occurrence = seen.get(moduleSpecifier) ?? 0
		seen.set(moduleSpecifier, occurrence + 1)
		const config = configs.get(moduleSpecifier)?.[occurrence]
		return config === undefined ? { moduleSpecifier } : { moduleSpecifier, config }
	})
}

/**
 * An external package as Node module resolution finds it inside the Workspace: the first
 * `node_modules/<name>/package.json` in `kit/` or the Workspace root. `linked` marks a package
 * directory reached through a symbolic link (Clause 01a11bb1-8b6e-7185-b0ac-cb84c3fcc24a).
 *
 * A link on the way (`node_modules` itself, a scope directory or the package directory) whose
 * target lies outside the Workspace, or does not resolve, ends the lookup there: the package is
 * reported as `resolved` and `linked` with no version, whether or not anything exists behind the
 * link, so nothing outside the Workspace is read or told apart.
 */
async function resolvePackage(project: KitProject, name: string): Promise<ProductKitPackage> {
	if (!project.directory) return { package: name, status: 'missing' }
	const segments = name.split('/')
	for (const directory of [project.directory, project.realRoot]) {
		let linked = false
		let present = true
		for (let index = 0; index <= segments.length; index++) {
			const path = join(directory, 'node_modules', ...segments.slice(0, index))
			const info = await lstat(path).catch(() => undefined)
			if (!info) {
				present = false
				break
			}
			if (info.isSymbolicLink()) {
				linked = true
				if (await containedRealPath(project.realRoot, path) === undefined) return { package: name, status: 'resolved', linked: true }
			}
		}
		if (!present) continue
		const real = await containedRealPath(project.realRoot, join(directory, 'node_modules', ...segments))
		if (real === undefined) continue
		const manifestPath = await containedRealPath(project.realRoot, join(real, 'package.json'))
		const manifest = manifestPath === undefined ? undefined : await readFile(manifestPath, 'utf8').catch(() => undefined)
		if (manifest === undefined) continue
		let version: string | undefined
		try {
			const parsed: unknown = JSON.parse(manifest)
			if (isRecord(parsed) && typeof parsed.version === 'string') version = parsed.version
		}
		catch { /* an unreadable package.json names no version */ }
		return { package: name, status: 'resolved', ...(version ? { version } : {}), linked }
	}
	return { package: name, status: 'missing' }
}
