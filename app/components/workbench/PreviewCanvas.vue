<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'

/**
 * The preview canvas: a real iframe at the canonical RenderContext viewport size,
 * scaled only by its outer presentation frame. Widget hit-testing happens inside the
 * iframe runtime, which posts `select` back over the existing targeting channel.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, contextOptions, loading, isReadOnly, preview } = workbench

const PREVIEW_CANVAS_PADDING_PX = 48
const PREVIEW_FRAME_HEADER_PX = 28
const PREVIEW_FRAME_BORDER_PX = 2

const canvasArea = ref<HTMLDivElement>()
const canvasSize = ref({ width: 0, height: 0 })
let resizeObserver: ResizeObserver | undefined

const dimensions = computed(() => contextOptions.value.viewports.selectedDimensions)

const logicalFrameSize = computed(() => ({
	width: dimensions.value.width + PREVIEW_FRAME_BORDER_PX,
	height: dimensions.value.height + PREVIEW_FRAME_HEADER_PX + PREVIEW_FRAME_BORDER_PX,
}))

const scale = computed(() => {
	const logical = logicalFrameSize.value
	const availableWidth = Math.max(0, canvasSize.value.width - PREVIEW_CANVAS_PADDING_PX)
	const availableHeight = Math.max(0, canvasSize.value.height - PREVIEW_CANVAS_PADDING_PX)
	if (!availableWidth || !availableHeight) return 1
	return Math.max(0.1, Math.min(1, availableWidth / logical.width, availableHeight / logical.height))
})

const scalePercent = computed(() => Math.round(scale.value * 100))

function measure(): void {
	const canvas = canvasArea.value
	if (!canvas) return
	canvasSize.value = { width: canvas.clientWidth, height: canvas.clientHeight }
}

onMounted(() => {
	measure()
	if (canvasArea.value) {
		resizeObserver = new ResizeObserver(measure)
		resizeObserver.observe(canvasArea.value)
	}
})

onUnmounted(() => {
	resizeObserver?.disconnect()
	resizeObserver = undefined
})
</script>

<template>
  <section
    class="relative flex min-h-0 min-w-0 flex-1 flex-col bg-canvas"
    :aria-label="t('workbench.canvas.label')"
  >
    <div class="flex h-9 shrink-0 items-center justify-between border-b border-default bg-default px-4 text-xs">
      <div class="flex items-center gap-2">
        <h2 class="font-medium text-muted">
          {{ t('workbench.canvas.title') }}
        </h2>
        <USeparator
          orientation="vertical"
          class="h-4"
        />
        <span class="font-mono text-toned">{{ t('workbench.canvas.dimensions', { width: dimensions.width, height: dimensions.height }) }}</span>
      </div>

      <div class="flex items-center gap-3">
        <UTooltip
          v-if="!isReadOnly"
          :text="selectedView ? t('workbench.canvas.commentHint') : t('workbench.canvas.commentDisabledHint')"
        >
          <UButton
            :color="preview.isCommentMode.value ? 'annotation' : 'neutral'"
            :variant="preview.isCommentMode.value ? 'solid' : 'outline'"
            size="xs"
            :icon="preview.isCommentMode.value ? 'i-lucide-crosshair' : 'i-lucide-message-square-plus'"
            :disabled="!selectedView"
            :aria-pressed="preview.isCommentMode.value"
            @click="preview.toggleCommentMode()"
          >
            {{ preview.isCommentMode.value ? t('workbench.canvas.commentActive') : t('workbench.canvas.comment') }}
            <UKbd
              v-if="preview.isCommentMode.value"
              value="Esc"
              size="sm"
              class="ms-1"
            />
          </UButton>
        </UTooltip>
        <USeparator
          orientation="vertical"
          class="h-4"
        />
        <UTooltip :text="t('workbench.canvas.scaleHint')">
          <UBadge
            color="neutral"
            variant="soft"
            size="sm"
            class="font-mono"
            tabindex="0"
          >
            {{ t('workbench.canvas.scale', { percent: scalePercent }) }}
          </UBadge>
        </UTooltip>
      </div>
    </div>

    <div
      ref="canvasArea"
      class="relative flex flex-1 items-center justify-center overflow-auto bg-[radial-gradient(var(--color-canvas-dot)_1px,transparent_1px)] [background-size:16px_16px] p-6"
    >
      <!-- The iframe keeps the canonical viewport size. Only this outer presentation layer scales. -->
      <div
        v-if="selectedView"
        class="relative shrink-0"
        :style="{
          width: `${logicalFrameSize.width * scale}px`,
          height: `${logicalFrameSize.height * scale}px`,
        }"
      >
        <div
          class="absolute top-0 left-0 flex flex-col overflow-hidden rounded-xs bg-frame shadow-frame"
          :class="preview.isCommentMode.value ? 'ring-2 ring-comment' : ''"
          :style="{
            width: `${logicalFrameSize.width}px`,
            height: `${logicalFrameSize.height}px`,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
          }"
        >
          <div class="flex h-7 shrink-0 items-center justify-between border-b border-default bg-muted px-3 text-xs text-muted">
            <div class="flex items-center gap-1.5">
              <span class="size-2 rounded-full bg-accented" />
              <span class="size-2 rounded-full bg-accented" />
              <span class="size-2 rounded-full bg-accented" />
              <span class="ms-2 font-mono text-toned">{{ selectedView.resource.name }}</span>
            </div>
            <span class="font-mono text-xs text-dimmed">{{ contextOptions.locales.selected }} · {{ contextOptions.themes.selected }} · {{ contextOptions.viewports.selectedId }}</span>
          </div>

          <!-- Real Preview Iframe Boundary: logical size remains identical to RenderContext.viewport. -->
          <iframe
            :ref="(el) => { preview.previewIframe.value = (el as HTMLIFrameElement | null) ?? undefined }"
            :src="preview.previewIframeSrc.value"
            class="block shrink-0 border-0 bg-transparent"
            :style="{
              width: `${dimensions.width}px`,
              height: `${dimensions.height}px`,
            }"
            :title="t('workbench.canvas.iframeTitle', { name: selectedView.resource.name })"
          />
        </div>
      </div>

      <UEmpty
        v-else-if="!loading"
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
    </div>
  </section>
</template>
