import { describe, expect, it } from 'vitest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { flowTraceFreshness, type CitableEvidenceEntry } from '../app/utils/readiness'
import { EVIDENCE_KIND_BY_CHANGE_DOMAIN, isSubmittable, preselectedCitations, submissionBody } from '../app/utils/review-submission'
import { flowTraceRecord } from './support/evidence-record'

const capture = (digest: string) => ({ kind: 'formal_capture', evidence: digest })

describe('human Submit for review (R12)', () => {
	const view = { key: '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1', revision: 'r_abc' }

	it('needs a change domain and a piece of Evidence', () => {
		expect(isSubmittable({ changeDomains: [], evidence: [capture('sha256:1')] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['  '], evidence: [capture('sha256:1')] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['spec'], evidence: [] })).toBe(false)
		expect(isSubmittable({ changeDomains: ['spec'], evidence: [capture('sha256:1')] })).toBe(true)
	})

	it('names the anchored View at its current revision and references Evidence', () => {
		expect(submissionBody({ changeDomains: [' spec', 'spec', 'i18n'], evidence: [capture('sha256:1'), capture('sha256:1')], reason: '  check the copy ' }, view, 'r_thread')).toEqual({
			expectedRevision: 'r_thread',
			changeDomains: ['spec', 'i18n'],
			resources: [{ identity: { kind: 'view', key: view.key }, revision: 'r_abc' }],
			evidenceRefs: [{ kind: 'formal_capture', evidence: 'sha256:1' }],
			reason: 'check the copy',
		})
	})

	it('declares each cited record as the kind it has, so a Run Checks record is not sent as a capture (Rule 01a11544-55b0-…)', () => {
		const body = submissionBody({
			changeDomains: ['i18n', 'flow', 'interaction'],
			evidence: [{ kind: 'checks_run', evidence: 'sha256:c' }, { kind: 'flow_trace', evidence: 'sha256:f' }, { kind: 'interaction_replay', evidence: 'sha256:i' }, capture('sha256:p')],
		}, view, 'r_t')
		expect(body.evidenceRefs).toEqual([
			{ kind: 'checks_run', evidence: 'sha256:c' },
			{ kind: 'flow_trace', evidence: 'sha256:f' },
			{ kind: 'interaction_replay', evidence: 'sha256:i' },
			{ kind: 'formal_capture', evidence: 'sha256:p' },
		])
	})

	it('omits an empty note', () => {
		expect(submissionBody({ changeDomains: ['ir'], evidence: [capture('sha256:2')], reason: '  ' }, view, 'r_t')).not.toHaveProperty('reason')
	})
})

describe('the Evidence a change domain preselects (owner ruling 6 of Discussion #241)', () => {
	const entry = (kind: CitableEvidenceEntry['kind'], digest: string, extra: Partial<CitableEvidenceEntry> = {}, record: Record<string, unknown> = {}): CitableEvidenceEntry => ({
		kind,
		digest,
		record: { schemaVersion: 1, kind, executionContext: {}, coverage: { complete: true }, provenance: { workspaceSchemaVersion: 6, resources: [], versions: {} }, artifactRefs: [], ...record } as FormalEvidenceRecord,
		...extra,
	})
	const entries = [
		entry('checks_run', 'sha256:newest'),
		entry('checks_run', 'sha256:older'),
		entry('flow_trace', 'sha256:fresh', { freshness: { state: 'fresh' } }),
		entry('flow_trace', 'sha256:stale', { freshness: { state: 'stale', reason: 'flowChanged' } }),
		entry('interaction_replay', 'sha256:passes', {}, { data: { assertions: [{ result: 'pass' }] } }),
		entry('interaction_replay', 'sha256:fails', {}, { data: { assertions: [{ result: 'pass' }, { result: 'fail' }] } }),
	]

	it('maps i18n to checks_run, flow to flow_trace and interaction to interaction_replay, and nothing else', () => {
		expect(EVIDENCE_KIND_BY_CHANGE_DOMAIN).toEqual({ i18n: 'checks_run', flow: 'flow_trace', interaction: 'interaction_replay' })
		expect(preselectedCitations('spec', entries)).toEqual([])
		expect(preselectedCitations('ir', entries)).toEqual([])
	})

	it('picks the latest Run Checks record, the current Flow traces and the passing replays, each declared with its kind', () => {
		expect(preselectedCitations('i18n', entries)).toEqual([{ kind: 'checks_run', evidence: 'sha256:newest' }])
		expect(preselectedCitations('flow', entries)).toEqual([{ kind: 'flow_trace', evidence: 'sha256:fresh' }])
		expect(preselectedCitations('interaction', entries)).toEqual([{ kind: 'interaction_replay', evidence: 'sha256:passes' }])
		expect(preselectedCitations('i18n', [])).toEqual([])
	})
})

describe('Flow trace freshness in the picker (shown, never refused)', () => {
	const VIEW = '11111111-1111-4111-8111-111111111111'
	const FLOW = '22222222-2222-4222-8222-222222222222'
	const STEP = '33333333-3333-4333-8333-333333333333'
	const captureDigest = `sha256:${'c'.repeat(64)}`
	const trace = (flowRevision: string) => flowTraceRecord({ flowId: FLOW, flowRevision, stepId: STEP, viewId: VIEW }, captureDigest) as unknown as FormalEvidenceRecord
	const context = (flows: readonly { key: string; revision: string }[], captures = new Map<string, FormalEvidenceRecord>()) => ({ allViews: [], flows, captures })

	it('is stale when the Flow changed or is gone, or a referenced capture is missing', () => {
		expect(flowTraceFreshness(trace('r_old'), context([{ key: FLOW, revision: 'r_new' }]))).toEqual({ state: 'stale', reason: 'flowChanged' })
		expect(flowTraceFreshness(trace('r_new'), context([]))).toEqual({ state: 'stale', reason: 'flowMissing' })
		expect(flowTraceFreshness(trace('r_new'), context([{ key: FLOW, revision: 'r_new' }]))).toEqual({ state: 'stale', reason: 'traceCaptureMissing' })
	})

	it('is fresh when the Flow has the recorded revision and no referenced capture is stale', () => {
		const withoutCaptures = { ...trace('r_new'), evidenceRefs: [] } as FormalEvidenceRecord
		expect(flowTraceFreshness(withoutCaptures, context([{ key: FLOW, revision: 'r_new' }]))).toEqual({ state: 'fresh' })
	})
})
