<script setup lang="ts">
import { computed, ref } from 'vue'

/**
 * A comment pin (DESIGN.md "Comment pin"; brief c, section 6): a teardrop whose bottom-left tip
 * marks the anchor point exactly. It is opaque Workbench chrome above the frame, never inside
 * the iframe; the layer around it stays `pointer-events: none`.
 *
 * `variant`: `pending` is the dashed composer pin, `resolved` the small graphite check, `cluster`
 * a count. `badge`: `ready` (blue eye) or `stale` (warning: a named Variant of the scope is missing).
 *
 * `muted` (or a `context`): the thread is recorded in another render context (Rule 01a1170f-c1ae).
 * The pin turns hollow and `context`, such as "zh-TW · mobile", shows as a mono chip beside it;
 * the accessible name (`label`) carries the same context (Rule 01a1170f-c352). Muting changes the
 * look only, never the position (Rule 01a1170f-c282).
 *
 * The pin has no position of its own: it sits with its tip on the bottom-left corner of its
 * parent, a zero-size anchor that the pin layer moves with a `transform` once per frame (decision
 * 9: pin DOM writes are transforms only), so a moving pin never re-renders.
 */
const props = defineProps<{
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
	muted?: boolean
	/** A muted pin's recorded render context, shown beside it. */
	context?: string
	threadId?: string
	/** Mouse drag moves the pin within its Widget (the hint mutation is the caller's). */
	draggable?: boolean
}>()
const emit = defineEmits<{
	/** `keyboard`: Enter or Space (a click with no pointer detail). */
	(e: 'activate', keyboard: boolean): void
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

function onClick(event: MouseEvent): void {
	if (!dragging.value) emit('activate', event.detail === 0)
}

const glyph = computed(() => {
	if (props.variant === 'resolved') return 'i-lucide-check'
	if (props.variant === 'pending') return 'i-lucide-plus'
	if (props.variant !== 'cluster' && props.agent) return 'i-lucide-bot'
	return undefined
})
const isMuted = computed(() => props.muted || props.context !== undefined)
</script>

<template>
  <button
    type="button"
    class="comment-pin"
    :class="[
      variant ? `is-${variant}` : '',
      { 'is-open': open, 'is-lift': lift, 'is-fresh': fresh, 'is-dim': dim, 'is-muted': isMuted, 'is-dragging': dragging },
    ]"
    :aria-label="label"
    :aria-expanded="variant === 'pending' ? undefined : open"
    :aria-haspopup="variant === 'cluster' ? 'menu' : 'dialog'"
    :tabindex="dim ? -1 : 0"
    :data-pin-thread="threadId"
    :data-pin-variant="variant ?? 'default'"
    :data-pin-muted="isMuted ? '' : undefined"
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
    <span
      v-if="context"
      class="comment-pin-context"
      aria-hidden="true"
      data-pin-context
    >{{ context }}</span>
  </button>
</template>

<style scoped>
/* DESIGN.md "Comment pin": 28px Marker teardrop, tip bottom-left on the anchor point. */
.comment-pin {
  position: absolute;
  left: 0;
  bottom: 0;
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
  transform-origin: 0 100%;
  pointer-events: auto;
  cursor: pointer;
  transition: transform 120ms var(--ease-out-quiet), box-shadow 120ms var(--ease-out-quiet), opacity 120ms;
}
.comment-pin:hover { transform: translateY(-1px); }
.comment-pin:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
.comment-pin.is-open { box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--ui-primary), var(--wb-shadow-pin-drop); }
.comment-pin.is-lift { transform: translateY(-2px); box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--wb-pin), 0 2px 6px oklch(0% 0 0 / 0.3); }
.comment-pin.is-resolved { width: 24px; height: 24px; background: var(--wb-pin-resolved); color: var(--wb-pin-text); }
.comment-pin.is-pending { background: var(--ui-bg); color: var(--ui-annotation); border: 1.5px dashed var(--wb-pin); box-shadow: var(--wb-shadow-pin-drop); cursor: default; }
.comment-pin.is-cluster { min-width: 28px; width: auto; padding-inline: 6px; font-variant-numeric: tabular-nums; }
/*
 * Muted (recorded in another render context): hollow, in the same Marker ink, so it still reads as
 * a comment but steps back from the pins of this context. The border sits inside the same box, so
 * the tip never moves.
 */
.comment-pin.is-muted { background: var(--ui-bg); color: var(--ui-annotation); border: 1.5px solid var(--wb-pin); box-shadow: var(--wb-shadow-pin-drop); }
.comment-pin.is-muted.is-resolved { color: var(--ui-text-muted); border-color: var(--wb-pin-resolved); }
.comment-pin.is-muted.is-lift { box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--wb-pin), 0 2px 6px oklch(0% 0 0 / 0.3); }
.comment-pin.is-muted.is-open { box-shadow: 0 0 0 2px var(--ui-bg), 0 0 0 4px var(--ui-primary), var(--wb-shadow-pin-drop); }
.comment-pin-context {
  position: absolute;
  left: calc(100% + 4px);
  bottom: 0;
  padding: 0 4px;
  border: 1px solid var(--ui-border);
  border-radius: 4px;
  background: var(--ui-bg);
  color: var(--ui-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1rem;
  font-weight: 400;
  white-space: nowrap;
  /* Long keys truncate; the full context stays in the pin's accessible name. */
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.comment-pin.is-dim { opacity: 0.4; pointer-events: none; }
.comment-pin.is-dragging { cursor: grabbing; transition: none; }
.comment-pin.is-fresh { animation: pin-drop 180ms var(--ease-out-quiet); }
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
  from { transform: scale(0.6); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .comment-pin, .comment-pin.is-fresh { transition: none; animation: none; }
}
/* Touch: a 44px hit area around the 28px glyph (brief c, section 9). */
@media (pointer: coarse) {
  .comment-pin::before { content: ""; position: absolute; inset: -8px; }
  .comment-pin.is-resolved::before { inset: -10px; }
}
</style>
