import type { DecisionRead, ViewRead } from '../composables/workbench-types'
import { decisionSourceThread } from './widget-inspection'

/**
 * Decision lifecycle helpers for the Workbench (issue #86): which actions a status offers (Clause
 * 01a11544-6854-7c6d-b420-4747804aab8d), whether a thread already has a Decision, and the rows of the
 * cross-View pending list (Rule 01a11544-5f18-77ac-b89e-56ced4056f19).
 */
export type DecisionAction = 'defer' | 'decide' | 'reopen'

/** The actions a Decision's status allows: pending defers or decides, deferred decides or reopens, decided reopens. */
export function decisionActionsFor(status: DecisionRead['status']): readonly DecisionAction[] {
	if (status === 'pending') return ['defer', 'decide']
	if (status === 'deferred') return ['decide', 'reopen']
	return ['reopen']
}

/**
 * Whether the View holds a Decision from the thread: `undefined` when `view` is not the thread's View
 * (or not loaded), so the caller cannot tell.
 */
export function promotedIn(
	view: ViewRead | undefined,
	thread: Readonly<{ id: string; viewId?: string; anchor?: unknown }> | undefined,
): boolean | undefined {
	if (!view || !thread) return undefined
	const anchor = thread.anchor as { viewId?: unknown } | undefined
	const viewId = thread.viewId ?? (typeof anchor?.viewId === 'string' ? anchor.viewId : undefined)
	if (viewId !== view.key) return undefined
	return view.resource.spec.decisions.some(decision => decisionSourceThread(decision) === thread.id)
}

/** The anchor facts of a Decision's source thread that its list entry navigates to. */
export type PendingDecisionTarget = Readonly<{ widgetId?: string; variant?: string }>

export type PendingDecisionRow = Readonly<{
	viewId: string
	viewName: string
	decision: DecisionRead
	/** The Widget and Variant of the source thread, when known. */
	target: PendingDecisionTarget
}>

type ThreadAnchorFacts = Readonly<{ widgetId?: string; variantNames?: readonly string[] }>

/**
 * The pending Decisions of the given Views, in View order then Spec order. `anchorOf` gives the
 * source thread's Widget and Variants when the thread is known; a root-anchored thread or a
 * View-wide one names neither.
 */
export function pendingDecisionRows(
	views: readonly Readonly<{ key: string; name: string; read: ViewRead | undefined }>[],
	anchorOf: (threadId: string) => ThreadAnchorFacts | undefined,
): readonly PendingDecisionRow[] {
	const rows: PendingDecisionRow[] = []
	for (const view of views) {
		for (const decision of view.read?.resource.spec.decisions ?? []) {
			if (decision.status !== 'pending') continue
			const threadId = decisionSourceThread(decision)
			const facts = threadId ? anchorOf(threadId) : undefined
			const widgetId = facts?.widgetId && facts.widgetId !== 'root' ? facts.widgetId : undefined
			const variant = facts?.variantNames?.length === 1 ? facts.variantNames[0] : undefined
			rows.push({ viewId: view.key, viewName: view.name, decision, target: { ...(widgetId ? { widgetId } : {}), ...(variant ? { variant } : {}) } })
		}
	}
	return rows
}
