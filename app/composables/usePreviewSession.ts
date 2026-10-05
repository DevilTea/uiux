import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { WorkbenchPreviewProtocolBridge } from '../../src/preview/protocol/bridge'
import { PreviewNavigationState } from '../../src/preview/navigation-state'
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
	const isCommentMode = ref(false)
	const targetingInteractionId = ref<string>()

	/** The phase shown to users. No View mounted means no session is expected, not one that is still starting. */
	const sessionPhase = computed<SessionPhase>(() => state.selectedViewId.value ? handshakePhase.value : 'idle')

	let workbenchBridge: WorkbenchPreviewProtocolBridge | undefined
	let navigationCoordinator: PreviewNavigationState | undefined
	let commentTargetHandler: ((widgetId: string) => void | Promise<void>) | undefined

	const previewIframeSrc = computed(() => {
		if (!state.selectedViewId.value) return ''
		const options = state.contextOptions.value
		const dims = options.viewports.selectedDimensions
		const params = new URLSearchParams({
			session: previewSessionId.value,
			generation: runtimeGenerationId.value,
			viewId: state.selectedViewId.value,
			locale: options.locales.selected,
			viewportId: options.viewports.selectedId,
			viewportWidth: String(dims.width),
			viewportHeight: String(dims.height),
			themeId: options.themes.selected,
		})
		if (options.variants.selected)
			params.set('variant', options.variants.selected)
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
		if (state.selectedViewId.value && navigationCoordinator) {
			const navigationRequestId = `nav-${Date.now()}`
			navigationCoordinator.requestChecksNavigation({
				navigationRequestId,
				viewId: state.selectedViewId.value,
				widgetId: id,
			})
			navigationCoordinator.applyNavigationResolution({
				navigationRequestId,
				viewId: state.selectedViewId.value,
				widgetId: id,
			}, 'resolved')
		}
		postHighlight({ widgetId: id })
	}

	function enterCommentMode(): void {
		if (!state.selectedView.value) return
		isCommentMode.value = true
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
		runtimeGenerationId.value = `gen-${Date.now()}`
		if (workbenchBridge) {
			workbenchBridge.replaceGenerationForLifecycle(runtimeGenerationId.value, 'reload')
			handshakePhase.value = 'initiating'
		}
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
			if (result.status === 'ack-dispatched') handshakePhase.value = 'open'
			else if (result.status === 'capability-failure' || result.status === 'invalid') handshakePhase.value = 'failed'
			return
		}

		if (data.channel !== PREVIEW_TARGETING_CHANNEL || !data.payload) return
		const payload = data.payload as PreviewTargetingPayload
		if (payload.type === 'select' && payload.widgetId) {
			if (payload.viewId && state.selectedViewId.value && payload.viewId !== state.selectedViewId.value) return
			const isCommentPick = isCommentMode.value
				&& payload.purpose !== 'inspection'
				&& (!payload.targetingInteractionId || payload.targetingInteractionId === targetingInteractionId.value)
			selectWidget(payload.widgetId)
			if (isCommentPick) {
				exitCommentMode()
				await commentTargetHandler?.(payload.widgetId)
			}
		}
		else if (payload.type === 'escape') {
			isCommentMode.value = false
			targetingInteractionId.value = undefined
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
		}
	})

	return {
		previewIframe,
		previewIframeSrc,
		sessionPhase,
		isCommentMode,
		selectWidget,
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
