import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import type {
	CapabilityAckMessage,
	CapabilityDeclareMessage,
	GeometryAcquireRequest,
	GeometryAcquireResponse,
} from '../src/preview/protocol/schema'

const compatible = { ok: true } as const
const declaration = { protocolVersion: 1, features: ['geometry', 'contour'] } as const

describe('Preview protocol bridge', () => {
	it('keeps runtime geometry gated until the matching Workbench ACK is actually received', () => {
		const workbenchOutbound: PreviewWireMessage[] = []
		const runtimeOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', declaration, collector(runtimeOutbound))
		expect(workbench.admitGeneration('generation-a', 'initial').status).toBe('admitted')

		const response = acquireResponse()
		expect(runtime.sendGeometry(response)).toEqual({ status: 'gated' })
		expect(workbench.receive(response)).toEqual({ status: 'gated' })

		const sentDeclaration = runtime.declareCapabilities()
		expect(runtimeOutbound).toEqual([sentDeclaration])
		const accepted = workbench.receive(sentDeclaration)
		expect(accepted.status).toBe('ack-dispatched')
		expect(workbench.snapshot()).toMatchObject({
			ackDispatchedGenerationId: 'generation-a',
			session: { currentGenerationPhase: 'open' },
		})
		expect(workbenchOutbound).toHaveLength(1)
		expect(workbenchOutbound[0]).toMatchObject({
			type: 'capability.ack',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
			payload: {},
		})

		// Workbench has dispatched ACK, but runtime has not observed it yet.
		expect(runtime.snapshot().ackObserved).toBe(false)
		expect(runtime.sendGeometry(response)).toEqual({ status: 'gated' })
		expect(runtime.receive(workbenchOutbound[0])).toMatchObject({ status: 'accepted' })
		expect(runtime.snapshot().ackObserved).toBe(true)
		expect(runtime.sendGeometry(response)).toEqual({ status: 'sent' })
		expect(runtimeOutbound.at(-1)).toEqual(response)
		expect(workbench.receive(response)).toMatchObject({ status: 'accepted', message: response })
	})

	it('allows ordered Workbench requests only after ACK dispatch while runtime still independently enforces ACK observation', () => {
		const workbenchOutbound: PreviewWireMessage[] = []
		const runtimeOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', declaration, collector(runtimeOutbound))
		workbench.admitGeneration('generation-a', 'initial')
		const request = acquireRequest()
		expect(workbench.sendGeometry(request)).toEqual({ status: 'gated' })

		workbench.receive(runtime.declareCapabilities())
		expect(workbench.sendGeometry(request)).toEqual({ status: 'sent' })
		expect(runtime.receive(request)).toEqual({ status: 'gated' })
		expect(runtime.receive(workbenchOutbound[0])).toMatchObject({ status: 'accepted' })
		expect(runtime.receive(request)).toMatchObject({ status: 'accepted', message: request })
	})

	it('does not open the Workbench gate when ACK transport dispatch fails and can retry the pinned declaration', () => {
		let fail = true
		const outbound: PreviewWireMessage[] = []
		const transport: PreviewProtocolTransport = {
			send(message) {
				if (fail) throw new Error('channel down')
				outbound.push(message)
			},
		}
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', transport, () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		expect(() => workbench.receive(capabilityDeclaration())).toThrow('channel down')
		expect(workbench.snapshot()).toEqual({
			session: expect.objectContaining({ currentGenerationPhase: 'awaiting-ack' }),
		})
		expect(workbench.receive(acquireResponse())).toEqual({ status: 'gated' })

		fail = false
		expect(workbench.receive(capabilityDeclaration()).status).toBe('ack-dispatched')
		expect(outbound).toHaveLength(1)
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationPhase: 'open' })
	})

	it('retransmits an identical declaration ACK idempotently without resetting the open generation', () => {
		const workbenchOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		const message = capabilityDeclaration()
		expect(workbench.receive(message).status).toBe('ack-dispatched')
		expect(workbench.receive({
			...message,
			payload: { protocolVersion: 1, features: ['contour', 'geometry'] },
		}).status).toBe('ack-dispatched')
		expect(workbenchOutbound).toHaveLength(2)
		expect(workbench.snapshot().session).toMatchObject({
			currentGenerationId: 'generation-a',
			currentGenerationPhase: 'open',
		})
	})

	it('invalidates a generation when its pinned capability set changes after ACK', () => {
		const outbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		workbench.receive(capabilityDeclaration())
		const conflict = workbench.receive({
			...capabilityDeclaration(),
			payload: { protocolVersion: 1, features: ['geometry'] },
		})
		expect(conflict).toEqual({ status: 'capability-conflict' })
		expect(workbench.receive(acquireResponse())).toEqual({ status: 'stale-generation' })
		expect(workbench.snapshot()).not.toHaveProperty('ackDispatchedGenerationId')
	})

	it('does not ACK incompatible capabilities and keeps geometry ineligible', () => {
		const outbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge(
			'session-a', collector(outbound),
			() => ({ ok: false, reason: 'capability.missing_required_feature' }),
		)
		workbench.admitGeneration('generation-a', 'initial')
		expect(workbench.receive(capabilityDeclaration())).toEqual({
			status: 'capability-failure', reason: 'capability.missing_required_feature',
		})
		expect(outbound).toEqual([])
		expect(workbench.receive(acquireResponse())).toEqual({ status: 'stale-generation' })
	})

	it('applies session then generation freshness and rejects messages travelling in the wrong direction', () => {
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), () => compatible)
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', declaration, collector([]))
		workbench.admitGeneration('generation-a', 'initial')

		expect(workbench.receive(capabilityAck())).toEqual({ status: 'wrong-direction' })
		expect(runtime.receive(capabilityDeclaration())).toEqual({ status: 'wrong-direction' })
		expect(workbench.receive({
			...capabilityDeclaration(), context: { previewSessionId: 'session-b', runtimeGenerationId: 'generation-a' },
		})).toEqual({ status: 'stale-session' })
		expect(runtime.receive({
			...capabilityAck(), context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-old' },
		})).toEqual({ status: 'stale-generation' })
	})

	it('rejects malformed wire data before bridge state changes', () => {
		const outbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		const result = workbench.receive({
			type: 'capability.declare',
			context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
			payload: { protocolVersion: 1, features: ['geometry', 'geometry'] },
		})
		expect(result.status).toBe('invalid')
		expect(outbound).toEqual([])
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationPhase: 'bootstrap' })
	})

	it('resets the automatic recovery budget only after the recovery generation ACK is dispatched', () => {
		const outbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		workbench.receive(capabilityDeclaration())
		expect(workbench.receive({
			...capabilityDeclaration(),
			payload: { protocolVersion: 2, features: ['geometry', 'contour'] },
		})).toEqual({ status: 'capability-conflict' })
		expect(workbench.snapshot().session).toMatchObject({ recoveryNeeded: true, automaticRecoveryUsed: false })

		expect(workbench.admitGeneration('generation-b', 'automatic-recovery').status).toBe('admitted')
		expect(workbench.snapshot().session).toMatchObject({ automaticRecoveryUsed: true, recoveryNeeded: false })
		workbench.receive(capabilityDeclaration('generation-b'))
		expect(workbench.snapshot().session).toMatchObject({
			currentGenerationPhase: 'open', automaticRecoveryUsed: false, recoveryExhausted: false, recoveryNeeded: false,
		})
	})
})

function collector(messages: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send(message) { messages.push(message) } }
}

function capabilityDeclaration(runtimeGenerationId = 'generation-a'): CapabilityDeclareMessage {
	return {
		type: 'capability.declare',
		context: { previewSessionId: 'session-a', runtimeGenerationId },
		payload: { protocolVersion: 1, features: ['geometry', 'contour'] },
	}
}

function capabilityAck(): CapabilityAckMessage {
	return {
		type: 'capability.ack',
		context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' },
		payload: {},
	}
}

function acquireRequest(): GeometryAcquireRequest {
	return {
		type: 'geometry.acquire.request',
		context: {
			previewSessionId: 'session-a', runtimeGenerationId: 'generation-a',
			viewId: '11111111-1111-4111-8111-111111111111', widgetId: 'widget-a',
		},
		payload: {},
	}
}

function acquireResponse(): GeometryAcquireResponse {
	return {
		type: 'geometry.acquire.response',
		context: {
			previewSessionId: 'session-a', runtimeGenerationId: 'generation-a',
			viewId: '11111111-1111-4111-8111-111111111111', widgetId: 'widget-a', geometryRevision: 1,
		},
		payload: { rect: { x: 0, y: 0, width: 100, height: 50 }, regions: [] },
	}
}
