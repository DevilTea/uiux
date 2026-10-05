<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useCanvasComments } from '../../../composables/useCanvasComments'
import type { PinEdgeSide } from '../../../../src/preview/pin-visibility'
import CommentPin from './CommentPin.vue'

/**
 * A count cluster (pins within 24 px, decision 7) or an edge indicator (pins whose Widget is
 * scrolled out of the frame or the stage, aggregated per side). Both open a menu of their threads;
 * picking one opens its bubble and focuses its pin. A one-thread edge indicator opens the thread
 * directly. Nothing here scrolls the iframe (decision 7: no reveal message exists).
 *
 * Props are primitives (`ids` is space-joined), so the pin layer can re-render without touching
 * menus whose threads did not change.
 */
const props = defineProps<{
	kind: 'cluster' | 'edge'
	ids: string
	side?: PinEdgeSide
	dim?: boolean
}>()

const { t } = useI18n()
const comments = useCanvasComments()!

const threadIds = computed(() => props.ids.split(' ').filter(Boolean))
const count = computed(() => threadIds.value.length)
const label = computed(() => props.kind === 'cluster'
	? t('comments.clusterLabel', count.value)
	: t(`pins.edge.${props.side ?? 'bottom'}`, count.value))

/** A pick moves focus to the picked thread's pin; only a dismissal returns it to the trigger. */
let picked = false
function openAndFocus(threadId: string): void {
	if (!comments.open(threadId)) return
	picked = true
	// After the menu's own focus restoration (it runs in a timeout when the menu unmounts).
	void nextTick(() => setTimeout(() => {
		const escaped = CSS.escape(threadId)
		const target = document.querySelector<HTMLElement>(`[data-comment-pins] [data-pin-thread="${escaped}"]`)
			?? document.querySelector<HTMLElement>(`[data-comment-pins] [data-edge-threads~="${escaped}"]`)
		target?.focus({ preventScroll: true })
	}))
}

/** Items are built only while the menu is open, so a closed menu ignores membership changes. */
const open = ref(false)
const NO_ITEMS: DropdownMenuItem[][] = []
const items = computed<DropdownMenuItem[][]>(() => !open.value ? NO_ITEMS : [
	[{ type: 'label', label: label.value }],
	threadIds.value.map((id) => {
		const meta = comments.pinMeta.value.get(id)
		return {
			label: meta?.title ?? id,
			description: meta?.detail,
			...(meta?.agent ? { icon: 'i-lucide-bot' } : { avatar: { text: meta?.initials ?? '', alt: meta?.name } }),
			onSelect: () => openAndFocus(id),
		}
	}),
])

const EDGE_ICON = { top: 'i-lucide-chevron-up', right: 'i-lucide-chevron-right', bottom: 'i-lucide-chevron-down', left: 'i-lucide-chevron-left' } as const
const EDGE_OFFSET = { top: 'translate(-50%, 0)', bottom: 'translate(-50%, -100%)', left: 'translate(0, -50%)', right: 'translate(-100%, -50%)' } as const
/** Menus open into the canvas, away from the edge they sit on. */
const EDGE_MENU_SIDE = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' } as const
function onCloseAutoFocus(event: Event): void {
	if (picked) event.preventDefault()
	picked = false
}
const content = computed(() => props.kind === 'cluster'
	? { align: 'start' as const, side: 'right' as const, sideOffset: 6, collisionPadding: 12, onCloseAutoFocus }
	: { align: 'center' as const, side: EDGE_MENU_SIDE[props.side ?? 'bottom'], sideOffset: 6, collisionPadding: 12, onCloseAutoFocus })
/** Long lists (an edge with dozens of threads) scroll inside the menu instead of covering the canvas. */
const MENU_UI = { content: 'w-72 max-h-[min(24rem,var(--reka-dropdown-menu-content-available-height))]', itemLabel: 'truncate', itemDescription: 'truncate' }

const single = computed(() => props.kind === 'edge' && count.value === 1)
const singleLabel = computed(() => single.value ? `${label.value}. ${comments.pinMeta.value.get(threadIds.value[0]!)?.label ?? ''}` : label.value)
</script>

<template>
  <button
    v-if="single"
    type="button"
    class="comment-edge"
    :class="{ 'is-dim': dim }"
    :style="{ transform: EDGE_OFFSET[side ?? 'bottom'] }"
    :aria-label="singleLabel"
    :data-edge-threads="ids"
    :data-edge-side="side"
    :tabindex="dim ? -1 : 0"
    @click="openAndFocus(threadIds[0]!)"
  >
    <UIcon
      :name="EDGE_ICON[side ?? 'bottom']"
      class="size-3.5"
    />
    <span class="tabular-nums">1</span>
  </button>
  <UDropdownMenu
    v-else
    v-model:open="open"
    :items="items"
    :content="content"
    :ui="MENU_UI"
  >
    <CommentPin
      v-if="kind === 'cluster'"
      variant="cluster"
      :count="count"
      :dim="dim"
      :label="label"
      :data-pin-cluster-threads="ids"
      data-pin-cluster
    />
    <button
      v-else
      type="button"
      class="comment-edge"
      :class="{ 'is-dim': dim }"
      :style="{ transform: EDGE_OFFSET[side ?? 'bottom'] }"
      :aria-label="label"
      :data-edge-threads="ids"
      :data-edge-side="side"
      :tabindex="dim ? -1 : 0"
    >
      <UIcon
        :name="EDGE_ICON[side ?? 'bottom']"
        class="size-3.5"
      />
      <span class="tabular-nums">{{ count }}</span>
    </button>
  </UDropdownMenu>
</template>

<style scoped>
.comment-edge {
  position: absolute;
  left: 0;
  top: 0;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 7px 0 4px;
  border: 0;
  border-radius: 999px;
  background: var(--wb-pin);
  color: var(--wb-pin-text);
  font-size: var(--text-xs);
  line-height: 1rem;
  font-weight: 600;
  white-space: nowrap;
  box-shadow: var(--wb-shadow-pin);
  pointer-events: auto;
  cursor: pointer;
}
.comment-edge:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
.comment-edge.is-dim { opacity: 0.4; pointer-events: none; }
@media (pointer: coarse) {
  .comment-edge::before { content: ""; position: absolute; inset: -10px -4px; }
}
</style>
