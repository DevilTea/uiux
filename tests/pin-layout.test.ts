import { describe, expect, it } from 'vitest'
import { canvasOrder, compareReadingOrder, cycleThread, layoutPins, pinStatuses } from '../app/utils/pin-layout'
import type { PinPlacement } from '../src/preview/pin-visibility'

const visible = (threadId: string, x: number, y: number): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'visible', point: { x, y } })
const offscreen = (threadId: string, side: 'top' | 'bottom'): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'offscreen', edge: { side, scope: 'frame', point: { x: 0, y: 0 } } })
const hidden = (threadId: string, reason: PinPlacement['reason']): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'hidden', reason })

describe('pin layout (R7b)', () => {
	it('reads top to bottom, and left to right within a 4px row', () => {
		expect(compareReadingOrder({ x: 100, y: 10 }, { x: 0, y: 30 })).toBeLessThan(0)
		expect(compareReadingOrder({ x: 100, y: 12 }, { x: 0, y: 10 })).toBeGreaterThan(0)
	})

	it('clusters pins within 24px, keeps solo threads apart and orders items for Tab', () => {
		const placements = [visible('a', 10, 100), visible('b', 20, 105), visible('c', 300, 20), visible('d', 15, 102), hidden('e', 'point-not-visible')]
		const layout = layoutPins(placements)
		expect(layout.items.map(item => item.kind === 'pin' ? item.threadId : item.threadIds.join('+'))).toEqual(['c', 'a+b+d'])
		const solo = layoutPins(placements, { solo: new Set(['b']) })
		expect(solo.items.map(item => item.kind === 'pin' ? item.threadId : item.threadIds.join('+'))).toEqual(['c', 'a+d', 'b'])
		expect(layoutPins(placements, { excluded: new Set(['c']) }).items.map(item => item.key)).toEqual(['c:a'])
	})

	it('keeps the structural key when pins only move, and changes it when membership changes', () => {
		const before = layoutPins([visible('a', 10, 10), visible('b', 200, 10)])
		const moved = layoutPins([visible('a', 10, -90), visible('b', 200, -90)])
		expect(moved.key).toBe(before.key)
		expect(layoutPins([visible('a', 10, 10), visible('b', 20, 10)]).key).not.toBe(before.key)
	})

	it('returns the previous status map while no thread changes state', () => {
		const first = pinStatuses([visible('a', 0, 0), offscreen('b', 'bottom')])
		expect(pinStatuses([visible('a', 5, 9), offscreen('b', 'bottom')], first)).toBe(first)
		const next = pinStatuses([visible('a', 5, 9), offscreen('b', 'top')], first)
		expect(next).not.toBe(first)
		expect(next.get('b')).toEqual({ state: 'offscreen', side: 'top' })
	})

	it('cycles drawn pins in reading order, then edge threads, wrapping both ways', () => {
		const order = canvasOrder([offscreen('z', 'bottom'), visible('b', 50, 50), hidden('h', 'over-cap'), visible('a', 10, 10), offscreen('y', 'top')])
		expect(order).toEqual(['a', 'b', 'y', 'z'])
		expect(cycleThread(order, undefined, 1)).toBe('a')
		expect(cycleThread(order, undefined, -1)).toBe('z')
		expect(cycleThread(order, 'z', 1)).toBe('a')
		expect(cycleThread(order, 'a', -1)).toBe('z')
		expect(cycleThread([], 'a', 1)).toBeUndefined()
	})
})
