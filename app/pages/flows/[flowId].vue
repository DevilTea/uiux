<script setup lang="ts">
import { computed } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { flowPath, viewLocation } from '../../utils/workbench-routes'
import FlowsPanel from '../../components/FlowsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'
import LockBadge from '../../components/workbench/LockBadge.vue'
import { useAccess } from '../../composables/useAccess'

/** One UX Flow; the sidebar lists the Flows, so the panel's own list is hidden. */
const { t } = useI18n()
const route = useRoute()
const workbench = useWorkbench()
const { views, authorReadOnly } = workbench
const access = useAccess()
const flowId = computed(() => String(route.params.flowId ?? ''))
</script>

<template>
  <WorkbenchPage
    id="flow"
    :title="t('nav.flows')"
  >
    <LockBadge
      kind="flow"
      :resource-key="flowId"
      class="border-b border-default px-3 py-2"
    />
    <FlowsPanel
      :flow-id="flowId"
      hide-list
      :available-views="views"
      :read-only="authorReadOnly || !!access.lockFor('flow', flowId)"
      @update:flow-id="(id: string) => navigateTo(flowPath(id))"
      @select-view="(id: string) => navigateTo(viewLocation(id))"
      @changed="workbench.refreshCounts()"
    />
  </WorkbenchPage>
</template>
