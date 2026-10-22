/** Keyboard move of a comment pin within its Widget (issue #118). Hints are physical, Widget-relative 0..1. */

/** One arrow press moves 1 % of the Widget's width or height; with Shift, 10 %. */
export const PIN_FINE_STEP = 0.01
export const PIN_COARSE_STEP = 0.1

export type PinHint = Readonly<{ x: number; y: number }>

/** Moves `hint` by `dx` and `dy` steps (-1, 0 or 1), clamped to the Widget; rounds away float drift. */
export function nudgePinHint(hint: PinHint, step: Readonly<{ dx: number; dy: number; coarse: boolean }>): PinHint {
	const size = step.coarse ? PIN_COARSE_STEP : PIN_FINE_STEP
	const move = (value: number, direction: number) => Math.min(1, Math.max(0, Math.round((value + direction * size) * 1e4) / 1e4))
	return { x: move(hint.x, step.dx), y: move(hint.y, step.dy) }
}
