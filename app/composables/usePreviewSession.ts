import { computed, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
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
	type VisibleRegion,
	type WidgetRect,
} from '../../src/preview/protocol/schema'
import {
	PREVIEW_CONTEXT_CHANNEL,
	PREVIEW_TARGETING_CHANNEL,
	PREVIEW_WIRE_CHANNEL,
	type PreviewTargetingPayload,
	type PreviewTargetingPurpose,
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

/** The runtime's current hover candidate and its geometry (Part 3 targeting hover preview). */
export type HoverCandidate = Readonly<{
	widgetId: string
	purpose: PreviewTargetingPurpose
	/** The candidate Widget's latest accepted report; absent until its stream reports. */
	geometry?: GeometryReport
}>

/** The measured canvas mapping, published by the canvas for pins and other overlay consumers. */
export type CanvasMappingState = Readonly<{
	mapping?: AffineOuterMapping
	/** The visible canvas stage in overlay-layer px (pins mapped outside it become edge indicators). */
	stage?: Readonly<{ left: number; top: number; right: number; bottom: number }>
}>

/** Options of the pins consumer: the open thread is tracked first (decision 6, tier 1). */
export type PinTrackingOptions = Readonly<{ openThreadId?: string }>

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
	/** Bumps on every accepted or hidden geometry report, so computed consumers re-read the coordinator. */
	const geometryVersion = ref(0)
	const hoverWidgetId = ref<string>()
	const hoverPurpose = ref<PreviewTargetingPurpose>()
	const pinThreads = shallowRef<readonly PinThreadInput[]>([])
	const pinOptions = shallowRef<PinTrackingOptions>({})
	const canvasMapping = shallowRef<CanvasMappingState>({})

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
	/** The Checks/selection highlight request; its reports may update the selection overlay. */
	let selectionTarget: PreviewNavigationTarget | undefined
	let generationSequence = 0
	let interactionSequence = 0
	const targeting = new PreviewTargetingState<{ widgetId: string }>()

	/** Every geometry stream of this session (Part 2, 2026-10-05 multi-target decision group). */
	const geometryStreams = new GeometryStreamCoordinator({
		send(message) {
			workbenchBridge?.sendGeometry(message)
		},
		requestFrame: callback => requestAnimationFrame(callback),
		cancelFrame: handle => cancelAnimationFrame(handle),
	})
	geometryStreams.subscribe(() => { geometryVersion.value++ })
	const pinEngine = new PinPlacementEngine()

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

	function currentVariantId(): string | undefined {
		return state.contextOptions.value.variants.selected || undefined
	}

	/** Keeps the coordinator's runtime context equal to the mounted View, Variant and generation. */
	function syncGeometryContext(): void {
		const viewId = state.selectedViewId.value
		const variantId = currentVariantId()
		geometryStreams.setContext(viewId
			? {
					previewSessionId: previewSessionId.value,
					runtimeGenerationId: runtimeGenerationId.value,
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
		if (selectionTarget) {
			demand.push({ consumerId: 'selection', widgetId: selectionTarget.widgetId, tier: 'highlight', navigationRequestId: selectionTarget.navigationRequestId })
		}
		const pins = pinGeometryDemand(pinThreads.value, { viewId: state.selectedViewId.value, variantId: currentVariantId() })
		const openThreadId = pinOptions.value.openThreadId
		for (const pin of pins) {
			demand.push(openThreadId && pin.consumerId === `pin:${openThreadId}` ? { ...pin, tier: 'targeting' } : pin)
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

	/**
	 * Enters the targeting interaction the current tool implies: Select is `inspection` (hover
	 * outline and click-to-select), Interact has none. A fresh `targetingInteractionId` supersedes
	 * the previous interaction at once (Part 3, 2026-10-02).
	 */
	function enterToolTargeting(): void {
		if (isCommentMode.value) return
		clearHover()
		if (canvasTool.value !== 'select' || !state.selectedView.value) {
			if (targetingInteractionId.value) {
				targeting.explicitCancel()
				targetingInteractionId.value = undefined
				postTargeting({ type: 'exit' })
			}
			return
		}
		const id = freshInteractionId()
		targeting.enterMode('inspection', id)
		targetingInteractionId.value = id
		postTargeting({ type: 'enter', purpose: 'inspection', targetingInteractionId: id })
	}

	function enterCommentMode(): void {
		if (!state.selectedView.value) return
		isCommentMode.value = true
		navigationCoordinator?.enterCommentMode()
		clearHover()
		const id = freshInteractionId()
		targeting.enterMode('comment-range', id)
		targetingInteractionId.value = id
		postTargeting({ type: 'enter', purpose: 'comment-range', targetingInteractionId: id })
		// The Checks/selection highlight consumer is suspended and hidden (Part 3). Its stream is
		// released unless a pin uses the same Widget; pins stay tracked (decision 8).
		selectionTarget = undefined
		selectionGeometry.value = undefined
		updateGeometryDemand()
	}

	function exitCommentMode(): void {
		if (!isCommentMode.value) return
		isCommentMode.value = false
		targeting.explicitCancel()
		targetingInteractionId.value = undefined
		postTargeting({ type: 'exit' })
		leaveCommentTracking()
		enterToolTargeting()
	}

	/** Part 3: the Widget highlight was suspended for comment-range selection; reacquire it with a fresh request. */
	function leaveCommentTracking(): void {
		const exit = navigationCoordinator?.exitCommentMode()
		if (exit) acquireSelectionGeometry()
	}

	function setCanvasTool(tool: CanvasTool): void {
		exitCommentMode()
		canvasTool.value = tool
		enterToolTargeting()
	}

	function toggleCommentMode(): void {
		if (isCommentMode.value) exitCommentMode()
		else enterCommentMode()
	}

	/** Registers what happens when a widget is picked in comment mode (the shell opens the Reviews composer). */
	function onCommentTarget(handler: (widgetId: string) => void | Promise<void>): void {
		commentTargetHandler = handler
	}

	/**
	 * Declares the in-scope comment threads whose pins the canvas tracks. Their Widgets get
	 * geometry streams in decision 6 order; `pinPlacements` reports each thread's placement.
	 * Pins stay tracked during Comment mode (decision 8).
	 */
	function setPinThreads(threads: readonly PinThreadInput[], options: PinTrackingOptions = {}): void {
		pinThreads.value = Object.freeze([...threads])
		pinOptions.value = Object.freeze({ ...options })
		updateGeometryDemand()
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

	/** Starts a fresh runtime generation, e.g. after another View is selected. */
	function replaceGeneration(): void {
		const previousGeneration = runtimeGenerationId.value
		runtimeGenerationId.value = `gen-${Date.now()}-${++generationSequence}`
		captureIframeSourceContext()
		runtimeFeatures.value = []
		targeting.onGenerationTeardown(previousGeneration)
		hoverWidgetId.value = undefined
		hoverPurpose.value = undefined
		navigationCoordinator?.onRuntimeGenerationBoundary()
		resetSelectionGeometry()
		// Generation boundary: every stream is void until the new generation's capability ACK.
		syncGeometryContext()
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
				// `geometry.multi-target` is optional: a runtime without it gets the single-stream fallback.
				declaration => declaration.protocolVersion === 1
					? { ok: true }
					: { ok: false, reason: 'capability.unsupported_protocol_version' },
			)
			workbenchBridge.admitGeneration(runtimeGenerationId.value, 'initial')
			navigationCoordinator = new PreviewNavigationState({
				viewId: state.selectedViewId.value || '',
				selectedWidgetId: state.selectedWidgetId.value,
			})
			syncGeometryContext()
		}
		catch (cause) {
			handshakePhase.value = 'failed'
			state.error.value = cause instanceof Error ? cause.message : t('workbench.errors.bridgeInitFailed')
		}
	}

	function onCapabilityAcknowledged(features: readonly string[]): void {
		handshakePhase.value = 'open'
		hasConnected.value = true
		runtimeFeatures.value = features
		// The document may have missed context changes made while it loaded; re-send those, then reopen geometry.
		if (contextDiffersFromSource()) notifyIframeContext()
		syncGeometryContext()
		geometryStreams.setMultiTarget(features.includes(MULTI_TARGET_GEOMETRY_FEATURE))
		targeting.markGenerationReady(runtimeGenerationId.value)
		// The new document knows no targeting mode yet: re-enter the active interaction.
		if (isCommentMode.value && targetingInteractionId.value) {
			postTargeting({ type: 'enter', purpose: 'comment-range', targetingInteractionId: targetingInteractionId.value })
		}
		else enterToolTargeting()
		// Declare the selection first so its own request identity opens the Widget's stream once.
		acquireSelectionGeometry()
		geometryStreams.setReady(true)
	}

	function receiveHover(payload: PreviewTargetingPayload): void {
		const generation = payload.runtimeGenerationId
		const interaction = payload.targetingInteractionId
		if (!generation || !interaction) return
		const purpose = targeting.snapshot().purpose
		const result = payload.widgetId
			? targeting.reportHoverCandidate(generation, interaction, payload.pointerType ?? 'mouse', { widgetId: payload.widgetId })
			: targeting.clearHoverCandidate(generation, interaction)
		if (result.status !== 'candidate' && result.status !== 'accepted') return
		const next = payload.widgetId
		if (next === hoverWidgetId.value && purpose === hoverPurpose.value) return
		hoverWidgetId.value = next
		hoverPurpose.value = next ? purpose : undefined
		updateGeometryDemand()
	}

	async function onWindowMessage(event: MessageEvent): Promise<void> {
		if (event.origin !== window.location.origin) return
		const data = event.data
		if (!data || typeof data !== 'object') return

		if (data.channel === PREVIEW_WIRE_CHANNEL && data.message && workbenchBridge) {
			const result = workbenchBridge.receive(data.message)
			if (result.status === 'ack-dispatched') {
				const features = (data.message as { payload?: { features?: unknown } }).payload?.features
				onCapabilityAcknowledged(Array.isArray(features) ? features.filter((feature): feature is string => typeof feature === 'string') : [])
			}
			else if (result.status === 'accepted' && result.message.type === 'geometry.acquire.response') receiveGeometryReport(result.message)
			else if (result.status === 'capability-failure') handshakePhase.value = 'failed'
			else if (result.status === 'invalid' && handshakePhase.value !== 'open') handshakePhase.value = 'failed'
			return
		}

		if (data.channel !== PREVIEW_TARGETING_CHANNEL || !data.payload) return
		const payload = data.payload as PreviewTargetingPayload
		if (payload.runtimeGenerationId && payload.runtimeGenerationId !== runtimeGenerationId.value) return
		if (payload.type === 'hover') receiveHover(payload)
		else if (payload.type === 'select' && payload.widgetId) {
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
			if (payload.targetingInteractionId && payload.targetingInteractionId !== targetingInteractionId.value) return
			exitCommentMode()
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
			targeting.explicitCancel()
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
		sessionPhase,
		sessionStatus,
		runtimeFeatures,
		isCommentMode,
		canvasTool,
		setCanvasTool,
		selectionGeometry,
		selectionVisibility,
		hoverCandidate,
		canvasMapping,
		setPinThreads,
		pinPlacements,
		geometryStreams,
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
