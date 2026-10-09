import type { JsonValue } from '../../validation'
import {
	asRecord,
	diffJson,
	diffJsonExcept,
	diffListItems,
	jsonEqual,
	unionKeys,
	valueChange,
	type JsonPointerChange,
	type ListItemChanges,
	type Side,
	type ValueChange,
} from './json-pointer'

/**
 * The semantic diff of a UX Flow (Rule 01a11a5e-0f87-7bc0-b557-4f0b0b4886a3): steps matched by
 * their key, each kept step's target and transition changes, and the entry step change.
 * Transitions have no identity of their own, so they are matched by value. When `steps` is not an
 * object on both sides it is reported structurally in `stepsChanges` instead.
 */
export type FlowStepChange = Readonly<{
	stepId: string
	target?: ValueChange
	transitions?: ListItemChanges<JsonValue>
	/** Step members other than `target` and `transitions`, relative to the step. */
	otherChanges?: readonly JsonPointerChange[]
}>

export type FlowDiff = Readonly<{
	type: 'flow'
	name?: ValueChange
	entryStepId?: ValueChange
	steps?: Readonly<{
		added: readonly Readonly<{ stepId: string; step: JsonValue }>[]
		removed: readonly Readonly<{ stepId: string; step: JsonValue }>[]
		changed: readonly FlowStepChange[]
	}>
	stepsChanges?: readonly JsonPointerChange[]
	/** Flow members other than `name`, `entryStepId` and `steps` (such as `scenarioRef`), relative to the Flow. */
	otherChanges?: readonly JsonPointerChange[]
}>

export function diffFlow(before: Side, after: Side): FlowDiff {
	const left = asRecord(before) ?? {}
	const right = asRecord(after) ?? {}
	const name = valueChange(left.name, right.name)
	const entryStepId = valueChange(left.entryStepId, right.entryStepId)
	const leftSteps = left.steps === undefined ? {} : asRecord(left.steps)
	const rightSteps = right.steps === undefined ? {} : asRecord(right.steps)
	const other = diffJsonExcept(left, right, ['name', 'entryStepId', 'steps'])
	return {
		type: 'flow',
		...(name ? { name } : {}),
		...(entryStepId ? { entryStepId } : {}),
		...(leftSteps && rightSteps ? { steps: diffSteps(leftSteps, rightSteps) } : { stepsChanges: diffJson(left.steps, right.steps) }),
		...(other.length > 0 ? { otherChanges: other } : {}),
	}
}

function diffSteps(left: Readonly<Record<string, JsonValue>>, right: Readonly<Record<string, JsonValue>>): NonNullable<FlowDiff['steps']> {
	const added: { stepId: string; step: JsonValue }[] = []
	const removed: { stepId: string; step: JsonValue }[] = []
	const changed: FlowStepChange[] = []
	for (const stepId of unionKeys(left, right)) {
		const was = left[stepId]
		const now = right[stepId]
		if (was === undefined) {
			added.push({ stepId, step: now! })
			continue
		}
		if (now === undefined) {
			removed.push({ stepId, step: was })
			continue
		}
		if (jsonEqual(was, now)) continue
		const wasStep = asRecord(was) ?? {}
		const nowStep = asRecord(now) ?? {}
		const target = valueChange(wasStep.target, nowStep.target)
		const listed = Array.isArray(wasStep.transitions ?? []) && Array.isArray(nowStep.transitions ?? [])
		const transitions = listed ? diffListItems((wasStep.transitions ?? []) as JsonValue[], (nowStep.transitions ?? []) as JsonValue[]) : undefined
		const otherChanges = asRecord(was) && asRecord(now)
			? diffJsonExcept(wasStep, nowStep, ['target', ...(listed ? ['transitions'] : [])])
			: diffJson(was, now)
		changed.push({
			stepId,
			...(target ? { target } : {}),
			...(transitions ? { transitions } : {}),
			...(otherChanges.length > 0 ? { otherChanges } : {}),
		})
	}
	return { added, removed, changed }
}
