import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import {
	evaluateEvidenceStaleness,
	isCompleteEvidenceForRenderInput,
	RENDER_INPUT_CHANGED_REASON,
	RENDER_INPUT_DIGEST_MISSING_REASON,
	VIEW_PROVENANCE_MISSING_REASON,
} from '../src/domain/evidence/staleness'

/** A View as stored: render input (`ir`, `variants`) plus the members outside it. */
const view = {
	id: 'v1',
	name: 'Counter',
	feature: 'billing',
	ir: { id: 'root', type: 'RootShell', slots: { default: [{ id: 'title', type: 'Text', props: { text: 'Hello' } }] } },
	variants: { Empty: { state: { count: 0 } } },
	spec: { intent: 'Count things.' },
}
const DIGEST = renderInputDigest(view)

describe('render-input digest (Clause 01a14e30-2d4a-7ce9-ad68-58db56f36f47)', () => {
	it('is sha256 over the canonical JSON { ir, variants } of the View', () => {
		// Sorted keys at every level, no whitespace, one trailing newline.
		const canonical = '{"ir":{"id":"root","slots":{"default":[{"id":"title","props":{"text":"Hello"},"type":"Text"}]},"type":"RootShell"},"variants":{"Empty":{"state":{"count":0}}}}\n'
		expect(DIGEST).toBe(`sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`)
		expect(DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/)
	})

	it('ignores key order and every member outside the IR and the Variants', () => {
		const reordered = { spec: { intent: 'Something else.' }, variants: view.variants, name: 'Renamed', ir: { type: 'RootShell', slots: view.ir.slots, id: 'root' }, id: 'v1' }
		expect(renderInputDigest(reordered)).toBe(DIGEST)
		expect(renderInputDigest({ ...view, feature: undefined })).toBe(DIGEST)
	})

	it('changes with the IR or a Variant', () => {
		expect(renderInputDigest({ ...view, ir: { ...view.ir, slots: { default: [] } } })).not.toBe(DIGEST)
		expect(renderInputDigest({ ...view, variants: { Empty: { state: { count: 1 } } } })).not.toBe(DIGEST)
		expect(renderInputDigest({ ...view, variants: {} })).not.toBe(DIGEST)
	})
})

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
			renderInputDigest: DIGEST,
		},
		artifactRefs: ['sha256:' + 'a'.repeat(64)],
		data: { format: 'png', width: 1280, height: 800 },
	}
	const workspace = {
		resource: {
			i18n: { defaultLocale: 'en-US' },
			viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
		},
	}

	it('is fresh when the View render-input digest matches, whatever the other Views are', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', renderInputDigest: DIGEST },
				{ key: 'v2', renderInputDigest: 'sha256:' + 'b'.repeat(64) },
			],
			workspace,
			discoveredLocales: ['en-US'],
		})
		expect(result.isStale).toBe(false)
	})

	// Rule 01a115cd-c749-…: a Spec-only or metadata edit changes the View revision but not its digest.
	it('stays fresh after a Spec-only or metadata edit of its View', () => {
		const edited = { ...view, name: 'Renamed counter', feature: 'growth', spec: { intent: 'Count more things.' } }
		const result = evaluateEvidenceStaleness(sampleRecord, { allViews: [{ key: 'v1', renderInputDigest: renderInputDigest(edited) }], workspace })
		expect(result).toEqual({ isStale: false })
	})

	// Rule 01a115cd-c5a5-…
	it('is stale once the View IR or a Variant changed', () => {
		for (const changed of [{ ...view, ir: { ...view.ir, props: { title: 'New' } } }, { ...view, variants: { Empty: { state: { count: 2 } } } }]) {
			const result = evaluateEvidenceStaleness(sampleRecord, { allViews: [{ key: 'v1', renderInputDigest: renderInputDigest(changed) }], workspace })
			expect(result).toEqual({ isStale: true, reason: RENDER_INPUT_CHANGED_REASON })
		}
	})

	// Rule 01a115cd-c53c-…
	it('is stale when the capture records no render-input digest, even if nothing changed', () => {
		const { renderInputDigest: _omitted, ...provenance } = sampleRecord.provenance
		void _omitted
		const legacy: FormalEvidenceRecord = { ...sampleRecord, provenance }
		const result = evaluateEvidenceStaleness(legacy, { allViews: [{ key: 'v1', renderInputDigest: DIGEST }], workspace })
		expect(result).toEqual({ isStale: true, reason: RENDER_INPUT_DIGEST_MISSING_REASON })
	})

	it('is stale when the capture records no View revision', () => {
		const noView: FormalEvidenceRecord = { ...sampleRecord, provenance: { ...sampleRecord.provenance, resources: [] } }
		expect(evaluateEvidenceStaleness(noView, { allViews: [{ key: 'v1', renderInputDigest: DIGEST }], workspace })).toEqual({ isStale: true, reason: VIEW_PROVENANCE_MISSING_REASON })
	})

	it('returns isStale=true when view no longer exists in allViews', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'other-view', renderInputDigest: DIGEST },
			],
			workspace,
		})

		expect(result.isStale).toBe(true)
		expect(result.reason).toContain('View no longer exists')
	})

	it('returns isStale=true when viewport preset was removed', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [
				{ key: 'v1', renderInputDigest: DIGEST },
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
				{ key: 'v1', renderInputDigest: DIGEST },
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

	it('returns isStale=true when the resolved viewport dimensions change under the same preset id', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [{ key: 'v1', renderInputDigest: DIGEST }],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { desktop: { dimensions: { width: 1440, height: 900 } } },
				},
			},
		})
		expect(result).toMatchObject({ isStale: true })
		expect(result.reason).toContain('dimensions changed')
	})

	it('returns isStale=true when the captured theme id is removed', () => {
		const result = evaluateEvidenceStaleness(sampleRecord, {
			allViews: [{ key: 'v1', renderInputDigest: DIGEST }],
			workspace: {
				resource: {
					i18n: { defaultLocale: 'en-US' },
					viewports: { desktop: { dimensions: { width: 1280, height: 800 } } },
					themes: { dark: {} },
				},
			},
		})
		expect(result).toMatchObject({ isStale: true })
		expect(result.reason).toContain("Theme 'light' was removed")
	})

	it('returns isStale=true when the captured locale resource revision changes', () => {
		const localizedRecord: FormalEvidenceRecord = {
			...sampleRecord,
			provenance: {
				...sampleRecord.provenance,
				resources: [
					...sampleRecord.provenance.resources,
					{ identity: { type: 'locale', id: 'en-US' }, revision: 'locale-r1' },
				],
			},
		}
		const result = evaluateEvidenceStaleness(localizedRecord, {
			allViews: [{ key: 'v1', renderInputDigest: DIGEST }],
			workspace,
			discoveredLocales: ['en-US'],
			localeRevisions: { 'en-US': 'locale-r2' },
		})
		expect(result).toMatchObject({ isStale: true })
		expect(result.reason).toContain('revision has changed')
	})

	describe('review evidence matching (Rule 01a11544-558b-…)', () => {
		it('accepts only complete evidence for the View current render-input digest', () => {
			expect(isCompleteEvidenceForRenderInput(sampleRecord, 'v1', DIGEST)).toBe(true)
			expect(isCompleteEvidenceForRenderInput(sampleRecord, 'v1', renderInputDigest({ ...view, variants: {} }))).toBe(false)
			expect(isCompleteEvidenceForRenderInput(sampleRecord, 'v2', DIGEST)).toBe(false)
		})

		it('accepts a capture taken before a Spec-only edit', () => {
			expect(isCompleteEvidenceForRenderInput(sampleRecord, 'v1', renderInputDigest({ ...view, spec: { intent: 'Changed.' }, name: 'New' }))).toBe(true)
		})

		it('rejects a capture without a render-input digest', () => {
			const { renderInputDigest: _omitted, ...provenance } = sampleRecord.provenance
			void _omitted
			expect(isCompleteEvidenceForRenderInput({ ...sampleRecord, provenance }, 'v1', DIGEST)).toBe(false)
		})

		it('rejects incomplete formal evidence even when View identity and digest match', () => {
			const incomplete: FormalEvidenceRecord = {
				...sampleRecord,
				coverage: { complete: false },
			}
			expect(isCompleteEvidenceForRenderInput(incomplete, 'v1', DIGEST)).toBe(false)
		})

		it('requires provenance for the same View named by the execution context', () => {
			const mismatched: FormalEvidenceRecord = {
				...sampleRecord,
				provenance: {
					...sampleRecord.provenance,
					resources: [{ identity: { type: 'view', id: 'v2' }, revision: 'r1' }],
				},
			}
			expect(isCompleteEvidenceForRenderInput(mismatched, 'v1', DIGEST)).toBe(false)
		})
	})
})
