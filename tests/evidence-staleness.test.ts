import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { adapterFreshnessContext, type EvidenceAdapterProvenance } from '../src/domain/evidence/adapter-provenance'
import { validateFormalEvidenceRecord, type FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { renderInputDigest } from '../src/domain/evidence/render-input-digest'
import {
	ADAPTER_CHANGED_REASON,
	ADAPTER_PROVENANCE_MISSING_REASON,
	ADAPTER_PROVENANCE_UNAVAILABLE_REASON,
	evaluateEvidenceStaleness,
	evaluateFlowTraceStaleness,
	FLOW_CHANGED_REASON,
	FLOW_PROVENANCE_MISSING_REASON,
	FLOW_REMOVED_REASON,
	FLOW_TRACE_CAPTURE_MISSING_REASON,
	FLOW_TRACE_FLOW_MISSING_REASON,
	isCompleteEvidenceForRenderInput,
	PRODUCT_KIT_PROVENANCE_MISSING_REASON,
	provenanceFreshness,
	unknownProvenanceFreshness,
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

describe('Adapter provenance in formal Evidence (issue #57)', () => {
	const counter: EvidenceAdapterProvenance = { moduleSpecifier: './adapters/counter.mjs', adapterId: 'counter', apiVersion: '1', contentDigest: `sha256:${'1'.repeat(64)}`, configDigest: `sha256:${'2'.repeat(64)}` }
	const badge: EvidenceAdapterProvenance = { moduleSpecifier: '@acme/badge', adapterId: 'badge', apiVersion: '1', packageVersion: '2.0.0' }
	const productKit = { dataDigest: `sha256:${'3'.repeat(64)}`, outputDigest: `sha256:${'4'.repeat(64)}`, sourceDigest: `sha256:${'5'.repeat(64)}`, designSystems: [] }
	const record = (provenance: Partial<FormalEvidenceRecord['provenance']>): FormalEvidenceRecord => ({
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: 'v1' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 1, resources: [{ identity: { type: 'view', id: 'v1' }, revision: 'r1' }], versions: { uiux: '0.1.0' }, renderInputDigest: DIGEST, ...provenance },
		artifactRefs: [],
	})
	const judged = (current: readonly EvidenceAdapterProvenance[]) => ({ allViews: [{ key: 'v1', renderInputDigest: DIGEST }], ...adapterFreshnessContext({ state: 'available', adapters: current }) })

	it('is fresh while the recorded Adapter provenance equals the current one, whatever its member order', () => {
		const reordered = { configDigest: counter.configDigest, contentDigest: counter.contentDigest, apiVersion: '1', adapterId: 'counter', moduleSpecifier: counter.moduleSpecifier }
		expect(evaluateEvidenceStaleness(record({ adapters: [counter, badge] }), judged([reordered, badge]))).toEqual({ isStale: false })
	})

	it('is stale once the active set differs in selection, order, content or configuration (Rule 01a115cd-c6de-…)', () => {
		const captured = record({ adapters: [counter, badge] })
		for (const current of [
			[counter],
			[counter, badge, { ...badge, adapterId: 'other', moduleSpecifier: '@acme/other' }],
			[badge, counter],
			[{ ...counter, contentDigest: `sha256:${'9'.repeat(64)}` }, badge],
			[counter, { ...badge, packageVersion: '2.0.1' }],
			[{ ...counter, configDigest: `sha256:${'8'.repeat(64)}` }, badge],
			[{ moduleSpecifier: counter.moduleSpecifier, adapterId: 'counter', apiVersion: '1', contentDigest: counter.contentDigest }, badge],
		]) expect(evaluateEvidenceStaleness(captured, judged(current)), JSON.stringify(current)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
	})

	it('has unknown freshness when the capture records no Adapter provenance or the current one is unavailable (Rule 01a1161b-ff68-…)', () => {
		expect(evaluateEvidenceStaleness(record({}), judged([]))).toEqual({ isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_MISSING_REASON })
		expect(evaluateEvidenceStaleness(record({ adapters: [] }), judged([]))).toEqual({ isStale: false })
		const unavailable = { allViews: [{ key: 'v1', renderInputDigest: DIGEST }], ...adapterFreshnessContext({ state: 'unavailable' }) }
		expect(evaluateEvidenceStaleness(record({ adapters: [counter] }), unavailable)).toEqual({ isStale: true, unknown: true, reason: ADAPTER_PROVENANCE_UNAVAILABLE_REASON })
	})

	it('reports a definite change before an unknown condition, yet still names the unknown one for Submit for review', () => {
		const captured = record({ adapters: [counter] })
		const context = { ...judged([badge]), productKit }
		expect(provenanceFreshness(captured, context)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
		expect(unknownProvenanceFreshness(captured, context)).toEqual({ isStale: true, unknown: true, reason: PRODUCT_KIT_PROVENANCE_MISSING_REASON })
		expect(unknownProvenanceFreshness(record({ adapters: [badge], productKit }), context)).toBeUndefined()
	})

	it('validates the recorded entries: the Handoff members without moduleIdentity, a package version or content digest, each Adapter once', () => {
		expect(validateFormalEvidenceRecord(record({ adapters: [counter, badge] })).ok).toBe(true)
		const codes = (adapters: unknown) => validateFormalEvidenceRecord(record({ adapters: adapters as never })).diagnostics.map(diagnostic => `${diagnostic.code} ${diagnostic.path}`)
		expect(codes([{ ...counter, moduleIdentity: 'file:///host/kit/adapters/counter.mjs' }])).toEqual(['schema.unknown_field /provenance/adapters/0/moduleIdentity'])
		expect(codes([{ moduleSpecifier: './a.mjs', adapterId: 'a', apiVersion: '1' }])).toEqual(['adapter.provenance_unverifiable /provenance/adapters/0'])
		expect(codes([counter, { ...counter }])).toEqual(['evidence.duplicate_adapter /provenance/adapters/1/adapterId'])
	})
})

// Rule 01a11544-6760-… and Clause 01a14e30-2e43-…: freshness of the Flow and interaction Evidence kinds.
describe('Flow and interaction Evidence freshness (issue #88)', () => {
	const FLOW = '22222222-2222-4222-8222-222222222222'
	const captureDigest = `sha256:${'c'.repeat(64)}`
	const otherDigest = `sha256:${'d'.repeat(64)}`
	const workspace = { resource: { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1280, height: 800 } } } } }
	const capture = (provenance: Partial<FormalEvidenceRecord['provenance']> = {}): FormalEvidenceRecord => ({
		schemaVersion: 1,
		kind: 'formal_capture',
		executionContext: { viewId: 'v1', locale: 'en-US', viewportId: 'desktop', viewport: { width: 1280, height: 800 }, themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 6, resources: [{ identity: { type: 'view', id: 'v1' }, revision: 'r1' }], versions: { uiux: '0.1.0' }, renderInputDigest: DIGEST, ...provenance },
		artifactRefs: [],
	})
	const trace = (patch: Partial<FormalEvidenceRecord> = {}): FormalEvidenceRecord => ({
		schemaVersion: 1,
		kind: 'flow_trace',
		executionContext: { flowId: FLOW, locale: 'en-US', viewportId: 'desktop', themeId: 'light' },
		coverage: { complete: true },
		provenance: { workspaceSchemaVersion: 6, resources: [{ identity: { type: 'flow', id: FLOW }, revision: 'f1' }], versions: { uiux: '0.1.0' } },
		artifactRefs: [],
		evidenceRefs: [{ kind: 'formal_capture', evidence: captureDigest }],
		...patch,
	})
	const judged = (overrides: Record<string, unknown> = {}) => ({
		allViews: [{ key: 'v1', renderInputDigest: DIGEST }],
		workspace,
		discoveredLocales: ['en-US'],
		flows: [{ key: FLOW, revision: 'f1' }],
		captures: new Map([[captureDigest, capture()]]),
		...overrides,
	})

	describe('flow_trace', () => {
		it('is fresh while its Flow has the recorded revision and every capture it references is fresh', () => {
			expect(evaluateFlowTraceStaleness(trace(), judged())).toEqual({ isStale: false })
		})

		it('is stale once its Flow changed or no longer exists, or the trace records no Flow', () => {
			expect(evaluateFlowTraceStaleness(trace(), judged({ flows: [{ key: FLOW, revision: 'f2' }] }))).toEqual({ isStale: true, reason: FLOW_CHANGED_REASON })
			expect(evaluateFlowTraceStaleness(trace(), judged({ flows: [] }))).toEqual({ isStale: true, reason: FLOW_REMOVED_REASON })
			expect(evaluateFlowTraceStaleness(trace({ provenance: { workspaceSchemaVersion: 6, resources: [], versions: { uiux: '0.1.0' } } }), judged())).toEqual({ isStale: true, reason: FLOW_PROVENANCE_MISSING_REASON })
			expect(evaluateFlowTraceStaleness(trace({ executionContext: {} }), judged())).toEqual({ isStale: true, reason: FLOW_TRACE_FLOW_MISSING_REASON })
		})

		it('is stale once a capture it references is stale (View render input) or missing', () => {
			const changed = renderInputDigest({ ...view, variants: { Empty: { state: { count: 9 } } } })
			expect(evaluateFlowTraceStaleness(trace(), judged({ allViews: [{ key: 'v1', renderInputDigest: changed }] }))).toEqual({ isStale: true, reason: `Capture ${captureDigest}: ${RENDER_INPUT_CHANGED_REASON}` })
			expect(evaluateFlowTraceStaleness(trace(), judged({ captures: new Map() }))).toEqual({ isStale: true, reason: FLOW_TRACE_CAPTURE_MISSING_REASON })
		})

		it('stays fresh after a Spec-only edit of a View it enters, since its captures do', () => {
			const edited = { ...view, spec: { intent: 'Another intent.' } }
			expect(evaluateFlowTraceStaleness(trace(), judged({ allViews: [{ key: 'v1', renderInputDigest: renderInputDigest(edited) }] }))).toEqual({ isStale: false })
		})

		it('has unknown freshness, not fresh, when a referenced capture records no Adapter provenance, and a definite stale outranks it', () => {
			const context = (captures: ReadonlyMap<string, FormalEvidenceRecord>) => ({ ...judged({ captures }), ...adapterFreshnessContext({ state: 'available', adapters: [] }) })
			const unknown = evaluateFlowTraceStaleness(trace(), context(new Map([[captureDigest, capture()]])))
			expect(unknown).toEqual({ isStale: true, unknown: true, reason: `Capture ${captureDigest}: ${ADAPTER_PROVENANCE_MISSING_REASON}` })
			const both = trace({ evidenceRefs: [{ kind: 'formal_capture', evidence: captureDigest }, { kind: 'formal_capture', evidence: otherDigest }] })
			const changed = capture({ renderInputDigest: renderInputDigest({ ...view, variants: {} }), adapters: [] })
			const mixed = evaluateFlowTraceStaleness(both, context(new Map([[captureDigest, capture()], [otherDigest, changed]])))
			expect(mixed).toEqual({ isStale: true, reason: `Capture ${otherDigest}: ${RENDER_INPUT_CHANGED_REASON}` })
		})
	})

	describe('interaction_replay', () => {
		// It copies the executionContext and provenance of the one capture it references (Clause 01a17762-b293-…).
		const replay = (provenance: Partial<FormalEvidenceRecord['provenance']> = {}): FormalEvidenceRecord => ({ ...capture(provenance), kind: 'interaction_replay' })

		it('is fresh and stale by the conditions of the capture it copies', () => {
			expect(evaluateEvidenceStaleness(replay(), { allViews: [{ key: 'v1', renderInputDigest: DIGEST }], workspace, discoveredLocales: ['en-US'] })).toEqual({ isStale: false })
			expect(evaluateEvidenceStaleness(replay(), { allViews: [{ key: 'v1', renderInputDigest: renderInputDigest({ ...view, ir: { ...view.ir, props: { title: 'New' } } }) }], workspace })).toEqual({ isStale: true, reason: RENDER_INPUT_CHANGED_REASON })
			expect(evaluateEvidenceStaleness(replay(), { allViews: [], workspace })).toEqual({ isStale: true, reason: 'View no longer exists' })
		})

		it('is stale once an Adapter changed since it was replayed, and unknown without Adapter provenance', () => {
			const counter: EvidenceAdapterProvenance = { moduleSpecifier: './adapters/counter.mjs', adapterId: 'counter', apiVersion: '1', contentDigest: `sha256:${'1'.repeat(64)}` }
			const current = { allViews: [{ key: 'v1', renderInputDigest: DIGEST }], ...adapterFreshnessContext({ state: 'available', adapters: [counter] }) }
			expect(evaluateEvidenceStaleness(replay({ adapters: [counter] }), current)).toEqual({ isStale: false })
			expect(evaluateEvidenceStaleness(replay({ adapters: [] }), current)).toEqual({ isStale: true, reason: ADAPTER_CHANGED_REASON })
			expect(evaluateEvidenceStaleness(replay(), current)).toMatchObject({ isStale: true, unknown: true })
		})
	})
})
