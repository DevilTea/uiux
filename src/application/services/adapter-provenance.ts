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
 * provenance cannot be computed (Rule 01a164bc-4e09-78be-91fe-e7ecb3c42edb). Without it (no server,
 * no build), the Adapters resolve from the files on disk.
 */
export type AdapterProvenanceSource = Readonly<{
	resolve?: AdapterSetResolver
	kitBuild?: () => KitBuildStatus
}>

/** Whether the current Adapter provenance can be computed as far as the kit build goes: not while it is running or its last run failed (Rule 01a164bc-4e09-…). */
export function kitBuildAllowsAdapterProvenance(source: AdapterProvenanceSource | undefined): boolean {
	const state = source?.kitBuild?.().state
	return state !== 'building' && state !== 'failed'
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
 * Adapter's content digest cannot be computed now (Rule 01a164bc-4e09-78be-91fe-e7ecb3c42edb). The
 * latter holds for an Adapter with a package version too: its digest is absent only when bundling
 * or reading its graph failed, possibly for a transient reason, and provenance without it would
 * differ from a capture that recorded one, reporting the Adapter changed when nothing did.
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
		if (!provenance?.contentDigest) return { state: 'unavailable' }
		adapters.push(evidenceAdapterProvenance(provenance))
	}
	return { state: 'available', adapters }
}

/**
 * The Workspace's current Adapter provenance, which formal capture records and Evidence freshness is
 * judged against (Clause 01a1161c-008a-… and Rule 01a115cd-c6de-…): the active set is the Product Kit
 * file's Adapter list, resolved through `source` when given (Rule 01a167bf-1f93-…). `unavailable`
 * (Rule 01a164bc-4e09-…) while a kit build is running or its last run failed, or when that file
 * cannot be read, the set does not resolve, or an Adapter's content digest cannot be computed now.
 */
export async function readCurrentAdapterProvenance(persistence: FileNativePersistence, source?: AdapterProvenanceSource): Promise<CurrentAdapterProvenance> {
	try {
		if (!kitBuildAllowsAdapterProvenance(source)) return { state: 'unavailable' }
		const productKit = await persistence.productKit.read().catch(() => undefined)
		if (!productKit) return { state: 'unavailable' }
		const adapters = productKit.resource.adapters ?? []
		if (adapters.length === 0) return { state: 'available', adapters: [] }
		return await adapterSetEvidenceProvenance(persistence, await resolveProductKitAdapterSet(persistence, adapters, source))
	}
	catch {
		return { state: 'unavailable' }
	}
}
