import { describe, expect, it } from 'vitest'
import {
	anchoredScroll,
	canvasInsets,
	contentSize,
	fitScale,
	frameOffset,
	logicalPointAt,
	MAX_ZOOM,
	MIN_ZOOM,
	stepZoom,
	wheelZoom,
	ZOOM_STEPS,
} from '../app/utils/canvas-zoom'

/** The three dogfood Workspace viewport presets (design/.uiux/workspace.json). */
const PRESETS = { desktop: { width: 1920, height: 1080 }, tablet: { width: 1024, height: 768 }, mobile: { width: 390, height: 844 } }
/** Representative canvas stages inside the three Workbench window sizes (both panels open at FHD). */
const STAGES = { fhd: { width: 1316, height: 992 }, tablet: { width: 968, height: 680 }, phone: { width: 390, height: 708 } }
const insets = canvasInsets(24, 64)

describe('canvas Fit', () => {
	it('fits every Workspace viewport inside every Workbench stage with the gutter and the tool pill reserve', () => {
		for (const frame of Object.values(PRESETS)) {
			for (const stage of Object.values(STAGES)) {
				const scale = fitScale(frame, stage, insets)
				expect(scale).toBeGreaterThan(0)
				expect(scale).toBeLessThanOrEqual(1)
				expect(frame.width * scale).toBeLessThanOrEqual(stage.width - insets.x * 2 + 1e-9)
				expect(frame.height * scale).toBeLessThanOrEqual(stage.height - insets.top - insets.bottom + 1e-9)
				// The frame is centered horizontally and never under the pill reserve.
				const offset = frameOffset(frame, scale, stage, insets)
				expect(offset.x).toBeCloseTo((stage.width - frame.width * scale) / 2, 6)
				expect(offset.y + frame.height * scale).toBeLessThanOrEqual(stage.height - insets.bottom + 1e-9)
				// Fit never needs scrolling.
				expect(contentSize(frame, scale, stage, insets)).toEqual(stage)
			}
		}
	})

	it('never enlarges a small View past 100%', () => {
		expect(fitScale(PRESETS.mobile, { width: 3000, height: 3000 }, insets)).toBe(1)
	})

	it('fits the desktop preset at the exact ratio rather than snapping down to a step', () => {
		expect(fitScale(PRESETS.desktop, STAGES.fhd, insets)).toBeCloseTo((1316 - 48) / 1920, 9)
	})

	it('treats an unmeasured stage as 100%', () => {
		expect(fitScale(PRESETS.desktop, { width: 0, height: 0 }, insets)).toBe(1)
	})
})

describe('canvas zoom steps', () => {
	it('steps through the DESIGN.md scale with a noticeable change', () => {
		expect(ZOOM_STEPS).toEqual([0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.25, 1.5, 2])
		expect(stepZoom(0.66, 1)).toBe(0.75)
		expect(stepZoom(0.66, -1)).toBe(0.5)
		expect(stepZoom(1, 1)).toBe(1.25)
		expect(stepZoom(1, -1)).toBe(0.9)
		expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM)
	})

	it('keeps a fit below the smallest step instead of jumping up when zooming out', () => {
		expect(stepZoom(0.19, -1)).toBe(0.19)
		expect(stepZoom(0.19, 1)).toBe(0.25)
	})

	it('zooms continuously for the wheel and clamps to the supported range', () => {
		expect(wheelZoom(1, -100)).toBeGreaterThan(1)
		expect(wheelZoom(1, 100)).toBeLessThan(1)
		expect(wheelZoom(1, -1e6)).toBe(MAX_ZOOM)
		expect(wheelZoom(1, 1e6)).toBe(MIN_ZOOM)
	})
})

describe('canvas zoom anchoring', () => {
	it('keeps the logical point under the pointer still while zooming in and out', () => {
		const frame = PRESETS.desktop
		const stage = STAGES.fhd
		const viewportPoint = { x: 400, y: 300 }
		const before = { scale: 0.66, scroll: { x: 0, y: 0 } }
		const anchor = logicalPointAt({ frame, stage, insets, scale: before.scale, scroll: before.scroll, viewportPoint })
		for (const scale of [0.25, 1, 1.5, 2]) {
			const scroll = anchoredScroll({ frame, stage, insets, scale, anchor, viewportPoint })
			const after = logicalPointAt({ frame, stage, insets, scale, scroll, viewportPoint })
			// Clamping at the scroll edges may move it; inside the scrollable range it stays put.
			const content = contentSize(frame, scale, stage, insets)
			if (scroll.x > 0 && scroll.x < content.width - stage.width) expect(after.x).toBeCloseTo(anchor.x, 6)
			if (scroll.y > 0 && scroll.y < content.height - stage.height) expect(after.y).toBeCloseTo(anchor.y, 6)
		}
	})

	it('never scrolls outside the content', () => {
		const scroll = anchoredScroll({ frame: PRESETS.desktop, stage: STAGES.fhd, insets, scale: 2, anchor: { x: 1920, y: 1080 }, viewportPoint: { x: 0, y: 0 } })
		const content = contentSize(PRESETS.desktop, 2, STAGES.fhd, insets)
		expect(scroll.x).toBeLessThanOrEqual(content.width - STAGES.fhd.width)
		expect(scroll.y).toBeLessThanOrEqual(content.height - STAGES.fhd.height)
		expect(anchoredScroll({ frame: PRESETS.desktop, stage: STAGES.fhd, insets, scale: 2, anchor: { x: 0, y: 0 }, viewportPoint: { x: 900, y: 900 } })).toEqual({ x: 0, y: 0 })
	})
})
