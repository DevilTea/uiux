import type { AdapterAssetValue } from '../adapter-entry'
import { sha256Identity, type ArtifactIdentity } from '../domain/artifacts/schema'
import {
	validateAssetBinding,
	validateAssetBindingCompatibility,
	validateAuthoredAssetResource,
	type AssetBinding,
	type AssetCapability,
	type AuthoredAssetResource,
} from '../domain/assets/schema'
import { isFullUuid, type Diagnostic } from '../domain/validation'

export type ResolvedAssetBinding = Readonly<{
	assetId: string
	mediaType: string
	contentDigest: ArtifactIdentity
}>

export type AssetExecutionResult =
	| Readonly<{ state: 'ready'; value: ResolvedAssetBinding; diagnostics: readonly [] }>
	| Readonly<{ state: 'blocked'; diagnostics: readonly Diagnostic[] }>

/**
 * One bound Asset as the server resolved it for execution: the runtime value a Widget's Config receives in
 * place of the binding (Clause 01a167f4-3e4e-7af1-b328-30fb52f7f4c5), or what keeps the Asset from being
 * used (Rule 01a115cd-c09f-7018-9f52-48b05284f600). It says nothing about the field the Asset is bound in.
 */
export type AssetTargetResolution =
	| Readonly<{ state: 'ready'; value: AdapterAssetValue }>
	| Readonly<{ state: 'blocked'; diagnostics: readonly Diagnostic[] }>

/** Asset ID to its resolution, as the Preview asset routes answer it. */
export type AssetResolutionTable = Readonly<Record<string, AssetTargetResolution>>

export interface AssetLookup {
	read(assetId: string): Promise<Readonly<{ resource: AuthoredAssetResource; diagnostics: readonly Diagnostic[] }> | undefined>
}

export interface InspectedAssetSource {
	readInspected(assetId: string): Promise<Readonly<{ resource: AuthoredAssetResource; diagnostics: readonly Diagnostic[] }> | undefined>
}

/** Keeps formal execution on the inspected read path so on-disk Asset shape diagnostics are never discarded. */
export function assetLookupFromInspectedSource(source: InspectedAssetSource): AssetLookup {
	return { read: assetId => source.readInspected(assetId) }
}

/**
 * The live content URL of an Asset (Clause 01a167f4-401d-7330-ac65-0a900adbccd6): the content route,
 * pinned to the digest it was resolved with, so content replaced since is refused rather than served.
 */
export function liveAssetContentUrl(assetId: string, contentDigest: string): string {
	return `/api/assets/${encodeURIComponent(assetId)}/content?digest=${contentDigest}`
}

/** The content URL of an Asset as a version records it: the version blob of its content digest. */
export function versionAssetContentUrl(contentDigest: string): string {
	return `/api/history/blobs/${contentDigest}`
}

/**
 * Resolves the Asset one binding names, independently of the field it is bound in: a missing, corrupt or
 * inconsistent Asset is blocked with its diagnostics, and a valid one yields its runtime value. Nothing
 * stands in for a blocked Asset (Rule 01a115cd-c106-71d6-b1f8-4d59cab22ad2).
 */
export async function resolveAssetTarget(input: Readonly<{
	assetId: string
	lookup: AssetLookup
	url: (assetId: string, contentDigest: string) => string
	path?: string
}>): Promise<AssetTargetResolution> {
	const path = input.path ?? ''
	const target = await input.lookup.read(input.assetId)
	if (!target) {
		return {
			state: 'blocked',
			diagnostics: [{ code: 'asset.missing_reference', path, message: `Referenced authored Asset ${input.assetId} does not exist.` }],
		}
	}
	const diagnostics = [...(target.diagnostics ?? [])]
	const resourceValidation = validateAuthoredAssetResource(target.resource)
	if (!resourceValidation.ok) diagnostics.push(...resourceValidation.diagnostics)
	if (!resourceValidation.ok || diagnostics.length > 0) return { state: 'blocked', diagnostics: deduplicateDiagnostics(diagnostics) }
	const contentDigest = await sha256Identity(resourceValidation.value.content)
	return {
		state: 'ready',
		value: Object.freeze({
			url: input.url(input.assetId, contentDigest),
			mediaType: resourceValidation.value.metadata.mediaType,
			contentDigest,
		}),
	}
}

/** Validates an authored binding without replacing it or inventing a runtime filesystem path. */
export async function resolveAssetBindingForExecution(input: Readonly<{
	binding: unknown
	capability: AssetCapability | undefined
	lookup: AssetLookup
	path?: string
}>): Promise<AssetExecutionResult> {
	const path = input.path ?? ''
	const binding = validateAssetBinding(input.binding, path)
	if (!binding.ok) return { state: 'blocked', diagnostics: binding.diagnostics }

	const target = await resolveAssetTarget({ assetId: binding.value.$asset, lookup: input.lookup, url: liveAssetContentUrl, path: `${path}/$asset` })
	if (target.state === 'blocked') return target
	const compatibility = validateAssetBindingCompatibility(target.value.mediaType, input.capability, path)
	if (!compatibility.ok) return { state: 'blocked', diagnostics: compatibility.diagnostics }

	return {
		state: 'ready',
		diagnostics: [],
		value: { assetId: binding.value.$asset, mediaType: target.value.mediaType, contentDigest: target.value.contentDigest },
	}
}

export function preserveAssetBinding(binding: AssetBinding): AssetBinding {
	return { $asset: binding.$asset }
}

function deduplicateDiagnostics(diagnostics: readonly Diagnostic[]): Diagnostic[] {
	const seen = new Set<string>()
	return diagnostics.filter(diagnostic => {
		const identity = `${diagnostic.code}\u0000${diagnostic.path}\u0000${diagnostic.message}`
		if (seen.has(identity)) return false
		seen.add(identity)
		return true
	})
}

/** Calls `visit` with each top-level Config member of every Widget of `ir` that has an own `$asset` key. */
function forEachAssetBinding(ir: unknown, visit: (authored: Record<string, unknown>) => void): void {
	function scan(node: unknown): void {
		if (!isRecord(node)) return
		if (isRecord(node.config)) {
			for (const authored of Object.values(node.config)) {
				if (isRecord(authored) && Object.hasOwn(authored, '$asset')) visit(authored)
			}
		}
		if (!isRecord(node.slots)) return
		for (const children of Object.values(node.slots)) {
			if (Array.isArray(children)) children.forEach(scan)
		}
	}
	scan(ir)
}

/**
 * The Asset IDs a View's IR binds: each top-level Config member of a Widget, at any depth of slots, that
 * is an object with an own `$asset` UUID. These are the Assets the server resolves for a render; a binding
 * of another shape is diagnosed by the render itself, and no other value is ever taken for an Asset
 * reference (Rule 01a115cd-beea-7d7d-bf04-edbf3990104b).
 */
export function collectBoundAssetIds(ir: unknown): readonly string[] {
	const ids = new Set<string>()
	forEachAssetBinding(ir, (authored) => {
		if (isFullUuid(authored.$asset)) ids.add(authored.$asset)
	})
	return [...ids].sort()
}

/** Whether `ir` has any `$asset` binding, valid or not. */
export function hasAssetBinding(ir: unknown): boolean {
	let found = false
	forEachAssetBinding(ir, () => { found = true })
	return found
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a batch of resource changes touches an Asset that `ir` binds, so an open Preview of it resolves
 * its bindings again (Rule 01a167f4-48f2-7460-8c12-dfc4cda35cd0): a change or removal of a bound Asset, or a
 * resync, after which any of them may have changed.
 */
export function bindsChangedAsset(ir: unknown, batch: Readonly<{ resync: boolean; changes: readonly Readonly<{ kind: string; key: string }>[] }>): boolean {
	const bound = new Set(collectBoundAssetIds(ir))
	if (bound.size === 0) return false
	return batch.resync || batch.changes.some(change => change.kind === 'asset' && bound.has(change.key))
}
