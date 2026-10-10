<script setup lang="ts">
import { computed } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useI18n } from '#imports'
import { useVersionCanvasAccess } from '../../composables/useVersionCanvasAccess'
import type { HistoryAddress, HistoryCanvasMode } from '../../utils/version-history'

/**
 * The View diff's canvas choice (Clause 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41): the change list only
 * (no `canvas`, the default by owner ruling
 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18834723), side by side
 * (`canvas=side`) or change highlighting (`canvas=highlight`). Each choice is a link, so the address
 * holds it. Offered on desktop and tablet only (Rule 01a11a5e-1ba5-765e-966f-a681def5f472).
 */
const props = defineProps<{
	address: HistoryAddress
	linkFor: (address: HistoryAddress) => RouteLocationRaw
}>()

const { t } = useI18n()
const access = useVersionCanvasAccess()

const modes = computed(() => ([undefined, 'side', 'highlight'] as const).map((mode: HistoryCanvasMode | undefined) => {
	const next: Record<string, unknown> = { ...props.address }
	if (mode) next.canvas = mode
	else delete next.canvas
	return {
		value: mode ?? 'list',
		label: t(`history.canvas.mode.${mode ?? 'list'}`),
		icon: mode === 'side' ? 'i-lucide-columns-2' : mode === 'highlight' ? 'i-lucide-scan-search' : 'i-lucide-list',
		to: props.linkFor(next as HistoryAddress),
		current: props.address.canvas === mode,
	}
}))
</script>

<template>
  <nav
    v-if="access.offered.value"
    class="flex flex-wrap items-center gap-1.5 pt-1"
    :aria-label="t('history.canvas.label')"
    data-canvas-modes
  >
    <span class="text-xs text-muted">{{ t('history.canvas.label') }}</span>
    <UButton
      v-for="mode in modes"
      :key="mode.value"
      :to="mode.to"
      size="xs"
      color="neutral"
      :variant="mode.current ? 'solid' : 'outline'"
      :icon="mode.icon"
      :aria-current="mode.current ? 'true' : undefined"
      :data-canvas-mode="mode.value"
      :label="mode.label"
    />
  </nav>
</template>
