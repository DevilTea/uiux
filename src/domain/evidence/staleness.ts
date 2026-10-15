import { productKitChanged, type ProductKitProvenance } from '../product-kit/provenance'
import type { FormalEvidenceRecord } from './schema'

export type EvidenceStalenessContext = Readonly<{
	allViews: readonly { key: string; revision: string }[]
	selectedView?: { key: string; revision: string }
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
	 * The Workspace's current Product Kit provenance. Absent when the Workspace has no Product Kit
	 * (below `schemaVersion` 5), and then the Product Kit is not judged, or when it is unavailable.
	 */
	productKit?: ProductKitProvenance
	/**
	 * True when the Workspace has a Product Kit file but its current provenance cannot be computed
	 * (`productKitFreshnessContext`): every capture's freshness is then unknown, never fresh.
	 */
	productKitUnavailable?: boolean
}>

export type EvidenceStalenessAssessment = Readonly<{
	isStale: boolean
	reason?: string
	/**
	 * Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1: the capture records no Product Kit provenance, or the
	 * current one cannot be computed, so its freshness is unknown, which counts as not fresh
	 * (`isStale` is true).
	 */
	unknown?: true
}>

/** The reason a capture is stale once the Product Kit changed (Rule 01a11bb1-be4a-7f9b-9fd6-a6e71241113c). */
export const PRODUCT_KIT_CHANGED_REASON = 'Product Kit changed since capture'

/** The reason a capture without Product Kit provenance is not fresh (Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1). */
export const PRODUCT_KIT_PROVENANCE_MISSING_REASON = 'Capture records no Product Kit provenance; capture it again'

/** The reason no capture is fresh while the current Product Kit provenance cannot be computed (Rule 01a1161b-ff68-76af-8237-dbc8ef2c27d1). */
export const PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON = 'Current Product Kit provenance cannot be computed'

export function isCompleteEvidenceForViewRevision(
	record: FormalEvidenceRecord,
	viewId: string,
	revision: string,
): boolean {
	if (record.coverage.complete !== true) return false
	const context = record.executionContext as Record<string, unknown>
	if (context.viewId !== viewId) return false
	return record.provenance.resources.some((resource) => {
		const identity = resource.identity as Record<string, unknown>
		return identity.type === 'view'
			&& identity.id === viewId
			&& resource.revision === revision
	})
}

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

	if (!provView) {
		return { isStale: true, reason: 'Evidence provenance missing View reference' }
	}

	const matchingRevision = (context.selectedView && context.selectedView.key === ctx.viewId)
		? context.selectedView.revision
		: viewSummary.revision

	if (provView.revision !== matchingRevision) {
		return { isStale: true, reason: 'View revision has changed since capture' }
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

	// Rules 01a1161b-ff68-… and 01a11bb1-be4a-…: with a Product Kit whose current provenance cannot be
	// computed, nothing tells whether the capture still matches it, so its freshness is unknown.
	if (context.productKitUnavailable) return { isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON }
	if (context.productKit) {
		const recorded = record.provenance.productKit
		if (!recorded) return { isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_MISSING_REASON }
		if (productKitChanged(recorded, context.productKit)) return { isStale: true, reason: PRODUCT_KIT_CHANGED_REASON }
	}

	return { isStale: false }
}
