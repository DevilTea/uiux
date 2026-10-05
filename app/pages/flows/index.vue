<script setup lang="ts">
import { navigateTo, useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { flowPath, viewLocation } from '../../utils/workbench-routes'
import FlowsPanel from '../../components/FlowsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/** UX Flows. The Flows panel is mounted here until the graph editor (brief g, R11) replaces it. */
const { t } = useI18n()
const workbench = useWorkbench()
const { views, isReadOnly } = workbench
</script>

<template>
  <WorkbenchPage
    id="flows"
    :title="t('nav.flows')"
  >
    <FlowsPanel
      :available-views="views"
      :read-only="isReadOnly"
      @update:flow-id="(id: string) => navigateTo(flowPath(id), { replace: true })"
      @select-view="(id: string) => navigateTo(viewLocation(id))"
      @changed="workbench.refreshCounts()"
    />
  </WorkbenchPage>
</template>
