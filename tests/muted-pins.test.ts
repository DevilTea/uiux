import { describe, expect, it } from 'vitest'
import { canvasOrder, isClusterMuted, layoutPins, mutedItemKeys, pinStatuses } from '../app/utils/pin-layout'
import { renderContextDiffers, type PinPlacement, type PinRenderContext } from '../src/preview/pin-visibility'

/**
 * Muted pins (Part 7, issue #144): a thread recorded in another render context keeps its pin,
 * muted (Rule 01a1170f-c1ae); only recorded members are compared (Rule 01a1170f-c23d); a cluster
 * is muted only when all its pins are (Rule 01a11e0d-d4a0); muting never shows a hidden pin and
 * never moves one (Rule 01a1170f-c282).
 */

const CURRENT: PinRenderContext = { locale: 'en-US', viewportId: 'mobile', themeId: 'dark' }

describe('renderContextDiffers', () => {
	const table: ReadonlyArray<readonly [string, PinRenderContext | undefined, boolean]> = [
		['no recorded context', undefined, false],
		['an empty record', {}, false],
		['the same Locale only', { locale: 'en-US' }, false],
		['another Locale only', { locale: 'zh-TW' }, true],
		['the same viewport only', { viewportId: 'mobile' }, false],
		['another viewport only', { viewportId: 'desktop' }, true],
		['the same theme only', { themeId: 'dark' }, false],
		['another theme only', { themeId: 'light' }, true],
		['all three the same', { locale: 'en-US', viewportId: 'mobile', themeId: 'dark' }, false],
		['all the same but the theme', { locale: 'en-US', viewportId: 'mobile', themeId: 'light' }, true],
		['all the same but the viewport', { locale: 'en-US', viewportId: 'tablet', themeId: 'dark' }, true],
		['all the same but the Locale', { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' }, true],
		['Locale and theme the same, viewport not recorded', { locale: 'en-US', themeId: 'dark' }, false],
		['a stale key that the Preview can never show', { viewportId: 'watch' }, true],
	]
	it.each(table)('%s → %s', (_name, recorded, muted) => {
		expect(renderContextDiffers(recorded, CURRENT)).toBe(muted)
	})

	it('compares keys exactly: a Locale tag is case-sensitive as recorded', () => {
		expect(renderContextDiffers({ locale: 'zh-tw' }, { ...CURRENT, locale: 'zh-TW' })).toBe(true)
	})
})

const visible = (threadId: string, x: number, y: number): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'visible', point: { x, y } })
const hidden = (threadId: string, reason: PinPlacement['reason']): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'hidden', reason })
const offscreen = (threadId: string): PinPlacement => ({ threadId, widgetId: `w-${threadId}`, state: 'offscreen', edge: { side: 'bottom', scope: 'frame', point: { x: 0, y: 0 } } })

describe('muted clusters and placements', () => {
	it('mutes a cluster only when every pin in it is muted', () => {
		expect(isClusterMuted(['a', 'b'], new Set(['a', 'b']))).toBe(true)
		expect(isClusterMuted(['a', 'b'], new Set(['a']))).toBe(false)
		expect(isClusterMuted(['a', 'b'], new Set())).toBe(false)
		expect(isClusterMuted([], new Set(['a']))).toBe(false)
	})

	it('marks drawn items only: muted pins, and clusters whose every thread is muted', () => {
		// a+b cluster (both muted), c+d cluster (one muted), e alone (muted), f alone (not muted).
		const placements = [visible('a', 10, 100), visible('b', 20, 105), visible('c', 300, 100), visible('d', 310, 104), visible('e', 600, 10), visible('f', 900, 10)]
		const layout = layoutPins(placements)
		const keys = mutedItemKeys(layout, new Set(['a', 'b', 'c', 'e']))
		const byKey = new Map(layout.items.map(item => [item.key, item.kind === 'pin' ? item.threadId : item.threadIds.join('+')]))
		expect([...keys].map(key => byKey.get(key)).sort()).toEqual(['a+b', 'e'])
		expect(mutedItemKeys(undefined, new Set(['a']))).toEqual(new Set())
	})

	it('never draws a hidden or off-screen pin and never moves a drawn one', () => {
		const placements = [visible('a', 10, 10), hidden('b', 'other-variant'), hidden('c', 'point-not-visible'), offscreen('d'), visible('e', 400, 10)]
		const allMuted = new Set(['a', 'b', 'c', 'd', 'e'])
		const before = layoutPins(placements)
		const snapshot = structuredClone(before)
		const keys = mutedItemKeys(before, allMuted)
		// Only the drawn pins are muted; the hidden and off-screen threads get no item.
		expect([...keys].sort()).toEqual(['p:a', 'p:e'])
		// The layout, the statuses and the keyboard order are what placement made, point for point.
		expect(before).toEqual(snapshot)
		expect(layoutPins(placements)).toEqual(snapshot)
		expect(pinStatuses(placements).get('b')).toEqual({ state: 'hidden', reason: 'other-variant' })
		expect(pinStatuses(placements).get('c')).toEqual({ state: 'hidden', reason: 'point-not-visible' })
		expect(canvasOrder(placements)).toEqual(['a', 'e', 'd'])
	})
})
