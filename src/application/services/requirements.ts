import { settledValue, type FileNativePersistence, type JsonResourceRepository } from '../../persistence/file-native'
import { PersistenceError } from '../../persistence/errors'
import type { FlowResource } from '../../domain/flows/schema'
import type { RequirementsSetting } from '../../domain/requirements/schema'
import type { ViewResource } from '../../domain/views/schema'
import { readRequirementsProvider, type RequirementsProviderOptions, type RequirementsProviderRead } from './requirements-provider'

/**
 * Requirement coverage (Clause 01a18120-f903-7f8d-9b44-d581ab520c0d), the content of the MCP Resource
 * `uiux://requirements` and of the Workbench's Overview Requirements tab.
 */
export type RequirementReferrer = Readonly<{ kind: 'view' | 'variant' | 'flow'; viewId?: string; variantName?: string; flowId?: string }>
export type RequirementState = 'referenced' | 'unreferenced' | 'noUi'
export type RequirementCoverageEntry = Readonly<{ id: string; state: RequirementState; statement: string; reason?: string; referencedBy: readonly RequirementReferrer[] }>
export type RequirementIdReferences = Readonly<{ id: string; referencedBy: readonly RequirementReferrer[] }>
export type RequirementsProviderStatus = 'none' | 'url' | 'ok' | 'unavailable'

export type RequirementsCoverage = Readonly<{
	/** The manifest's `requirements` setting without `noUi`, or `null`. */
	provider: Readonly<Record<string, string>> | null
	status: RequirementsProviderStatus
	counts: Readonly<{ referenced: number; unreferenced: number; noUi: number; unresolved: number; unverified: number }>
	requirements: readonly RequirementCoverageEntry[]
	unresolved: readonly RequirementIdReferences[]
	unverified: readonly RequirementIdReferences[]
}>

export type RequirementsService = Readonly<{
	readCoverage(): Promise<RequirementsCoverage>
	/** The provider read of the manifest's current setting, for the diagnostics of a write's result. */
	readProvider(): Promise<RequirementsProviderRead>
}>

/** The valid requirement IDs of an array member, whatever the resource's other diagnostics (a broken member lists nothing). */
function idsOf(value: unknown): readonly string[] {
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id.length > 0) : []
}

/**
 * Who references each requirement ID: a View (its Spec's `requirements`), a Variant (its entry's)
 * or a UX Flow, in View, then Variant, then Flow order by key (Rule 01a18120-fa17-…: a View counts as
 * referencing a requirement when the View or any of its Variants lists it).
 */
export function collectRequirementReferences(
	views: ReadonlyMap<string, ViewResource>,
	flows: ReadonlyMap<string, FlowResource>,
): ReadonlyMap<string, readonly RequirementReferrer[]> {
	const byId = new Map<string, RequirementReferrer[]>()
	const add = (id: string, referrer: RequirementReferrer) => {
		const list = byId.get(id)
		if (list) list.push(referrer)
		else byId.set(id, [referrer])
	}
	for (const viewId of [...views.keys()].sort()) {
		const view = views.get(viewId)!
		for (const id of idsOf(view.spec?.requirements)) add(id, { kind: 'view', viewId })
		for (const [variantName, entry] of Object.entries(view.variants ?? {}))
			for (const id of idsOf(entry?.requirements)) add(id, { kind: 'variant', viewId, variantName })
	}
	for (const flowId of [...flows.keys()].sort()) {
		for (const id of idsOf(flows.get(flowId)!.requirements)) add(id, { kind: 'flow', flowId })
	}
	return byId
}

/** Pure coverage computation from a provider read and the references (Rules 01a18120-fd5d-…, fde6-… and 01a1814f-8133-…). */
export function computeRequirementsCoverage(
	setting: RequirementsSetting | undefined,
	read: RequirementsProviderRead,
	references: ReadonlyMap<string, readonly RequirementReferrer[]>,
): RequirementsCoverage {
	const provider = setting ? Object.fromEntries(Object.entries(setting).filter(([key]) => key !== 'noUi')) as Record<string, string> : null
	const referencedIds = [...references.keys()].sort()
	if (read.status !== 'ok') {
		const unverified = referencedIds.map(id => ({ id, referencedBy: references.get(id)! }))
		return {
			provider,
			status: read.status,
			counts: { referenced: 0, unreferenced: 0, noUi: 0, unresolved: 0, unverified: unverified.length },
			requirements: [],
			unresolved: [],
			unverified,
		}
	}
	const requirements: RequirementCoverageEntry[] = [...read.rules.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([id, statement]) => {
			const referencedBy = references.get(id) ?? []
			const reason = read.noUi[id]
			const state: RequirementState = reason !== undefined ? 'noUi' : referencedBy.length > 0 ? 'referenced' : 'unreferenced'
			return { id, state, statement, ...(reason !== undefined ? { reason } : {}), referencedBy }
		})
	const lacking = new Set([...referencedIds, ...Object.keys(read.noUi)].filter(id => !read.rules.has(id)))
	const unresolved = [...lacking].sort().map(id => ({ id, referencedBy: references.get(id) ?? [] }))
	const count = (state: RequirementState) => requirements.filter(entry => entry.state === state).length
	return {
		provider,
		status: 'ok',
		counts: { referenced: count('referenced'), unreferenced: count('unreferenced'), noUi: count('noUi'), unresolved: unresolved.length, unverified: 0 },
		requirements,
		unresolved,
		unverified: [],
	}
}

export function createRequirementsService(persistence: FileNativePersistence, options: RequirementsProviderOptions = {}): RequirementsService {
	async function readSetting(): Promise<RequirementsSetting | undefined> {
		const read = await persistence.workspace.readInspected()
		const setting = read.resource?.requirements
		return setting && typeof setting === 'object' ? setting : undefined
	}

	async function readProvider(): Promise<RequirementsProviderRead> {
		return readRequirementsProvider(persistence.root, await readSetting(), options)
	}

	async function readResources<T>(repository: JsonResourceRepository<string, T>): Promise<Map<string, T>> {
		const resources = new Map<string, T>()
		for (const { key, read: settled } of await repository.readAllInspected()) {
			let read: Awaited<ReturnType<typeof repository.readInspected>>
			try { read = settledValue(settled) }
			catch (error) {
				// A file that is not valid JSON references nothing, as discovery lists it as unreadable.
				if (error instanceof PersistenceError && error.code === 'persistence.invalid_json') continue
				throw error
			}
			if (read?.resource && typeof read.resource === 'object') resources.set(key, read.resource)
		}
		return resources
	}

	async function readCoverage(): Promise<RequirementsCoverage> {
		const setting = await readSetting()
		const [read, views, flows] = await Promise.all([
			readRequirementsProvider(persistence.root, setting, options),
			readResources(persistence.views),
			readResources(persistence.flows),
		])
		return computeRequirementsCoverage(setting, read, collectRequirementReferences(views, flows))
	}

	return { readCoverage, readProvider }
}
