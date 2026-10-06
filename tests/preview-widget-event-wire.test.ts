import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewProtocolTransport,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import { createPostMessageTransport } from '../src/preview/protocol/transport'
import {
	MAX_ARMED_TRIGGERS,
	validateWidgetEventMessage,
	WIDGET_EVENTS_FEATURE,
	type WidgetEventArmMessage,
	type WidgetEventOccurrenceMessage,
} from '../src/preview/protocol/widget-events'

/**
 * Widget Event reporting on the wire (Part 2 implementation-recovery group "Widget Event reporting",
 * decisions 3, 9 and 10): `widget.event.arm` and `widget.event.occurrence` in the accepted envelope,
 * and the bridges' session, generation, capability-ACK and direction gates.
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const context = { previewSessionId: 'session-a', runtimeGenerationId: 'generation-a', viewId: VIEW_ID } as const

const arm: WidgetEventArmMessage = {
	type: 'widget.event.arm',
	context,
	payload: { armId: 'arm-1', triggers: [{ widgetId: 'retry', event: 'click' }, { widgetId: 'done', event: 'click' }] },
}
const occurrence: WidgetEventOccurrenceMessage = {
	type: 'widget.event.occurrence',
	context: { ...context, widgetId: 'retry' },
	payload: { armId: 'arm-1', event: 'click' },
}

function codes(input: unknown, mode: 'receive' | 'send' = 'receive'): string[] {
	const result = validateWidgetEventMessage(input, mode)
	return result.ok ? [] : result.diagnostics.map(diagnostic => diagnostic.code)
}

function collector(target: PreviewWireMessage[]): PreviewProtocolTransport {
	return { send: message => target.push(message) }
}

describe('widget.event.* wire schema', () => {
	it('names the feature and keeps protocolVersion 1 semantics (no new version)', () => {
		expect(WIDGET_EVENTS_FEATURE).toBe('widget.events')
		expect(MAX_ARMED_TRIGGERS).toBe(256)
	})

	it('accepts both types, with and without a Variant, and an empty arm that disarms', () => {
		expect(codes(arm)).toEqual([])
		expect(codes(occurrence)).toEqual([])
		expect(codes({ ...arm, context: { ...context, variantId: 'error' } })).toEqual([])
		expect(codes({ ...occurrence, context: { ...occurrence.context, variantId: 'error' } })).toEqual([])
		expect(codes({ ...arm, payload: { armId: 'arm-2', triggers: [] } })).toEqual([])
	})

	it('requires session, generation, View and arm identity, and the occurrence Widget', () => {
		expect(codes({ ...arm, context: { runtimeGenerationId: 'g', viewId: VIEW_ID } })).toContain('protocol.missing_context_identity')
		expect(codes({ ...arm, context: { previewSessionId: 's', viewId: VIEW_ID } })).toContain('protocol.missing_context_identity')
		expect(codes({ ...arm, context: { previewSessionId: 's', runtimeGenerationId: 'g' } })).toContain('protocol.missing_context_identity')
		expect(codes({ ...occurrence, context })).toContain('protocol.missing_context_identity')
		expect(codes({ ...arm, payload: { triggers: [] } })).toContain('protocol.missing_arm_identity')
		expect(codes({ ...occurrence, payload: { event: 'click' } })).toContain('protocol.missing_arm_identity')
		expect(codes({ ...occurrence, payload: { armId: 'a' } })).toContain('protocol.missing_event_name')
		expect(codes({ ...arm, context: { ...context, viewId: 'not-a-uuid' } })).toContain('identity.invalid_uuid')
	})

	it('rejects empty strings', () => {
		expect(codes({ ...arm, payload: { armId: '', triggers: [] } })).toContain('schema.empty_string')
		expect(codes({ ...arm, payload: { armId: 'a', triggers: [{ widgetId: '', event: 'click' }] } })).toContain('schema.empty_string')
		expect(codes({ ...arm, payload: { armId: 'a', triggers: [{ widgetId: 'w', event: '' }] } })).toContain('schema.empty_string')
		expect(codes({ ...occurrence, payload: { armId: 'a', event: '' } })).toContain('schema.empty_string')
		expect(codes({ ...occurrence, context: { ...occurrence.context, widgetId: '' } })).toContain('schema.empty_string')
		expect(codes({ ...arm, context: { ...context, variantId: '' } })).toContain('schema.empty_string')
	})

	it('forbids widgetId on an arm, navigation and geometry identities, and payload identities in context', () => {
		expect(codes({ ...arm, context: { ...context, widgetId: 'retry' } })).toContain('protocol.inapplicable_context_identity')
		expect(codes({ ...arm, context: { ...context, navigationRequestId: 'n' } })).toContain('protocol.inapplicable_context_identity')
		expect(codes({ ...occurrence, context: { ...occurrence.context, geometryRevision: 1 } })).toContain('protocol.inapplicable_context_identity')
		expect(codes({ ...occurrence, context: { ...occurrence.context, armId: 'arm-1' } })).toContain('protocol.identity_in_wrong_envelope')
		expect(codes({ ...arm, context: { ...context, variantId: null } })).not.toEqual([])
	})

	it('rejects duplicate pairs and more than 256 triggers', () => {
		const pair = { widgetId: 'retry', event: 'click' }
		expect(codes({ ...arm, payload: { armId: 'a', triggers: [pair, { ...pair }] } })).toContain('protocol.duplicate_armed_trigger')
		const many = Array.from({ length: MAX_ARMED_TRIGGERS + 1 }, (_, index) => ({ widgetId: `w-${index}`, event: 'click' }))
		expect(codes({ ...arm, payload: { armId: 'a', triggers: many } })).toContain('protocol.too_many_armed_triggers')
		expect(codes({ ...arm, payload: { armId: 'a', triggers: many.slice(0, MAX_ARMED_TRIGGERS) } })).toEqual([])
		// Order carries no meaning; the same Widget may arm several Events.
		expect(codes({ ...arm, payload: { armId: 'a', triggers: [{ widgetId: 'w', event: 'b' }, { widgetId: 'w', event: 'a' }] } })).toEqual([])
	})

	it('ignores unknown additive fields on receive and drops them from the decoded copy', () => {
		const result = validateWidgetEventMessage({ ...occurrence, context: { ...occurrence.context, futureKey: 1 }, payload: { ...occurrence.payload, future: 'x' }, extra: true })
		expect(result.ok).toBe(true)
		if (!result.ok) return
		expect(result.value).toEqual(occurrence)
		expect(JSON.stringify(result.value)).not.toContain('future')
	})

	it('keeps the occurrence payload closed for senders', () => {
		for (const leak of [{ args: ['secret'] }, { argCount: 1 }, { target: '#btn' }, { x: 1, y: 2 }, { key: 'Enter' }, { value: 'typed' }, { at: 1 }])
			expect(codes({ ...occurrence, payload: { ...occurrence.payload, ...leak } }, 'send')).toContain('protocol.closed_payload_member')
		expect(codes({ ...occurrence, context: { ...occurrence.context, extra: 'x' } }, 'send')).toContain('protocol.closed_payload_member')
		expect(codes(occurrence, 'send')).toEqual([])
	})

	it('still decodes an unknown type as protocol.unknown_message_type', () => {
		expect(codes({ type: 'widget.event.log', context, payload: {} })).toEqual(['protocol.unknown_message_type'])
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector([]), () => ({ ok: true }))
		const result = workbench.receive({ type: 'widget.event.replay', context, payload: {} })
		expect(result.status).toBe('invalid')
		if (result.status === 'invalid') expect(result.diagnostics.map(item => item.code)).toContain('protocol.unknown_message_type')
	})
})

describe('widget.event.* through the protocol bridges', () => {
	function connected(features: readonly string[] = ['geometry', WIDGET_EVENTS_FEATURE]) {
		const workbenchOut: PreviewWireMessage[] = []
		const runtimeOut: PreviewWireMessage[] = []
		const workbench = new WorkbenchPreviewProtocolBridge('session-a', collector(workbenchOut), () => ({ ok: true }))
		const runtime = new RuntimePreviewProtocolBridge('session-a', 'generation-a', { protocolVersion: 1, features }, collector(runtimeOut))
		workbench.admitGeneration('generation-a', 'initial')
		return { workbench, runtime, workbenchOut, runtimeOut }
	}

	function handshake(parts: ReturnType<typeof connected>): void {
		const declaration = parts.runtime.declareCapabilities()
		expect(parts.workbench.receive(declaration).status).toBe('ack-dispatched')
		expect(parts.runtime.receive(parts.workbenchOut.at(-1)).status).toBe('accepted')
	}

	it('gates an arm and an occurrence until the capability ACK', () => {
		const parts = connected()
		expect(parts.workbench.sendWidgetEventArm(arm)).toEqual({ status: 'gated' })
		expect(parts.runtime.sendWidgetEventOccurrence(occurrence)).toEqual({ status: 'gated' })
		expect(parts.workbench.receive(occurrence)).toEqual({ status: 'gated' })
		expect(parts.workbenchOut).toEqual([])
		expect(parts.runtimeOut).toEqual([])
		const declaration = parts.runtime.declareCapabilities()
		expect(parts.workbench.receive(declaration).status).toBe('ack-dispatched')
		// The Workbench may arm once the ACK is dispatched; the runtime may report once it saw it.
		expect(parts.workbench.sendWidgetEventArm(arm)).toEqual({ status: 'sent' })
		expect(parts.runtime.receive(arm)).toEqual({ status: 'gated' })
		expect(parts.runtime.receive(parts.workbenchOut[0])).toMatchObject({ status: 'accepted' })
		expect(parts.runtime.receive(arm)).toEqual({ status: 'accepted', message: arm })
		expect(parts.runtime.sendWidgetEventOccurrence(occurrence)).toEqual({ status: 'sent' })
		expect(parts.workbench.receive(parts.runtimeOut.at(-1))).toEqual({ status: 'accepted', message: occurrence })
	})

	it('classifies stale sessions and generations as for geometry, never as failures', () => {
		const parts = connected()
		handshake(parts)
		expect(parts.workbench.receive({ ...occurrence, context: { ...occurrence.context, previewSessionId: 'session-old' } })).toEqual({ status: 'stale-session' })
		expect(parts.workbench.receive({ ...occurrence, context: { ...occurrence.context, runtimeGenerationId: 'generation-old' } })).toEqual({ status: 'stale-generation' })
		expect(parts.runtime.receive({ ...arm, context: { ...context, previewSessionId: 'session-old' } })).toEqual({ status: 'stale-session' })
		expect(parts.runtime.receive({ ...arm, context: { ...context, runtimeGenerationId: 'generation-old' } })).toEqual({ status: 'stale-generation' })
		// A new generation makes every occurrence of the previous one stale.
		parts.workbench.replaceGenerationForLifecycle('generation-b', 'reload')
		expect(parts.workbench.receive(occurrence)).toEqual({ status: 'stale-generation' })
	})

	it('rejects a wrong direction both ways', () => {
		const parts = connected()
		handshake(parts)
		expect(parts.workbench.receive(arm)).toEqual({ status: 'wrong-direction' })
		expect(parts.runtime.receive(occurrence)).toEqual({ status: 'wrong-direction' })
		expect(parts.workbench.sendWidgetEventArm(occurrence as never)).toEqual({ status: 'wrong-direction' })
		expect(parts.runtime.sendWidgetEventOccurrence(arm as never)).toEqual({ status: 'wrong-direction' })
	})

	it('takes the protocol-failure path for a malformed message, and never sends one', () => {
		const parts = connected()
		handshake(parts)
		expect(parts.workbench.receive({ ...occurrence, payload: {} }).status).toBe('invalid')
		expect(parts.runtime.receive({ ...arm, payload: { armId: 'x' } }).status).toBe('invalid')
		const before = parts.runtimeOut.length
		expect(parts.runtime.sendWidgetEventOccurrence({ ...occurrence, payload: { ...occurrence.payload, args: ['secret'] } } as never).status).toBe('invalid')
		expect(parts.runtimeOut).toHaveLength(before)
	})

	it('posts only to an explicit origin, never "*"', () => {
		expect(() => createPostMessageTransport(() => undefined, '*')).toThrow()
		expect(() => createPostMessageTransport(() => undefined, '')).toThrow()
		const posted: Array<[unknown, string]> = []
		const target = { postMessage: (message: unknown, origin: string) => posted.push([message, origin]) } as unknown as Window
		createPostMessageTransport(() => target, 'http://127.0.0.1:3950').send(occurrence)
		expect(posted).toEqual([[{ channel: 'uiux:preview:wire', message: occurrence }, 'http://127.0.0.1:3950']])
	})
})
