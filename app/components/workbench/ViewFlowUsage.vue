<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useViewFlowUsage } from '../../composables/useViewFlowUsage'
import { flowStepLocation } from '../../utils/workbench-routes'
import WbDiagnosticList from './WbDiagnosticList.vue'

/**
 * The UX Flows that step through this View and the Variant each step opens (Rule
 * 01a116f0-89b6-7d08-a850-e1ee1aecd51f). Read-only on every layout; each step links to its Flow with
 * that step selected. An invalid Flow is listed with its diagnostics; one that cannot be read at all
 * is named apart, because whether it uses the View is unknown.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const viewId = computed(() => workbench.selectedViewId.value ?? '')
const { usage, loading } = useViewFlowUsage(viewId)
const pending = computed(() => loading.value || workbench.loading.value)
const flowName = (name: string | undefined) => name || t('flowUsage.unnamed')
</script>

<template>
  <div
    class="min-h-0 flex-1 overflow-y-auto px-4 py-3"
    data-view-flow-usage
  >
    <h2 class="text-sm font-semibold text-highlighted">
      {{ t('flowUsage.title') }}
    </h2>
    <p
      v-if="pending"
      class="mt-2 text-sm text-muted"
      role="status"
    >
      {{ t('flowUsage.loading') }}
    </p>
    <template v-else>
      <p
        v-if="!usage.flows.length && !usage.unreadable.length"
        class="mt-2 text-sm text-muted"
        data-flow-usage-empty
      >
        {{ t('flowUsage.empty') }}
      </p>
      <ul
        v-if="usage.flows.length"
        class="mt-2 space-y-4"
        :aria-label="t('flowUsage.list')"
      >
        <li
          v-for="flow in usage.flows"
          :key="flow.flowKey"
          data-flow-usage-flow
        >
          <div class="flex min-w-0 items-center gap-2">
            <NuxtLink
              :to="flowStepLocation(flow.flowKey)"
              class="min-w-0 truncate text-sm font-medium text-highlighted underline-offset-2 hover:underline"
              :aria-label="t('flowUsage.openFlow', { flow: flowName(flow.name) })"
            >
              {{ flowName(flow.name) }}
            </NuxtLink>
          </div>
          <div
            v-if="flow.diagnostics.length"
            class="mt-1 text-xs text-error"
            data-flow-usage-diagnostics
          >
            <p class="font-medium">
              {{ t('flowUsage.invalid') }}
            </p>
            <WbDiagnosticList
              :diagnostics="flow.diagnostics"
              :details="false"
            />
          </div>
          <ul
            class="mt-1 space-y-0.5"
            :aria-label="t('flowUsage.steps', { flow: flowName(flow.name) })"
          >
            <li
              v-for="step in flow.steps"
              :key="step.stepId"
            >
              <NuxtLink
                :to="flowStepLocation(flow.flowKey, step.stepId)"
                class="flex min-h-(--wb-target) min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-muted"
                :aria-label="t('flowUsage.open', { flow: flowName(flow.name), n: step.ordinal })"
                data-flow-usage-step
              >
                <span class="shrink-0 font-mono text-xs text-dimmed tabular-nums">{{ t('flowUsage.step', { n: step.ordinal }) }}</span>
                <UBadge
                  v-if="step.variantName"
                  color="neutral"
                  variant="soft"
                  size="sm"
                  class="font-mono"
                >
                  {{ step.variantName }}
                </UBadge>
                <span
                  v-else
                  class="text-xs text-muted"
                >{{ t('ctx.base') }}</span>
              </NuxtLink>
            </li>
          </ul>
        </li>
      </ul>
      <section
        v-if="usage.unreadable.length"
        class="mt-4"
        data-flow-usage-unreadable
      >
        <h3 class="text-xs font-semibold text-muted">
          {{ t('flowUsage.unreadableTitle') }}
        </h3>
        <p class="mt-0.5 text-xs text-muted">
          {{ t('flowUsage.unreadableHint') }}
        </p>
        <ul class="mt-1 space-y-2">
          <li
            v-for="flow in usage.unreadable"
            :key="flow.flowKey"
          >
            <NuxtLink
              :to="flowStepLocation(flow.flowKey)"
              class="text-sm text-highlighted underline-offset-2 hover:underline"
            >
              {{ flowName(flow.name) }}
            </NuxtLink>
            <WbDiagnosticList
              v-if="flow.diagnostics.length"
              class="text-xs text-error"
              :diagnostics="flow.diagnostics"
              :details="false"
            />
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>
