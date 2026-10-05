<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { navigateTo, useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { flowPath } from '../../utils/workbench-routes'
import FlowCreateModal from '../../components/flows/FlowCreateModal.vue'

/**
 * UX Flows. On tablet and desktop the first Flow opens (the sidebar keeps the list); on a phone this
 * is the list itself. With no Flows, it says what a Flow is and, on desktop, offers to create one.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { flows, loading, isReadOnly } = workbench
const isTablet = useMediaQuery(WORKBENCH_BREAKPOINTS.tablet)
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const canCreate = computed(() => !isReadOnly.value && isDesktop.value && workbench.workspace.value?.inspection?.state !== 'migration_required')
const createOpen = ref(false)

watch([flows, isTablet, loading], () => {
	if (!isTablet.value || loading.value || !flows.value.length) return
	void navigateTo(flowPath(flows.value[0]!.key), { replace: true })
}, { immediate: true })

function onCreated(flowId: string): void {
	void navigateTo(flowPath(flowId))
}
</script>

<template>
  <UDashboardPanel
    id="flows"
    :ui="{ body: 'gap-0 p-0 sm:p-0' }"
  >
    <template #body>
      <main
        id="main"
        data-landmark="main"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        :aria-label="t('nav.flows')"
      >
        <div class="flex items-center justify-between gap-3 px-4 pt-6 pb-3">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('flows.title') }}
          </h1>
          <UButton
            v-if="canCreate && flows.length"
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-plus"
            :label="t('flows.newFlow')"
            @click="createOpen = true"
          />
        </div>
        <UEmpty
          v-if="!flows.length && !loading"
          icon="i-lucide-workflow"
          :title="t('flows.list.empty')"
          variant="naked"
          :actions="canCreate ? [{ label: t('flows.newFlow'), icon: 'i-lucide-plus', color: 'primary', variant: 'solid', onClick: () => { createOpen = true } }] : undefined"
        >
          <template #description>
            <i18n-t
              :keypath="canCreate ? 'flows.list.emptyHint' : 'flows.list.emptyHintReadOnly'"
              tag="span"
              scope="global"
            >
              <template #tool>
                <code class="rounded-sm bg-elevated px-1 py-0.5 font-mono text-xs text-highlighted">create_flow</code>
              </template>
            </i18n-t>
          </template>
        </UEmpty>
        <ul
          v-else
          class="divide-y divide-default border-y border-default"
          :aria-label="t('flows.list.label')"
        >
          <li
            v-for="flow in flows"
            :key="flow.key"
          >
            <ULink
              :to="flowPath(flow.key)"
              class="flex min-h-(--wb-target) items-center gap-3 px-4 py-3 text-sm text-default hover:bg-muted"
            >
              <UIcon
                name="i-lucide-workflow"
                class="size-4 shrink-0 text-dimmed"
              />
              <span class="min-w-0 flex-1 truncate font-medium text-highlighted">{{ flow.summary.name || t('flows.list.unnamed') }}</span>
              <UBadge
                v-if="flow.diagnosticCount"
                color="error"
                variant="subtle"
                size="sm"
                icon="i-lucide-circle-alert"
              >
                {{ t('flows.toolbar.problems', flow.diagnosticCount) }}
              </UBadge>
              <UIcon
                name="i-lucide-chevron-right"
                class="size-4 shrink-0 text-dimmed"
              />
            </ULink>
          </li>
        </ul>
        <FlowCreateModal
          v-if="canCreate"
          v-model:open="createOpen"
          @created="onCreated"
        />
      </main>
    </template>
  </UDashboardPanel>
</template>
