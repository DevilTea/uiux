<script setup lang="ts">
import { computed, nextTick, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { useCanvasComments, PENDING_PIN_ID } from '../../../composables/useCanvasComments'
import { useMediaQuery } from '../../../composables/useMediaQuery'
import CommentComposer from './CommentComposer.vue'
import ThreadBubble from './ThreadBubble.vue'

/**
 * Hosts the composer and the thread bubble. On a fine pointer it is a non-modal `UPopover` whose
 * reference is the pin itself (or its edge indicator, the unplaced tray, or the canvas corner), so
 * Nuxt UI's floating layer handles collisions and the bubble follows the pin while the View
 * scrolls. Escape and outside clicks are the Workbench's (Part 3), so the popover never dismisses
 * itself. Touch devices and phones get a bottom `UDrawer`, which stays above the virtual keyboard.
 */
const { t } = useI18n()
const comments = useCanvasComments()!

const coarse = useMediaQuery('(pointer: coarse)')
const phone = useMediaQuery('(max-width: 767.98px)')
const sheet = computed(() => coarse.value || phone.value)

const composer = computed(() => comments.composer.value)
const threadId = computed(() => composer.value ? undefined : comments.openThreadId.value)
const isOpen = computed(() => !!composer.value || !!threadId.value)

const reference = shallowRef<HTMLElement>()

function findReference(): HTMLElement | undefined {
	// A pin that is mounted but not drawn (its anchor is `hidden`, e.g. the pin point is not
	// visible) has no box; anchoring to it would park the bubble in the window's top-left corner.
	const query = (selector: string) => {
		const element = document.querySelector<HTMLElement>(selector)
		return element && element.getClientRects().length > 0 ? element : undefined
	}
	if (composer.value) return query(`[data-pin-thread="${PENDING_PIN_ID}"]`) ?? query('[data-comment-fallback]')
	const id = threadId.value
	if (!id) return undefined
	const escaped = CSS.escape(id)
	return query(`[data-pin-thread="${escaped}"]`)
		?? query(`[data-edge-threads~="${escaped}"]`)
		?? (comments.threadById.value.get(id)?.anchorValid === false ? query('[data-comment-tray]') : undefined)
		?? query('[data-comment-fallback]')
}

// The reference changes only when a thread's canvas status does (drawn, behind an edge, hidden),
// never per scrolled frame; the floating layer itself follows the moving pin.
watch(
	[() => composer.value?.sequence, threadId, () => comments.pinStatusById.value, () => comments.pinsHidden.value, () => comments.hoveredThreadId.value],
	async () => {
		await nextTick()
		const next = findReference()
		if (next !== reference.value) reference.value = next
	},
	{ immediate: true, flush: 'post' },
)

function onSheetOpen(open: boolean): void {
	// The drawer also reports its initial closed state; only a real dismissal closes anything.
	if (open || !isOpen.value) return
	if (composer.value) comments.closeComposer()
	else comments.close()
}

const contentProps = {
	side: 'right' as const,
	align: 'start' as const,
	sideOffset: 8,
	collisionPadding: 12,
	updatePositionStrategy: 'always' as const,
	onOpenAutoFocus: (event: Event) => event.preventDefault(),
	onCloseAutoFocus: (event: Event) => event.preventDefault(),
}
</script>

<template>
  <UDrawer
    v-if="sheet"
    :open="isOpen"
    :title="composer ? t('comment.placeholder') : t('comments.threadTitle')"
    :ui="{ header: 'sr-only', body: 'p-0', content: 'max-h-[90dvh]' }"
    @update:open="onSheetOpen"
  >
    <template #body>
      <div
        class="flex justify-center overflow-y-auto"
        data-comment-sheet
      >
        <CommentComposer
          v-if="composer"
          class="w-full max-w-none"
        />
        <ThreadBubble
          v-else-if="threadId"
          :thread-id="threadId"
          class="w-full max-w-none"
        />
      </div>
    </template>
  </UDrawer>
  <UPopover
    v-else-if="reference"
    :open="isOpen"
    :reference="reference"
    :dismissible="false"
    :content="contentProps"
    :ui="{ content: 'rounded-xl shadow-overlay ring-0 max-h-[min(60vh,40rem)] overflow-y-auto' }"
  >
    <template #content>
      <CommentComposer v-if="composer" />
      <ThreadBubble
        v-else-if="threadId"
        :thread-id="threadId"
      />
    </template>
  </UPopover>
</template>
