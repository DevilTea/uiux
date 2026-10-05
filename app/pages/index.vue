<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import { useI18n } from '#imports'
import { provideWorkbench } from '../composables/useWorkbench'
import WorkbenchHeader from '../components/workbench/WorkbenchHeader.vue'
import WorkbenchNav from '../components/workbench/WorkbenchNav.vue'
import PreviewCanvas from '../components/workbench/PreviewCanvas.vue'
import SpecPanel from '../components/workbench/SpecPanel.vue'
import InspectorPanel from '../components/workbench/InspectorPanel.vue'

const { t } = useI18n()
const workbench = provideWorkbench()
const { error } = workbench

onMounted(() => {
	workbench.preview.mount()
	void workbench.refreshAll()
})

onUnmounted(() => {
	workbench.preview.unmount()
})
</script>

<template>
  <main class="flex h-screen flex-col overflow-hidden bg-default text-default">
    <WorkbenchHeader />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="t('workbench.errors.title')"
      :description="error"
      :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', onClick: () => { void workbench.refreshAll() } }]"
      :ui="{ root: 'rounded-none border-b border-error/30' }"
    />

    <UDashboardGroup
      storage="local"
      storage-key="uiux-workbench"
      unit="px"
    >
      <UDashboardSidebar
        id="navigation"
        side="left"
        resizable
        :min-size="260"
        :max-size="560"
        :default-size="320"
        :toggle="false"
      >
        <WorkbenchNav />
      </UDashboardSidebar>

      <UDashboardPanel id="canvas">
        <template #body>
          <PreviewCanvas />
          <SpecPanel />
        </template>
      </UDashboardPanel>

      <UDashboardSidebar
        id="inspector"
        side="right"
        resizable
        :min-size="260"
        :max-size="520"
        :default-size="320"
        :toggle="false"
        :ui="{ root: 'border-s border-default' }"
      >
        <InspectorPanel />
      </UDashboardSidebar>
    </UDashboardGroup>
  </main>
</template>
