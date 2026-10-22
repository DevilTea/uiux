<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { PENDING_PIN_ID, useCanvasComments } from '../../../composables/useCanvasComments'
import { aggregateEdgeIndicators, type PinEdgeSide } from '../../../../src/preview/pin-visibility'
import { mapPointAffine, type AffineOuterMapping } from '../../../../src/preview/outer-precision'
import type { Point } from '../../../../src/preview/protocol/schema'
import { layoutPins, mutedItemKeys } from '../../../utils/pin-layout'
import { nudgePinHint } from '../../../utils/pin-move'
import CommentPin from './CommentPin.vue'
import CommentPinMenu from './CommentPinMenu.vue'
import CommentThreadPin from './CommentThreadPin.vue'

/**
 * The pin layer inside the canvas overlay (overlay-layer CSS px). The layer itself is
 * `pointer-events: none`; only pins, clusters and edge indicators take input, so every other
 * click reaches the iframe, which hit-tests (multi-target decision 8).
 *
 * Rendering is split in two (decision 9, "DOM writes via `transform` only"): the template renders
 * what is drawn (which pins, which clusters, which edge indicators, in reading order) and re-renders
 * only when that changes; positions are written as `transform`s on zero-size anchors once per frame,
 * after the coalesced geometry update. Children take primitive props and stable handlers, so a
 * re-render touches only the items that changed. A scrolled frame costs one placement pass and one
 * transform write per drawn item.
 */
const props = defineProps<{ mapping?: AffineOuterMapping }>()

const { t } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { preview } = workbench

const layer = ref<HTMLElement>()

/** Interact gives every click to the View: pins dim and stop taking input. */
const dimmed = computed(() => preview.canvasTool.value === 'interact')

// ---------------------------------------------------------------------------------------------
// Drag to move a pin within its Widget (pin-hint decision 4: one write on drop)
// ---------------------------------------------------------------------------------------------

const drag = ref<{ threadId: string; x: number; y: number; hint: { x: number; y: number } }>()

function invert(point: Point, mapping: AffineOuterMapping): Point | undefined {
	const det = mapping.a * mapping.d - mapping.b * mapping.c
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return undefined
	const dx = point.x - mapping.e
	const dy = point.y - mapping.f
	return { x: (mapping.d * dx - mapping.c * dy) / det, y: (-mapping.b * dx + mapping.a * dy) / det }
}

/** The thread's Widget rectangle (inner px) when it can be measured and the overlay mapped. */
function widgetRect(threadId: string) {
	const item = comments.threadById.value.get(threadId)
	const rect = item ? preview.geometryStreams.report(item.anchor.widgetId)?.rect : undefined
	return props.mapping && rect && rect.width > 0 && rect.height > 0 ? rect : undefined
}

/** Draws the pin at `hint` (clamped to the Widget) without writing it; the write is the caller's. */
function showAt(threadId: string, hint: Readonly<{ x: number; y: number }>): { x: number; y: number } | undefined {
	const mapping = props.mapping
	const rect = widgetRect(threadId)
	if (!mapping || !rect) return undefined
	const clamped = { x: Math.min(1, Math.max(0, hint.x)), y: Math.min(1, Math.max(0, hint.y)) }
	const tip = mapPointAffine({ x: rect.x + clamped.x * rect.width, y: rect.y + clamped.y * rect.height }, mapping)
	drag.value = { threadId, x: tip.x, y: tip.y, hint: clamped }
	return clamped
}

/** The hint under an overlay-layer point, or `undefined` when it cannot be measured. */
function hintAtOverlay(threadId: string, point: Point): { x: number; y: number } | undefined {
	const mapping = props.mapping
	const rect = widgetRect(threadId)
	const inner = mapping && rect ? invert(point, mapping) : undefined
	if (!rect || !inner) return undefined
	return { x: (inner.x - rect.x) / rect.width, y: (inner.y - rect.y) / rect.height }
}

function dragTo(threadId: string, clientX: number, clientY: number): void {
	const bounds = layer.value?.getBoundingClientRect()
	const hint = bounds ? hintAtOverlay(threadId, { x: clientX - bounds.left, y: clientY - bounds.top }) : undefined
	if (hint) showAt(threadId, hint)
}

async function dropAt(threadId: string, clientX: number, clientY: number): Promise<void> {
	dragTo(threadId, clientX, clientY)
	const current = drag.value
	if (current?.threadId === threadId) await comments.moveHint(threadId, current.hint)
	drag.value = undefined
}

// ---------------------------------------------------------------------------------------------
// Keyboard move (issue #118): M on a focused pin starts, arrows move, Enter commits, Escape cancels
// ---------------------------------------------------------------------------------------------

const MOVE_HINT_ID = 'pin-move-hint'
const keyMoving = ref<string>()
/** The hint the move started from, so a commit that changed nothing writes nothing. */
let keyOrigin: { x: number; y: number } | undefined
/** A commit's write is in flight: no second move starts until it settles. */
const writing = ref(false)

/** Step announcements go at most every 500 ms (like the hover chip); the last position always follows. */
const STEP_ANNOUNCE_MS = 500
let lastStepAnnounce = 0
let stepTimer: ReturnType<typeof setTimeout> | undefined
function announceStep(text: string): void {
	clearTimeout(stepTimer)
	const wait = lastStepAnnounce + STEP_ANNOUNCE_MS - Date.now()
	const send = () => {
		lastStepAnnounce = Date.now()
		comments.announce(text)
	}
	if (wait <= 0) send()
	else stepTimer = setTimeout(send, wait)
}
function announceNow(text: string): void {
	clearTimeout(stepTimer)
	lastStepAnnounce = Date.now()
	comments.announce(text)
}
onBeforeUnmount(() => clearTimeout(stepTimer))

const percent = (value: number) => Math.round(value * 100)
function announcePosition(hint: Readonly<{ x: number; y: number }>): string {
	return t('pins.move.position', { x: percent(hint.x), y: percent(hint.y) })
}

/** Steps are physical (ArrowLeft is toward the Widget's left edge), also in a right-to-left Locale. */
function onPinKey(threadId: string, action: 'start' | 'step' | 'commit' | 'cancel', step?: Readonly<{ dx: number; dy: number; coarse: boolean }>): void {
	if (action === 'start') {
		const point = comments.placements.value.find(placement => placement.threadId === threadId && placement.state === 'visible')?.point
		const start = point ? hintAtOverlay(threadId, point) : undefined
		const shown = start ? showAt(threadId, start) : undefined
		if (!shown || writing.value) return
		keyMoving.value = threadId
		keyOrigin = shown
		announceNow(`${t('pins.move.started')} ${announcePosition(shown)}`)
	}
	else if (keyMoving.value !== threadId) return
	else if (action === 'step' && step && drag.value?.threadId === threadId) {
		const shown = showAt(threadId, nudgePinHint(drag.value.hint, step))
		if (shown) announceStep(announcePosition(shown))
	}
	else if (action === 'commit') {
		const hint = drag.value?.threadId === threadId ? drag.value.hint : undefined
		keyMoving.value = undefined
		if (!hint) return
		// The start point is measured, not stored: within 0.1 % of the Widget counts as unchanged.
		if (keyOrigin && Math.abs(hint.x - keyOrigin.x) < 1e-3 && Math.abs(hint.y - keyOrigin.y) < 1e-3) {
			drag.value = undefined
			announceNow(t('pins.move.unchanged'))
			return
		}
		// One write, as for a drop; the pin stays where it was drawn until the thread refreshes.
		writing.value = true
		void comments.moveHint(threadId, hint).then((ok) => {
			writing.value = false
			if (drag.value?.threadId === threadId) drag.value = undefined
			announceNow(ok ? `${t('pins.move.done')} ${announcePosition(hint)}` : t('pins.move.failed'))
		})
	}
	else if (action === 'cancel') {
		endKeyMove()
	}
}

function endKeyMove(): void {
	keyMoving.value = undefined
	if (drag.value?.threadId) drag.value = undefined
	announceNow(t('pins.move.canceled'))
}

// The move ends when its pin can no longer be moved: the thread is gone, resolved or off the canvas.
const moveStillValid = computed(() => {
	const id = keyMoving.value
	if (!id) return true
	return !!props.mapping && comments.canComment.value && comments.pinMeta.value.get(id)?.resolved === false
		&& comments.placements.value.some(placement => placement.threadId === id && placement.state === 'visible')
})
watch(moveStillValid, (valid) => {
	if (!valid && keyMoving.value) endKeyMove()
})

/** A muted pin switches the Preview to its thread's recorded context first (Rule 01a1170f-c1f7). */
function toggle(threadId: string): void {
	if (comments.openThreadId.value === threadId) comments.close()
	else if (comments.mutedThreadIds.value.has(threadId)) void comments.openInRecordedContext(threadId)
	else comments.open(threadId)
}

type PinPoint = Readonly<{ clientX: number; clientY: number }>
/** One stable handler for every pin's activation and drag (see CommentThreadPin). */
function onPin(threadId: string, action: 'activate' | 'enter' | 'move' | 'drop' | 'cancel', point?: PinPoint): void {
	if (action === 'activate') toggle(threadId)
	// Enter on the pin of the open bubble moves into the conversation instead of closing it.
	else if (action === 'enter' && comments.openThreadId.value === threadId) focusBubble()
	else if (action === 'enter') toggle(threadId)
	else if (action === 'move' && point) dragTo(threadId, point.clientX, point.clientY)
	else if (action === 'drop' && point) void dropAt(threadId, point.clientX, point.clientY)
	else if (action === 'cancel') drag.value = undefined
}

// ---------------------------------------------------------------------------------------------
// What is drawn (structure) and where (per-frame positions)
// ---------------------------------------------------------------------------------------------

/** The open, dragged and list-hovered threads are drawn on their own; the rest may merge into clusters. */
const solo = computed(() => new Set([comments.openThreadId.value, drag.value?.threadId, comments.hoveredThreadId.value].filter((id): id is string => !!id)))
const EXCLUDED = new Set([PENDING_PIN_ID])

const layout = computed(() => comments.pinsHidden.value ? undefined : layoutPins(comments.placements.value, { solo: solo.value, excluded: EXCLUDED }))
const edges = computed(() => comments.pinsHidden.value ? [] : aggregateEdgeIndicators(comments.placements.value))
/** Muted clusters: only those whose every thread is muted (Rule 01a11e0d-d4a0). Never changes `layout`. */
const mutedKeys = computed(() => mutedItemKeys(layout.value, comments.mutedThreadIds.value))
const pending = computed(() => comments.placements.value.find(placement => placement.threadId === PENDING_PIN_ID && placement.state === 'visible' && placement.point))

type Structure = Readonly<{
	key: string
	items: ReadonlyArray<Readonly<{ kind: 'pin'; key: string; threadId: string; drawn: boolean } | { kind: 'cluster'; key: string; ids: string; drawn: true }>>
	edges: ReadonlyArray<Readonly<{ key: string; side: PinEdgeSide; ids: string }>>
	pending: boolean
}>

/** One indicator per side and scope; it keeps its element while its threads change. */
const edgeKey = (edge: Readonly<{ scope: string; side: string }>) => `e:${edge.scope}:${edge.side}`

/**
 * What is drawn. It keeps its identity while pins only move, so the template does not re-render.
 * Every pin that can appear on this canvas stays mounted; one that scrolls out of view, joins a
 * cluster or loses its point is only `hidden`, so scrolling never mounts or unmounts components.
 * Drawn items come first, in reading order, which is also their Tab order.
 */
const structure = computed<Structure>((previous) => {
	const edgeItems = edges.value.map(edge => ({ key: edgeKey(edge), side: edge.side, ids: edge.threadIds.join(' ') }))
	const drawnItems = layout.value?.items ?? []
	const drawnPins = new Set(drawnItems.flatMap(item => item.kind === 'pin' ? [item.threadId] : []))
	const undrawn = comments.pinsHidden.value
		? []
		: comments.placements.value.filter(placement => placement.threadId !== PENDING_PIN_ID && placement.state !== 'invalid'
			&& placement.reason !== 'other-variant' && placement.reason !== 'other-view' && !drawnPins.has(placement.threadId))
	const key = `${layout.value?.key ?? ''}~${undrawn.map(placement => placement.threadId).join(',')}#${edgeItems.map(edge => `${edge.key}=${edge.ids}`).join('|')}#${pending.value ? 'pending' : ''}`
	if (previous && previous.key === key) return previous
	const items: Structure['items'][number][] = drawnItems.map(item => item.kind === 'pin'
		? { kind: 'pin' as const, key: item.key, threadId: item.threadId, drawn: true }
		: { kind: 'cluster' as const, key: item.key, ids: item.threadIds.join(' '), drawn: true as const })
	for (const placement of undrawn) items.push({ kind: 'pin', key: `p:${placement.threadId}`, threadId: placement.threadId, drawn: false })
	return { key, items, edges: edgeItems, pending: !!pending.value }
})

/** Where each drawn item is, in overlay px. Recomputed per frame; written as transforms only. */
const positions = computed(() => {
	const result = new Map<string, Point>()
	for (const item of layout.value?.items ?? []) {
		const dragged = item.kind === 'pin' && drag.value?.threadId === item.threadId ? drag.value : undefined
		result.set(item.key, dragged ? { x: dragged.x, y: dragged.y } : item.point)
	}
	for (const edge of edges.value) result.set(edgeKey(edge), edge.point)
	if (pending.value?.point) result.set('pending', pending.value.point)
	return result
})

const anchors = new Map<string, HTMLElement>()
const anchorRefs = new Map<string, (element: Element | ComponentPublicInstance | null) => void>()
/** Registration only: the post-flush watcher writes positions, so rendering never reads them. */
function anchorRef(key: string) {
	let set = anchorRefs.get(key)
	if (!set) {
		set = (element) => {
			if (element instanceof HTMLElement) anchors.set(key, element)
			else {
				anchors.delete(key)
				anchorRefs.delete(key)
			}
		}
		anchorRefs.set(key, set)
	}
	return set
}

function writePositions(): void {
	for (const [key, point] of positions.value) {
		const element = anchors.get(key)
		if (element) element.style.transform = `translate(${point.x}px, ${point.y}px)`
	}
}
watch([positions, structure], writePositions, { flush: 'post' })
// The layer mounts with the overlay mapping, which can be the moment its first pin appears (a
// composer opened from the keyboard, the tree or "Comment on this View" on a View with no pins
// yet). Nothing changes after that first render, so the watcher alone would never place it and
// the pin and its composer would sit at the stage's corner.
onMounted(writePositions)

// ---------------------------------------------------------------------------------------------
// Keyboard: J / K cycle the pins (brief c §11); Tab walks them in reading order
// ---------------------------------------------------------------------------------------------

function isTyping(target: EventTarget | null): boolean {
	const element = target as HTMLElement | null
	return !!element && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' || element.isContentEditable)
}

function focusBubble(): void {
	comments.browsingPins.value = false
	const bubble = document.querySelector<HTMLElement>('[data-thread-bubble]')
	;(bubble?.querySelector<HTMLElement>('textarea[data-thread-reply]') ?? bubble)?.focus({ preventScroll: true })
}

function focusThread(threadId: string): void {
	void nextTick(() => {
		const escaped = CSS.escape(threadId)
		const target = layer.value?.querySelector<HTMLElement>(`[data-pin-thread="${escaped}"]`)
			?? layer.value?.querySelector<HTMLElement>(`[data-edge-threads~="${escaped}"]`)
		target?.focus({ preventScroll: true })
	})
}

function onKeydown(event: KeyboardEvent): void {
	if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
	if (event.key !== 'j' && event.key !== 'k') return
	const active = document.activeElement as HTMLElement | null
	if (isTyping(active) || active?.closest('[data-comments-tab]')) return
	if (document.querySelector('[data-reka-popper-content-wrapper] [role="menu"]')) return
	// On the canvas: a focused pin, cluster or edge indicator, the open bubble, or nothing focused while a thread is open.
	const inLayer = !!active && !!layer.value?.contains(active)
	const inBubble = !!active?.closest('[data-thread-bubble]')
	const idle = !active || active === document.body
	if (!inLayer && !inBubble && !(idle && comments.openThreadId.value)) return
	const from = active?.getAttribute('data-pin-thread')
		?? (active?.getAttribute('data-edge-threads') ?? active?.getAttribute('data-pin-cluster-threads'))?.split(' ')[0]
	const next = comments.cycle(event.key === 'j' ? 1 : -1, from && from !== PENDING_PIN_ID ? from : undefined)
	if (!next) return
	event.preventDefault()
	focusThread(next)
}

/**
 * Icons that pins, edge indicators and list rows switch to while the View scrolls. Icons inject
 * their CSS on first use, which restyles the whole Workbench document; rendering them once up front
 * keeps that out of the scrolled frames.
 */
const PRELOADED_ICONS = [
	'i-lucide-chevron-up', 'i-lucide-chevron-right', 'i-lucide-chevron-down', 'i-lucide-chevron-left',
	'i-lucide-arrow-up-to-line', 'i-lucide-arrow-right-to-line', 'i-lucide-arrow-down-to-line', 'i-lucide-arrow-left-to-line',
	'i-lucide-scan', 'i-lucide-scan-line', 'i-lucide-eye-off', 'i-lucide-eye', 'i-lucide-bot', 'i-lucide-check', 'i-lucide-plus', 'i-lucide-history',
] as const

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div
    ref="layer"
    class="pointer-events-none absolute inset-0"
    data-comment-pins
  >
    <span
      v-for="item in structure.items"
      :key="item.key"
      :ref="anchorRef(item.key)"
      class="pin-anchor"
      :class="{ 'is-raised': item.kind === 'pin' && solo.has(item.threadId) }"
      :hidden="!item.drawn"
    >
      <CommentPinMenu
        v-if="item.kind === 'cluster'"
        kind="cluster"
        :ids="item.ids"
        :dim="dimmed"
        :muted="mutedKeys.has(item.key)"
      />
      <CommentThreadPin
        v-else
        :thread-id="item.threadId"
        :draggable-on-canvas="!!mapping"
        :moving="keyMoving === item.threadId"
        :move-hint-id="MOVE_HINT_ID"
        @pin="onPin"
        @pin-key="onPinKey"
      />
    </span>

    <span
      v-for="edge in structure.edges"
      :key="edge.key"
      :ref="anchorRef(edge.key)"
      class="pin-anchor"
    >
      <CommentPinMenu
        kind="edge"
        :ids="edge.ids"
        :side="edge.side"
        :dim="dimmed"
      />
    </span>

    <span
      v-if="structure.pending"
      key="pending"
      :ref="anchorRef('pending')"
      class="pin-anchor is-raised"
    >
      <CommentPin
        variant="pending"
        :thread-id="PENDING_PIN_ID"
        :label="t('comment.placeholder')"
        fresh
        aria-hidden="true"
        tabindex="-1"
      />
    </span>

    <p
      :id="MOVE_HINT_ID"
      class="sr-only"
    >
      {{ t('pins.move.hint') }}
    </p>

    <span
      hidden
      aria-hidden="true"
    >
      <UIcon
        v-for="icon in PRELOADED_ICONS"
        :key="icon"
        :name="icon"
      />
    </span>
  </div>
</template>

<style scoped>
/* A zero-size anchor at the pin tip; the layer moves it with a transform (decision 9). */
.pin-anchor {
  position: absolute;
  left: 0;
  top: 0;
  width: 0;
  height: 0;
  z-index: 2;

}
.pin-anchor.is-raised { z-index: 3; }
</style>
