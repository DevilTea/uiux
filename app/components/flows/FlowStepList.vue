<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { injectFlowEditor } from '../../composables/useFlowEditor'
import { edgeKey, orderSteps, triggerLabel, type FlowSelection } from '../../utils/flow-graph'

/**
 * The Flow as an ordered list (brief g, section 9): every step in breadth-first order from the entry
 * step, each with its outgoing transitions. It is the graph's parallel accessible representation and
 * the phone layout. Selecting here selects the same step or transition as the graph.
 */
const props = defineProps<{ selection?: FlowSelection; interactive?: boolean }>()
const emit = defineEmits<{ (e: 'select', selection: FlowSelection): void }>()

const { t } = useI18n()
const editor = injectFlowEditor()
const { draft, problems } = editor

const rows = computed(() => {
	const current = draft.value
	if (!current) return []
	const { order, reachable } = orderSteps(current)
	return order.map((stepId, index) => {
		const step = current.steps[stepId]!
		return {
			stepId,
			ordinal: index + 1,
			variantName: step.target.variantName,
			isEntry: stepId === current.entryStepId,
			reachable: reachable.has(stepId),
			problemCount: problems.value.filter(problem => problem.stepId === stepId && !problem.edgeKey).length,
			transitions: step.transitions.map((transition, transitionIndex) => {
				const key = edgeKey(stepId, transitionIndex)
				return {
					key,
					trigger: triggerLabel(transition.trigger),
					target: current.steps[transition.targetStepId] ? editor.stepLabel(transition.targetStepId) : t('flows.graph.missingStep'),
					problem: problems.value.some(problem => problem.edgeKey === key),
				}
			}),
		}
	})
})

const selectedStepId = computed(() => props.selection?.kind === 'step' ? props.selection.stepId : undefined)
const selectedEdgeKey = computed(() => props.selection?.kind === 'edge' ? props.selection.key : undefined)
</script>

<template>
  <div class="min-h-0 flex-1 overflow-y-auto">
    <ol
      class="mx-auto max-w-3xl divide-y divide-default px-3 py-2 sm:px-4"
      :aria-label="t('flows.list.steps')"
      data-flow-list
    >
      <li
        v-for="row in rows"
        :key="row.stepId"
        class="py-3"
      >
        <component
          :is="interactive ? 'button' : 'div'"
          :type="interactive ? 'button' : undefined"
          class="flex w-full min-w-0 items-start gap-3 rounded-md px-2 py-1.5 text-start"
          :class="[
            interactive ? 'min-h-(--wb-target) hover:bg-muted' : '',
            selectedStepId === row.stepId ? 'bg-selection-subtle' : '',
          ]"
          :aria-pressed="interactive ? selectedStepId === row.stepId : undefined"
          @click="interactive && emit('select', { kind: 'step', stepId: row.stepId })"
        >
          <span class="mt-0.5 w-6 shrink-0 text-end font-mono text-xs text-dimmed tabular-nums">{{ row.ordinal }}</span>
          <span class="min-w-0 flex-1">
            <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span
                class="min-w-0 truncate text-sm font-medium"
                :class="selectedStepId === row.stepId ? 'text-selection-text' : 'text-highlighted'"
              >{{ editor.stepLabel(row.stepId) }}</span>
              <UBadge
                v-if="row.variantName"
                color="neutral"
                variant="soft"
                size="sm"
                class="font-mono"
              >{{ row.variantName }}</UBadge>
              <span
                v-else
                class="text-xs text-muted"
              >{{ t('ctx.base') }}</span>
              <UBadge
                v-if="row.isEntry"
                color="neutral"
                variant="outline"
                size="sm"
                icon="i-lucide-flag"
              >{{ t('flows.graph.entry') }}</UBadge>
              <UBadge
                v-if="!row.reachable"
                color="error"
                variant="subtle"
                size="sm"
                icon="i-lucide-circle-alert"
              >{{ t('flows.unreachable') }}</UBadge>
              <UBadge
                v-else-if="row.problemCount"
                color="error"
                variant="subtle"
                size="sm"
                icon="i-lucide-circle-alert"
              >{{ t('flows.toolbar.problems', row.problemCount) }}</UBadge>
            </span>
          </span>
        </component>

        <ul
          v-if="row.transitions.length"
          class="mt-1 space-y-0.5 ps-11"
          :aria-label="t('flows.list.transitionsOf', { step: editor.stepLabel(row.stepId) })"
        >
          <li
            v-for="transition in row.transitions"
            :key="transition.key"
          >
            <component
              :is="interactive ? 'button' : 'div'"
              :type="interactive ? 'button' : undefined"
              class="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md px-2 py-1 text-start text-sm"
              :class="[
                interactive ? 'min-h-(--wb-target) hover:bg-muted' : '',
                selectedEdgeKey === transition.key ? 'bg-selection-subtle text-selection-text' : 'text-default',
              ]"
              :aria-pressed="interactive ? selectedEdgeKey === transition.key : undefined"
              @click="interactive && emit('select', { kind: 'edge', key: transition.key })"
            >
              <span
                class="min-w-0 font-mono text-xs break-all"
                :class="transition.problem ? 'text-error' : 'text-muted'"
              >{{ transition.trigger }}</span>
              <span class="flex min-w-0 flex-1 basis-40 items-center gap-2">
                <UIcon
                  name="i-lucide-arrow-right"
                  class="size-3.5 shrink-0 text-dimmed"
                />
                <span class="sr-only">{{ t('flows.list.goesTo') }}</span>
                <span class="min-w-0 truncate">{{ transition.target }}</span>
              </span>
              <UIcon
                v-if="transition.problem"
                name="i-lucide-circle-alert"
                class="size-3.5 shrink-0 text-error"
              />
            </component>
          </li>
        </ul>
        <p
          v-else
          class="mt-1 ps-11 text-xs text-dimmed"
        >
          {{ t('flows.inspector.noOutgoing') }}
        </p>
      </li>
    </ol>
  </div>
</template>
