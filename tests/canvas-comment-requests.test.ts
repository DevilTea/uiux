import { describe, expect, it } from 'vitest'
import { createThreadBody, reanchorThreadBody } from '../app/utils/canvas-comment-requests'

/**
 * The canvas's Review request bodies (Part 7, schemaVersion 4): a new thread records its render
 * context (Rule 01a1170f-c0ce); a Workbench re-anchor never sends one, so the server keeps the
 * recorded context (Rule 01a11e0d-d3f8, owner ruling 2026-10-09 ruling 1).
 */

const VIEW_ID = '7f3d7780-3cb9-4e57-8f0b-2e8d569905c1'

describe('canvas comment request bodies', () => {
	it('sends the captured render context with a new thread, Root ("Comment on this View") included', () => {
		expect(createThreadBody({ viewId: VIEW_ID, widgetId: 'cta', variantNames: [], hint: { x: 0.25, y: 0.5 }, renderContext: { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' } })).toEqual({
			anchor: { viewId: VIEW_ID, widgetId: 'cta' },
			variantNames: [],
			displayHint: { pin: { x: 0.25, y: 0.5 } },
			renderContext: { locale: 'zh-TW', viewportId: 'mobile', themeId: 'dark' },
		})
		expect(createThreadBody({ viewId: VIEW_ID, widgetId: 'root', variantNames: ['compact'], renderContext: { locale: 'zh-TW' } })).toEqual({
			anchor: { viewId: VIEW_ID, widgetId: 'root' },
			variantNames: ['compact'],
			renderContext: { locale: 'zh-TW' },
		})
	})

	it('omits renderContext when nothing was captured', () => {
		expect(Object.keys(createThreadBody({ viewId: VIEW_ID, widgetId: 'cta', variantNames: [] })).sort()).toEqual(['anchor', 'variantNames'])
	})

	it('never sends renderContext on a re-anchor, so the recorded context is kept (Rule 01a11e0d-d3f8)', () => {
		const body = reanchorThreadBody({ expectedRevision: 'sha256:1', viewId: VIEW_ID, widgetId: 'cta', variantNames: ['compact'], hint: { x: 0.1, y: 0.9 } })
		expect(body).toEqual({ expectedRevision: 'sha256:1', anchor: { viewId: VIEW_ID, widgetId: 'cta' }, variantNames: ['compact'], displayHint: { pin: { x: 0.1, y: 0.9 } } })
		expect('renderContext' in body).toBe(false)
		// Even a caller that passes one through cannot smuggle it into the body.
		const smuggled = reanchorThreadBody({ expectedRevision: 'sha256:1', viewId: VIEW_ID, widgetId: 'root', variantNames: [], renderContext: { locale: 'zh-TW' } } as Parameters<typeof reanchorThreadBody>[0])
		expect('renderContext' in smuggled).toBe(false)
	})
})
