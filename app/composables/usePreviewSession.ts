import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { describeFetchError } from '../utils/fetch-error'
import {
	envelopeGenerationId,
	isCapabilityDeclaration,
	isChecksReport,
	isFailureReport,
	WorkbenchPreviewProtocolBridge,
	type BridgeReceiveResult,
} from '../../src/preview/protocol/bridge'
import { deriveWorkbenchFailure, recorrelatePreviewFailure, retryStallGraceMs } from '../../src/preview/failure-diagnostic'
import { failureReportDiagnostic } from '../../src/preview/protocol/failure-report'
import { CHECKS_REPORTS_FEATURE } from '../../src/preview/protocol/checks-report'
import { PreviewChecksReports, type LivePreviewChecks } from '../../src/preview/checks-reports'
import { createPreviewSessionId } from '../../src/preview/protocol/generation-id'
import { workbenchPreviewSessions } from '../../src/preview/protocol/session'
import { PreviewNavigationState, type PreviewNavigationTarget } from '../../src/preview/navigation-state'
import { PreviewTargetingState } from '../../src/preview/targeting-state'
import { GeometryStreamCoordinator, type GeometryDemand, type GeometryReport } from '../../src/preview/geometry-streams'
import {
	PinPlacementEngine,
	pinGeometryDemand,
	type PinPlacement,
	type PinThreadInput,
} from '../../src/preview/pin-visibility'
import type { AffineOuterMapping } from '../../src/preview/outer-precision'
import {
	MULTI_TARGET_GEOMETRY_FEATURE,
	type GeometryAcquireResponse,
	type PreviewFailureDiagnostic,
	type VisibleRegion,
	type WidgetRect,
} from '../../src/preview/protocol/schema'
import {
	PREVIEW_CONTEXT_CHANNEL,
	createPreviewWirePost,
	readPreviewWirePost,
	type PreviewTargetingPurpose,
} from '../../src/preview/protocol/transport'
import type { TargetingContext, TargetingRuntimeMessage } from '../../src/preview/protocol/targeting'
import type { ChecksReportMessage } from '../../src/preview/protocol/checks-report'
import { WIDGET_EVENTS_FEATURE } from '../../src/preview/protocol/widget-events'
import { WidgetEventArming } from '../../src/preview/widget-event-arming'
import type { Point } from '../../src/preview/protocol/schema'
import { useUiuxClient } from './useUiuxClient'
import type { WorkbenchState } from './useWorkbenchState'
import type { SessionPhase } from './workbench-types'

/**
 * The canvas tool. Select holds an `inspection` targeting interaction, Comment a `comment-range`
 * one, and Interact none, so its clicks belong to the View (Part 3 item 2.1).
 */
export type CanvasTool = 'select' | 'comment' | 'interact'

/**
 * A committed comment-range target (Part 3): the hit-tested Widget and the transient click point
 * in inner content-viewport CSS px. Keyboard paths (tree, Inspector) have no point.
 */
export type CommentTarget = Readonly<{ widgetId: string; point?: Point }>

/** What the session chip shows (brief b, section 6). */
export type SessionStatusKind = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'stopped'

/**
 * The latest accepted runtime geometry for the selected Widget, in inner content-viewport CSS px.
 * Only reports that pass the bridge gates and the navigation correlation reach here (Parts 2 and 3).
 */
export type SelectionGeometry = Readonly<{
	widgetId: string
	geometryRevision: number
	rect: WidgetRect
	regions: readonly VisibleRegion[]
}>

/**
 * `awaiting`: requested, no current report yet. `hidden`: zero-area or no reliably visible region
 * ("Not visible in this state"). `offscreen`: outside the iframe content viewport.
 */
export type SelectionVisibility = 'none' | 'awaiting' | 'visible' | 'hidden' | 'offscreen'

/** The runtime's current hover candidate and its geometry (Part 3 targeting hover preview). */
export type HoverCandidate = Readonly<{
	widgetId: string
	purpose: PreviewTargetingPurpose
	/** The candidate Widget's latest accepted report; absent until its stream reports. */
	geometry?: GeometryReport
}>

/**
 * What Checks can say about the live Preview (issue #347; Rules 01a115cd-bb96-7131-99d9-a3882829590c
 * and 01a115cd-bc5e-710e-bbe2-a3d5f51469fb). `not_checked`: no Preview generation of this session
 * reports to Checks, so nothing is known, which is never zero findings. `checking`: a Preview that
 * reports is open and has not reported for its current View, Variant and Locale yet. `completed`: the
 * latest report of the current generation is held.
 */
export type LivePreviewChecksState = Readonly<
	| { state: 'not_checked' | 'checking'; report?: undefined }
	| { state: 'completed'; report: LivePreviewChecks }
>

/** The measured canvas mapping, published by the canvas for pins and other overlay consumers. */
export type CanvasMappingState = Readonly<{
	mapping?: AffineOuterMapping
	/** The visible canvas stage in overlay-layer px (pins mapped outside it become edge indicators). */
	stage?: Readonly<{ left: number; top: number; right: number; bottom: number }>
}>

/**
 * Options of the pins consumer: the open thread and the pending composer are tracked first
 * (decision 6, tier 1, with the hover candidate).
 */
export type PinTrackingOptions = Readonly<{ openThreadId?: string; pendingThreadId?: string }>

/** The render context the iframe document was created with; later changes travel over the context channel. */
type IframeSourceContext = Readonly<{
	viewId: string
	variant?: string
	locale: string
	viewportId: string
	width: number
	height: number
	themeId: string
}>

/**
 * The Workbench side of the preview iframe: protocol bridge handshake, the context and targeting
 * channels, comment mode and widget selection coming back from the iframe's own hit-testing, and
 * every runtime geometry stream (selection highlight, hover candidate, comment pins).
 */
export function createPreviewSession(state: WorkbenchState) {
	const uiux = useUiuxClient()
	const { t } = useI18n()

	const previewIframe = ref<HTMLIFrameElement>()
	/**
	 * The Preview session, opened through the page's registry so a retired session ID is never
	 * activated again (Rule 01a1161c-3b15-7913-acfb-136f0bd365b6). It lasts as long as the page, until
	 * the server restarts (`renewSession`).
	 */
	let protocolSession = workbenchPreviewSessions.openFresh(() => createPreviewSessionId())
	const previewSessionId = ref(protocolSession.previewSessionId)
	/**
	 * The admitted runtime generation. The runtime mints its ID and names it in its first
	 * declaration; until one is admitted there is none (Clause 01a1161c-4119-712d-8785-7d8155c0ceee).
	 */
	const runtimeGenerationId = ref<string>()
	/**
	 * Bumps for every Preview document the Workbench requests, and is part of the document URL, so a
	 * request for the same View still loads a new document. It never names the generation.
	 */
	const documentSequence = ref(0)
	const handshakePhase = ref<Exclude<SessionPhase, 'idle'>>('initiating')
	/** True once any generation of this session completed its handshake: a later loss reads "Reconnecting". */
	const hasConnected = ref(false)
	/**
	 * The last non-recoverable failure the Workbench derived, kept until a generation completes its
	 * handshake: a generation refused while recovery is exhausted shows it again (issue #111).
	 */
	let lastFailure: PreviewFailureDiagnostic | undefined
	/** The diagnostic on screen; switching to another View clears it (owner ruling 4 of 2026-10-23). */
	const shownFailure = shallowRef<PreviewFailureDiagnostic>()
	/**
	 * True from the start of a recovery document until the outcome of its declaration: a Retry
	 * Preview activation (an explicit retry) or the automatic recovery attempt the Workbench starts
	 * after a protocol failure (owner ruling 2 of 2026-10-23, Discussion #241; issue #101).
	 */
	const retryInFlight = ref(false)
	/**
	 * The in-flight retry's document loaded and declared nothing within the grace period, so Retry
	 * Preview is offered again; pressing it reloads under the same pending authorization (owner
	 * ruling 1 of 2026-10-23, Discussion #241).
	 */
	const retryStalled = ref(false)
	let retryStallTimer: ReturnType<typeof setTimeout> | undefined
	/** Read once per session; see `retryStallGraceMs`. */
	const stallGraceMs = retryStallGraceMs(typeof window === 'undefined' ? undefined : window)
	const targetingInteractionId = ref<string>()
	const canvasTool = ref<CanvasTool>('select')
	/** The tool Comment returns to when it is left (Select unless Interact was active). */
	const baseTool = ref<Exclude<CanvasTool, 'comment'>>('select')
	const isCommentMode = computed(() => canvasTool.value === 'comment')
	/** While set, the comment-range interaction re-anchors this thread instead of creating one. */
	const reanchorThreadId = ref<string>()
	const runtimeFeatures = ref<readonly string[]>([])
	const selectionGeometry = shallowRef<SelectionGeometry>()
	const selectionVisibility = ref<SelectionVisibility>('none')
	/** Bumps on every accepted or hidden geometry report, so computed consumers re-read the coordinator. */
	const geometryVersion = ref(0)
	const hoverWidgetId = ref<string>()
	const hoverPurpose = ref<PreviewTargetingPurpose>()
	const pinThreads = shallowRef<readonly PinThreadInput[]>([])
	const pinOptions = shallowRef<PinTrackingOptions>({})
	const canvasMapping = shallowRef<CanvasMappingState>({})
	/** The consumer whose threads `pinThreads` holds (see `releasePinThreads`). */
	let pinOwner: object | undefined

	/** The phase shown to users. No View mounted means no session is expected, not one that is still starting. */
	const sessionPhase = computed<SessionPhase>(() => state.selectedViewId.value ? handshakePhase.value : 'idle')
	const sessionStatus = computed<SessionStatusKind>(() => {
		switch (sessionPhase.value) {
			case 'open': return 'live'
			case 'failed': return 'stopped'
			case 'initiating': return hasConnected.value ? 'reconnecting' : 'connecting'
			default: return 'idle'
		}
	})

	/**
	 * The inline Preview diagnostic (Rule 01a11687-375e-7667-b8f1-59389fdd9780): shown while Preview is
	 * unavailable after a non-recoverable failure, and through the handshake of a retry, until a
	 * generation recovers, another View replaces the context, or the View closes.
	 */
	const failureDiagnostic = computed<PreviewFailureDiagnostic | undefined>(() =>
		state.selectedViewId.value ? shownFailure.value : undefined)
	/** Retry Preview is disabled while a retry is in flight, unless its document stalled. */
	const retryDisabled = computed(() => retryInFlight.value && !retryStalled.value)

	let workbenchBridge: WorkbenchPreviewProtocolBridge | undefined
	let navigationCoordinator: PreviewNavigationState | undefined
	let commentTargetHandler: ((target: CommentTarget) => void) | undefined
	/** The comments layer's Escape: closes the composer or bubble first; false when it had nothing open. */
	let commentEscapeHandler: (() => boolean) | undefined
	/** The Checks/selection highlight request; its reports may update the selection overlay. */
	let selectionTarget: PreviewNavigationTarget | undefined
	let interactionSequence = 0
	const targeting = new PreviewTargetingState<{ widgetId: string }>()
	let armSequence = 0
	/**
	 * Widget Event arming for the Prototype player (Part 2 "Widget Event reporting"): armed only
	 * while no targeting interaction is active, so it shares `targetingInteractionId` (decision 6).
	 */
	const widgetEvents = new WidgetEventArming({
		generation: () => runtimeGenerationId.value ?? '',
		open: () => handshakePhase.value === 'open',
		features: () => runtimeFeatures.value,
		targetingActive: () => !!targetingInteractionId.value,
		context: () => targetingContext(),
		send: message => workbenchBridge?.sendWidgetEventArm(message).status === 'sent',
		mintArmId: () => `arm-${previewSessionId.value}-${++armSequence}-${Date.now()}`,
	})
	/**
	 * The accepted `checks.report` of the current generation (issue #347). It is cleared by every
	 * change of View, Variant or Locale and by every generation boundary, so nothing of an earlier
	 * Preview, Variant or Locale ever reads as current.
	 */
	const checksReports = new PreviewChecksReports()
	/** Bumps whenever `checksReports` changes, so `liveChecks` recomputes. */
	const checksVersion = ref(0)
	const liveChecks = computed<LivePreviewChecksState>(() => {
		void checksVersion.value
		const report = checksReports.current()
		if (report) return { state: 'completed', report }
		const reporting = handshakePhase.value === 'open' && runtimeFeatures.value.includes(CHECKS_REPORTS_FEATURE) && !!previewIframe.value && !!state.selectedViewId.value
		return { state: reporting ? 'checking' : 'not_checked' }
	})
	/** Whether the open generation declared `widget.events`; undefined until its handshake opens. */
	const widgetEventsSupported = computed<boolean | undefined>(() =>
		handshakePhase.value === 'open' ? runtimeFeatures.value.includes(WIDGET_EVENTS_FEATURE) : undefined)

	/** Every geometry stream of this session (Part 2, 2026-10-05 multi-target decision group). */
	const geometryStreams = new GeometryStreamCoordinator({
		send(message) {
			workbenchBridge?.sendGeometry(message)
		},
		requestFrame: callback => requestAnimationFrame(callback),
		cancelFrame: handle => cancelAnimationFrame(handle),
	})
	/**
	 * Reports arrive as one message task each (up to one per stream per frame), so applying them is
	 * coalesced to one animation frame: every overlay consumer recomputes once per frame from the
	 * latest accepted reports. A report that disappears (release, supersession, content-box resize,
	 * generation boundary) applies at once, so nothing is drawn from geometry that is no longer current.
	 */
	let geometryFrame: number | undefined
	geometryStreams.subscribe((changed) => {
		const removed = [...changed].some(widgetId => !geometryStreams.report(widgetId))
		if (removed || typeof requestAnimationFrame === 'undefined') {
			if (geometryFrame !== undefined) cancelAnimationFrame(geometryFrame)
			geometryFrame = undefined
			geometryVersion.value++
			return
		}
		geometryFrame ??= requestAnimationFrame(() => {
			geometryFrame = undefined
			geometryVersion.value++
		})
	})
	const pinEngine = new PinPlacementEngine()

	/**
	 * The iframe document is one runtime generation. Locale, viewport, theme and Variant changes are
	 * presentation or state changes sent over the context channel, so they never reload the document,
	 * and a new document always brings a generation of its own (Parts 1 and 10).
	 */
	const iframeSourceContext = shallowRef<IframeSourceContext>()

	function captureIframeSourceContext(): void {
		const viewId = state.selectedViewId.value
		if (!viewId) {
			iframeSourceContext.value = undefined
			return
		}
		const options = state.contextOptions.value
		const dims = options.viewports.selectedDimensions
		iframeSourceContext.value = Object.freeze({
			viewId,
			...(options.variants.selected ? { variant: options.variants.selected } : {}),
			locale: options.locales.selected,
			viewportId: options.viewports.selectedId,
			width: dims.width,
			height: dims.height,
			themeId: options.themes.selected,
		})
	}

	// Until a document of this generation has connected, the source follows the resolved context
	// (the Workspace manifest may still be loading when the generation starts). After the
	// handshake it is frozen, and changes travel over the context channel instead.
	watch(() => state.contextOptions.value, () => {
		if (handshakePhase.value !== 'open' && iframeSourceContext.value && contextDiffersFromSource()) {
			// A new source is a new requested document: the one it replaces may no longer declare. A
			// retry in flight waits for the new document's load again, never for the replaced one's.
			documentSequence.value++
			captureIframeSourceContext()
			clearRetryStallTimer()
			retryStalled.value = false
		}
	})

	function contextDiffersFromSource(): boolean {
		const source = iframeSourceContext.value
		if (!source) return false
		const options = state.contextOptions.value
		const dims = options.viewports.selectedDimensions
		return source.viewId !== state.selectedViewId.value
			|| (source.variant ?? '') !== (options.variants.selected ?? '')
			|| source.locale !== options.locales.selected
			|| source.viewportId !== options.viewports.selectedId
			|| source.width !== dims.width
			|| source.height !== dims.height
			|| source.themeId !== options.themes.selected
	}

	const previewIframeSrc = computed(() => {
		const source = iframeSourceContext.value
		if (!state.selectedViewId.value || !source || source.viewId !== state.selectedViewId.value) return ''
		// Wait for the Workspace manifest, so the first document already renders the resolved context.
		if (state.loading.value && !state.workspace.value) return ''
		const params = new URLSearchParams({
			session: previewSessionId.value,
			document: String(documentSequence.value),
			viewId: source.viewId,
			locale: source.locale,
			viewportId: source.viewportId,
			viewportWidth: String(source.width),
			viewportHeight: String(source.height),
			themeId: source.themeId,
		})
		if (source.variant) params.set('variant', source.variant)
		return uiux.routeUrl(`preview?${params.toString()}`)
	})

	function post(channel: string, body: Record<string, unknown>): void {
		const target = previewIframe.value?.contentWindow
		if (!target) return
		target.postMessage({ channel, ...body }, window.location.origin)
	}

	function targetingContext(): TargetingContext | undefined {
		const viewId = state.selectedViewId.value
		const generation = runtimeGenerationId.value
		if (!viewId || !generation) return undefined
		const variantId = currentVariantId()
		return {
			previewSessionId: previewSessionId.value,
			runtimeGenerationId: generation,
			viewId,
			...(variantId ? { variantId } : {}),
		}
	}

	/** Enter and exit go out in the protocol envelope; the bridge holds them until the generation's ACK. */
	function postTargeting(message: Readonly<{ type: 'enter'; purpose: PreviewTargetingPurpose; id: string }> | Readonly<{ type: 'exit' }>): void {
		const context = targetingContext()
		if (!context || !workbenchBridge) return
		if (message.type === 'enter')
			workbenchBridge.sendTargeting({ type: 'targeting.enter', context, payload: { targetingInteractionId: message.id, purpose: message.purpose } })
		else workbenchBridge.sendTargeting({ type: 'targeting.exit', context, payload: {} })
	}

	function notifyIframeContext(): void {
		if (!state.selectedViewId.value) return
		const options = state.contextOptions.value
		const dims = options.viewports.selectedDimensions
		post(PREVIEW_CONTEXT_CHANNEL, {
			payload: {
				viewId: state.selectedViewId.value,
				variantName: options.variants.selected,
				locale: options.locales.selected,
				viewportId: options.viewports.selectedId,
				viewport: { width: dims.width, height: dims.height },
				themeId: options.themes.selected,
			},
		})
	}

	function selectWidget(id: string): void {
		state.selectedWidgetId.value = id
	}

	/** A Checks navigation failed (its View is gone): the previous highlight is hidden; the selection stays. */
	function hideSelectionHighlight(): void {
		selectionTarget = undefined
		selectionGeometry.value = undefined
		selectionVisibility.value = 'none'
		updateGeometryDemand()
	}

	function currentVariantId(): string | undefined {
		return state.contextOptions.value.variants.selected || undefined
	}

	/** Keeps the coordinator's runtime context equal to the mounted View, Variant and generation. */
	function syncGeometryContext(): void {
		const viewId = state.selectedViewId.value
		const generation = runtimeGenerationId.value
		const variantId = currentVariantId()
		geometryStreams.setContext(viewId && generation
			? {
					previewSessionId: previewSessionId.value,
					runtimeGenerationId: generation,
					viewId,
					...(variantId ? { variantId } : {}),
				}
			: undefined)
	}

	/** Recomputes which Widgets need geometry: hover candidate, selection highlight, pins (decision 6). */
	function updateGeometryDemand(): void {
		const demand: GeometryDemand[] = []
		const hover = hoverWidgetId.value
		if (hover && hover !== 'root') demand.push({ consumerId: 'hover', widgetId: hover, tier: 'targeting' })
		if (selectionTarget && !isCommentMode.value) {
			demand.push({ consumerId: 'selection', widgetId: selectionTarget.widgetId, tier: 'highlight', navigationRequestId: selectionTarget.navigationRequestId })
		}
		const pins = pinGeometryDemand(pinThreads.value, { viewId: state.selectedViewId.value, variantId: currentVariantId() })
		const focused = new Set([pinOptions.value.openThreadId, pinOptions.value.pendingThreadId].filter(Boolean).map(id => `pin:${id}`))
		for (const pin of pins) {
			demand.push(focused.has(pin.consumerId) ? { ...pin, tier: 'targeting' } : pin)
		}
		geometryStreams.setDemand(demand)
	}

	/**
	 * Opens the selection highlight request for the selected Widget. Every call mints a fresh
	 * `navigationRequestId`, so reports for an earlier Widget, Variant or content-viewport size fail
	 * the correlation gate. Nothing is drawn until a current report arrives; there is no last-known
	 * geometry. Other consumers of the same Widget share the resulting stream.
	 */
	function acquireSelectionGeometry(): void {
		selectionTarget = undefined
		selectionGeometry.value = undefined
		const viewId = state.selectedViewId.value
		const widgetId = state.selectedWidgetId.value
		if (!viewId || !widgetId || !navigationCoordinator) {
			selectionVisibility.value = 'none'
			updateGeometryDemand()
			return
		}
		selectionVisibility.value = 'awaiting'
		const variantId = currentVariantId()
		const target: PreviewNavigationTarget = Object.freeze({
			navigationRequestId: `selection-${previewSessionId.value}-${++interactionSequence}-${Date.now()}`,
			viewId,
			...(variantId ? { variantId } : {}),
			widgetId,
		})
		const request = navigationCoordinator.requestChecksNavigation(target)
		if (request.status === 'execute') {
			// Comment mode suspends the highlight consumer instead; it is reacquired on exit (Part 3).
			navigationCoordinator.applyNavigationResolution(target, 'resolved')
			selectionTarget = target
		}
		updateGeometryDemand()
	}

	function receiveGeometryReport(message: GeometryAcquireResponse): void {
		if (geometryStreams.accept(message) !== 'accepted') return
		const target = selectionTarget
		if (!target || !navigationCoordinator || message.context.widgetId !== target.widgetId) return
		const { rect, regions } = message.payload
		const viewport = state.contextOptions.value.viewports.selectedDimensions
		const zeroArea = rect.width === 0 || rect.height === 0
		const intersects = rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0
		const visibility: SelectionVisibility = zeroArea || !regions.length ? 'hidden' : intersects ? 'visible' : 'offscreen'
		const accepted = navigationCoordinator.acceptGeometry({
			navigationRequestId: message.context.navigationRequestId ?? '',
			viewId: message.context.viewId,
			...(message.context.variantId !== undefined ? { variantId: message.context.variantId } : {}),
			...(message.context.runtimeContextVersion !== undefined ? { runtimeContextVersion: message.context.runtimeContextVersion } : {}),
			widgetId: message.context.widgetId,
			geometryRevision: message.context.geometryRevision,
			visibility: visibility === 'visible' ? 'visible' : visibility === 'offscreen' ? 'offscreen' : 'hidden',
		})
		if (accepted.status !== 'accepted') return
		selectionVisibility.value = visibility
		selectionGeometry.value = visibility === 'visible'
			? Object.freeze({ widgetId: target.widgetId, geometryRevision: message.context.geometryRevision, rect, regions })
			: undefined
	}

	function resetSelectionGeometry(): void {
		selectionTarget = undefined
		selectionGeometry.value = undefined
		selectionVisibility.value = state.selectedWidgetId.value ? 'awaiting' : 'none'
	}

	function freshInteractionId(): string {
		return `target-${previewSessionId.value}-${++interactionSequence}-${Date.now()}`
	}

	function clearHover(): void {
		if (hoverWidgetId.value === undefined && hoverPurpose.value === undefined) return
		hoverWidgetId.value = undefined
		hoverPurpose.value = undefined
		updateGeometryDemand()
	}

	/** Ends the active interaction, if any, on both sides. */
	function exitInteraction(): void {
		if (!targetingInteractionId.value) return
		targeting.explicitCancel()
		targetingInteractionId.value = undefined
		postTargeting({ type: 'exit' })
	}

	/** Starts a fresh interaction; the new `targetingInteractionId` supersedes the previous one at once. */
	function enterInteraction(purpose: PreviewTargetingPurpose): void {
		const id = freshInteractionId()
		if (targeting.snapshot().purpose) targeting.authoritativeModeTransition(purpose, id)
		else targeting.enterMode(purpose, id)
		targetingInteractionId.value = id
		// Disarm before entering: on the one ordered channel the runtime is disarmed first.
		widgetEvents.sync()
		postTargeting({ type: 'enter', purpose, id })
	}

	/**
	 * Enters the targeting interaction the current tool implies: Select is `inspection` (hover
	 * outline and click-to-select), Comment is `comment-range`, Interact has none (Part 3, 2026-10-02).
	 */
	function applyToolInteraction(): void {
		clearHover()
		const purpose: PreviewTargetingPurpose | undefined = !state.selectedView.value
			? undefined
			: canvasTool.value === 'comment' ? 'comment-range' : canvasTool.value === 'select' ? 'inspection' : undefined
		if (!purpose) {
			exitInteraction()
			// An exit with no successor re-arms with a fresh armId.
			widgetEvents.sync()
		}
		else enterInteraction(purpose)
	}

	function setCanvasTool(tool: CanvasTool): void {
		if (tool === 'comment' && !state.selectedView.value) return
		const previous = canvasTool.value
		if (tool === previous) return
		if (tool !== 'comment') {
			baseTool.value = tool
			reanchorThreadId.value = undefined
		}
		canvasTool.value = tool
		if (tool === 'comment') {
			// The Checks/selection highlight consumer is suspended and hidden (Part 3). Its stream is
			// released unless a pin uses the same Widget; pins stay tracked (decision 8).
			navigationCoordinator?.enterCommentMode()
			selectionTarget = undefined
			selectionGeometry.value = undefined
		}
		applyToolInteraction()
		if (previous === 'comment') leaveCommentTracking()
		else updateGeometryDemand()
	}

	/** Leaves Comment for the tool it was entered from (Esc, or C again). */
	function exitCommentMode(): void {
		if (isCommentMode.value) setCanvasTool(baseTool.value)
	}

	/** Comment mode whose next commit re-anchors `threadId` (the bubble's Re-anchor action). */
	function startReanchor(threadId: string): void {
		reanchorThreadId.value = threadId
		if (!isCommentMode.value) setCanvasTool('comment')
	}

	/** Part 3: the Widget highlight was suspended for comment-range selection; reacquire it with a fresh request. */
	function leaveCommentTracking(): void {
		const exit = navigationCoordinator?.exitCommentMode()
		if (exit) acquireSelectionGeometry()
		else updateGeometryDemand()
	}

	/**
	 * Registers what a committed comment-range target does (the canvas opens the composer at it)
	 * and returns the unregister function. That function clears only its own handler: moving
	 * between Views sets up the next page's comments layer before the previous one is disposed, and
	 * the late disposal must not unregister the handler the new page just installed.
	 */
	function onCommentTarget(handler: (target: CommentTarget) => void): () => void {
		commentTargetHandler = handler
		return () => {
			if (commentTargetHandler === handler) commentTargetHandler = undefined
		}
	}

	/**
	 * Keyboard and menu paths (Widget tree, Inspector): comment on a Widget without a pointer. The
	 * composer opens at the Widget's default pin point (brief c, section 8).
	 */
	function commentOnWidget(widgetId: string): boolean {
		if (!commentTargetHandler || !state.selectedView.value) return false
		commentTargetHandler({ widgetId })
		return true
	}

	/**
	 * Registers the comments layer's Escape, which closes the composer or bubble before the mode
	 * exits, and returns the unregister function (which clears only its own handler).
	 */
	function onCommentEscape(handler: () => boolean): () => void {
		commentEscapeHandler = handler
		return () => {
			if (commentEscapeHandler === handler) commentEscapeHandler = undefined
		}
	}

	/** Workbench owns Escape (Part 3): close the composer or bubble first, then leave Comment mode. */
	function handleEscape(): boolean {
		if (commentEscapeHandler?.()) return true
		if (isCommentMode.value) {
			exitCommentMode()
			return true
		}
		return false
	}

	/**
	 * Declares the in-scope comment threads whose pins the canvas tracks. Their Widgets get
	 * geometry streams in decision 6 order; `pinPlacements` reports each thread's placement.
	 * Pins stay tracked during Comment mode (decision 8).
	 */
	function setPinThreads(threads: readonly PinThreadInput[], options: PinTrackingOptions = {}, owner?: object): void {
		pinOwner = owner
		pinThreads.value = Object.freeze([...threads])
		pinOptions.value = Object.freeze({ ...options })
		updateGeometryDemand()
	}

	/**
	 * Stops tracking `owner`'s pins, unless another consumer has declared its threads since: the
	 * next View page declares its pins before the previous page's scope is disposed.
	 */
	function releasePinThreads(owner: object): void {
		if (pinOwner === owner) setPinThreads([])
	}

	const pinPlacements = computed<readonly PinPlacement[]>(() => {
		void geometryVersion.value
		const threads = pinThreads.value
		if (!threads.length) return []
		const mapping = canvasMapping.value
		return pinEngine.place(threads, {
			viewId: state.selectedViewId.value,
			variantId: currentVariantId(),
			viewport: state.contextOptions.value.viewports.selectedDimensions,
			...(mapping.mapping ? { mapping: mapping.mapping } : {}),
			...(mapping.stage ? { stage: mapping.stage } : {}),
			live: sessionStatus.value === 'live',
			multiTarget: geometryStreams.isMultiTarget(),
			report: widgetId => geometryStreams.report(widgetId),
			isTracked: widgetId => geometryStreams.isTracked(widgetId),
		})
	})

	const hoverCandidate = computed<HoverCandidate | undefined>(() => {
		void geometryVersion.value
		const widgetId = hoverWidgetId.value
		const purpose = hoverPurpose.value
		if (!widgetId || !purpose) return undefined
		const geometry = geometryStreams.report(widgetId)
		return Object.freeze({ widgetId, purpose, ...(geometry ? { geometry } : {}) })
	})

	/** Ends every per-generation state of the current runtime generation, if any. */
	function endGeneration(): void {
		const previousGeneration = runtimeGenerationId.value
		runtimeGenerationId.value = undefined
		runtimeFeatures.value = []
		widgetEvents.onGenerationBoundary()
		if (previousGeneration) targeting.onGenerationTeardown(previousGeneration)
		hoverWidgetId.value = undefined
		hoverPurpose.value = undefined
		checksReports.reset()
		checksVersion.value++
		navigationCoordinator?.onRuntimeGenerationBoundary()
		resetSelectionGeometry()
		// Generation boundary: every stream is void until the new generation's capability ACK.
		syncGeometryContext()
	}

	/**
	 * Starts a fresh runtime generation, e.g. after another View is selected: the Workbench retires
	 * the current one and loads a new document, whose runtime names the new generation.
	 */
	function replaceGeneration(): void {
		documentSequence.value++
		captureIframeSourceContext()
		endGeneration()
		if (workbenchBridge) {
			workbenchBridge.retireGeneration()
			handshakePhase.value = 'initiating'
		}
	}

	/**
	 * The runtime's declaration named a generation the session never saw, and the bridge admitted
	 * it. When a generation is still current, the document reloaded or its runtime restarted on its
	 * own: that generation is retired, and nothing of it carries over (issue #102).
	 */
	function onGenerationAdmitted(generationId: string): void {
		if (runtimeGenerationId.value) endGeneration()
		runtimeGenerationId.value = generationId
		syncGeometryContext()
		handshakePhase.value = 'initiating'
	}

	/**
	 * Retry Preview, the one shared manual recovery action (Rule 01a11687-386c-764f-98fd-cf19dc3d0013)
	 * and a fresh Preview document. It authorizes one explicit retry, which the next declared
	 * generation spends; a press while that retry is in flight joins it and loads nothing (Rules
	 * 01a1161c-3dad-7ac1-b49b-a77fcb1e33f2 and 01a1161c-3e28-7dcf-a06e-a2c12c83919c). If the in-flight
	 * document stalls, a press reloads it under the same pending authorization, which the session
	 * reports as `coalesced` (owner ruling 1 of 2026-10-23). A press after the automatic recovery
	 * attempt stalled abandons that attempt and authorizes an explicit retry instead.
	 */
	function retry(): void {
		if (!state.selectedViewId.value || !workbenchBridge || retryDisabled.value) return
		if (workbenchBridge.authorizeRetry() === 'ignored-active-bootstrap') return
		startRecoveryDocument()
	}

	/**
	 * After a protocol-invalid generation, the Workbench starts the one automatic recovery attempt
	 * itself: a fresh Preview document in the same session (Rules 01a1161c-3bd4-7a91-b50e-d01a857521e5
	 * and 01a1161c-3c0e-7274-8112-db507455e0f4). It shares the in-flight state of Retry Preview: the
	 * diagnostic stays shown and the action disabled until the next declaration's outcome (owner
	 * ruling 2 of 2026-10-23). Once the attempt is spent, only Retry Preview starts another.
	 */
	function recoverAutomatically(): void {
		if (!state.selectedViewId.value || !workbenchBridge) return
		if (workbenchBridge.beginAutomaticRecovery() !== 'started') return
		startRecoveryDocument()
	}

	/** Requests the fresh document of a recovery, which stays in flight until its declaration's outcome. */
	function startRecoveryDocument(): void {
		retryInFlight.value = true
		retryStalled.value = false
		clearRetryStallTimer()
		replaceGeneration()
	}

	/**
	 * The server restarted: a Preview session never outlives its server, so the page starts a new one
	 * under a fresh ID, with a fresh document and generation, before any geometry traffic resumes
	 * (Rule 01a1161c-3b51-7ebd-bff2-987863a7c1cb). The old session's ID is retired; every message of
	 * its documents is stale from now on. The new session starts with an unspent automatic recovery
	 * allowance, no unavailable state and no retry authorization (Rule 01a1161c-3e9d-7da7-b7d7-18caf1d8cf43).
	 */
	function renewSession(): void {
		workbenchPreviewSessions.close(protocolSession.previewSessionId)
		protocolSession = workbenchPreviewSessions.openFresh(() => createPreviewSessionId())
		previewSessionId.value = protocolSession.previewSessionId
		lastFailure = undefined
		shownFailure.value = undefined
		endRetryInFlight()
		endGeneration()
		createBridge()
		documentSequence.value++
		captureIframeSourceContext()
		handshakePhase.value = 'initiating'
	}

	/**
	 * The iframe loaded while a retry is in flight: wait the grace period for a declaration. A
	 * readable document the Workbench no longer requests is ignored (its replacement's load follows);
	 * an unreadable one, such as an error page when the server is down, starts the wait too, so
	 * Retry Preview always comes back (owner ruling 1 of 2026-10-23).
	 */
	function onIframeLoad(): void {
		if (!retryInFlight.value || committedDocument() === 'replaced') return
		clearRetryStallTimer()
		retryStalled.value = false
		retryStallTimer = setTimeout(() => {
			retryStallTimer = undefined
			if (retryInFlight.value) retryStalled.value = true
		}, stallGraceMs)
	}

	function clearRetryStallTimer(): void {
		if (retryStallTimer !== undefined) clearTimeout(retryStallTimer)
		retryStallTimer = undefined
	}

	/** The retry's declaration had its outcome, or the context was replaced: nothing is in flight. */
	function endRetryInFlight(): void {
		retryInFlight.value = false
		retryStalled.value = false
		clearRetryStallTimer()
	}

	/** The protocol bridge of the current Preview session. */
	function createBridge(): void {
		workbenchBridge = new WorkbenchPreviewProtocolBridge(
			protocolSession,
			{
				// One envelope per post: Workbench sends stay in step with its context-channel posts.
				send(message) {
					const target = previewIframe.value?.contentWindow
					if (target) target.postMessage(createPreviewWirePost([message]), window.location.origin)
				},
			},
			// `geometry.multi-target` is optional: a runtime without it gets the single-stream fallback.
			declaration => declaration.protocolVersion === 1
				? { ok: true }
				: { ok: false, reason: 'capability.unsupported_protocol_version' },
			{ onGenerationAdmitted },
		)
	}

	function initBridge(): void {
		try {
			createBridge()
			navigationCoordinator = new PreviewNavigationState({
				viewId: state.selectedViewId.value || '',
				selectedWidgetId: state.selectedWidgetId.value,
			})
			syncGeometryContext()
		}
		catch (cause) {
			handshakePhase.value = 'failed'
			state.error.value = describeFetchError(cause, t('workbench.errors.bridgeInitFailed')).message
		}
	}

	function onCapabilityAcknowledged(features: readonly string[]): void {
		handshakePhase.value = 'open'
		hasConnected.value = true
		// A generation completed its handshake: Preview recovered, and no retry is in flight any more.
		lastFailure = undefined
		shownFailure.value = undefined
		endRetryInFlight()
		runtimeFeatures.value = features
		// The document may have missed context changes made while it loaded; re-send those, then reopen geometry.
		if (contextDiffersFromSource()) notifyIframeContext()
		syncGeometryContext()
		geometryStreams.setMultiTarget(features.includes(MULTI_TARGET_GEOMETRY_FEATURE))
		if (runtimeGenerationId.value) targeting.markGenerationReady(runtimeGenerationId.value)
		// The new document knows no targeting interaction yet: enter a fresh one for the current tool.
		applyToolInteraction()
		// Declare the selection first so its own request identity opens the Widget's stream once.
		acquireSelectionGeometry()
		geometryStreams.setReady(true)
	}

	/**
	 * A `checks.report` that passed the bridge's session, generation, ACK and feature gates. It
	 * replaces the held report when it is about the View and Variant the Workbench renders and is
	 * newer than what was accepted (Clause 01a17619-ab3f-797d-ae93-4038a48ee31f).
	 */
	function receiveChecksReport(message: ChecksReportMessage): void {
		const viewId = state.selectedViewId.value
		const generation = runtimeGenerationId.value
		if (!viewId || !generation) return
		const variantId = currentVariantId()
		const accepted = checksReports.accept(message, {
			runtimeGenerationId: generation,
			viewId,
			...(variantId ? { variantId } : {}),
			...(state.contextOptions.value.locales.selected ? { locale: state.contextOptions.value.locales.selected } : {}),
		})
		if (accepted.status === 'accepted') checksVersion.value++
	}

	/**
	 * Targeting traffic that passed the bridge's session, generation and ACK gates. Workbench then
	 * gates on the mounted View and Variant, then on the exact active `targetingInteractionId`
	 * (item 2.3); late traffic of a superseded interaction is stale and changes nothing.
	 */
	function receiveTargeting(message: TargetingRuntimeMessage): void {
		if (message.context.viewId !== state.selectedViewId.value || (message.context.variantId ?? '') !== (currentVariantId() ?? '')) return
		const generation = message.context.runtimeGenerationId
		const interaction = message.payload.targetingInteractionId
		if (message.type === 'targeting.hover') {
			const next = message.context.widgetId
			const purpose = targeting.snapshot().purpose
			const result = next
				? targeting.reportHoverCandidate(generation, interaction, message.payload.pointerType ?? 'mouse', { widgetId: next })
				: targeting.clearHoverCandidate(generation, interaction)
			if (result.status !== 'candidate' && result.status !== 'accepted') return
			if (next === hoverWidgetId.value && purpose === hoverPurpose.value) return
			hoverWidgetId.value = next
			hoverPurpose.value = next ? purpose : undefined
			updateGeometryDemand()
			return
		}
		if (message.type === 'targeting.escape') {
			const snapshot = targeting.snapshot()
			if (snapshot.purpose !== 'comment-range' || snapshot.targetingInteractionId !== interaction || snapshot.runtimeGenerationId !== generation || snapshot.input !== 'ready') return
			handleEscape()
			return
		}
		const widgetId = message.context.widgetId
		const committed = targeting.commitFinalTarget(generation, interaction, { widgetId })
		if (committed.status !== 'committed') return
		targetingInteractionId.value = undefined
		releaseIframeFocus()
		if (committed.purpose === 'inspection') {
			selectWidget(widgetId)
			// The commit ended the interaction; Select keeps targeting with a fresh one.
			applyToolInteraction()
			return
		}
		const point = message.payload.point
		// Comment stays on after a commit (brief c, section 5): a fresh interaction follows at once.
		applyToolInteraction()
		commentTargetHandler?.({ widgetId, ...(point ? { point } : {}) })
	}

	/**
	 * A click that committed a Select or Comment target also moved keyboard focus into the iframe,
	 * whose document would then swallow every Workbench key (`C`, `V`, `I`, `Shift C`, `J`/`K`,
	 * `⌘K`): pressing `C` after selecting a Widget silently did nothing (review feedback 8dd59d25).
	 * The Workbench takes focus back to the canvas region after each commit. Interact holds no
	 * targeting interaction, so there the View keeps its keys, as it should.
	 */
	function releaseIframeFocus(): void {
		const iframe = previewIframe.value
		if (!iframe || document.activeElement !== iframe) return
		iframe.closest<HTMLElement>('[data-canvas]')?.focus({ preventScroll: true })
	}

	function onWindowMessage(event: MessageEvent): void {
		// Only this Workbench's own Preview document, of this origin, is a protocol peer (item 2.3).
		if (event.origin !== window.location.origin) return
		const source = previewIframe.value?.contentWindow
		if (!source || event.source !== source) return
		if (!workbenchBridge) return
		// One envelope, or a transport batch from one runtime task: each envelope passes the bridge's
		// gates on its own, in order, exactly as consecutive single posts would.
		const messages = readPreviewWirePost(event.data)
		if (!messages) return
		for (const message of messages) {
			// A document the Workbench already replaced (by a recovery, another View or a renewed
			// session) is no peer any more: nothing it sends, not even a malformed envelope later in
			// the same batch, can fail the requested document or spend its recovery (issue #101).
			// Checked per envelope, because an envelope may replace the document mid-batch.
			if (committedDocument() === 'replaced') return
			receiveWire(message)
		}
	}

	/**
	 * Whether the committed iframe document is the one the Workbench last requested. A navigating
	 * iframe keeps its window, so the source check alone cannot tell a replaced document from the
	 * requested one (owner ruling 1 of 2026-10-23, Discussion #241). A self-reload keeps its URL.
	 */
	function requestedDocumentIsCommitted(): boolean {
		return committedDocument() === 'requested'
	}

	/** The committed iframe document: the requested one, another readable one, or one it cannot read. */
	function committedDocument(): 'requested' | 'replaced' | 'unreadable' {
		try {
			const location = previewIframe.value?.contentWindow?.location.href
			if (!location) return 'unreadable'
			return new URL(location).searchParams.get('document') === String(documentSequence.value) ? 'requested' : 'replaced'
		}
		catch {
			return 'unreadable'
		}
	}

	function receiveWire(input: unknown): void {
		if (!workbenchBridge) return
		const declaration = isCapabilityDeclaration(input)
		// A declaration from a replaced document never admits a generation; it is dropped without effect.
		if (declaration && !requestedDocumentIsCommitted()) return
		// So is a runtime-reported failure: it ends a generation, which only the requested document's
		// runtime may do (issue #312, on top of the generation check of the bridge).
		if (isFailureReport(input) && !requestedDocumentIsCommitted()) return
		// A Checks report of a replaced document is no report of the Preview the Workbench shows.
		if (isChecksReport(input) && !requestedDocumentIsCommitted()) return
		const phase = handshakePhase.value
		const admittedGenerationId = runtimeGenerationId.value
		const result = workbenchBridge.receive(input)
		if (result.status === 'ack-dispatched') {
			const features = (input as { payload?: { features?: unknown } }).payload?.features
			onCapabilityAcknowledged(Array.isArray(features) ? features.filter((feature): feature is string => typeof feature === 'string') : [])
		}
		else if (result.status === 'accepted') {
			const message = result.message
			if (message.type === 'geometry.acquire.response') receiveGeometryReport(message)
			else if (message.type === 'targeting.hover' || message.type === 'targeting.select' || message.type === 'targeting.escape') receiveTargeting(message)
			else if (message.type === 'widget.event.occurrence') widgetEvents.receive(message)
			else if (message.type === 'checks.report') receiveChecksReport(message)
			// A work-scoped failure report ends one contour work and leaves its generation alone; the
			// Workbench sends no contour work yet, so there is none to end (issue #110).
		}
		else if (result.status === 'generation-failed') {
			// The runtime reported its generation's failure: the session ended and retired it. A `protocol`
			// report made it protocol-invalid, so the one automatic recovery attempt follows; a `runtime`
			// one exhausted recovery, so only Retry Preview starts the next generation (Rule
			// 01a11a59-eecb-7aff-983b-972148c714e1).
			failPreview(result.status, failureReportDiagnostic(result.message))
			if (result.message.payload.category === 'protocol') recoverAutomatically()
		}
		else {
			const derived = deriveWorkbenchFailure({
				result,
				declaration,
				envelopeGenerationId: envelopeGenerationId(input),
				admittedGenerationId,
				previewSessionId: previewSessionId.value,
				phase,
			})
			if (derived.effect === 'fail') {
				// The session judged a conflicting declaration and a capability failure itself; an
				// undecodable message or a reused generation ID fails the requested document here.
				if (result.status === 'invalid' || result.status === 'stale-generation') workbenchBridge.failRequestedDocument()
				failPreview(result.status, derived.failure)
				recoverAutomatically()
			}
			else if (derived.effect === 'refused')
				failPreview(result.status, lastFailure && recorrelatePreviewFailure(lastFailure, previewSessionId.value, derived.generationId))
		}
	}

	/**
	 * Preview is unavailable after a non-recoverable failure: the handshake fails, the retry in
	 * flight (if any) has run its course, and the diagnostic shows `failure`. A generation refused
	 * while recovery is exhausted passes the failure that exhausted it, under the refused generation.
	 */
	function failPreview(status: BridgeReceiveResult['status'], failure: PreviewFailureDiagnostic | undefined): void {
		if (failure) {
			if (status !== 'generation-refused') lastFailure = failure
			shownFailure.value = failure
		}
		// The session already ended these generations: a refused one, or one whose declaration
		// conflicted, which may have been open with live streams.
		if ((status === 'generation-refused' || status === 'capability-conflict' || status === 'invalid' || status === 'generation-failed') && runtimeGenerationId.value) endGeneration()
		handshakePhase.value = 'failed'
		endRetryInFlight()
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc leaves the composer, the bubble, then Comment mode, even when focus is in the Workbench.
		// The event is never prevented: menus and dialogs above the canvas close themselves on it too.
		if (event.key !== 'Escape' || event.defaultPrevented) return
		handleEscape()
	}

	function mount(): void {
		window.addEventListener('message', onWindowMessage)
		window.addEventListener('keydown', onWindowKeydown)
		initBridge()
	}

	function unmount(): void {
		window.removeEventListener('message', onWindowMessage)
		window.removeEventListener('keydown', onWindowKeydown)
		clearRetryStallTimer()
	}

	// Comment mode is meaningless without a mounted View.
	watch(() => state.selectedView.value, (view) => {
		if (!view && isCommentMode.value) {
			canvasTool.value = baseTool.value
			reanchorThreadId.value = undefined
			exitInteraction()
			leaveCommentTracking()
		}
	})

	// One iframe document is one runtime generation. A new View, or a new iframe element (the canvas
	// was unmounted and mounted again), starts a fresh generation; the same document is never reused.
	let generationElement: HTMLIFrameElement | undefined
	watch(previewIframe, (element, previous) => {
		previous?.removeEventListener('load', onIframeLoad)
		if (!element) {
			clearRetryStallTimer()
			return
		}
		element.addEventListener('load', onIframeLoad)
		if (generationElement && generationElement !== element) replaceGeneration()
		generationElement = element
	})
	watch(() => state.selectedView.value?.key, (key, previous) => {
		// Another View replaces the context: its diagnostic and any retry in flight end here, even when
		// a new iframe element already requested the new document. A pending authorization stays with
		// the session, and a refusal of the new View's document shows the failure again (owner ruling 4
		// of 2026-10-23, Discussion #241).
		if (previous && key !== previous) {
			shownFailure.value = undefined
			endRetryInFlight()
		}
		if (key && key !== iframeSourceContext.value?.viewId) replaceGeneration()
	})

	// A change of View, Variant or Locale ends the live warnings and errors of the previous context
	// (Rule 01a115cd-b9fc-71d9-8bf9-91d65acd1096): the next report of the new context replaces them.
	watch(
		() => [state.selectedViewId.value, state.contextOptions.value.variants.selected, state.contextOptions.value.locales.selected] as const,
		(next, previous) => {
			if (previous && next.every((value, index) => value === previous[index])) return
			checksReports.clear()
			checksVersion.value++
		},
	)

	// A new selected Widget, a Variant change (new runtime context) or a content-viewport size change
	// (Part 3: inner geometry is invalidated) reopens the selection request with a fresh identity.
	// A Variant change ends every stream and reopens it under the new context; a content-box size
	// change hides every report and reopens every stream (decision 4). Locale and theme changes keep
	// the streams: the runtime reports the re-laid-out geometry itself.
	watch(
		() => [
			state.selectedViewId.value,
			state.selectedWidgetId.value,
			state.contextOptions.value.variants.selected,
			state.contextOptions.value.viewports.selectedDimensions.width,
			state.contextOptions.value.viewports.selectedDimensions.height,
		] as const,
		(next, previous) => {
			if (previous && next.every((value, index) => value === previous[index])) return
			const contextChanged = !previous || next[0] !== previous[0] || next[2] !== previous[2]
			const sizeChanged = !!previous && (next[3] !== previous[3] || next[4] !== previous[4])
			if (contextChanged) {
				selectionTarget = undefined
				clearHover()
				syncGeometryContext()
			}
			if (sizeChanged) geometryStreams.invalidateContentBox()
			acquireSelectionGeometry()
		},
	)

	return {
		previewIframe,
		previewIframeSrc,
		previewSessionId,
		runtimeGenerationId,
		documentSequence,
		sessionPhase,
		sessionStatus,
		runtimeFeatures,
		isCommentMode,
		canvasTool,
		setCanvasTool,
		reanchorThreadId,
		startReanchor,
		selectionGeometry,
		selectionVisibility,
		hoverCandidate,
		canvasMapping,
		setPinThreads,
		releasePinThreads,
		pinPlacements,
		geometryStreams,
		selectWidget,
		hideSelectionHighlight,
		failureDiagnostic,
		retryInFlight,
		retryDisabled,
		retry,
		renewSession,
		exitCommentMode,
		onCommentTarget,
		onCommentEscape,
		commentOnWidget,
		notifyIframeContext,
		replaceGeneration,
		widgetEvents,
		widgetEventsSupported,
		liveChecks,
		mount,
		unmount,
	}
}

export type PreviewSession = ReturnType<typeof createPreviewSession>
