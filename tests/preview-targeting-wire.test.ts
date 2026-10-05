import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import { validateTargetingMessage, type TargetingMessage } from '../src/preview/protocol/targeting'

/**
 * Targeting in the accepted protocol envelope (Part 3 implementation-recovery group, item 2):
 * five `targeting.*` types, mandatory session / generation / interaction identity, and the
 * bridge's session, generation and capability-ACK gates.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID } as const

function collector(target: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send: message => target.push(message) }
}

function codes(input: unknown): string[] {
	const result = validateTargetingMessage(input)
	return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}

describe('targeting wire messages', () => {
	it('accepts the five types as specified', () => {
		const messages: TargetingMessage[] = [
			{ type: 'targeting.enter', context, payload: { targetingInteractionId: 'i-1', purpose: 'comment-range' } },
			{ type: 'targeting.exit', context: { ...context, variantId: 'compact' }, payload: {} },
			{ type: 'targeting.hover', context: { ...context, widgetId: 'btn' }, payload: { targetingInteractionId: 'i-1', pointerType: 'mouse' } },
			{ type: 'targeting.hover', context, payload: { targetingInteractionId: 'i-1' } },
			{ type: 'targeting.select', context: { ...context, widgetId: 'btn' }, payload: { targetingInteractionId: 'i-1', point: { x: 12.5, y: 40 } } },
			{ type: 'targeting.select', context: { ...context, widgetId: 'btn' }, payload: { targetingInteractionId: 'i-1' } },
			{ type: 'targeting.escape', context, payload: { targetingInteractionId: 'i-1' } },
		]
		for (const message of messages) expect(codes(message), message.type).toEqual([])
	})

	it('makes session, generation and interaction identity mandatory', () => {
		expect(codes({ type: 'targeting.select', context: { ...context, widgetId: 'btn' }, payload: {} })).toContain('protocol.missing_interaction_identity')
		expect(codes({ type: 'targeting.escape', context: { runtimeGenerationId: 'g', viewId: VIEW_ID }, payload: { targetingInteractionId: 'i' } })).toContain('protocol.missing_context_identity')
		expect(codes({ type: 'targeting.hover', context: { previewSessionId: 's', viewId: VIEW_ID }, payload: { targetingInteractionId: 'i' } })).toContain('protocol.missing_context_identity')
		expect(codes({ type: 'targeting.select', context, payload: { targetingInteractionId: 'i' } })).toContain('protocol.missing_context_identity')
		// purpose is required on enter; no default.
		expect(codes({ type: 'targeting.enter', context, payload: { targetingInteractionId: 'i' } })).toContain('protocol.invalid_targeting_purpose')
	})

	it('keeps the context key set closed and forbids navigation and geometry revisions', () => {
		expect(codes({ type: 'targeting.select', context: { ...context, widgetId: 'b', targetingInteractionId: 'i' }, payload: { targetingInteractionId: 'i' } })).toContain('schema.unknown_field')
		expect(codes({ type: 'targeting.hover', context: { ...context, navigationRequestId: 'n' }, payload: { targetingInteractionId: 'i' } })).toContain('schema.unknown_field')
		expect(codes({ type: 'targeting.select', context: { ...context, widgetId: 'b', geometryRevision: 1 }, payload: { targetingInteractionId: 'i' } })).toContain('schema.unknown_field')
		expect(codes({ type: 'targeting.escape', context: { ...context, widgetId: 'b' }, payload: { targetingInteractionId: 'i' } })).toContain('schema.unknown_field')
		expect(codes({ type: 'targeting.hover', context, payload: { targetingInteractionId: 'i', pointerType: 'touch' } })).toContain('protocol.invalid_pointer_type')
		expect(codes({ type: 'targeting.select', context: { ...context, widgetId: 'b' }, payload: { targetingInteractionId: 'i', point: { x: Number.NaN, y: 1 } } })).not.toEqual([])
		expect(codes({ type: 'targeting.select', context: { ...context, viewId: 'not-a-uuid', widgetId: 'b' }, payload: { targetingInteractionId: 'i' } })).not.toEqual([])
	})
})

describe('targeting through the protocol bridges', () => {
	function connected() {
		const workbenchOut: PreviewWireMessage[] = []
		const runtimeOut: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOut), () => ({ ok: true }))
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features: ['geometry'] }, collector(runtimeOut))
		workbench.admitGeneration('generation-a', 'initial')
		return { workbench, runtime, workbenchOut, runtimeOut }
	}

	const select: TargetingMessage = { type: 'targeting.select', context: { ...context, widgetId: 'btn' }, payload: { targetingInteractionId: 'i-1', point: { x: 1, y: 2 } } }
	const enter: TargetingMessage = { type: 'targeting.enter', context, payload: { targetingInteractionId: 'i-1', purpose: 'inspection' } }

	it('gates targeting until the capability ACK, then delivers it in both directions', () => {
		const { workbench, runtime, workbenchOut, runtimeOut } = connected()
		expect(runtime.sendTargeting(select)).toEqual({ status: 'gated' })
		expect(workbench.sendTargeting(enter)).toEqual({ status: 'gated' })
		expect(workbench.receive(select)).toEqual({ status: 'gated' })

		workbench.receive(runtime.declareCapabilities())
		runtime.receive(workbenchOut.at(-1))
		expect(workbench.sendTargeting(enter)).toEqual({ status: 'sent' })
		expect(runtime.receive(workbenchOut.at(-1))).toEqual({ status: 'accepted', message: enter })
		expect(runtime.sendTargeting(select)).toEqual({ status: 'sent' })
		expect(workbench.receive(runtimeOut.at(-1))).toEqual({ status: 'accepted', message: select })
	})

	it('rejects stale sessions and generations, wrong directions and invalid messages', () => {
		const { workbench, runtime, workbenchOut } = connected()
		workbench.receive(runtime.declareCapabilities())
		runtime.receive(workbenchOut.at(-1))
		expect(workbench.receive({ ...select, context: { ...select.context, previewSessionId: 'other' } })).toEqual({ status: 'stale-session' })
		expect(workbench.receive({ ...select, context: { ...select.context, runtimeGenerationId: 'old' } })).toEqual({ status: 'stale-generation' })
		expect(workbench.receive(enter)).toEqual({ status: 'wrong-direction' })
		expect(runtime.receive(select)).toEqual({ status: 'wrong-direction' })
		expect(workbench.receive({ ...select, payload: {} })).toMatchObject({ status: 'invalid' })
		expect(runtime.receive({ ...enter, payload: { targetingInteractionId: 'i-2' } })).toMatchObject({ status: 'invalid' })
	})
})
