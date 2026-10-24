import { adapterGraphDigest } from '../../adapters/adapter-graph-digest'
import {
	extractProductAdapterManifest,
	productAdapterApiCompatibility,
	productAdapterRegistryInspector,
} from '../../adapters/product-integration'
import {
	adapterResolutionBase,
	NodeAdapterManifestLoader,
	NodeWorkspaceAdapterModuleResolver,
	resolveWorkspaceAdapterSet,
	type AdapterSetResolutionResult,
	type ValidatedAdapterEntry,
} from '../../adapters/resolution'
import { adapterConfigDigest, type AdapterProvenance } from '../../domain/adapters/schema'
import { evidenceAdapterProvenance, type CurrentAdapterProvenance } from '../../domain/evidence/adapter-provenance'
import type { WorkspaceAdapterSelection } from '../../domain/workspace/schema'
import type { FileNativePersistence } from '../../persistence'
import type { KitBuildStatus } from '../ports/kit-build'
import { EXPIRED, IN_LOCK_PROVENANCE_BUDGET_MS, withinBudget } from '../../adapters/kit-provenance'
import { validateProductKit } from '../../domain/product-kit/schema'
import type { JsonObject } from '../../domain/validation'
import { diagnostics } from '../../logging/diagnostics'

/**
 * Content digests already computed during one operation, by resolved entry module, so that an
 * operation that judges Evidence freshness and records provenance (Handoff export) bundles each
 * Adapter's module graph once. Nothing is cached across operations (issue #304).
 */
export type AdapterGraphDigestCache = Map<string, Promise<string | undefined>>

/** Resolves an Adapter list as the Preview resolves the Workspace's (`resolveSelectedWorkspaceAdapterList` in `src/server/`). */
export type AdapterSetResolver = (adapters: readonly WorkspaceAdapterSelection[]) => Promise<AdapterSetResolutionResult>

/**
 * Where Adapter provenance comes from under `uiux dev` (Rule 01a167bf-1f93-78b7-9045-6562c20f5a42):
 * the server's resolution, the one the Preview renders with, pinned to the last good kit build
 * output; and the kit build state, while it is running or its last run failed the current Adapter
 * provenance cannot be computed (Rule 01a167d8-acd9-727d-9ab8-7395a4843897). Without it (no server,
 * no build), the Adapters resolve from the files on disk.
 */
export type AdapterProvenanceSource = Readonly<{
	resolve?: AdapterSetResolver
	/**
	 * The content digest of an entry of a resolution pinned to a kit build output generation, taken
	 * when that generation was captured (`pinnedAdapterContentDigest` in `src/server/`); `undefined`
	 * for an entry of no pinned resolution, whose digest is computed from the files on disk.
	 */
	pinnedContentDigest?: (entry: ValidatedAdapterEntry) => Promise<string | undefined> | undefined
	/** The identity of the kit build's last good output generation, if any. */
	outputGeneration?: () => string | undefined
	kitBuild?: () => KitBuildStatus
}>

/** Whether the current Adapter provenance can be computed as far as the kit build goes: not while it is running or its last run failed (Rule 01a167d8-acd9-727d-9ab8-7395a4843897). */
export function kitBuildAllowsAdapterProvenance(source: AdapterProvenanceSource | undefined): boolean {
	const state = source?.kitBuild?.().state
	return state !== 'building' && state !== 'failed'
}

/**
 * Runs `compute` while the kit build allows Adapter provenance, and gives `unavailable` instead
 * when it does not, before or after `compute` ran, or when a new output generation settled
 * meanwhile, so a result never mixes two generations or outlives the state that allowed it.
 */
export async function withSettledKitBuild(source: AdapterProvenanceSource | undefined, compute: () => Promise<CurrentAdapterProvenance>): Promise<CurrentAdapterProvenance> {
	if (!kitBuildAllowsAdapterProvenance(source)) return { state: 'unavailable' }
	const generation = source?.outputGeneration?.()
	const result = await compute()
	if (!kitBuildAllowsAdapterProvenance(source) || source?.outputGeneration?.() !== generation) return { state: 'unavailable' }
	return result
}

/**
 * Resolves Product Kit Adapter selections as Handoff export and Evidence provenance resolve them:
 * through the server's resolution when `source` supplies it (Rule 01a167bf-1f93-…), otherwise from
 * `kit/` (Clauses 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6),
 * with the product integration's manifest extraction, API compatibility and registry inspection.
 */
export function resolveProductKitAdapterSet(persistence: FileNativePersistence, adapters: readonly WorkspaceAdapterSelection[], source?: AdapterProvenanceSource): Promise<AdapterSetResolutionResult> {
	if (source?.resolve) return source.resolve(adapters)
	return resolveWorkspaceAdapterSet({
		workspaceRoot: persistence.root,
		adapters,
		resolver: new NodeWorkspaceAdapterModuleResolver({ layout: persistence.layout }),
		loader: new NodeAdapterManifestLoader(extractProductAdapterManifest),
		apiCompatibility: productAdapterApiCompatibility,
		registryInspector: productAdapterRegistryInspector,
	})
}

/**
 * One resolved Adapter's provenance (Clause 01a115cd-d7f6-74a1-ba9f-c20a24a31ae5): its content digest
 * covers the Adapter's whole bundled module graph, and its configuration digest the entry's validated
 * `config`, absent when it has none. The content digest is absent when it cannot be computed now (the
 * graph cannot be bundled or read). `undefined` when the Adapter has neither a package version nor a
 * content digest, so it has no verifiable identity to record.
 */
export async function adapterEntryProvenance(
	persistence: FileNativePersistence,
	entry: ValidatedAdapterEntry,
	digests?: AdapterGraphDigestCache,
	source?: AdapterProvenanceSource,
): Promise<AdapterProvenance | undefined> {
	const path = entry.resolvedModule.resolvedPath
	let pending = digests?.get(path)
	if (!pending) {
		// The digest taken with the pinned output generation the entry was resolved from (Rule 01a167bf-1f93-…).
		pending = source?.pinnedContentDigest?.(entry) ?? adapterGraphDigest({
			workspaceRoot: persistence.root,
			moduleBase: adapterResolutionBase(persistence.root, persistence.layout),
			entry: path,
		})
		digests?.set(path, pending)
	}
	const contentDigest = await pending
	const configDigest = await adapterConfigDigest(entry.selection.config)
	if (!entry.resolvedModule.packageVersion && !contentDigest) return undefined
	return {
		moduleSpecifier: entry.selection.moduleSpecifier,
		adapterId: entry.manifest.id,
		apiVersion: entry.manifest.apiVersion,
		moduleIdentity: entry.resolvedModule.moduleIdentity,
		...(entry.resolvedModule.packageVersion ? { packageVersion: entry.resolvedModule.packageVersion } : {}),
		...(contentDigest ? { contentDigest } : {}),
		...(configDigest ? { configDigest } : {}),
	}
}

/**
 * The Evidence Adapter provenance of a resolution (Clause 01a1161c-008a-746d-8d53-a8301b23588f):
 * every Adapter of the set in Adapter-list order, or `unavailable` when the set is invalid or an
 * Adapter's content digest cannot be computed now (Rule 01a164bc-4e09-78be-91fe-e7ecb3c42edb). The
 * latter holds for an Adapter with a package version too: its digest is absent only when bundling
 * or reading its graph failed, possibly for a transient reason, and provenance without it would
 * differ from a capture that recorded one, reporting the Adapter changed when nothing did.
 */
export async function adapterSetEvidenceProvenance(
	persistence: FileNativePersistence,
	resolution: AdapterSetResolutionResult,
	digests?: AdapterGraphDigestCache,
	source?: AdapterProvenanceSource,
): Promise<CurrentAdapterProvenance> {
	if (resolution.state !== 'valid') return { state: 'unavailable' }
	const adapters = []
	for (const entry of resolution.set.entries) {
		const provenance = await adapterEntryProvenance(persistence, entry, digests, source)
		if (!provenance?.contentDigest) return { state: 'unavailable' }
		adapters.push(evidenceAdapterProvenance(provenance))
	}
	return { state: 'available', adapters }
}

/**
 * The Workspace's current Adapter provenance, which formal capture records and Evidence freshness is
 * judged against (Clause 01a1161c-008a-… and Rule 01a115cd-c6de-…): the active set is the Product Kit
 * file's Adapter list, resolved through `source` when given (Rule 01a167bf-1f93-…). `unavailable`
 * (Rules 01a167d8-acd9-… and 01a164bc-4e09-…) while a kit build is running or its last run failed, or when that file
 * cannot be read, the set does not resolve, or an Adapter's content digest cannot be computed now.
 */
export async function readCurrentAdapterProvenance(persistence: FileNativePersistence, source?: AdapterProvenanceSource): Promise<CurrentAdapterProvenance> {
	try {
		return await withSettledKitBuild(source, async () => {
			const productKit = await persistence.productKit.read().catch(() => undefined)
			if (!productKit) return { state: 'unavailable' }
			const adapters = productKit.resource.adapters ?? []
			if (adapters.length === 0) return { state: 'available', adapters: [] }
			return await adapterSetEvidenceProvenance(persistence, await resolveProductKitAdapterSet(persistence, adapters, source), undefined, source)
		})
	}
	catch {
		return { state: 'unavailable' }
	}
}

/** The longest a version or Checkpoint record, which holds the persistence lock, waits for the Adapter provenance (as for the Product Kit provenance, `IN_LOCK_PROVENANCE_BUDGET_MS`). */
export const IN_LOCK_ADAPTER_PROVENANCE_BUDGET_MS = IN_LOCK_PROVENANCE_BUDGET_MS

/**
 * The `adapters` member of a version or Checkpoint record (Clause 01a11a5e-201a-7532-8192-517b439c6c0c;
 * Rule 01a11a5e-06fb-79c5-8396-d50d08780a6d), for a caller that holds the persistence lock: `{ adapters }`
 * with the active set in the Adapter provenance shape of a formal capture record, or `{}` when it is
 * not known (the same cases as {@link readCurrentAdapterProvenance}: a kit build running or failed,
 * the Product Kit file unreadable, the set invalid, a content digest not computable) or not known
 * within the budget, so recording a version never fails or overstays the lock for it. The Product
 * Kit file is read under the caller's lock; the Adapters resolve and bundle without it.
 */
export async function adapterRecordFieldUnlocked(
	persistence: FileNativePersistence,
	source: AdapterProvenanceSource | undefined,
	options: Readonly<{ budgetMilliseconds?: number; log?: (message: string) => void }> = {},
): Promise<Readonly<{ adapters?: JsonObject[] }>> {
	try {
		if (!kitBuildAllowsAdapterProvenance(source)) return {}
		const productKitPath = persistence.layout.productKitPath
		const bytes = productKitPath ? await persistence.readOptionalBytesUnlocked(productKitPath) : undefined
		if (!bytes) return {}
		let parsed: unknown
		try {
			parsed = JSON.parse(new TextDecoder().decode(bytes))
		}
		catch {
			return {}
		}
		const validated = validateProductKit(parsed)
		if (!validated.ok) return {}
		const selections = validated.value.adapters
		if (selections.length === 0) return { adapters: [] }
		const budget = options.budgetMilliseconds ?? IN_LOCK_ADAPTER_PROVENANCE_BUDGET_MS
		const current = await withinBudget(
			withSettledKitBuild(source, async () => adapterSetEvidenceProvenance(persistence, await resolveProductKitAdapterSet(persistence, selections, source), undefined, source)),
			budget,
		)
		if (current === EXPIRED) {
			const log = options.log ?? (message => diagnostics.error(message))
			log(`uiux: the Adapter provenance was not computed within ${budget} ms under the persistence lock; this history record goes without adapters.`)
			return {}
		}
		return current?.state === 'available' ? { adapters: current.adapters as unknown as JsonObject[] } : {}
	}
	catch {
		return {}
	}
}
