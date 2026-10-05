<script setup lang="ts">
import { computed } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { flowPath, viewLocation } from '../../utils/workbench-routes'
import FlowsPanel from '../../components/FlowsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/** One UX Flow; the sidebar lists the Flows, so the panel's own list is hidden. */
const { t } = useI18n()
const route = useRoute()
const workbench = useWorkbench()
const { views, isReadOnly } = workbench
const flowId = computed(() => String(route.params.flowId ?? ''))
</script>

<template>
  <WorkbenchPage
    id="flow"
    :title="t('nav.flows')"
  >
    <FlowsPanel
      :flow-id="flowId"
      hide-list
      :available-views="views"
      :read-only="isReadOnly"
      @update:flow-id="(id: string) => navigateTo(flowPath(id))"
      @select-view="(id: string) => navigateTo(viewLocation(id))"
      @changed="workbench.refreshCounts()"
    />
  </WorkbenchPage>
</template>
