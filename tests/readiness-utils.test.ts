import { describe, expect, it } from 'vitest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { HandoffBlockingDiagnostic, HandoffReadiness } from '../src/domain/handoff/schema'
import {
	contextKey,
	evidenceFreshness,
	expandContexts,
	groupFindings,
	handoffDiagnosticSubject,
	reviewCoverageSummary,
	splitReadinessDiagnostics,
	updatedSince,
	type CaptureContext,
	type Finding,
} from '../app/utils/readiness'

const VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const REVIEW = '140f4e87-cc50-4768-a82b-56b663609321'

function diagnostic(code: string, blocking: boolean, path?: string): HandoffBlockingDiagnostic {
	return { code, message: code, blocking, ...(path ? { path } : {}) }
}

describe('Handoff assessment: blocking versus advisory (R9)', () => {
	it('never counts a non-blocking entry, such as a declined Review, as a blocker', () => {
		const split = splitReadinessDiagnostics([
			diagnostic('handoff.unresolved_review_thread', true, `/reviews/${REVIEW}`),
			diagnostic('handoff.review_declined', false, `/reviews/${REVIEW}`),
			diagnostic('handoff.missing_view_evidence', true, `/views/${VIEW}`),
			diagnostic('handoff.review_declined', false, '/reviews/other'),
		])
		expect(split.blocking.map(item => item.code)).toEqual(['handoff.unresolved_review_thread', 'handoff.missing_view_evidence'])
		expect(split.advisory.map(item => item.code)).toEqual(['handoff.review_declined', 'handoff.review_declined'])
	})

	it('keeps an entry without an explicit `blocking: false` on the blocking side', () => {
		const loose = { code: 'x', message: 'x' } as unknown as HandoffBlockingDiagnostic
		expect(splitReadinessDiagnostics([loose]).blocking).toHaveLength(1)
		expect(splitReadinessDiagnostics(undefined)).toEqual({ blocking: [], advisory: [] })
	})

	it('reads per-resolution counts from coverage.review without changing the contract', () => {
		const readiness = {
			implementationReady: false,
			coverage: { validation: {}, evidence: {}, review: { complete: true, threads: 4, resolved: { 'verified': 2, 'wont-fix': 1, 'answered': 0, 'duplicate': 1, 'obsolete': 0 } } },
			blockingDiagnostics: [],
		} as HandoffReadiness
		const summary = reviewCoverageSummary(readiness)
		expect(summary.resolved['wont-fix']).toBe(1)
		expect(summary.resolvedTotal).toBe(4)
		expect(summary.threads).toBe(4)
		expect(reviewCoverageSummary(undefined).resolvedTotal).toBe(0)
	})

	it('names the resource a diagnostic is about', () => {
		expect(handoffDiagnosticSubject({ path: `/views/${VIEW}` })).toEqual({ viewId: VIEW })
		expect(handoffDiagnosticSubject({ path: `/reviews/${REVIEW}` })).toEqual({ reviewId: REVIEW })
		expect(handoffDiagnosticSubject({ path: '/i18n/zh-TW.json/messages' })).toEqual({ locale: 'zh-TW' })
	})
})

function record(overrides: Partial<{ resources: FormalEvidenceRecord['provenance']['resources']; context: Record<string, unknown>; complete: boolean }> = {}): FormalEvidenceRecord {
	return {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: (overrides.context ?? { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }) as never,
		coverage: { complete: overrides.complete ?? true },
		provenance: {
			workspaceSchemaVersion: 2,
			resources: overrides.resources ?? [
				{ identity: { type: 'view', id: VIEW }, revision: 'r_view' },
				{ identity: { type: 'locale', id: 'en-US' }, revision: 'r_locale' },
			],
			versions: {},
		},
		artifactRefs: [],
	}
}

const CURRENT = {
	allViews: [{ key: VIEW, revision: 'r_view' }],
	workspace: { resource: { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } } },
	discoveredLocales: ['en-US'],
	localeRevisions: { 'en-US': 'r_locale' },
}

describe('Evidence freshness (R9 acceptance 5)', () => {
	it('is fresh only when every revision it needs matches', () => {
		expect(evidenceFreshness(record(), CURRENT)).toEqual({ state: 'fresh' })
	})

	it('is stale when the View or Locale changed after capture', () => {
		expect(evidenceFreshness(record(), { ...CURRENT, allViews: [{ key: VIEW, revision: 'r_next' }] })).toEqual({ state: 'stale', reason: 'viewChanged' })
		expect(evidenceFreshness(record(), { ...CURRENT, localeRevisions: { 'en-US': 'r_next' } })).toEqual({ state: 'stale', reason: 'localeChanged', subject: 'en-US' })
	})

	it('reads unknown, never fresh, when the record lacks a revision to judge', () => {
		expect(evidenceFreshness(record({ resources: [{ identity: { type: 'locale', id: 'en-US' }, revision: 'r_locale' }] }), CURRENT).state).toBe('unknown')
		expect(evidenceFreshness(record({ resources: [{ identity: { type: 'view', id: VIEW }, revision: 'r_view' }] }), CURRENT)).toEqual({ state: 'unknown', reason: 'noLocaleRevision', subject: 'en-US' })
		expect(evidenceFreshness(record({ context: { locale: 'en-US' } }), CURRENT)).toEqual({ state: 'unknown', reason: 'noView' })
	})

	it('never calls an incomplete run fresh', () => {
		expect(evidenceFreshness(record({ complete: false }), CURRENT)).toEqual({ state: 'stale', reason: 'incomplete' })
	})
})

describe('Explicit capture lists (Part 10)', () => {
	const base: CaptureContext = { viewId: VIEW, locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' }
	const options = {
		variants: ['', 'compact'],
		locales: ['en-US', 'zh-TW'],
		viewports: [{ id: 'desktop', width: 1280, height: 800 }, { id: 'mobile', width: 390, height: 844 }],
		themes: ['light', 'dark'],
	}

	it('expands one dimension at a time into a visible, de-duplicated list', () => {
		const themed = expandContexts([base], 'themes', options)
		expect(themed.map(context => context.themeId)).toEqual(['light', 'dark'])
		const localized = expandContexts(themed, 'locales', options)
		expect(localized).toHaveLength(4)
		expect(new Set(localized.map(contextKey)).size).toBe(4)
		expect(expandContexts(localized, 'locales', options)).toHaveLength(4)
	})

	it('drops the Variant name for the base entry and keeps resolved viewport dimensions', () => {
		const variants = expandContexts([{ ...base, variantName: 'compact' }], 'variants', options)
		expect(variants[0]).not.toHaveProperty('variantName')
		expect(variants[1]?.variantName).toBe('compact')
		const viewports = expandContexts([base], 'viewports', options)
		expect(viewports[1]).toMatchObject({ viewportId: 'mobile', viewport: { width: 390, height: 844 } })
	})
})

describe('Checks grouping (Part 5)', () => {
	it('groups findings problem → resource, keeping first-seen order', () => {
		const view = { kind: 'view' as const, key: VIEW, name: 'Checkout' }
		const workspace = { kind: 'workspace' as const, key: 'workspace', name: 'Workspace' }
		const findings: Finding[] = [
			{ code: 'schema.unknown_prop', message: 'Unknown property', path: '/ir/slots/content/0', resource: view, widgetId: 'promo' },
			{ code: 'i18n.whitespace', message: 'Whitespace', path: '/messages/a', resource: workspace },
			{ code: 'schema.unknown_prop', message: 'Unknown property 2', path: '/ir/slots/content/1', resource: view, widgetId: 'cta' },
		]
		const groups = groupFindings(findings)
		expect(groups.map(group => [group.code, group.category, group.count])).toEqual([['schema.unknown_prop', 'schema', 2], ['i18n.whitespace', 'i18n', 1]])
		expect(groups[0]!.resources).toHaveLength(1)
		expect(groups[0]!.resources[0]!.findings.map(item => item.widgetId)).toEqual(['promo', 'cta'])
	})
})

describe('Updated since you last looked', () => {
	it('marks only resources this browser saw at another revision', () => {
		expect(updatedSince({ 'view:a': 'r1' }, 'view:a', 'r2')).toBe(true)
		expect(updatedSince({ 'view:a': 'r1' }, 'view:a', 'r1')).toBe(false)
		expect(updatedSince({}, 'view:a', 'r1')).toBe(false)
	})
})
