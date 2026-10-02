import { describe, expect, it } from 'vitest'

import { PreviewTargetingState } from '../src/preview/targeting-state'
import type { JsonValue } from '../src/domain/validation'

type Candidate = JsonValue

const candidateA: Candidate = { widgetId: 'widget-a', geometry: { regionIds: ['r1'] } }
const candidateB: Candidate = { widgetId: 'widget-b', geometry: { regionIds: ['r2'] } }

describe('Preview targeting lifecycle', () => {
	it('keeps targeting mode suspended until a generation is capability-ready', () => {
		const state = new PreviewTargetingState<Candidate>()
		expect(state.enterMode('inspection', 'interaction-a')).toEqual({ status: 'accepted' })
		expect(state.snapshot()).toMatchObject({ purpose: 'inspection', targetingInteractionId: 'interaction-a', input: 'suspended' })
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)).toEqual({ status: 'suspended' })
		expect(state.markGenerationReady('generation-a')).toEqual({ status: 'accepted' })
		expect(state.snapshot()).toMatchObject({ purpose: 'inspection', targetingInteractionId: 'interaction-a', input: 'ready', runtimeGenerationId: 'generation-a' })
	})

	it('shows hover candidates for hover-capable pointers without committing structural state', () => {
		const state = readyState()
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)).toEqual({ status: 'candidate', candidate: candidateA })
		expect(state.snapshot()).toMatchObject({ purpose: 'inspection', candidatePreview: candidateA })
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'pen', candidateB)).toEqual({ status: 'candidate', candidate: candidateB })
		expect(state.snapshot().candidatePreview).toEqual(candidateB)
	})

	it('never creates touch hover preview', () => {
		const state = readyState()
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'touch', candidateA)).toEqual({ status: 'touch-hover-ignored' })
		expect('candidatePreview' in state.snapshot()).toBe(false)
	})

	it('models runtime-owned drag as one gesture and accepts only matching pointer candidate updates', () => {
		const state = readyState()
		expect(state.beginGesture('generation-a', 'interaction-a', 7, 'mouse')).toEqual({ status: 'accepted' })
		expect(state.snapshot()).toMatchObject({ gesture: { runtimeGenerationId: 'generation-a', pointerId: 7, pointerType: 'mouse' } })
		expect(state.reportGestureCandidate('generation-a', 'interaction-a', 8, candidateA)).toEqual({ status: 'stale-gesture' })
		expect(state.reportGestureCandidate('generation-a', 'interaction-a', 7, candidateA)).toEqual({ status: 'candidate', candidate: candidateA })
		expect(state.beginGesture('generation-a', 'interaction-a', 9, 'mouse')).toEqual({ status: 'gesture-already-active' })
	})

	it('pointer-capture loss cancels only transient gesture state and keeps targeting ready', () => {
		const state = readyState()
		state.beginGesture('generation-a', 'interaction-a', 7, 'mouse')
		state.reportGestureCandidate('generation-a', 'interaction-a', 7, candidateA)
		expect(state.onPointerCaptureLost('generation-a', 'interaction-a', 7)).toEqual({ status: 'gesture-cancelled', reason: 'pointer-capture-loss' })
		expect(state.snapshot()).toEqual({ purpose: 'inspection', targetingInteractionId: 'interaction-a', input: 'ready', runtimeGenerationId: 'generation-a' })
		expect(state.beginGesture('generation-a', 'interaction-a', 8, 'mouse')).toEqual({ status: 'accepted' })
	})

	it('focus transfer clears hover/gesture preview but does not exit targeting mode', () => {
		const state = readyState()
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(state.onFocusTransferredToWorkbench()).toEqual({ status: 'transient-cancelled', reason: 'focus-transfer' })
		expect(state.snapshot()).toEqual({ purpose: 'inspection', targetingInteractionId: 'interaction-a', input: 'ready', runtimeGenerationId: 'generation-a' })
		expect(state.onFocusTransferredToWorkbench()).toEqual({ status: 'accepted' })
	})

	it('generation teardown cancels old transient state, preserves mode, and suspends input until a new generation is ready', () => {
		const state = readyState('comment-range')
		state.beginGesture('generation-a', 'interaction-a', 4, 'touch')
		state.reportGestureCandidate('generation-a', 'interaction-a', 4, candidateA)
		expect(state.onGenerationTeardown('generation-a')).toEqual({ status: 'transient-cancelled', reason: 'generation-teardown' })
		expect(state.snapshot()).toEqual({ purpose: 'comment-range', targetingInteractionId: 'interaction-a', input: 'suspended' })
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateA)).toEqual({ status: 'suspended' })
		expect(state.markGenerationReady('generation-b')).toEqual({ status: 'accepted' })
		expect(state.snapshot()).toEqual({ purpose: 'comment-range', targetingInteractionId: 'interaction-a', input: 'ready', runtimeGenerationId: 'generation-b' })
	})

	it('rejects stale old-generation candidates and final commits after recovery', () => {
		const state = readyState()
		state.onGenerationTeardown('generation-a')
		state.markGenerationReady('generation-b')
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)).toEqual({ status: 'stale-generation' })
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateA)).toEqual({ status: 'stale-generation' })
		expect(state.snapshot()).toMatchObject({ purpose: 'inspection', input: 'ready', runtimeGenerationId: 'generation-b' })
	})

	it('commits a runtime final target exactly once and exits targeting mode', () => {
		const state = readyState('comment-range')
		state.beginGesture('generation-a', 'interaction-a', 5, 'touch')
		state.reportGestureCandidate('generation-a', 'interaction-a', 5, candidateA)
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateB)).toEqual({ status: 'committed', purpose: 'comment-range', candidate: candidateB })
		expect(state.snapshot()).toEqual({ input: 'inactive', runtimeGenerationId: 'generation-a' })
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateB)).toEqual({ status: 'inactive' })
	})

	it('processes runtime Escape only as an intent input to Workbench-owned authoritative mode exit', () => {
		const state = readyState()
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(state.applyRuntimeEscapeIntent('generation-a', 'interaction-a')).toEqual({ status: 'cancelled', purpose: 'inspection', reason: 'escape-intent' })
		expect(state.snapshot()).toEqual({ input: 'inactive', runtimeGenerationId: 'generation-a' })
	})

	it('explicit cancellation and authoritative replacement clear transient state', () => {
		const state = readyState()
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(state.authoritativeModeTransition('comment-range', 'interaction-b')).toEqual({
			status: 'cancelled', purpose: 'inspection', reason: 'authoritative-transition',
		})
		expect(state.snapshot()).toEqual({ purpose: 'comment-range', targetingInteractionId: 'interaction-b', input: 'ready', runtimeGenerationId: 'generation-a' })
		expect(state.explicitCancel()).toEqual({ status: 'cancelled', purpose: 'comment-range', reason: 'explicit' })
		expect(state.snapshot()).toEqual({ input: 'inactive', runtimeGenerationId: 'generation-a' })
	})

	it('ignores teardown and capture-loss signals from stale generations/pointers without disturbing current transient state', () => {
		const state = readyState()
		state.beginGesture('generation-a', 'interaction-a', 7, 'mouse')
		state.reportGestureCandidate('generation-a', 'interaction-a', 7, candidateA)
		expect(state.onGenerationTeardown('generation-old')).toEqual({ status: 'stale-generation' })
		expect(state.onPointerCaptureLost('generation-a', 'interaction-a', 8)).toEqual({ status: 'stale-gesture' })
		expect(state.snapshot()).toMatchObject({ candidatePreview: candidateA, gesture: { pointerId: 7 } })
	})



	it('same-purpose re-entry with a fresh interaction identity clears old transient state', () => {
		const state = readyState('inspection')
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(state.enterMode('inspection', 'interaction-b')).toEqual({ status: 'accepted' })
		expect(state.snapshot()).toEqual({ purpose: 'inspection', targetingInteractionId: 'interaction-b', input: 'ready', runtimeGenerationId: 'generation-a' })
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateB)).toEqual({ status: 'stale-interaction' })
	})

	it('never allows a retired targeting interaction identity to become current again', () => {
		const state = readyState('inspection')
		expect(state.explicitCancel()).toEqual({ status: 'cancelled', purpose: 'inspection', reason: 'explicit' })
		expect(() => state.enterMode('inspection', 'interaction-a')).toThrow(/fresh/)
		expect(state.snapshot()).toEqual({ input: 'inactive', runtimeGenerationId: 'generation-a' })
	})

	it('validates authoritative replacement identity before mutating current targeting state', () => {
		const state = readyState('inspection')
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(() => state.authoritativeModeTransition('comment-range', 'interaction-a')).toThrow(/fresh/)
		expect(state.snapshot()).toEqual({
			purpose: 'inspection', targetingInteractionId: 'interaction-a', input: 'ready',
			runtimeGenerationId: 'generation-a', candidatePreview: candidateA,
		})
	})

	it('rejects delayed same-generation traffic from a superseded targeting interaction', () => {
		const state = readyState('inspection')
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateA)
		expect(state.authoritativeModeTransition('comment-range', 'interaction-b')).toEqual({
			status: 'cancelled', purpose: 'inspection', reason: 'authoritative-transition',
		})
		expect(state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', candidateB)).toEqual({ status: 'stale-interaction' })
		expect(state.commitFinalTarget('generation-a', 'interaction-a', candidateB)).toEqual({ status: 'stale-interaction' })
		expect(state.applyRuntimeEscapeIntent('generation-a', 'interaction-a')).toEqual({ status: 'stale-interaction' })
		expect(state.snapshot()).toEqual({ purpose: 'comment-range', targetingInteractionId: 'interaction-b', input: 'ready', runtimeGenerationId: 'generation-a' })
	})

	it('defensively clones candidate JSON at ingress and egress', () => {
		const state = readyState()
		const mutable = { widgetId: 'widget-a', nested: { value: 'original' } }
		state.reportHoverCandidate('generation-a', 'interaction-a', 'mouse', mutable)
		mutable.nested.value = 'mutated-after-ingress'
		const first = state.snapshot()
		expect(first.candidatePreview).toEqual({ widgetId: 'widget-a', nested: { value: 'original' } })
		if (first.candidatePreview && typeof first.candidatePreview === 'object' && !Array.isArray(first.candidatePreview)) {
			;(first.candidatePreview as { nested: { value: string } }).nested.value = 'mutated-after-egress'
		}
		expect(state.snapshot().candidatePreview).toEqual({ widgetId: 'widget-a', nested: { value: 'original' } })
	})
})

function readyState(purpose: 'inspection' | 'comment-range' = 'inspection'): PreviewTargetingState<Candidate> {
	const state = new PreviewTargetingState<Candidate>()
	state.enterMode(purpose, 'interaction-a')
	state.markGenerationReady('generation-a')
	return state
}
