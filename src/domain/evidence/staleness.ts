import { productKitChanged, type ProductKitProvenance } from '../product-kit/provenance'
import { adapterProvenanceChanged, type EvidenceAdapterProvenance } from './adapter-provenance'
import type { FormalEvidenceRecord } from './schema'

/**
 * A View as freshness sees it: its key and its current render-input digest (Clause
 * 01a14e30-2d4a-7ce9-ad68-58db56f36f47, `renderInputDigest` in `./render-input-digest`).
 */
export type EvidenceStalenessView = Readonly<{ key: string; renderInputDigest: string }>

export type EvidenceStalenessContext = Readonly<{
	allViews: readonly EvidenceStalenessView[]
	workspace?: {
		resource?: {
			i18n?: { defaultLocale?: string }
			viewports?: Record<string, { dimensions?: { width?: number; height?: number } }>
			themes?: Record<string, unknown>
		}
	}
	discoveredLocales?: readonly string[]
	localeRevisions?: Readonly<Record<string, string>>
	/**
	 * The Workspace's current Product Kit provenance. Absent when it is unavailable.
	 */
	productKit?: ProductKitProvenance
	/**
	 * True when the Workspace has a Product Kit file but its current provenance cannot be computed
	 * (`productKitFreshnessContext`): every capture's freshness is then unknown, never fresh.
	 */
	productKitUnavailable?: boolean
	/**
	 * The Workspace's current Adapter provenance, every Adapter of the active set in Adapter-list
	 * order (`adapterFreshnessContext`). Absent when it is unavailable.
	 */
	adapters?: readonly EvidenceAdapterProvenance[]
	/**
	 * True when the current Adapter provenance cannot be computed (`adapterFreshnessContext`): every
	 * capture's freshness is then unknown, never fresh.
	 */
	adaptersUnavailable?: boolean
}>

export type EvidenceStalenessAssessment = Readonly<{
	isStale: boolean
	reason?: string
	/**
	 * Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1: the capture records no Adapter or no Product Kit
	 * provenance, or the current one cannot be computed, so its freshness is unknown, which counts as
	 * not fresh (`isStale` is true).
	 */
	unknown?: true
}>

/** The reason a capture is stale once the active Adapter set changed (Rule 01a115cd-c6de-7744-be27-715bec2e7fef). */
export const ADAPTER_CHANGED_REASON = 'Adapter changed since capture'

/** The reason a capture without Adapter provenance is not fresh (Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1). */
export const ADAPTER_PROVENANCE_MISSING_REASON = 'Capture records no Adapter provenance; capture it again'

/** The reason no capture is fresh while the current Adapter provenance cannot be computed (Rule 01a164bc-4e09-78be-91fe-e7ecb3c42edb). */
export const ADAPTER_PROVENANCE_UNAVAILABLE_REASON = 'Current Adapter provenance cannot be computed'

/** The reason a capture is stale once the Product Kit changed (Rule 01a11bb1-be4a-7f9b-9fd6-a6e71241113c). */
export const PRODUCT_KIT_CHANGED_REASON = 'Product Kit changed since capture'

/** The reason a capture without Product Kit provenance is not fresh (Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1). */
export const PRODUCT_KIT_PROVENANCE_MISSING_REASON = 'Capture records no Product Kit provenance; capture it again'

/** The reason no capture is fresh while the current Product Kit provenance cannot be computed (Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1). */
export const PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON = 'Current Product Kit provenance cannot be computed'

/** The reason a capture without a View revision is stale (Rule 01a115cd-c53c-7121-ae74-8243c4890477). */
export const VIEW_PROVENANCE_MISSING_REASON = 'Evidence provenance missing View reference'

/** The reason a capture without a render-input digest is stale (Rule 01a115cd-c53c-7121-ae74-8243c4890477). */
export const RENDER_INPUT_DIGEST_MISSING_REASON = 'Capture records no render-input digest; capture it again'

/** The reason a capture is stale once its View's IR or Variants changed (Rule 01a115cd-c5a5-757a-b049-b5138fe75920). */
export const RENDER_INPUT_CHANGED_REASON = 'View IR or Variants changed since capture'

/**
 * Rules 01a11544-558b-7b86-b4c7-76928862c948 and 01a115cd-c53c-…: a formal capture satisfies a
 * submission for `viewId` when it is complete, captured that View, records a View revision for it
 * and recorded `renderInputDigest`, the View's current render-input digest. A Spec-only or metadata
 * edit keeps the digest, so it keeps the capture usable.
 */
export function isCompleteEvidenceForRenderInput(
	record: FormalEvidenceRecord,
	viewId: string,
	renderInputDigest: string,
): boolean {
	if (record.coverage.complete !== true) return false
	const context = record.executionContext as Record<string, unknown>
	if (context.viewId !== viewId) return false
	if (record.provenance.renderInputDigest !== renderInputDigest) return false
	return record.provenance.resources.some((resource) => {
		const identity = resource.identity as Record<string, unknown>
		return identity.type === 'view'
			&& identity.id === viewId
			&& typeof resource.revision === 'string'
			&& resource.revision.length > 0
	})
}

/**
 * The freshness of a formal capture and, unchanged, of an `interaction_replay` record: that record
 * copies the `executionContext` and `provenance` of the one capture it references (Clause
 * 01a17762-b293-7157-aa2f-39a9c2ffbab5), so every condition below (View, render-input digest, Locale,
 * viewport, theme, Adapter, Product Kit) judges it as it judges that capture (Clause
 * 01a14e30-2e43-75a7-aca8-c8df28915f4e). A `flow_trace` is judged by {@link evaluateFlowTraceStaleness}.
 */
export function evaluateEvidenceStaleness(
	record: FormalEvidenceRecord,
	context: EvidenceStalenessContext,
): EvidenceStalenessAssessment {
	const ctx = record.executionContext as Record<string, unknown> | undefined
	if (!ctx?.viewId) {
		return { isStale: true, reason: 'Missing executionContext.viewId' }
	}

	const viewSummary = context.allViews.find(v => v.key === ctx.viewId)
	if (!viewSummary) {
		return { isStale: true, reason: 'View no longer exists' }
	}

	const provView = record.provenance?.resources?.find(
		r => (r.identity as Record<string, unknown>)?.type === 'view' && (r.identity as Record<string, unknown>)?.id === ctx.viewId,
	) ?? record.provenance?.resources?.find(
		r => (r.identity as Record<string, unknown>)?.type === 'view',
	)

	// Rule 01a115cd-c53c-…: a capture that records no View revision or no render-input digest is stale.
	if (!provView || typeof provView.revision !== 'string' || provView.revision.length === 0) {
		return { isStale: true, reason: VIEW_PROVENANCE_MISSING_REASON }
	}
	const recordedDigest = record.provenance.renderInputDigest
	if (typeof recordedDigest !== 'string' || recordedDigest.length === 0) {
		return { isStale: true, reason: RENDER_INPUT_DIGEST_MISSING_REASON }
	}

	// Rule 01a115cd-c5a5-…: the View condition follows what was rendered (IR and Variants), not the
	// View revision, so a Spec-only or metadata edit leaves the capture fresh.
	if (recordedDigest !== viewSummary.renderInputDigest) {
		return { isStale: true, reason: RENDER_INPUT_CHANGED_REASON }
	}

	if (typeof ctx.locale === 'string') {
		const validLocales = new Set([
			context.workspace?.resource?.i18n?.defaultLocale || 'en-US',
			...(context.discoveredLocales ?? []),
		])
		if (!validLocales.has(ctx.locale)) {
			return { isStale: true, reason: `Locale '${ctx.locale}' is not in workspace` }
		}
		const currentLocaleRevision = context.localeRevisions?.[ctx.locale]
		if (currentLocaleRevision) {
			const provLocale = record.provenance.resources.find((resource) => {
				const identity = resource.identity as Record<string, unknown>
				return identity.type === 'locale' && identity.id === ctx.locale
			})
			if (!provLocale || provLocale.revision !== currentLocaleRevision) {
				return { isStale: true, reason: `Locale '${ctx.locale}' revision has changed since capture` }
			}
		}
	}

	if (typeof ctx.viewportId === 'string' && context.workspace?.resource?.viewports) {
		const preset = context.workspace.resource.viewports[ctx.viewportId]
		if (!preset) {
			return { isStale: true, reason: `Viewport preset '${ctx.viewportId}' was removed` }
		}
		const resolved = ctx.viewport as { width?: number; height?: number } | undefined
		if (resolved && preset.dimensions
			&& (resolved.width !== preset.dimensions.width || resolved.height !== preset.dimensions.height)) {
			return { isStale: true, reason: `Viewport preset '${ctx.viewportId}' dimensions changed since capture` }
		}
	}

	if (typeof ctx.themeId === 'string' && context.workspace?.resource?.themes) {
		if (!Object.hasOwn(context.workspace.resource.themes, ctx.themeId)) {
			return { isStale: true, reason: `Theme '${ctx.themeId}' was removed` }
		}
	}

	return provenanceFreshness(record, context) ?? { isStale: false }
}

/**
 * A Flow as freshness sees it: its key and its current Flow input digest (Clause
 * 01a1814f-81c2-7c7a-93c8-1beecd1c5740, `flowInputDigest` in `../flows/input-digest`).
 */
export type FlowTraceStalenessFlow = Readonly<{ key: string; flowInputDigest: string }>

export type FlowTraceStalenessContext = EvidenceStalenessContext & Readonly<{
	/** Every Flow the Workspace holds, with its current Flow input digest. */
	flows: readonly FlowTraceStalenessFlow[]
	/** The formal capture records a trace may reference, by `sha256:` identity; a reference absent here is missing. */
	captures: ReadonlyMap<string, FormalEvidenceRecord>
}>

/** The reason a trace without a Flow reference is stale (Clause 01a14e30-2e43-75a7-aca8-c8df28915f4e). */
export const FLOW_TRACE_FLOW_MISSING_REASON = 'Missing executionContext.flowId'

/** The reason a trace is stale once its Flow no longer exists. */
export const FLOW_REMOVED_REASON = 'Flow no longer exists'

/** The reason a trace that records no Flow input digest is stale (Rule 01a1814f-8256-7927-92d9-b3d2ba9e5719). */
export const FLOW_PROVENANCE_MISSING_REASON = 'Trace records no Flow input digest; capture it again'

/** The reason a trace is stale once its Flow input digest differs from the recorded one (a change to `requirements` alone is none). */
export const FLOW_CHANGED_REASON = 'Flow changed since trace'

/** The reason a trace is stale when a capture it references is not in the store. */
export const FLOW_TRACE_CAPTURE_MISSING_REASON = 'A capture the trace references no longer exists'

/**
 * Freshness of a `flow_trace` record (Rule 01a11544-6760-7ec2-8430-0f7cc5807259, Clause
 * 01a14e30-2e43-75a7-aca8-c8df28915f4e: the `flow` change domain affects Flow Evidence). A trace
 * records the Flow input digest (Clause 01a1814f-81c2-7c7a-93c8-1beecd1c5740) and references the
 * formal captures of every View and Variant its recipe enters, so it is stale once its Flow no
 * longer exists, once its Flow input digest differs from the recorded one or it records none (Rule
 * 01a1814f-8256-7927-92d9-b3d2ba9e5719), or once a capture it references is missing or stale by the
 * conditions of a formal capture ({@link evaluateEvidenceStaleness}); it has unknown freshness, which counts as not fresh,
 * when no condition makes it stale and a referenced capture's freshness is unknown (Rule
 * 01a1161b-ff68-76af-8237-dbc8ef2c27d1). A definite stale outranks an unknown, as for a capture.
 */
export function evaluateFlowTraceStaleness(
	record: FormalEvidenceRecord,
	context: FlowTraceStalenessContext,
): EvidenceStalenessAssessment {
	const flowId = (record.executionContext as Record<string, unknown> | undefined)?.flowId
	if (typeof flowId !== 'string' || flowId.length === 0) return { isStale: true, reason: FLOW_TRACE_FLOW_MISSING_REASON }
	const flow = context.flows.find(candidate => candidate.key === flowId)
	if (!flow) return { isStale: true, reason: FLOW_REMOVED_REASON }
	const recorded = record.provenance?.flowInputDigest
	if (typeof recorded !== 'string' || recorded.length === 0)
		return { isStale: true, reason: FLOW_PROVENANCE_MISSING_REASON }
	if (recorded !== flow.flowInputDigest) return { isStale: true, reason: FLOW_CHANGED_REASON }

	let unknown: EvidenceStalenessAssessment | undefined
	for (const ref of record.evidenceRefs ?? []) {
		if (ref.kind !== 'formal_capture') continue
		const capture = context.captures.get(ref.evidence)
		if (!capture) return { isStale: true, reason: FLOW_TRACE_CAPTURE_MISSING_REASON }
		const assessment = evaluateEvidenceStaleness(capture, context)
		if (!assessment.isStale) continue
		const reason = `Capture ${ref.evidence}: ${assessment.reason ?? 'stale'}`
		if (!assessment.unknown) return { isStale: true, reason }
		unknown ??= { isStale: true, unknown: true, reason }
	}
	return unknown ?? { isStale: false }
}

/**
 * The Adapter and Product Kit conditions alone (Rules 01a115cd-c6de-…, 01a11bb1-be4a-… and
 * 01a1161b-ff68-…): `undefined` when both hold. A recorded provenance that differs from the current
 * one is stale, and outranks a provenance whose comparison is unknown. A condition whose current
 * provenance the context does not carry is not judged.
 */
export function provenanceFreshness(
	record: FormalEvidenceRecord,
	context: Pick<EvidenceStalenessContext, 'adapters' | 'adaptersUnavailable' | 'productKit' | 'productKitUnavailable'>,
): EvidenceStalenessAssessment | undefined {
	const adapters = adapterFreshness(record, context)
	const productKit = productKitFreshness(record, context)
	if (adapters && !adapters.unknown) return adapters
	if (productKit && !productKit.unknown) return productKit
	return adapters ?? productKit
}

/**
 * Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1 alone: the unknown assessment of the Adapter or Product
 * Kit condition, whatever else holds, or `undefined` when neither is unknown. Submit for review
 * refuses such a capture (Rule 01a11686-8d71-79f5-bb10-0c74649586ea).
 */
export function unknownProvenanceFreshness(
	record: FormalEvidenceRecord,
	context: Pick<EvidenceStalenessContext, 'adapters' | 'adaptersUnavailable' | 'productKit' | 'productKitUnavailable'>,
): EvidenceStalenessAssessment | undefined {
	return [adapterFreshness(record, context), productKitFreshness(record, context)].find(assessment => assessment?.unknown)
}

function adapterFreshness(
	record: FormalEvidenceRecord,
	context: Pick<EvidenceStalenessContext, 'adapters' | 'adaptersUnavailable'>,
): EvidenceStalenessAssessment | undefined {
	// Rule 01a164bc-4e09-…: while the current Adapter provenance cannot be computed, nothing tells
	// whether the capture still matches the active set, so its freshness is unknown.
	if (context.adaptersUnavailable) return { isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_UNAVAILABLE_REASON }
	if (!context.adapters) return undefined
	const recorded = record.provenance.adapters
	if (!recorded) return { isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_MISSING_REASON }
	// Rule 01a115cd-c6de-…: selection, order, content or configuration differs.
	if (adapterProvenanceChanged(recorded, context.adapters)) return { isStale: true, reason: ADAPTER_CHANGED_REASON }
	return undefined
}

function productKitFreshness(
	record: FormalEvidenceRecord,
	context: Pick<EvidenceStalenessContext, 'productKit' | 'productKitUnavailable'>,
): EvidenceStalenessAssessment | undefined {
	// Rules 01a1161b-ff68-… and 01a11bb1-be4a-…: with a Product Kit whose current provenance cannot be
	// computed, nothing tells whether the capture still matches it, so its freshness is unknown.
	if (context.productKitUnavailable) return { isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON }
	if (!context.productKit) return undefined
	const recorded = record.provenance.productKit
	if (!recorded) return { isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_MISSING_REASON }
	if (productKitChanged(recorded, context.productKit)) return { isStale: true, reason: PRODUCT_KIT_CHANGED_REASON }
	return undefined
}
