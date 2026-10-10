import type { ViewDiff } from '../../src/domain/history/diff/view'
import type { CanvasInsets, Point, Size } from './canvas-zoom'

/**
 * The canvas before/after comparison's pure parts (issue #132, B9): which Widgets a comparison
 * outlines on which frame, and how two frames share one stage.
 */

/** Why a Widget is outlined: added, modified or moved on the after frame; removed on the before frame. */
export type HighlightKind = 'added' | 'modified' | 'moved' | 'removed'

export type WidgetHighlight = Readonly<{ widgetId: string; kinds: readonly HighlightKind[] }>

export type CanvasHighlights = Readonly<{
	before: readonly WidgetHighlight[]
	after: readonly WidgetHighlight[]
	/** The IR could not be matched by Widget ID, so the diff names no Widget to outline. */
	unmatched: boolean
}>

const KIND_ORDER: readonly HighlightKind[] = ['added', 'modified', 'moved', 'removed']

/**
 * Rule 01a11a5e-12dc-793c-8f66-2d58c032fa19, from the View's semantic diff: Widgets added, modified
 * (type, config, or the State override of the Variant being rendered) and moved (owner ruling
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18828964: a new parent or Slot,
 * or a new order among the siblings it kept) on the after frame, and removed Widgets on the before
 * frame. A Widget both modified and moved carries both kinds.
 */
export function canvasHighlights(diff: ViewDiff | undefined, variant?: string): CanvasHighlights {
	if (!diff) return { before: [], after: [], unmatched: false }
	const widgets = diff.widgets
	if (!widgets) return { before: [], after: [], unmatched: (diff.irChanges?.length ?? 0) > 0 }
	const after = new Map<string, Set<HighlightKind>>()
	const mark = (widgetId: string, kind: HighlightKind) => {
		const kinds = after.get(widgetId) ?? new Set<HighlightKind>()
		kinds.add(kind)
		after.set(widgetId, kinds)
	}
	for (const widget of widgets.added) mark(widget.id, 'added')
	for (const widget of widgets.typeChanged) mark(widget.id, 'modified')
	for (const widget of widgets.configChanged) mark(widget.id, 'modified')
	if (variant) for (const change of diff.variants.stateChanged) if (change.variant === variant) mark(change.widgetId, 'modified')
	for (const widget of widgets.moved) mark(widget.id, 'moved')
	// An added Widget is only added: a State override of a new Widget is part of adding it.
	for (const [widgetId, kinds] of after) if (kinds.has('added')) after.set(widgetId, new Set(['added']))
	return {
		before: widgets.removed.map(widget => ({ widgetId: widget.id, kinds: ['removed'] })),
		after: [...after].map(([widgetId, kinds]) => ({ widgetId, kinds: KIND_ORDER.filter(kind => kinds.has(kind)) })),
		unmatched: false,
	}
}

/** The space above each frame for its label, in stage px. */
export const FRAME_LABEL_PX = 28
/** The gap between the two frames, in stage px. */
export const FRAME_GAP_PX = 32

export type PairLayout = Readonly<{
	/** The stage's scrollable content size. */
	content: Size
	/** Each frame's top-left corner (its label sits above it), in stage px. */
	offsets: readonly [Point, Point]
}>

/** The scale at which both frames, side by side, fit the stage. Never above 100%. */
export function fitPairScale(frames: readonly [Size, Size], stage: Size, insets: CanvasInsets, minimum: number): number {
	const width = stage.width - insets.x * 2 - FRAME_GAP_PX
	const height = stage.height - insets.top - insets.bottom - FRAME_LABEL_PX
	const total = frames[0].width + frames[1].width
	const tallest = Math.max(frames[0].height, frames[1].height)
	if (width <= 0 || height <= 0 || total <= 0 || tallest <= 0) return minimum
	return Math.max(minimum, Math.min(1, width / total, height / tallest))
}

/**
 * Two frames side by side on one stage at one scale (Rule 01a11e45-6bbc-7c95-9759-e42a3308e7a5): the
 * stage is the only outer scroll container, so panning, zooming and scrolling it moves both frames
 * together, while each frame's own document scrolls alone. The pair is centered while it fits.
 */
export function pairLayout(frames: readonly [Size, Size], scale: number, stage: Size, insets: CanvasInsets): PairLayout {
	const first = { width: frames[0].width * scale, height: frames[0].height * scale }
	const second = { width: frames[1].width * scale, height: frames[1].height * scale }
	const pairWidth = first.width + FRAME_GAP_PX + second.width
	const pairHeight = FRAME_LABEL_PX + Math.max(first.height, second.height)
	const content = {
		width: Math.max(stage.width, pairWidth + insets.x * 2),
		height: Math.max(stage.height, pairHeight + insets.top + insets.bottom),
	}
	const left = Math.max(insets.x, (content.width - pairWidth) / 2)
	const top = Math.max(insets.top, (content.height - insets.bottom - pairHeight + insets.top) / 2) + FRAME_LABEL_PX
	return {
		content,
		offsets: [{ x: left, y: top }, { x: left + first.width + FRAME_GAP_PX, y: top }],
	}
}
