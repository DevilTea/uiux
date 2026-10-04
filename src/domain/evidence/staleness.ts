import type { FormalEvidenceRecord } from './schema'

export type EvidenceStalenessContext = Readonly<{
	allViews: readonly { key: string; revision: string }[]
	selectedView?: { key: string; revision: string }
	workspace?: {
		resource?: {
			i18n?: { defaultLocale?: string }
			viewports?: Record<string, unknown>
		}
	}
	discoveredLocales?: readonly string[]
}>

export type EvidenceStalenessAssessment = Readonly<{
	isStale: boolean
	reason?: string
}>

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
	}

	if (typeof ctx.viewportId === 'string' && context.workspace?.resource?.viewports) {
		if (!context.workspace.resource.viewports[ctx.viewportId]) {
			return { isStale: true, reason: `Viewport preset '${ctx.viewportId}' was removed` }
		}
	}

	return { isStale: false }
}
