import { describe, expect, it } from 'vitest'
import {
	CHANGE_DOMAINS,
	changeAffectsFlowEvidence,
	changeAffectsFormalCapture,
	changeAffectsInteractionEvidence,
	changeScopeOfSubmission,
	isKnownChangeDomain,
	unknownChangeDomainDiagnostics,
	type ChangeScope,
	type FormalCaptureFacts,
} from '../src/domain/reviews/change-domains'

/**
 * Review change domains (Discussion #241 R2 and its owner confirmations B1, B2 and B4): Clause
 * 01a14e30-2dce-7b09-8688-4413e1433f3a (the known values), Clause
 * 01a14e57-637f-76a1-b6ce-45128da52c93 (refused when written) and Clause
 * 01a14e30-2e43-75a7-aca8-c8df28915f4e (which Evidence each value affects).
 */

const CHECKOUT = '11111111-1111-4111-8111-111111111111'
const RECEIPT = '11111111-1111-4111-8111-111111111112'
const LOGO = '33333333-3333-4333-8333-333333333333'
const HERO = '33333333-3333-4333-8333-333333333334'
const FLOW = '55555555-5555-4555-8555-555555555555'

/** Two Views captured in two Locales, viewports and themes; only Receipt binds the logo. */
const captures: Readonly<Record<string, FormalCaptureFacts>> = {
	checkoutEn: { viewId: CHECKOUT, locale: 'en-US', viewportId: 'desktop', themeId: 'light', boundAssets: new Set() },
	checkoutZh: { viewId: CHECKOUT, locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark', boundAssets: new Set() },
	receiptEn: { viewId: RECEIPT, locale: 'en-US', viewportId: 'desktop', themeId: 'light', boundAssets: new Set([LOGO]) },
}

function scope(domains: readonly string[], extra: Partial<ChangeScope> = {}): ChangeScope {
	return { domains, views: new Set([CHECKOUT]), ...extra }
}

function affected(change: ChangeScope): string[] {
	return Object.entries(captures).filter(([, capture]) => changeAffectsFormalCapture(change, capture)).map(([name]) => name)
}

describe('known change domains (Clause 01a14e30-2dce-…)', () => {
	it('are exactly the eleven values the Clause lists', () => {
		expect([...CHANGE_DOMAINS]).toEqual(['ir', 'variant', 'spec', 'metadata', 'flow', 'asset', 'i18n', 'settings', 'adapter', 'product-kit', 'interaction'])
		for (const domain of CHANGE_DOMAINS) expect(isKnownChangeDomain(domain)).toBe(true)
		for (const domain of ['IR', 'views', 'view-structure', 'copy', 'Adapter/config', '', ' ir']) expect(isKnownChangeDomain(domain)).toBe(false)
	})

	it('names each unknown string value at its index with review.change_domain_unknown (Clause 01a14e57-637f-…)', () => {
		expect(unknownChangeDomainDiagnostics(['spec', 'Spec', 'flow', 'views'])).toEqual([
			{ code: 'review.change_domain_unknown', path: '/changeDomains/1', message: expect.stringContaining("'Spec'") },
			{ code: 'review.change_domain_unknown', path: '/changeDomains/3', message: expect.stringContaining("'views'") },
		])
		expect(unknownChangeDomainDiagnostics([...CHANGE_DOMAINS])).toEqual([])
		// A wrong shape is the submission schema's to refuse.
		expect(unknownChangeDomainDiagnostics('ir')).toEqual([])
		expect(unknownChangeDomainDiagnostics([7, null])).toEqual([])
	})
})

describe('the Evidence a change domain affects (Clause 01a14e30-2e43-…)', () => {
	it('spec and metadata affect no Evidence', () => {
		expect(affected(scope(['spec']))).toEqual([])
		expect(affected(scope(['metadata']))).toEqual([])
		expect(affected(scope(['spec', 'metadata']))).toEqual([])
		expect(changeAffectsFlowEvidence(scope(['spec', 'metadata'], { flows: new Set([FLOW]) }), FLOW)).toBe(false)
	})

	it('flow affects only the Flow Evidence of the change\'s Flows and no formal capture', () => {
		const change = scope(['flow'], { flows: new Set([FLOW]) })
		expect(affected(change)).toEqual([])
		expect(changeAffectsFlowEvidence(change, FLOW)).toBe(true)
		expect(changeAffectsFlowEvidence(change, '55555555-5555-4555-8555-555555555556')).toBe(false)
		// ir names no Flow Evidence.
		expect(changeAffectsFlowEvidence(scope(['ir'], { flows: new Set([FLOW]) }), FLOW)).toBe(false)
	})

	// Clause 01a14e30-2e43-…: a reference-only Flow edit affects no Flow Evidence; its digest equals the trace's.
	it('flow affects no trace whose recorded Flow input digest equals the Flow\'s current one, and any other', () => {
		const change = scope(['flow'], { flows: new Set([FLOW]) })
		expect(changeAffectsFlowEvidence(change, FLOW, { recordedFlowInputDigest: 'sha256:a', currentFlowInputDigest: 'sha256:a' })).toBe(false)
		expect(changeAffectsFlowEvidence(change, FLOW, { recordedFlowInputDigest: 'sha256:a', currentFlowInputDigest: 'sha256:b' })).toBe(true)
		// A trace without a recorded digest, or a Flow whose digest is unknown, stays affected.
		expect(changeAffectsFlowEvidence(change, FLOW, { currentFlowInputDigest: 'sha256:a' })).toBe(true)
		expect(changeAffectsFlowEvidence(change, FLOW, { recordedFlowInputDigest: 'sha256:a' })).toBe(true)
	})

	it('interaction affects only the interaction Evidence of the change\'s Views and no formal capture', () => {
		const change = scope(['interaction'])
		expect(affected(change)).toEqual([])
		expect(changeAffectsInteractionEvidence(change, CHECKOUT)).toBe(true)
		expect(changeAffectsInteractionEvidence(change, RECEIPT)).toBe(false)
		// ir, variant and flow leave interaction Evidence alone, as the Clause lists.
		expect(changeAffectsInteractionEvidence(scope(['ir', 'variant', 'flow', 'spec', 'metadata']), CHECKOUT)).toBe(false)
		expect(changeAffectsInteractionEvidence(scope(['ir', 'interaction']), CHECKOUT)).toBe(true)
	})

	it('ir and variant affect every formal capture of the change\'s Views, and only those', () => {
		expect(affected(scope(['ir']))).toEqual(['checkoutEn', 'checkoutZh'])
		expect(affected(scope(['variant']))).toEqual(['checkoutEn', 'checkoutZh'])
		expect(affected(scope(['ir'], { views: new Set([RECEIPT]) }))).toEqual(['receiptEn'])
	})

	it('asset affects the captures of every View that binds a changed Asset', () => {
		expect(affected(scope(['asset'], { assets: new Set([LOGO]) }))).toEqual(['receiptEn'])
		expect(affected(scope(['asset'], { assets: new Set([HERO]) }))).toEqual([])
		// A change that names no Asset counts as any Asset; a capture whose bound Assets are unknown counts as binding it.
		expect(affected(scope(['asset']))).toEqual(['receiptEn'])
		expect(changeAffectsFormalCapture(scope(['asset'], { assets: new Set([HERO]) }), { viewId: CHECKOUT })).toBe(true)
	})

	it('i18n affects every formal capture in a changed Locale, Workspace-wide', () => {
		expect(affected(scope(['i18n'], { locales: new Set(['en-US']) }))).toEqual(['checkoutEn', 'receiptEn'])
		expect(affected(scope(['i18n'], { locales: new Set(['zh-TW']) }))).toEqual(['checkoutZh'])
		// No Locale named: any Locale may have changed.
		expect(affected(scope(['i18n']))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
	})

	it('settings affects every formal capture in a changed viewport or theme, Workspace-wide', () => {
		expect(affected(scope(['settings'], { viewports: new Set(['mobile']), themes: new Set(['light']) }))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
		expect(affected(scope(['settings'], { viewports: new Set(['mobile']), themes: new Set(['sepia']) }))).toEqual(['checkoutZh'])
		// A set the change leaves unnamed reads as any, like the other sets.
		expect(affected(scope(['settings'], { viewports: new Set(['mobile']) }))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
		expect(affected(scope(['settings'], { themes: new Set(['light']) }))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
		// A submission names the manifest only as a whole, so its changed keys are unknown.
		expect(affected(scope(['settings']))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
	})

	it('adapter and product-kit affect every formal capture of the Workspace', () => {
		expect(affected(scope(['adapter']))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
		expect(affected(scope(['product-kit']))).toEqual(['checkoutEn', 'checkoutZh', 'receiptEn'])
	})

	it('reads a stored unknown value conservatively: it affects every formal capture of the change\'s Views', () => {
		expect(affected(scope(['views']))).toEqual(['checkoutEn', 'checkoutZh'])
		expect(affected(scope(['spec', 'Copy']))).toEqual(['checkoutEn', 'checkoutZh'])
	})
})

describe('the change scope a stored submission states', () => {
	it('collects its Views (with a Widget thread\'s anchor View), Flows, Assets and Locales in either identity form', () => {
		const change = changeScopeOfSubmission({
			changeDomains: ['views', 'i18n', 7],
			resources: [
				{ identity: { type: 'workspace' } },
				{ identity: { kind: 'view', key: RECEIPT } },
				{ identity: { type: 'flow', id: FLOW } },
				{ identity: { type: 'asset', id: LOGO } },
				{ identity: { kind: 'locale', key: 'zh-TW' } },
				{ identity: 'not an identity' },
			],
		}, CHECKOUT)
		expect(change).toEqual({
			domains: ['views', 'i18n'],
			views: new Set([CHECKOUT, RECEIPT]),
			flows: new Set([FLOW]),
			assets: new Set([LOGO]),
			locales: new Set(['zh-TW']),
		})
	})

	it('leaves a kind it names none of unset, so the mapping reads it as any', () => {
		expect(changeScopeOfSubmission({ changeDomains: ['i18n'], resources: [{ identity: { type: 'view', id: CHECKOUT } }] })).toEqual({ domains: ['i18n'], views: new Set([CHECKOUT]) })
		expect(changeScopeOfSubmission({})).toEqual({ domains: [], views: new Set() })
	})
})
