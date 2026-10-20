import { toFlowDraft, orderSteps } from './flow-graph'
import type { Diagnostic } from '../composables/workbench-types'

/**
 * UX Flow usage of one View (Rule 01a116f0-89b6-7d08-a850-e1ee1aecd51f; issue #115): the Flows with
 * at least one step that targets the View, each step with its reading-order number and the Variant
 * it opens. Derived from the Flow resources the Workbench reads; nothing is persisted.
 */

/** One Flow as read by the Workbench: `resource` is `undefined` when the read failed or found nothing. */
export type FlowUsageSource = Readonly<{
	key: string
	name?: string
	diagnostics: readonly Diagnostic[]
	resource: unknown
}>

export type ViewFlowUsageStep = Readonly<{
	stepId: string
	/** 1-based position in the Flow's reading order (the number its step list shows). */
	ordinal: number
	/** `undefined` is the base state. */
	variantName?: string
}>

export type ViewFlowUsageEntry = Readonly<{
	flowKey: string
	name?: string
	steps: readonly ViewFlowUsageStep[]
	/** The Flow's own diagnostics: an invalid Flow is listed with them, never dropped. */
	diagnostics: readonly Diagnostic[]
}>

export type UnreadableFlow = Readonly<{ flowKey: string; name?: string; diagnostics: readonly Diagnostic[] }>

export type ViewFlowUsage = Readonly<{
	/** Flows with a step on the View, in the order given. */
	flows: readonly ViewFlowUsageEntry[]
	/** Flows that could not be read at all, so whether they use the View is unknown. */
	unreadable: readonly UnreadableFlow[]
}>

function hasSteps(resource: unknown): boolean {
	if (typeof resource !== 'object' || resource === null) return false
	const steps = (resource as { steps?: unknown }).steps
	return typeof steps === 'object' && steps !== null
}

export function deriveViewFlowUsage(viewId: string, sources: readonly FlowUsageSource[]): ViewFlowUsage {
	const flows: ViewFlowUsageEntry[] = []
	const unreadable: UnreadableFlow[] = []
	for (const source of sources) {
		const name = source.name ? { name: source.name } : {}
		if (!hasSteps(source.resource)) {
			unreadable.push({ flowKey: source.key, ...name, diagnostics: source.diagnostics })
			continue
		}
		const { draft } = toFlowDraft(source.resource)
		const { order } = orderSteps(draft)
		const steps: ViewFlowUsageStep[] = []
		order.forEach((stepId, index) => {
			const step = draft.steps[stepId]
			if (step?.target.viewId !== viewId) return
			steps.push({ stepId, ordinal: index + 1, ...(step.target.variantName !== undefined ? { variantName: step.target.variantName } : {}) })
		})
		if (steps.length) flows.push({ flowKey: source.key, ...name, steps, diagnostics: source.diagnostics })
	}
	return { flows, unreadable }
}
