import { INTERACTION_ACTIONS, MAX_INTERACTION_KEY_LENGTH, MAX_INTERACTION_TEXT_LENGTH, type InteractionAction } from '../evidence/interaction-replay'
import { isRecord, jsonPointer, type Diagnostic } from '../validation'
import type { FlowResource, FlowStep } from './schema'

/**
 * Clause of the Evidence-owned replay recipe of a formal UX Flow Evidence record (`data.recipe`):
 * an ordered list of `enter` actions, which enter a step and assert its target, and `trigger`
 * actions, which immediately follow an `enter` of the same step, take the transition the trigger
 * identifies there and assert the step it leads to. The recipe belongs to the Evidence record and
 * never to the Flow (Rule 01a11544-66ad-73e5-8fcd-9e24bfcb3313). A `trigger` carries the browser action
 * that causes its Widget Event (`perform`, owner ruling 4 of
 * https://github.com/DevilTea/uiux/discussions/241#discussioncomment-19197851), which the interaction
 * replay engine performs; a recipe that is given states it on every trigger.
 */
export type FlowRecipePerform = Readonly<{ action: InteractionAction; text?: string; key?: string }>
export type FlowRecipeEnter = Readonly<{
	type: 'enter'
	stepId: string
	expect: Readonly<{ viewId: string; variantName?: string }>
}>
export type FlowRecipeTrigger = Readonly<{
	type: 'trigger'
	stepId: string
	trigger: Readonly<{ widgetId: string; event: string }>
	/** Absent only on a derived trigger whose Event is not `press`; `validateFlowRecipe` refuses such a recipe. */
	perform?: FlowRecipePerform
	expect: Readonly<{ resultStepId: string }>
}>
export type FlowRecipeAction = FlowRecipeEnter | FlowRecipeTrigger
export type FlowRecipe = Readonly<{ actions: readonly FlowRecipeAction[] }>

/** One step entry of a recipe: its `enter` and the `trigger` that follows it, if any. */
export type FlowRecipeEntry = Readonly<{
	stepId: string
	viewId: string
	variantName?: string
	trigger?: Readonly<{ widgetId: string; event: string }>
	perform?: FlowRecipePerform
	resultStepId?: string
}>

const compare = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

function enterOf(stepId: string, step: FlowStep): FlowRecipeEnter {
	return { type: 'enter', stepId, expect: { viewId: step.target.viewId, ...(step.target.variantName !== undefined ? { variantName: step.target.variantName } : {}) } }
}

/**
 * The recipe the server derives when none is given, breadth-first from the entry step: every
 * reached step is entered once without a trigger when it has no outgoing transition, otherwise
 * once for each outgoing transition, in order of Widget ID then Event name, followed by its trigger.
 * A trigger whose Event is `press` performs a `click`; no other Event has a default action, so its trigger
 * has no `perform` and `validateFlowRecipe` refuses the recipe until one is given. The Flow must be valid
 * (every step reachable, every target present).
 */
export function deriveFlowRecipe(flow: FlowResource): FlowRecipe {
	const actions: FlowRecipeAction[] = []
	const seen = new Set<string>([flow.entryStepId])
	const queue = [flow.entryStepId]
	while (queue.length > 0) {
		const stepId = queue.shift()!
		const step = flow.steps[stepId]
		if (!step) continue
		const transitions = [...step.transitions].sort((a, b) => compare(a.trigger.widgetId, b.trigger.widgetId) || compare(a.trigger.event, b.trigger.event))
		if (transitions.length === 0) actions.push(enterOf(stepId, step))
		for (const transition of transitions) {
			actions.push(enterOf(stepId, step))
			actions.push({ type: 'trigger', stepId, trigger: { widgetId: transition.trigger.widgetId, event: transition.trigger.event }, ...(transition.trigger.event === 'press' ? { perform: { action: 'click' as const } } : {}), expect: { resultStepId: transition.targetStepId } })
			if (!seen.has(transition.targetStepId)) {
				seen.add(transition.targetStepId)
				queue.push(transition.targetStepId)
			}
		}
	}
	return { actions }
}

/** The step entries of a recipe that matches its Flow, in recipe order (one for each `enter`). */
export function flowRecipeEntries(recipe: FlowRecipe): readonly FlowRecipeEntry[] {
	const entries: FlowRecipeEntry[] = []
	for (const action of recipe.actions) {
		if (action.type === 'enter') {
			entries.push({ stepId: action.stepId, viewId: action.expect.viewId, ...(action.expect.variantName !== undefined ? { variantName: action.expect.variantName } : {}) })
			continue
		}
		const last = entries.pop()!
		entries.push({ ...last, trigger: { widgetId: action.trigger.widgetId, event: action.trigger.event }, ...(action.perform ? { perform: action.perform } : {}), resultStepId: action.expect.resultStepId })
	}
	return entries
}

/** A trigger's `perform`: required, and shaped as a step of an interaction replay (an action, the text of a `type`, the key of a `press`). */
function validatePerform(trigger: Record<string, unknown>, path: string, diagnostics: Diagnostic[]): void {
	const performPath = jsonPointer(path, 'perform')
	if (!Object.hasOwn(trigger, 'perform')) {
		diagnostics.push({ code: 'flow.recipe_perform_required', path: performPath, message: 'A trigger states the browser action that causes its Event, perform { action, text?, key? }; only a derived press trigger defaults to a click.' })
		return
	}
	const bad = (at: string, message: string) => { diagnostics.push({ code: 'flow.recipe_invalid_shape', path: at, message }) }
	const perform = trigger.perform
	if (!isRecord(perform)) return bad(performPath, 'perform is { action, text?, key? }.')
	keysOnly(perform, ['action', 'text', 'key'], performPath, diagnostics)
	const action = typeof perform.action === 'string' && (INTERACTION_ACTIONS as readonly string[]).includes(perform.action) ? perform.action : undefined
	if (!action) bad(jsonPointer(performPath, 'action'), `An action is one of ${INTERACTION_ACTIONS.join(', ')}.`)
	if (action === 'type') {
		if (typeof perform.text !== 'string' || perform.text.length === 0 || perform.text.length > MAX_INTERACTION_TEXT_LENGTH)
			bad(jsonPointer(performPath, 'text'), `A type action has text of 1 to ${MAX_INTERACTION_TEXT_LENGTH} characters.`)
	}
	else if (Object.hasOwn(perform, 'text')) bad(jsonPointer(performPath, 'text'), 'Only a type action has text.')
	if (action === 'press') {
		if (typeof perform.key !== 'string' || perform.key.length === 0 || perform.key.length > MAX_INTERACTION_KEY_LENGTH)
			bad(jsonPointer(performPath, 'key'), `A press action has a key of 1 to ${MAX_INTERACTION_KEY_LENGTH} characters.`)
	}
	else if (Object.hasOwn(perform, 'key')) bad(jsonPointer(performPath, 'key'), 'Only a press action has a key.')
}

function keysOnly(value: Record<string, unknown>, allowed: readonly string[], path: string, diagnostics: Diagnostic[]): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) diagnostics.push({ code: 'flow.recipe_invalid_shape', path: jsonPointer(path, key), message: `A recipe action has no member "${key}".` })
	}
}

/**
 * Checks `input` as a recipe of `flow`: its shape, and that every action names a step and trigger the
 * Flow has, gives every trigger its `perform`, and asserts what the Flow holds. A recipe that does not match is refused whole; it is
 * never adjusted. The diagnostics are empty for a recipe that matches.
 */
export function validateFlowRecipe(input: unknown, flow: FlowResource): readonly Diagnostic[] {
	const diagnostics: Diagnostic[] = []
	const bad = (path: string, message: string, code = 'flow.recipe_invalid_shape') => { diagnostics.push({ code, path, message }) }
	if (!isRecord(input)) return [{ code: 'flow.recipe_invalid_shape', path: '/recipe', message: 'A recipe is an object { actions }.' }]
	keysOnly(input, ['actions'], '/recipe', diagnostics)
	if (!Array.isArray(input.actions) || input.actions.length === 0) {
		bad('/recipe/actions', 'A recipe has a non-empty list of actions.')
		return diagnostics
	}
	let entered: string | undefined
	input.actions.forEach((action, index) => {
		const path = jsonPointer('/recipe/actions', index)
		if (!isRecord(action) || (action.type !== 'enter' && action.type !== 'trigger')) return bad(path, 'An action is an enter or a trigger.')
		keysOnly(action, action.type === 'enter' ? ['type', 'stepId', 'expect'] : ['type', 'stepId', 'trigger', 'perform', 'expect'], path, diagnostics)
		const stepId = action.stepId
		const step = typeof stepId === 'string' && Object.hasOwn(flow.steps, stepId) ? flow.steps[stepId] : undefined
		if (!step) return bad(`${path}/stepId`, 'The action names a step the Flow does not have.', 'flow.recipe_unknown_step')
		const expect = isRecord(action.expect) ? action.expect : undefined
		if (action.type === 'enter') {
			entered = stepId as string
			if (!expect) return bad(`${path}/expect`, 'An enter asserts the step\'s target.')
			keysOnly(expect, ['viewId', 'variantName'], `${path}/expect`, diagnostics)
			if (expect.viewId !== step.target.viewId || expect.variantName !== step.target.variantName)
				bad(`${path}/expect`, 'The asserted View and Variant are not the step\'s target.', 'flow.recipe_assertion_failed')
			return
		}
		if (entered !== stepId) {
			entered = undefined
			return bad(path, 'A trigger immediately follows an enter of the same step.', 'flow.recipe_orphan_trigger')
		}
		entered = undefined
		const trigger = isRecord(action.trigger) ? action.trigger : undefined
		if (!trigger) return bad(`${path}/trigger`, 'A trigger names { widgetId, event }.')
		keysOnly(trigger, ['widgetId', 'event'], `${path}/trigger`, diagnostics)
		validatePerform(action, path, diagnostics)
		const transition = step.transitions.find(candidate => candidate.trigger.widgetId === trigger.widgetId && candidate.trigger.event === trigger.event)
		if (!transition) return bad(`${path}/trigger`, 'The step has no transition with this trigger.', 'flow.recipe_unknown_trigger')
		if (!expect) return bad(`${path}/expect`, 'A trigger asserts the step it leads to.')
		keysOnly(expect, ['resultStepId'], `${path}/expect`, diagnostics)
		if (expect.resultStepId !== transition.targetStepId)
			bad(`${path}/expect/resultStepId`, 'The asserted step is not the one the transition leads to.', 'flow.recipe_assertion_failed')
	})
	return diagnostics
}
