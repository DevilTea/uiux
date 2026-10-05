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
	PreviewProtocolSession,
	type CapabilityCompatibility,
	type GenerationAdmissionCause,
	type GenerationAdmissionResult,
} from './session'

export type PreviewWireMessage = CapabilityDeclareMessage | CapabilityAckMessage | GeometryMessage
export type PreviewProtocolTransport = Readonly<{ send(message: PreviewWireMessage): void }>

export type BridgeReceiveResult =
	| Readonly<{ status: 'accepted'; message: PreviewWireMessage }>
	| Readonly<{ status: 'ack-dispatched'; acknowledgement: CapabilityAckMessage }>
	| Readonly<{ status: 'capability-failure'; reason: `capability.${string}` }>
	| Readonly<{ status: 'capability-conflict' | 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

export type BridgeSendResult =
	| Readonly<{ status: 'sent' }>
	| Readonly<{ status: 'gated' | 'stale-session' | 'stale-generation' | 'wrong-direction' }>
	| Readonly<{ status: 'invalid'; diagnostics: readonly Diagnostic[] }>

export class WorkbenchPreviewProtocolBridge {
	private readonly session: PreviewProtocolSession
	private readonly transport: PreviewProtocolTransport
	private readonly evaluateCapabilities: (declaration: CapabilityDeclareMessage['payload']) => CapabilityCompatibility
	private ackDispatchedGenerationId?: string

	constructor(
		previewSessionId: string,
		transport: PreviewProtocolTransport,
		evaluateCapabilities: (declaration: CapabilityDeclareMessage['payload']) => CapabilityCompatibility,
	) {
		this.session = new PreviewProtocolSession(previewSessionId)
		this.transport = transport
		this.evaluateCapabilities = evaluateCapabilities
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

	receive(input: unknown): BridgeReceiveResult {
		const type = messageType(input)
		if (type === 'capability.declare') return this.receiveCapabilityDeclaration(input)
		if (type === 'capability.ack') return { status: 'wrong-direction' }

		const decoded = validateGeometryMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryResponse(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.workbenchInboundGate(decoded.value)
		if (gate) return { status: gate }
		return { status: 'accepted', message: decoded.value }
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
		if (type === 'capability.ack') return this.receiveAcknowledgement(input)

		const decoded = validateGeometryMessage(input)
		if (!decoded.ok) return { status: 'invalid', diagnostics: decoded.diagnostics }
		if (!isGeometryRequest(decoded.value)) return { status: 'wrong-direction' }
		const gate = this.runtimeGate(decoded.value)
		if (gate) return { status: gate }
		return { status: 'accepted', message: decoded.value }
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

	private runtimeGate(message: GeometryMessage): 'gated' | 'stale-session' | 'stale-generation' | undefined {
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

function cloneDeclaration(value: CapabilityDeclareMessage['payload']): CapabilityDeclareMessage['payload'] {
	return Object.freeze({ protocolVersion: value.protocolVersion, features: Object.freeze([...value.features]) })
}

function assertOpaqueId(value: string, name: string): void {
	if (!value) throw new TypeError(`${name} must be a non-empty opaque identity.`)
}
