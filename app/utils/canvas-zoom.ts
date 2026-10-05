/**
 * Canvas zoom and fit arithmetic (brief b, section 7; DESIGN.md "Canvas").
 *
 * The iframe always keeps its canonical logical viewport size; these helpers only
 * compute the scale of the outer presentation frame and where the stage scrolls to.
 * Everything here is pure so it can be unit tested without a browser.
 */

/** Manual zoom steps (DESIGN.md): 25 / 50 / 67 / 75 / 90 / 100 / 125 / 150 / 200%. */
export const ZOOM_STEPS = Object.freeze([0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2])
/** The percentage menu (brief b, section 6), after "Fit". */
export const ZOOM_MENU_STEPS = Object.freeze([0.5, 0.75, 1, 1.5, 2])
/** Fit may go below the smallest step (a 1920px View on a phone), never below this. */
export const MIN_ZOOM = 0.05
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!
/** Fit-to-canvas gutter: 24px on desktop, 12px on tablet and mobile. */
export const CANVAS_GUTTER_DESKTOP = 24
export const CANVAS_GUTTER_COMPACT = 12
/** Wheel and pinch zoom sensitivity: one 100px wheel notch is about 18%. */
const WHEEL_ZOOM_RATE = 0.0018
/** A manual step must change the zoom noticeably: Fit at 66% steps to 75%, not to 67%. */
const STEP_MIN_RATIO = 1.05

export type Size = Readonly<{ width: number; height: number }>
export type Point = Readonly<{ x: number; y: number }>
export type ZoomMode = 'fit' | number
/**
 * Space kept around the frame inside the stage: the gutter on the sides and top, and at the
 * bottom the gutter plus the floating tool pill, so Fit never puts the View under the pill.
 */
export type CanvasInsets = Readonly<{ x: number; top: number; bottom: number }>

export function canvasInsets(gutter: number, bottomReserve = 0): CanvasInsets {
	return { x: gutter, top: gutter, bottom: Math.max(gutter, bottomReserve) }
}

export function clampZoom(scale: number): number {
	if (Number.isNaN(scale)) return 1
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale))
}

/**
 * The scale at which the whole frame fits the stage with the gutter on every side.
 * Fit never enlarges past 100%: a small View is shown at its real size.
 */
export function fitScale(frame: Size, stage: Size, insets: CanvasInsets): number {
	const width = stage.width - insets.x * 2
	const height = stage.height - insets.top - insets.bottom
	if (!(frame.width > 0) || !(frame.height > 0) || !(width > 0) || !(height > 0)) return 1
	return clampZoom(Math.min(1, width / frame.width, height / frame.height))
}

/** The next manual step above (direction 1) or below (direction -1) the current scale. */
export function stepZoom(current: number, direction: 1 | -1): number {
	if (direction > 0) return ZOOM_STEPS.find(step => step > current * STEP_MIN_RATIO) ?? MAX_ZOOM
	const below = [...ZOOM_STEPS].reverse().find(step => step < current / STEP_MIN_RATIO)
	return below ?? clampZoom(Math.min(current, ZOOM_STEPS[0]!))
}

/** Continuous zoom for Ctrl/⌘ + wheel and pinch; never tweened (DESIGN.md "Motion"). */
export function wheelZoom(current: number, deltaY: number): number {
	return clampZoom(current * Math.exp(-deltaY * WHEEL_ZOOM_RATE))
}

/** Where the scaled frame sits inside the scroll content: centered while it fits, else at the inset. */
export function frameOffset(frame: Size, scale: number, stage: Size, insets: CanvasInsets): Point {
	const freeHeight = stage.height - insets.top - insets.bottom - frame.height * scale
	return {
		x: Math.max(insets.x, (stage.width - frame.width * scale) / 2),
		y: insets.top + Math.max(0, freeHeight / 2),
	}
}

/** The scrollable content size: the stage itself, or the scaled frame plus its insets when larger. */
export function contentSize(frame: Size, scale: number, stage: Size, insets: CanvasInsets): Size {
	return {
		width: Math.max(stage.width, frame.width * scale + insets.x * 2),
		height: Math.max(stage.height, frame.height * scale + insets.top + insets.bottom),
	}
}

/**
 * The scroll position that keeps a logical frame point (`anchor`, in View CSS px) under the same
 * stage-viewport point (`viewportPoint`) after zooming to `scale`.
 */
export function anchoredScroll(input: Readonly<{
	frame: Size
	stage: Size
	insets: CanvasInsets
	scale: number
	anchor: Point
	viewportPoint: Point
}>): Point {
	const offset = frameOffset(input.frame, input.scale, input.stage, input.insets)
	const content = contentSize(input.frame, input.scale, input.stage, input.insets)
	const x = input.anchor.x * input.scale + offset.x - input.viewportPoint.x
	const y = input.anchor.y * input.scale + offset.y - input.viewportPoint.y
	return {
		x: clampRange(x, 0, content.width - input.stage.width),
		y: clampRange(y, 0, content.height - input.stage.height),
	}
}

/** The logical frame point currently under a stage-viewport point. */
export function logicalPointAt(input: Readonly<{
	frame: Size
	stage: Size
	insets: CanvasInsets
	scale: number
	scroll: Point
	viewportPoint: Point
}>): Point {
	const offset = frameOffset(input.frame, input.scale, input.stage, input.insets)
	return {
		x: (input.scroll.x + input.viewportPoint.x - offset.x) / input.scale,
		y: (input.scroll.y + input.viewportPoint.y - offset.y) / input.scale,
	}
}

/** Manual zoom per View and viewport, for this SPA document only (brief b, section 12: nothing is persisted). */
export const sessionZoomMemory = new Map<string, number>()

/** Session-only zoom memory per View and viewport (brief b, section 12: nothing is persisted). */
export function zoomMemoryKey(viewId: string, viewportId: string): string {
	return `${viewId}\u0000${viewportId}`
}

/** A 160ms zoom tween easing (DESIGN.md `--ease-out-quiet`, cubic-bezier(0.2, 0, 0, 1)), approximated. */
export function easeOutQuiet(t: number): number {
	const clamped = Math.min(1, Math.max(0, t))
	return 1 - (1 - clamped) ** 3
}

function clampRange(value: number, min: number, max: number): number {
	return Math.min(Math.max(min, max), Math.max(min, value))
}
