<script setup lang="ts">
import { nextTick, onMounted } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import WorkspaceSettingsPanel from '../../components/WorkspaceSettingsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/**
 * Adapters. Until the Adapters and Catalog page (brief g, R10) exists, this opens Workspace
 * settings at its Adapters section, where the Adapter set is edited today.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { workspace, isReadOnly } = workbench

onMounted(async () => {
	await nextTick()
	document.getElementById('workspace-adapters')?.scrollIntoView({ block: 'start' })
})
</script>

<template>
  <WorkbenchPage
    id="workspace-adapters-page"
    :title="t('nav.adapters')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto border-default lg:border-x">
      <WorkspaceSettingsPanel
        :workspace="workspace"
        :read-only="isReadOnly"
        @saved="workbench.refreshAll()"
        @reload="workbench.refreshAll()"
      />
    </div>
  </WorkbenchPage>
</template>
