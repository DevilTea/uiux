<script setup lang="ts">
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import AssetsPanel from '../../components/AssetsPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/** Workspace Assets, mounted here until the Assets page (brief g, R10) replaces the panel. */
const { t } = useI18n()
const workbench = useWorkbench()
const { authorReadOnly } = workbench
</script>

<template>
  <WorkbenchPage
    id="workspace-assets"
    :title="t('nav.assets')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col border-default lg:border-x">
      <AssetsPanel
        :read-only="authorReadOnly"
        @changed="workbench.refreshCounts()"
      />
    </div>
  </WorkbenchPage>
</template>
