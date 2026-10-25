import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import {
	FAILURE_REPORTS_FEATURE,
	failureReportDiagnostic,
	failureReportScope,
	validateFailureReportMessage,
	type FailureReportMessage,
} from '../src/preview/protocol/failure-report'

/**
 * `failure.report` (issue #312): the decoder (Clauses 01a11a59-dd69-78ed-9181-d8beb5f4cb7b and
 * 01a11a70-4261-7155-8aed-28bed7a89064), the Workbench bridge's generation-scoped effect (Clause
 * 01a11a59-def9-797a-8d08-5e4b02ecd900 and Rule 01a11a59-eecb-7aff-983b-972148c714e1) and the
 * runtime bridge's once-only limits.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const WITH_REPORTS = { protocolVersion: 1, features: ['geometry', FAILURE_REPORTS_FEATURE] } as const
const WITHOUT_REPORTS = { protocolVersion: 1, features: ['geometry'] } as const
const compatible = { ok: true } as const

const generationReport = (generation = 'generation-a', overrides: Record<string, unknown> = {}) => ({
	type: 'failure.report',
	context: { previewSessionId: 'session-a', runtimeGenerationId: generation },
	payload: { category: 'runtime', reason: 'runtime.unavailable', ...overrides },
})
const workContext = { viewId: VIEW_ID, widgetId: 'widget-a', geometryRevision: 3 }
const workReport = (overrides: Record<string, unknown> = {}) => ({
	type: 'failure.report',
	context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', ...workContext },
	payload: { category: 'runtime', reason: 'runtime.unavailable', sequence: 7, ...overrides },
})
const declare = (generation: string, payload: object = WITH_REPORTS) => ({
	type: 'capability.declare',
	context: { previewSessionId: 'session-a', runtimeGenerationId: generation },
	payload,
})
const issues = (input: unknown) => {
	const result = validateFailureReportMessage(input)
	return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}

function collector(messages: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send(message) { messages.push(message) } }
}

/** A Workbench bridge with generation-a open, and the runtime bridge that declared it. */
function openGeneration(payload: typeof WITH_REPORTS | typeof WITHOUT_REPORTS = WITH_REPORTS) {
	const workbenchOutbound: PreviewWireMessage[] = []
	const runtimeOutbound: PreviewWireMessage[] = []
	const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
	const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', payload, collector(runtimeOutbound))
	expect(workbench.receive(runtime.declareCapabilities()).status).toBe('ack-dispatched')
	expect(runtime.receive(workbenchOutbound[0])).toMatchObject({ status: 'accepted' })
	return { workbench, runtime, workbenchOutbound, runtimeOutbound }
}

describe('failure.report decoder', () => {
	it('decodes a generation-scoped report to its known members and reads its scope from the context alone', () => {
		const result = validateFailureReportMessage({ ...generationReport('generation-a', { detail: 'worker stopped', extra: 1 }), extraTop: true })
		expect(result.ok).toBe(true)
		const message = (result as { value: FailureReportMessage }).value
		expect(message).toEqual({
			type: 'failure.report',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
			payload: { category: 'runtime', reason: 'runtime.unavailable', detail: 'worker stopped' },
		})
		expect(failureReportScope(message)).toBe('generation')
		expect(failureReportDiagnostic(message)).toEqual({
			category: 'runtime',
			reason: 'runtime.unavailable',
			detail: 'worker stopped',
			correlation: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
		})
	})

	it('decodes a work-scoped report with its contour-work identities, including a partial one\'s base version', () => {
		const result = validateFailureReportMessage(workReport({ baseSnapshotVersion: 2 }))
		expect(result.ok).toBe(true)
		const message = (result as { value: FailureReportMessage }).value
		expect(failureReportScope(message)).toBe('work')
		expect(failureReportDiagnostic(message).correlation).toEqual({
			previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', ...workContext, sequence: 7, baseSnapshotVersion: 2,
		})
	})

	it('admits only the categories and reasons a runtime may report', () => {
		expect(issues(generationReport('generation-a', { category: 'transport', reason: 'transport.channel_unavailable' }))).toContain('protocol.invalid_failure_category')
		expect(issues(generationReport('generation-a', { category: 'capability', reason: 'capability.missing_required_feature' }))).toContain('protocol.invalid_failure_category')
		expect(issues(generationReport('generation-a', { category: 'protocol', reason: 'protocol.identity_reuse' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(generationReport('generation-a', { category: 'protocol', reason: 'protocol.capability_conflict' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(generationReport('generation-a', { category: 'runtime', reason: 'protocol.invalid_state' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(generationReport('generation-a', { category: 'runtime', reason: 'runtime.Bad Code' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(generationReport('generation-a', { category: 'protocol', reason: 'protocol.invalid_message' }))).toEqual([])
		expect(issues(generationReport('generation-a', { category: 'protocol', reason: 'protocol.invalid_state' }))).toEqual([])
		// The registry only grows: a runtime reason the Workbench does not know yet still decodes.
		expect(issues(generationReport('generation-a', { reason: 'runtime.worker_crashed' }))).toEqual([])
	})

	it('bounds the detail and rejects control characters, so it can be shown as text', () => {
		expect(issues(generationReport('generation-a', { detail: 'x'.repeat(500) }))).toEqual([])
		expect(issues(generationReport('generation-a', { detail: 'x'.repeat(501) }))).toContain('protocol.unsafe_failure_detail')
		expect(issues(generationReport('generation-a', { detail: 'line\u0000break' }))).toContain('protocol.unsafe_failure_detail')
		expect(issues(generationReport('generation-a', { detail: 42 }))).toContain('schema.expected_string')
	})

	it('requires the session and generation, and keeps payload identities and nulls out of the context', () => {
		expect(issues({ type: 'failure.report', context: { runtimeGenerationId: 'g' }, payload: generationReport().payload })).toContain('protocol.missing_context_identity')
		expect(issues({ type: 'failure.report', context: { previewSessionId: 's' }, payload: generationReport().payload })).toContain('protocol.missing_context_identity')
		const misplaced = { ...generationReport(), context: { ...generationReport().context, sequence: 1 } }
		expect(issues(misplaced)).toContain('protocol.identity_in_wrong_envelope')
		const nulled = { ...generationReport(), context: { ...generationReport().context, widgetId: null } }
		expect(issues(nulled)).toContain('protocol.null_optional_field')
		expect(issues({ ...generationReport(), type: 'geometry.acquire.response' })).toContain('protocol.unknown_message_type')
	})

	it('takes a context naming only part of a contour work, or a work-less sequence, for neither scope', () => {
		const partial = { ...generationReport(), context: { ...generationReport().context, viewId: VIEW_ID } }
		expect(issues(partial)).toContain('protocol.incomplete_failure_scope')
		expect(issues(generationReport('generation-a', { sequence: 1 }))).toContain('protocol.incomplete_failure_scope')
		const noSequence = workReport()
		delete (noSequence.payload as Record<string, unknown>).sequence
		expect(issues(noSequence)).toContain('protocol.incomplete_failure_scope')
		expect(issues(workReport({ sequence: -1 }))).toContain('protocol.invalid_sequence')
	})
})

describe('Workbench bridge: a runtime-reported failure', () => {
	it('ends and retires the generation for a runtime report and starts no automatic recovery', () => {
		const { workbench } = openGeneration()
		const report = generationReport('generation-a', { detail: 'worker stopped' })
		const result = workbench.receive(report)
		expect(result).toMatchObject({ status: 'generation-failed', message: { payload: { category: 'runtime', reason: 'runtime.unavailable' } } })
		expect(workbench.snapshot().session).toMatchObject({
			retiredGenerationIds: ['generation-a'], recoveryNeeded: false, recoveryExhausted: true, automaticRecoveryUsed: false,
		})
		expect(workbench.snapshot().session.currentGenerationId).toBeUndefined()
		expect(workbench.beginAutomaticRecovery()).toBe('not-eligible')

		// Only an explicit retry admits the next generation; without one it is refused.
		expect(workbench.receive(declare('generation-b'))).toEqual({ status: 'generation-refused', generationId: 'generation-b' })
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.receive(declare('generation-c')).status).toBe('ack-dispatched')
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-c', recoveryExhausted: false })
	})

	it('makes the generation protocol-invalid for a protocol report, which leaves the one automatic recovery', () => {
		const { workbench } = openGeneration()
		const report = generationReport('generation-a', { category: 'protocol', reason: 'protocol.invalid_message' })
		expect(workbench.receive(report).status).toBe('generation-failed')
		expect(workbench.snapshot().session).toMatchObject({ recoveryNeeded: true, recoveryExhausted: false })
		expect(workbench.beginAutomaticRecovery()).toBe('started')
		expect(workbench.receive(declare('generation-b')).status).toBe('ack-dispatched')
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-b', currentGenerationPhase: 'open' })
	})

	it('drops a report of a retired or never-admitted generation, whatever its category (ablation target: the generation check)', () => {
		const { workbench } = openGeneration()
		// A runtime report of a generation the Workbench never admitted is stale traffic.
		expect(workbench.receive(generationReport('generation-z'))).toEqual({ status: 'stale-generation' })
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-a', currentGenerationPhase: 'open', recoveryExhausted: false })

		// Replace the generation: the first one is retired, and its late report changes nothing.
		workbench.retireGeneration()
		expect(workbench.receive(declare('generation-b')).status).toBe('ack-dispatched')
		expect(workbench.receive(generationReport('generation-a', { category: 'protocol', reason: 'protocol.invalid_message' }))).toEqual({ status: 'stale-generation' })
		expect(workbench.receive(generationReport('generation-a'))).toEqual({ status: 'stale-generation' })
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-b', currentGenerationPhase: 'open', recoveryNeeded: false, recoveryExhausted: false })
		// Another session is stale as well.
		expect(workbench.receive({ ...generationReport('generation-b'), context: { previewSessionId: 'session-x', runtimeGenerationId: 'generation-b' } })).toEqual({ status: 'stale-session' })
	})

	it('gates a report until the generation is acknowledged, and one from a generation that never declared the feature is invalid', () => {
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), () => compatible)
		// Not declared yet: no generation is current, so the report is stale; with the declaration pending it is gated.
		expect(workbench.receive(generationReport())).toEqual({ status: 'stale-generation' })
		const awaitingAck = new WorkbenchPreviewProtocolBridge('session-a', { send() { throw new Error('ack transport failed') } }, () => compatible)
		expect(() => awaitingAck.receive(declare('generation-a'))).toThrow()
		expect(awaitingAck.receive(generationReport())).toEqual({ status: 'gated' })

		const open = openGeneration(WITHOUT_REPORTS)
		const result = open.workbench.receive(generationReport())
		expect(result).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'protocol.feature_not_declared' }] })
		expect(open.workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-a', currentGenerationPhase: 'open' })
	})

	it('rejects a report of a category a runtime may not report, leaving the generation open', () => {
		const { workbench } = openGeneration()
		const result = workbench.receive(generationReport('generation-a', { category: 'transport', reason: 'transport.channel_unavailable' }))
		expect(result.status).toBe('invalid')
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-a', currentGenerationPhase: 'open' })
	})

	it('accepts a work-scoped report without ending its generation', () => {
		const { workbench } = openGeneration()
		const result = workbench.receive(workReport())
		expect(result).toMatchObject({ status: 'accepted', message: { type: 'failure.report' } })
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-a', currentGenerationPhase: 'open', recoveryExhausted: false })
	})

	it('treats a retry\'s generation that reports a runtime failure as a failed retry needing another', () => {
		const { workbench } = openGeneration()
		workbench.receive(generationReport())
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.receive(declare('generation-b')).status).toBe('ack-dispatched')
		expect(workbench.receive(generationReport('generation-b')).status).toBe('generation-failed')
		expect(workbench.snapshot().session).toMatchObject({ recoveryExhausted: true, retryAuthorizationPending: false })
		expect(workbench.receive(declare('generation-c'))).toEqual({ status: 'generation-refused', generationId: 'generation-c' })
	})
})

describe('Runtime bridge: sending failure.report', () => {
	it('sends a generation-scoped report once, as the generation\'s last envelope', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		const report = generationReport() as FailureReportMessage
		expect(runtime.sendFailureReport(report)).toEqual({ status: 'sent' })
		expect(runtimeOutbound.at(-1)).toMatchObject({ type: 'failure.report' })
		const count = runtimeOutbound.length
		expect(runtime.sendFailureReport(report)).toEqual({ status: 'gated' })
		expect(runtime.sendTargeting({ type: 'targeting.escape', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID }, payload: { targetingInteractionId: 'i-1' } })).toEqual({ status: 'gated' })
		expect(runtimeOutbound).toHaveLength(count)
	})

	it('sends nothing before the ACK, and only when the generation declared failure.reports', () => {
		const out: PreviewWireMessage[] = []
		const early = new RuntimePreviewProtocolBridge('session-a', 'generation-a', WITH_REPORTS, collector(out))
		expect(early.sendFailureReport(generationReport() as FailureReportMessage)).toEqual({ status: 'gated' })
		expect(out).toEqual([])

		const { runtime, runtimeOutbound } = openGeneration(WITHOUT_REPORTS)
		const count = runtimeOutbound.length
		expect(runtime.sendFailureReport(generationReport() as FailureReportMessage)).toEqual({ status: 'not-permitted' })
		expect(runtimeOutbound).toHaveLength(count)
	})

	it('never sends another generation\'s report or a category a runtime may not report', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		const count = runtimeOutbound.length
		expect(runtime.sendFailureReport(generationReport('generation-z') as FailureReportMessage)).toEqual({ status: 'stale-generation' })
		expect(runtime.sendFailureReport(generationReport('generation-a', { category: 'capability', reason: 'capability.missing_required_feature' }) as FailureReportMessage).status).toBe('invalid')
		expect(runtimeOutbound).toHaveLength(count)
	})

	it('sends one work-scoped report per sequence and keeps the generation sending', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		expect(runtime.sendFailureReport(workReport() as FailureReportMessage)).toEqual({ status: 'sent' })
		expect(runtime.sendFailureReport(workReport() as FailureReportMessage)).toEqual({ status: 'not-permitted' })
		expect(runtime.sendFailureReport(workReport({ sequence: 8 }) as FailureReportMessage)).toEqual({ status: 'sent' })
		expect(runtimeOutbound.filter(message => message.type === 'failure.report')).toHaveLength(2)
		// The generation is still alive: its own report can follow.
		expect(runtime.sendFailureReport(generationReport() as FailureReportMessage)).toEqual({ status: 'sent' })
	})

	it('reports an undecodable envelope of its own generation by diagnostic codes only, never stale traffic', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		const malformed = { type: 'geometry.acquire.request', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID }, payload: { secret: 'token-123' } }
		const result = runtime.receive(malformed)
		expect(result.status).toBe('invalid')
		if (result.status !== 'invalid') return
		expect(runtime.reportInvalidTraffic(malformed, result.diagnostics)).toEqual({ status: 'sent' })
		const sent = runtimeOutbound.at(-1) as FailureReportMessage
		expect(sent).toMatchObject({ type: 'failure.report', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }, payload: { category: 'protocol', reason: 'protocol.invalid_message' } })
		expect(failureReportScope(sent)).toBe('generation')
		expect(sent.payload.detail).toContain('protocol.missing_context_identity')
		expect(JSON.stringify(sent)).not.toContain('token-123')

		// A second violation adds nothing: at most one generation-scoped report.
		const count = runtimeOutbound.length
		expect(runtime.reportInvalidTraffic(malformed, result.diagnostics)).toEqual({ status: 'gated' })
		expect(runtimeOutbound).toHaveLength(count)
	})

	it('does not report an undecodable envelope that names another generation or session', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		const count = runtimeOutbound.length
		for (const context of [
			{ previewSessionId: 'session-a', runtimeGenerationId: 'generation-old' },
			{ previewSessionId: 'session-old', runtimeGenerationId: 'generation-a' },
			{ previewSessionId: 'session-a' },
		]) {
			const input = { type: 'geometry.acquire.request', context, payload: {} }
			const result = runtime.receive(input)
			expect(runtime.reportInvalidTraffic(input, result.status === 'invalid' ? result.diagnostics : [])).toEqual({ status: 'not-permitted' })
		}
		expect(runtimeOutbound).toHaveLength(count)
	})

	it('never reports an unknown additive message type of its own generation, which is dropped without effect', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		const count = runtimeOutbound.length
		const unknown = { type: 'geometry.reveal', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, widgetId: 'widget-a' }, payload: {} }
		const result = runtime.receive(unknown)
		expect(result.status).toBe('invalid')
		expect(runtime.reportInvalidTraffic(unknown, result.status === 'invalid' ? result.diagnostics : [])).toEqual({ status: 'not-permitted' })
		expect(runtimeOutbound).toHaveLength(count)
		// The generation is still free to report a real violation afterwards.
		const malformed = { type: 'geometry.acquire.request', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID }, payload: {} }
		const bad = runtime.receive(malformed)
		expect(runtime.reportInvalidTraffic(malformed, bad.status === 'invalid' ? bad.diagnostics : [])).toEqual({ status: 'sent' })
	})

	it('caps the reason length of a runtime report', () => {
		expect(issues(generationReport('generation-a', { reason: `runtime.${'a'.repeat(92)}` }))).toEqual([])
		expect(issues(generationReport('generation-a', { reason: `runtime.${'a'.repeat(93)}` }))).toContain('protocol.failure_reason_not_reportable')
	})

	it('rejects a failure.report arriving at the runtime as traffic in the wrong direction', () => {
		const { runtime } = openGeneration()
		expect(runtime.receive(generationReport())).toEqual({ status: 'wrong-direction' })
	})
})
