import type { ReviewRenderContext } from '../../src/domain/reviews/schema'

type Hint = Readonly<{ x: number; y: number }>

/**
 * The canvas's `POST /api/reviews` body: the anchor, the Variant scope, the pin hint when there is
 * one, and the recorded render context when any member is a Workspace-local key (Rule
 * 01a1170f-c0ce). The actor is never sent: the server stamps it.
 */
export function createThreadBody(input: Readonly<{
	viewId: string
	widgetId: string
	variantNames: readonly string[]
	hint?: Hint
	renderContext?: ReviewRenderContext
}>): Record<string, unknown> {
	return {
		anchor: { viewId: input.viewId, widgetId: input.widgetId },
		variantNames: [...input.variantNames],
		...(input.hint ? { displayHint: { pin: input.hint } } : {}),
		...(input.renderContext ? { renderContext: input.renderContext } : {}),
	}
}

/**
 * The canvas's re-anchor body: the new Widget, the thread's scope and the new click's hint. It never
 * carries `renderContext`, so the server keeps the recorded one (Rule 01a11e0d-d3f8).
 */
export function reanchorThreadBody(input: Readonly<{
	expectedRevision: string
	viewId: string
	widgetId: string
	variantNames: readonly string[]
	hint?: Hint
}>): Record<string, unknown> {
	return {
		expectedRevision: input.expectedRevision,
		anchor: { viewId: input.viewId, widgetId: input.widgetId },
		variantNames: [...input.variantNames],
		...(input.hint ? { displayHint: { pin: input.hint } } : {}),
	}
}
