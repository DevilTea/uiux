export type PreviewNavigationTarget = Readonly<{
	navigationRequestId: string
	viewId: string
	variantId?: string
	runtimeContextVersion?: number
	widgetId: string
}>

export type NavigationResolution = 'resolved' | 'missing-widget' | 'missing-view'
export type HighlightGeometryVisibility = 'visible' | 'hidden' | 'offscreen' | 'unmeasurable'
export type HighlightState = 'none' | 'awaiting-geometry' | 'visible' | 'hidden'

export type NavigationRequestResult =
	| Readonly<{ status: 'execute'; target: PreviewNavigationTarget }>
	| Readonly<{ status: 'deferred'; target: PreviewNavigationTarget; replacedNavigationRequestId?: string }>

export type NavigationResolutionResult =
	| Readonly<{ status: 'applied' }>
	| Readonly<{ status: 'missing-widget'; target: PreviewNavigationTarget }>
	| Readonly<{ status: 'missing-view'; target: PreviewNavigationTarget }>
	| Readonly<{ status: 'stale'; target: PreviewNavigationTarget }>

export type GeometryCorrelation = Readonly<{
	navigationRequestId: string
	viewId: string
	variantId?: string
	runtimeContextVersion?: number
	widgetId: string
	geometryRevision: number
	visibility: HighlightGeometryVisibility
}>

export type GeometryAcceptance =
	| Readonly<{ status: 'accepted'; geometryRevision: number; highlight: 'visible' | 'hidden' }>
	| Readonly<{ status: 'stale' | 'suspended' | 'no-active-target' | 'invalid-revision' }>

export type CommentModeExitResult = Readonly<{
	deferredTarget?: PreviewNavigationTarget
	reacquireHighlight: boolean
}>

export type NavigationStateSnapshot = Readonly<{
	commentMode: boolean
	currentViewId?: string
	currentVariantId?: string
	currentRuntimeContextVersion?: number
	selectedWidgetId?: string
	activeHighlightTarget?: PreviewNavigationTarget
	highlightState: HighlightState
	overlayVisible: boolean
	geometryTracking: 'inactive' | 'active' | 'suspended'
	latestGeometryRevision?: number
	deferredTarget?: PreviewNavigationTarget
	pendingTarget?: PreviewNavigationTarget
	invalidWidgetDiagnostic?: PreviewNavigationTarget
}>

/**
 * Wire-independent Workbench navigation/highlight coordinator.
 * Part 3 defines these state semantics but does not currently define navigation/targeting wire message names.
 */
export class PreviewNavigationState {
	private commentMode = false
	private currentViewId?: string
	private currentVariantId?: string
	private currentRuntimeContextVersion?: number
	private selectedWidgetId?: string
	private activeHighlightTarget?: PreviewNavigationTarget
	private highlightState: HighlightState = 'none'
	private latestGeometryRevision?: number
	private deferredTarget?: PreviewNavigationTarget
	private pendingTarget?: PreviewNavigationTarget
	private invalidWidgetDiagnostic?: PreviewNavigationTarget

	constructor(initial?: Readonly<{
		viewId: string
		variantId?: string
		runtimeContextVersion?: number
		selectedWidgetId?: string
	}>) {
		if (!initial) return
		this.currentViewId = initial.viewId
		this.currentVariantId = initial.variantId
		this.currentRuntimeContextVersion = initial.runtimeContextVersion
		this.selectedWidgetId = initial.selectedWidgetId
	}

	requestChecksNavigation(target: PreviewNavigationTarget): NavigationRequestResult {
		assertTarget(target)
		if (this.commentMode) {
			const replacedNavigationRequestId = this.deferredTarget?.navigationRequestId
			this.deferredTarget = cloneTarget(target)
			return replacedNavigationRequestId === undefined
				? { status: 'deferred', target: cloneTarget(target) }
				: { status: 'deferred', target: cloneTarget(target), replacedNavigationRequestId }
		}
		this.pendingTarget = cloneTarget(target)
		return { status: 'execute', target: cloneTarget(target) }
	}

	applyNavigationResolution(target: PreviewNavigationTarget, resolution: NavigationResolution): NavigationResolutionResult {
		assertTarget(target)
		if (!this.pendingTarget || !sameTarget(this.pendingTarget, target))
			return { status: 'stale', target: cloneTarget(target) }
		this.pendingTarget = undefined

		if (resolution === 'missing-view')
			return { status: 'missing-view', target: cloneTarget(target) }

		this.currentViewId = target.viewId
		this.currentVariantId = target.variantId
		this.currentRuntimeContextVersion = target.runtimeContextVersion
		this.latestGeometryRevision = undefined

		if (resolution === 'missing-widget') {
			this.selectedWidgetId = undefined
			this.activeHighlightTarget = undefined
			this.highlightState = 'none'
			this.invalidWidgetDiagnostic = cloneTarget(target)
			return { status: 'missing-widget', target: cloneTarget(target) }
		}

		this.selectedWidgetId = target.widgetId
		this.activeHighlightTarget = cloneTarget(target)
		this.highlightState = 'awaiting-geometry'
		this.invalidWidgetDiagnostic = undefined
		return { status: 'applied' }
	}

	enterCommentMode(): Readonly<{ overlayHidden: boolean; trackingSuspended: boolean }> {
		const overlayHidden = !this.commentMode && this.highlightState === 'visible'
		const trackingSuspended = this.activeHighlightTarget !== undefined
		this.commentMode = true
		return { overlayHidden, trackingSuspended }
	}

	exitCommentMode(): CommentModeExitResult {
		if (!this.commentMode) return { reacquireHighlight: false }
		this.commentMode = false
		const deferredTarget = this.deferredTarget
		this.deferredTarget = undefined
		if (deferredTarget) this.pendingTarget = cloneTarget(deferredTarget)
		const reacquireHighlight = this.activeHighlightTarget !== undefined
		if (reacquireHighlight) this.highlightState = 'awaiting-geometry'
		return deferredTarget
			? { deferredTarget: cloneTarget(deferredTarget), reacquireHighlight }
			: { reacquireHighlight }
	}

	acceptGeometry(report: GeometryCorrelation): GeometryAcceptance {
		if (!Number.isSafeInteger(report.geometryRevision) || report.geometryRevision < 0)
			return { status: 'invalid-revision' }
		if (this.commentMode) return { status: 'suspended' }
		const target = this.activeHighlightTarget
		if (!target) return { status: 'no-active-target' }
		if (!sameCorrelation(target, report)) return { status: 'stale' }
		if (this.latestGeometryRevision !== undefined && report.geometryRevision <= this.latestGeometryRevision)
			return { status: 'stale' }
		this.latestGeometryRevision = report.geometryRevision
		const highlight = report.visibility === 'visible' ? 'visible' : 'hidden'
		this.highlightState = highlight
		return { status: 'accepted', geometryRevision: report.geometryRevision, highlight }
	}

	onRuntimeGenerationBoundary(): Readonly<{ structuralSelectionPreserved: boolean; reacquireAfterHandshake: boolean }> {
		this.latestGeometryRevision = undefined
		if (!this.activeHighlightTarget)
			return { structuralSelectionPreserved: this.selectedWidgetId !== undefined, reacquireAfterHandshake: false }
		this.highlightState = 'awaiting-geometry'
		return { structuralSelectionPreserved: true, reacquireAfterHandshake: true }
	}

	invalidateCurrentGeometry(): Readonly<{ reacquire: boolean }> {
		if (!this.activeHighlightTarget) return { reacquire: false }
		this.highlightState = 'awaiting-geometry'
		return { reacquire: !this.commentMode }
	}

	clearCurrentSelection(): void {
		this.selectedWidgetId = undefined
		this.activeHighlightTarget = undefined
		this.highlightState = 'none'
		this.latestGeometryRevision = undefined
		this.invalidWidgetDiagnostic = undefined
	}

	snapshot(): NavigationStateSnapshot {
		const geometryTracking = this.activeHighlightTarget === undefined
			? 'inactive'
			: this.commentMode ? 'suspended' : 'active'
		return Object.freeze({
			commentMode: this.commentMode,
			...(this.currentViewId !== undefined ? { currentViewId: this.currentViewId } : {}),
			...(this.currentVariantId !== undefined ? { currentVariantId: this.currentVariantId } : {}),
			...(this.currentRuntimeContextVersion !== undefined ? { currentRuntimeContextVersion: this.currentRuntimeContextVersion } : {}),
			...(this.selectedWidgetId !== undefined ? { selectedWidgetId: this.selectedWidgetId } : {}),
			...(this.activeHighlightTarget ? { activeHighlightTarget: cloneTarget(this.activeHighlightTarget) } : {}),
			highlightState: this.highlightState,
			overlayVisible: !this.commentMode && this.highlightState === 'visible',
			geometryTracking,
			...(this.latestGeometryRevision !== undefined ? { latestGeometryRevision: this.latestGeometryRevision } : {}),
			...(this.deferredTarget ? { deferredTarget: cloneTarget(this.deferredTarget) } : {}),
			...(this.pendingTarget ? { pendingTarget: cloneTarget(this.pendingTarget) } : {}),
			...(this.invalidWidgetDiagnostic ? { invalidWidgetDiagnostic: cloneTarget(this.invalidWidgetDiagnostic) } : {}),
		})
	}
}

function assertTarget(target: PreviewNavigationTarget): void {
	for (const [name, value] of [
		['navigationRequestId', target.navigationRequestId],
		['viewId', target.viewId],
		['widgetId', target.widgetId],
	] as const) {
		if (!value) throw new TypeError(`${name} must be a non-empty opaque identity.`)
	}
	if (target.variantId !== undefined && !target.variantId) throw new TypeError('variantId must be omitted or non-empty.')
	if (target.runtimeContextVersion !== undefined
		&& (!Number.isSafeInteger(target.runtimeContextVersion) || target.runtimeContextVersion < 0))
		throw new TypeError('runtimeContextVersion must be a non-negative JSON safe integer when present.')
}

function sameTarget(left: PreviewNavigationTarget, right: PreviewNavigationTarget): boolean {
	return left.navigationRequestId === right.navigationRequestId
		&& left.viewId === right.viewId
		&& left.variantId === right.variantId
		&& left.runtimeContextVersion === right.runtimeContextVersion
		&& left.widgetId === right.widgetId
}

function sameCorrelation(target: PreviewNavigationTarget, report: GeometryCorrelation): boolean {
	return sameTarget(target, report)
}

function cloneTarget(target: PreviewNavigationTarget): PreviewNavigationTarget {
	return Object.freeze({ ...target })
}
