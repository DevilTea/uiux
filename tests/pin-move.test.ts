import { describe, expect, it } from 'vitest'
import { nudgePinHint } from '../app/utils/pin-move'

describe('nudgePinHint (issue #118)', () => {
	it('moves 1 % per arrow and 10 % with Shift, without float drift', () => {
		expect(nudgePinHint({ x: 0.5, y: 0.5 }, { dx: 1, dy: 0, coarse: false })).toEqual({ x: 0.51, y: 0.5 })
		expect(nudgePinHint({ x: 0.5, y: 0.5 }, { dx: 0, dy: -1, coarse: true })).toEqual({ x: 0.5, y: 0.4 })
		let hint = { x: 0.1, y: 0.1 }
		for (let index = 0; index < 7; index++) hint = nudgePinHint(hint, { dx: 1, dy: 1, coarse: false })
		expect(hint).toEqual({ x: 0.17, y: 0.17 })
	})

	it('stays inside the Widget', () => {
		expect(nudgePinHint({ x: 0.995, y: 0.02 }, { dx: 1, dy: -1, coarse: true })).toEqual({ x: 1, y: 0 })
		expect(nudgePinHint({ x: 0, y: 1 }, { dx: -1, dy: 1, coarse: false })).toEqual({ x: 0, y: 1 })
	})
})
