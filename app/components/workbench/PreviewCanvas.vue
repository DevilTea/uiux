<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { defineShortcuts, useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useCanvasMapping } from '../../composables/useCanvasMapping'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import {
	anchoredScroll,
	canvasInsets,
	CANVAS_GUTTER_COMPACT,
	CANVAS_GUTTER_DESKTOP,
	clampZoom,
	contentSize,
	easeOutQuiet,
	fitScale,
	frameOffset,
	logicalPointAt,
	sessionZoomMemory,
	stepZoom,
	wheelZoom,
	zoomMemoryKey,
	type Point,
	type ZoomMode,
} from '../../utils/canvas-zoom'
import { findWidgetInTree, type WidgetTreeNode } from '../../../src/preview/widget-tree'
import RenderContextControls from './RenderContextControls.vue'
import SessionStatus from './SessionStatus.vue'
import CanvasZoomControls from './CanvasZoomControls.vue'
import CanvasToolPill, { type CanvasToolId } from './CanvasToolPill.vue'
import CanvasOverlay from './CanvasOverlay.vue'
import CommentPinLayer from './comments/CommentPinLayer.vue'
import CommentBubbleHost from './comments/CommentBubbleHost.vue'
import { useCanvasComments } from '../../composables/useCanvasComments'
import { mapPointAffine } from '../../../src/preview/outer-precision'

/**
 * The View canvas (brief b): the render-context bar, the stage with the scaled frame, the overlay
 * and the floating tool pill.
 *
 * The iframe always renders at the canonical logical viewport size; only the outer frame scales.
 * The iframe hit-tests every pointer event over the View: nothing transparent is ever layered over
 * it, the overlay is `pointer-events: none`, and Ctrl/⌘ + wheel or pinch zoom only over the gutter.
 */
const emit = defineEmits<{ (e: 'openPanel', tab: 'readiness'): void }>()
/**
 * `prototype`: the Prototype player reuses this frame (brief g). The Flow step fixes the Variant
 * and the View receives every click, so the tool pill gives way to the player's `dock` slot.
 */
const props = defineProps<{ prototype?: boolean }>()

const { t } = useI18n()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const uiux = useUiuxClient()
const { selectedView, contextOptions, loading, reviewReadOnly, preview, widgetTreeResult, selectedWidgetId, selectedVariant } = workbench
/** The comments layer of the View page, or of the Prototype player (comment mode during playback, R17). */
const comments = useCanvasComments()

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery('(max-width: 767.98px)')
const reducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)')

/** Room the floating tool pill needs below the frame at Fit (pill 40px, 16px offset, 8px air). */
const PILL_RESERVE_PX = 64
const ZOOM_TWEEN_MS = 160

// ---------------------------------------------------------------------------------------------
// Stage geometry, Fit and zoom
// ---------------------------------------------------------------------------------------------

/** Session memory per View and viewport; nothing is persisted (brief b, section 12). */
const zoomMemory = sessionZoomMemory

const stage = ref<HTMLDivElement>()
const overlayLayer = ref<HTMLElement>()
const stageSize = ref({ width: 0, height: 0 })
const dims = computed(() => contextOptions.value.viewports.selectedDimensions)
const insets = computed(() => canvasInsets(isDesktop.value ? CANVAS_GUTTER_DESKTOP : CANVAS_GUTTER_COMPACT, PILL_RESERVE_PX))
const fit = computed(() => fitScale(dims.value, stageSize.value, insets.value))
const zoomMode = ref<ZoomMode>('fit')
/** The rendered frame scale; it equals the target except during a zoom tween. */
const scale = ref(1)
const content = computed(() => contentSize(dims.value, scale.value, stageSize.value, insets.value))
const offset = computed(() => frameOffset(dims.value, scale.value, stageSize.value, insets.value))
const targetScale = computed(() => zoomMode.value === 'fit' ? fit.value : zoomMode.value)
const memoryKey = computed(() => selectedView.value ? zoomMemoryKey(selectedView.value.key, contextOptions.value.viewports.selectedId) : undefined)

let resizeObserver: ResizeObserver | undefined
let tweenId = 0

function measureStage(): void {
	const element = stage.value
	if (!element) return
	stageSize.value = { width: element.clientWidth, height: element.clientHeight }
}

function stageViewportCenter(): Point {
	return { x: stageSize.value.width / 2, y: stageSize.value.height / 2 }
}

function currentScroll(): Point {
	return { x: stage.value?.scrollLeft ?? 0, y: stage.value?.scrollTop ?? 0 }
}

/** The logical point to keep still: the selected Widget's center when it is on screen, else the stage center. */
function zoomAnchor(viewportPoint?: Point): { anchor: Point; viewportPoint: Point } {
	const base = { frame: dims.value, stage: stageSize.value, insets: insets.value, scale: scale.value, scroll: currentScroll() }
	if (viewportPoint) return { anchor: logicalPointAt({ ...base, viewportPoint }), viewportPoint }
	const geometry = preview.selectionGeometry.value
	if (geometry && geometry.widgetId !== 'root') {
		const center = { x: geometry.rect.x + geometry.rect.width / 2, y: geometry.rect.y + geometry.rect.height / 2 }
		const onStage = {
			x: center.x * scale.value + offset.value.x - base.scroll.x,
			y: center.y * scale.value + offset.value.y - base.scroll.y,
		}
		if (onStage.x >= 0 && onStage.y >= 0 && onStage.x <= stageSize.value.width && onStage.y <= stageSize.value.height)
			return { anchor: center, viewportPoint: onStage }
	}
	const center = stageViewportCenter()
	return { anchor: logicalPointAt({ ...base, viewportPoint: center }), viewportPoint: center }
}

async function renderScale(next: number, anchor: { anchor: Point; viewportPoint: Point }): Promise<void> {
	scale.value = next
	// The zoom tween is a Workbench-owned animation: each step remeasures the mapping once.
	markMappingDirty()
	await nextTick()
	const position = anchoredScroll({ frame: dims.value, stage: stageSize.value, insets: insets.value, scale: next, ...anchor })
	stage.value?.scrollTo({ left: position.x, top: position.y, behavior: 'instant' })
}

/** Zooms to a mode. Buttons and shortcuts tween for 160ms; wheel, pinch and reduced motion are instant. */
function setZoom(next: ZoomMode, options: Readonly<{ animate?: boolean; viewportPoint?: Point }> = {}): void {
	zoomMode.value = next === 'fit' ? 'fit' : clampZoom(next)
	if (memoryKey.value) {
		if (zoomMode.value === 'fit') zoomMemory.delete(memoryKey.value)
		else zoomMemory.set(memoryKey.value, zoomMode.value)
	}
	const target = targetScale.value
	const anchor = zoomAnchor(options.viewportPoint)
	const id = ++tweenId
	const from = scale.value
	if (!options.animate || reducedMotion.value || Math.abs(target - from) < 0.0005) {
		void renderScale(target, anchor)
		return
	}
	const started = performance.now()
	const frame = (now: number) => {
		if (id !== tweenId) return
		const progress = Math.min(1, (now - started) / ZOOM_TWEEN_MS)
		void renderScale(from + (target - from) * easeOutQuiet(progress), anchor)
		if (progress < 1) requestAnimationFrame(frame)
	}
	requestAnimationFrame(frame)
}

const zoomIn = () => setZoom(stepZoom(scale.value, 1), { animate: true })
const zoomOut = () => setZoom(stepZoom(scale.value, -1), { animate: true })
const zoomFit = () => setZoom('fit', { animate: true })
const zoomActual = () => setZoom(1, { animate: true })

// A different View or viewport restores its remembered zoom, or fits (brief b, section 7).
watch(memoryKey, (key) => {
	tweenId++
	zoomMode.value = key ? zoomMemory.get(key) ?? 'fit' : 'fit'
	scale.value = targetScale.value
	void nextTick(() => stage.value?.scrollTo({ left: 0, top: 0, behavior: 'instant' }))
}, { immediate: true })

// Fit follows the stage size (panel toggles, window resizes) without a tween.
watch(fit, () => {
	if (zoomMode.value !== 'fit') return
	tweenId++
	scale.value = fit.value
})

function onWheel(event: WheelEvent): void {
	// Wheel events over the iframe belong to the View's own document and never arrive here.
	if (!event.ctrlKey && !event.metaKey) return
	event.preventDefault()
	const bounds = stage.value!.getBoundingClientRect()
	setZoom(wheelZoom(scale.value, event.deltaY), { viewportPoint: { x: event.clientX - bounds.left, y: event.clientY - bounds.top } })
}

// Two-finger pinch on the gutter. A cancelled or lost gesture clears its state (impeccable harden).
const touches = new Map<number, Point>()
let pinch: { distance: number; scale: number } | undefined

function pinchDistance(): number {
	const [first, second] = [...touches.values()]
	return first && second ? Math.hypot(first.x - second.x, first.y - second.y) : 0
}

function onPointerDown(event: PointerEvent): void {
	if (event.pointerType !== 'touch') return
	touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
	if (touches.size === 2) pinch = { distance: pinchDistance(), scale: scale.value }
}

function onPointerMove(event: PointerEvent): void {
	if (!touches.has(event.pointerId)) return
	touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
	if (!pinch || touches.size !== 2 || !pinch.distance) return
	const [first, second] = [...touches.values()] as [Point, Point]
	const bounds = stage.value!.getBoundingClientRect()
	setZoom(pinch.scale * (pinchDistance() / pinch.distance), {
		viewportPoint: { x: (first.x + second.x) / 2 - bounds.left, y: (first.y + second.y) / 2 - bounds.top },
	})
}

function onPointerEnd(event: PointerEvent): void {
	touches.delete(event.pointerId)
	if (touches.size < 2) pinch = undefined
}

function resetGestures(): void {
	touches.clear()
	pinch = undefined
}

onMounted(() => {
	measureStage()
	if (stage.value) {
		resizeObserver = new ResizeObserver(measureStage)
		resizeObserver.observe(stage.value)
		stage.value.addEventListener('wheel', onWheel, { passive: false })
		stage.value.addEventListener('scroll', onStageScroll, { passive: true })
	}
	window.addEventListener('blur', resetGestures)
	window.addEventListener('keydown', onCanvasKeydown, { capture: true })
	void loadAdapterState()
})

onBeforeUnmount(() => {
	tweenId++
	resizeObserver?.disconnect()
	resizeObserver = undefined
	stage.value?.removeEventListener('wheel', onWheel)
	stage.value?.removeEventListener('scroll', onStageScroll)
	window.removeEventListener('blur', resetGestures)
	window.removeEventListener('keydown', onCanvasKeydown, { capture: true })
	shell.onCanvasCommands(undefined)
})

// ---------------------------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------------------------

/**
 * The Checks/selection highlight; Comment mode hides it (Part 3). The RootShell is the frame itself.
 * The Prototype player draws no selection: playback is the View itself, not an inspection of it.
 */
const highlightGeometry = computed(() => {
	const geometry = preview.selectionGeometry.value
	return props.prototype || preview.isCommentMode.value || geometry?.widgetId === 'root' ? undefined : geometry
})
/**
 * The runtime's hover candidate, drawn by the overlay (Part 3); the selected Widget needs no hover
 * outline, and the Prototype player (Interact, every click goes to the View) draws none at all.
 */
const hoverCandidate = computed(() => {
	const candidate = preview.hoverCandidate.value
	if ((props.prototype && !preview.isCommentMode.value) || !candidate || candidate.widgetId === 'root') return undefined
	if (candidate.purpose === 'inspection' && candidate.widgetId === highlightGeometry.value?.widgetId) return undefined
	return candidate
})
const pinsTracked = computed(() => preview.pinPlacements.value.length > 0)
/** Threads whose Widget is gone (never drawn, never rebound): the unplaced tray (brief c, section 6). */
const unplacedThreads = computed(() => comments?.threads.value.filter(item => !item.anchorValid && item.status !== 'resolved' && comments.inFilter(item)) ?? [])
const overlayActive = computed(() => !!highlightGeometry.value || !!hoverCandidate.value || pinsTracked.value)
/** Highlight and targeting overlays keep the accepted per-frame loop; pins alone are event-driven. */
const mappingMode = computed(() => highlightGeometry.value || hoverCandidate.value ? 'continuous' as const : 'event-driven' as const)
const { mapping, status: mappingStatus, markDirty: markMappingDirty } = useCanvasMapping({
	iframe: preview.previewIframe,
	overlay: overlayLayer,
	viewport: dims,
	active: overlayActive,
	mode: mappingMode,
})
const mappingPaused = computed(() => overlayActive.value && mappingStatus.value === 'unavailable')
watch([scale, offset, dims], () => markMappingDirty(), { flush: 'post' })

// The visible stage in overlay-layer px, for pins whose mapped point leaves it (decision 7).
const stageScroll = ref({ x: 0, y: 0 })
function onStageScroll(): void {
	stageScroll.value = currentScroll()
}
const stageBounds = computed(() => ({
	left: stageScroll.value.x,
	top: stageScroll.value.y,
	right: stageScroll.value.x + stageSize.value.width,
	bottom: stageScroll.value.y + stageSize.value.height,
}))
watch([mapping, stageBounds], ([nextMapping, stageArea]) => {
	preview.canvasMapping.value = Object.freeze({ ...(nextMapping ? { mapping: nextMapping } : {}), stage: stageArea })
}, { immediate: true })

// A list pick pans the stage to the pin when it is drawn but outside the stage. The iframe is never scrolled.
watch(() => comments?.revealRequest.value, (request) => {
	if (!request || !comments) return
	void nextTick(() => {
		const placement = comments.placementById.value.get(request.threadId)
		const element = stage.value
		if (!placement?.innerPoint || !mapping.value || !element || placement.state === 'hidden' || placement.state === 'invalid') return
		if (placement.state === 'offscreen' && placement.edge?.scope === 'frame') return
		const point = mapPointAffine(placement.innerPoint, mapping.value)
		const bounds = stageBounds.value
		if (point.x >= bounds.left + 40 && point.x <= bounds.right - 340 && point.y >= bounds.top + 40 && point.y <= bounds.bottom - 40) return
		element.scrollTo({
			left: Math.max(0, point.x - stageSize.value.width / 3),
			top: Math.max(0, point.y - stageSize.value.height / 2),
			behavior: reducedMotion.value ? 'instant' : 'smooth',
		})
	})
})

const widgetNode = computed<WidgetTreeNode | undefined>(() => widgetTreeResult.value?.status === 'valid'
	? findWidgetInTree(widgetTreeResult.value.root, selectedWidgetId.value)
	: undefined)
const hoverNode = computed<WidgetTreeNode | undefined>(() => widgetTreeResult.value?.status === 'valid' && hoverCandidate.value
	? findWidgetInTree(widgetTreeResult.value.root, hoverCandidate.value.widgetId)
	: undefined)

// ---------------------------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------------------------

/** Viewers, the publication and phones get no Comment tool (phones read, reply and resolve only). */
const showComment = computed(() => !!comments && !reviewReadOnly.value && !isPhone.value)
const activeTool = computed<CanvasToolId>(() => preview.canvasTool.value)
const toolsDisabledReason = computed(() => {
	if (!selectedView.value) return t('tool.disabledNoView')
	if (preview.sessionStatus.value === 'live') return undefined
	return preview.sessionStatus.value === 'stopped' ? t('tool.disabledStopped') : t('tool.disabledConnecting')
})

function selectTool(tool: CanvasToolId): void {
	if (tool === 'comment') {
		// C toggles the Comment tool; leaving it returns to the tool it was entered from.
		if (preview.isCommentMode.value) preview.exitCommentMode()
		else if (showComment.value) preview.setCanvasTool('comment')
		return
	}
	preview.setCanvasTool(tool)
}

// ---------------------------------------------------------------------------------------------
// States: adapter set and Variant validity
// ---------------------------------------------------------------------------------------------

const adapterState = ref<'unknown' | 'valid' | 'invalid'>('unknown')
const adapterDiagnostics = shallowRef<readonly { code: string; message: string }[]>([])

async function loadAdapterState(): Promise<void> {
	try {
		const result = await uiux.previewAdapters() as { state: 'valid' | 'invalid'; diagnostics?: readonly { code: string; message: string }[] }
		adapterState.value = result.state
		adapterDiagnostics.value = result.diagnostics ?? []
	}
	catch {
		// Unknown is not invalid: the Preview itself still reports what it can.
		adapterState.value = 'unknown'
	}
}
watch(() => selectedView.value?.revision, () => { void loadAdapterState() })

const variantInvalid = computed(() => contextOptions.value.variants.isInvalid && !!contextOptions.value.variants.selected)
const showFrame = computed(() => !!selectedView.value && adapterState.value !== 'invalid' && !variantInvalid.value)

// ---------------------------------------------------------------------------------------------
// Accessibility: iframe title and polite announcements
// ---------------------------------------------------------------------------------------------

const contextSummary = computed(() => {
	const options = contextOptions.value
	return {
		variant: options.variants.selected || t('ctx.base'),
		locale: options.locales.selected,
		viewport: options.viewports.selectedId,
		theme: options.themes.selected,
	}
})
const iframeTitle = computed(() => selectedView.value
	? t('canvas.iframeTitle', { name: selectedView.value.resource.name, ...contextSummary.value })
	: t('workbench.canvas.label'))

const announcement = ref('')
watch(() => ({ ...contextSummary.value }), (next, previous) => {
	if (!previous || !selectedView.value) return
	if (next.variant !== previous.variant) announcement.value = t('canvas.announceContext', { label: t('ctx.variant'), value: next.variant })
	else if (next.locale !== previous.locale) announcement.value = t('canvas.announceContext', { label: t('ctx.locale'), value: next.locale })
	else if (next.viewport !== previous.viewport) announcement.value = t('canvas.announceContext', { label: t('ctx.viewport'), value: next.viewport })
	else if (next.theme !== previous.theme) announcement.value = t('canvas.announceContext', { label: t('ctx.theme'), value: next.theme })
})
watch(() => preview.selectionGeometry.value, (geometry, previous) => {
	if (!geometry || geometry.widgetId === 'root' || geometry.widgetId === previous?.widgetId) return
	announcement.value = t('canvas.announceSelection', {
		type: widgetNode.value?.type ?? '',
		id: geometry.widgetId,
		width: Math.round(geometry.rect.width),
		height: Math.round(geometry.rect.height),
	})
})

// ---------------------------------------------------------------------------------------------
// Keyboard (brief b, section 9) and command palette actions
// ---------------------------------------------------------------------------------------------

const contextControls = ref<InstanceType<typeof RenderContextControls>>()
const contextPopoverOpen = ref(false)

function openContextMenu(dimension: 'variant' | 'locale' | 'theme'): void {
	if (!selectedView.value) return
	if (isDesktop.value) contextControls.value?.openMenu(dimension)
	else contextPopoverOpen.value = true
}

/** Alt + arrows walk the Widget tree: parent, first child, previous and next sibling. */
function walkTree(direction: 'parent' | 'child' | 'previous' | 'next'): void {
	if (widgetTreeResult.value?.status !== 'valid') return
	const parents = new Map<string, WidgetTreeNode>()
	const visit = (node: WidgetTreeNode) => node.children.forEach((child) => { parents.set(child.id, node); visit(child) })
	visit(widgetTreeResult.value.root)
	const node = findWidgetInTree(widgetTreeResult.value.root, selectedWidgetId.value) ?? widgetTreeResult.value.root
	const parent = parents.get(node.id)
	let next: WidgetTreeNode | undefined
	if (direction === 'parent') next = parent
	else if (direction === 'child') next = node.children[0]
	else if (parent) {
		const index = parent.children.findIndex(child => child.id === node.id)
		next = parent.children[index + (direction === 'next' ? 1 : -1)]
	}
	if (next) workbench.selectWidget(next.id)
}

function isTyping(): boolean {
	const element = document.activeElement as HTMLElement | null
	return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.isContentEditable)
}

/** Keys the shortcut helper cannot express by `key` (Shift + digit, ⌘ + = / −), and Escape. */
function onCanvasKeydown(event: KeyboardEvent): void {
	if (!selectedView.value || isTyping()) return
	const command = event.metaKey || event.ctrlKey
	if (event.key === 'Escape') {
		// Comment mode is left by the session's own Escape handler; menus close themselves.
		if (preview.isCommentMode.value || comments?.composer.value || comments?.openThreadId.value || event.defaultPrevented || document.querySelector('[role="dialog"], [role="menu"], [role="listbox"]')) return
		if (selectedWidgetId.value !== 'root') workbench.selectWidget('root')
		return
	}
	let handled = true
	if (command && !event.altKey && !event.shiftKey && event.code === 'Digit0') zoomFit()
	else if (!command && !event.altKey && event.shiftKey && event.code === 'Digit1') zoomFit()
	else if (!command && !event.altKey && event.shiftKey && event.code === 'Digit0') zoomActual()
	else if (command && !event.altKey && (event.code === 'Equal' || event.code === 'NumpadAdd')) zoomIn()
	else if (command && !event.altKey && (event.code === 'Minus' || event.code === 'NumpadSubtract')) zoomOut()
	else handled = false
	if (handled) {
		event.preventDefault()
		event.stopPropagation()
	}
}

defineShortcuts(computed(() => ({
	'alt_arrowup': () => walkTree('parent'),
	'alt_arrowdown': () => walkTree('child'),
	'alt_arrowleft': () => walkTree('previous'),
	'alt_arrowright': () => walkTree('next'),
	...(shell.singleKeyShortcuts.value && selectedView.value && !props.prototype
		? {
				v: () => selectTool('select'),
				i: () => selectTool('interact'),
				shift_v: () => openContextMenu('variant'),
				shift_l: () => openContextMenu('locale'),
				shift_t: () => openContextMenu('theme'),
			}
		: {}),
	// Comment mode stays reachable in the Prototype player (R17): it disarms Widget Events.
	...(shell.singleKeyShortcuts.value && selectedView.value
		? {
				c: () => selectTool('comment'),
				shift_c: () => { if (comments) comments.pinsHidden.value = !comments.pinsHidden.value },
			}
		: {}),
})))

shell.onCanvasCommands({
	fit: zoomFit,
	zoomIn,
	zoomOut,
	actualSize: zoomActual,
	selectTool: tool => selectTool(tool),
	canComment: () => showComment.value,
})

function switchToBase(): void {
	selectedVariant.value = ''
}
</script>

<template>
  <section
    class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
    :aria-label="t('workbench.canvas.label')"
    data-canvas
  >
    <UDashboardToolbar
      :ui="{
        root: 'min-h-10 h-10 gap-1 bg-default px-2 sm:px-2',
        left: 'min-w-0 gap-0.5',
        right: 'shrink-0 gap-0.5',
      }"
    >
      <template #left>
        <template v-if="selectedView">
          <RenderContextControls
            v-if="isDesktop"
            ref="contextControls"
            :lock-variant="props.prototype"
          />
          <UPopover
            v-else
            v-model:open="contextPopoverOpen"
            :content="{ align: 'start', sideOffset: 6 }"
          >
            <UButton
              color="neutral"
              variant="ghost"
              size="sm"
              icon="i-lucide-layers"
              trailing-icon="i-lucide-chevron-down"
              class="min-w-0 max-w-full"
              :label="t('ctx.summary', contextSummary)"
              :aria-label="t('ctx.summaryLabel', contextSummary)"
              data-context-summary
            />
            <template #content>
              <div class="w-[min(20rem,calc(100vw-2rem))] p-2">
                <RenderContextControls
                  layout="stacked"
                  :lock-variant="props.prototype"
                />
              </div>
            </template>
          </UPopover>
        </template>
        <span
          v-else
          class="px-2 text-xs text-muted"
        >{{ t('workbench.canvas.title') }}</span>
      </template>
      <template #right>
        <SessionStatus v-if="showFrame" />
        <USeparator
          v-if="showFrame"
          orientation="vertical"
          class="mx-1 h-4 max-sm:hidden"
        />
        <CanvasZoomControls
          :scale="scale"
          :fitted="zoomMode === 'fit'"
          :disabled="!showFrame"
          @zoom-in="zoomIn"
          @zoom-out="zoomOut"
          @fit="zoomFit"
          @zoom-to="value => setZoom(value, { animate: true })"
        />
        <slot name="actions" />
      </template>
    </UDashboardToolbar>

    <UAlert
      v-if="mappingPaused"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :description="t('canvas.mappingPaused')"
      class="rounded-none border-b border-default"
      :ui="{ description: 'text-xs' }"
    />

    <div
      class="relative min-h-0 flex-1"
      :class="preview.isCommentMode.value ? 'before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:z-10 before:h-0.5 before:bg-comment' : ''"
    >
      <div
        ref="stage"
        class="absolute inset-0 touch-pan-x touch-pan-y overflow-auto overscroll-contain"
        :class="scale >= 0.5 ? 'canvas-dots' : ''"
        data-canvas-stage
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerEnd"
        @pointercancel="onPointerEnd"
        @lostpointercapture="onPointerEnd"
      >
        <div
          class="relative"
          :style="{ width: `${content.width}px`, height: `${content.height}px` }"
        >
          <!-- The iframe keeps the canonical viewport size. Only this outer presentation layer scales. -->
          <div
            v-if="showFrame"
            class="absolute"
            data-canvas-frame-box
            :style="{
              left: `${offset.x}px`,
              top: `${offset.y}px`,
              width: `${dims.width * scale}px`,
              height: `${dims.height * scale}px`,
            }"
          >
            <div
              class="absolute top-0 left-0 overflow-hidden rounded-xs bg-frame shadow-frame"
              data-canvas-frame
              :style="{
                width: `${dims.width}px`,
                height: `${dims.height}px`,
                transform: `scale(${scale})`,
                transformOrigin: '0 0',
              }"
            >
              <iframe
                :ref="(element) => { preview.previewIframe.value = (element as HTMLIFrameElement | null) ?? undefined }"
                :src="preview.previewIframeSrc.value"
                class="block border-0 bg-transparent"
                :style="{ width: `${dims.width}px`, height: `${dims.height}px` }"
                :title="iframeTitle"
              />
            </div>
          </div>

          <USkeleton
            v-else-if="!selectedView && loading"
            class="absolute rounded-xs"
            :style="{
              left: `${offset.x}px`,
              top: `${offset.y}px`,
              width: `${dims.width * scale}px`,
              height: `${dims.height * scale}px`,
            }"
          />

          <div
            ref="overlayLayer"
            class="pointer-events-none absolute inset-0"
          >
            <CanvasOverlay
              v-if="showFrame && overlayActive"
              :mapping="mapping"
              :geometry="highlightGeometry"
              :widget-type="widgetNode?.type"
              :hover="hoverCandidate"
              :hover-type="hoverNode?.type"
              :reanchor="!!preview.reanchorThreadId.value"
              :viewport="dims"
              :bounds="stageBounds"
            />
            <CommentPinLayer
              v-if="showFrame && comments && mapping"
              :mapping="mapping"
            />
          </div>
        </div>
      </div>

      <div
        v-if="selectedView && !showFrame"
        class="absolute inset-0 flex items-center justify-center p-6"
      >
        <UEmpty
          v-if="adapterState === 'invalid'"
          icon="i-lucide-puzzle"
          :title="t('canvas.adapterInvalid')"
          :description="t('canvas.adapterInvalidHint')"
          variant="naked"
          :actions="[{ label: t('canvas.openAdapters'), to: '/workspace/adapters', color: 'neutral', variant: 'outline', icon: 'i-lucide-puzzle' }]"
        >
          <template
            v-if="adapterDiagnostics.length"
            #footer
          >
            <ul class="mt-2 max-w-md space-y-1 text-start text-xs text-muted">
              <li
                v-for="diagnostic in adapterDiagnostics"
                :key="diagnostic.code + diagnostic.message"
              >
                <span class="font-mono">{{ diagnostic.code }}</span> {{ diagnostic.message }}
              </li>
            </ul>
          </template>
        </UEmpty>
        <UEmpty
          v-else
          icon="i-lucide-layers"
          :title="t('canvas.variantInvalid')"
          :description="t('canvas.variantInvalidHint', { variant: contextOptions.variants.selected })"
          variant="naked"
          :actions="[
            { label: t('canvas.switchToBase'), color: 'primary', variant: 'solid', onClick: switchToBase },
            { label: t('canvas.openInChecks'), color: 'neutral', variant: 'outline', onClick: () => emit('openPanel', 'readiness') },
          ]"
        />
      </div>

      <UEmpty
        v-else-if="!selectedView && !loading"
        class="absolute inset-0"
        icon="i-lucide-monitor-dot"
        :title="workbench.views.value.length ? t('workbench.canvas.noSelectionTitle') : t('workbench.canvas.noViewsTitle')"
        variant="naked"
      >
        <template #description>
          <span v-if="workbench.views.value.length">{{ t('workbench.canvas.noSelectionDescription') }}</span>
          <i18n-t
            v-else
            keypath="workbench.canvas.noViewsDescription"
            tag="span"
            scope="global"
          >
            <template #tool>
              <code class="rounded bg-elevated px-1 py-0.5 font-mono text-[0.9em] text-highlighted">create_view</code>
            </template>
          </i18n-t>
        </template>
      </UEmpty>

      <template v-if="showFrame && comments">
        <!-- The bubble's last-resort reference: the canvas corner, for threads with no pin to point at. -->
        <span
          class="pointer-events-none absolute bottom-14 left-3 size-px max-md:bottom-26"
          aria-hidden="true"
          data-comment-fallback
        />
        <UButton
          v-if="unplacedThreads.length"
          class="absolute bottom-4 left-3 z-20 shadow-overlay max-md:bottom-16"
          color="warning"
          variant="soft"
          size="sm"
          icon="i-lucide-triangle-alert"
          :label="t('pins.unplaced', unplacedThreads.length)"
          data-comment-tray
          @click="comments.open(unplacedThreads[0]!.id)"
        />
        <CommentBubbleHost />
        <p
          class="sr-only"
          role="status"
          aria-live="polite"
        >
          {{ comments.announcement.value }}
        </p>
      </template>

      <div
        v-if="showFrame"
        class="pointer-events-none absolute inset-x-0 bottom-4 z-10 flex justify-center px-3"
      >
        <slot
          v-if="props.prototype"
          name="dock"
        />
        <CanvasToolPill
          v-else
          class="pointer-events-auto"
          :active="activeTool"
          :show-comment="showComment"
          :disabled-reason="toolsDisabledReason"
          @select="selectTool"
        />
      </div>

      <p
        class="sr-only"
        role="status"
        aria-live="polite"
      >
        {{ announcement }}
      </p>
    </div>
  </section>
</template>

<style scoped>
/* The canvas's only texture (DESIGN.md "Canvas"): 1px dots at a 16px pitch, at zoom 50% and above. */
.canvas-dots {
  background-image: radial-gradient(var(--wb-canvas-dot) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: 8px 8px;
  background-attachment: local;
}
</style>
