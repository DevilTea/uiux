<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * A comment pin (DESIGN.md "Comment pin"; brief c, section 6): a teardrop whose bottom-left tip
 * marks the anchor point exactly. It is opaque Workbench chrome above the frame, never inside
 * the iframe; the layer around it stays `pointer-events: none`.
 *
 * `variant`: `pending` is the dashed composer pin, `resolved` the small graphite check, `cluster`
 * a count. `badge`: `ready` (blue eye) or `stale` (warning: a named Variant of the scope is missing).
 */
const props = defineProps<{
	x: number
	y: number
	label: string
	variant?: 'default' | 'pending' | 'resolved' | 'cluster'
	badge?: 'ready' | 'stale'
	initials?: string
	agent?: boolean
	count?: number
	open?: boolean
	lift?: boolean
	fresh?: boolean
	dim?: boolean
	threadId?: string
	/** Mouse drag moves the pin within its Widget (the hint mutation is the caller's). */
	draggable?: boolean
}>()
const emit = defineEmits<{
	(e: 'activate'): void
	(e: 'dragMove', point: Readonly<{ clientX: number; clientY: number }>): void
	(e: 'dragEnd', point: Readonly<{ clientX: number; clientY: number }>): void
	(e: 'dragCancel'): void
}>()

const DRAG_THRESHOLD = 3
let start: { x: number; y: number; id: number } | undefined
const dragging = ref(false)

function onPointerDown(event: PointerEvent): void {
	if (!props.draggable || event.button !== 0 || event.pointerType !== 'mouse') return
	start = { x: event.clientX, y: event.clientY, id: event.pointerId }
	;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent): void {
	if (!start || event.pointerId !== start.id) return
	if (!dragging.value && Math.hypot(event.clientX - start.x, event.clientY - start.y) < DRAG_THRESHOLD) return
	dragging.value = true
	emit('dragMove', { clientX: event.clientX, clientY: event.clientY })
}

function onPointerUp(event: PointerEvent): void {
	if (!start || event.pointerId !== start.id) return
	start = undefined
	if (!dragging.value) return
	emit('dragEnd', { clientX: event.clientX, clientY: event.clientY })
	// The click that follows a drag must not toggle the bubble.
	setTimeout(() => { dragging.value = false })
}

function onPointerCancel(): void {
	if (!start) return
	start = undefined
	if (dragging.value) emit('dragCancel')
	dragging.value = false
}

function onClick(): void {
	if (!dragging.value) emit('activate')
}

const glyph = computed(() => {
	if (props.variant === 'resolved') return 'i-lucide-check'
	if (props.variant === 'pending') return 'i-lucide-plus'
	if (props.variant !== 'cluster' && props.agent) return 'i-lucide-bot'
	return undefined
})
</script>

<template>
  <button
    type="button"
    class="comment-pin"
    :class="[
      variant ? `is-${variant}` : '',
      { 'is-open': open, 'is-lift': lift, 'is-fresh': fresh, 'is-dim': dim, 'is-dragging': dragging },
    ]"
    :style="{ left: `${x}px`, top: `${y}px` }"
    :aria-label="label"
    :aria-expanded="variant === 'pending' ? undefined : open"
    :aria-haspopup="variant === 'cluster' ? 'menu' : 'dialog'"
    :tabindex="dim ? -1 : 0"
    :data-pin-thread="threadId"
    :data-pin-variant="variant ?? 'default'"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
    @click="onClick"
  >
    <UIcon
      v-if="glyph"
      :name="glyph"
      class="size-3.5"
    />
    <span v-else-if="variant === 'cluster'">+{{ count }}</span>
    <span v-else>{{ initials }}</span>
    <span
      v-if="badge"
      class="comment-pin-badge"
      :class="`is-${badge}`"
    >
      <UIcon
        :name="badge === 'ready' ? 'i-lucide-eye' : 'i-lucide-history'"
        class="size-2.5"
      />
    </span>
  </button>
</template>

<style scoped>
/* DESIGN.md "Comment pin": 28px Marker teardrop, tip bottom-left at the anchor point. */
.comment-pin {
  position: absolute;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px 999px 999px 2px;
  background: var(--wb-pin);
  color: var(--wb-pin-text);
  font-size: var(--text-xs);
  line-height: 1rem;
  font-weight: 600;
  box-shadow: var(--wb-shadow-pin);
  transform: translateY(-100%);
  pointer-events: auto;
  cursor: pointer;
  transition: transform 120ms var(--ease-out-quiet), box-shadow 120ms var(--ease-out-quiet), opacity 120ms;
  z-index: 2;
}
.comment-pin:hover { transform: translateY(calc(-100% - 1px)); }
.comment-pin:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
.comment-pin.is-open { box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--ui-primary), 0 1px 3px oklch(0% 0 0 / 0.28); z-index: 3; }
.comment-pin.is-lift { transform: translateY(calc(-100% - 2px)); box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--wb-pin), 0 2px 6px oklch(0% 0 0 / 0.3); z-index: 3; }
.comment-pin.is-resolved { width: 24px; height: 24px; background: var(--wb-pin-resolved); color: var(--wb-pin-text); }
.comment-pin.is-pending { background: var(--ui-bg); color: var(--ui-annotation); border: 1.5px dashed var(--wb-pin); box-shadow: 0 1px 3px oklch(0% 0 0 / 0.28); cursor: default; }
.comment-pin.is-dim { opacity: 0.4; pointer-events: none; }
.comment-pin.is-dragging { cursor: grabbing; transition: none; }
.comment-pin.is-fresh { animation: pin-drop 180ms var(--ease-out-quiet); transform-origin: 0 100%; }
.comment-pin-badge {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 2px var(--ui-bg);
}
.comment-pin-badge.is-ready { background: var(--ui-info); color: var(--ui-text-inverted); }
.comment-pin-badge.is-stale { background: var(--ui-bg); color: var(--ui-warning); box-shadow: 0 0 0 2px var(--ui-bg), inset 0 0 0 1.5px var(--ui-warning); }
@keyframes pin-drop {
  from { transform: translateY(-100%) scale(0.6); opacity: 0; }
  to { transform: translateY(-100%) scale(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .comment-pin, .comment-pin.is-fresh { transition: none; animation: none; }
}
/* Touch: a 44px hit area around the 28px glyph (brief c, section 9). */
@media (pointer: coarse) {
  .comment-pin::before { content: ""; position: absolute; inset: -8px; }
}
</style>
