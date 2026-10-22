import type { Diagnostic } from '../../domain/validation'
import {
	validateCapabilityMessage,
	validateGeometryMessage,
	type CapabilityAckMessage,
	type CapabilityDeclareMessage,
	type GeometryMessage,
	type GeometryRequestMessage,
	type GeometryResponseMessage,
} from './schema'
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
	type CapabilityCompatibility,
	type GenerationAdmissionCause,
	type GenerationAdmissionResult,
} from './session'

export type PreviewWireMessage = CapabilityDeclareMessage | CapabilityAckMessage | GeometryMessage | TargetingMessage | WidgetEventMessage
export type PreviewProtocolTransport = Readonly<{ send(message: PreviewWireMessage): void }>

export type BridgeReceiveResult =
	| Readonly<{ status: 'accepted'; message: PreviewWireMessage }>
	| Readonly<{ status: 'ack-dispatched'; acknowledgement: CapabilityAckMessage }>
	| Readonly<{ status: 'capability-failure'; reason: `capability.${string}` }>
	| Readonly<{ status: 'capability-conflict' | 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' }>
	| Readonly<{ status: 'generation-refused'; generationId: string }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

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
	| Readonly<{ status: 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' }>
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
	 * unseen ID replaces the current generation. `admitGeneration` remains for callers that already
	 * know the runtime's ID.
	 */
	constructor(
		previewSessionId: string,
		transport: PreviewProtocolTransport,
		evaluateCapabilities: (declaration: CapabilityDeclareMessage['payload']) => CapabilityCompatibility,
		hooks: WorkbenchBridgeHooks = {},
	) {
		this.session = new PreviewProtocolSession(previewSessionId)
		this.transport = transport
		this.evaluateCapabilities = evaluateCapabilities
		this.hooks = hooks
	}

	admitGeneration(generationId: string, cause: GenerationAdmissionCause): GenerationAdmissionResult {
		const result = this.session.beginGeneration(generationId, cause)
		if (result.status === 'admitted') this.ackDispatchedGenerationId = undefined
		return result
	}

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

	sendGeometry(message: GeometryRequestMessage): BridgeSendResult {
		const decoded = validateGeometryMessage(message)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryRequest(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.workbenchOutboundGate(decoded.value)
		if (gate) return { status: gate }
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
		if (type === 'capability.declare') return { status: 'wrong-direction' }
		// Correlation before the full decode, as on the Workbench side.
		const correlation = envelopeCorrelation(input)
		if (correlation && correlation.previewSessionId !== this.previewSessionId) return { status: 'stale-session' }
		if (correlation?.runtimeGenerationId !== undefined && correlation.runtimeGenerationId !== this.runtimeGenerationId)
			return { status: 'stale-generation' }
		if (type === 'capability.ack') return this.receiveAcknowledgement(input)
		if (isTargetingMessageType(type)) {
			const targeting = validateTargetingMessage(input)
			if (!targeting.ok) return { status: 'invalid', diagnostics: targeting.diagnostics }
			if (isTargetingRuntimeMessage(targeting.value)) return { status: 'wrong-direction' }
			const gate = this.runtimeGate(targeting.value)
			if (gate) return { status: gate }
			return { status: 'accepted', message: targeting.value }
		}
		if (isWidgetEventMessageType(type)) {
			// The runtime accepts only arms inbound.
			const decoded = validateWidgetEventMessage(input)
			if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
			if (decoded.value.type !== 'widget.event.arm') return { status: 'wrong-direction' }
			const gate = this.runtimeGate(decoded.value)
			if (gate) return { status: gate }
			return { status: 'accepted', message: decoded.value }
		}

		const decoded = validateGeometryMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryRequest(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		return { status: 'accepted', message: decoded.value }
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
		return { status: 'accepted', message: decoded.value }
	}

	private runtimeGate(message: GeometryMessage | TargetingMessage | WidgetEventMessage): 'gated' | 'stale-session' | 'stale-generation' | undefined {
		if (message.context.previewSessionId !== this.previewSessionId) return 'stale-session'
		if (message.context.runtimeGenerationId !== this.runtimeGenerationId) return 'stale-generation'
		if (!this.ackObserved) return 'gated'
		return undefined
	}
}

function isGeometryRequest(message: GeometryMessage): message is GeometryRequestMessage {
	return message.type === 'geometry.acquire.request'
		|| message.type === 'geometry.release'
		|| message.type === 'contour.full.request'
		|| message.type === 'contour.partial.request'
		|| message.type === 'contour.cancel'
}

function isGeometryResponse(message: GeometryMessage): message is GeometryResponseMessage {
	return message.type === 'geometry.acquire.response'
		|| message.type === 'contour.full.response'
		|| message.type === 'contour.partial.response'
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
