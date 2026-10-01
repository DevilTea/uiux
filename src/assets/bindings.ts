import { sha256Identity, type ArtifactIdentity } from '../domain/artifacts/schema'
import {
	validateAssetBinding,
	validateAssetBindingCompatibility,
	validateAuthoredAssetResource,
	type AssetBinding,
	type AssetCapability,
	type AuthoredAssetResource,
} from '../domain/assets/schema'
import type { Diagnostic } from '../domain/validation'

export type ResolvedAssetBinding = Readonly<{
	assetId: string
	mediaType: string
	contentDigest: ArtifactIdentity
}>

export type AssetExecutionResult =
	| Readonly<{ state: 'ready'; value: ResolvedAssetBinding; diagnostics: readonly [] }>
	| Readonly<{ state: 'blocked'; diagnostics: readonly Diagnostic[] }>

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

/** Validates an authored binding without replacing it or inventing a runtime filesystem path. */
export async function resolveAssetBindingForExecution(input: Readonly<{
	binding: unknown
	capability: AssetCapability | undefined
	lookup: AssetLookup
	category?: string
	path?: string
}>): Promise<AssetExecutionResult> {
	const path = input.path ?? ''
	const binding = validateAssetBinding(input.binding, path)
	if (!binding.ok) return { state: 'blocked', diagnostics: binding.diagnostics }

	const target = await input.lookup.read(binding.value.$asset)
	if (!target) {
		return {
			state: 'blocked',
			diagnostics: [{ code: 'asset.missing_reference', path: `${path}/$asset`, message: `Referenced authored Asset ${binding.value.$asset} does not exist.` }],
		}
	}

	const diagnostics = [...(target.diagnostics ?? [])]
	const resourceValidation = validateAuthoredAssetResource(target.resource)
	if (!resourceValidation.ok) {
		diagnostics.push(...resourceValidation.diagnostics)
		return { state: 'blocked', diagnostics: deduplicateDiagnostics(diagnostics) }
	}
	const compatibility = validateAssetBindingCompatibility(
		resourceValidation.value.metadata.mediaType,
		input.category,
		input.capability,
		path,
	)
	if (!compatibility.ok) diagnostics.push(...compatibility.diagnostics)
	if (diagnostics.length > 0) return { state: 'blocked', diagnostics: deduplicateDiagnostics(diagnostics) }

	return {
		state: 'ready',
		diagnostics: [],
		value: {
			assetId: binding.value.$asset,
			mediaType: resourceValidation.value.metadata.mediaType,
			contentDigest: await sha256Identity(resourceValidation.value.content),
		},
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
