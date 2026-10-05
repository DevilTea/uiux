<script setup lang="ts">
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import WorkspaceSettingsPanel from '../../components/WorkspaceSettingsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'
import LockBadge from '../../components/workbench/LockBadge.vue'
import { useAccess } from '../../composables/useAccess'

/** Workspace settings, mounted here until the settings page (brief g, R10) replaces the panel. */
const { t } = useI18n()
const workbench = useWorkbench()
const { workspace, authorReadOnly } = workbench
const access = useAccess()
</script>

<template>
  <WorkbenchPage
    id="workspace-settings"
    :title="t('nav.settings')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col overflow-y-auto border-default lg:border-x">
      <LockBadge
        kind="workspace"
        resource-key="workspace"
        class="border-b border-default px-3 py-2"
      />
      <WorkspaceSettingsPanel
        :workspace="workspace"
        :read-only="authorReadOnly || !!access.lockFor('workspace', 'workspace')"
        @saved="workbench.refreshAll()"
        @reload="workbench.refreshAll()"
      />
    </div>
  </WorkbenchPage>
</template>
