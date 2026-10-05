<script setup lang="ts">
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import LocalesPanel from '../../components/LocalesPanel.vue'
import WorkbenchPage from '../../components/workbench/WorkbenchPage.vue'

/** Workspace Locales, mounted here until the Locales table (brief g, R10) replaces the panel. */
const { t } = useI18n()
const workbench = useWorkbench()
const { workspace, isReadOnly } = workbench
</script>

<template>
  <WorkbenchPage
    id="workspace-locales"
    :title="t('nav.locales')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col border-default lg:border-x">
      <LocalesPanel
        :default-locale="workspace?.resource?.i18n?.defaultLocale"
        :read-only="isReadOnly"
        @locales-changed="workbench.refreshAll()"
      />
    </div>
  </WorkbenchPage>
</template>
