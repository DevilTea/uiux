<script setup lang="ts">
import { computed, nextTick, ref, useId } from 'vue'
import { useI18n } from '#imports'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import {
	NODE_HEIGHT,
	NODE_WIDTH,
	neighbourStep,
	projectFlowGraph,
	routeEdge,
	triggerLabel,
	type FlowEdge,
	type FlowNode,
	type FlowSelection,
} from '../../utils/flow-graph'

/**
 * The UX Flow graph (brief g, sections 5, 6 and 8): a layered DOM/SVG projection of the keyed-steps
 * model on the canvas ground. Nodes are buttons in one roving tab stop; arrow keys travel along
 * transitions. Edge labels are pointer shortcuts to a transition, which the inspector and the List
 * view also reach by keyboard. Positions are derived on every change and never persisted.
 */
const props = defineProps<{ selection?: FlowSelection; canPlay?: boolean }>()
const emit = defineEmits<{
	(e: 'select', selection: FlowSelection | undefined): void
	(e: 'activate', stepId: string): void
	(e: 'play'): void
}>()

const { t } = useI18n()
const editor = injectFlowEditor()
const { draft, problems } = editor
const markerId = useId()

const graph = computed(() => draft.value ? projectFlowGraph(draft.value) : undefined)
const nodeById = computed(() => new Map((graph.value?.nodes ?? []).map(node => [node.stepId, node])))

const problemsByStep = computed(() => {
	const counts = new Map<string, number>()
	for (const problem of problems.value) {
		// "Unreachable" is written on the node itself, so it is not counted again in the badge.
		if (problem.stepId && !problem.edgeKey && problem.kind !== 'unreachable') counts.set(problem.stepId, (counts.get(problem.stepId) ?? 0) + 1)
	}
	return counts
})
const problemEdges = computed(() => new Set(problems.value.map(problem => problem.edgeKey).filter(Boolean)))

type RoutedEdge = FlowEdge & { path: string; labelX: number; labelY: number; problem: boolean; dangling: boolean }

const routedEdges = computed<RoutedEdge[]>(() => {
	const current = graph.value
	if (!current) return []
	const lanes = new Map<string, number>()
	return current.edges.flatMap((edge) => {
		const source = nodeById.value.get(edge.sourceStepId)
		if (!source) return []
		const target = edge.resolved ? nodeById.value.get(edge.targetStepId) : undefined
		const pair = `${edge.sourceStepId}>${edge.resolved ? edge.targetStepId : '?'}`
		const lane = lanes.get(pair) ?? 0
		lanes.set(pair, lane + 1)
		const route = routeEdge(source, target, lane)
		return [{ ...edge, path: route.path, labelX: route.label.x, labelY: route.label.y, problem: problemEdges.value.has(edge.key), dangling: route.kind === 'dangling' }]
	})
})

const selectedStepId = computed(() => props.selection?.kind === 'step' ? props.selection.stepId : undefined)
const selectedEdgeKey = computed(() => props.selection?.kind === 'edge' ? props.selection.key : undefined)

/** The one node in the tab order: the selected step, else the entry step. */
const tabStop = computed(() => {
	const id = selectedStepId.value
	if (id && nodeById.value.has(id)) return id
	return graph.value?.nodes[0]?.stepId
})

const nodeButtons = ref<Record<string, HTMLButtonElement | undefined>>({})

async function focusStep(stepId: string | undefined): Promise<void> {
	if (!stepId) return
	emit('select', { kind: 'step', stepId })
	await nextTick()
	nodeButtons.value[stepId]?.focus()
	nodeButtons.value[stepId]?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

function onNodeKeydown(event: KeyboardEvent, node: FlowNode): void {
	const current = graph.value
	if (!current || event.altKey || event.metaKey || event.ctrlKey) return
	let next: string | undefined
	switch (event.key) {
		case 'ArrowRight': next = neighbourStep(current, node.stepId, 'next'); break
		case 'ArrowLeft': next = neighbourStep(current, node.stepId, 'previous'); break
		case 'ArrowDown': next = neighbourStep(current, node.stepId, 'down'); break
		case 'ArrowUp': next = neighbourStep(current, node.stepId, 'up'); break
		case 'Home': next = current.nodes[0]?.stepId; break
		case 'End': next = current.nodes[current.nodes.length - 1]?.stepId; break
		case 'Enter':
			event.preventDefault()
			emit('activate', node.stepId)
			return
		case 'Escape':
			if (!props.selection) return
			event.preventDefault()
			emit('select', undefined)
			return
		case 'p':
		case 'P':
			if (event.shiftKey || !props.canPlay) return
			event.preventDefault()
			emit('play')
			return
		default: return
	}
	event.preventDefault()
	void focusStep(next)
}

function nodeLabel(node: FlowNode): string {
	const parts = [
		editor.stepLabel(node.stepId),
		node.variantName ? t('flows.graph.variant', { variant: node.variantName }) : t('ctx.base'),
	]
	if (node.isEntry) parts.push(t('flows.graph.entry'))
	if (!node.reachable) parts.push(t('flows.unreachable'))
	else if (node.isTerminal) parts.push(t('flows.graph.end'))
	const count = problemsByStep.value.get(node.stepId) ?? 0
	if (count) parts.push(t('flows.toolbar.problems', count))
	return parts.join(', ')
}

function edgeAriaLabel(edge: RoutedEdge): string {
	return t('flows.graph.edgeLabel', {
		trigger: triggerLabel(edge.trigger),
		target: edge.resolved ? editor.stepLabel(edge.targetStepId) : t('flows.graph.missingStep'),
	})
}

defineExpose({ focusStep })
</script>

<template>
  <div
    class="flow-graph relative flex min-h-0 flex-1 overflow-auto bg-canvas"
    data-flow-graph
    @click.self="emit('select', undefined)"
  >
    <div
      v-if="graph"
      role="group"
      :aria-label="t('flows.graph.label')"
      :aria-describedby="`${markerId}-hint`"
      class="relative m-auto shrink-0"
      :style="{ width: `${graph.width}px`, height: `${graph.height}px` }"
      @click.self="emit('select', undefined)"
    >
      <p
        :id="`${markerId}-hint`"
        class="sr-only"
      >
        {{ t('flows.graph.keyboardHint') }}
      </p>

      <svg
        class="pointer-events-none absolute inset-0 overflow-visible"
        :width="graph.width"
        :height="graph.height"
        aria-hidden="true"
      >
        <defs>
          <marker
            v-for="tone in ['rest', 'selected', 'problem']"
            :id="`${markerId}-${tone}`"
            :key="tone"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path
              d="M 0 0 L 10 5 L 0 10 z"
              :class="`flow-arrow-${tone}`"
            />
          </marker>
        </defs>
        <path
          v-for="edge in routedEdges"
          :key="edge.key"
          :d="edge.path"
          class="flow-edge"
          :class="{
            'flow-edge-selected': selectedEdgeKey === edge.key,
            'flow-edge-problem': edge.problem && selectedEdgeKey !== edge.key,
          }"
          :marker-end="edge.dangling ? undefined : `url(#${markerId}-${selectedEdgeKey === edge.key ? 'selected' : edge.problem ? 'problem' : 'rest'})`"
        />
      </svg>

      <button
        v-for="edge in routedEdges"
        :key="`label-${edge.key}`"
        type="button"
        tabindex="-1"
        class="absolute z-10 max-w-44 -translate-x-1/2 -translate-y-1/2 truncate rounded-sm border px-1.5 py-0.5 font-mono text-xs transition-colors duration-120"
        :class="selectedEdgeKey === edge.key
          ? 'border-selection bg-selection-subtle text-selection-text'
          : edge.problem
            ? 'border-error bg-default text-error hover:bg-elevated'
            : 'border-default bg-default text-muted hover:bg-elevated hover:text-default'"
        :style="{ left: `${edge.labelX}px`, top: `${edge.labelY}px` }"
        :title="edgeAriaLabel(edge)"
        :aria-label="edgeAriaLabel(edge)"
        :aria-pressed="selectedEdgeKey === edge.key"
        data-flow-edge
        @click="emit('select', { kind: 'edge', key: edge.key })"
      >
        {{ triggerLabel(edge.trigger) }}
      </button>

      <button
        v-for="node in graph.nodes"
        :key="node.stepId"
        :ref="(element) => { nodeButtons[node.stepId] = (element as HTMLButtonElement | null) ?? undefined }"
        type="button"
        class="flow-node absolute z-20 flex flex-col justify-center gap-1.5 rounded-lg border px-3 text-start transition-[background-color,border-color] duration-120"
        :class="[
          selectedStepId === node.stepId ? 'border-selection bg-selection-subtle' : 'border-accented bg-default hover:bg-muted',
          node.reachable ? '' : 'border-dashed',
        ]"
        :style="{ left: `${node.x}px`, top: `${node.y}px`, width: `${NODE_WIDTH}px`, height: `${NODE_HEIGHT}px` }"
        :tabindex="tabStop === node.stepId ? 0 : -1"
        :aria-label="nodeLabel(node)"
        :title="editor.stepLabel(node.stepId)"
        :aria-pressed="selectedStepId === node.stepId"
        :aria-keyshortcuts="canPlay ? 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter P' : 'ArrowLeft ArrowRight ArrowUp ArrowDown Home End Enter'"
        data-flow-node
        :data-step-id="node.stepId"
        @click="emit('select', { kind: 'step', stepId: node.stepId })"
        @dblclick="emit('activate', node.stepId)"
        @keydown="onNodeKeydown($event, node)"
      >
        <span class="flex min-w-0 items-center gap-1.5">
          <UIcon
            v-if="node.isEntry"
            name="i-lucide-flag"
            class="size-3.5 shrink-0"
            :class="selectedStepId === node.stepId ? 'text-selection-text' : 'text-muted'"
          />
          <span
            class="min-w-0 flex-1 truncate text-sm font-medium"
            :class="selectedStepId === node.stepId ? 'text-selection-text' : 'text-highlighted'"
          >{{ editor.stepLabel(node.stepId) }}</span>
          <UBadge
            v-if="problemsByStep.get(node.stepId)"
            color="error"
            variant="subtle"
            size="sm"
            icon="i-lucide-circle-alert"
            class="shrink-0"
          >
            {{ problemsByStep.get(node.stepId) }}
          </UBadge>
        </span>
        <span class="flex min-w-0 items-center gap-1.5">
          <UBadge
            v-if="node.variantName"
            color="neutral"
            variant="soft"
            size="sm"
            class="min-w-0 font-mono"
          >
            <span class="truncate">{{ node.variantName }}</span>
          </UBadge>
          <span
            v-else
            class="truncate text-xs text-muted"
          >{{ t('ctx.base') }}</span>
          <span
            v-if="!node.reachable"
            class="ms-auto shrink-0 text-xs font-medium text-error"
          >{{ t('flows.unreachable') }}</span>
          <span
            v-else-if="node.isTerminal"
            class="ms-auto shrink-0 text-xs text-dimmed"
          >{{ t('flows.graph.end') }}</span>
        </span>
      </button>
    </div>
  </div>
</template>

<style scoped>
/* The canvas texture (DESIGN.md "Canvas"): 1px dots at a 16px pitch. */
.flow-graph {
  background-image: radial-gradient(var(--wb-canvas-dot) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: 8px 8px;
  background-attachment: local;
}

.flow-edge {
  fill: none;
  stroke: var(--ui-border-accented);
  stroke-width: 1.5;
}
.flow-edge-selected {
  stroke: var(--ui-primary);
  stroke-width: 2;
}
.flow-edge-problem {
  stroke: var(--ui-error);
  stroke-dasharray: 4 3;
}
.flow-arrow-rest { fill: var(--ui-border-accented); }
.flow-arrow-selected { fill: var(--ui-primary); }
.flow-arrow-problem { fill: var(--ui-error); }

/* A step that just joined the Flow settles into place: opacity plus a 4px rise, 160ms. */
.flow-node {
  animation: flow-node-in 160ms var(--ease-out-quiet, cubic-bezier(0.2, 0, 0, 1)) both;
}
@keyframes flow-node-in {
  from { opacity: 0; translate: 0 4px; }
}
@media (prefers-reduced-motion: reduce) {
  @keyframes flow-node-in {
    from { opacity: 0; }
  }
}
</style>
