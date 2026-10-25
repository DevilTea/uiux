import type { ReviewAnchorTarget } from '../reviews/anchor-state'
import { isFullUuid, isRecord, jsonPointer, type Diagnostic } from '../validation'

/**
 * Rule 01a11544-629c-7dbf-8e41-36c8e37537b3: the structured diagnostics of a Flow's invalid View, Variant
 * and Widget references. The authored reference is never rebound or rewritten; it is only reported, at
 * the path of the reference. The codes are the Workbench's reference-check codes (`app/utils/flow-graph.ts`)
 * and, like the `flow.*` codes, are not part of any Contract.
 *
 * `target` answers what the Workspace holds for a View: `null` when it does not exist, otherwise the
 * Variant names and Widget IDs it knows (a member is left out while unknown, such as for a View that
 * cannot be read, and is then not checked). A Widget Event name is never checked (Rule
 * 01a11544-62f1-7d7e-93a2-33691c947f24). The input may be a Flow read with diagnostics, so it is read
 * defensively: whatever is not of the expected shape is skipped, since the structural diagnostics name it.
 */
export async function flowReferenceDiagnostics(
	flow: unknown,
	target: (viewId: string) => Promise<ReviewAnchorTarget>,
): Promise<readonly Diagnostic[]> {
	const steps = isRecord(flow) && isRecord(flow.steps) ? flow.steps : undefined
	if (!steps) return []
	const diagnostics: Diagnostic[] = []
	for (const [stepId, step] of Object.entries(steps)) {
		if (!isRecord(step) || !isRecord(step.target)) continue
		const { viewId, variantName } = step.target
		if (!isFullUuid(viewId)) continue
		const known = await target(viewId)
		const stepPath = jsonPointer('/steps', stepId)
		if (known === null) {
			diagnostics.push({ code: 'reference.missing_view', path: `${stepPath}/target/viewId`, message: `The step targets View ${viewId}, which does not exist in this Workspace.` })
			continue
		}
		if (typeof variantName === 'string' && variantName !== '' && known.variantNames && !known.variantNames.has(variantName))
			diagnostics.push({ code: 'reference.missing_variant', path: `${stepPath}/target/variantName`, message: `The step targets Variant "${variantName}", which View ${viewId} does not have.` })
		if (!known.widgetIds || !Array.isArray(step.transitions)) continue
		step.transitions.forEach((transition, index) => {
			const widgetId = isRecord(transition) && isRecord(transition.trigger) ? transition.trigger.widgetId : undefined
			if (typeof widgetId !== 'string' || widgetId === '' || known.widgetIds!.has(widgetId)) return
			diagnostics.push({ code: 'reference.missing_widget', path: `${jsonPointer(`${stepPath}/transitions`, index)}/trigger/widgetId`, message: `The transition is triggered by Widget ${widgetId}, which View ${viewId} does not have.` })
		})
	}
	return diagnostics
}
