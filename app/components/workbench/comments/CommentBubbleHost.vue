<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, shallowRef, watch } from 'vue'
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
/**
 * The open thread's recorded context when it is muted (Rule 01a1170f-c1ae): the sheet's title says
 * so, like the muted pin's accessible name (Rule 01a1170f-c352); the bubble itself shows the label
 * and offers the recorded context.
 */
const mutedContext = computed(() => threadId.value ? comments.mutedContexts.value.get(threadId.value) : undefined)
const sheetTitle = computed(() => {
	if (composer.value) return t('comment.placeholder')
	return mutedContext.value === undefined ? t('comments.threadTitle') : t('pins.muted.label', { label: t('comments.threadTitle'), context: mutedContext.value })
})

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

/**
 * A control must not move under the pointer between press and release (issue #266). A
 * deep-linked thread's bubble opens at the canvas corner and moves to its pin once the Preview
 * draws it, and its content can change height meanwhile (the placement note goes away), which
 * shifts a bubble held inside the window. A click whose press and release straddle such a move
 * reaches a common ancestor instead of the control. So while a pointer is pressed on the bubble,
 * a new reference waits and the floating layer keeps its position (`data-bubble-held`, below);
 * once the click has landed, both catch up at once, without animation.
 */
let pressed = false
let held: HTMLElement | undefined
let releaseTimer: ReturnType<typeof setTimeout> | undefined

function retarget(): void {
	if (pressed) return
	const next = findReference()
	if (next !== reference.value) reference.value = next
}

function stopListening(): void {
	window.removeEventListener('pointerup', onRelease, true)
	window.removeEventListener('pointercancel', onRelease, true)
	window.removeEventListener('blur', onRelease)
	window.removeEventListener('contextmenu', onRelease, true)
}

function unhold(): void {
	held?.removeAttribute('data-bubble-held')
	held?.style.removeProperty('--bubble-held-transform')
	held = undefined
}

function onRelease(): void {
	stopListening()
	clearTimeout(releaseTimer)
	// `click` follows `pointerup` within the same input event; one task later it has landed.
	releaseTimer = setTimeout(() => {
		releaseTimer = undefined
		pressed = false
		unhold()
		retarget()
	})
}

function onBubblePointerdown(event: PointerEvent): void {
	// Only the primary button holds; a right or middle press (or ctrl-click, the macOS context menu) never starts a drag.
	if (!event.isPrimary || event.button !== 0 || (event.ctrlKey && /Mac/i.test(navigator.platform))) return
	clearTimeout(releaseTimer)
	releaseTimer = undefined
	pressed = true
	window.addEventListener('pointerup', onRelease, true)
	window.addEventListener('pointercancel', onRelease, true)
	window.addEventListener('blur', onRelease)
	// A context menu may swallow the pointerup.
	window.addEventListener('contextmenu', onRelease, true)
	if (held) return
	// The floating layer's wrapper, positioned by an inline transform the floating layer rewrites.
	const wrapper = (event.currentTarget as HTMLElement).closest<HTMLElement>('[data-reka-popper-content-wrapper]')
	if (!wrapper?.style.transform) return
	held = wrapper
	wrapper.style.setProperty('--bubble-held-transform', wrapper.style.transform)
	wrapper.setAttribute('data-bubble-held', '')
}

onBeforeUnmount(() => {
	stopListening()
	clearTimeout(releaseTimer)
	unhold()
})

// The reference changes only when a thread's canvas status does (drawn, behind an edge, hidden),
// never per scrolled frame; the floating layer itself follows the moving pin.
watch(
	[() => composer.value?.sequence, threadId, () => comments.pinStatusById.value, () => comments.pinsHidden.value, () => comments.hoveredThreadId.value],
	async () => {
		await nextTick()
		retarget()
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
    :title="sheetTitle"
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
      <div
        class="contents"
        @pointerdown.capture="onBubblePointerdown"
      >
        <CommentComposer v-if="composer" />
        <ThreadBubble
          v-else-if="threadId"
          :thread-id="threadId"
        />
      </div>
    </template>
  </UPopover>
</template>

<style>
/* While a pointer is pressed on the bubble, the floating layer keeps the position it had at the
   press (issue #266); the inline transform it rewrites meanwhile applies on release. */
[data-reka-popper-content-wrapper][data-bubble-held] {
  transform: var(--bubble-held-transform) !important;
}
</style>
