import type { FlowDraft } from './flow-graph'

/**
 * The deterministic Prototype player model (Discussion #6, items 4, 5, 6 and 10c).
 *
 * Playback always starts at `entryStepId` and follows the one canonical Flow. Each step entry is a
 * new `entry` number: the Preview creates a fresh View Runtime for every entry, including re-entering
 * a step already visited, and nothing from an earlier entry is restored. Transitions match the
 * source step plus the exact Widget Event identity `{ widgetId, event }`; payloads are never read
 * and there is no first-match fallback, because a duplicate trigger is a validation error that
 * blocks playback before it starts.
 */

export type PlayerTrigger = Readonly<{ widgetId: string; event: string }>

export type PlayerVisit = Readonly<{
	/** Monotonic per player: every step entry, including a return to the same step, gets a new one. */
	entry: number
	stepId: string
	/** The trigger that entered this step; absent for the entry step. */
	via?: PlayerTrigger
}>

export type PlayerState = Readonly<{
	flowId: string
	history: readonly PlayerVisit[]
	nextEntry: number
}>

export function startPlayback(flow: FlowDraft): PlayerState {
	return Object.freeze({
		flowId: flow.id,
		history: Object.freeze([Object.freeze({ entry: 1, stepId: flow.entryStepId })]),
		nextEntry: 2,
	})
}

export function currentVisit(state: PlayerState): PlayerVisit {
	return state.history[state.history.length - 1]!
}

/** Restart is a fresh entry into the entry step, never a rewind to an earlier entry. */
export function restartPlayback(flow: FlowDraft, state: PlayerState): PlayerState {
	return Object.freeze({
		flowId: flow.id,
		history: Object.freeze([Object.freeze({ entry: state.nextEntry, stepId: flow.entryStepId })]),
		nextEntry: state.nextEntry + 1,
	})
}

/** The transitions leaving the current step, in authored order (order carries no priority). */
export function availableTransitions(flow: FlowDraft, state: PlayerState) {
	return flow.steps[currentVisit(state).stepId]?.transitions ?? []
}

/**
 * Resolves a Widget Event occurrence in the current step. Exactly one transition may match; zero
 * means the event does not navigate, and more than one is ambiguous and never resolved.
 */
export function resolveTransition(flow: FlowDraft, stepId: string, trigger: PlayerTrigger): string | undefined {
	const matches = (flow.steps[stepId]?.transitions ?? []).filter(transition =>
		transition.trigger.widgetId === trigger.widgetId && transition.trigger.event === trigger.event)
	return matches.length === 1 && flow.steps[matches[0]!.targetStepId] ? matches[0]!.targetStepId : undefined
}

/** Follows a Widget Event occurrence. Returns the same state when nothing matches. */
export function followTrigger(flow: FlowDraft, state: PlayerState, trigger: PlayerTrigger): PlayerState {
	const target = resolveTransition(flow, currentVisit(state).stepId, trigger)
	if (!target) return state
	return Object.freeze({
		flowId: state.flowId,
		history: Object.freeze([...state.history, Object.freeze({ entry: state.nextEntry, stepId: target, via: Object.freeze({ ...trigger }) })]),
		nextEntry: state.nextEntry + 1,
	})
}
