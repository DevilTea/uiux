import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import { createRuntimeGenerationId } from '../src/preview/protocol/generation-id'
import {
	MAX_TRACKED_WIDGETS,
	MULTI_TARGET_GEOMETRY_FEATURE,
	validateGeometryMessage,
} from '../src/preview/protocol/schema'
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

	it('carries geometry.release Workbench → runtime under the acquire context, gated like every request', () => {
		expect(MULTI_TARGET_GEOMETRY_FEATURE).toBe('geometry.multi-target')
		expect(MAX_TRACKED_WIDGETS).toBe(64)
		const workbenchOutbound: PreviewWireMessage[] = []
		const runtimeOutbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOutbound), () => compatible)
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features: ['geometry', MULTI_TARGET_GEOMETRY_FEATURE] }, collector(runtimeOutbound))
		workbench.admitGeneration('generation-a', 'initial')
		const release = { type: 'geometry.release', context: { ...acquireRequest().context, navigationRequestId: 'stream-1' }, payload: {} } as const
		expect(workbench.sendGeometry(release)).toEqual({ status: 'gated' })
		workbench.receive(runtime.declareCapabilities())
		expect(workbench.sendGeometry(release)).toEqual({ status: 'sent' })
		runtime.receive(workbenchOutbound[0])
		expect(runtime.receive(release)).toMatchObject({ status: 'accepted', message: release })
		// Release travels only Workbench → runtime.
		expect(workbench.receive(release)).toEqual({ status: 'wrong-direction' })
		expect(runtime.sendGeometry(release as never)).toEqual({ status: 'wrong-direction' })
		// Unknown additive payload fields are ignored; geometryRevision and a missing stream identity are not.
		expect(validateGeometryMessage({ ...release, payload: { reason: 'filter' } }).ok).toBe(true)
		expect(validateGeometryMessage({ ...release, context: { ...release.context, geometryRevision: 3 } }).ok).toBe(false)
		const withoutStream: Record<string, unknown> = { ...release.context }
		delete withoutStream.navigationRequestId
		expect(validateGeometryMessage({ ...release, context: withoutStream }).ok).toBe(false)
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

	// Issue #136: a message of the replaced, acknowledged generation that is still in flight when the
	// new generation's handshake starts must be discarded as stale, even when it would not decode.
	it('discards an undecodable message of the replaced generation during the new handshake', () => {
		const outbound: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		expect(workbench.receive(capabilityDeclaration('generation-a')).status).toBe('ack-dispatched')

		// The runtime of generation-a posted these just before the Workbench replaced the generation.
		const unknownType = { type: 'geometry.future', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }, payload: {} }
		const malformedResponse = { ...acquireResponse(), payload: { rect: 'not-a-rect' } }
		const malformedDeclaration = { ...capabilityDeclaration('generation-a'), payload: { protocolVersion: 'one' } }
		expect(workbench.replaceGenerationForLifecycle('generation-b', 'reload').status).toBe('admitted')

		for (const stale of [unknownType, malformedResponse, malformedDeclaration])
			expect(workbench.receive(stale)).toEqual({ status: 'stale-generation' })
		// A message of another Preview session is stale before its generation is even read.
		expect(workbench.receive({ ...unknownType, context: { previewSessionId: 'session-old', runtimeGenerationId: 'generation-b' } }))
			.toEqual({ status: 'stale-session' })
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-b', currentGenerationPhase: 'bootstrap', recoveryNeeded: false })

		expect(workbench.receive(capabilityDeclaration('generation-b')).status).toBe('ack-dispatched')
		expect(outbound.map(message => message.context.runtimeGenerationId)).toEqual(['generation-a', 'generation-b'])
	})

	it('still rejects an undecodable message of the current generation as invalid', () => {
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), () => compatible)
		workbench.admitGeneration('generation-a', 'initial')
		const unknownType = { type: 'geometry.future', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }, payload: {} }
		expect(workbench.receive(unknownType).status).toBe('invalid')
		// An envelope whose identities cannot be read is judged by the full decode, never as stale.
		expect(workbench.receive({ type: 'geometry.future', context: { previewSessionId: 'session-a' }, payload: {} }).status).toBe('invalid')
		expect(workbench.receive({ type: 'geometry.future', context: { previewSessionId: 7, runtimeGenerationId: 'generation-old' }, payload: {} }).status).toBe('invalid')
		expect(workbench.receive({ type: 'geometry.future', payload: {} }).status).toBe('invalid')
		expect(workbench.receive(capabilityDeclaration('generation-a')).status).toBe('ack-dispatched')
		expect(workbench.receive(unknownType).status).toBe('invalid')
	})

	it('discards an undecodable message of another generation on the runtime side', () => {
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-b', declaration, collector([]))
		const unknownType = { type: 'geometry.future', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' }, payload: {} }
		expect(runtime.receive(unknownType)).toEqual({ status: 'stale-generation' })
		expect(runtime.receive({ ...unknownType, context: { previewSessionId: 'session-old', runtimeGenerationId: 'generation-b' } })).toEqual({ status: 'stale-session' })
		expect(runtime.receive({ ...unknownType, context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-b' } }).status).toBe('invalid')
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

// Issue #102: the runtime mints every generation ID (Clause 01a1161c-4119-712d-8785-7d8155c0ceee); a
// reloaded document or restarted runtime is a new generation (Clause 01a1161c-4339-7614-ba65-6f21e37cd1a0),
// and a retired one is never revived (Clause 01a1161c-4154-7de9-9dc5-622d21438a47).
describe('Runtime-minted generation IDs', () => {
	function workbenchWithHook(outbound: PreviewWireMessage[] = []) {
		const admitted: string[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), () => compatible, {
			onGenerationAdmitted: generationId => admitted.push(generationId),
		})
		return { workbench, admitted, outbound }
	}

	it('mints a fresh opaque ID for every generation, from the given random source', () => {
		const ids = new Set(Array.from({ length: 64 }, () => createRuntimeGenerationId()))
		expect(ids.size).toBe(64)
		for (const id of ids) expect(id).toMatch(/^gen-[0-9a-f]{32}$/)
		const fixed = { getRandomValues: <T extends ArrayBufferView | null>(array: T): T => { (array as unknown as Uint8Array).fill(0xab); return array } }
		expect(createRuntimeGenerationId(fixed)).toBe(`gen-${'ab'.repeat(16)}`)
	})

	it('admits the generation the first declaration names, without any allocation by the Workbench', () => {
		const { workbench, admitted, outbound } = workbenchWithHook()
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', declaration, collector([]))
		expect(workbench.snapshot().session.currentGenerationId).toBeUndefined()
		// Traffic of a generation before its declaration is not admitted.
		expect(workbench.receive(acquireResponse())).toEqual({ status: 'stale-generation' })
		expect(admitted).toEqual([])

		expect(workbench.receive(runtime.declareCapabilities()).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a'])
		expect(outbound).toEqual([expect.objectContaining({ type: 'capability.ack', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a' } })])
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-a', currentGenerationPhase: 'open', retiredGenerationIds: [] })
		// A resent identical declaration is a duplicate of the same generation, not a new one.
		expect(workbench.receive(capabilityDeclaration('generation-a')).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a'])
	})

	it('treats a reloaded document as a new generation and retires the old one', () => {
		const { workbench, admitted, outbound } = workbenchWithHook()
		workbench.receive(capabilityDeclaration('generation-a'))
		expect(workbench.receive(acquireResponse()).status).toBe('accepted')

		// The document reloaded on its own: its runtime declares a generation the Workbench never saw.
		expect(workbench.receive(capabilityDeclaration('generation-b')).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a', 'generation-b'])
		expect(outbound.map(message => message.context.runtimeGenerationId)).toEqual(['generation-a', 'generation-b'])
		expect(workbench.snapshot().session).toMatchObject({
			currentGenerationId: 'generation-b', currentGenerationPhase: 'open', retiredGenerationIds: ['generation-a'], recoveryNeeded: false,
		})
		// Delayed traffic of the old generation is stale, never adopted by the new one.
		expect(workbench.receive(acquireResponse())).toEqual({ status: 'stale-generation' })
	})

	it('never revives a retired generation, even when its declaration arrives again', () => {
		const { workbench, admitted, outbound } = workbenchWithHook()
		workbench.receive(capabilityDeclaration('generation-a'))
		workbench.receive(capabilityDeclaration('generation-b'))
		const acknowledgements = outbound.length

		expect(workbench.receive(capabilityDeclaration('generation-a'))).toEqual({ status: 'stale-generation' })
		expect(workbench.receive({ ...capabilityDeclaration('generation-a'), payload: { protocolVersion: 'one' } })).toEqual({ status: 'stale-generation' })
		expect(outbound).toHaveLength(acknowledgements)
		expect(admitted).toEqual(['generation-a', 'generation-b'])
		expect(workbench.snapshot().session).toMatchObject({ currentGenerationId: 'generation-b', currentGenerationPhase: 'open' })
	})

	it('admits the next declared generation after the Workbench replaced the document itself', () => {
		const { workbench, admitted } = workbenchWithHook()
		workbench.receive(capabilityDeclaration('generation-a'))
		workbench.retireGeneration()
		expect(workbench.snapshot().session).toMatchObject({ retiredGenerationIds: ['generation-a'] })
		expect(workbench.snapshot().session.currentGenerationId).toBeUndefined()
		expect(workbench.receive(capabilityDeclaration('generation-a'))).toEqual({ status: 'stale-generation' })

		expect(workbench.receive(capabilityDeclaration('generation-b')).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a', 'generation-b'])
	})

	it('admits nothing for a malformed declaration of an unseen generation', () => {
		const { workbench, admitted } = workbenchWithHook()
		expect(workbench.receive({ ...capabilityDeclaration('generation-a'), payload: { protocolVersion: 'one' } }).status).toBe('invalid')
		expect(admitted).toEqual([])
		expect(workbench.snapshot().session.currentGenerationId).toBeUndefined()
	})

	it('refuses and retires a new generation while recovery is exhausted', () => {
		const admitted: string[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), payload => payload.protocolVersion === 1
			? compatible
			: { ok: false, reason: 'capability.unsupported_protocol_version' }, { onGenerationAdmitted: generationId => admitted.push(generationId) })
		// A capability failure leaves Preview unavailable until an explicit retry.
		expect(workbench.receive({ ...capabilityDeclaration('generation-a'), payload: { protocolVersion: 2, features: ['geometry'] } }).status).toBe('capability-failure')
		expect(workbench.snapshot().session).toMatchObject({ recoveryExhausted: true })

		expect(workbench.receive(capabilityDeclaration('generation-c'))).toEqual({ status: 'generation-refused', generationId: 'generation-c' })
		expect(admitted).toEqual(['generation-a'])
		expect(workbench.snapshot().session.retiredGenerationIds).toContain('generation-c')
		expect(workbench.receive(capabilityDeclaration('generation-c'))).toEqual({ status: 'stale-generation' })
	})
})

// Issue #111: Retry Preview spends the explicit retry authorization (Rules
// 01a1161c-3cf8-7859-9de8-2b99d22ce8aa, 01a1161c-3d31-7a69-9d64-cad14a8071bb,
// 01a1161c-3dad-7ac1-b49b-a77fcb1e33f2 and 01a1161c-3e28-7dcf-a06e-a2c12c83919c).
describe('Explicit retry through declared generations', () => {
	function versionGated(outbound: PreviewWireMessage[] = []) {
		const admitted: string[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(outbound), payload => payload.protocolVersion === 1
			? compatible
			: { ok: false, reason: 'capability.unsupported_protocol_version' }, { onGenerationAdmitted: generationId => admitted.push(generationId) })
		return { workbench, admitted, outbound }
	}
	const incompatible = (runtimeGenerationId: string) => ({ ...capabilityDeclaration(runtimeGenerationId), payload: { protocolVersion: 2, features: ['geometry'] } })

	it('admits the next declared generation as the authorized retry and reopens Preview', () => {
		const { workbench, admitted, outbound } = versionGated()
		expect(workbench.receive(incompatible('generation-a')).status).toBe('capability-failure')
		// Duplicate triggers join one authorization; no retry credit accumulates.
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.authorizeRetry()).toBe('coalesced')
		expect(workbench.snapshot().session).toMatchObject({ recoveryExhausted: true, retryAuthorizationPending: true })

		expect(workbench.receive(capabilityDeclaration('generation-b')).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a', 'generation-b'])
		expect(outbound).toEqual([expect.objectContaining({ type: 'capability.ack', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-b' } })])
		expect(workbench.snapshot().session).toMatchObject({
			currentGenerationId: 'generation-b', currentGenerationPhase: 'open', recoveryExhausted: false, retryAuthorizationPending: false,
		})
		// An open generation needs no retry.
		expect(workbench.authorizeRetry()).toBe('not-eligible')
	})

	it('spends the authorization at admission, so a retry that fails again needs a new one', () => {
		const { workbench, admitted } = versionGated()
		workbench.receive(incompatible('generation-a'))
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.receive(incompatible('generation-b')).status).toBe('capability-failure')
		expect(workbench.snapshot().session).toMatchObject({ recoveryExhausted: true, retryAuthorizationPending: false })

		// Without a new authorization the next generation is refused.
		expect(workbench.receive(capabilityDeclaration('generation-c'))).toEqual({ status: 'generation-refused', generationId: 'generation-c' })
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.receive(capabilityDeclaration('generation-d')).status).toBe('ack-dispatched')
		expect(admitted).toEqual(['generation-a', 'generation-b', 'generation-d'])
	})

	it('admits the retry only from an unseen generation, never by reviving a retired one', () => {
		const { workbench } = versionGated()
		workbench.receive(incompatible('generation-a'))
		expect(workbench.authorizeRetry()).toBe('authorized')
		expect(workbench.receive(capabilityDeclaration('generation-a'))).toEqual({ status: 'stale-generation' })
		expect(workbench.snapshot().session).toMatchObject({ retryAuthorizationPending: true })
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
