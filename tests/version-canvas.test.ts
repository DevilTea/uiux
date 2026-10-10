import { describe, expect, it } from 'vitest'

import { canvasHighlights, fitPairScale, FRAME_GAP_PX, FRAME_LABEL_PX, pairLayout } from '../app/utils/version-canvas'
import { diffView } from '../src/domain/history/diff/view'
import type { JsonValue } from '../src/domain/validation'
import { resolveFrameContext, type FrameContextSelection } from '../src/preview/version-frame-context'

/**
 * The canvas before/after comparison's pure parts (issue #132, B9): the frame render context and
 * its notices (Rules 01a11a5e-1288-7f86-a1cc-9b2fd0d2bd62 and 1331), the outlined Widgets (Rule
 * 01a11a5e-12dc-793c-8f66-2d58c032fa19) and the shared stage (Rule 01a11e45-6bbc-7c95-9759-e42a3308e7a5).
 */

const SELECTION: FrameContextSelection = { variant: 'empty', locale: 'zh-TW', viewportId: 'phone', width: 390, height: 844, themeId: 'dark' }

describe('resolveFrameContext', () => {
	it('keeps the canvas selection on a side that has every key, with that side\'s size for the viewport', () => {
		const resolved = resolveFrameContext(SELECTION, {
			manifest: { i18n: { defaultLocale: 'en-US' }, viewports: { phone: { dimensions: { width: 375, height: 812 } } }, themes: { dark: {}, light: {} } },
			view: { variants: { empty: { state: {} } } },
			locales: ['en-US', 'zh-TW'],
		})
		expect(resolved).toEqual({ context: { variant: 'empty', locale: 'zh-TW', viewportId: 'phone', width: 375, height: 812, themeId: 'dark' }, notices: [] })
	})

	it('renders the base state or the side\'s default for each key the side lacks, with a notice each', () => {
		const resolved = resolveFrameContext(SELECTION, {
			manifest: { i18n: { defaultLocale: 'en-US' }, viewports: { desktop: { dimensions: { width: 1440, height: 900 } } }, themes: { light: {} } },
			view: { variants: {} },
			locales: ['en-US'],
		})
		expect(resolved.context).toEqual({ locale: 'en-US', viewportId: 'desktop', width: 1440, height: 900, themeId: 'light' })
		expect(resolved.notices).toEqual([
			{ dimension: 'variant', requested: 'empty', used: '' },
			{ dimension: 'locale', requested: 'zh-TW', used: 'en-US' },
			{ dimension: 'viewport', requested: 'phone', used: 'desktop' },
			{ dimension: 'theme', requested: 'dark', used: 'light' },
		])
	})

	it('accepts the built-in defaults on a side that authors no viewports or themes', () => {
		const resolved = resolveFrameContext({ locale: 'en-US', viewportId: 'default', width: 1280, height: 800, themeId: 'light' }, { manifest: { i18n: { defaultLocale: 'en-US' }, viewports: {}, themes: {} }, locales: [] })
		expect(resolved).toEqual({ context: { locale: 'en-US', viewportId: 'default', width: 1280, height: 800, themeId: 'light' }, notices: [] })
	})
})

type Json = JsonValue
const RootShell = (content: Json[]): Json => ({ id: 'root', type: 'RootShell', slots: { content } })
const node = (id: string, config: Record<string, Json> = {}, slots?: Record<string, Json[]>): Json => ({ id, type: 'Text', config, ...(slots ? { slots } : {}) })

describe('canvasHighlights', () => {
	it('outlines added, modified and moved Widgets on the after frame and removed ones on the before frame', () => {
		const before = { ir: RootShell([node('kept'), node('changed', { text: 'a' }), node('group', {}, { content: [node('mover')] }), node('gone'), node('first'), node('second')]), variants: {} }
		const after = { ir: RootShell([node('kept'), node('changed', { text: 'b' }), node('group'), node('mover'), node('new'), node('second'), node('first')]), variants: {} }
		const highlights = canvasHighlights(diffView(before, after))
		expect(highlights.unmatched).toBe(false)
		expect(highlights.before).toEqual([{ widgetId: 'gone', kinds: ['removed'] }])
		const after_ = Object.fromEntries(highlights.after.map(item => [item.widgetId, item.kinds]))
		expect(after_.new).toEqual(['added'])
		expect(after_.changed).toEqual(['modified'])
		// A new parent is a move (owner ruling discussioncomment-18828964).
		expect(after_.mover).toEqual(['moved'])
		// Two kept siblings that swapped order: one of them moved.
		expect(['first', 'second'].filter(id => after_[id]?.includes('moved'))).toHaveLength(1)
		// Siblings that only shifted beside an added or removed Widget are not moved.
		expect(after_.kept).toBeUndefined()
	})

	it('counts a State override change only for the Variant being rendered', () => {
		const before = { ir: RootShell([node('label')]), variants: { empty: { state: { label: { hidden: false } } } } }
		const after = { ir: RootShell([node('label')]), variants: { empty: { state: { label: { hidden: true } } } } }
		expect(canvasHighlights(diffView(before, after)).after).toEqual([])
		expect(canvasHighlights(diffView(before, after), 'other').after).toEqual([])
		expect(canvasHighlights(diffView(before, after), 'empty').after).toEqual([{ widgetId: 'label', kinds: ['modified'] }])
	})

	it('outlines nothing when the IR cannot be matched by Widget ID', () => {
		const before = { ir: RootShell([{ type: 'Text' }]), variants: {} }
		const after = { ir: RootShell([{ type: 'Text', config: { text: 'x' } }]), variants: {} }
		expect(canvasHighlights(diffView(before, after))).toEqual({ before: [], after: [], unmatched: true })
		expect(canvasHighlights(undefined)).toEqual({ before: [], after: [], unmatched: false })
	})
})

describe('pairLayout', () => {
	const insets = { x: 32, top: 32, bottom: 32 }

	it('fits both frames side by side at one scale, never above 100%', () => {
		const frames = [{ width: 1280, height: 800 }, { width: 1280, height: 800 }] as const
		const scale = fitPairScale(frames, { width: 1000, height: 900 }, insets, 0.05)
		expect(scale).toBeCloseTo((1000 - 64 - FRAME_GAP_PX) / 2560)
		expect(fitPairScale([{ width: 100, height: 100 }, { width: 100, height: 100 }], { width: 4000, height: 4000 }, insets, 0.05)).toBe(1)
	})

	it('places the frames on one stage with one gap, so scrolling the stage moves both', () => {
		const frames = [{ width: 400, height: 300 }, { width: 200, height: 500 }] as const
		const layout = pairLayout(frames, 1, { width: 500, height: 400 }, insets)
		expect(layout.content).toEqual({ width: 400 + FRAME_GAP_PX + 200 + 64, height: FRAME_LABEL_PX + 500 + 64 })
		expect(layout.offsets[0]).toEqual({ x: 32, y: 32 + FRAME_LABEL_PX })
		expect(layout.offsets[1]).toEqual({ x: 32 + 400 + FRAME_GAP_PX, y: 32 + FRAME_LABEL_PX })
	})
})
