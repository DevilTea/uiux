import {
	jsonPointer,
	rejectUnknownKeys,
	validateDigest,
	validateJsonValue,
	validateUuid,
	validateUtcTimestamp,
	Validator,
	type JsonObject,
	type JsonValue,
	type ValidationResult,
} from '../validation'
import { validateAdapterProvenance, type AdapterProvenance } from '../adapters/schema'
import { validateEvidenceReference, type EvidenceReference } from '../evidence/schema'
import { validateResolvedRenderContext, type ResolvedRenderContext } from '../render-context/schema'
import { validateAssetMetadata } from '../assets/schema'

export type HandoffRoot =
	| Readonly<{ type: 'workspace' }>
	| Readonly<{ type: 'view'; viewId: string }>
	| Readonly<{ type: 'flow'; flowId: string }>
	| Readonly<{ type: 'asset'; assetId: string }>

export type HandoffResourceSnapshot = Readonly<{
	type: string
	identity: JsonObject
	revision: string
	snapshot: JsonValue
	contentDigest?: string
}>
export type HandoffArtifactReference = Readonly<{
	kind: string
	artifact: string
	context?: JsonObject
}>
export type HandoffSourceReference = Readonly<{
	availability: 'materialized' | 'provenance-only' | 'unavailable'
	provenance: JsonObject
	contentDigest?: string
}>
export type HandoffWidgetImplementationReference = Readonly<{
	widgetType: string
	semanticSource: HandoffSourceReference
	rendererSource: HandoffSourceReference
	designSystemSource?: HandoffSourceReference
	supportingSources?: readonly HandoffSourceReference[]
}>
export type HandoffProvenance = Readonly<{
	workspaceSchemaVersion: number
	scope: readonly HandoffRoot[]
	resources: readonly Readonly<{ identity: JsonObject; revision: string }>[]
	contexts: readonly ResolvedRenderContext[]
	versions: Readonly<Record<string, string>>
	adapters: readonly AdapterProvenance[]
	gitCommit?: string
}>
export type HandoffCoverage = Readonly<{
	validation: JsonObject
	evidence: JsonObject
	review: JsonObject
}>
export type HandoffBlockingDiagnostic = Readonly<{
	code: string
	message: string
	blocking: boolean
	path?: string
}>
export type HandoffReadiness = Readonly<{
	implementationReady: boolean
	coverage: HandoffCoverage
	blockingDiagnostics: readonly HandoffBlockingDiagnostic[]
}>
export type HandoffManifest = Readonly<{
	schemaVersion: number
	bundleIdentity: string
	exportedAt: string
	roots: readonly HandoffRoot[]
	resources: readonly HandoffResourceSnapshot[]
	artifactRefs: readonly HandoffArtifactReference[]
	evidenceRefs: readonly EvidenceReference[]
	implementationReferences: readonly HandoffWidgetImplementationReference[]
	provenance: HandoffProvenance
	readiness: HandoffReadiness
}>

export function validateHandoffRoot(input: unknown, path = ''): ValidationResult<HandoffRoot> {
	const v = new Validator()
	const root = v.object(input, path)
	if (!root) return v.finish<HandoffRoot>(input)
	switch (root.type) {
		case 'workspace':
			rejectUnknownKeys(root, ['type'], path, v)
			break
		case 'view':
			rejectUnknownKeys(root, ['type', 'viewId'], path, v)
			validateUuid(root.viewId, `${path}/viewId`, v, 'Handoff View root')
			break
		case 'flow':
			rejectUnknownKeys(root, ['type', 'flowId'], path, v)
			validateUuid(root.flowId, `${path}/flowId`, v, 'Handoff Flow root')
			break
		case 'asset':
			rejectUnknownKeys(root, ['type', 'assetId'], path, v)
			validateUuid(root.assetId, `${path}/assetId`, v, 'Handoff asset root')
			break
		default:
			v.issue('handoff.invalid_root_type', `${path}/type`, 'Handoff roots are typed resources; feature is not a root type.')
	}
	return v.finish<HandoffRoot>(input)
}

export function validateHandoffManifest(input: unknown): ValidationResult<HandoffManifest> {
	const v = new Validator()
	const manifest = v.object(input, '')
	if (!manifest) return v.finish<HandoffManifest>(input)
	validateJsonValue(input, '', v)
	positiveInteger(manifest.schemaVersion, '/schemaVersion', v)
	v.string(manifest.bundleIdentity, '/bundleIdentity', true)
	validateUtcTimestamp(manifest.exportedAt, '/exportedAt', v)
	const roots = v.array(manifest.roots, '/roots')
	if (roots && roots.length === 0)
		v.issue('handoff.empty_roots', '/roots', 'A Handoff bundle starts from explicit typed roots.')
	roots?.forEach((root, index) => v.diagnostics.push(...validateHandoffRoot(root, jsonPointer('/roots', index)).diagnostics))
	if (roots) {
		const rootKeys = new Set<string>()
		roots.forEach((root, index) => {
			const key = rootIdentityKey(root)
			if (!key) return
			if (rootKeys.has(key)) v.issue('handoff.duplicate_root', jsonPointer('/roots', index), 'Handoff roots are explicit identities and must not be duplicated.')
			rootKeys.add(key)
		})
	}
	const resources = v.array(manifest.resources, '/resources')
	resources?.forEach((resourceValue, index) => {
		const path = jsonPointer('/resources', index)
		const resource = v.object(resourceValue, path)
		if (!resource) return
		v.string(resource.type, `${path}/type`, true)
		const identity = v.object(resource.identity, `${path}/identity`)
		if (identity) {
			if (Object.keys(identity).length === 0) v.issue('handoff.empty_resource_identity', `${path}/identity`, 'Canonical resource snapshots require a typed identity.')
			validateJsonValue(identity, `${path}/identity`, v)
		}
		if (identity && ['view', 'flow', 'review', 'asset'].includes(String(resource.type)))
			validateUuid(identity.id, `${path}/identity/id`, v, `${String(resource.type)} resource id`)
		v.string(resource.revision, `${path}/revision`, true)
		validateJsonValue(resource.snapshot, `${path}/snapshot`, v)
		if (Object.hasOwn(resource, 'contentDigest'))
			validateDigest(resource.contentDigest, `${path}/contentDigest`, v)
		if (resource.type === 'asset') {
			const identityId = identity?.id
			v.diagnostics.push(...validateAssetMetadata(resource.snapshot, typeof identityId === 'string' ? identityId : undefined).diagnostics)
			if (!Object.hasOwn(resource, 'contentDigest'))
				v.issue('handoff.asset_content_digest_missing', `${path}/contentDigest`, 'Authored Asset snapshots record the canonical source-content digest.')
		}
	})
	const artifacts = v.array(manifest.artifactRefs, '/artifactRefs')
	const artifactIds = new Set<string>()
	artifacts?.forEach((artifactValue, index) => {
		const path = jsonPointer('/artifactRefs', index)
		const artifact = v.object(artifactValue, path)
		if (!artifact) return
		v.string(artifact.kind, `${path}/kind`, true)
		if (validateDigest(artifact.artifact, `${path}/artifact`, v)) {
			if (artifactIds.has(artifact.artifact)) v.issue('handoff.duplicate_artifact', `${path}/artifact`, 'Content-addressed artifacts are deduplicated by SHA-256 identity.')
			artifactIds.add(artifact.artifact)
		}
		if (Object.hasOwn(artifact, 'context')) {
			const context = v.object(artifact.context, `${path}/context`)
			if (context) validateJsonValue(context, `${path}/context`, v)
		}
	})
	const evidenceRefs = v.array(manifest.evidenceRefs, '/evidenceRefs')
	evidenceRefs?.forEach((ref, index) => v.diagnostics.push(...validateEvidenceReference(ref, jsonPointer('/evidenceRefs', index)).diagnostics))
	validateImplementationReferences(manifest.implementationReferences, '/implementationReferences', v)
	validateHandoffProvenance(manifest.provenance, '/provenance', v)
	validateScopeAgreement(roots, manifest.provenance, v)
	validateReadiness(manifest.readiness, '/readiness', v)
	return v.finish<HandoffManifest>(input)
}

function validateImplementationReferences(input: unknown, path: string, v: Validator): void {
	const references = v.array(input, path)
	if (!references) return
	const widgetTypes = new Set<string>()
	references.forEach((value, index) => {
		const itemPath = jsonPointer(path, index)
		const reference = v.object(value, itemPath)
		if (!reference) return
		const widgetType = v.string(reference.widgetType, `${itemPath}/widgetType`, true)
		if (widgetType) {
			if (widgetTypes.has(widgetType)) v.issue('handoff.duplicate_widget_mapping', `${itemPath}/widgetType`, 'Each used Widget type has one source mapping entry.')
			widgetTypes.add(widgetType)
		}
		validateSourceReference(reference.semanticSource, `${itemPath}/semanticSource`, v)
		validateSourceReference(reference.rendererSource, `${itemPath}/rendererSource`, v)
		if (Object.hasOwn(reference, 'designSystemSource'))
			validateSourceReference(reference.designSystemSource, `${itemPath}/designSystemSource`, v)
		if (Object.hasOwn(reference, 'supportingSources')) {
			const supporting = v.array(reference.supportingSources, `${itemPath}/supportingSources`)
			supporting?.forEach((source, sourceIndex) => validateSourceReference(source, jsonPointer(`${itemPath}/supportingSources`, sourceIndex), v))
		}
	})
}

function validateSourceReference(input: unknown, path: string, v: Validator): void {
	const source = v.object(input, path)
	if (!source) return
	if (source.availability !== 'materialized' && source.availability !== 'provenance-only' && source.availability !== 'unavailable')
		v.issue('handoff.invalid_source_availability', `${path}/availability`, 'Source availability is materialized, provenance-only, or unavailable.')
	const provenance = v.object(source.provenance, `${path}/provenance`)
	if (provenance) {
		if (Object.keys(provenance).length === 0) v.issue('handoff.empty_source_provenance', `${path}/provenance`, 'Source mappings retain pinned source provenance.')
		validateJsonValue(provenance, `${path}/provenance`, v)
	}
	if (source.availability === 'materialized') {
		if (provenance) {
			const hasOrigin = (typeof provenance.package === 'string' && provenance.package.length > 0)
				|| (typeof provenance.repository === 'string' && provenance.repository.length > 0)
			if (!hasOrigin) v.issue('handoff.missing_pinned_source', `${path}/provenance`, 'Materialized source provenance identifies its package or repository.')
			if (typeof provenance.revision !== 'string' || provenance.revision.length === 0)
				v.issue('handoff.missing_source_revision', `${path}/provenance/revision`, 'Materialized source provenance pins the source revision.')
			if (typeof provenance.path !== 'string' || provenance.path.length === 0)
				v.issue('handoff.missing_source_path', `${path}/provenance/path`, 'Materialized source provenance identifies the original path.')
		}
		validateDigest(source.contentDigest, `${path}/contentDigest`, v)
	}
	else if (Object.hasOwn(source, 'contentDigest'))
		validateDigest(source.contentDigest, `${path}/contentDigest`, v)
}

function validateHandoffProvenance(input: unknown, path: string, v: Validator): void {
	const provenance = v.object(input, path)
	if (!provenance) return
	positiveInteger(provenance.workspaceSchemaVersion, `${path}/workspaceSchemaVersion`, v)
	const scope = v.array(provenance.scope, `${path}/scope`)
	scope?.forEach((root, index) => v.diagnostics.push(...validateHandoffRoot(root, jsonPointer(`${path}/scope`, index)).diagnostics))
	const resources = v.array(provenance.resources, `${path}/resources`)
	resources?.forEach((value, index) => {
		const resourcePath = jsonPointer(`${path}/resources`, index)
		const resource = v.object(value, resourcePath)
		if (!resource) return
		const identity = v.object(resource.identity, `${resourcePath}/identity`)
		if (identity) validateJsonValue(identity, `${resourcePath}/identity`, v)
		v.string(resource.revision, `${resourcePath}/revision`, true)
	})
	const contexts = v.array(provenance.contexts, `${path}/contexts`)
	contexts?.forEach((context, index) => v.diagnostics.push(...validateResolvedRenderContext(context, jsonPointer(`${path}/contexts`, index)).diagnostics))
	const versions = v.object(provenance.versions, `${path}/versions`)
	if (versions) {
		if (!Object.hasOwn(versions, 'uiux')) v.issue('handoff.missing_uiux_version', `${path}/versions/uiux`, 'Handoff provenance records the UIUX version.')
		for (const [key, value] of Object.entries(versions)) v.string(value, jsonPointer(`${path}/versions`, key), true)
	}
	const adapters = v.array(provenance.adapters, `${path}/adapters`)
	const adapterIds = new Set<string>()
	adapters?.forEach((adapter, index) => {
		const adapterPath = jsonPointer(`${path}/adapters`, index)
		v.diagnostics.push(...validateAdapterProvenance(adapter, adapterPath).diagnostics)
		if (typeof adapter === 'object' && adapter !== null && !Array.isArray(adapter)) {
			const id = (adapter as Record<string, unknown>).adapterId
			if (typeof id === 'string') {
				if (adapterIds.has(id)) v.issue('adapter.duplicate_id', `${adapterPath}/adapterId`, 'Resolved adapter ids are unique in the ordered active set.')
				adapterIds.add(id)
			}
		}
	})
	if (Object.hasOwn(provenance, 'gitCommit')) v.string(provenance.gitCommit, `${path}/gitCommit`, true)
}

function validateScopeAgreement(roots: unknown[] | undefined, provenanceValue: unknown, v: Validator): void {
	if (!roots || typeof provenanceValue !== 'object' || provenanceValue === null || Array.isArray(provenanceValue)) return
	const scope = (provenanceValue as Record<string, unknown>).scope
	if (!Array.isArray(scope)) return
	const rootKeys = roots.map(rootIdentityKey).filter((key): key is string => key !== undefined).sort()
	const scopeKeys = scope.map(rootIdentityKey).filter((key): key is string => key !== undefined).sort()
	if (rootKeys.length !== scope.length || scopeKeys.length !== roots.length || rootKeys.some((key, index) => key !== scopeKeys[index]))
		v.issue('handoff.scope_mismatch', '/provenance/scope', 'Handoff provenance must preserve the selected explicit roots.')
}

function validateReadiness(input: unknown, path: string, v: Validator): void {
	const readiness = v.object(input, path)
	if (!readiness) return
	if (typeof readiness.implementationReady !== 'boolean')
		v.issue('handoff.invalid_readiness_claim', `${path}/implementationReady`, 'Readiness exposes only the explicit implementation-ready claim as a boolean.')
	const coverage = v.object(readiness.coverage, `${path}/coverage`)
	if (coverage) {
		for (const key of ['validation', 'evidence', 'review'] as const) {
			const item = v.object(coverage[key], `${path}/coverage/${key}`)
			if (item) validateJsonValue(item, `${path}/coverage/${key}`, v)
		}
	}
	const diagnostics = v.array(readiness.blockingDiagnostics, `${path}/blockingDiagnostics`)
	let hasBlocking = false
	diagnostics?.forEach((value, index) => {
		const diagnosticPath = jsonPointer(`${path}/blockingDiagnostics`, index)
		const diagnostic = v.object(value, diagnosticPath)
		if (!diagnostic) return
		v.string(diagnostic.code, `${diagnosticPath}/code`, true)
		v.string(diagnostic.message, `${diagnosticPath}/message`)
		if (typeof diagnostic.blocking !== 'boolean')
			v.issue('handoff.invalid_diagnostic_blocking', `${diagnosticPath}/blocking`, 'Handoff diagnostic must state whether it blocks readiness.')
		else hasBlocking ||= diagnostic.blocking
		if (Object.hasOwn(diagnostic, 'path')) v.string(diagnostic.path, `${diagnosticPath}/path`)
	})
	if (readiness.implementationReady === true && hasBlocking)
		v.issue('handoff.ready_with_blockers', `${path}/implementationReady`, 'A closure with blocking diagnostics cannot claim implementation-ready.')
}

export type HandoffReadinessAssessment = Readonly<{
	rootsReadable: boolean
	closureValid: boolean
	requiredEvidenceComplete: boolean
	reviewCoverageComplete: boolean
	blockingDiagnostics: readonly HandoffBlockingDiagnostic[]
}>

/**
 * The persisted coverage payload is machine-readable but intentionally does not
 * define the readiness algorithm. The resolved closure/evidence/review services
 * supply this non-persisted assessment before a true claim can be trusted.
 */
export function mayClaimImplementationReady(input: HandoffReadinessAssessment): boolean {
	return input.rootsReadable
		&& input.closureValid
		&& input.requiredEvidenceComplete
		&& input.reviewCoverageComplete
		&& !input.blockingDiagnostics.some(diagnostic => diagnostic.blocking)
}

export function validateImplementationReadyClaim(
	readiness: HandoffReadiness,
	assessment: HandoffReadinessAssessment,
): ValidationResult<HandoffReadiness> {
	const v = new Validator()
	validateReadiness(readiness, '', v)
	if (readiness.implementationReady && !mayClaimImplementationReady(assessment))
		v.issue('handoff.unsubstantiated_readiness_claim', '/implementationReady',
			'An implementation-ready claim requires a successful closure-scoped readiness assessment.')
	return v.finish<HandoffReadiness>(readiness)
}

function positiveInteger(value: unknown, path: string, v: Validator): void {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1)
		v.issue('schema.expected_positive_integer', path, 'Expected a positive integer.')
}

function rootIdentityKey(input: unknown): string | undefined {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) return undefined
	const root = input as Record<string, unknown>
	switch (root.type) {
		case 'workspace': return 'workspace'
		case 'view': return typeof root.viewId === 'string' ? `view:${root.viewId}` : undefined
		case 'flow': return typeof root.flowId === 'string' ? `flow:${root.flowId}` : undefined
		case 'asset': return typeof root.assetId === 'string' ? `asset:${root.assetId}` : undefined
		default: return undefined
	}
}
