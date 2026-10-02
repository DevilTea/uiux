import { describe, expect, it } from 'vitest'

import { PreviewNavigationState, type PreviewNavigationTarget } from '../src/preview/navigation-state'

function target(request: string, view = 'view-a', widget = 'widget-a', overrides: Partial<PreviewNavigationTarget> = {}): PreviewNavigationTarget {
	return {
		navigationRequestId: request,
		viewId: view,
		variantId: 'default',
		runtimeContextVersion: 3,
		widgetId: widget,
		...overrides,
	}
}

describe('Workbench Preview navigation state', () => {
	it('applies structural selection before geometry and accepts only strictly newer current-context reports', () => {
		const state = new PreviewNavigationState()
		const requested = target('nav-1')
		expect(state.requestChecksNavigation(requested)).toEqual({ status: 'execute', target: requested })
		expect(state.applyNavigationResolution(requested, 'resolved')).toEqual({ status: 'applied' })
		expect(state.snapshot()).toMatchObject({
			currentViewId: 'view-a', selectedWidgetId: 'widget-a', highlightState: 'awaiting-geometry', geometryTracking: 'active',
		})

		expect(state.acceptGeometry({ ...requested, geometryRevision: 4, visibility: 'visible' })).toEqual({
			status: 'accepted', geometryRevision: 4, highlight: 'visible',
		})
		expect(state.snapshot()).toMatchObject({ highlightState: 'visible', overlayVisible: true, latestGeometryRevision: 4 })
		expect(state.acceptGeometry({ ...requested, geometryRevision: 4, visibility: 'hidden' })).toEqual({ status: 'stale' })
		expect(state.acceptGeometry({ ...requested, geometryRevision: 3, visibility: 'hidden' })).toEqual({ status: 'stale' })
		expect(state.snapshot().highlightState).toBe('visible')
	})

	it('rejects delayed geometry when request, View, Variant, runtime context, or Widget no longer matches', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-1')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		const mismatches = [
			{ navigationRequestId: 'old' },
			{ viewId: 'other-view' },
			{ variantId: 'other' },
			{ runtimeContextVersion: 4 },
			{ widgetId: 'other-widget' },
		]
		for (const mismatch of mismatches) {
			expect(state.acceptGeometry({ ...current, ...mismatch, geometryRevision: 1, visibility: 'visible' })).toEqual({ status: 'stale' })
		}
		expect(state.snapshot().highlightState).toBe('awaiting-geometry')
	})

	it('keeps structural selection while hiding the Preview highlight for hidden/offscreen/unmeasurable geometry', () => {
		for (const visibility of ['hidden', 'offscreen', 'unmeasurable'] as const) {
			const state = new PreviewNavigationState()
			const current = target('nav-1')
			state.requestChecksNavigation(current)
			state.applyNavigationResolution(current, 'resolved')
			expect(state.acceptGeometry({ ...current, geometryRevision: 1, visibility })).toMatchObject({ status: 'accepted', highlight: 'hidden' })
			expect(state.snapshot()).toMatchObject({ selectedWidgetId: 'widget-a', highlightState: 'hidden', overlayVisible: false })
		}
	})

	it('preserves all current state when the requested View disappeared', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-current')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		state.acceptGeometry({ ...current, geometryRevision: 2, visibility: 'visible' })
		const before = state.snapshot()

		const missing = target('nav-missing', 'gone-view', 'widget-x')
		state.requestChecksNavigation(missing)
		expect(state.applyNavigationResolution(missing, 'missing-view')).toEqual({ status: 'missing-view', target: missing })
		const after = state.snapshot()
		expect(after.currentViewId).toBe(before.currentViewId)
		expect(after.selectedWidgetId).toBe(before.selectedWidgetId)
		expect(after.activeHighlightTarget).toEqual(before.activeHighlightTarget)
		expect(after.highlightState).toBe('visible')
		expect(after.overlayVisible).toBe(true)
	})

	it('opens a surviving View structurally and keeps a persistent invalid-Widget diagnostic when Widget resolution fails', () => {
		const state = new PreviewNavigationState()
		const missingWidget = target('nav-1', 'view-b', 'deleted-widget', { variantId: 'state-b', runtimeContextVersion: 9 })
		state.requestChecksNavigation(missingWidget)
		expect(state.applyNavigationResolution(missingWidget, 'missing-widget')).toEqual({ status: 'missing-widget', target: missingWidget })
		expect(state.snapshot()).toMatchObject({
			currentViewId: 'view-b', currentVariantId: 'state-b', currentRuntimeContextVersion: 9,
			highlightState: 'none', overlayVisible: false, geometryTracking: 'inactive', invalidWidgetDiagnostic: missingWidget,
		})
		expect('selectedWidgetId' in state.snapshot()).toBe(false)
	})

	it('defers Checks navigation during comment mode and retains only the latest requested target', () => {
		const state = new PreviewNavigationState()
		expect(state.enterCommentMode()).toEqual({ overlayHidden: false, trackingSuspended: false })
		const first = target('nav-1', 'view-a', 'widget-a')
		const second = target('nav-2', 'view-b', 'widget-b')
		expect(state.requestChecksNavigation(first)).toEqual({ status: 'deferred', target: first })
		expect(state.requestChecksNavigation(second)).toEqual({ status: 'deferred', target: second, replacedNavigationRequestId: 'nav-1' })
		expect(state.snapshot().deferredTarget).toEqual(second)
		expect(state.exitCommentMode()).toEqual({ deferredTarget: second, reacquireHighlight: false })
		expect(state.snapshot().pendingTarget).toEqual(second)
		expect(state.applyNavigationResolution(first, 'resolved')).toMatchObject({ status: 'stale' })
		expect(state.applyNavigationResolution(second, 'resolved')).toEqual({ status: 'applied' })
	})

	it('does not claim it hid an overlay that was already non-visible when comment mode begins', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-current')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		expect(state.snapshot().highlightState).toBe('awaiting-geometry')
		expect(state.enterCommentMode()).toEqual({ overlayHidden: false, trackingSuspended: true })
		expect(state.enterCommentMode()).toEqual({ overlayHidden: false, trackingSuspended: true })
	})

	it('hides and suspends an existing highlight in comment mode, then reacquires it on exit without changing structural selection', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-current')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		state.acceptGeometry({ ...current, geometryRevision: 1, visibility: 'visible' })
		expect(state.enterCommentMode()).toEqual({ overlayHidden: true, trackingSuspended: true })
		expect(state.snapshot()).toMatchObject({
			commentMode: true, selectedWidgetId: 'widget-a', highlightState: 'visible', overlayVisible: false, geometryTracking: 'suspended',
		})
		expect(state.acceptGeometry({ ...current, geometryRevision: 2, visibility: 'visible' })).toEqual({ status: 'suspended' })
		expect(state.exitCommentMode()).toEqual({ reacquireHighlight: true })
		expect(state.snapshot()).toMatchObject({
			commentMode: false, selectedWidgetId: 'widget-a', highlightState: 'awaiting-geometry', overlayVisible: false, geometryTracking: 'active',
			latestGeometryRevision: 1,
		})
		expect(state.acceptGeometry({ ...current, geometryRevision: 2, visibility: 'visible' }).status).toBe('accepted')
	})

	it('restores the prior highlight when a deferred navigation later resolves to a missing View', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-current')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		state.acceptGeometry({ ...current, geometryRevision: 3, visibility: 'visible' })
		state.enterCommentMode()
		const missing = target('nav-missing', 'gone-view', 'widget-z')
		state.requestChecksNavigation(missing)
		expect(state.exitCommentMode()).toEqual({ deferredTarget: missing, reacquireHighlight: true })
		expect(state.applyNavigationResolution(missing, 'missing-view').status).toBe('missing-view')
		expect(state.snapshot()).toMatchObject({
			currentViewId: 'view-a', selectedWidgetId: 'widget-a', activeHighlightTarget: current,
			highlightState: 'awaiting-geometry', geometryTracking: 'active',
		})
	})

	it('makes older async navigation resolutions stale when a newer immediate request replaces them', () => {
		const state = new PreviewNavigationState()
		const first = target('nav-1', 'view-a', 'widget-a')
		const second = target('nav-2', 'view-b', 'widget-b')
		state.requestChecksNavigation(first)
		state.requestChecksNavigation(second)
		expect(state.applyNavigationResolution(first, 'resolved').status).toBe('stale')
		expect(state.applyNavigationResolution(second, 'resolved').status).toBe('applied')
		expect(state.snapshot()).toMatchObject({ currentViewId: 'view-b', selectedWidgetId: 'widget-b' })
	})

	it('resets only the geometry-revision domain at a runtime-generation boundary while preserving structural selection', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-1')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		state.acceptGeometry({ ...current, geometryRevision: 7, visibility: 'visible' })
		expect(state.onRuntimeGenerationBoundary()).toEqual({ structuralSelectionPreserved: true, reacquireAfterHandshake: true })
		const snapshot = state.snapshot()
		expect(snapshot).toMatchObject({ selectedWidgetId: 'widget-a', activeHighlightTarget: current, highlightState: 'awaiting-geometry', overlayVisible: false })
		expect('latestGeometryRevision' in snapshot).toBe(false)
		expect(state.acceptGeometry({ ...current, geometryRevision: 0, visibility: 'visible' })).toMatchObject({ status: 'accepted', geometryRevision: 0 })
	})

	it('invalidates current geometry without resetting the accepted revision freshness floor', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-1')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		state.acceptGeometry({ ...current, geometryRevision: 7, visibility: 'visible' })
		expect(state.invalidateCurrentGeometry()).toEqual({ reacquire: true })
		expect(state.snapshot()).toMatchObject({ highlightState: 'awaiting-geometry', latestGeometryRevision: 7 })
		expect(state.acceptGeometry({ ...current, geometryRevision: 7, visibility: 'visible' })).toEqual({ status: 'stale' })
		expect(state.acceptGeometry({ ...current, geometryRevision: 8, visibility: 'visible' }).status).toBe('accepted')
	})

	it('rejects invalid geometry revisions without mutating highlight state', () => {
		const state = new PreviewNavigationState()
		const current = target('nav-1')
		state.requestChecksNavigation(current)
		state.applyNavigationResolution(current, 'resolved')
		for (const geometryRevision of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(state.acceptGeometry({ ...current, geometryRevision, visibility: 'visible' })).toEqual({ status: 'invalid-revision' })
		}
		expect(state.snapshot().highlightState).toBe('awaiting-geometry')
	})
})
