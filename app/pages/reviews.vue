<script setup lang="ts">
import { navigateTo, useI18n } from '#imports'
import { useWorkbench } from '../composables/useWorkbench'
import { viewLocation } from '../utils/workbench-routes'
import ReviewsPanel from '../components/ReviewsPanel.vue'
import WorkbenchPage from '../components/workbench/WorkbenchPage.vue'

/**
 * The Reviews inbox. The Reviews panel is mounted here, across every View, until the
 * inbox (brief d, R8) replaces it.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { reviewReadOnly } = workbench

function openInCanvas(thread: { threadId: string; viewId: string; widgetId: string }): void {
	void navigateTo(viewLocation(thread.viewId, { widget: thread.widgetId, thread: thread.threadId }))
}
</script>

<template>
  <WorkbenchPage
    id="reviews"
    :title="t('inbox.title')"
  >
    <div class="mx-auto flex min-h-0 w-full max-w-3xl flex-1 flex-col border-default lg:border-x">
      <ReviewsPanel
        :read-only="reviewReadOnly"
        hide-comment-mode
        show-open-in-canvas
        @open-in-canvas="openInCanvas"
        @changed="workbench.refreshCounts()"
      />
    </div>
  </WorkbenchPage>
</template>
