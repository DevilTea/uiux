import { describe, expect, it } from 'vitest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { evaluateEvidenceStaleness, isCompleteEvidenceForViewRevision } from '../src/domain/evidence/staleness'

describe('evidence staleness evaluation', () => {
	const sampleRecord: FormalEvidenceRecord = {
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: {
			viewId: 'v1',
			locale: 'en-US',
			viewportId: 'desktop',
			viewport: { width: 1280, height: 800 },
			themeId: 'light',
		},
		coverage: { complete: true },
		provenance: {
			workspaceSchemaVersion: 1,
			resources: [
				{ identity: { type: 'view', id: 'v1' }, revision: 'r1' },
			],
			versions: { uiux: '0.1.0' },
		},
		artifactRefs: ['sha256:' + 'a'.repeat(64)],
		data: { format: 'png', width: 1280, height: 800 },
	}

	it('returns isStale=false when view revision matches allViews even if selectedView is different view', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', revision: 'r1' },
				{ key: 'v2', revision: 'r99' },
			],
			selectedView: { key: 'v2', revision: 'r99' },
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
				},
			},
			discoveredLocales: ['en-US'],
		})

		expect(result.isStale).toBe(false)
	})

	it('returns isStale=true when view revision has changed in allViews', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', revision: 'r2' }, // changed to r2!
			],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
				},
			},
		})

		expect(result.isStale).toBe(true)
		expect(result.reason).toContain('View revision has changed')
	})

	it('returns isStale=true when view no longer exists in allViews', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'other-view', revision: 'r1' },
			],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
				},
			},
		})

		expect(result.isStale).toBe(true)
		expect(result.reason).toContain('View no longer exists')
	})

	it('returns isStale=true when viewport preset was removed', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', revision: 'r1' },
			],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { tablet: { dimensions: { width: 768, height: 1024 } } }, // desktop removed
				},
			},
		})

		expect(result.isStale).toBe(true)
		expect(result.reason).toContain('Viewport preset')
	})

	it('returns isStale=true when locale is not in workspace', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', revision: 'r1' },
			],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'fr-FR' },
					viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
				},
			},
			discoveredLocales: ['fr-FR'],
		})

		expect(result.isStale).toBe(true)
		expect(result.reason).toContain('not in workspace')
	})

	describe('review evidence matching', () => {
		it('accepts only complete evidence for the exact View revision', () => {
			expect(isCompleteEvidenceForViewRevision(sampleRecord, 'v1', 'r1')).toBe(true)
			expect(isCompleteEvidenceForViewRevision(sampleRecord, 'v1', 'r2')).toBe(false)
			expect(isCompleteEvidenceForViewRevision(sampleRecord, 'v2', 'r1')).toBe(false)
		})

		it('rejects incomplete formal evidence even when View identity and revision match', () => {
			const incomplete: FormalEvidenceRecord = {
				...sampleRecord,
				coverage: { complete: false },
			}
			expect(isCompleteEvidenceForViewRevision(incomplete, 'v1', 'r1')).toBe(false)
		})

		it('requires provenance for the same View named by the execution context', () => {
			const mismatched: FormalEvidenceRecord = {
				...sampleRecord,
				provenance: {
					...sampleRecord.provenance,
					resources: [{ identity: { type: 'view', id: 'v2' }, revision: 'r1' }],
				},
			}
			expect(isCompleteEvidenceForViewRevision(mismatched, 'v1', 'r1')).toBe(false)
		})
	})
})
