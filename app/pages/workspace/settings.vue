<script setup lang="ts">
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import WorkspaceSettingsPanel from '../../components/WorkspaceSettingsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/** Workspace settings, mounted here until the settings page (brief g, R10) replaces the panel. */
const { t } = useI18n()
const workbench = useWorkbench()
const { workspace, isReadOnly } = workbench
</script>

<template>
  <WorkbenchPage
    id="workspace-settings"
    :title="t('nav.settings')"
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
