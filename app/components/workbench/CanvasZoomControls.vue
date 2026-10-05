<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { MAX_ZOOM, MIN_ZOOM, ZOOM_MENU_STEPS } from '../../utils/canvas-zoom'

/**
 * Zoom controls at the end of the canvas bar (brief b, section 6): −, the percentage menu
 * (Fit, 50, 75, 100, 150, 200), + and Fit. Zoom scales only the outer frame.
 */
const props = defineProps<{ scale: number; fitted: boolean; disabled?: boolean }>()
const emit = defineEmits<{
	(e: 'zoomIn' | 'zoomOut' | 'fit'): void
	(e: 'zoomTo', scale: number): void
}>()

const { t } = useI18n()
const percent = computed(() => Math.round(props.scale * 100))

const items = computed<DropdownMenuItem[][]>(() => [
	[{ label: t('zoom.fit'), icon: 'i-lucide-scan', kbds: ['shift', '1'], type: 'checkbox', checked: props.fitted, onSelect: () => emit('fit') }],
	ZOOM_MENU_STEPS.map(step => ({
		label: t('zoom.percent', { percent: Math.round(step * 100) }),
		type: 'checkbox' as const,
		checked: !props.fitted && Math.abs(props.scale - step) < 0.001,
		...(step === 1 ? { kbds: ['shift', '0'] } : {}),
		onSelect: () => emit('zoomTo', step),
	})),
])
</script>

<template>
  <div
    role="group"
    :aria-label="t('zoom.label')"
    class="flex items-center gap-0.5"
    data-zoom-controls
  >
    <UTooltip
      :text="t('zoom.out')"
      :kbds="['meta', '-']"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-zoom-out"
        class="max-sm:hidden"
        :aria-label="t('zoom.out')"
        :disabled="disabled || scale <= MIN_ZOOM + 0.001"
        @click="emit('zoomOut')"
      />
    </UTooltip>
    <UDropdownMenu
      :items="items"
      :content="{ align: 'end' }"
      :ui="{ content: 'min-w-40' }"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        trailing-icon="i-lucide-chevron-down"
        class="min-w-16 justify-center font-mono text-xs tabular-nums"
        :aria-label="t('zoom.menuLabel', { percent })"
        :disabled="disabled"
        data-zoom-percent
      >
        {{ t('zoom.percent', { percent }) }}
      </UButton>
    </UDropdownMenu>
    <UTooltip
      :text="t('zoom.in')"
      :kbds="['meta', '=']"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-zoom-in"
        class="max-sm:hidden"
        :aria-label="t('zoom.in')"
        :disabled="disabled || scale >= MAX_ZOOM - 0.001"
        @click="emit('zoomIn')"
      />
    </UTooltip>
    <UTooltip
      :text="t('zoom.fitHint')"
      :kbds="['shift', '1']"
    >
      <UButton
        color="neutral"
        variant="ghost"
        size="sm"
        icon="i-lucide-scan"
        :aria-pressed="fitted"
        :disabled="disabled"
        class="max-lg:px-1.5"
        :ui="{ label: 'max-lg:sr-only' }"
        data-zoom-fit
        @click="emit('fit')"
      >
        {{ t('zoom.fit') }}
      </UButton>
    </UTooltip>
  </div>
</template>
