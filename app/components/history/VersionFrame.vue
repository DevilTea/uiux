<script setup lang="ts">
import { computed, watch } from 'vue'
import { useI18n } from '#imports'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useVersionFrame } from '../../composables/useVersionFrame'
import type { FrameContextSelection } from '../../../src/preview/version-frame-context'
import type { HighlightKind, WidgetHighlight } from '../../utils/version-canvas'

/**
 * One frame of the canvas before/after comparison (issue #132, B9): a Preview document of one side,
 * a historical version in Preview's read-only version mode or the current state, at the canonical
 * viewport size and scaled only on the outside, like the live canvas frame. Changed Widgets are
 * outlined over it from runtime-reported geometry (Rule 01a11a5e-12dc-793c-8f66-2d58c032fa19); no
 * comment pin is ever drawn over it (Rule 01a11a5e-13d6-7a24-92e9-9a5de720ca27). The parent mounts a
 * new frame for a new render context, so each frame is one document and one session.
 */
const props = defineProps<{
	side: 'before' | 'after'
	/** The version to render, or none for the current state. */
	versionId?: string
	viewId: string
	context: FrameContextSelection
	scale: number
	highlights: readonly WidgetHighlight[]
	/** The accessible name of the frame's document. */
	title: string
}>()

/** How many outlined Widgets get no geometry stream because of the tracking cap. */
const emit = defineEmits<{ (e: 'overCap', count: number): void }>()

const { t } = useI18n()
const uiux = useUiuxClient()
const session = useVersionFrame({
	viewId: props.viewId,
	...(props.context.variant ? { variantId: props.context.variant } : {}),
	widgets: () => props.highlights.map(highlight => highlight.widgetId),
})
watch(() => session.overCap.value.length, count => emit('overCap', count), { immediate: true })

const src = computed(() => {
	const params = new URLSearchParams({
		session: session.previewSessionId,
		generation: session.runtimeGenerationId,
		viewId: props.viewId,
		locale: props.context.locale,
		viewportId: props.context.viewportId,
		viewportWidth: String(props.context.width),
		viewportHeight: String(props.context.height),
		themeId: props.context.themeId,
	})
	if (props.context.variant) params.set('variant', props.context.variant)
	if (props.versionId) params.set('version', props.versionId)
	return uiux.routeUrl(`preview?${params.toString()}`)
})

const STYLE: Readonly<Record<HighlightKind, Readonly<{ color: string; line: string }>>> = {
	added: { color: 'var(--ui-success)', line: 'solid' },
	modified: { color: 'var(--ui-warning)', line: 'dashed' },
	moved: { color: 'var(--ui-info)', line: 'dotted' },
	removed: { color: 'var(--ui-error)', line: 'solid' },
}

/** The outlines with a current, visible report, in the frame's own CSS px (the frame scales them). */
const outlines = computed(() => {
	void session.geometryVersion.value
	const width = 2 / Math.max(props.scale, 0.05)
	return props.highlights.flatMap((highlight) => {
		const report = session.report(highlight.widgetId)
		if (!report || report.rect.width === 0 || report.rect.height === 0 || !report.regions.length) return []
		const style = STYLE[highlight.kinds[0]!]
		return [{
			widgetId: highlight.widgetId,
			kinds: highlight.kinds.join(' '),
			label: highlight.kinds.map(kind => t(`history.canvas.legend.${kind}`)).join(' · '),
			style: {
				left: `${report.rect.x - width}px`,
				top: `${report.rect.y - width}px`,
				width: `${report.rect.width + width * 2}px`,
				height: `${report.rect.height + width * 2}px`,
				borderWidth: `${width}px`,
				borderStyle: style.line,
				borderColor: style.color,
			},
		}]
	})
})
</script>

<template>
  <div
    class="absolute top-0 left-0 overflow-hidden rounded-xs bg-frame shadow-frame"
    :data-version-frame="side"
    :data-frame-version="versionId ?? 'current'"
    :data-frame-phase="session.phase.value"
    :data-frame-context="`${context.variant ?? ''}|${context.locale}|${context.viewportId}|${context.themeId}`"
    :style="{
      width: `${context.width}px`,
      height: `${context.height}px`,
      transform: `scale(${scale})`,
      transformOrigin: '0 0',
    }"
  >
    <iframe
      :ref="(element) => { session.iframe.value = (element as HTMLIFrameElement | null) ?? undefined }"
      :src="src"
      class="block border-0 bg-transparent"
      :style="{ width: `${context.width}px`, height: `${context.height}px` }"
      :title="title"
    />
    <div
      class="pointer-events-none absolute inset-0"
      aria-hidden="true"
    >
      <div
        v-for="outline in outlines"
        :key="outline.widgetId"
        class="absolute rounded-xs"
        :style="outline.style"
        :title="outline.label"
        :data-highlight-widget="outline.widgetId"
        :data-highlight="outline.kinds"
      />
    </div>
  </div>
</template>
