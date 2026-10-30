<script setup lang="ts">
import { computed, ref } from 'vue'
import Icon from './Icon.vue'

/**
 * The Kit comment pin (DESIGN.md "Comment pin"): a 28px Marker teardrop whose bottom-left tip marks
 * the anchor point exactly. It is opaque chrome above the content it annotates.
 *
 * `variant`: `pending` is the dashed composer pin, `resolved` the small graphite check, `cluster` a
 * count (`count`), `default` the starter's initials or an actor glyph. `badge`: `ready` (an eye) or
 * `stale` (a history mark). `muted`, or a `context`, hollows the pin for a thread recorded in another
 * render context, and `context` shows beside it as a mono chip; muting changes the look only, never
 * the position.
 *
 * By default the pin sits with its tip on the bottom-left corner of its positioned parent. A parent
 * that places the pin another way overrides `left`, `top`, `bottom` and `transform` on the pin; the
 * pin's own hover, lift and drop-in motion use the independent `translate` and `scale` properties, so
 * they never disturb a `transform` set that way.
 *
 * The pin is controlled: it renders from its props. Its only state is the pointer drag in progress,
 * which it reports as events (`dragMove`, `dragEnd`, `dragCancel`) for the parent to apply, and the
 * keyboard move (M, arrows, Enter, Escape), which the parent owns through `moving` and `moveKey`.
 */
const props = defineProps<{
  /** The accessible name. A muted pin's name carries its render context too. */
  label: string
  variant?: 'default' | 'pending' | 'resolved' | 'cluster'
  badge?: 'ready' | 'stale'
  initials?: string
  /** Who started the thread: an `agent` or `system` shows a glyph instead of initials. */
  actor?: 'human' | 'agent' | 'system'
  /** The number a `cluster` pin shows after `+`. */
  count?: number
  /** The pin's bubble or menu is open: a 2px ring in the primary ink. */
  open?: boolean
  lift?: boolean
  /** A pin that has just appeared drops in. */
  fresh?: boolean
  dim?: boolean
  muted?: boolean
  /** A muted pin's recorded render context, shown beside it. */
  context?: string
  threadId?: string
  /** Mouse drag moves the pin (the move itself is the parent's). */
  draggable?: boolean
  /** The pin is in keyboard move mode (the parent owns the state). */
  moving?: boolean
  /** Id of the element that describes the keyboard move (draggable pins only). */
  moveHintId?: string
}>()
const emit = defineEmits<{
  /** `keyboard`: Enter or Space (a click with no pointer detail). */
  (e: 'activate', keyboard: boolean): void
  (e: 'dragMove', point: Readonly<{ clientX: number; clientY: number }>): void
  (e: 'dragEnd', point: Readonly<{ clientX: number; clientY: number }>): void
  (e: 'dragCancel'): void
  /** The keyboard move; `step` carries a signed direction (Shift asks for a coarse step). */
  (e: 'moveKey', action: 'start' | 'step' | 'commit' | 'cancel', step?: Readonly<{ dx: number; dy: number; coarse: boolean }>): void
}>()

const DRAG_THRESHOLD = 3
let start: { x: number; y: number; id: number } | undefined
const dragging = ref(false)

function onPointerDown(event: PointerEvent): void {
  // A pointer drag ends a keyboard move first.
  if (props.moving) emit('moveKey', 'cancel')
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
  // The click that follows a drag must not activate the pin.
  setTimeout(() => { dragging.value = false })
}

function onPointerCancel(): void {
  if (!start) return
  start = undefined
  if (dragging.value) emit('dragCancel')
  dragging.value = false
}

const ARROWS: Record<string, { dx: number; dy: number }> = {
  ArrowLeft: { dx: -1, dy: 0 }, ArrowRight: { dx: 1, dy: 0 }, ArrowUp: { dx: 0, dy: -1 }, ArrowDown: { dx: 0, dy: 1 },
}

/** Keyboard move: M starts, arrows move, Enter commits, Escape cancels. */
function onKeydown(event: KeyboardEvent): void {
  if (!props.draggable || event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return
  if (!props.moving) {
    if (event.key.toLowerCase() === 'm' && !event.shiftKey) {
      event.preventDefault()
      emit('moveKey', 'start')
    }
    return
  }
  // The move owns these keys: no activation, no page scroll, no global Escape.
  const arrow = ARROWS[event.key]
  if (arrow) emit('moveKey', 'step', { ...arrow, coarse: event.shiftKey })
  else if (event.key === 'Enter' || event.key === ' ') {
    swallowCommit = true
    emit('moveKey', 'commit')
  }
  else if (event.key === 'Escape') emit('moveKey', 'cancel')
  else return
  event.preventDefault()
  event.stopPropagation()
}

function onBlur(): void {
  if (props.moving) emit('moveKey', 'cancel')
}

/**
 * Enter or Space that committed a keyboard move must not also activate the pin: Firefox fires a
 * click on the Space keyup even when the keydown was prevented, so the keyup and its click are swallowed.
 */
let swallowCommit = false
function onKeyup(event: KeyboardEvent): void {
  if (!swallowCommit || (event.key !== ' ' && event.key !== 'Enter')) return
  event.preventDefault()
  setTimeout(() => { swallowCommit = false })
}

function onClick(event: MouseEvent): void {
  if (swallowCommit) return
  if (!dragging.value) emit('activate', event.detail === 0)
}

const glyph = computed(() => {
  if (props.variant === 'resolved') return 'check'
  if (props.variant === 'pending') return 'plus'
  if (props.variant === 'cluster') return undefined
  if (props.actor === 'agent') return 'bot'
  if (props.actor === 'system') return 'cog'
  return undefined
})
const isMuted = computed(() => props.muted || props.context !== undefined)
</script>

<template>
  <button
    type="button"
    class="kit-comment-pin"
    :class="[
      variant ? `is-${variant}` : '',
      { 'is-open': open, 'is-lift': lift, 'is-fresh': fresh, 'is-dim': dim, 'is-muted': isMuted, 'is-dragging': dragging, 'is-moving': moving },
    ]"
    :aria-label="label"
    :aria-expanded="variant === 'pending' ? undefined : open"
    :aria-haspopup="variant === 'cluster' ? 'menu' : 'dialog'"
    :tabindex="dim ? -1 : 0"
    :aria-describedby="draggable ? moveHintId : undefined"
    :aria-keyshortcuts="draggable ? 'M' : undefined"
    :data-pin-moving="moving ? '' : undefined"
    :data-pin-thread="threadId"
    :data-pin-variant="variant ?? 'default'"
    :data-pin-muted="isMuted ? '' : undefined"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerCancel"
    @lostpointercapture="onPointerCancel"
    @keydown="onKeydown"
    @keyup="onKeyup"
    @blur="onBlur"
    @click="onClick"
  >
    <Icon
      v-if="glyph"
      :name="glyph"
      :size="14"
    />
    <span v-else-if="variant === 'cluster'">+{{ count }}</span>
    <span v-else>{{ initials }}</span>
    <span
      v-if="badge"
      class="kit-comment-pin__badge"
      :class="`is-${badge}`"
    >
      <Icon
        :name="badge === 'ready' ? 'eye' : 'history'"
        :size="10"
      />
    </span>
    <span
      v-if="context"
      class="kit-comment-pin__context"
      aria-hidden="true"
      data-pin-context
    >{{ context }}</span>
  </button>
</template>

<style>
/* DESIGN.md "Comment pin": 28px Marker teardrop, tip bottom-left on the anchor point. */
.kit-comment-pin {
  position: absolute;
  left: 0;
  bottom: 0;
  box-sizing: border-box;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 0;
  border-radius: 999px 999px 999px 2px;
  background: var(--kit-pin);
  color: var(--kit-on-pin);
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  font-weight: 600;
  box-shadow: 0 0 0 2px var(--kit-bg-surface), var(--kit-shadow-pin-drop);
  transform-origin: 0 100%;
  pointer-events: auto;
  cursor: pointer;
  transition: translate 120ms cubic-bezier(0.2, 0, 0, 1), box-shadow 120ms cubic-bezier(0.2, 0, 0, 1), opacity 120ms;
}
.kit-comment-pin:hover { translate: 0 -1px; }
.kit-comment-pin:focus-visible { outline: 2px solid var(--kit-primary); outline-offset: 3px; }
.kit-comment-pin.is-open { box-shadow: 0 0 0 2px var(--kit-bg-surface), 0 0 0 4px var(--kit-primary), var(--kit-shadow-pin-drop); }
.kit-comment-pin.is-lift { translate: 0 -2px; box-shadow: 0 0 0 2px var(--kit-bg-surface), 0 0 0 4px var(--kit-pin), var(--kit-shadow-pin-lift); }
.kit-comment-pin.is-resolved { width: 24px; height: 24px; background: var(--kit-pin-resolved); color: var(--kit-on-pin-resolved); }
.kit-comment-pin.is-pending { background: var(--kit-bg-surface); color: var(--kit-annotation); border: 1.5px dashed var(--kit-pin); box-shadow: var(--kit-shadow-pin-drop); cursor: default; }
.kit-comment-pin.is-cluster { min-width: 28px; width: auto; padding-inline: 6px; font-variant-numeric: tabular-nums; }
/*
 * Muted (recorded in another render context): hollow, in the same Marker ink, so it still reads as
 * a comment but steps back from the pins of this context. The border sits inside the same box, so
 * the tip never moves.
 */
.kit-comment-pin.is-muted { background: var(--kit-bg-surface); color: var(--kit-annotation); border: 1.5px solid var(--kit-pin); box-shadow: var(--kit-shadow-pin-drop); }
.kit-comment-pin.is-muted.is-resolved { color: var(--kit-text-muted); border-color: var(--kit-pin-resolved); }
.kit-comment-pin.is-muted.is-lift { box-shadow: 0 0 0 2px var(--kit-bg-surface), 0 0 0 4px var(--kit-pin), var(--kit-shadow-pin-lift); }
.kit-comment-pin.is-muted.is-open { box-shadow: 0 0 0 2px var(--kit-bg-surface), 0 0 0 4px var(--kit-primary), var(--kit-shadow-pin-drop); }
.kit-comment-pin__context {
  position: absolute;
  left: calc(100% + 4px);
  bottom: 0;
  padding: 0 4px;
  border: 1px solid var(--kit-border);
  border-radius: 4px;
  background: var(--kit-bg-surface);
  color: var(--kit-text-muted);
  font-family: var(--kit-font-mono); font-feature-settings: var(--kit-font-mono-features);
  font-size: 12px;
  line-height: 16px;
  font-weight: 400;
  white-space: nowrap;
  /* Long keys truncate; the full context stays in the pin's accessible name. */
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  pointer-events: none;
}
.kit-comment-pin.is-dim { opacity: 0.4; pointer-events: none; }
.kit-comment-pin.is-dragging { cursor: grabbing; transition: none; }
.kit-comment-pin.is-moving { box-shadow: 0 0 0 2px var(--kit-bg-surface), 0 0 0 4px var(--kit-primary), var(--kit-shadow-pin-drop); transition: none; }
.kit-comment-pin.is-fresh { animation: kit-comment-pin-drop 180ms cubic-bezier(0.2, 0, 0, 1); }
.kit-comment-pin__badge {
  position: absolute;
  top: -5px;
  right: -5px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  box-shadow: 0 0 0 2px var(--kit-bg-surface);
}
.kit-comment-pin__badge.is-ready { background: var(--kit-info); color: var(--kit-text-inverted); }
.kit-comment-pin__badge.is-stale { background: var(--kit-bg-surface); color: var(--kit-warning); box-shadow: 0 0 0 2px var(--kit-bg-surface), inset 0 0 0 1.5px var(--kit-warning); }
@keyframes kit-comment-pin-drop {
  from { scale: 0.6; opacity: 0; }
  to { scale: 1; opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .kit-comment-pin, .kit-comment-pin.is-fresh { transition: none; animation: none; }
}
/* Touch: a 44px hit area around the 28px glyph. */
@media (pointer: coarse) {
  .kit-comment-pin::before { content: ""; position: absolute; inset: -8px; }
  .kit-comment-pin.is-resolved::before { inset: -10px; }
}
</style>
