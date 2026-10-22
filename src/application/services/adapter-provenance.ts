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

/**
 * Content digests already computed during one operation, by resolved entry module, so that an
 * operation that judges Evidence freshness and records provenance (Handoff export) bundles each
 * Adapter's module graph once.
 */
export type AdapterGraphDigestCache = Map<string, Promise<string | undefined>>

/**
 * Resolves Product Kit Adapter selections as Handoff export and Evidence provenance resolve them:
 * from `kit/` (Clauses 01a1144e-538e-705f-afdc-841028c410e4 and 01a115cd-d109-76d3-9622-85d0080c60b6),
 * with the product integration's manifest extraction, API compatibility and registry inspection.
 */
export function resolveProductKitAdapterSet(persistence: FileNativePersistence, adapters: readonly WorkspaceAdapterSelection[]): Promise<AdapterSetResolutionResult> {
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
 * `config`, absent when it has none. `undefined` when the Adapter has neither a package version nor a
 * content digest, so it has no verifiable identity to record.
 */
export async function adapterEntryProvenance(
	persistence: FileNativePersistence,
	entry: ValidatedAdapterEntry,
	digests?: AdapterGraphDigestCache,
): Promise<AdapterProvenance | undefined> {
	const path = entry.resolvedModule.resolvedPath
	let pending = digests?.get(path)
	if (!pending) {
		pending = adapterGraphDigest({
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
 * Adapter has no verifiable identity.
 */
export async function adapterSetEvidenceProvenance(
	persistence: FileNativePersistence,
	resolution: AdapterSetResolutionResult,
	digests?: AdapterGraphDigestCache,
): Promise<CurrentAdapterProvenance> {
	if (resolution.state !== 'valid') return { state: 'unavailable' }
	const adapters = []
	for (const entry of resolution.set.entries) {
		const provenance = await adapterEntryProvenance(persistence, entry, digests)
		if (!provenance) return { state: 'unavailable' }
		adapters.push(evidenceAdapterProvenance(provenance))
	}
	return { state: 'available', adapters }
}

/**
 * The Workspace's current Adapter provenance, which formal capture records and Evidence freshness is
 * judged against (Clause 01a1161c-008a-… and Rule 01a115cd-c6de-…): the active set is the Product Kit
 * file's Adapter list. `unavailable` when that file cannot be read, the set does not resolve, or an
 * Adapter has no verifiable identity.
 */
export async function readCurrentAdapterProvenance(persistence: FileNativePersistence): Promise<CurrentAdapterProvenance> {
	try {
		const productKit = await persistence.productKit.read().catch(() => undefined)
		if (!productKit) return { state: 'unavailable' }
		const adapters = productKit.resource.adapters ?? []
		if (adapters.length === 0) return { state: 'available', adapters: [] }
		return await adapterSetEvidenceProvenance(persistence, await resolveProductKitAdapterSet(persistence, adapters))
	}
	catch {
		return { state: 'unavailable' }
	}
}
