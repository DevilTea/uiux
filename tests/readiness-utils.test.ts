import { describe, expect, it } from 'vitest'
import type { EvidenceStalenessContext } from '../src/domain/evidence/staleness'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import type { HandoffBlockingDiagnostic, HandoffReadiness } from '../src/domain/handoff/schema'
import {
	contextKey,
	evidenceFreshness,
	expandContexts,
	handoffDiagnosticSubject,
	reviewCoverageSummary,
	splitReadinessDiagnostics,
	unchangedSinceCapture,
	updatedSince,
	type CaptureContext,
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

const RENDER_INPUT = `sha256:${'d'.repeat(64)}`

function record(overrides: Partial<{ resources: FormalEvidenceRecord['provenance']['resources']; context: Record<string, unknown>; complete: boolean; renderInputDigest: string | null }> = {}): FormalEvidenceRecord {
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
			...(overrides.renderInputDigest === null ? {} : { renderInputDigest: overrides.renderInputDigest ?? RENDER_INPUT }),
		},
		artifactRefs: [],
	}
}

const CURRENT = {
	allViews: [{ key: VIEW, renderInputDigest: RENDER_INPUT }],
	workspace: { resource: { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } }, themes: { light: {} } } },
	discoveredLocales: ['en-US'],
	localeRevisions: { 'en-US': 'r_locale' },
}

describe('Evidence freshness (R9 acceptance 5)', () => {
	it('is fresh only when every revision it needs matches', () => {
		expect(evidenceFreshness(record(), CURRENT)).toEqual({ state: 'fresh' })
	})

	it('is stale when the View or Locale changed after capture', () => {
		expect(evidenceFreshness(record(), { ...CURRENT, allViews: [{ key: VIEW, renderInputDigest: `sha256:${'e'.repeat(64)}` }] })).toEqual({ state: 'stale', reason: 'viewChanged' })
		expect(evidenceFreshness(record(), { ...CURRENT, localeRevisions: { 'en-US': 'r_next' } })).toEqual({ state: 'stale', reason: 'localeChanged', subject: 'en-US' })
	})

	it('reads unknown, never fresh, when the record lacks a revision to judge', () => {
		expect(evidenceFreshness(record({ resources: [{ identity: { type: 'locale', id: 'en-US' }, revision: 'r_locale' }] }), CURRENT).state).toBe('unknown')
		expect(evidenceFreshness(record({ resources: [{ identity: { type: 'view', id: VIEW }, revision: 'r_view' }] }), CURRENT)).toEqual({ state: 'unknown', reason: 'noLocaleRevision', subject: 'en-US' })
		expect(evidenceFreshness(record({ context: { locale: 'en-US' } }), CURRENT)).toEqual({ state: 'unknown', reason: 'noView' })
	})

	it('is stale when the record carries no render-input digest (Rule 01a115cd-c53c-…)', () => {
		expect(evidenceFreshness(record({ renderInputDigest: null }), CURRENT)).toEqual({ state: 'stale', reason: 'noRenderInputDigest' })
	})

	it('never calls an incomplete run fresh', () => {
		expect(evidenceFreshness(record({ complete: false }), CURRENT)).toEqual({ state: 'stale', reason: 'incomplete' })
	})

	it('names an Adapter change as stale, and missing or unavailable Adapter provenance as unknown (issue #57)', () => {
		const adapter = { moduleSpecifier: './adapters/a.mjs', adapterId: 'a', apiVersion: '1', contentDigest: `sha256:${'a'.repeat(64)}` }
		const captured: FormalEvidenceRecord = { ...record(), provenance: { ...record().provenance, adapters: [adapter] } }
		expect(evidenceFreshness(captured, { ...CURRENT, adapters: [adapter] })).toEqual({ state: 'fresh' })
		expect(evidenceFreshness(captured, { ...CURRENT, adapters: [{ ...adapter, contentDigest: `sha256:${'b'.repeat(64)}` }] })).toEqual({ state: 'stale', reason: 'adapterChanged' })
		expect(evidenceFreshness(record(), { ...CURRENT, adapters: [adapter] })).toEqual({ state: 'unknown', reason: 'noAdapters' })
		expect(evidenceFreshness(captured, { ...CURRENT, adaptersUnavailable: true })).toEqual({ state: 'unknown', reason: 'adaptersUnavailable' })
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

describe('Updated since you last looked', () => {
	it('marks only resources this browser saw at another revision', () => {
		expect(updatedSince({ 'view:a': 'r1' }, 'view:a', 'r2')).toBe(true)
		expect(updatedSince({ 'view:a': 'r1' }, 'view:a', 'r1')).toBe(false)
		expect(updatedSince({}, 'view:a', 'r1')).toBe(false)
	})
})

describe('unchangedSinceCapture', () => {
	const record = {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: VIEW },
		provenance: { resources: [{ identity: { type: 'view', id: VIEW }, revision: 'r2' }], renderInputDigest: 'sha256:recorded' },
	} as unknown as FormalEvidenceRecord
	const context = { allViews: [{ key: VIEW, renderInputDigest: 'sha256:old' }] } as unknown as EvidenceStalenessContext
	const digestOf = (c: EvidenceStalenessContext) => c.allViews.find(view => view.key === VIEW)?.renderInputDigest

	it('keeps the context while the digest is for the current revision', () => {
		expect(unchangedSinceCapture(record, new Map([[VIEW, { revision: 'r2' }]]), new Map([[VIEW, 'r2']]), context)).toBe(context)
	})

	it('uses the recorded digest while the list lags and the capture saw the current revision', () => {
		const next = unchangedSinceCapture(record, new Map([[VIEW, { revision: 'r1' }]]), new Map([[VIEW, 'r2']]), context)
		expect(digestOf(next)).toBe('sha256:recorded')
		// A View with no entry (unreadable) and a capture of the current revision reads the same.
		expect(digestOf(unchangedSinceCapture(record, new Map(), new Map([[VIEW, 'r2']]), context))).toBe('sha256:recorded')
	})

	it('keeps the context when the capture saw another revision, or the View is unknown', () => {
		expect(unchangedSinceCapture(record, new Map([[VIEW, { revision: 'r1' }]]), new Map([[VIEW, 'r3']]), context)).toBe(context)
		expect(unchangedSinceCapture(record, new Map(), new Map(), context)).toBe(context)
	})
})
