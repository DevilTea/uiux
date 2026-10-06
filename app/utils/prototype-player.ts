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

/**
 * Where a transition came from (Widget Event reporting, decisions 7 and 8): `runtime` is a Widget
 * Event occurrence the Preview reported; `workbench` is a dock control or digit shortcut, a player
 * action that is not an Event and never evidence. Ephemeral: player history is never persisted.
 */
export type PlayerSource = 'runtime' | 'workbench'

export type PlayerVisit = Readonly<{
	/** Monotonic per player: every step entry, including a return to the same step, gets a new one. */
	entry: number
	stepId: string
	/** The trigger that entered this step and its source; absent for the entry step. */
	via?: PlayerTrigger & Readonly<{ source: PlayerSource }>
}>

/** Every call into the player carries the entry it was issued from (decision 7). */
export type PlayerFollowScope = Readonly<{ entry: number; source: PlayerSource }>

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

/**
 * Follows a trigger from the entry it was issued in. Each step entry accepts at most one
 * transition from any source: once followed, the entry is no longer current, so a later call
 * scoped to it (a double click, an occurrence racing a dock click) is a no-op. Returns the same
 * state when the entry is stale or nothing matches.
 */
export function followTrigger(flow: FlowDraft, state: PlayerState, trigger: PlayerTrigger, scope: PlayerFollowScope): PlayerState {
	const visit = currentVisit(state)
	if (scope.entry !== visit.entry) return state
	const target = resolveTransition(flow, visit.stepId, trigger)
	if (!target) return state
	const via = Object.freeze({ widgetId: trigger.widgetId, event: trigger.event, source: scope.source })
	return Object.freeze({
		flowId: state.flowId,
		history: Object.freeze([...state.history, Object.freeze({ entry: state.nextEntry, stepId: target, via })]),
		nextEntry: state.nextEntry + 1,
	})
}
