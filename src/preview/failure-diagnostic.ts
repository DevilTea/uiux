import type { BridgeReceiveResult } from './protocol/bridge'
import {
	PREVIEW_FAILURE_REASON_CODES,
	type PreviewFailureDiagnostic,
	type ProtocolFailureCategory,
} from './protocol/schema'

/**
 * Preview failure diagnostics the Workbench derives itself (issue #111). A failure the runtime
 * detects arrives as `failure.report` and is turned into its diagnostic by `failureReportDiagnostic`
 * (issue #312); every diagnostic here comes from what the Workbench's own bridge observed (Clause
 * 01a11687-415c-79d5-9978-62683f35e9e2).
 */

/** What one received envelope did to the Workbench's view of the handshake. */
export type FailureDerivation =
	/** Nothing failed, or the envelope was stale traffic that the gates discard without a code. */
	| Readonly<{ effect: 'none' }>
	/** Preview is unavailable after this non-recoverable failure. */
	| Readonly<{ effect: 'fail'; failure: PreviewFailureDiagnostic }>
	/**
	 * Recovery is exhausted and the new generation was refused, which is no failure of its own and
	 * has no reason code: Preview stays unavailable for the failure that exhausted recovery, shown
	 * again under the refused generation (owner ruling 4 of 2026-10-23, Discussion #241).
	 */
	| Readonly<{ effect: 'refused'; generationId: string }>

export type FailureObservation = Readonly<{
	result: BridgeReceiveResult
	/** Whether the envelope was a `capability.declare`. */
	declaration: boolean
	/** The `runtimeGenerationId` the envelope's context names, when it names one. */
	envelopeGenerationId?: string
	/** The generation the Workbench had admitted before this envelope, if any. */
	admittedGenerationId?: string
	previewSessionId: string
	/** The Workbench handshake phase before this envelope. */
	phase: 'initiating' | 'open' | 'failed'
}>

/**
 * How long Retry Preview waits after its document loaded for that document's declaration before it
 * is offered again (owner ruling 1 of 2026-10-23, Discussion #241).
 */
export const RETRY_STALL_GRACE_MS = 5000

/**
 * The grace period in effect: `RETRY_STALL_GRACE_MS`, unless browser tests set a positive
 * `__uiuxRetryStallGraceMs` on the Workbench window before it loads, so that in-flight and stall
 * assertions do not race the real timer. Nothing in the product sets it.
 */
export function retryStallGraceMs(scope: unknown = globalThis): number {
	const override = (scope as { __uiuxRetryStallGraceMs?: unknown } | undefined)?.__uiuxRetryStallGraceMs
	return typeof override === 'number' && Number.isFinite(override) && override > 0 ? override : RETRY_STALL_GRACE_MS
}

export type RecoveryStallObservation = Readonly<{
	/** The session's automatic recovery allowance is spent (`automaticRecoveryUsed` of its snapshot). */
	automaticRecoveryUsed: boolean
	previewSessionId: string
}>

/**
 * A recovery document (the automatic attempt's, or one an explicit Retry Preview requested) loaded
 * and declared nothing within the grace period (issue #467; owner ruling 2026-11-02, Discussion
 * #379). With the automatic recovery allowance spent, the Workbench judges the channel lost for
 * good and derives `transport.channel_unavailable`, correlated with the Preview session alone since
 * no generation of the stalled document was admitted. While the allowance is unspent the stall is
 * not a failure: Retry Preview is offered again and the earlier diagnostic stays (owner ruling 1 of
 * 2026-10-23, Discussion #241).
 */
export function deriveRecoveryStallFailure(observation: RecoveryStallObservation): PreviewFailureDiagnostic | undefined {
	if (!observation.automaticRecoveryUsed) return undefined
	return createPreviewFailure('transport', 'transport.channel_unavailable', observation.previewSessionId)
}

/** Longest `detail` the Workbench writes; the detail is display-only and never drives control flow. */
const MAX_DETAIL_LENGTH = 200

/**
 * Maps one bridge result to its failure effect (issue #111, orchestrator decision Q3 of 2026-10-23):
 * a capability failure keeps its `capability.*` reason, a conflicting declaration is
 * `protocol.capability_conflict`, an undecodable message before the handshake opens is
 * `protocol.invalid_message`, and a declaration naming a retired generation is
 * `protocol.identity_reuse` only while no generation is open; once a generation is open, or Preview
 * already failed, it is stale traffic and changes nothing (Clause 01a1161c-418f-799c-944d-23a1e17e4f19).
 */
export function deriveWorkbenchFailure(observation: FailureObservation): FailureDerivation {
	const { result, previewSessionId } = observation
	switch (result.status) {
		case 'capability-failure':
			return fail(createPreviewFailure('capability', result.reason, previewSessionId, observation.envelopeGenerationId ?? observation.admittedGenerationId))
		case 'capability-conflict':
			return fail(createPreviewFailure('protocol', 'protocol.capability_conflict', previewSessionId, observation.envelopeGenerationId))
		case 'generation-refused':
			return { effect: 'refused', generationId: result.generationId }
		case 'invalid': {
			if (observation.phase !== 'initiating') return { effect: 'none' }
			const codes = [...new Set(result.diagnostics.map(diagnostic => diagnostic.code))].join(', ')
			return fail(createPreviewFailure('protocol', 'protocol.invalid_message', previewSessionId, observation.admittedGenerationId, codes))
		}
		case 'stale-generation':
			if (!observation.declaration || observation.phase !== 'initiating' || !observation.envelopeGenerationId) return { effect: 'none' }
			return fail(createPreviewFailure('protocol', 'protocol.identity_reuse', previewSessionId, observation.envelopeGenerationId))
		default:
			return { effect: 'none' }
	}
}

/**
 * One generation-scoped diagnostic: its correlation is the Preview session and, when known, the
 * failed generation, and nothing else applies (Clause 01a11687-415c-79d5-9978-62683f35e9e2).
 */
export function createPreviewFailure(
	category: ProtocolFailureCategory,
	reason: string,
	previewSessionId: string,
	runtimeGenerationId?: string,
	detail?: string,
): PreviewFailureDiagnostic {
	const bounded = detail ? displaySafe(detail) : ''
	return Object.freeze({
		category,
		reason,
		...(bounded ? { detail: bounded } : {}),
		correlation: Object.freeze({ previewSessionId, ...(runtimeGenerationId ? { runtimeGenerationId } : {}) }),
	})
}

/** The same failure correlated with another generation of the session (a refused one). */
export function recorrelatePreviewFailure(failure: PreviewFailureDiagnostic, previewSessionId: string, runtimeGenerationId: string): PreviewFailureDiagnostic {
	return createPreviewFailure(failure.category, failure.reason, previewSessionId, runtimeGenerationId, failure.detail)
}

/** Whether the Workbench has copy for this reason: a registry code of the diagnostic's own category. */
export function isRecognizedFailureReason(diagnostic: Pick<PreviewFailureDiagnostic, 'category' | 'reason'>): boolean {
	return PREVIEW_FAILURE_REASON_CODES.has(diagnostic.reason) && diagnostic.reason.startsWith(`${diagnostic.category}.`)
}

/**
 * The catalog keys of a diagnostic's copy: the title from its category, the body from its
 * recognized reason, else the category's generic body (Rules 01a11687-37a0-77bb-a857-5f7804b7c306
 * and 01a11687-37e4-76ef-8468-35e2e9d67a4d).
 */
export function previewFailureCopyKeys(diagnostic: Pick<PreviewFailureDiagnostic, 'category' | 'reason'>): Readonly<{ title: string; body: string; recognized: boolean }> {
	const recognized = isRecognizedFailureReason(diagnostic)
	return {
		title: `previewFailure.${diagnostic.category}.title`,
		body: recognized ? previewFailureReasonKey(diagnostic.reason) : `previewFailure.${diagnostic.category}.body`,
		recognized,
	}
}

/** `capability.unsupported_protocol_version` → `previewFailure.reasons.capability.unsupported_protocol_version`. */
export function previewFailureReasonKey(reason: string): string {
	return `previewFailure.reasons.${reason}`
}

function fail(failure: PreviewFailureDiagnostic): FailureDerivation {
	return { effect: 'fail', failure }
}

/** Bounded and printable: control characters become spaces, so the detail can be shown as text. */
function displaySafe(value: string): string {
	const printable = [...value].map((character) => {
		const code = character.charCodeAt(0)
		return code < 32 || code === 127 ? ' ' : character
	}).join('').trim()
	return printable.length > MAX_DETAIL_LENGTH ? `${printable.slice(0, MAX_DETAIL_LENGTH - 1)}…` : printable
}
