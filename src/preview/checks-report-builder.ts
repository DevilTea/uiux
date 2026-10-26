import type { Diagnostic } from '../domain/validation'
import type { ChecksObservation } from './checks-observer'
import {
	jsonLength,
	MAX_CHECKS_REPORT_LENGTH,
	MAX_CHECKS_RUNTIME_ERRORS,
	MAX_CHECKS_TEXT_LENGTH,
	MAX_CHECKS_TRANSLATION_WARNINGS,
	MAX_CHECKS_UNEVALUATED,
	type ChecksCoverage,
	type ChecksReportMessage,
	type ChecksRuntimeError,
	type ChecksTranslationWarning,
	type ChecksUnevaluated,
} from './protocol/checks-report'
import { containsProtocolControl } from './protocol/schema'

/**
 * The runtime side of `checks.report` (issue #347; Clauses 01a17619-89fc-7a94-b690-2e65c6a99f39 and
 * 01a17619-ab3f-797d-ae93-4038a48ee31f): what the Preview document reports from what it observed
 * and from what it failed to load, within the bounds the decoder admits.
 */

/** What the document knows about its View and Adapters, apart from what its Runtime evaluated. */
export type ChecksReportInput = Readonly<{
	/** The View, Locale or Asset read that failed, as the document shows it. */
	loadError?: string
	/** The materialization status the document shows. Every status but `ready` is an error: the View is not rendered. */
	materialization?: Readonly<{ status: string; diagnostics?: readonly Diagnostic[] }>
	/** What the mounted Runtime evaluated; absent while no Runtime is mounted. */
	observation?: ChecksObservation
}>

export type ChecksReportBody = Readonly<{
	translationWarnings: readonly ChecksTranslationWarning[]
	runtimeErrors: readonly ChecksRuntimeError[]
	/** Absent while no Runtime that can be inspected is mounted: the report then claims nothing about coverage. */
	coverage?: ChecksCoverage
}>

/** The characters of JSON the unevaluated list may take of a report, so the warnings keep the rest. */
const UNEVALUATED_BUDGET = 262_144

/** Display-safe text of at most `limit` characters: control characters become spaces, a longer text is cut with an ellipsis. */
export function displaySafe(value: string, limit = MAX_CHECKS_TEXT_LENGTH): string {
	const cleaned = containsProtocolControl(value) ? [...value].map(character => containsProtocolControl(character) ? ' ' : character).join('') : value
	return cleaned.length > limit ? `${cleaned.slice(0, limit - 1)}…` : cleaned
}

function admissible(value: string): boolean {
	return value.length > 0 && value.length <= MAX_CHECKS_TEXT_LENGTH && !containsProtocolControl(value)
}

function diagnosticDetail(diagnostic: Diagnostic): string {
	return displaySafe(`${diagnostic.code}${diagnostic.path ? ` ${diagnostic.path}` : ''}: ${diagnostic.message}`)
}

/**
 * The report's lists. The coverage lists what the Runtime declared and did not evaluate, and is
 * complete exactly when nothing is left; it is never obtained by forcing a Property to evaluate. The
 * warnings come only from Properties the Runtime evaluated; a warning whose
 * identity the decoder would refuse (an over-long key, say) is left out, and a list over its bound is
 * cut, which the report says with one `runtime.report_truncated` entry instead of failing as a whole.
 */
export function buildChecksReportBody(input: ChecksReportInput): ChecksReportBody {
	const errors: ChecksRuntimeError[] = []
	const seen = new Set<string>()
	const add = (error: ChecksRuntimeError): void => {
		const key = JSON.stringify([error.reason, error.widgetId ?? '', error.detail ?? ''])
		if (seen.has(key)) return
		seen.add(key)
		errors.push(error)
	}

	if (input.loadError) add({ reason: 'runtime.view_load_failed', detail: displaySafe(input.loadError) })
	const { materialization } = input
	if (materialization?.status === 'invalid') {
		for (const diagnostic of materialization.diagnostics ?? []) add({ reason: 'runtime.adapter_invalid', detail: diagnosticDetail(diagnostic) })
	}
	else if (materialization?.status === 'adapter_unavailable') {
		for (const diagnostic of materialization.diagnostics ?? []) add({ reason: 'runtime.adapter_unavailable', detail: diagnosticDetail(diagnostic) })
	}
	else if (materialization?.status === 'blocked') {
		for (const diagnostic of materialization.diagnostics ?? []) add({ reason: 'runtime.preview_blocked', detail: diagnosticDetail(diagnostic) })
	}
	for (const failure of input.observation?.propertyErrors ?? []) {
		if (!admissible(failure.widgetId)) continue
		add({ reason: 'runtime.property_failed', widgetId: failure.widgetId, detail: displaySafe(`${failure.property}: ${failure.detail}`) })
	}

	const warnings = (input.observation?.translationWarnings ?? []).filter((entry) => {
		const { warning } = entry
		return admissible(entry.widgetId) && admissible(entry.resultProperty) && admissible(warning.key)
			&& (warning.code !== 'missing-parameter' || admissible(warning.parameter))
	})

	// Identities are display-safe text the decoder admits; an entry cut by a bound still counts as not evaluated.
	const declaredUnevaluated = input.observation?.unevaluated
	let keptUnevaluated: readonly ChecksUnevaluated[] = []
	if (declaredUnevaluated) {
		const cleaned = declaredUnevaluated
			.filter(entry => entry.widgetId.length > 0 && entry.resultProperty.length > 0 && entry.catalogField.length > 0)
			.map(entry => ({
				widgetId: displaySafe(entry.widgetId),
				resultProperty: displaySafe(entry.resultProperty),
				catalogField: displaySafe(entry.catalogField),
				reason: displaySafe(entry.reason) || 'Not evaluated.',
			}))
		keptUnevaluated = cleaned.slice(0, MAX_CHECKS_UNEVALUATED)
		while (keptUnevaluated.length > 0 && jsonLength(keptUnevaluated) > UNEVALUATED_BUDGET) keptUnevaluated = keptUnevaluated.slice(0, Math.floor(keptUnevaluated.length * 0.9))
	}
	const unevaluatedLeftOut = declaredUnevaluated ? declaredUnevaluated.length - keptUnevaluated.length : 0

	// The whole report stays within its size bound: the errors and the coverage are bounded on their own, the warnings take the rest.
	const budget = MAX_CHECKS_REPORT_LENGTH - jsonLength(errors) - jsonLength(keptUnevaluated) - 4096
	let keptWarnings = warnings.slice(0, MAX_CHECKS_TRANSLATION_WARNINGS)
	while (keptWarnings.length > 0 && jsonLength(keptWarnings) > budget) keptWarnings = keptWarnings.slice(0, Math.floor(keptWarnings.length * 0.9))
	const warningsLeftOut = warnings.length - keptWarnings.length
	const keptErrors = [...errors]
	let errorsLeftOut = 0
	// The truncation entry takes one of the slots, so a list that must say it was cut leaves one free.
	if (warningsLeftOut > 0 || unevaluatedLeftOut > 0 || errors.length > MAX_CHECKS_RUNTIME_ERRORS) {
		const room = MAX_CHECKS_RUNTIME_ERRORS - 1
		if (errors.length > room) {
			keptErrors.length = room
			errorsLeftOut = errors.length - room
		}
		const notes = [
			...(warningsLeftOut > 0 ? [`${warningsLeftOut} translation warnings were left out.`] : []),
			...(unevaluatedLeftOut > 0 ? [`${unevaluatedLeftOut} unevaluated Properties were left out.`] : []),
			...(errorsLeftOut > 0 ? [`${errorsLeftOut} runtime errors were left out.`] : []),
		]
		keptErrors.push({ reason: 'runtime.report_truncated', detail: notes.join(' ') })
	}

	return Object.freeze({
		translationWarnings: Object.freeze(keptWarnings),
		runtimeErrors: Object.freeze(keptErrors),
		...(declaredUnevaluated
			? { coverage: Object.freeze({ complete: declaredUnevaluated.length === 0, unevaluated: Object.freeze(keptUnevaluated) }) }
			: {}),
	})
}

type ChecksReportContextInput = Readonly<{
	previewSessionId: string
	runtimeGenerationId: string
	viewId: string
	variantId?: string
	runtimeContextVersion: number
}>

/**
 * Numbers and de-duplicates the reports of one generation: `sequence` starts at 0 and rises with
 * every report that was sent, and a report that says what the last sent one said, for the same
 * context, is not sent again. A report the bridge did not send (it is gated until the ACK) takes no
 * sequence, so the caller can offer it again.
 */
/**
 * A trailing debounce with a longest wait: every `schedule` pushes the run back by `delayMs`, but a run
 * never waits longer than `maxWaitMs` after the first `schedule` since the last run, so a Preview that
 * keeps recomputing its Properties still reports.
 */
export class MaxWaitDebouncer {
	private timer?: unknown
	private pendingSince?: number

	constructor(
		private readonly run: () => void,
		private readonly delayMs: number,
		private readonly maxWaitMs: number,
		private readonly clock: Readonly<{ now: () => number; set: (callback: () => void, ms: number) => unknown; clear: (handle: unknown) => void }> = { now: () => Date.now(), set: (callback, ms) => setTimeout(callback, ms), clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) },
	) {}

	schedule(): void {
		const now = this.clock.now()
		this.pendingSince ??= now
		if (this.timer !== undefined) this.clock.clear(this.timer)
		const remaining = this.maxWaitMs - (now - this.pendingSince)
		this.timer = this.clock.set(() => this.fire(), Math.max(0, Math.min(this.delayMs, remaining)))
	}

	cancel(): void {
		if (this.timer !== undefined) this.clock.clear(this.timer)
		this.timer = undefined
		this.pendingSince = undefined
	}

	private fire(): void {
		this.timer = undefined
		this.pendingSince = undefined
		this.run()
	}
}

export class ChecksReportPublisher {
	private sequence = 0
	private lastKey?: string

	constructor(private readonly send: (message: ChecksReportMessage) => 'sent' | 'unsent') {}

	publish(context: ChecksReportContextInput, body: ChecksReportBody): 'sent' | 'unchanged' | 'unsent' {
		const key = JSON.stringify([context.viewId, context.variantId ?? '', context.runtimeContextVersion, body])
		if (key === this.lastKey) return 'unchanged'
		const message: ChecksReportMessage = {
			type: 'checks.report',
			context: {
				previewSessionId: context.previewSessionId,
				runtimeGenerationId: context.runtimeGenerationId,
				viewId: context.viewId,
				...(context.variantId ? { variantId: context.variantId } : {}),
				runtimeContextVersion: context.runtimeContextVersion,
			},
			payload: {
				sequence: this.sequence,
				translationWarnings: body.translationWarnings,
				runtimeErrors: body.runtimeErrors,
				...(body.coverage ? { coverage: body.coverage } : {}),
			},
		}
		if (this.send(message) !== 'sent') return 'unsent'
		this.sequence++
		this.lastKey = key
		return 'sent'
	}
}
