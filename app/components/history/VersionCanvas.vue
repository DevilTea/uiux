<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { useI18n, useRoute } from '#imports'
import type { ViewDiff } from '../../../src/domain/history/diff/view'
import type { ViewResource } from '../../../src/domain/views/schema'
import type { WorkspaceManifest } from '../../../src/domain/workspace/schema'
import type { VersionRecord } from '../../../src/domain/history/schema'
import { resolveFrameContext, type FrameContext, type FrameContextNotice, type FrameContextSelection, type FrameSide } from '../../../src/preview/version-frame-context'
import { useWorkbench } from '../../composables/useWorkbench'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { readVersionRecord, useOrderedEndpoints, useVersionDiff, useWorkbenchSignature } from '../../composables/useVersionHistory'
import { describeFetchError } from '../../utils/fetch-error'
import { canvasInsets, CANVAS_GUTTER_COMPACT, CANVAS_GUTTER_DESKTOP, clampZoom, MIN_ZOOM, stepZoom, wheelZoom, type ZoomMode } from '../../utils/canvas-zoom'
import { canvasHighlights, fitPairScale, FRAME_LABEL_PX, pairLayout, type HighlightKind } from '../../utils/version-canvas'
import { CURRENT_COMPARE, resolveHistorySelection, type HistoryAddress, type HistoryCanvasMode } from '../../utils/version-history'
import RenderContextControls from '../workbench/RenderContextControls.vue'
import CanvasZoomControls from '../workbench/CanvasZoomControls.vue'
import VersionFrame from './VersionFrame.vue'

/**
 * The canvas before/after comparison of the View page (Rules 01a11a5e-11e0-7f39-84a7-fde3faa43340,
 * 1232, 1288, 12dc, 1331, 1385 and 13d6; Rule 01a11e45-6bbc-7c95-9759-e42a3308e7a5), shown in place
 * of the live canvas while the history panel's address holds a `canvas` mode (Clause
 * 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41) on desktop and tablet (Rule 01a11a5e-1ba5-765e-966f-a681def5f472).
 *
 * - Both frames render the View in the canvas's current Variant, Locale, viewport and theme, chosen
 *   with the same render-context bar; a key one side lacks renders that side's default, with a notice.
 * - Historical frames are Preview's read-only version mode: that version's manifest, View and
 *   Locales with the current Widget runtime and Adapters, so the Adapters-changed caveat is always
 *   shown (versions record no Adapter provenance yet, issues #57 and #92). No pins, no tools.
 * - The two frames sit on one stage at one scale: panning, zooming and scrolling the stage move both
 *   together, while each frame's own content scrolls alone.
 * - `highlight` outlines what the View's semantic diff names: added, modified and moved Widgets on
 *   the after frame, removed ones on the before frame, from geometry the frames' runtimes report.
 */
const props = defineProps<{ viewId: string; address: HistoryAddress }>()

const { t } = useI18n()
const route = useRoute()
const uiux = useUiuxClient()
const labels = useHistoryLabels()
const workbench = useWorkbench()
const { contextOptions, selectedView, workspace } = workbench
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)

/** As on the live canvas: below 32rem of toolbar the render-context selects collapse into a summary popover. */
const CONTEXT_BAR_MIN_PX = 512
const contextSlot = ref<HTMLElement>()
const contextBarCompact = ref(true)
let contextSlotObserver: ResizeObserver | undefined
watch(contextSlot, (element) => {
	contextSlotObserver?.disconnect()
	if (!element || typeof ResizeObserver === 'undefined') return
	contextSlotObserver = new ResizeObserver(([entry]) => {
		if (entry) contextBarCompact.value = entry.contentRect.width < CONTEXT_BAR_MIN_PX
	})
	contextSlotObserver.observe(element)
})
onBeforeUnmount(() => contextSlotObserver?.disconnect())

const mode = computed<HistoryCanvasMode>(() => props.address.canvas ?? 'side')
const selection = computed(() => resolveHistorySelection(props.address))
const ordered = useOrderedEndpoints(selection)
const signature = useWorkbenchSignature()
const view = computed(() => [{ kind: 'view', key: props.viewId }])
const diff = useVersionDiff(ordered.endpoints, { resources: view, detail: 'semantic', refreshKey: signature })

/** The two sides as the server resolved them: a version ID, `current`, or nothing before the first version. */
const sides = computed(() => {
	const result = diff.result.value
	if (!result) return undefined
	return { before: result.from?.id, after: result.to.id }
})
const viewDiff = computed(() => {
	const change = diff.result.value?.changes?.find(item => item.kind === 'view' && item.key === props.viewId)
	return change?.diff.type === 'view' ? change.diff as ViewDiff : undefined
})

// ---------------------------------------------------------------------------------------------
// Each side's manifest, View and Locales
// ---------------------------------------------------------------------------------------------

type SideData =
	| Readonly<{ status: 'loading' }>
	| Readonly<{ status: 'none' }>
	| Readonly<{ status: 'missing'; record?: VersionRecord }>
	| Readonly<{ status: 'error'; message: string }>
	| Readonly<{ status: 'ready'; record?: VersionRecord; side: FrameSide }>

const versionData = shallowRef(new Map<string, SideData>())

/** Loads a side once; an `error` is kept only for its placeholder, whose Retry loads it again. */
async function loadVersion(id: string, retry = false): Promise<void> {
	const known = versionData.value.get(id)
	if (known && !(retry && known.status === 'error')) return
	versionData.value = new Map(versionData.value).set(id, { status: 'loading' })
	let data: SideData
	try {
		const [record, manifest, read] = await Promise.all([
			readVersionRecord(id),
			uiux.readVersionResource<WorkspaceManifest>(id, 'workspace', 'workspace'),
			uiux.readVersionResource<ViewResource>(id, 'view', props.viewId),
		])
		data = read
			? { status: 'ready', record: record.version, side: { ...(manifest ? { manifest: manifest.resource } : {}), view: read.resource, locales: record.version.resources.filter(item => item.kind === 'locale').map(item => item.key) } }
			: { status: 'missing', record: record.version }
	}
	catch (cause) {
		data = { status: 'error', message: describeFetchError(cause, t('history.canvas.loadFailed')).message }
	}
	versionData.value = new Map(versionData.value).set(id, data)
}

watch(sides, (value) => {
	for (const id of [value?.before, value?.after]) if (id && id !== CURRENT_COMPARE) void loadVersion(id)
}, { immediate: true })

const currentSide = computed<SideData>(() => {
	if (selectedView.value?.key !== props.viewId) return { status: 'loading' }
	return {
		status: 'ready',
		side: { ...(workspace.value ? { manifest: workspace.value.resource } : {}), view: selectedView.value.resource, locales: contextOptions.value.locales.available },
	}
})

function sideData(id: string | undefined): SideData {
	if (!sides.value) return { status: 'loading' }
	if (id === undefined) return { status: 'none' }
	if (id === CURRENT_COMPARE) return currentSide.value
	return versionData.value.get(id) ?? { status: 'loading' }
}

/** The canvas's current selection (Rule 01a11a5e-1331-7e9e-a98d-5ff9b265b0e8). */
const canvasSelection = computed<FrameContextSelection>(() => {
	const options = contextOptions.value
	const dims = options.viewports.selectedDimensions
	return {
		...(options.variants.selected ? { variant: options.variants.selected } : {}),
		locale: options.locales.selected,
		viewportId: options.viewports.selectedId,
		width: dims.width,
		height: dims.height,
		themeId: options.themes.selected,
	}
})

const contextSummary = computed(() => ({
	variant: canvasSelection.value.variant || t('ctx.base'),
	locale: canvasSelection.value.locale,
	viewport: canvasSelection.value.viewportId,
	theme: canvasSelection.value.themeId,
}))

type Frame = Readonly<{
	side: 'before' | 'after'
	id?: string
	data: SideData
	title: string
	resolved?: FrameContext
}>

function sideTitle(id: string | undefined, data: SideData): string {
	if (id === undefined) return t('history.compare.nothing')
	if (id === CURRENT_COMPARE) return t('history.compare.current')
	const record = 'record' in data ? data.record : undefined
	return record ? labels.versionTitle(record) : t('history.canvas.version')
}

const frames = computed<readonly [Frame, Frame] | undefined>(() => {
	if (!sides.value) return undefined
	const build = (side: 'before' | 'after', id: string | undefined): Frame => {
		const data = sideData(id)
		return {
			side,
			...(id && id !== CURRENT_COMPARE ? { id } : {}),
			data,
			title: sideTitle(id, data),
			...(data.status === 'ready' ? { resolved: resolveFrameContext(canvasSelection.value, data.side) } : {}),
		}
	}
	return [build('before', sides.value.before), build('after', sides.value.after)]
})

const notices = computed(() => (frames.value ?? []).flatMap(frame => (frame.resolved?.notices ?? []).map(notice => ({ side: frame.side, notice }))))

function noticeText(side: 'before' | 'after', notice: FrameContextNotice): string {
	const sideLabel = t(`history.canvas.${side}`)
	if (notice.dimension === 'variant') return t('history.canvas.notice.variant', { side: sideLabel, requested: notice.requested })
	return t(`history.canvas.notice.${notice.dimension}`, { side: sideLabel, requested: notice.requested, used: notice.used })
}

// ---------------------------------------------------------------------------------------------
// Change highlighting
// ---------------------------------------------------------------------------------------------

const highlights = computed(() => mode.value === 'highlight'
	? canvasHighlights(viewDiff.value, canvasSelection.value.variant)
	: { before: [], after: [], unmatched: false })
const overCap = ref<Record<'before' | 'after', number>>({ before: 0, after: 0 })
const overCapTotal = computed(() => overCap.value.before + overCap.value.after)
const LEGEND: readonly Readonly<{ kind: HighlightKind; class: string }>[] = [
	{ kind: 'added', class: 'border-success border-solid' },
	{ kind: 'modified', class: 'border-warning border-dashed' },
	{ kind: 'moved', class: 'border-info border-dotted' },
	{ kind: 'removed', class: 'border-error border-solid' },
]

// ---------------------------------------------------------------------------------------------
// One stage, one scale
// ---------------------------------------------------------------------------------------------

const stage = ref<HTMLDivElement>()
const stageSize = ref({ width: 0, height: 0 })
const insets = computed(() => canvasInsets(isDesktop.value ? CANVAS_GUTTER_DESKTOP : CANVAS_GUTTER_COMPACT))
const frameSizes = computed<readonly [{ width: number; height: number }, { width: number; height: number }]>(() => {
	const size = (frame: Frame | undefined, other: Frame | undefined) => {
		const context = frame?.resolved?.context ?? other?.resolved?.context ?? canvasSelection.value
		return { width: context.width, height: context.height }
	}
	return [size(frames.value?.[0], frames.value?.[1]), size(frames.value?.[1], frames.value?.[0])]
})
const zoomMode = ref<ZoomMode>('fit')
const fit = computed(() => fitPairScale(frameSizes.value, stageSize.value, insets.value, MIN_ZOOM))
const scale = computed(() => zoomMode.value === 'fit' ? fit.value : zoomMode.value)
const layout = computed(() => pairLayout(frameSizes.value, scale.value, stageSize.value, insets.value))

function setZoom(next: ZoomMode): void {
	zoomMode.value = next === 'fit' ? 'fit' : clampZoom(next)
}

let resizeObserver: ResizeObserver | undefined
function measure(): void {
	if (stage.value) stageSize.value = { width: stage.value.clientWidth, height: stage.value.clientHeight }
}
/** Ctrl/⌘ + wheel over the stage's gutter zooms both frames; wheel over a frame belongs to that frame. */
function onWheel(event: WheelEvent): void {
	if (!event.ctrlKey && !event.metaKey) return
	event.preventDefault()
	setZoom(wheelZoom(scale.value, event.deltaY))
}
onMounted(() => {
	measure()
	if (!stage.value) return
	resizeObserver = new ResizeObserver(measure)
	resizeObserver.observe(stage.value)
	stage.value.addEventListener('wheel', onWheel, { passive: false })
})
onBeforeUnmount(() => {
	resizeObserver?.disconnect()
	stage.value?.removeEventListener('wheel', onWheel)
})

/** A frame is a new document (and a new frame session) whenever what it renders changes. */
function frameKey(frame: Frame): string {
	return `${frame.side}|${frame.id ?? 'current'}|${props.viewId}|${JSON.stringify(frame.resolved?.context ?? {})}`
}

const viewName = computed(() => selectedView.value?.resource.name ?? '')

// ---------------------------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------------------------

/** This page with another `canvas` value, or none: back to the live canvas and the change list. */
function canvasTo(next: HistoryCanvasMode | undefined) {
	const query: LocationQueryRaw = { ...route.query }
	if (next) query.canvas = next
	else delete query.canvas
	return { path: route.path, query }
}
</script>

<template>
  <section
    class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
    :aria-label="t('history.canvas.title')"
    data-version-canvas
    :data-canvas-mode="mode"
    :data-from="sides?.before ?? (sides ? 'none' : undefined)"
    :data-to="sides?.after"
  >
    <UDashboardToolbar
      :ui="{
        root: 'min-h-10 h-10 gap-1 bg-default px-2 sm:px-2',
        left: 'min-w-0 flex-1 gap-1',
        right: 'shrink-0 gap-0.5',
      }"
    >
      <template #left>
        <div
          ref="contextSlot"
          class="flex min-w-0 flex-1 items-center"
        >
          <RenderContextControls v-if="isDesktop && !contextBarCompact" />
          <UPopover
            v-else
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
                <RenderContextControls layout="stacked" />
              </div>
            </template>
          </UPopover>
        </div>
      </template>
      <template #right>
        <nav
          class="flex items-center gap-0.5"
          :aria-label="t('history.canvas.label')"
        >
          <UButton
            v-for="option in (['side', 'highlight'] as const)"
            :key="option"
            :to="canvasTo(option)"
            size="sm"
            color="neutral"
            :variant="mode === option ? 'soft' : 'ghost'"
            :icon="option === 'side' ? 'i-lucide-columns-2' : 'i-lucide-scan-search'"
            :aria-current="mode === option ? 'true' : undefined"
            :data-canvas-toolbar-mode="option"
            :label="isDesktop ? t(`history.canvas.mode.${option}`) : undefined"
            :aria-label="t(`history.canvas.mode.${option}`)"
          />
        </nav>
        <USeparator
          orientation="vertical"
          class="mx-1 h-4"
        />
        <CanvasZoomControls
          :scale="scale"
          :fitted="zoomMode === 'fit'"
          @zoom-in="setZoom(stepZoom(scale, 1))"
          @zoom-out="setZoom(stepZoom(scale, -1))"
          @fit="setZoom('fit')"
          @zoom-to="value => setZoom(value)"
        />
        <UTooltip :text="t('history.canvas.close')">
          <UButton
            :to="canvasTo(undefined)"
            size="sm"
            color="neutral"
            variant="ghost"
            icon="i-lucide-x"
            :aria-label="t('history.canvas.close')"
            data-canvas-close
          />
        </UTooltip>
        <slot name="actions" />
      </template>
    </UDashboardToolbar>

    <div class="space-y-px border-b border-default">
      <UAlert
        color="warning"
        variant="subtle"
        icon="i-lucide-puzzle"
        :title="t('history.canvas.caveatTitle')"
        :description="t('history.canvas.caveat')"
        class="rounded-none"
        :ui="{ title: 'text-xs', description: 'text-xs' }"
        data-adapters-caveat
      />
      <UAlert
        v-if="diff.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="diff.error.value.message"
        class="rounded-none"
        :ui="{ title: 'text-xs' }"
        :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void diff.load() } }]"
      />
      <UAlert
        v-if="notices.length"
        color="info"
        variant="subtle"
        icon="i-lucide-info"
        class="rounded-none"
        :ui="{ description: 'text-xs' }"
        data-frame-notices
      >
        <template #description>
          <ul class="space-y-0.5">
            <li
              v-for="item in notices"
              :key="`${item.side}:${item.notice.dimension}`"
              :data-frame-notice="`${item.side}:${item.notice.dimension}`"
            >
              {{ noticeText(item.side, item.notice) }}
            </li>
          </ul>
        </template>
      </UAlert>
      <div
        v-if="mode === 'highlight'"
        class="flex flex-wrap items-center gap-x-4 gap-y-1 bg-default px-3 py-1.5 text-xs text-muted"
        data-highlight-legend
      >
        <span
          v-for="item in LEGEND"
          :key="item.kind"
          class="flex items-center gap-1.5"
        >
          <span
            class="size-3 rounded-xs border-2"
            :class="item.class"
            aria-hidden="true"
          />
          {{ t(`history.canvas.legend.${item.kind}`) }}
        </span>
        <span
          v-if="highlights.unmatched"
          data-highlight-unmatched
        >{{ t('history.canvas.unmatched') }}</span>
        <span
          v-if="overCapTotal"
          data-highlight-over-cap
        >{{ t('history.canvas.overCap', overCapTotal) }}</span>
      </div>
    </div>

    <div class="relative min-h-0 flex-1">
      <div
        ref="stage"
        class="absolute inset-0 touch-pan-x touch-pan-y overflow-auto overscroll-contain"
        :class="scale >= 0.5 ? 'canvas-dots' : ''"
        tabindex="0"
        role="region"
        :aria-label="t('history.canvas.stageLabel')"
        data-version-stage
      >
        <div
          class="relative"
          :style="{ width: `${layout.content.width}px`, height: `${layout.content.height}px` }"
        >
          <template v-if="frames">
            <div
              v-for="(frame, index) in frames"
              :key="frame.side"
              class="absolute"
              :style="{
                left: `${layout.offsets[index]!.x}px`,
                top: `${layout.offsets[index]!.y - FRAME_LABEL_PX}px`,
                width: `${frameSizes[index]!.width * scale}px`,
              }"
              :data-frame-slot="frame.side"
            >
              <p
                class="flex min-w-0 items-center gap-1.5 truncate text-xs"
                :style="{ height: `${FRAME_LABEL_PX}px` }"
                data-frame-label
              >
                <span class="font-semibold text-highlighted">{{ t(`history.canvas.${frame.side}`) }}</span>
                <span class="truncate text-muted">{{ frame.title }}</span>
              </p>
              <div
                class="relative"
                :style="{ width: `${frameSizes[index]!.width * scale}px`, height: `${frameSizes[index]!.height * scale}px` }"
              >
                <VersionFrame
                  v-if="frame.data.status === 'ready' && frame.resolved"
                  :key="frameKey(frame)"
                  :side="frame.side"
                  :version-id="frame.id"
                  :view-id="viewId"
                  :context="frame.resolved.context"
                  :scale="scale"
                  :highlights="highlights[frame.side]"
                  :title="t('history.canvas.frameTitle', { side: t(`history.canvas.${frame.side}`), version: frame.title, name: viewName })"
                  @over-cap="count => { overCap = { ...overCap, [frame.side]: count } }"
                />
                <div
                  v-else
                  class="absolute inset-0 flex items-center justify-center rounded-xs border border-dashed border-default bg-default/60 p-4 text-center"
                  :data-frame-placeholder="frame.data.status"
                >
                  <USkeleton
                    v-if="frame.data.status === 'loading'"
                    class="absolute inset-0"
                    :aria-label="t('common.loading')"
                  />
                  <div
                    v-else
                    class="flex max-w-xs flex-col items-center gap-2"
                  >
                    <p class="text-sm text-muted">
                      {{ frame.data.status === 'none' ? t('history.canvas.nothingBefore') : frame.data.status === 'missing' ? t('history.canvas.viewMissing') : frame.data.status === 'error' ? frame.data.message : '' }}
                    </p>
                    <UButton
                      v-if="frame.data.status === 'error' && frame.id"
                      size="xs"
                      color="neutral"
                      variant="outline"
                      icon="i-lucide-rotate-cw"
                      :label="t('common.retry')"
                      data-frame-retry
                      @click="loadVersion(frame.id, true)"
                    />
                  </div>
                </div>
              </div>
            </div>
          </template>
          <USkeleton
            v-else
            class="absolute inset-8"
            :aria-label="t('common.loading')"
          />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* The canvas's only texture (DESIGN.md "Canvas"), as on the live canvas. */
.canvas-dots {
  background-image: radial-gradient(var(--wb-canvas-dot) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: 8px 8px;
  background-attachment: local;
}
</style>
