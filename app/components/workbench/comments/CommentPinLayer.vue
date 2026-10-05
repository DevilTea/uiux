<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useWorkbench } from '../../../composables/useWorkbench'
import { threadAuthorInitials, PENDING_PIN_ID, statusKey, useCanvasComments } from '../../../composables/useCanvasComments'
import { clusterPins, type PinPlacement } from '../../../../src/preview/pin-visibility'
import { mapPointAffine, type AffineOuterMapping } from '../../../../src/preview/outer-precision'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'
import CommentPin from './CommentPin.vue'

/**
 * The pin layer inside the canvas overlay (overlay-layer CSS px). The layer itself is
 * `pointer-events: none`; only pins, clusters and edge indicators take input, so every other
 * click reaches the iframe, which hit-tests (multi-target decision 8).
 */
const props = defineProps<{ mapping?: AffineOuterMapping }>()

const { t } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { preview, widgetTreeResult } = workbench

const layer = ref<HTMLElement>()

const typeById = computed(() => {
	const tree = widgetTreeResult.value
	return new Map(tree?.status === 'valid' ? flattenWidgetTree(tree.root).map(node => [node.id, node.type]) : [])
})
const widgetLabel = (widgetId: string) => `${typeById.value.get(widgetId) ?? 'Widget'} · #${widgetId}`

/** Interact gives every click to the View: pins dim and stop taking input. */
const dimmed = computed(() => preview.canvasTool.value === 'interact')

function statusWord(status: string): string {
	return t(`thread.status.${statusKey(status as 'open')}`)
}

function pinLabel(threadId: string): string {
	const item = comments.threadById.value.get(threadId)
	if (!item) return ''
	const status = statusWord(item.status) + (item.missingVariants.length ? `, ${t('comments.staleWord')}` : '')
	return t('comments.pinLabel', {
		name: item.author?.displayName ?? t('comments.unknownAuthor'),
		type: typeById.value.get(item.anchor.widgetId) ?? 'Widget',
		id: item.anchor.widgetId,
		status,
		n: item.messageCount,
	}, item.messageCount)
}

// ---------------------------------------------------------------------------------------------
// Drag to move a pin within its Widget (pin-hint decision 4: one write on drop)
// ---------------------------------------------------------------------------------------------

const drag = ref<{ threadId: string; x: number; y: number; hint: { x: number; y: number } }>()

function invert(point: { x: number; y: number }, mapping: AffineOuterMapping): { x: number; y: number } | undefined {
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

// ---------------------------------------------------------------------------------------------
// What to draw
// ---------------------------------------------------------------------------------------------

type DrawnPin = Readonly<{ placement: PinPlacement; x: number; y: number }>

const visible = computed(() => comments.placements.value.filter(placement => placement.state === 'visible' && placement.point))
const pending = computed(() => visible.value.find(placement => placement.threadId === PENDING_PIN_ID))

/** The open (and dragged) thread is drawn on its own; the rest may merge into count clusters. */
const groups = computed(() => {
	const open = comments.openThreadId.value
	const solo: DrawnPin[] = []
	const rest: PinPlacement[] = []
	for (const placement of visible.value) {
		if (placement.threadId === PENDING_PIN_ID) continue
		if (placement.threadId === open || placement.threadId === drag.value?.threadId || placement.threadId === comments.hoveredThreadId.value) {
			const dragged = drag.value?.threadId === placement.threadId ? drag.value : undefined
			solo.push({ placement, x: dragged?.x ?? placement.point!.x, y: dragged?.y ?? placement.point!.y })
		}
		else rest.push(placement)
	}
	const clusters = clusterPins(rest)
	const byId = new Map(rest.map(placement => [placement.threadId, placement]))
	const singles: DrawnPin[] = []
	const merged: { x: number; y: number; threadIds: readonly string[] }[] = []
	for (const cluster of clusters) {
		if (cluster.threadIds.length === 1) {
			const placement = byId.get(cluster.threadIds[0]!)!
			singles.push({ placement, x: placement.point!.x, y: placement.point!.y })
		}
		else merged.push({ x: cluster.point.x, y: cluster.point.y, threadIds: cluster.threadIds })
	}
	return { solo, singles, merged }
})

function pinProps(drawn: DrawnPin) {
	const item = comments.threadById.value.get(drawn.placement.threadId)
	const resolved = item?.status === 'resolved'
	return {
		x: drawn.x,
		y: drawn.y,
		threadId: drawn.placement.threadId,
		label: pinLabel(drawn.placement.threadId),
		variant: resolved ? 'resolved' as const : 'default' as const,
		badge: item?.status === 'ready-for-review' ? 'ready' as const : item?.missingVariants.length ? 'stale' as const : undefined,
		initials: threadAuthorInitials(item?.author),
		agent: item?.author?.type === 'agent',
		open: comments.openThreadId.value === drawn.placement.threadId,
		lift: comments.hoveredThreadId.value === drawn.placement.threadId,
		fresh: comments.freshThreadIds.value.has(drawn.placement.threadId),
		dim: dimmed.value,
		draggable: comments.canComment.value && !resolved && !dimmed.value && !!props.mapping,
	}
}

function toggle(threadId: string): void {
	if (comments.openThreadId.value === threadId) comments.close()
	else comments.open(threadId)
}

function clusterItems(threadIds: readonly string[]): DropdownMenuItem[] {
	return threadIds.map((id) => {
		const item = comments.threadById.value.get(id)
		return {
			label: item?.title ?? widgetLabel(item?.anchor.widgetId ?? ''),
			description: `${item?.author?.displayName ?? t('comments.unknownAuthor')} · ${widgetLabel(item?.anchor.widgetId ?? '')}`,
			icon: item?.status === 'ready-for-review' ? 'i-lucide-eye' : item?.status === 'resolved' ? 'i-lucide-circle-check' : 'i-lucide-circle-dot',
			onSelect: () => { comments.open(id) },
		}
	})
}

const EDGE_ICON = { top: 'i-lucide-chevron-up', right: 'i-lucide-chevron-right', bottom: 'i-lucide-chevron-down', left: 'i-lucide-chevron-left' } as const
const EDGE_OFFSET = { top: 'translate(-50%, 0)', bottom: 'translate(-50%, -100%)', left: 'translate(0, -50%)', right: 'translate(-100%, -50%)' } as const

/** Opens the first thread behind an edge indicator. It never scrolls the iframe (decision 7). */
function openEdge(threadIds: readonly string[]): void {
	const first = threadIds[0]
	if (first) comments.open(first)
}
</script>

<template>
  <div
    ref="layer"
    class="pointer-events-none absolute inset-0"
    data-comment-pins
  >
    <template v-if="!comments.pinsHidden.value">
      <UDropdownMenu
        v-for="cluster in groups.merged"
        :key="cluster.threadIds.join(':')"
        :items="clusterItems(cluster.threadIds)"
        :content="{ align: 'start', side: 'right', sideOffset: 6 }"
      >
        <CommentPin
          :x="cluster.x"
          :y="cluster.y"
          variant="cluster"
          :count="cluster.threadIds.length"
          :dim="dimmed"
          :label="t('comments.clusterLabel', cluster.threadIds.length)"
          data-pin-cluster
        />
      </UDropdownMenu>
      <CommentPin
        v-for="drawn in [...groups.singles, ...groups.solo]"
        :key="drawn.placement.threadId"
        v-bind="pinProps(drawn)"
        @activate="toggle(drawn.placement.threadId)"
        @drag-move="point => dragTo(drawn.placement.threadId, point.clientX, point.clientY)"
        @drag-end="point => dropAt(drawn.placement.threadId, point.clientX, point.clientY)"
        @drag-cancel="drag = undefined"
      />
      <button
        v-for="edge in comments.edgeIndicators.value"
        :key="`${edge.scope}:${edge.side}`"
        type="button"
        class="comment-edge"
        :class="{ 'is-dim': dimmed }"
        :style="{ left: `${edge.point.x}px`, top: `${edge.point.y}px`, transform: EDGE_OFFSET[edge.side] }"
        :aria-label="t('comments.edgeLabel', edge.threadIds.length)"
        :data-edge-threads="edge.threadIds.join(' ')"
        :data-edge-side="edge.side"
        @click="openEdge(edge.threadIds)"
      >
        <UIcon
          :name="EDGE_ICON[edge.side]"
          class="size-3.5"
        />
        <span>{{ edge.threadIds.length }}</span>
      </button>
    </template>
    <CommentPin
      v-if="pending"
      :x="pending.point!.x"
      :y="pending.point!.y"
      variant="pending"
      :thread-id="PENDING_PIN_ID"
      :label="t('comment.placeholder')"
      fresh
      aria-hidden="true"
      tabindex="-1"
    />
  </div>
</template>

<style scoped>
.comment-edge {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 6px 0 4px;
  border: 0;
  border-radius: 999px;
  background: var(--wb-pin);
  color: var(--wb-pin-text);
  font-size: var(--text-xs);
  line-height: 1rem;
  font-weight: 600;
  box-shadow: var(--wb-shadow-pin);
  pointer-events: auto;
  cursor: pointer;
  z-index: 2;
}
.comment-edge:focus-visible { outline: 2px solid var(--ui-primary); outline-offset: 3px; }
.comment-edge.is-dim { opacity: 0.4; pointer-events: none; }
</style>
