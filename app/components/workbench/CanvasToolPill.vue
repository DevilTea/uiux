<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'

/**
 * The floating canvas tool palette (DESIGN.md "Canvas tool palette"; brief b, section 10):
 * a toolbar with roving tabindex whose active tool is `aria-pressed`. Comment keeps the existing
 * comment mode until R6 routes it through the targeting state.
 */
export type CanvasToolId = 'select' | 'comment' | 'interact'

const props = defineProps<{
	active: CanvasToolId
	/** Read-only publications and phones offer Select and Interact only. */
	showComment: boolean
	/** Why the tools are unavailable (no live preview yet); undefined when they work. */
	disabledReason?: string
	/** Comment pins hidden (`true`) or shown; undefined where the canvas has no pins. */
	pinsHidden?: boolean
}>()
const emit = defineEmits<{ (e: 'select', tool: CanvasToolId): void, (e: 'togglePins'): void }>()

const { t } = useI18n()

const tools = computed(() => [
	{ id: 'select' as const, icon: 'i-lucide-mouse-pointer-2', label: t('tool.select'), kbd: 'V' },
	...(props.showComment ? [{ id: 'comment' as const, icon: 'i-lucide-message-circle-plus', label: t('tool.comment'), kbd: 'C' }] : []),
	{ id: 'interact' as const, icon: 'i-lucide-hand', label: t('tool.interact'), kbd: 'I' },
])

/** Roving tabindex: one tab stop, arrows move between tools. */
const focusIndex = ref(-1)
const buttons = ref<{ $el: HTMLElement }[]>([])
const activeIndex = computed(() => Math.max(0, tools.value.findIndex(tool => tool.id === props.active)))

function tabIndexFor(index: number): number {
	return index === (focusIndex.value >= 0 ? focusIndex.value : activeIndex.value) ? 0 : -1
}

async function move(direction: 1 | -1 | 'first' | 'last'): Promise<void> {
	const count = tools.value.length
	const current = focusIndex.value >= 0 ? focusIndex.value : activeIndex.value
	focusIndex.value = direction === 'first' ? 0 : direction === 'last' ? count - 1 : (current + direction + count) % count
	await nextTick()
	buttons.value[focusIndex.value]?.$el.focus()
}

function toolClass(id: CanvasToolId): string {
	if (props.active !== id) return 'text-muted'
	return id === 'comment'
		? 'bg-comment-subtle text-annotation ring-1 ring-inset ring-annotation/35 hover:bg-comment-subtle'
		: 'bg-primary text-inverted hover:bg-primary'
}
</script>

<template>
  <!-- One pill: the tool toolbar (one active tool), then the pins toggle as its own control (Shift C). -->
  <div class="inline-flex items-center gap-0.5 rounded-[10px] bg-default p-1 shadow-overlay">
    <div
      role="toolbar"
      :aria-label="t('tool.label')"
      aria-orientation="horizontal"
      class="inline-flex items-center gap-0.5"
      @keydown.right.prevent="move(1)"
      @keydown.left.prevent="move(-1)"
      @keydown.home.prevent="move('first')"
      @keydown.end.prevent="move('last')"
    >
      <UTooltip
        v-for="(tool, index) in tools"
        :key="tool.id"
        :text="disabledReason ?? tool.label"
        :kbds="disabledReason ? undefined : [tool.kbd]"
      >
        <UButton
          ref="buttons"
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="tool.icon"
          :aria-pressed="active === tool.id"
          :aria-keyshortcuts="tool.kbd"
          :disabled="!!disabledReason"
          :tabindex="tabIndexFor(index)"
          :class="toolClass(tool.id)"
          :ui="{ base: 'gap-1.5 px-2', label: 'max-sm:sr-only' }"
          @focus="focusIndex = index"
          @blur="focusIndex = -1"
          @click="emit('select', tool.id)"
        >
          {{ tool.label }}
          <UKbd
            :value="tool.kbd"
            variant="outline"
            class="max-sm:hidden bg-transparent text-current ring-current/35"
          />
        </UButton>
      </UTooltip>
    </div>
    <template v-if="pinsHidden !== undefined">
      <USeparator
        orientation="vertical"
        class="mx-0.5 h-5"
      />
      <UTooltip
        :text="pinsHidden ? t('pins.show') : t('pins.hide')"
        :kbds="['shift', 'C']"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          :icon="pinsHidden ? 'i-lucide-eye-off' : 'i-lucide-eye'"
          :aria-label="t('pins.toggle')"
          :aria-pressed="!pinsHidden"
          aria-keyshortcuts="Shift+C"
          class="text-muted"
          data-pins-toggle
          @click="emit('togglePins')"
        />
      </UTooltip>
    </template>
  </div>
</template>
