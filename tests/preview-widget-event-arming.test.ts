import { describe, expect, it } from 'vitest'

import {
	RuntimePreviewProtocolBridge,
	WorkbenchPreviewProtocolBridge,
	type PreviewWireMessage,
} from '../src/preview/protocol/bridge'
import { WIDGET_EVENTS_FEATURE, type WidgetEventArmMessage, type WidgetEventOccurrenceMessage } from '../src/preview/protocol/widget-events'
import { WidgetEventArming, type WidgetEventOccurrence, type WidgetEventVerdict } from '../src/preview/widget-event-arming'

/**
 * The Workbench side of Widget Event arming (Part 2 "Widget Event reporting", decisions 3, 5, 6, 7),
 * against the real protocol bridges: arming only after the ACK of a generation that declared
 * `widget.events`, fresh `armId`s, disarm before a targeting `enter`, re-arm after an exit, and
 * gates 1–9, each dropping its case without failing the session.
 */

const VIEW = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'
const OTHER_VIEW = '11111111-1111-4111-8111-111111111111'
const TRIGGERS = [{ widgetId: 'retry', event: 'click' }, { widgetId: 'done', event: 'click' }]

function harness(options: Readonly<{ features?: readonly string[]; variantId?: string }> = {}) {
	const features = options.features ?? ['geometry', WIDGET_EVENTS_FEATURE]
	/** The one ordered channel, Workbench → runtime, in send order (arms and targeting alike). */
	const wire: PreviewWireMessage[] = []
	const toWorkbench: PreviewWireMessage[] = []
	let generation = 'generation-1'
	let open = false
	let declared: readonly string[] = []
	let targeting: string | undefined
	let failed = false
	let sequence = 0
	const workbenchBridge = new WorkbenchPreviewProtocolBridge('session-a', { send: message => wire.push(message) }, () => ({ ok: true }))
	workbenchBridge.admitGeneration(generation, 'initial')
	let runtimeBridge = new RuntimePreviewProtocolBridge('session-a', generation, { protocolVersion: 1, features }, { send: message => toWorkbench.push(message) })
	const context = () => ({ previewSessionId: 'session-a', runtimeGenerationId: generation, viewId: VIEW, ...(options.variantId ? { variantId: options.variantId } : {}) })

	const arming = new WidgetEventArming({
		generation: () => generation,
		open: () => open,
		features: () => declared,
		targetingActive: () => !!targeting,
		context,
		send: message => workbenchBridge.sendWidgetEventArm(message).status === 'sent',
		mintArmId: () => `arm-${++sequence}`,
	})
	const seen: WidgetEventOccurrence[] = []
	let verdict: WidgetEventVerdict = 'followed'
	arming.onOccurrence((occurrence) => {
		seen.push(occurrence)
		return verdict
	})

	/** The session's ACK path: open the handshake, then the tool's interaction re-syncs the arm. */
	function acknowledge(): void {
		const result = workbenchBridge.receive(runtimeBridge.declareCapabilities())
		expect(result.status).toBe('ack-dispatched')
		runtimeBridge.receive(wire.at(-1))
		declared = features
		open = true
		arming.sync()
	}

	/** Session `onWindowMessage`: the bridge, then the arming gates; `invalid` only fails a session still starting. */
	function deliver(message: unknown): void {
		const result = workbenchBridge.receive(message)
		if (result.status === 'accepted' && result.message.type === 'widget.event.occurrence') arming.receive(result.message)
		else if (result.status === 'invalid' && !open) failed = true
	}

	function occurrence(armId: string, widgetId = 'retry', event = 'click', overrides: Partial<WidgetEventOccurrenceMessage['context']> = {}): WidgetEventOccurrenceMessage {
		return { type: 'widget.event.occurrence', context: { ...context(), widgetId, ...overrides }, payload: { armId, event } }
	}

	function arms(): WidgetEventArmMessage[] {
		return wire.filter((message): message is WidgetEventArmMessage => message.type === 'widget.event.arm')
	}

	/** The session's `enterInteraction`: set the id, sync (disarm), then send `targeting.enter`. */
	function enterTargeting(purpose: 'comment-range' | 'inspection'): void {
		targeting = `target-${++sequence}`
		arming.sync()
		workbenchBridge.sendTargeting({ type: 'targeting.enter', context: context(), payload: { targetingInteractionId: targeting, purpose } })
	}

	/** The session's exit with no successor: send `targeting.exit`, then sync (re-arm). */
	function exitTargeting(): void {
		targeting = undefined
		workbenchBridge.sendTargeting({ type: 'targeting.exit', context: context(), payload: {} })
		arming.sync()
	}

	function replaceGeneration(next: string): void {
		generation = next
		open = false
		declared = []
		arming.onGenerationBoundary()
		workbenchBridge.replaceGenerationForLifecycle(next, 'reload')
		runtimeBridge = new RuntimePreviewProtocolBridge('session-a', next, { protocolVersion: 1, features }, { send: message => toWorkbench.push(message) })
	}

	return {
		arming,
		wire,
		seen,
		arms,
		acknowledge,
		deliver,
		occurrence,
		enterTargeting,
		exitTargeting,
		replaceGeneration,
		generation: () => generation,
		failed: () => failed,
		setVerdict: (next: WidgetEventVerdict) => { verdict = next },
	}
}

describe('Widget Event arming (Workbench)', () => {
	it('sends no arm before the ACK, then exactly one with the bound triggers', () => {
		const h = harness()
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		expect(h.arms()).toEqual([])
		h.acknowledge()
		expect(h.arms()).toHaveLength(1)
		expect(h.arms()[0]!.payload.triggers).toEqual(TRIGGERS)
		expect(h.arms()[0]!.context).toEqual({ previewSessionId: 'session-a', runtimeGenerationId: 'generation-1', viewId: VIEW })
		// The same set again sends nothing; a changed set is a full replacement with a fresh armId.
		h.arming.arm([...TRIGGERS].reverse(), { runtimeGenerationId: h.generation() })
		expect(h.arms()).toHaveLength(1)
		h.arming.arm(TRIGGERS.slice(0, 1), { runtimeGenerationId: h.generation() })
		expect(h.arms()).toHaveLength(2)
		expect(h.arms()[1]!.payload).toEqual({ armId: 'arm-2', triggers: TRIGGERS.slice(0, 1) })
	})

	it('never arms a generation without widget.events, and never fails it', () => {
		const h = harness({ features: ['geometry'] })
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		h.acknowledge()
		expect(h.arms()).toEqual([])
		h.deliver(h.occurrence('arm-1'))
		expect(h.seen).toEqual([])
		expect(h.failed()).toBe(false)
	})

	it('never arms a generation the entry is not bound to', () => {
		const h = harness()
		h.arming.arm(TRIGGERS, { runtimeGenerationId: 'generation-0' })
		h.acknowledge()
		expect(h.arms()).toEqual([])
	})

	it('mints a fresh armId for every arm, and carries the Variant name as variantId', () => {
		const h = harness({ variantId: 'error' })
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		h.acknowledge()
		h.enterTargeting('comment-range')
		h.exitTargeting()
		const ids = h.arms().map(message => message.payload.armId)
		expect(new Set(ids).size).toBe(ids.length)
		expect(h.arms().every(message => message.context.variantId === 'error')).toBe(true)
	})

	it('disarms before targeting.enter on the one ordered channel, stays disarmed across a replaced interaction, and re-arms on exit', () => {
		const h = harness()
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		h.acknowledge()
		const before = h.wire.length
		h.enterTargeting('comment-range')
		const sequence = h.wire.slice(before).map(message => message.type === 'widget.event.arm' ? `arm:${message.payload.triggers.length}` : message.type)
		expect(sequence).toEqual(['arm:0', 'targeting.enter'])
		// A commit enters a fresh interaction: no second disarm, no arm.
		h.enterTargeting('comment-range')
		expect(h.wire.slice(before).filter(message => message.type === 'widget.event.arm')).toHaveLength(1)
		h.exitTargeting()
		const last = h.arms().at(-1)!
		expect(last.payload.triggers).toEqual(TRIGGERS)
		expect(h.wire.at(-2)!.type).toBe('targeting.exit')
	})

	it('sends nothing at all on a canvas that never armed (no Event traffic outside the player)', () => {
		const h = harness()
		h.acknowledge()
		h.enterTargeting('inspection')
		h.exitTargeting()
		h.enterTargeting('comment-range')
		expect(h.arms()).toEqual([])
	})

	it('accepts the first eligible occurrence, then retires its armId', () => {
		const h = harness()
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		h.acknowledge()
		h.deliver(h.occurrence('arm-1'))
		expect(h.seen).toEqual([{ runtimeGenerationId: 'generation-1', viewId: VIEW, widgetId: 'retry', event: 'click', armed: true }])
		// One occurrence per arm: a second one with the same armId is stale.
		h.deliver(h.occurrence('arm-1', 'done'))
		expect(h.seen).toHaveLength(1)
	})

	describe('gates 1–9 drop their case without failing the session', () => {
		function armed(options: Parameters<typeof harness>[0] = {}) {
			const h = harness(options)
			h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
			h.acknowledge()
			return h
		}

		it('2–3: a stale session or generation', () => {
			const h = armed()
			h.deliver(h.occurrence('arm-1', 'retry', 'click', { previewSessionId: 'session-old' }))
			h.deliver(h.occurrence('arm-1', 'retry', 'click', { runtimeGenerationId: 'generation-0' }))
			expect(h.seen).toEqual([])
			expect(h.failed()).toBe(false)
		})

		it('5: another View or Variant', () => {
			const h = armed()
			h.deliver(h.occurrence('arm-1', 'retry', 'click', { viewId: OTHER_VIEW }))
			h.deliver(h.occurrence('arm-1', 'retry', 'click', { variantId: 'error' }))
			expect(h.seen).toEqual([])
			const v = armed({ variantId: 'error' })
			v.deliver({ type: 'widget.event.occurrence', context: { previewSessionId: 'session-a', runtimeGenerationId: 'generation-1', viewId: VIEW, widgetId: 'retry' }, payload: { armId: 'arm-1', event: 'click' } })
			expect(v.seen).toEqual([])
		})

		it('6: a retired armId, even after the mode has ended', () => {
			const h = armed()
			h.enterTargeting('comment-range')
			h.exitTargeting()
			// Emitted just before the disarm reached the runtime, delivered after the exit.
			h.deliver(h.occurrence('arm-1'))
			expect(h.seen).toEqual([])
			const current = h.arms().at(-1)!.payload.armId
			h.deliver(h.occurrence(current))
			expect(h.seen).toHaveLength(1)
		})

		it('7: comment or targeting mode is active', () => {
			const h = armed()
			const armId = h.arms().at(-1)!.payload.armId
			h.enterTargeting('comment-range')
			h.deliver(h.occurrence(armId))
			const disarm = h.arms().at(-1)!.payload.armId
			h.deliver(h.occurrence(disarm))
			expect(h.seen).toEqual([])
			// Suppressed, not deferred: nothing is replayed on exit.
			h.exitTargeting()
			expect(h.seen).toEqual([])
		})

		it('8: the player reports the entry closed; no re-arm', () => {
			const h = armed()
			h.setVerdict('closed')
			const count = h.arms().length
			h.deliver(h.occurrence('arm-1'))
			expect(h.seen).toHaveLength(1)
			expect(h.arms()).toHaveLength(count)
			expect(h.arming.currentArmId()).toBeUndefined()
		})

		it('9: a pair outside the armed set, or no resolvable transition, re-arms with a fresh armId', () => {
			const h = armed()
			h.setVerdict('unmatched')
			h.deliver(h.occurrence('arm-1', 'stray', 'click'))
			expect(h.seen.at(-1)!.armed).toBe(false)
			expect(h.arms().at(-1)!.payload).toEqual({ armId: 'arm-2', triggers: TRIGGERS })
			expect(h.arming.currentArmId()).toBe('arm-2')
		})

		it('a generation boundary drops late occurrences', () => {
			const h = armed()
			h.replaceGeneration('generation-2')
			h.deliver(h.occurrence('arm-1', 'retry', 'click', { runtimeGenerationId: 'generation-1' }))
			expect(h.seen).toEqual([])
			expect(h.failed()).toBe(false)
		})

		it('a malformed message takes the protocol-failure path while the session is starting', () => {
			const h = harness()
			h.deliver({ type: 'widget.event.occurrence', context: { previewSessionId: 'session-a' }, payload: {} })
			expect(h.failed()).toBe(true)
		})
	})

	it('retire() closes the entry without sending a disarm (the old generation is about to end)', () => {
		const h = harness()
		h.arming.arm(TRIGGERS, { runtimeGenerationId: h.generation() })
		h.acknowledge()
		const count = h.wire.length
		h.arming.retire()
		expect(h.wire).toHaveLength(count)
		h.deliver(h.occurrence('arm-1'))
		expect(h.seen).toEqual([])
		// An explicit disarm (leaving the player) sends an empty arm when one is live.
		const g = harness()
		g.arming.arm(TRIGGERS, { runtimeGenerationId: g.generation() })
		g.acknowledge()
		g.arming.disarm()
		expect(g.arms().at(-1)!.payload.triggers).toEqual([])
	})
})
