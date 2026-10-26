import type { Diagnostic } from '../validation'

/**
 * Review submission change domains (Discussion #241 R2 and the owner confirmations B1, B2 and B4).
 *
 * - Clause 01a14e30-2dce-7b09-8688-4413e1433f3a owns the known values. Any other value a stored
 *   submission holds is an unknown value and does not make the submission invalid, so the stored
 *   schema (`validateReviewSubmission`) keeps accepting any non-empty string.
 * - Clause 01a14e57-637f-76a1-b6ce-45128da52c93: marking ready refuses an unknown value
 *   ({@link unknownChangeDomainDiagnostics}), the only place one is written.
 * - Clause 01a14e30-2e43-75a7-aca8-c8df28915f4e owns which Evidence each value affects
 *   ({@link changeAffectsFormalCapture}, {@link changeAffectsFlowEvidence},
 *   {@link changeAffectsInteractionEvidence}); Rules
 *   01a115cd-c715-7527-b773-cae2d87c8f33 and 01a115cd-c749-7a82-bf67-7d1634e31b35 decide
 *   regeneration from them: Evidence they leave unaffected stays valid and need not be rerun.
 *
 * Pure and browser-safe: the Workbench uses it too.
 */
export const CHANGE_DOMAINS = Object.freeze(['ir', 'variant', 'spec', 'metadata', 'flow', 'asset', 'i18n', 'settings', 'adapter', 'product-kit', 'interaction'] as const)
export type ChangeDomain = typeof CHANGE_DOMAINS[number]

export function isKnownChangeDomain(value: unknown): value is ChangeDomain {
	return typeof value === 'string' && (CHANGE_DOMAINS as readonly string[]).includes(value)
}

/**
 * One `review.change_domain_unknown` diagnostic per string value that is not a known change
 * domain, at `/changeDomains/<index>`. A value that is not a string, or a list that is not an
 * array, is left to the submission schema.
 */
export function unknownChangeDomainDiagnostics(domains: unknown): Diagnostic[] {
	if (!Array.isArray(domains)) return []
	const diagnostics: Diagnostic[] = []
	domains.forEach((domain, index) => {
		if (typeof domain !== 'string' || isKnownChangeDomain(domain)) return
		diagnostics.push({
			code: 'review.change_domain_unknown',
			path: `/changeDomains/${index}`,
			message: `'${domain}' is not a known change domain; use one of ${CHANGE_DOMAINS.join(', ')}.`,
		})
	})
	return diagnostics
}

/**
 * What one change touched, as the Evidence mapping needs it. `views` are the submission's Views
 * (its named Views and a Widget thread's anchor View). Every other set lists the changed
 * resources the change names; an absent set means the change names none, so the mapping reads it
 * conservatively as "any".
 */
export type ChangeScope = Readonly<{
	domains: readonly string[]
	views: ReadonlySet<string>
	flows?: ReadonlySet<string>
	assets?: ReadonlySet<string>
	locales?: ReadonlySet<string>
	viewports?: ReadonlySet<string>
	themes?: ReadonlySet<string>
}>

/**
 * The render context of one formal capture. `boundAssets`, the Assets its View binds, is absent
 * when unknown, which counts as binding the changed Asset.
 */
export type FormalCaptureFacts = Readonly<{
	viewId?: string
	locale?: string
	viewportId?: string
	themeId?: string
	boundAssets?: ReadonlySet<string>
}>

/** Clause 01a14e30-2e43-…: whether a change with these domains affects one formal capture. */
export function changeAffectsFormalCapture(scope: ChangeScope, capture: FormalCaptureFacts): boolean {
	return scope.domains.some(domain => domainAffectsFormalCapture(domain, scope, capture))
}

function domainAffectsFormalCapture(domain: string, scope: ChangeScope, capture: FormalCaptureFacts): boolean {
	switch (domain) {
		// `spec` and `metadata` (a View's `name`, `feature` and other fields outside its Spec and its
		// render input) affect no Evidence; `flow` only Flow Evidence.
		case 'spec':
		case 'metadata':
		case 'flow':
		// `interaction` only the interaction replay Evidence of the submission's Views (owner ruling 2, #89).
		case 'interaction':
			return false
		// Any View that binds a changed Asset, named by the change or not.
		case 'asset':
			return bindsChangedAsset(scope.assets, capture.boundAssets)
		case 'i18n':
			return named(scope.locales, capture.locale)
		case 'settings':
			// A set the change does not name reads as "any", like every other set: the change may have
			// touched any viewport or theme it leaves unnamed.
			return named(scope.viewports, capture.viewportId) || named(scope.themes, capture.themeId)
		case 'adapter':
		case 'product-kit':
			return true
		// `ir`, `variant` and, read conservatively, an unknown stored value.
		default:
			return capture.viewId !== undefined && scope.views.has(capture.viewId)
	}
}

/** Clause 01a14e30-2e43-…: only `flow` affects Flow Evidence, and only that of the change's Flows. */
export function changeAffectsFlowEvidence(scope: ChangeScope, flowId: string): boolean {
	return scope.domains.includes('flow') && named(scope.flows, flowId)
}

/**
 * Clause 01a14e30-2e43-…: only `interaction` affects interaction replay Evidence, and only that of the
 * Views the change names. Citing such Evidence stays the author's choice.
 */
export function changeAffectsInteractionEvidence(scope: ChangeScope, viewId: string): boolean {
	return scope.domains.includes('interaction') && scope.views.has(viewId)
}

/** True when `value` is in `set`, or `set` is absent (the change names none, so any counts). */
function named(set: ReadonlySet<string> | undefined, value: string | undefined): boolean {
	if (set === undefined) return true
	return value !== undefined && set.has(value)
}

function bindsChangedAsset(changed: ReadonlySet<string> | undefined, bound: ReadonlySet<string> | undefined): boolean {
	if (bound === undefined) return true
	if (changed === undefined) return bound.size > 0
	for (const asset of bound) if (changed.has(asset)) return true
	return false
}

/**
 * The change scope a stored submission states: its domains, its Views (each `view` resource it
 * names, plus `anchorViewId` for a Widget thread), and the Flows, Assets and Locales it names. A
 * submission names the Workspace manifest only as a whole, so the changed viewports and themes stay
 * unknown.
 */
export function changeScopeOfSubmission(
	submission: Readonly<{ changeDomains?: readonly unknown[]; resources?: readonly Readonly<{ identity?: unknown }>[] }>,
	anchorViewId?: string,
): ChangeScope {
	const views = new Set<string>()
	const flows = new Set<string>()
	const assets = new Set<string>()
	const locales = new Set<string>()
	if (anchorViewId) views.add(anchorViewId)
	for (const resource of Array.isArray(submission.resources) ? submission.resources : []) {
		const named = namedResource(resource?.identity)
		if (!named) continue
		if (named.kind === 'view') views.add(named.key)
		else if (named.kind === 'flow') flows.add(named.key)
		else if (named.kind === 'asset') assets.add(named.key)
		else if (named.kind === 'locale') locales.add(named.key)
	}
	const domains = (Array.isArray(submission.changeDomains) ? submission.changeDomains : []).filter((domain): domain is string => typeof domain === 'string')
	return {
		domains,
		views,
		...(flows.size > 0 ? { flows } : {}),
		...(assets.size > 0 ? { assets } : {}),
		...(locales.size > 0 ? { locales } : {}),
	}
}

/** `{ type, id }` or `{ kind, key }`. */
function namedResource(identity: unknown): { kind: string; key: string } | undefined {
	if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return undefined
	const record = identity as Record<string, unknown>
	if (typeof record.type === 'string' && typeof record.id === 'string') return { kind: record.type, key: record.id }
	if (typeof record.kind === 'string' && typeof record.key === 'string') return { kind: record.kind, key: record.key }
	return undefined
}
