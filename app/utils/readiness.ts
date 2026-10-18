import type { FormalEvidenceRecord } from '../../src/domain/evidence/schema'
import { evaluateEvidenceStaleness, PRODUCT_KIT_CHANGED_REASON, PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON, RENDER_INPUT_CHANGED_REASON, RENDER_INPUT_DIGEST_MISSING_REASON, type EvidenceStalenessContext } from '../../src/domain/evidence/staleness'
import type { HandoffBlockingDiagnostic, HandoffReadiness } from '../../src/domain/handoff/schema'
import type { ResolvedRenderContext } from '../../src/domain/render-context/schema'
import { REVIEW_RESOLUTIONS, type ReviewResolution } from '../../src/domain/reviews/schema'

/**
 * Pure readiness helpers for the Overview and a View's Readiness tab (brief f). Nothing here
 * defines readiness: the server's Handoff assessment owns the gate, and these helpers only
 * split, label and summarize what it returned.
 */

// ---------------------------------------------------------------------------------------------
// Handoff assessment: blocking versus advisory
// ---------------------------------------------------------------------------------------------

export type ReadinessDiagnostics = Readonly<{
	/** Entries that block `implementation-ready`. */
	blocking: readonly HandoffBlockingDiagnostic[]
	/** Entries the server reports with `blocking: false` (for example `handoff.review_declined`). */
	advisory: readonly HandoffBlockingDiagnostic[]
}>

/**
 * Splits `readiness.blockingDiagnostics` by each entry's own `blocking` flag. The list name is
 * historical: a declined Review rides in it with `blocking: false` and must never be counted as
 * a blocker. An entry without an explicit `false` stays blocking, so nothing is under-reported.
 */
export function splitReadinessDiagnostics(diagnostics: readonly HandoffBlockingDiagnostic[] | undefined): ReadinessDiagnostics {
	const blocking: HandoffBlockingDiagnostic[] = []
	const advisory: HandoffBlockingDiagnostic[] = []
	for (const diagnostic of diagnostics ?? []) (diagnostic.blocking === false ? advisory : blocking).push(diagnostic)
	return { blocking, advisory }
}

export type ReviewCoverageSummary = Readonly<{
	complete?: boolean
	threads?: number
	/** Closed threads per resolution kind, from `coverage.review.resolved` (schema v2). */
	resolved: Readonly<Record<ReviewResolution, number>>
	/** Sum of `resolved`. */
	resolvedTotal: number
}>

/** Reads `readiness.coverage.review` defensively; missing counts are zero. */
export function reviewCoverageSummary(readiness: HandoffReadiness | undefined): ReviewCoverageSummary {
	const review = (readiness?.coverage?.review ?? {}) as Record<string, unknown>
	const raw = (review.resolved && typeof review.resolved === 'object' ? review.resolved : {}) as Record<string, unknown>
	const resolved = Object.fromEntries(REVIEW_RESOLUTIONS.map(kind => [kind, typeof raw[kind] === 'number' ? raw[kind] as number : 0])) as Record<ReviewResolution, number>
	return {
		...(typeof review.complete === 'boolean' ? { complete: review.complete } : {}),
		...(typeof review.threads === 'number' ? { threads: review.threads } : {}),
		resolved,
		resolvedTotal: REVIEW_RESOLUTIONS.reduce((sum, kind) => sum + resolved[kind], 0),
	}
}

export type HandoffDiagnosticSubject = Readonly<{
	viewId?: string
	reviewId?: string
	assetId?: string
	locale?: string
	flowId?: string
}>

/** The resource a Handoff diagnostic is about, read from its JSON pointer path. */
export function handoffDiagnosticSubject(diagnostic: Pick<HandoffBlockingDiagnostic, 'path'>): HandoffDiagnosticSubject {
	const path = diagnostic.path ?? ''
	const match = /^\/(views|reviews|assets|flows|i18n)\/([^/]+)/.exec(path)
	if (!match) return {}
	const [, kind, id] = match
	if (kind === 'views') return { viewId: id }
	if (kind === 'reviews') return { reviewId: id }
	if (kind === 'assets') return { assetId: id }
	if (kind === 'flows') return { flowId: id }
	return { locale: id!.replace(/\.json$/, '') }
}

// ---------------------------------------------------------------------------------------------
// Evidence freshness
// ---------------------------------------------------------------------------------------------

export type EvidenceFreshnessReason =
	| 'viewChanged'
	| 'viewMissing'
	| 'localeChanged'
	| 'localeMissing'
	| 'viewportRemoved'
	| 'viewportChanged'
	| 'themeRemoved'
	| 'incomplete'
	| 'noView'
	| 'noViewRevision'
	| 'noRenderInputDigest'
	| 'noLocaleRevision'
	| 'productKitChanged'
	| 'noProductKit'
	| 'productKitUnavailable'
	| 'other'

export type EvidenceFreshness = Readonly<{
	state: 'fresh' | 'stale' | 'unknown'
	reason?: EvidenceFreshnessReason
	/** The locale, viewport or theme key the reason names. */
	subject?: string
}>

type ProvenanceIdentity = Readonly<{ type?: unknown; id?: unknown }>

function provenanceFor(record: FormalEvidenceRecord, type: string, id: unknown): boolean {
	return (record.provenance?.resources ?? []).some((resource) => {
		const identity = resource.identity as ProvenanceIdentity
		return identity?.type === type && identity?.id === id
	})
}

/**
 * Freshness of one formal capture against the current Workspace (Part 1, Part 10). A record
 * that does not carry the revisions needed to judge it reads `unknown`, never `fresh`
 * (roadmap R9 acceptance 5).
 */
export function evidenceFreshness(record: FormalEvidenceRecord, context: EvidenceStalenessContext): EvidenceFreshness {
	const execution = (record.executionContext ?? {}) as Record<string, unknown>
	if (typeof execution.viewId !== 'string' || !execution.viewId) return { state: 'unknown', reason: 'noView' }
	if (!context.allViews.some(view => view.key === execution.viewId)) return { state: 'stale', reason: 'viewMissing' }
	if (!provenanceFor(record, 'view', execution.viewId)) return { state: 'unknown', reason: 'noViewRevision' }
	const locale = typeof execution.locale === 'string' ? execution.locale : undefined
	if (locale && context.localeRevisions?.[locale] && !provenanceFor(record, 'locale', locale))
		return { state: 'unknown', reason: 'noLocaleRevision', subject: locale }

	const assessed = evaluateEvidenceStaleness(record, context)
	// Rule 01a1161b-ff68-…: a capture without Product Kit provenance, or judged while the current one
	// cannot be computed, is unknown, not fresh.
	if (assessed.unknown) return { state: 'unknown', reason: assessed.reason === PRODUCT_KIT_PROVENANCE_UNAVAILABLE_REASON ? 'productKitUnavailable' : 'noProductKit' }
	if (assessed.isStale) return { state: 'stale', ...staleReason(assessed.reason) }
	if (record.coverage?.complete !== true) return { state: 'stale', reason: 'incomplete' }
	return { state: 'fresh' }
}

function staleReason(reason: string | undefined): Pick<EvidenceFreshness, 'reason' | 'subject'> {
	if (!reason) return { reason: 'other' }
	if (reason === RENDER_INPUT_CHANGED_REASON) return { reason: 'viewChanged' }
	if (reason === RENDER_INPUT_DIGEST_MISSING_REASON) return { reason: 'noRenderInputDigest' }
	if (reason === 'View no longer exists') return { reason: 'viewMissing' }
	if (reason === PRODUCT_KIT_CHANGED_REASON) return { reason: 'productKitChanged' }
	const patterns: ReadonlyArray<readonly [RegExp, EvidenceFreshnessReason]> = [
		[/^Locale '(.+)' is not in workspace$/, 'localeMissing'],
		[/^Locale '(.+)' revision has changed since capture$/, 'localeChanged'],
		[/^Viewport preset '(.+)' was removed$/, 'viewportRemoved'],
		[/^Viewport preset '(.+)' dimensions changed since capture$/, 'viewportChanged'],
		[/^Theme '(.+)' was removed$/, 'themeRemoved'],
	]
	for (const [pattern, code] of patterns) {
		const match = pattern.exec(reason)
		if (match) return { reason: code, subject: match[1] }
	}
	return { reason: 'other' }
}

// ---------------------------------------------------------------------------------------------
// Render contexts: explicit capture lists (Part 10: no hidden Cartesian expansion)
// ---------------------------------------------------------------------------------------------

export type CaptureContext = ResolvedRenderContext

export type CaptureDimensionOptions = Readonly<{
	/** Variant names; `''` is the base (no Variant). */
	variants: readonly string[]
	locales: readonly string[]
	viewports: readonly Readonly<{ id: string; width: number; height: number }>[]
	themes: readonly string[]
}>

export type CaptureDimension = 'variants' | 'locales' | 'viewports' | 'themes'

/** Stable identity of a resolved render context. */
export function contextKey(context: CaptureContext): string {
	return [context.viewId, context.variantName ?? '', context.locale, context.viewportId, `${context.viewport.width}x${context.viewport.height}`, context.themeId].join('\u0000')
}

/** The resolved render context a formal capture recorded, if it names one. */
export function contextFromRecord(record: FormalEvidenceRecord): CaptureContext | undefined {
	const execution = (record.executionContext ?? {}) as Record<string, unknown>
	const viewport = execution.viewport as { width?: unknown; height?: unknown } | undefined
	if (typeof execution.viewId !== 'string' || typeof execution.locale !== 'string'
		|| typeof execution.viewportId !== 'string' || typeof execution.themeId !== 'string'
		|| typeof viewport?.width !== 'number' || typeof viewport?.height !== 'number')
		return undefined
	return {
		viewId: execution.viewId,
		...(typeof execution.variantName === 'string' && execution.variantName ? { variantName: execution.variantName } : {}),
		locale: execution.locale,
		viewportId: execution.viewportId,
		viewport: { width: viewport.width, height: viewport.height },
		themeId: execution.themeId,
	}
}

/**
 * One convenience step: every context in `list`, repeated for every value of one dimension.
 * The result is an explicit list the reviewer sees and edits before anything runs; capture
 * never expands it again. Order is stable and duplicates are dropped.
 */
export function expandContexts(list: readonly CaptureContext[], dimension: CaptureDimension, options: CaptureDimensionOptions): CaptureContext[] {
	const out: CaptureContext[] = []
	const seen = new Set<string>()
	const push = (context: CaptureContext) => {
		const key = contextKey(context)
		if (seen.has(key)) return
		seen.add(key)
		out.push(context)
	}
	for (const context of list) {
		if (dimension === 'variants') {
			for (const name of options.variants.length ? options.variants : ['']) {
				const rest: CaptureContext = { viewId: context.viewId, locale: context.locale, viewportId: context.viewportId, viewport: context.viewport, themeId: context.themeId }
				push(name ? { ...rest, variantName: name } : rest)
			}
		}
		else if (dimension === 'locales') {
			for (const locale of options.locales.length ? options.locales : [context.locale]) push({ ...context, locale })
		}
		else if (dimension === 'viewports') {
			for (const viewport of options.viewports.length ? options.viewports : [{ id: context.viewportId, ...context.viewport }])
				push({ ...context, viewportId: viewport.id, viewport: { width: viewport.width, height: viewport.height } })
		}
		else {
			for (const themeId of options.themes.length ? options.themes : [context.themeId]) push({ ...context, themeId })
		}
	}
	return out
}

// ---------------------------------------------------------------------------------------------
// Checks: findings grouped problem → resource → Widget (Part 5, findings only)
// ---------------------------------------------------------------------------------------------

export type FindingResource = Readonly<{ kind: 'workspace' | 'view' | 'flow' | 'locale' | 'asset' | 'product-kit'; key: string; name: string }>

export type Finding = Readonly<{
	code: string
	message: string
	path: string
	resource: FindingResource
	/** The Widget a View finding resolves to; never guessed. */
	widgetId?: string
	/** The resolved Widget's type, for the blueprint label. */
	widgetType?: string
	/** The Variant a Product Kit capture finding concerns; absent for the base state. */
	variantName?: string
	/** The registry component a Product Kit finding concerns. */
	component?: string
	/**
	 * The group's plain sentence, in place of the first message under its code; and, for a finding
	 * that has no code (the props and emits check, which Discussion #139 gives no code, with `code`
	 * empty), the key it groups by.
	 */
	group?: Readonly<{ key: string; title: string }>
}>

export type FindingGroup = Readonly<{
	/** Empty for a group of findings without a code; `title` names it then. */
	code: string
	title?: string
	/** The group's key: the code, or the codeless group's own key. */
	key: string
	category: string
	/** The first message under this code, as the group's plain sentence. */
	message: string
	count: number
	resources: readonly Readonly<{ resource: FindingResource; findings: readonly Finding[] }>[]
}>

/** The category of a diagnostic code: its first dotted segment (`schema`, `i18n`, `view`…). */
export function findingCategory(code: string): string {
	const index = code.indexOf('.')
	return index > 0 ? code.slice(0, index) : code
}

/** Groups findings by code, then by resource, keeping first-seen order at every level. */
export function groupFindings(findings: readonly Finding[]): FindingGroup[] {
	const groups = new Map<string, { key: string; code: string; title?: string; message: string; findings: Finding[] }>()
	for (const finding of findings) {
		const key = finding.code || `group:${finding.group?.key ?? ''}`
		const group = groups.get(key) ?? { key, code: finding.code, ...(finding.group ? { title: finding.group.title } : {}), message: finding.message, findings: [] }
		group.findings.push(finding)
		groups.set(key, group)
	}
	return [...groups.values()].map((group) => {
		const resources = new Map<string, { resource: FindingResource; findings: Finding[] }>()
		for (const finding of group.findings) {
			const key = `${finding.resource.kind}:${finding.resource.key}`
			const entry = resources.get(key) ?? { resource: finding.resource, findings: [] }
			entry.findings.push(finding)
			resources.set(key, entry)
		}
		return {
			key: group.key,
			code: group.code,
			...(group.title ? { title: group.title } : {}),
			category: group.code ? findingCategory(group.code) : 'kit',
			message: group.message,
			count: group.findings.length,
			resources: [...resources.values()],
		}
	})
}

// ---------------------------------------------------------------------------------------------
// "Updated since you last looked" (per browser, no schema change)
// ---------------------------------------------------------------------------------------------

/** True when this browser saw `key` at another revision. A resource never looked at is not "updated". */
export function updatedSince(lastSeen: Readonly<Record<string, string>>, key: string, revision: string): boolean {
	const seen = lastSeen[key]
	return seen !== undefined && seen !== revision
}
