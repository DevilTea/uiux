import type { Diagnostic } from '../../domain/validation'
import {
	REVEAL_GEOMETRY_FEATURE,
	validateCapabilityMessage,
	validateGeometryMessage,
	type CapabilityAckMessage,
	type CapabilityDeclareMessage,
	type GeometryMessage,
	type GeometryRequestMessage,
	type GeometryResponseMessage,
} from './schema'
import {
	BASE_STATE_FEATURE,
	isBaseStateMessageType,
	isBaseStateMountedMessage,
	isBaseStateRequestMessage,
	validateBaseStateMessage,
	type BaseStateMessage,
	type BaseStateMountedMessage,
	type BaseStateRequestMessage,
	type BaseStateResponseMessage,
} from './base-state'
import {
	CHECKS_REPORTS_FEATURE,
	isChecksReportMessageType,
	validateChecksReportMessage,
	type ChecksReportMessage,
} from './checks-report'
import {
	FAILURE_REPORTS_FEATURE,
	failureReportScope,
	isFailureReportMessageType,
	validateFailureReportMessage,
	type FailureReportMessage,
} from './failure-report'
import {
	isTargetingMessageType,
	isTargetingRuntimeMessage,
	validateTargetingMessage,
	type TargetingMessage,
	type TargetingRuntimeMessage,
	type TargetingWorkbenchMessage,
} from './targeting'
import {
	isWidgetEventMessageType,
	validateWidgetEventMessage,
	type WidgetEventArmMessage,
	type WidgetEventMessage,
	type WidgetEventOccurrenceMessage,
} from './widget-events'
import {
	PreviewProtocolSession,
	type AutomaticRecoveryResult,
	type CapabilityCompatibility,
	type GenerationAdmissionCause,
	type GenerationAdmissionResult,
	type RetryAuthorizationResult,
} from './session'

export type PreviewWireMessage = CapabilityDeclareMessage | CapabilityAckMessage | GeometryMessage | TargetingMessage | WidgetEventMessage | FailureReportMessage | ChecksReportMessage | BaseStateMessage
export type PreviewProtocolTransport = Readonly<{ send(message: PreviewWireMessage): void }>

export type BridgeReceiveResult =
	| Readonly<{ status: 'accepted'; message: PreviewWireMessage }>
	| Readonly<{ status: 'ack-dispatched'; acknowledgement: CapabilityAckMessage }>
	| Readonly<{ status: 'capability-failure'; reason: `capability.${string}` }>
	| Readonly<{ status: 'capability-conflict' | 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' }>
	| Readonly<{ status: 'generation-refused'; generationId: string }>
	/**
	 * The current generation reported its own failure (a generation-scoped `failure.report`): the
	 * session ended and retired it. The caller ends its per-generation state and applies the effect
	 * of the report's category.
	 */
	| Readonly<{ status: 'generation-failed'; message: FailureReportMessage }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>
	/**
	 * Only the Workbench returns it: an `inspection.base-state.response` that does not decode or exceeds
	 * its bound is rejected whole and is never a protocol failure (Clause
	 * 01a19ab9-d028-7bb9-a370-4736992852f5), so the caller ends the request it answers without failing the
	 * generation. `requestId` is read from the raw payload when it is a string, to name that request.
	 */
	| Readonly<{ status: 'rejected'; diagnostics: readonly Diagnostic[]; requestId?: string }>
	/**
	 * Only a runtime returns it: Workbench traffic of its own session and generation that violates
	 * the generation's state (Clause 01a11a70-4261-7155-8aed-28bed7a89064). `detail` is display-safe
	 * text for `reportInvalidState`, never the payload.
	 */
	| Readonly<{ status: 'invalid-state'; detail: string }>

export type WorkbenchBridgeHooks = Readonly<{
	/**
	 * A declaration named a generation this session never saw, and the Workbench admitted it: the
	 * runtime started a new Preview document or restarted. Called before the declaration is judged
	 * and acknowledged, so the caller ends every per-generation state of the previous one first.
	 */
	onGenerationAdmitted?(generationId: string): void
}>

export type BridgeSendResult =
	| Readonly<{ status: 'sent' }>
	/** The sender may not send this message now: its feature is not declared, or its once-only report is spent. */
	| Readonly<{ status: 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' | 'not-permitted' }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

export class WorkbenchPreviewProtocolBridge {
	private readonly session: PreviewProtocolSession
	private readonly transport: PreviewProtocolTransport
	private readonly evaluateCapabilities: (declaration: CapabilityDeclareMessage['payload']) => CapabilityCompatibility
	private readonly hooks: WorkbenchBridgeHooks
	private ackDispatchedGenerationId?: string

	/**
	 * The runtime mints every generation ID (Clause 01a1161c-4119-712d-8785-7d8155c0ceee): the
	 * Workbench admits a generation when its first declaration arrives, and a declaration naming an
	 * unseen ID replaces the current generation.
	 */
	constructor(
		session: PreviewProtocolSession | string,
		transport: PreviewProtocolTransport,
		evaluateCapabilities: (declaration: CapabilityDeclareMessage['payload']) => CapabilityCompatibility,
		hooks: WorkbenchBridgeHooks = {},
	) {
		this.session = typeof session === 'string' ? new PreviewProtocolSession(session) : session
		this.transport = transport
		this.evaluateCapabilities = evaluateCapabilities
		this.hooks = hooks
	}

	/**
	 * Test-only: admits a generation whose ID the caller already knows, with an explicit cause, ahead
	 * of its declaration. The Workbench itself never calls it; it admits from the declaration.
	 */
	admitGeneration(generationId: string, cause: GenerationAdmissionCause): GenerationAdmissionResult {
		const result = this.session.beginGeneration(generationId, cause)
		if (result.status === 'admitted') this.ackDispatchedGenerationId = undefined
		return result
	}

	/** Test-only, like `admitGeneration`: replaces the current generation with a known ID. */
	replaceGenerationForLifecycle(generationId: string, cause: 'reload' | 'restart'): GenerationAdmissionResult {
		const result = this.session.replaceGenerationForLifecycle(generationId, cause)
		this.ackDispatchedGenerationId = undefined
		return result
	}

	/**
	 * The Workbench replaces the Preview document: the current generation ends and its ID is retired
	 * for the rest of the session, so nothing of it is ever acknowledged or accepted again.
	 */
	retireGeneration(): void {
		this.session.retireCurrentGeneration()
		this.ackDispatchedGenerationId = undefined
	}

	/**
	 * Retry Preview: authorizes one explicit retry while recovery is exhausted. The next generation
	 * the runtime declares is that retry; a trigger while one is pending joins it, and a trigger
	 * during a generation's handshake is ignored (Rules 01a1161c-3dad-7ac1-b49b-a77fcb1e33f2 and
	 * 01a1161c-3e28-7dcf-a06e-a2c12c83919c).
	 */
	authorizeRetry(): RetryAuthorizationResult {
		return this.session.authorizeRetry()
	}

	/**
	 * Starts the one automatic recovery attempt after a protocol-invalid generation; the caller then
	 * requests a fresh Preview document, whose declared generation is that attempt (Rule
	 * 01a1161c-3bd4-7a91-b50e-d01a857521e5).
	 */
	beginAutomaticRecovery(): AutomaticRecoveryResult {
		return this.session.beginAutomaticRecovery()
	}

	/** The Workbench found its requested Preview document protocol-invalid (see the session). */
	failRequestedDocument(): void {
		this.session.failRequestedDocument()
		this.ackDispatchedGenerationId = undefined
	}

	receive(input: unknown): BridgeReceiveResult {
		const type = messageType(input)
		if (type === 'capability.ack') return { status: 'wrong-direction' }
		// Correlation before the full decode: a stale envelope is discarded whatever its type or
		// payload, so an undecodable message of a retired generation never fails the current one.
		// A declaration may name a generation not seen yet; only a retired one is stale.
		const stale = type === 'capability.declare' ? this.staleDeclaration(input) : this.staleCorrelation(input)
		if (stale) return { status: stale }
		if (type === 'capability.declare') return this.receiveCapabilityDeclaration(input)
		if (isTargetingMessageType(type)) {
			const targeting = validateTargetingMessage(input)
			if (!targeting.ok) return { status: 'invalid', diagnostics: targeting.diagnostics }
			if (!isTargetingRuntimeMessage(targeting.value)) return { status: 'wrong-direction' }
			const gate = this.classify(targeting.value.context.previewSessionId, targeting.value.context.runtimeGenerationId)
			if (gate) return { status: gate }
			return { status: 'accepted', message: targeting.value }
		}
		if (isFailureReportMessageType(type)) return this.receiveFailureReport(input)
		if (isChecksReportMessageType(type)) return this.receiveChecksReport(input)
		if (isBaseStateMessageType(type)) return this.receiveBaseStateRuntimeTraffic(input, type)
		if (isWidgetEventMessageType(type)) {
			// Workbench accepts only occurrences inbound; the decoded copy carries known members only.
			const decoded = validateWidgetEventMessage(input)
			if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
			if (decoded.value.type !== 'widget.event.occurrence') return { status: 'wrong-direction' }
			const gate = this.classify(decoded.value.context.previewSessionId, decoded.value.context.runtimeGenerationId)
			if (gate) return { status: gate }
			return { status: 'accepted', message: decoded.value }
		}

		const decoded = validateGeometryMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryResponse(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.workbenchInboundGate(decoded.value)
		if (gate) return { status: gate }
		return { status: 'accepted', message: decoded.value }
	}

	/** Sends `targeting.enter` / `targeting.exit` once the generation's capability ACK is dispatched. */
	sendTargeting(message: TargetingWorkbenchMessage): BridgeSendResult {
		const decoded = validateTargetingMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (isTargetingRuntimeMessage(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.classify(decoded.value.context.previewSessionId, decoded.value.context.runtimeGenerationId)
		if (gate) return { status: gate }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends `widget.event.arm` once the generation's capability ACK is dispatched. Whether the
	 * generation declared `widget.events` is the caller's gate (decision 10).
	 */
	sendWidgetEventArm(message: WidgetEventArmMessage): BridgeSendResult {
		const decoded = validateWidgetEventMessage(message, 'send')
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'widget.event.arm') return { status: 'wrong-direction' }
		const gate = this.classify(decoded.value.context.previewSessionId, decoded.value.context.runtimeGenerationId)
		if (gate) return { status: gate }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends one `inspection.base-state.request` once the generation's capability ACK is dispatched, and
	 * only to a generation that declared `inspection.base-state` (Clauses
	 * 01a1161c-4283-70b7-b487-e81bc28ce875 and 01a11a59-d728-751f-bbac-287a77b75610). A request beyond a
	 * bound is invalid and is not sent; having at most one request pending is the caller's.
	 */
	sendBaseStateRequest(message: BaseStateRequestMessage): BridgeSendResult {
		const decoded = validateBaseStateMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isBaseStateRequestMessage(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.classify(decoded.value.context.previewSessionId, decoded.value.context.runtimeGenerationId)
		if (gate) return { status: gate }
		if (!this.session.currentGenerationDeclares(decoded.value.context.runtimeGenerationId, BASE_STATE_FEATURE)) return { status: 'not-permitted' }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	sendGeometry(message: GeometryRequestMessage): BridgeSendResult {
		const decoded = validateGeometryMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryRequest(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.workbenchOutboundGate(decoded.value)
		if (gate) return { status: gate }
		// A message type that an optional feature introduces goes only to a generation that declared it
		// (Clause 01a11a59-d728-751f-bbac-287a77b75610).
		if (decoded.value.type === 'geometry.reveal'
			&& !this.session.currentGenerationDeclares(decoded.value.context.runtimeGenerationId, REVEAL_GEOMETRY_FEATURE))
			return { status: 'not-permitted' }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	snapshot() {
		return Object.freeze({
			session: this.session.snapshot(),
			...(this.ackDispatchedGenerationId ? { ackDispatchedGenerationId: this.ackDispatchedGenerationId } : {}),
		})
	}

	private receiveCapabilityDeclaration(input: unknown): BridgeReceiveResult {
		const decoded = validateCapabilityMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'capability.declare') return { status: 'wrong-direction' }
		if (decoded.value.context.previewSessionId !== this.session.previewSessionId) return { status: 'stale-session' }

		const generationId = decoded.value.context.runtimeGenerationId
		const known = this.session.classifyGeneration(generationId)
		// A retired generation is never revived (Clause 01a1161c-4154-7de9-9dc5-622d21438a47).
		if (known === 'retired') return { status: 'stale-generation' }
		if (known === 'unseen') {
			const admission = this.session.admitDeclaredGeneration(generationId)
			this.ackDispatchedGenerationId = undefined
			if (admission.status !== 'admitted') return { status: 'generation-refused', generationId }
			this.hooks.onGenerationAdmitted?.(generationId)
		}

		const result = this.session.receiveCapabilityDeclaration(
			decoded.value.context.runtimeGenerationId,
			decoded.value.payload,
			this.evaluateCapabilities(decoded.value.payload),
		)
		if (result.status === 'stale') return { status: 'stale-generation' }
		if (result.status === 'capability-conflict') {
			this.ackDispatchedGenerationId = undefined
			return { status: 'capability-conflict' }
		}
		if (result.status === 'capability-failure') {
			this.ackDispatchedGenerationId = undefined
			return { status: 'capability-failure', reason: result.reason }
		}

		const acknowledgement: CapabilityAckMessage = Object.freeze({
			type: 'capability.ack',
			context: Object.freeze({
				previewSessionId: decoded.value.context.previewSessionId,
				runtimeGenerationId: decoded.value.context.runtimeGenerationId,
			}),
			payload: Object.freeze({}),
		})
		this.transport.send(acknowledgement)
		const committed = this.session.observeCapabilityAcknowledgement(decoded.value.context.runtimeGenerationId)
		if (committed.status !== 'opened' && committed.status !== 'already-open')
			throw new Error('Capability ACK dispatch must commit the matching Workbench handshake state.')
		this.ackDispatchedGenerationId = decoded.value.context.runtimeGenerationId
		return { status: 'ack-dispatched', acknowledgement }
	}

	/**
	 * A runtime-reported failure. It is traffic of an open generation that declared `failure.reports`
	 * (Clauses 01a1161c-4283-70b7-b487-e81bc28ce875 and 01a11a59-dd69-78ed-9181-d8beb5f4cb7b); the
	 * correlation check before the decode already dropped a report of another generation. A
	 * generation-scoped report is its generation's last envelope, so the session ends and retires
	 * that generation here; a work-scoped one is handed to the caller and leaves the generation alone
	 * (Clause 01a11a59-def9-797a-8d08-5e4b02ecd900).
	 */
	private receiveFailureReport(input: unknown): BridgeReceiveResult {
		const decoded = validateFailureReportMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		const message = decoded.value
		const { previewSessionId, runtimeGenerationId } = message.context
		const gate = this.classify(previewSessionId, runtimeGenerationId)
		if (gate) return { status: gate }
		if (!this.session.currentGenerationDeclares(runtimeGenerationId, FAILURE_REPORTS_FEATURE))
			return { status: 'invalid', diagnostics: [{ code: 'protocol.feature_not_declared', path: '/type', message: 'failure.report needs the generation to declare failure.reports.' }] }
		if (failureReportScope(message) === 'work') return { status: 'accepted', message }
		this.session.failGenerationFromReport(runtimeGenerationId, message.payload.category)
		this.ackDispatchedGenerationId = undefined
		return { status: 'generation-failed', message }
	}

	/**
	 * A runtime's `checks.report`. Like any runtime traffic it is accepted only for the current
	 * generation after its capability ACK was dispatched, and only when that generation declared
	 * `checks.reports` (Clauses 01a1161c-4283-70b7-b487-e81bc28ce875 and 01a17619-ab3f-797d-ae93-4038a48ee31f);
	 * the correlation check before the decode already dropped a report of another session or generation.
	 * Whether the report is current for the View and Variant the Workbench renders, and whether it
	 * replaces the previous one, is the caller's (`PreviewChecksReports`).
	 */
	private receiveChecksReport(input: unknown): BridgeReceiveResult {
		const decoded = validateChecksReportMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		const message = decoded.value
		const { previewSessionId, runtimeGenerationId } = message.context
		const gate = this.classify(previewSessionId, runtimeGenerationId)
		if (gate) return { status: gate }
		if (!this.session.currentGenerationDeclares(runtimeGenerationId, CHECKS_REPORTS_FEATURE))
			return { status: 'invalid', diagnostics: [{ code: 'protocol.feature_not_declared', path: '/type', message: 'checks.report needs the generation to declare checks.reports.' }] }
		return { status: 'accepted', message }
	}

	/**
	 * A runtime's `inspection.base-state.response` or `inspection.base-state.mounted`. Like any runtime traffic it is accepted only for the
	 * current generation after its capability ACK was dispatched, and only when that generation declared
	 * `inspection.base-state`; the correlation check before the decode already dropped a response of
	 * another session or generation. A message that does not decode or exceeds its bound is `rejected`,
	 * never `invalid`: it is no protocol failure (Clause 01a19ab9-d028-7bb9-a370-4736992852f5). Whether
	 * a response answers the pending request, and is current for the View and Variant, is the caller's.
	 */
	private receiveBaseStateRuntimeTraffic(input: unknown, type: BaseStateMessage['type']): BridgeReceiveResult {
		if (type === 'inspection.base-state.request') return { status: 'wrong-direction' }
		// The gates come before the decode, by the identities the envelope names: traffic of a generation
		// that is not open, or did not declare the feature, is dropped and is never `rejected`.
		const correlation = envelopeCorrelation(input)
		if (correlation?.runtimeGenerationId !== undefined) {
			const gate = this.classify(correlation.previewSessionId, correlation.runtimeGenerationId)
			if (gate) return { status: gate }
			if (!this.session.currentGenerationDeclares(correlation.runtimeGenerationId, BASE_STATE_FEATURE)) return { status: 'gated' }
		}
		const decoded = validateBaseStateMessage(input)
		if (!decoded.ok) {
			const requestId = type === 'inspection.base-state.response' ? rawRequestId(input) : undefined
			return { status: 'rejected', diagnostics: decoded.diagnostics, ...(requestId !== undefined ? { requestId } : {}) }
		}
		if (isBaseStateRequestMessage(decoded.value)) return { status: 'wrong-direction' }
		return { status: 'accepted', message: decoded.value }
	}

	/** A declaration is stale when its session is not this one or its generation is retired. */
	private staleDeclaration(input: unknown): 'stale-session' | 'stale-generation' | undefined {
		const correlation = envelopeCorrelation(input)
		if (!correlation) return undefined
		if (correlation.previewSessionId !== this.session.previewSessionId) return 'stale-session'
		if (correlation.runtimeGenerationId === undefined) return undefined
		return this.session.classifyGeneration(correlation.runtimeGenerationId) === 'retired' ? 'stale-generation' : undefined
	}

	private staleCorrelation(input: unknown): 'stale-session' | 'stale-generation' | undefined {
		const correlation = envelopeCorrelation(input)
		if (!correlation) return undefined
		if (correlation.previewSessionId !== this.session.previewSessionId) return 'stale-session'
		if (correlation.runtimeGenerationId === undefined) return undefined
		return this.classify(correlation.previewSessionId, correlation.runtimeGenerationId) === 'stale-generation' ? 'stale-generation' : undefined
	}

	private classify(previewSessionId: string, runtimeGenerationId: string): 'gated' | 'stale-session' | 'stale-generation' | undefined {
		const gate = this.session.classifyGeometryTraffic(previewSessionId, runtimeGenerationId)
		return gate === 'open' ? undefined : gate
	}

	private workbenchInboundGate(message: GeometryResponseMessage): 'gated' | 'stale-session' | 'stale-generation' | undefined {
		const gate = this.session.classifyGeometryTraffic(
			message.context.previewSessionId,
			message.context.runtimeGenerationId,
		)
		return gate === 'open' ? undefined : gate
	}

	private workbenchOutboundGate(message: GeometryRequestMessage): 'gated' | 'stale-session' | 'stale-generation' | undefined {
		const gate = this.session.classifyGeometryTraffic(
			message.context.previewSessionId,
			message.context.runtimeGenerationId,
		)
		return gate === 'open' ? undefined : gate
	}
}

export class RuntimePreviewProtocolBridge {
	private readonly previewSessionId: string
	private readonly runtimeGenerationId: string
	private readonly declaration: CapabilityDeclareMessage['payload']
	private readonly transport: PreviewProtocolTransport
	private ackObserved = false
	/** A generation-scoped `failure.report` was sent: it is the generation's last envelope. */
	private generationEnded = false
	/** A generation-scoped report decided before the acknowledgement, sent when it arrives. */
	private heldReport?: FailureReportMessage
	/** The latest `inspection.base-state.mounted` of a mount that completed before the acknowledgement, sent when it arrives. */
	private heldMounted?: BaseStateMountedMessage
	private readonly reportedWorkSequences = new Set<number>()
	/** The highest `checks.report` `sequence` sent: each report of a generation carries a higher one. */
	private lastChecksSequence?: number

	constructor(
		previewSessionId: string,
		runtimeGenerationId: string,
		declaration: CapabilityDeclareMessage['payload'],
		transport: PreviewProtocolTransport,
	) {
		assertOpaqueId(previewSessionId, 'previewSessionId')
		assertOpaqueId(runtimeGenerationId, 'runtimeGenerationId')
		this.previewSessionId = previewSessionId
		this.runtimeGenerationId = runtimeGenerationId
		this.declaration = cloneDeclaration(declaration)
		this.transport = transport
	}

	/** Whether the generation has ended: it sent its generation-scoped `failure.report`, and nothing crosses after it. */
	get ended(): boolean {
		return this.generationEnded
	}

	declareCapabilities(): CapabilityDeclareMessage {
		const message: CapabilityDeclareMessage = Object.freeze({
			type: 'capability.declare',
			context: Object.freeze({
				previewSessionId: this.previewSessionId,
				runtimeGenerationId: this.runtimeGenerationId,
			}),
			payload: cloneDeclaration(this.declaration),
		})
		const decoded = validateCapabilityMessage(message)
		if (!decoded.ok || decoded.value.type !== 'capability.declare')
			throw new TypeError('Runtime capability declaration must satisfy the canonical wire schema.')
		this.transport.send(message)
		return message
	}

	receive(input: unknown): BridgeReceiveResult {
		const type = messageType(input)
		// Correlation before the full decode, as on the Workbench side.
		const correlation = envelopeCorrelation(input)
		if (type === 'capability.declare') {
			// Only the runtime declares. Once its generation is acknowledged, a declaration of that
			// generation from the Workbench is a handshake opened again: an established violation.
			if (this.ackObserved && correlation?.previewSessionId === this.previewSessionId && correlation.runtimeGenerationId === this.runtimeGenerationId)
				return { status: 'invalid-state', detail: 'capability.declare after capability.ack' }
			return { status: 'wrong-direction' }
		}
		if (correlation && correlation.previewSessionId !== this.previewSessionId) return { status: 'stale-session' }
		if (correlation?.runtimeGenerationId !== undefined && correlation.runtimeGenerationId !== this.runtimeGenerationId)
			return { status: 'stale-generation' }
		if (type === 'capability.ack') return this.receiveAcknowledgement(input)
		if (isTargetingMessageType(type)) {
			const targeting = validateTargetingMessage(input)
			if (!targeting.ok) return { status: 'invalid', diagnostics: targeting.diagnostics }
			if (isTargetingRuntimeMessage(targeting.value)) return { status: 'wrong-direction' }
			const gate = this.runtimeGate(targeting.value)
			if (gate) return this.gated(gate, targeting.value.type)
			return { status: 'accepted', message: targeting.value }
		}
		if (isFailureReportMessageType(type) || isChecksReportMessageType(type)) return { status: 'wrong-direction' }
		if (isBaseStateMessageType(type)) return this.receiveBaseStateRequest(input, type)
		if (isWidgetEventMessageType(type)) {
			// The runtime accepts only arms inbound.
			const decoded = validateWidgetEventMessage(input)
			if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
			if (decoded.value.type !== 'widget.event.arm') return { status: 'wrong-direction' }
			const gate = this.runtimeGate(decoded.value)
			if (gate) return this.gated(gate, decoded.value.type)
			return { status: 'accepted', message: decoded.value }
		}

		const decoded = validateGeometryMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryRequest(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return this.gated(gate, decoded.value.type)
		// A runtime that did not declare `geometry.reveal` does not know the command: it drops it without
		// effect, as it drops any unknown type of an acknowledged generation (Clause 01a11a59-d728-751f-bbac-287a77b75610).
		if (decoded.value.type === 'geometry.reveal' && !this.declaration.features.includes(REVEAL_GEOMETRY_FEATURE)) return { status: 'gated' }
		return { status: 'accepted', message: decoded.value }
	}

	/**
	 * A Workbench `inspection.base-state.request`. A runtime that did not declare the feature does not
	 * know the type and drops it without effect (Clause 01a11a59-d728-751f-bbac-287a77b75610). A
	 * request beyond a bound does not decode, so it is an invalid message like any other (Clause
	 * 01a19a9b-347f-782c-bd9a-22dc52096603); whether it names the mounted View and Variant is the caller's.
	 */
	private receiveBaseStateRequest(input: unknown, type: BaseStateMessage['type']): BridgeReceiveResult {
		if (!this.declaration.features.includes(BASE_STATE_FEATURE)) return { status: 'gated' }
		const decoded = validateBaseStateMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isBaseStateRequestMessage(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return this.gated(gate, type)
		return { status: 'accepted', message: decoded.value }
	}

	/**
	 * Sends one `inspection.base-state.response`; nothing crosses before the capability ACK, and only a
	 * generation that declared `inspection.base-state` may send one. The caller builds it with
	 * `encodeBaseStateResponse`, which applies the bound of the whole envelope.
	 */
	sendBaseStateResponse(message: BaseStateResponseMessage): BridgeSendResult {
		const decoded = validateBaseStateMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (isBaseStateRequestMessage(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		if (!this.declaration.features.includes(BASE_STATE_FEATURE)) return { status: 'not-permitted' }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends one `inspection.base-state.mounted` (Discussion #241, owner ruling 2026-11-03): nothing
	 * crosses before the capability ACK, and only a generation that declared `inspection.base-state`
	 * may send one. A mount that completes before the ACK is held, a later one replacing it, and sent
	 * once the ACK arrives, so the Workbench learns the latest revision. A generation that ended
	 * sends nothing.
	 */
	sendBaseStateMounted(message: BaseStateMountedMessage): BridgeSendResult {
		const decoded = validateBaseStateMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isBaseStateMountedMessage(decoded.value)) return { status: 'wrong-direction' }
		const declared = this.declaration.features.includes(BASE_STATE_FEATURE)
		const gate = this.runtimeGate(decoded.value)
		if (gate === 'gated' && declared && !this.ackObserved && !this.generationEnded) {
			this.heldMounted = decoded.value
			return { status: 'gated' }
		}
		if (gate) return { status: gate }
		if (!declared) return { status: 'not-permitted' }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/** Sends `targeting.hover` / `select` / `escape`; nothing crosses before the capability ACK. */
	sendTargeting(message: TargetingRuntimeMessage): BridgeSendResult {
		const decoded = validateTargetingMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isTargetingRuntimeMessage(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends one `widget.event.occurrence`; nothing crosses before the capability ACK. The payload is
	 * closed for senders: any member beyond `{ armId, event }` makes the message invalid, unsent.
	 */
	sendWidgetEventOccurrence(message: WidgetEventOccurrenceMessage): BridgeSendResult {
		const decoded = validateWidgetEventMessage(message, 'send')
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'widget.event.occurrence') return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends one `failure.report`; nothing crosses before the capability ACK, and only a generation
	 * that declared `failure.reports` may send one. At most one generation-scoped report goes out
	 * per generation, after which nothing else does, and one work-scoped report per `sequence`
	 * (Clause 01a11a70-4261-7155-8aed-28bed7a89064). The decoder admits only the categories and
	 * reasons a runtime may report.
	 */
	sendFailureReport(message: FailureReportMessage): BridgeSendResult {
		const decoded = validateFailureReportMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		if (!this.declaration.features.includes(FAILURE_REPORTS_FEATURE)) return { status: 'not-permitted' }
		const sequence = decoded.value.payload.sequence
		if (failureReportScope(decoded.value) === 'work') {
			if (sequence === undefined || this.reportedWorkSequences.has(sequence)) return { status: 'not-permitted' }
			this.reportedWorkSequences.add(sequence)
		}
		else this.generationEnded = true
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Sends one `checks.report`; nothing crosses before the capability ACK, and only a generation
	 * that declared `checks.reports` may send one. A report whose `sequence` is not higher than the
	 * last one sent is not sent (Clause 01a17619-ab3f-797d-ae93-4038a48ee31f), and a generation that
	 * ended with a `failure.report` sends nothing more.
	 */
	sendChecksReport(message: ChecksReportMessage): BridgeSendResult {
		const decoded = validateChecksReportMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		if (!this.declaration.features.includes(CHECKS_REPORTS_FEATURE)) return { status: 'not-permitted' }
		const { sequence } = decoded.value.payload
		if (this.lastChecksSequence !== undefined && sequence <= this.lastChecksSequence) return { status: 'not-permitted' }
		this.lastChecksSequence = sequence
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	/**
	 * Reports an established violation in the Workbench's traffic as a generation-scoped
	 * `protocol.invalid_message`: an envelope of this session and generation, which therefore is no
	 * stale traffic (Clause 01a11a70-4261-7155-8aed-28bed7a89064), that failed to decode. The detail
	 * names the decoder's diagnostic codes only, never the payload.
	 */
	reportInvalidTraffic(input: unknown, diagnostics: readonly Diagnostic[]): BridgeSendResult {
		const correlation = envelopeCorrelation(input)
		if (correlation?.previewSessionId !== this.previewSessionId || correlation.runtimeGenerationId !== this.runtimeGenerationId)
			return { status: 'not-permitted' }
		// An unknown message type is an additive one the runtime does not know: it is dropped without
		// effect and never fails the generation (Rule 01a11a59-d728-751f-bbac-287a77b75610).
		// Its other diagnostics (a context the known types would require) are artifacts of the guess.
		if (diagnostics.some(diagnostic => diagnostic.code === 'protocol.unknown_message_type'))
			return { status: 'not-permitted' }
		const detail = [...new Set(diagnostics.map(diagnostic => diagnostic.code))].join(', ').slice(0, 200)
		return this.sendFailureReport({
			type: 'failure.report',
			context: { previewSessionId: this.previewSessionId, runtimeGenerationId: this.runtimeGenerationId },
			payload: { category: 'protocol', reason: 'protocol.invalid_message', ...(detail ? { detail } : {}) },
		})
	}

	/**
	 * Reports an established violation of the generation's state in the Workbench's traffic, as a
	 * generation-scoped `protocol.invalid_state` (Clause 01a11a70-4261-7155-8aed-28bed7a89064): what
	 * `receive` returned as `invalid-state`. A report before the acknowledgement is held and sent
	 * once it arrives, because the runtime completes the handshake first.
	 */
	reportInvalidState(detail: string): BridgeSendResult {
		return this.reportGenerationFailure('protocol', 'protocol.invalid_state', detail)
	}

	/**
	 * Reports that the runtime itself failed for good, as a generation-scoped `runtime.unavailable`
	 * (Clause 01a11a70-4261-7155-8aed-28bed7a89064). The detail names a kind of failure, never an
	 * exception's message or stack.
	 */
	reportRuntimeUnavailable(detail?: string): BridgeSendResult {
		return this.reportGenerationFailure('runtime', 'runtime.unavailable', detail)
	}

	sendGeometry(message: GeometryResponseMessage): BridgeSendResult {
		const decoded = validateGeometryMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryResponse(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		this.transport.send(decoded.value)
		return { status: 'sent' }
	}

	snapshot() {
		return Object.freeze({
			previewSessionId: this.previewSessionId,
			runtimeGenerationId: this.runtimeGenerationId,
			ackObserved: this.ackObserved,
		})
	}

	private receiveAcknowledgement(input: unknown): BridgeReceiveResult {
		const decoded = validateCapabilityMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (decoded.value.type !== 'capability.ack') return { status: 'wrong-direction' }
		if (decoded.value.context.previewSessionId !== this.previewSessionId) return { status: 'stale-session' }
		if (decoded.value.context.runtimeGenerationId !== this.runtimeGenerationId) return { status: 'stale-generation' }
		this.ackObserved = true
		const held = this.heldReport
		this.heldReport = undefined
		if (held) this.sendFailureReport(held)
		const heldMounted = this.heldMounted
		this.heldMounted = undefined
		if (heldMounted) this.sendBaseStateMounted(heldMounted)
		return { status: 'accepted', message: decoded.value }
	}

	/** A generation-scoped report; the one a generation sends is held until its acknowledgement when it comes before. */
	private reportGenerationFailure(category: 'runtime' | 'protocol', reason: string, detail?: string): BridgeSendResult {
		const bounded = detail?.slice(0, 200)
		const message: FailureReportMessage = {
			type: 'failure.report',
			context: { previewSessionId: this.previewSessionId, runtimeGenerationId: this.runtimeGenerationId },
			payload: { category, reason, ...(bounded ? { detail: bounded } : {}) },
		}
		if (!this.ackObserved && !this.generationEnded && !this.heldReport && this.declaration.features.includes(FAILURE_REPORTS_FEATURE)) {
			const decoded = validateFailureReportMessage(message)
			if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
			this.heldReport = decoded.value
			return { status: 'gated' }
		}
		return this.sendFailureReport(message)
	}

	/** A traffic result for a message that the runtime gate refused: before the acknowledgement it is out of order, an established violation. */
	private gated(gate: 'gated' | 'stale-session' | 'stale-generation', type: string): BridgeReceiveResult {
		if (gate === 'gated' && !this.ackObserved) return { status: 'invalid-state', detail: `${type} before capability.ack` }
		return { status: gate }
	}

	private runtimeGate(message: GeometryMessage | TargetingMessage | WidgetEventMessage | FailureReportMessage | ChecksReportMessage | BaseStateMessage): 'gated' | 'stale-session' | 'stale-generation' | undefined {
		if (message.context.previewSessionId !== this.previewSessionId) return 'stale-session'
		if (message.context.runtimeGenerationId !== this.runtimeGenerationId) return 'stale-generation'
		if (!this.ackObserved || this.generationEnded) return 'gated'
		return undefined
	}
}

function isGeometryRequest(message: GeometryMessage): message is GeometryRequestMessage {
	return message.type === 'geometry.acquire.request'
		|| message.type === 'geometry.release'
		|| message.type === 'geometry.reveal'
		|| message.type === 'contour.full.request'
		|| message.type === 'contour.partial.request'
		|| message.type === 'contour.cancel'
}

function isGeometryResponse(message: GeometryMessage): message is GeometryResponseMessage {
	return message.type === 'geometry.acquire.response'
		|| message.type === 'contour.full.response'
		|| message.type === 'contour.partial.response'
}

/** Whether an envelope, before any decode, is a `capability.declare`. */
export function isCapabilityDeclaration(input: unknown): boolean {
	return messageType(input) === 'capability.declare'
}

/** Whether an envelope, before any decode, is a `failure.report`. */
export function isFailureReport(input: unknown): boolean {
	return messageType(input) === 'failure.report'
}

/** Whether an envelope, before any decode, is a `checks.report`. */
export function isChecksReport(input: unknown): boolean {
	return messageType(input) === 'checks.report'
}

/** The `runtimeGenerationId` an envelope's context names, read without decoding the message. */
export function envelopeGenerationId(input: unknown): string | undefined {
	return envelopeCorrelation(input)?.runtimeGenerationId
}

/** The `requestId` of an envelope's payload, read without decoding, when it is a non-empty string. */
function rawRequestId(input: unknown): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
	const payload = (input as Record<string, unknown>).payload
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined
	const requestId = Object.getOwnPropertyDescriptor(payload, 'requestId')?.value
	return typeof requestId === 'string' && requestId ? requestId : undefined
}

function messageType(input: unknown): string | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
	const type = (input as Record<string, unknown>).type
	return typeof type === 'string' ? type : undefined
}

/**
 * Reads only an envelope's session and generation identities, before any schema decode, so a
 * receiver can check correlation outermost first. An identity that is missing or not a non-empty
 * string is left to the full decode, which then judges the envelope.
 */
function envelopeCorrelation(input: unknown): Readonly<{ previewSessionId: string; runtimeGenerationId?: string }> | undefined {
	if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined
	const context = (input as Record<string, unknown>).context
	if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined
	const { previewSessionId, runtimeGenerationId } = context as Record<string, unknown>
	if (typeof previewSessionId !== 'string' || !previewSessionId) return undefined
	return typeof runtimeGenerationId === 'string' && runtimeGenerationId
		? { previewSessionId, runtimeGenerationId }
		: { previewSessionId }
}

function cloneDeclaration(value: CapabilityDeclareMessage['payload']): CapabilityDeclareMessage['payload'] {
	return Object.freeze({ protocolVersion: value.protocolVersion, features: Object.freeze([...value.features]) })
}

function assertOpaqueId(value: string, name: string): void {
	if (!value) throw new TypeError(`${name} must be a non-empty opaque identity.`)
}
