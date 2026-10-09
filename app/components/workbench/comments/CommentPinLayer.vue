<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch, type ComponentPublicInstance } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { PENDING_PIN_ID, useCanvasComments } from '../../../composables/useCanvasComments'
import { aggregateEdgeIndicators, type PinEdgeSide } from '../../../../src/preview/pin-visibility'
import { mapPointAffine, type AffineOuterMapping } from '../../../../src/preview/outer-precision'
import type { Point } from '../../../../src/preview/protocol/schema'
import { layoutPins, mutedItemKeys } from '../../../utils/pin-layout'
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

function dragTo(threadId: string, clientX: number, clientY: number): void {
	const mapping = props.mapping
	const item = comments.threadById.value.get(threadId)
	const rect = item ? preview.geometryStreams.report(item.anchor.widgetId)?.rect : undefined
	const bounds = layer.value?.getBoundingClientRect()
	if (!mapping || !rect || !bounds || !(rect.width > 0) || !(rect.height > 0)) return
	const inner = invert({ x: clientX - bounds.left, y: clientY - bounds.top }, mapping)
	if (!inner) return
	const hint = {
		x: Math.min(1, Math.max(0, (inner.x - rect.x) / rect.width)),
		y: Math.min(1, Math.max(0, (inner.y - rect.y) / rect.height)),
	}
	const tip = mapPointAffine({ x: rect.x + hint.x * rect.width, y: rect.y + hint.y * rect.height }, mapping)
	drag.value = { threadId, x: tip.x, y: tip.y, hint }
}

async function dropAt(threadId: string, clientX: number, clientY: number): Promise<void> {
	dragTo(threadId, clientX, clientY)
	const current = drag.value
	if (current?.threadId === threadId) await comments.moveHint(threadId, current.hint)
	drag.value = undefined
}

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
        @pin="onPin"
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
