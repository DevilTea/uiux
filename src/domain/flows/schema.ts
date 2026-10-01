import {
	jsonPointer,
	isRecord,
	rejectUnknownKeys,
	validateJsonValue,
	validateUuid,
	Validator,
	type JsonObject,
	type ValidationResult,
} from '../validation'

export type FlowTarget = Readonly<{ viewId: string; variantName?: string }>
export type FlowTransition = Readonly<{
	trigger: Readonly<{ widgetId: string; event: string }>
	targetStepId: string
}>
export type FlowStep = Readonly<{ target: FlowTarget; transitions: readonly FlowTransition[] }>
export type FlowResource = Readonly<{
	id: string
	name: string
	scenarioRef?: JsonObject
	entryStepId: string
	steps: Readonly<Record<string, FlowStep>>
}>

export function validateFlowResource(input: unknown, filename?: string): ValidationResult<FlowResource> {
	const v = new Validator()
	const flow = v.object(input, '')
	if (!flow)
		return v.finish<FlowResource>(input)
	validateJsonValue(input, '', v)
	rejectUnknownKeys(flow, ['id', 'name', 'scenarioRef', 'entryStepId', 'steps'], '', v)
	const idIsUuid = validateUuid(flow.id, '/id', v, 'Flow id')
	v.string(flow.name, '/name', true)
	if (filename !== undefined && idIsUuid) {
		const match = /^([0-9a-f-]+)\.flow\.json$/iu.exec(filename)
		if (!match || match[1] !== flow.id)
			v.issue('identity.filename_id_mismatch', '/id', 'Flow filename UUID must exactly match the immutable id.')
	}
	if (Object.hasOwn(flow, 'transitions'))
		v.issue('flow.forbidden_top_level_transitions', '/transitions', 'Canonical transitions belong to their containing source step.')
	if (Object.hasOwn(flow, 'scenarioRef') && !isRecord(flow.scenarioRef))
		v.issue('flow.invalid_scenario_ref', '/scenarioRef', 'scenarioRef must remain a structured external provenance reference.')
	const steps = v.object(flow.steps, '/steps')
	if (!steps)
		return v.finish<FlowResource>(input)
	const stepIds = Object.keys(steps)
	const validStepIds = new Set<string>()
	for (const id of stepIds) {
		if (validateUuid(id, jsonPointer('/steps', id), v, 'Flow step identity'))
			validStepIds.add(id)
	}
	if (!validateUuid(flow.entryStepId, '/entryStepId', v, 'entryStepId')) {
		// The common UUID diagnostic is sufficient.
	}
	else if (!validStepIds.has(flow.entryStepId)) {
		v.issue('flow.dangling_entry_step', '/entryStepId', 'entryStepId must identify a step in this Flow.')
	}

	const graph = new Map<string, string[]>()
	for (const [stepId, stepValue] of Object.entries(steps)) {
		const path = jsonPointer('/steps', stepId)
		const step = v.object(stepValue, path)
		if (!step)
			continue
		rejectUnknownKeys(step, ['target', 'transitions'], path, v)
		if (Object.hasOwn(step, 'id'))
			v.issue('flow.duplicate_step_identity', `${path}/id`, 'Step identity is its object key and is not repeated inside the entry.')
		const target = v.object(step.target, `${path}/target`)
		if (target) {
			rejectUnknownKeys(target, ['viewId', 'variantName'], `${path}/target`, v)
			validateUuid(target.viewId, `${path}/target/viewId`, v, 'target viewId')
			if (Object.hasOwn(target, 'variantName')) v.string(target.variantName, `${path}/target/variantName`, true)
		}
		const outgoing = v.array(step.transitions, `${path}/transitions`)
		const triggers = new Set<string>()
		const targets: string[] = []
		outgoing?.forEach((transitionValue, index) => {
			const transitionPath = jsonPointer(`${path}/transitions`, index)
			const transition = v.object(transitionValue, transitionPath)
			if (!transition)
				return
			rejectUnknownKeys(transition, ['trigger', 'targetStepId'], transitionPath, v)
			if (Object.hasOwn(transition, 'id') || Object.hasOwn(transition, 'sourceStepId'))
				v.issue('flow.forbidden_transition_identity', transitionPath, 'A transition has no separate identity or sourceStepId; its source is the containing step key.')
			const trigger = v.object(transition.trigger, `${transitionPath}/trigger`)
			let triggerKey: string | undefined
			if (trigger) {
				rejectUnknownKeys(trigger, ['widgetId', 'event'], `${transitionPath}/trigger`, v)
				const widgetId = v.string(trigger.widgetId, `${transitionPath}/trigger/widgetId`, true)
				const event = v.string(trigger.event, `${transitionPath}/trigger/event`, true)
				if (widgetId !== undefined && event !== undefined)
					triggerKey = JSON.stringify([widgetId, event])
			}
			if (triggerKey !== undefined) {
				if (triggers.has(triggerKey))
					v.issue('flow.ambiguous_trigger', `${transitionPath}/trigger`, 'A source step may have at most one outgoing transition for each Widget Event identity.')
				triggers.add(triggerKey)
			}
			const targetStepId = transition.targetStepId
			if (validateUuid(targetStepId, `${transitionPath}/targetStepId`, v, 'targetStepId')) {
				if (!validStepIds.has(targetStepId))
					v.issue('flow.dangling_target_step', `${transitionPath}/targetStepId`, 'Transition targetStepId must identify a step in this Flow.')
				else
					targets.push(targetStepId)
			}
		})
		graph.set(stepId, targets)
	}

	if (validStepIds.has(String(flow.entryStepId))) {
		const reachable = new Set<string>()
		const queue = [String(flow.entryStepId)]
		while (queue.length) {
			const current = queue.shift()!
			if (reachable.has(current)) continue
			reachable.add(current)
			for (const target of graph.get(current) ?? [])
				if (!reachable.has(target)) queue.push(target)
		}
		for (const id of validStepIds) {
			if (!reachable.has(id))
				v.issue('flow.unreachable_step', jsonPointer('/steps', id), 'Every Flow step must be reachable from entryStepId.')
		}
	}
	return v.finish<FlowResource>(input)
}
