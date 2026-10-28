import type { RequirementReferrer, RequirementsCoverage } from '../../src/application/services/requirements'
import { requirementLink } from '../../src/domain/requirements/schema'
import type { RequirementsSetting } from '../../src/domain/requirements/schema'
import { flowPath, viewLocation } from './workbench-routes'

/**
 * Requirement references as the Workbench shows them (Feature 01a18120-f2dd-72a2-bc50-cea327cf1b4d):
 * the Workbench only shows references, the provider and `noUi`; MCP authors them.
 */

/** One requirement reference of a View: its ID and the Variants that list it. */
export type ViewRequirementRow = Readonly<{
	id: string
	/** True when the View's Spec lists the ID itself. */
	fromView: boolean
	/** The Variants whose entries list the ID, in Variant name order. */
	variants: readonly string[]
}>

type ViewLike = Readonly<{
	spec?: Readonly<{ requirements?: readonly string[] }>
	variants?: Readonly<Record<string, Readonly<{ requirements?: readonly string[] }> | undefined>>
}>

/**
 * The references of a View (Rule 01a18120-fa17-…): its Spec's, then the ones only a Variant lists, each
 * with the Variants behind it so the page can name them (Rule 01a18120-fe71-…).
 */
export function viewRequirementRows(view: ViewLike | undefined): readonly ViewRequirementRow[] {
	if (!view) return []
	const rows = new Map<string, { fromView: boolean; variants: string[] }>()
	const row = (id: string) => {
		let entry = rows.get(id)
		if (!entry) rows.set(id, entry = { fromView: false, variants: [] })
		return entry
	}
	for (const id of view.spec?.requirements ?? []) row(id).fromView = true
	for (const name of Object.keys(view.variants ?? {}).sort()) {
		for (const id of view.variants?.[name]?.requirements ?? []) row(id).variants.push(name)
	}
	return [...rows.entries()].map(([id, entry]) => ({ id, fromView: entry.fromView, variants: entry.variants }))
}

/** The link of a `url` provider for `id` (Rule 01a18120-fc4e-…), or `undefined` with any other provider. */
export function requirementHref(setting: RequirementsSetting | undefined, id: string): string | undefined {
	return setting?.provider === 'url' ? requirementLink(setting.template, id) : undefined
}

/** Where a referrer lives in the Workbench: its View's Spec (a Variant selected), or the Flow's page. */
export function referrerLocation(referrer: RequirementReferrer): string | ReturnType<typeof viewLocation> | undefined {
	if (referrer.kind === 'flow') return referrer.flowId ? flowPath(referrer.flowId) : undefined
	if (!referrer.viewId) return undefined
	return viewLocation(referrer.viewId, { panel: 'spec', ...(referrer.kind === 'variant' && referrer.variantName ? { variant: referrer.variantName } : {}) })
}

/**
 * Coverage as the share of the provider's requirements that are not `noUi` and that some View, Variant
 * or Flow references (Rule 01a18120-fd5d-…), or `undefined` when the provider was not read with `ok`
 * (Rule 01a1814f-8133-…: never full coverage) or has no requirement outside `noUi`.
 */
export function coverageShare(coverage: RequirementsCoverage | undefined): Readonly<{ covered: number; total: number; percent: number }> | undefined {
	if (!coverage || coverage.status !== 'ok') return undefined
	const total = coverage.counts.referenced + coverage.counts.unreferenced
	if (total === 0) return undefined
	return { covered: coverage.counts.referenced, total, percent: Math.floor(coverage.counts.referenced / total * 100) }
}
