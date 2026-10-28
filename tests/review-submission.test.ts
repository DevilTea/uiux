import { describe, expect, it } from 'vitest'
import type { FormalEvidenceRecord } from '../src/domain/evidence/schema'
import { flowTraceEntersView, flowTraceFreshness, type CitableEvidenceEntry } from '../app/utils/readiness'
import { EVIDENCE_KIND_BY_CHANGE_DOMAIN, isSubmittable, preselectedCitations, submissionBody, withUsableSelection } from '../app/utils/review-submission'
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
		entry('interaction_replay', 'sha256:passes', { freshness: { state: 'fresh' } }, { data: { assertions: [{ result: 'pass' }] } }),
		entry('interaction_replay', 'sha256:fails', { freshness: { state: 'fresh' } }, { data: { assertions: [{ result: 'pass' }, { result: 'fail' }] } }),
		entry('interaction_replay', 'sha256:passes-stale', { freshness: { state: 'stale', reason: 'viewChanged' } }, { data: { assertions: [{ result: 'pass' }] } }),
		entry('interaction_replay', 'sha256:passes-unknown', { freshness: { state: 'unknown', reason: 'noProductKit' } }, { data: { assertions: [{ result: 'pass' }] } }),
	]

	it('maps i18n to checks_run, flow to flow_trace and interaction to interaction_replay, and nothing else', () => {
		expect(EVIDENCE_KIND_BY_CHANGE_DOMAIN).toEqual({ i18n: 'checks_run', flow: 'flow_trace', interaction: 'interaction_replay' })
		expect(preselectedCitations('spec', entries)).toEqual([])
		expect(preselectedCitations('ir', entries)).toEqual([])
	})

	it('picks the latest Run Checks record, the current Flow traces and the passing replays that are current, each declared with its kind', () => {
		expect(preselectedCitations('i18n', entries)).toEqual([{ kind: 'checks_run', evidence: 'sha256:newest' }])
		expect(preselectedCitations('flow', entries)).toEqual([{ kind: 'flow_trace', evidence: 'sha256:fresh' }])
		expect(preselectedCitations('interaction', entries)).toEqual([{ kind: 'interaction_replay', evidence: 'sha256:passes' }])
		expect(preselectedCitations('i18n', [])).toEqual([])
	})

	it('does not preselect a replay that is stale or of unknown freshness, nor one without a freshness, but leaves it in the list', () => {
		expect(preselectedCitations('interaction', entries.filter(item => item.digest !== 'sha256:passes'))).toEqual([])
		expect(preselectedCitations('interaction', [entry('interaction_replay', 'sha256:no-freshness', {}, { data: { assertions: [{ result: 'pass' }] } })])).toEqual([])
	})
})

describe('Flow trace freshness in the picker (shown, never refused)', () => {
	const VIEW = '11111111-1111-4111-8111-111111111111'
	const FLOW = '22222222-2222-4222-8222-222222222222'
	const STEP = '33333333-3333-4333-8333-333333333333'
	const captureDigest = `sha256:${'c'.repeat(64)}`
	const trace = (flowInputDigest: string) => flowTraceRecord({ flowId: FLOW, flowRevision: 'r_recorded', flowInputDigest, stepId: STEP, viewId: VIEW }, captureDigest) as unknown as FormalEvidenceRecord
	const context = (flows: readonly { key: string; flowInputDigest: string }[], captures = new Map<string, FormalEvidenceRecord>()) => ({ allViews: [], flows, captures })

	it('is stale when the Flow changed or is gone, the trace records no Flow input digest, or a referenced capture is missing', () => {
		expect(flowTraceFreshness(trace('d_old'), context([{ key: FLOW, flowInputDigest: 'd_new' }]))).toEqual({ state: 'stale', reason: 'flowChanged' })
		expect(flowTraceFreshness(trace('d_new'), context([]))).toEqual({ state: 'stale', reason: 'flowMissing' })
		expect(flowTraceFreshness(flowTraceRecord({ flowId: FLOW, flowRevision: 'r', stepId: STEP, viewId: VIEW }, captureDigest) as unknown as FormalEvidenceRecord, context([{ key: FLOW, flowInputDigest: 'd_new' }]))).toEqual({ state: 'stale', reason: 'noFlowRevision' })
		expect(flowTraceFreshness(trace('d_new'), context([{ key: FLOW, flowInputDigest: 'd_new' }]))).toEqual({ state: 'stale', reason: 'traceCaptureMissing' })
	})

	it('is fresh when the Flow has the recorded input digest and no referenced capture is stale', () => {
		const withoutCaptures = { ...trace('d_new'), evidenceRefs: [] } as FormalEvidenceRecord
		expect(flowTraceFreshness(withoutCaptures, context([{ key: FLOW, flowInputDigest: 'd_new' }]))).toEqual({ state: 'fresh' })
	})

	it('is offered for a View only when a step of its Flow enters that View', () => {
		expect(flowTraceEntersView(trace('d_new'), VIEW)).toBe(true)
		expect(flowTraceEntersView(trace('d_new'), '99999999-9999-4999-8999-999999999999')).toBe(false)
		expect(flowTraceEntersView({ ...trace('r_new'), data: undefined } as unknown as FormalEvidenceRecord, VIEW)).toBe(false)
	})
})

describe('Select current and Clear in the picker', () => {
	it('add or remove the usable captures only, and keep the ticks of every other kind', () => {
		const ticked = ['sha256:checks', 'sha256:trace', 'sha256:replay']
		expect(withUsableSelection(ticked, ['sha256:a', 'sha256:b'], true)).toEqual([...ticked, 'sha256:a', 'sha256:b'])
		expect(withUsableSelection([...ticked, 'sha256:a', 'sha256:b'], ['sha256:a', 'sha256:b'], false)).toEqual(ticked)
		expect(withUsableSelection(['sha256:a'], ['sha256:a', 'sha256:b'], true)).toEqual(['sha256:a', 'sha256:b'])
		expect(withUsableSelection([], ['sha256:a'], false)).toEqual([])
	})
})
