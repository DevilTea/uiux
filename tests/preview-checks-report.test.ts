import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import {
	CHECKS_REPORTS_FEATURE,
	MAX_CHECKS_REPORT_LENGTH,
	MAX_CHECKS_RUNTIME_ERRORS,
	MAX_CHECKS_TRANSLATION_WARNINGS,
	MAX_CHECKS_UNEVALUATED,
	validateChecksReportMessage,
	type ChecksReportMessage,
} from '../src/preview/protocol/checks-report'
import { declaredRuntimeFeatures } from '../src/preview/declared-features'
import { buildChecksReportBody, ChecksReportPublisher, displaySafe, MaxWaitDebouncer } from '../src/preview/checks-report-builder'
import { PreviewChecksReports } from '../src/preview/checks-reports'
import type { ChecksObservation } from '../src/preview/checks-observer'

/**
 * `checks.report` (issue #347; owner ruling 1 of 2026-10-26, Discussion #241): the decoder and its
 * bounds (Clauses 01a17619-89fc-7a94-b690-2e65c6a99f39 and 01a17619-ab3f-797d-ae93-4038a48ee31f), the
 * bridges' gates, the Workbench's replacement by `sequence` and dropping of a stale context, and
 * what the runtime reports from what it observed.
 */

const VIEW_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_VIEW_ID = '22222222-2222-4222-8222-222222222222'
const WITH_CHECKS = { protocolVersion: 1, features: ['geometry', CHECKS_REPORTS_FEATURE] } as const
const WITHOUT_CHECKS = { protocolVersion: 1, features: ['geometry'] } as const
const compatible = { ok: true } as const

const missingTranslation = { code: 'missing-translation', key: 'cta.label', requestedLocale: 'ja-JP', fallbackLocale: 'en-US' } as const

const report = (overrides: { context?: Record<string, unknown>; payload?: Record<string, unknown> } = {}) => ({
	type: 'checks.report',
	context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, runtimeContextVersion: 0, ...overrides.context },
	payload: {
		sequence: 0,
		translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }],
		runtimeErrors: [],
		...overrides.payload,
	},
})
const decoded = (input: unknown): ChecksReportMessage => {
	const result = validateChecksReportMessage(input)
	if (!result.ok) throw new Error(`not decoded: ${result.diagnostics.map(d => d.code).join(', ')}`)
	return result.value
}
const issues = (input: unknown) => {
	const result = validateChecksReportMessage(input)
	return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}

function collector(messages: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send(message) { messages.push(message) } }
}

/** A Workbench bridge with generation-a open, and the runtime bridge that declared it. */
function openGeneration(payload: typeof WITH_CHECKS | typeof WITHOUT_CHECKS = WITH_CHECKS) {
	const workbenchOutbound: PreviewWireMessage[] = []
	const runtimeOutbound: PreviewWireMessage[] = []
	const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
	const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', payload, collector(runtimeOutbound))
	expect(workbench.receive(runtime.declareCapabilities()).status).toBe('ack-dispatched')
	expect(runtime.receive(workbenchOutbound[0])).toMatchObject({ status: 'accepted' })
	return { workbench, runtime, workbenchOutbound, runtimeOutbound }
}

describe('checks.report decoder', () => {
	it('decodes a report to its known members and ignores additive ones', () => {
		const input = report({
			payload: { runtimeErrors: [{ reason: 'runtime.property_failed', detail: 'labelResult: failed', widgetId: 'button-1', extra: 1 }], extra: true },
			context: { variantId: 'Loading' },
		})
		const message = decoded({ ...input, extraTop: 1 })
		expect(message).toEqual({
			type: 'checks.report',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, variantId: 'Loading', runtimeContextVersion: 0 },
			payload: {
				sequence: 0,
				translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }],
				runtimeErrors: [{ reason: 'runtime.property_failed', detail: 'labelResult: failed', widgetId: 'button-1' }],
			},
		})
	})

	it('requires the context identities and keeps shared context free of payload identities', () => {
		for (const key of ['previewSessionId', 'runtimeGenerationId', 'viewId', 'runtimeContextVersion']) {
			const input = report()
			delete (input.context as Record<string, unknown>)[key]
			expect(issues(input)).toContain('protocol.missing_context_identity')
		}
		expect(issues(report({ context: { sequence: 1 } }))).toContain('protocol.identity_in_wrong_envelope')
		expect(issues(report({ context: { widgetId: 'button-1' } }))).toContain('protocol.inapplicable_context_identity')
		expect(issues(report({ context: { variantId: null } }))).toContain('protocol.null_optional_field')
		expect(issues(report({ context: { viewId: 'not-a-uuid' } }))).not.toEqual([])
		expect(issues(report({ context: { runtimeContextVersion: -1 } }))).toContain('protocol.invalid_sequence')
		expect(issues(report({ payload: { sequence: 1.5 } }))).toContain('protocol.invalid_sequence')
	})

	it('reuses the I18nWarning shape for a warning and bounds its text', () => {
		const warning = (value: unknown) => report({ payload: { translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: value }] } })
		expect(issues(warning({ code: 'missing-parameter', key: 'greeting', requestedLocale: 'en-US', parameter: 'name' }))).toEqual([])
		expect(issues(warning({ code: 'unresolved-key', key: 'x', requestedLocale: 'en-US' }))).toEqual([])
		expect(issues(warning({ code: 'unknown', key: 'x', requestedLocale: 'en-US' }))).toContain('i18n.unknown_warning_code')
		expect(issues(warning({ code: 'missing-translation', key: 'x', requestedLocale: 'en-US' }))).toContain('i18n.invalid_fallback_locale')
		expect(issues(warning({ ...missingTranslation, key: 'k'.repeat(501) }))).toContain('protocol.unsafe_text')
		expect(issues(warning({ ...missingTranslation, key: 'a\u0000b' }))).toContain('protocol.unsafe_text')
		expect(issues(report({ payload: { translationWarnings: [{ widgetId: '', resultProperty: 'labelResult', warning: missingTranslation }] } }))).toContain('schema.empty_string')
	})

	it('bounds a runtime error as failure.report does: a runtime reason code and display-safe detail of at most 500 characters', () => {
		const errors = (...entries: Record<string, unknown>[]) => report({ payload: { runtimeErrors: entries } })
		expect(issues(errors({ reason: 'runtime.view_load_failed', detail: 'x'.repeat(500) }))).toEqual([])
		expect(issues(errors({ reason: 'runtime.view_load_failed', detail: 'x'.repeat(501) }))).toContain('protocol.unsafe_failure_detail')
		expect(issues(errors({ reason: 'runtime.view_load_failed', detail: 'a\u0007b' }))).toContain('protocol.unsafe_failure_detail')
		expect(issues(errors({ reason: 'protocol.invalid_message' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(errors({ reason: 'runtime.Bad Code' }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(errors({ reason: `runtime.${'a'.repeat(100)}` }))).toContain('protocol.failure_reason_not_reportable')
		expect(issues(errors({ detail: 'no reason' }))).not.toEqual([])
	})

	it('caps the two lists', () => {
		const warnings = (count: number) => Array.from({ length: count }, (_, index) => ({ widgetId: `w${index}`, resultProperty: 'labelResult', warning: missingTranslation }))
		const errors = (count: number) => Array.from({ length: count }, (_, index) => ({ reason: 'runtime.property_failed', widgetId: `w${index}` }))
		expect(issues(report({ payload: { translationWarnings: warnings(MAX_CHECKS_TRANSLATION_WARNINGS) } }))).toEqual([])
		expect(issues(report({ payload: { translationWarnings: warnings(MAX_CHECKS_TRANSLATION_WARNINGS + 1) } }))).toContain('protocol.too_many_translation_warnings')
		expect(issues(report({ payload: { runtimeErrors: errors(MAX_CHECKS_RUNTIME_ERRORS) } }))).toEqual([])
		expect(issues(report({ payload: { runtimeErrors: errors(MAX_CHECKS_RUNTIME_ERRORS + 1) } }))).toContain('protocol.too_many_runtime_errors')
	})

	describe('coverage (issue #95; owner ruling 5 of Discussion #241, 2026-10-26)', () => {
		const entry = (index = 0) => ({ widgetId: `w${index}`, resultProperty: 'labelResult', catalogField: 'label', reason: 'The Property was not evaluated.' })
		const coverage = (value: unknown) => report({ payload: { coverage: value } })

		it('is optional: a report without it decodes without one, never as complete', () => {
			expect(decoded(report()).payload.coverage).toBeUndefined()
			expect('coverage' in decoded(report()).payload).toBe(false)
		})

		it('decodes the unevaluated Properties of an incomplete coverage, and drops additive members', () => {
			const message = decoded(coverage({ complete: false, unevaluated: [{ ...entry(1), extra: 1 }, entry(2)], extra: true }))
			expect(message.payload.coverage).toEqual({ complete: false, unevaluated: [entry(1), entry(2)] })
			expect(decoded(coverage({ complete: true, unevaluated: [] })).payload.coverage).toEqual({ complete: true, unevaluated: [] })
		})

		it('requires complete to agree with the list: complete lists nothing, incomplete lists at least one', () => {
			expect(issues(coverage({ complete: true, unevaluated: [entry()] }))).toContain('protocol.invalid_coverage')
			expect(issues(coverage({ complete: false, unevaluated: [] }))).toContain('protocol.invalid_coverage')
			expect(issues(coverage({ unevaluated: [] }))).toContain('protocol.invalid_coverage')
			expect(issues(coverage({ complete: 'yes', unevaluated: [] }))).toContain('protocol.invalid_coverage')
			expect(issues(coverage({ complete: true }))).not.toEqual([])
			expect(issues(coverage('complete'))).not.toEqual([])
			expect(issues(coverage(null))).not.toEqual([])
		})

		it('bounds each entry as the other report text and caps the list', () => {
			for (const key of ['widgetId', 'resultProperty', 'catalogField', 'reason']) {
				const missing = { ...entry() } as Record<string, unknown>
				delete missing[key]
				expect(issues(coverage({ complete: false, unevaluated: [missing] }))).not.toEqual([])
				expect(issues(coverage({ complete: false, unevaluated: [{ ...entry(), [key]: 'x'.repeat(501) }] }))).toContain('protocol.unsafe_text')
				expect(issues(coverage({ complete: false, unevaluated: [{ ...entry(), [key]: 'a\u0000b' }] }))).toContain('protocol.unsafe_text')
			}
			const many = (count: number) => Array.from({ length: count }, (_, index) => entry(index))
			expect(issues(coverage({ complete: false, unevaluated: many(MAX_CHECKS_UNEVALUATED) }))).toEqual([])
			expect(issues(coverage({ complete: false, unevaluated: many(MAX_CHECKS_UNEVALUATED + 1) }))).toContain('protocol.too_many_unevaluated')
		})

		it('belongs in the payload, never in shared context', () => {
			expect(issues(report({ context: { coverage: { complete: true, unevaluated: [] } } }))).toContain('protocol.identity_in_wrong_envelope')
		})
	})

	it('bounds the session, generation and Variant identities and the size of the whole report', () => {
		expect(issues(report({ context: { previewSessionId: 's'.repeat(501) } }))).toContain('protocol.unsafe_text')
		expect(issues(report({ context: { runtimeGenerationId: 'g\u0000' } }))).toContain('protocol.unsafe_text')
		expect(issues(report({ context: { variantId: 'v'.repeat(501) } }))).toContain('protocol.unsafe_text')
		expect(issues(report({ context: { variantId: 'v'.repeat(500) } }))).toEqual([])
		// 500 warnings of maximal text fit no report: the decoder refuses the total, not only the parts.
		const long = (index: number) => ({ widgetId: 'w'.repeat(500) + index, resultProperty: 'p'.repeat(500), warning: { code: 'missing-parameter', key: 'k'.repeat(500), requestedLocale: 'en-US', parameter: 'a'.repeat(500) } })
		const huge = report({ payload: { translationWarnings: Array.from({ length: 500 }, (_, index) => long(index)) } })
		expect(JSON.stringify(huge).length).toBeGreaterThan(MAX_CHECKS_REPORT_LENGTH)
		expect(issues(huge)).toContain('protocol.report_too_large')
	})

	it('decodes only checks.report', () => {
		expect(issues({ ...report(), type: 'failure.report' })).toContain('protocol.unknown_message_type')
	})
})

describe('bridges: checks.report traffic', () => {
	it('sends nothing before the capability ACK and only when the generation declared checks.reports', () => {
		const messages: PreviewWireMessage[] = []
		const early = new RuntimePreviewProtocolBridge('session-a', 'generation-a', WITH_CHECKS, collector(messages))
		expect(early.sendChecksReport(decoded(report()))).toEqual({ status: 'gated' })
		expect(messages).toEqual([])

		const { runtime, runtimeOutbound } = openGeneration(WITHOUT_CHECKS)
		expect(runtime.sendChecksReport(decoded(report()))).toEqual({ status: 'not-permitted' })
		expect(runtimeOutbound.filter(message => message.type === 'checks.report')).toEqual([])
	})

	it('sends a report whose sequence is higher than the last sent one, and no other', () => {
		const { runtime, runtimeOutbound } = openGeneration()
		expect(runtime.sendChecksReport(decoded(report({ payload: { sequence: 3 } })))).toEqual({ status: 'sent' })
		expect(runtime.sendChecksReport(decoded(report({ payload: { sequence: 3 } })))).toEqual({ status: 'not-permitted' })
		expect(runtime.sendChecksReport(decoded(report({ payload: { sequence: 2 } })))).toEqual({ status: 'not-permitted' })
		expect(runtime.sendChecksReport(decoded(report({ payload: { sequence: 4 } })))).toEqual({ status: 'sent' })
		expect(runtimeOutbound.filter(message => message.type === 'checks.report')).toHaveLength(2)
		expect(runtime.sendChecksReport(decoded(report({ context: { runtimeGenerationId: 'generation-b' }, payload: { sequence: 9 } })))).toEqual({ status: 'stale-generation' })
		expect(runtime.sendChecksReport({ ...decoded(report()), payload: { sequence: -1, translationWarnings: [], runtimeErrors: [] } }).status).toBe('invalid')
	})

	it('has the Workbench accept a report only of the current acknowledged generation that declared the feature', () => {
		const { workbench } = openGeneration()
		expect(workbench.receive(report())).toMatchObject({ status: 'accepted', message: { type: 'checks.report' } })
		// Another session or generation is stale traffic.
		expect(workbench.receive(report({ context: { previewSessionId: 'session-z' } }))).toEqual({ status: 'stale-session' })
		expect(workbench.receive(report({ context: { runtimeGenerationId: 'generation-z' } }))).toEqual({ status: 'stale-generation' })
		// An undecodable report of the current generation is invalid, never accepted.
		expect(workbench.receive(report({ payload: { sequence: -1 } })).status).toBe('invalid')
	})

	it('drops a report of a retired generation and of one that did not declare checks.reports', () => {
		const declared = openGeneration()
		declared.workbench.retireGeneration()
		expect(declared.workbench.receive(report())).toEqual({ status: 'stale-generation' })

		const undeclared = openGeneration(WITHOUT_CHECKS)
		expect(undeclared.workbench.receive(report())).toMatchObject({ status: 'invalid', diagnostics: [{ code: 'protocol.feature_not_declared' }] })
	})

	it('gates a report before the generation is acknowledged', () => {
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), () => compatible)
		// The Workbench has admitted no generation, so a report of one is stale, never accepted.
		expect(workbench.receive(report()).status).not.toBe('accepted')
	})

	it('is runtime to Workbench only', () => {
		const { runtime } = openGeneration()
		expect(runtime.receive(report())).toEqual({ status: 'wrong-direction' })
	})
})

describe('Workbench state: the held report', () => {
	const rendering = { runtimeGenerationId: 'generation-a', viewId: VIEW_ID, locale: 'ja-JP' }
	const message = (overrides: { context?: Record<string, unknown>; payload?: Record<string, unknown> } = {}) => decoded(report(overrides))

	it('replaces the held report as a whole by a higher sequence and drops one that is not higher', () => {
		const state = new PreviewChecksReports()
		expect(state.accept(message({ payload: { sequence: 0 } }), rendering)).toEqual({ status: 'accepted' })
		expect(state.current()?.translationWarnings).toHaveLength(1)

		// The next report is complete, not a delta: its empty lists leave nothing of the previous one.
		expect(state.accept(message({ payload: { sequence: 1, translationWarnings: [], runtimeErrors: [{ reason: 'runtime.adapter_invalid' }] } }), rendering)).toEqual({ status: 'accepted' })
		expect(state.current()).toMatchObject({ sequence: 1, translationWarnings: [], runtimeErrors: [{ reason: 'runtime.adapter_invalid' }] })

		expect(state.accept(message({ payload: { sequence: 1 } }), rendering)).toEqual({ status: 'stale-sequence' })
		expect(state.accept(message({ payload: { sequence: 0 } }), rendering)).toEqual({ status: 'stale-sequence' })
		expect(state.current()?.sequence).toBe(1)
	})

	it('drops a report of another View, Variant or generation, or of an earlier runtime context', () => {
		const state = new PreviewChecksReports()
		expect(state.accept(message({ context: { viewId: OTHER_VIEW_ID } }), rendering)).toEqual({ status: 'stale-context' })
		expect(state.accept(message({ context: { variantId: 'Loading' } }), rendering)).toEqual({ status: 'stale-context' })
		expect(state.accept(message({ context: { runtimeGenerationId: 'generation-b' } }), rendering)).toEqual({ status: 'stale-context' })
		expect(state.accept(message(), { ...rendering, variantId: 'Loading' })).toEqual({ status: 'stale-context' })
		expect(state.current()).toBeUndefined()

		expect(state.accept(message({ context: { runtimeContextVersion: 4 }, payload: { sequence: 5 } }), rendering)).toEqual({ status: 'accepted' })
		expect(state.accept(message({ context: { runtimeContextVersion: 3 }, payload: { sequence: 6 } }), rendering)).toEqual({ status: 'stale-context' })
		expect(state.current()?.runtimeContextVersion).toBe(4)
	})

	it('replaces the report of the previous Variant when the Workbench switches and the runtime reports the new one', () => {
		const state = new PreviewChecksReports()
		const base = { ...rendering }
		state.accept(message({ payload: { sequence: 0 } }), base)
		// The Workbench switched Variant: what was held is of the previous context and is gone at once.
		state.clear()
		expect(state.current()).toBeUndefined()
		// The report that was in flight for the base state is dropped against the Variant now rendered.
		expect(state.accept(message({ payload: { sequence: 1 } }), { ...base, variantId: 'Loading' })).toEqual({ status: 'stale-context' })
		// The runtime's report of the Variant replaces it, and is not mistaken for the earlier one.
		expect(state.accept(message({ context: { variantId: 'Loading', runtimeContextVersion: 1 }, payload: { sequence: 2, translationWarnings: [] } }), { ...base, variantId: 'Loading' })).toEqual({ status: 'accepted' })
		expect(state.current()).toMatchObject({ variantId: 'Loading', translationWarnings: [] })
		// The floors survive a clear: the report that was in flight cannot come back as current.
		state.clear()
		expect(state.accept(message({ context: { runtimeContextVersion: 1 }, payload: { sequence: 1 } }), base)).toEqual({ status: 'stale-sequence' })
	})

	it('keeps only the warnings of the Locale the Workbench renders', () => {
		const state = new PreviewChecksReports()
		const other = { widgetId: 'button-2', resultProperty: 'labelResult', warning: { ...missingTranslation, requestedLocale: 'zh-TW' } }
		const own = { widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }
		state.accept(message({ payload: { translationWarnings: [other, own] } }), rendering)
		expect(state.current()?.translationWarnings.map(entry => entry.widgetId)).toEqual(['button-1'])
	})

	it('holds the coverage of the latest report, and replaces it with the report', () => {
		const state = new PreviewChecksReports()
		const unevaluated = [{ widgetId: 'button-1', resultProperty: 'labelResult', catalogField: 'label', reason: 'The Property was not evaluated.' }]
		state.accept(message({ payload: { sequence: 0, coverage: { complete: false, unevaluated } } }), rendering)
		expect(state.current()?.coverage).toEqual({ complete: false, unevaluated })
		state.accept(message({ payload: { sequence: 1, coverage: { complete: true, unevaluated: [] } } }), rendering)
		expect(state.current()?.coverage).toEqual({ complete: true, unevaluated: [] })
		// A report that makes no claim holds none: the earlier one is not carried over.
		state.accept(message({ payload: { sequence: 2 } }), rendering)
		expect(state.current()?.coverage).toBeUndefined()
	})

	it('starts over with a new generation', () => {
		const state = new PreviewChecksReports()
		state.accept(message({ payload: { sequence: 7 } }), rendering)
		state.reset()
		expect(state.current()).toBeUndefined()
		expect(state.accept(message({ context: { runtimeGenerationId: 'generation-b' }, payload: { sequence: 0 } }), { ...rendering, runtimeGenerationId: 'generation-b' })).toEqual({ status: 'accepted' })
	})
})

describe('what the runtime reports', () => {
	const observation = (overrides: Partial<ChecksObservation> = {}): ChecksObservation => ({ context: 1, translationWarnings: [], propertyErrors: [], ...overrides })

	it('reports the warnings of evaluated Properties and the errors of failed ones, and no other', () => {
		const body = buildChecksReportBody({
			observation: observation({
				translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }],
				propertyErrors: [{ widgetId: 'text-1', property: 'textResult', detail: 'The compute threw.' }],
			}),
		})
		expect(body).toEqual({
			translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }],
			runtimeErrors: [{ reason: 'runtime.property_failed', widgetId: 'text-1', detail: 'textResult: The compute threw.' }],
		})
		// A Preview with nothing evaluated and nothing failed reports empty lists, never a made-up entry.
		expect(buildChecksReportBody({ materialization: { status: 'ready' }, observation: observation() })).toEqual({ translationWarnings: [], runtimeErrors: [] })
	})

	describe('coverage', () => {
		const unevaluatedEntry = (index: number) => ({ widgetId: `w${index}`, resultProperty: 'labelResult', catalogField: 'label', reason: 'The Property was not evaluated.' })

		it('says nothing without an observation of a mounted Runtime', () => {
			expect(buildChecksReportBody({ loadError: 'x' }).coverage).toBeUndefined()
			expect(buildChecksReportBody({ materialization: { status: 'ready' }, observation: observation() }).coverage).toBeUndefined()
		})

		it('is complete when the Runtime left no declared Property unevaluated, and incomplete with the list when it did', () => {
			expect(buildChecksReportBody({ observation: observation({ unevaluated: [] }) }).coverage).toEqual({ complete: true, unevaluated: [] })
			const body = buildChecksReportBody({ observation: observation({ unevaluated: [unevaluatedEntry(1), unevaluatedEntry(2)] }) })
			expect(body.coverage).toEqual({ complete: false, unevaluated: [unevaluatedEntry(1), unevaluatedEntry(2)] })
			// It decodes, and the Workbench receives it unchanged.
			expect(decoded({ ...report(), payload: { sequence: 0, ...body } }).payload.coverage).toEqual(body.coverage)
		})

		it('caps the list, keeps the coverage incomplete and says it cut it', () => {
			const entries = Array.from({ length: MAX_CHECKS_UNEVALUATED + 7 }, (_, index) => unevaluatedEntry(index))
			const body = buildChecksReportBody({ observation: observation({ unevaluated: entries }) })
			expect(body.coverage?.complete).toBe(false)
			expect(body.coverage?.unevaluated).toHaveLength(MAX_CHECKS_UNEVALUATED)
			expect(body.runtimeErrors.at(-1)).toMatchObject({ reason: 'runtime.report_truncated', detail: '7 unevaluated Properties were left out.' })
			expect(issues({ ...report(), payload: { sequence: 0, ...body } })).toEqual([])
		})

		it('keeps a report of maximal entries within the size bound', () => {
			const long = (index: number) => ({ widgetId: 'w'.repeat(497) + String(index).padStart(3, '0'), resultProperty: 'p'.repeat(500), catalogField: 'c'.repeat(500), reason: 'r'.repeat(600) })
			const warnings = Array.from({ length: 500 }, (_, index) => ({ widgetId: 'w'.repeat(497) + String(index).padStart(3, '0'), resultProperty: 'p'.repeat(500), warning: { code: 'missing-parameter', key: 'k'.repeat(500), requestedLocale: 'en-US', parameter: 'a'.repeat(500) } as const }))
			const body = buildChecksReportBody({ observation: observation({ translationWarnings: warnings, unevaluated: Array.from({ length: 500 }, (_, index) => long(index)) }) })
			expect(body.coverage?.complete).toBe(false)
			expect(body.coverage!.unevaluated.length).toBeGreaterThan(0)
			expect(issues({ ...report(), payload: { sequence: 0, ...body } })).toEqual([])
		})

		it('makes a changed coverage a new report, and an unchanged one a repeat', () => {
			const sent: ChecksReportMessage[] = []
			const publisher = new ChecksReportPublisher((message) => { sent.push(message); return 'sent' })
			const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, runtimeContextVersion: 1 }
			const base = { translationWarnings: [], runtimeErrors: [] }
			expect(publisher.publish(context, { ...base, coverage: { complete: false, unevaluated: [unevaluatedEntry(1)] } })).toBe('sent')
			expect(publisher.publish(context, { ...base, coverage: { complete: false, unevaluated: [unevaluatedEntry(1)] } })).toBe('unchanged')
			expect(publisher.publish(context, { ...base, coverage: { complete: true, unevaluated: [] } })).toBe('sent')
			expect(sent.map(message => message.payload.coverage?.complete)).toEqual([false, true])
			expect(sent.every(message => validateChecksReportMessage(message).ok)).toBe(true)
		})
	})

	it('reports View and Adapter load errors as runtime errors', () => {
		const body = buildChecksReportBody({
			loadError: 'The View could not be read.',
			materialization: { status: 'invalid', diagnostics: [{ code: 'adapter.bundle_invalid', path: '/adapters', message: 'No mount.' }] },
		})
		expect(body.runtimeErrors).toEqual([
			{ reason: 'runtime.view_load_failed', detail: 'The View could not be read.' },
			{ reason: 'runtime.adapter_invalid', detail: 'adapter.bundle_invalid /adapters: No mount.' },
		])
		expect(buildChecksReportBody({ materialization: { status: 'adapter_unavailable', diagnostics: [{ code: 'adapter.materialization_unavailable', path: '/adapters', message: 'Unsupported: [Hero].' }] } }).runtimeErrors[0]?.reason).toBe('runtime.adapter_unavailable')
		expect(buildChecksReportBody({ materialization: { status: 'blocked', diagnostics: [{ code: 'i18n.missing_default_locale', path: '/i18n', message: 'No file.' }] } }).runtimeErrors[0]?.reason).toBe('runtime.preview_blocked')
	})

	it('keeps every report within the decoder bounds and says when it cut one', () => {
		const warnings = Array.from({ length: MAX_CHECKS_TRANSLATION_WARNINGS + 25 }, (_, index) => ({ widgetId: `w${index}`, resultProperty: 'labelResult', warning: missingTranslation }))
		const errors = Array.from({ length: MAX_CHECKS_RUNTIME_ERRORS + 10 }, (_, index) => ({ widgetId: `e${index}`, property: 'p', detail: 'x'.repeat(2000) }))
		const body = buildChecksReportBody({ observation: observation({ translationWarnings: warnings, propertyErrors: errors }) })
		expect(body.translationWarnings).toHaveLength(MAX_CHECKS_TRANSLATION_WARNINGS)
		expect(body.runtimeErrors).toHaveLength(MAX_CHECKS_RUNTIME_ERRORS)
		expect(body.runtimeErrors.at(-1)).toMatchObject({ reason: 'runtime.report_truncated' })
		// The whole report decodes.
		expect(issues({ ...report(), payload: { sequence: 0, ...body } })).toEqual([])
	})

	it('leaves out an entry the decoder would refuse instead of failing the whole report', () => {
		const body = buildChecksReportBody({
			observation: observation({ translationWarnings: [
				{ widgetId: 'ok', resultProperty: 'labelResult', warning: missingTranslation },
				{ widgetId: 'bad', resultProperty: 'labelResult', warning: { ...missingTranslation, key: 'k'.repeat(600) } },
			] }),
		})
		expect(body.translationWarnings.map(entry => entry.widgetId)).toEqual(['ok'])
		expect(displaySafe('a\u0000b')).toBe('a b')
		expect(displaySafe('x'.repeat(600))).toHaveLength(500)
	})

	it('keeps a report of maximal warnings within the size bound and says it was cut', () => {
		const entry = (index: number) => ({ widgetId: 'w'.repeat(497) + String(index).padStart(3, '0'), resultProperty: 'p'.repeat(500), warning: { code: 'missing-parameter', key: 'k'.repeat(500), requestedLocale: 'en-US', parameter: 'a'.repeat(500) } as const })
		const body = buildChecksReportBody({ observation: observation({ translationWarnings: Array.from({ length: 500 }, (_, index) => entry(index)) }) })
		expect(body.translationWarnings.length).toBeLessThan(500)
		expect(body.runtimeErrors.at(-1)).toMatchObject({ reason: 'runtime.report_truncated' })
		expect(issues({ ...report(), payload: { sequence: 0, ...body } })).toEqual([])
	})

	it('carries runtime.report_truncated over the wire to the Workbench', () => {
		const { workbench, runtime } = openGeneration()
		const warnings = Array.from({ length: MAX_CHECKS_TRANSLATION_WARNINGS + 5 }, (_, index) => ({ widgetId: `w${index}`, resultProperty: 'labelResult', warning: missingTranslation }))
		const body = buildChecksReportBody({ observation: observation({ translationWarnings: warnings }) })
		const message = decoded({ ...report(), payload: { sequence: 0, ...body } })
		expect(runtime.sendChecksReport(message)).toEqual({ status: 'sent' })
		const received = workbench.receive(message)
		expect(received).toMatchObject({ status: 'accepted' })
		const accepted = (received as { message: ChecksReportMessage }).message
		expect(accepted.payload.translationWarnings).toHaveLength(MAX_CHECKS_TRANSLATION_WARNINGS)
		expect(accepted.payload.runtimeErrors).toEqual([{ reason: 'runtime.report_truncated', detail: '5 translation warnings were left out.' }])
	})

	it('numbers the reports, sends a changed one and leaves a repeated one unsent', () => {
		const sent: ChecksReportMessage[] = []
		let accept = false
		const publisher = new ChecksReportPublisher((message) => {
			if (!accept) return 'unsent'
			sent.push(message)
			return 'sent'
		})
		const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID, runtimeContextVersion: 1 }
		const empty = { translationWarnings: [], runtimeErrors: [] }
		const withWarning = { translationWarnings: [{ widgetId: 'button-1', resultProperty: 'labelResult', warning: missingTranslation }], runtimeErrors: [] }

		// Gated until the ACK: nothing is numbered, and the same report is offered again.
		expect(publisher.publish(context, empty)).toBe('unsent')
		accept = true
		expect(publisher.publish(context, empty)).toBe('sent')
		expect(publisher.publish(context, empty)).toBe('unchanged')
		expect(publisher.publish(context, withWarning)).toBe('sent')
		// A new context reports again even when it says the same, so the Workbench learns it finished.
		expect(publisher.publish({ ...context, variantId: 'Loading', runtimeContextVersion: 2 }, withWarning)).toBe('sent')
		expect(sent.map(message => message.payload.sequence)).toEqual([0, 1, 2])
		expect(sent[2]!.context).toMatchObject({ variantId: 'Loading', runtimeContextVersion: 2 })
		expect(sent.every(message => validateChecksReportMessage(message).ok)).toBe(true)
	})
})

describe('the runtime declares checks.reports in a Workbench Preview only', () => {
	it('declares it for a Workbench Preview, and not for the formal capture harness or a version frame', () => {
		expect(declaredRuntimeFeatures({ harness: false, version: false })).toContain(CHECKS_REPORTS_FEATURE)
		expect(declaredRuntimeFeatures({ harness: true, version: false })).not.toContain(CHECKS_REPORTS_FEATURE)
		expect(declaredRuntimeFeatures({ harness: false, version: true })).not.toContain(CHECKS_REPORTS_FEATURE)
	})
})

describe('reporting cannot be starved by continuous recomputation', () => {
	it('runs a trailing debounce after the delay, and at the latest after the longest wait', () => {
		let now = 0
		const timers = new Map<number, { at: number; callback: () => void }>()
		let next = 0
		const clock = {
			now: () => now,
			set: (callback: () => void, ms: number) => { timers.set(++next, { at: now + ms, callback }); return next },
			clear: (handle: unknown) => { timers.delete(handle as number) },
		}
		const advance = (to: number) => {
			while (true) {
				const due = [...timers.entries()].filter(([, timer]) => timer.at <= to).sort((a, b) => a[1].at - b[1].at)[0]
				if (!due) break
				timers.delete(due[0])
				now = due[1].at
				due[1].callback()
			}
			now = to
		}
		const runs: number[] = []
		const debouncer = new MaxWaitDebouncer(() => runs.push(now), 100, 1000, clock)
		// A change every 50 ms never lets the 100 ms delay elapse, yet the report goes out by 1000 ms.
		for (let at = 0; at <= 2500; at += 50) {
			advance(at)
			debouncer.schedule()
		}
		expect(runs[0]).toBe(1000)
		expect(runs.length).toBeGreaterThanOrEqual(2)
		// Quiet after a change: it runs one delay later.
		advance(10_000)
		const before = runs.length
		debouncer.schedule()
		advance(10_099)
		expect(runs.length).toBe(before)
		advance(10_100)
		expect(runs.length).toBe(before + 1)
		debouncer.schedule()
		debouncer.cancel()
		advance(20_000)
		expect(runs.length).toBe(before + 1)
	})
})
