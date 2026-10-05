import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import { PreviewNavigationState, type PreviewNavigationTarget } from '../../src/preview/navigation-state'
import type { GeometryAcquireResponse, VisibleRegion, WidgetRect } from '../../src/preview/protocol/schema'
import {
	PREVIEW_CONTEXT_CHANNEL,
	PREVIEW_HIGHLIGHT_CHANNEL,
	PREVIEW_TARGETING_CHANNEL,
	PREVIEW_WIRE_CHANNEL,
	type PreviewHighlightPayload,
	type PreviewTargetingPayload,
} from '../../src/preview/protocol/transport'
import { useUiuxClient } from './useUiuxClient'
import type { WorkbenchState } from './useWorkbenchState'
import type { SessionPhase } from './workbench-types'

/** The canvas tool besides Comment, which stays the existing comment mode until R6 rewires it. */
export type CanvasTool = 'select' | 'interact'

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
 * The Workbench side of the preview iframe: protocol bridge handshake, the
 * existing postMessage channels (context / highlight / targeting), comment
 * mode and widget selection coming back from the iframe's own hit-testing.
 */
export function createPreviewSession(state: WorkbenchState) {
	const uiux = useUiuxClient()
	const { t } = useI18n()

	const previewIframe = ref<HTMLIFrameElement>()
	const previewSessionId = ref(`session-${Date.now()}`)
	const runtimeGenerationId = ref(`gen-${Date.now()}`)
	const handshakePhase = ref<Exclude<SessionPhase, 'idle'>>('initiating')
	/** True once any generation of this session completed its handshake: a later loss reads "Reconnecting". */
	const hasConnected = ref(false)
	const isCommentMode = ref(false)
	const targetingInteractionId = ref<string>()
	const canvasTool = ref<CanvasTool>('select')
	const runtimeFeatures = ref<readonly string[]>([])
	const selectionGeometry = shallowRef<SelectionGeometry>()
	const selectionVisibility = ref<SelectionVisibility>('none')

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

	let workbenchBridge: WorkbenchPreviewProtocolBridge | undefined
	let navigationCoordinator: PreviewNavigationState | undefined
	let commentTargetHandler: ((widgetId: string) => void | Promise<void>) | undefined
	/** The geometry request whose reports may update the selection overlay; one stream at a time (no `geometry.multi-target`). */
	let activeGeometryRequest: PreviewNavigationTarget | undefined
	let geometryRequestSequence = 0
	let generationSequence = 0
	/**
	 * Whether this runtime generation has answered a geometry request. Until it has, the legacy
	 * in-iframe highlight stays as the only visible selection cue; once a runtime reports geometry,
	 * the Workbench overlay takes over and the in-iframe highlight is cleared.
	 */
	let geometryProducerSeen = false

	/**
	 * The iframe document is created once per runtime generation. Locale, viewport, theme and
	 * Variant changes are presentation or state changes sent over the context channel, so they
	 * never reload the document and never reuse a generation for a new document (Parts 1 and 10).
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
		if (handshakePhase.value !== 'open' && iframeSourceContext.value && contextDiffersFromSource()) captureIframeSourceContext()
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
			generation: runtimeGenerationId.value,
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

	function postHighlight(payload: PreviewHighlightPayload): void {
		post(PREVIEW_HIGHLIGHT_CHANNEL, { payload })
	}

	function postTargeting(payload: PreviewTargetingPayload): void {
		post(PREVIEW_TARGETING_CHANNEL, { payload })
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

	/**
	 * Opens a geometry request for the selected Widget (the N = 1 case of the accepted per-Widget
	 * stream model, Discussion #2). Every call mints a fresh `navigationRequestId`, so reports for an
	 * earlier Widget, Variant or content-viewport size fail the correlation gate. Nothing is drawn
	 * until a current report arrives; there is no last-known geometry.
	 */
	function acquireSelectionGeometry(): void {
		activeGeometryRequest = undefined
		selectionGeometry.value = undefined
		const viewId = state.selectedViewId.value
		const widgetId = state.selectedWidgetId.value
		if (!viewId || !widgetId || !navigationCoordinator) {
			selectionVisibility.value = 'none'
			return
		}
		selectionVisibility.value = 'awaiting'
		const variantId = state.contextOptions.value.variants.selected || undefined
		const target: PreviewNavigationTarget = Object.freeze({
			navigationRequestId: `geometry-${++geometryRequestSequence}-${Date.now()}`,
			viewId,
			...(variantId ? { variantId } : {}),
			widgetId,
		})
		const request = navigationCoordinator.requestChecksNavigation(target)
		if (request.status !== 'execute') return // Comment mode: suspended, reacquired on exit (Part 3).
		navigationCoordinator.applyNavigationResolution(target, 'resolved')
		activeGeometryRequest = target
		if (!workbenchBridge || handshakePhase.value !== 'open') return // Sent again after the capability ACK.
		workbenchBridge.sendGeometry({
			type: 'geometry.acquire.request',
			context: {
				previewSessionId: previewSessionId.value,
				runtimeGenerationId: runtimeGenerationId.value,
				viewId,
				...(variantId ? { variantId } : {}),
				navigationRequestId: target.navigationRequestId,
				widgetId,
			},
			payload: {},
		})
	}

	function receiveGeometryReport(message: GeometryAcquireResponse): void {
		const target = activeGeometryRequest
		if (!target || !navigationCoordinator) return
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
		if (!geometryProducerSeen) {
			geometryProducerSeen = true
			postHighlight({}) // The overlay takes over; clear the legacy in-iframe highlight.
		}
		selectionVisibility.value = visibility
		selectionGeometry.value = visibility === 'visible'
			? Object.freeze({ widgetId: target.widgetId, geometryRevision: message.context.geometryRevision, rect, regions })
			: undefined
	}

	function resetSelectionGeometry(): void {
		activeGeometryRequest = undefined
		selectionGeometry.value = undefined
		selectionVisibility.value = state.selectedWidgetId.value ? 'awaiting' : 'none'
	}

	function enterCommentMode(): void {
		if (!state.selectedView.value) return
		isCommentMode.value = true
		navigationCoordinator?.enterCommentMode()
		targetingInteractionId.value = `target-${Date.now()}`
		postTargeting({ type: 'enter', purpose: 'comment-range', targetingInteractionId: targetingInteractionId.value })
		postHighlight({ commentMode: true, targetingInteractionId: targetingInteractionId.value })
	}

	function exitCommentMode(): void {
		if (!isCommentMode.value) return
		isCommentMode.value = false
		targetingInteractionId.value = undefined
		postTargeting({ type: 'exit' })
		postHighlight({ commentMode: false })
		leaveCommentTracking()
	}

	/** Part 3: the Widget highlight was suspended for comment-range selection; reacquire it with a fresh request. */
	function leaveCommentTracking(): void {
		const exit = navigationCoordinator?.exitCommentMode()
		if (exit) acquireSelectionGeometry()
	}

	function setCanvasTool(tool: CanvasTool): void {
		exitCommentMode()
		canvasTool.value = tool
	}

	function toggleCommentMode(): void {
		if (isCommentMode.value) exitCommentMode()
		else enterCommentMode()
	}

	/** Registers what happens when a widget is picked in comment mode (the shell opens the Reviews composer). */
	function onCommentTarget(handler: (widgetId: string) => void | Promise<void>): void {
		commentTargetHandler = handler
	}

	/** Starts a fresh runtime generation, e.g. after another View is selected. */
	function replaceGeneration(): void {
		runtimeGenerationId.value = `gen-${Date.now()}-${++generationSequence}`
		captureIframeSourceContext()
		geometryProducerSeen = false
		runtimeFeatures.value = []
		navigationCoordinator?.onRuntimeGenerationBoundary()
		resetSelectionGeometry()
		if (workbenchBridge) {
			workbenchBridge.replaceGenerationForLifecycle(runtimeGenerationId.value, 'reload')
			handshakePhase.value = 'initiating'
		}
	}

	/** "Retry" on a stopped or stuck session: a fresh runtime generation and iframe document. */
	function retry(): void {
		if (!state.selectedViewId.value) return
		replaceGeneration()
	}

	function initBridge(): void {
		try {
			workbenchBridge = new WorkbenchPreviewProtocolBridge(
				previewSessionId.value,
				{
					send(message) {
						post(PREVIEW_WIRE_CHANNEL, { message })
					},
				},
				declaration => declaration.protocolVersion === 1
					? { ok: true }
					: { ok: false, reason: 'capability.unsupported_protocol_version' },
			)
			workbenchBridge.admitGeneration(runtimeGenerationId.value, 'initial')
			navigationCoordinator = new PreviewNavigationState({
				viewId: state.selectedViewId.value || '',
				selectedWidgetId: state.selectedWidgetId.value,
			})
		}
		catch (cause) {
			handshakePhase.value = 'failed'
			state.error.value = cause instanceof Error ? cause.message : t('workbench.errors.bridgeInitFailed')
		}
	}

	async function onWindowMessage(event: MessageEvent): Promise<void> {
		if (event.origin !== window.location.origin) return
		const data = event.data
		if (!data || typeof data !== 'object') return

		if (data.channel === PREVIEW_WIRE_CHANNEL && data.message && workbenchBridge) {
			const result = workbenchBridge.receive(data.message)
			if (result.status === 'ack-dispatched') {
				handshakePhase.value = 'open'
				hasConnected.value = true
				const features = (data.message as { payload?: { features?: unknown } }).payload?.features
				runtimeFeatures.value = Array.isArray(features) ? features.filter((feature): feature is string => typeof feature === 'string') : []
				// The document may have missed context changes made while it loaded; re-send those, then reopen geometry.
				if (contextDiffersFromSource()) notifyIframeContext()
				acquireSelectionGeometry()
				if (state.selectedWidgetId.value) postHighlight({ widgetId: state.selectedWidgetId.value })
			}
			else if (result.status === 'accepted' && result.message.type === 'geometry.acquire.response') receiveGeometryReport(result.message)
			else if (result.status === 'capability-failure') handshakePhase.value = 'failed'
			else if (result.status === 'invalid' && handshakePhase.value !== 'open') handshakePhase.value = 'failed'
			return
		}

		if (data.channel !== PREVIEW_TARGETING_CHANNEL || !data.payload) return
		const payload = data.payload as PreviewTargetingPayload
		if (payload.type === 'select' && payload.widgetId) {
			if (payload.viewId && state.selectedViewId.value && payload.viewId !== state.selectedViewId.value) return
			const isCommentPick = isCommentMode.value
				&& payload.purpose !== 'inspection'
				&& (!payload.targetingInteractionId || payload.targetingInteractionId === targetingInteractionId.value)
			// The Interact tool hands clicks to the View; they never change the Workbench selection.
			if (!isCommentPick && canvasTool.value === 'interact') return
			selectWidget(payload.widgetId)
			if (isCommentPick) {
				exitCommentMode()
				await commentTargetHandler?.(payload.widgetId)
			}
		}
		else if (payload.type === 'escape') {
			if (!isCommentMode.value) return
			isCommentMode.value = false
			targetingInteractionId.value = undefined
			leaveCommentTracking()
		}
	}

	function onWindowKeydown(event: KeyboardEvent): void {
		// Esc leaves comment mode even when keyboard focus is in the Workbench, not the iframe.
		if (event.key === 'Escape' && isCommentMode.value) exitCommentMode()
	}

	function mount(): void {
		window.addEventListener('message', onWindowMessage)
		window.addEventListener('keydown', onWindowKeydown)
		initBridge()
	}

	function unmount(): void {
		window.removeEventListener('message', onWindowMessage)
		window.removeEventListener('keydown', onWindowKeydown)
	}

	// Comment mode is meaningless without a mounted View.
	watch(() => state.selectedView.value, (view) => {
		if (!view && isCommentMode.value) {
			isCommentMode.value = false
			targetingInteractionId.value = undefined
			leaveCommentTracking()
		}
	})

	// One iframe document is one runtime generation. A new View, or a new iframe element (the canvas
	// was unmounted and mounted again), starts a fresh generation; the same document is never reused.
	let generationElement: HTMLIFrameElement | undefined
	watch(previewIframe, (element) => {
		if (!element) return
		if (generationElement && generationElement !== element) replaceGeneration()
		generationElement = element
	})
	watch(() => state.selectedView.value?.key, (key) => {
		if (key && key !== iframeSourceContext.value?.viewId) replaceGeneration()
	})

	// A new selected Widget, a Variant change (new runtime context) or a content-viewport size change
	// (Part 3: inner geometry is invalidated) reopens the geometry request with a fresh identity.
	// Locale and theme changes keep the request: the runtime reports the re-laid-out geometry itself.
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
			acquireSelectionGeometry()
			// Until a runtime reports geometry, the legacy in-iframe highlight is the visible cue.
			if (!geometryProducerSeen && state.selectedWidgetId.value) postHighlight({ widgetId: state.selectedWidgetId.value })
		},
	)

	return {
		previewIframe,
		previewIframeSrc,
		previewSessionId,
		runtimeGenerationId,
		sessionPhase,
		sessionStatus,
		runtimeFeatures,
		isCommentMode,
		canvasTool,
		setCanvasTool,
		selectionGeometry,
		selectionVisibility,
		selectWidget,
		retry,
		toggleCommentMode,
		enterCommentMode,
		exitCommentMode,
		onCommentTarget,
		notifyIframeContext,
		replaceGeneration,
		mount,
		unmount,
	}
}

export type PreviewSession = ReturnType<typeof createPreviewSession>
