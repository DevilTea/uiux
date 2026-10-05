<script setup lang="ts">
import { computed, ref } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TabsItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { EvidenceContextSelection, ViewPanelTab } from '../../composables/workbench-types'
import { viewLocation } from '../../utils/workbench-routes'
import ReviewsPanel from '../ReviewsPanel.vue'
import ChecksPanel from '../ChecksPanel.vue'
import EvidencePanel from '../EvidencePanel.vue'
import InspectorPanel from './InspectorPanel.vue'
import SpecPanel from './SpecPanel.vue'

/**
 * The View page's right panel: Comments, Inspect, Spec and Readiness (brief e). The existing
 * Reviews, Inspector, Spec, Checks and Evidence panels are mounted here until R5, R7 and R9
 * replace them.
 */
const tab = defineModel<ViewPanelTab>('tab', { required: true })
const emit = defineEmits<{ (e: 'threadSelected', threadId: string): void }>()

const { t } = useI18n()
const workbench = useWorkbench()
const {
	selectedView, selectedViewId, selectedWidgetId, reviews, views, workspace,
	discoveredLocales, localeRevisions, currentActiveContext, isReadOnly, preview,
} = workbench

const reviewsPanel = ref<InstanceType<typeof ReviewsPanel>>()

const unresolvedHere = computed(() => reviews.value.filter(review =>
	review.summary.anchor?.viewId === selectedViewId.value && review.summary.status !== 'resolved').length)
const findingsHere = computed(() => selectedView.value?.diagnostics.length ?? 0)

const items = computed<TabsItem[]>(() => [
	{ value: 'comments', slot: 'comments' as const, label: t('panel.comments'), badge: unresolvedHere.value ? { label: String(unresolvedHere.value), color: 'annotation', variant: 'soft', size: 'sm' } : undefined },
	{ value: 'inspect', slot: 'inspect' as const, label: t('panel.inspect') },
	{ value: 'spec', slot: 'spec' as const, label: t('panel.spec') },
	{ value: 'readiness', slot: 'readiness' as const, label: t('panel.readiness'), badge: findingsHere.value ? { label: String(findingsHere.value), color: 'warning', variant: 'soft', size: 'sm' } : undefined },
])

const tabModel = computed({
	get: () => tab.value,
	set: (value: string | number) => { tab.value = value as ViewPanelTab },
})

async function onViewPromoted(): Promise<void> {
	await workbench.loadSelectedView(preview.notifyIframeContext)
	await workbench.refreshAll()
}

function applyEvidenceContext(context: EvidenceContextSelection): void {
	void navigateTo(viewLocation(context.viewId, {
		variant: context.variantName,
		locale: context.locale,
		viewport: context.viewportId,
		theme: context.themeId,
	}))
}

defineExpose({
	openCreateModal: (widgetId?: string) => reviewsPanel.value?.openCreateModal(widgetId),
	selectThread: (threadId: string) => reviewsPanel.value?.selectReview(threadId),
})
</script>

<template>
  <UTabs
    v-model="tabModel"
    :items="items"
    variant="link"
    color="primary"
    :unmount-on-hide="false"
    :ui="{
      root: 'flex min-h-0 flex-1 flex-col gap-0',
      list: 'shrink-0 border-b border-default px-2',
      trigger: 'px-2',
      content: 'flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden',
    }"
  >
    <template #comments>
      <ReviewsPanel
        ref="reviewsPanel"
        :current-view-id="selectedViewId"
        :selected-widget-id="selectedWidgetId"
        :current-view-revision="selectedView?.revision"
        :is-comment-mode="preview.isCommentMode.value"
        :read-only="isReadOnly"
        @highlight-widget="workbench.selectWidget"
        @toggle-comment-mode="preview.toggleCommentMode"
        @view-promoted="onViewPromoted"
        @changed="workbench.refreshCounts()"
        @thread-selected="emit('threadSelected', $event)"
      />
    </template>
    <template #inspect>
      <InspectorPanel />
    </template>
    <template #spec>
      <SpecPanel />
    </template>
    <template #readiness>
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div class="flex min-h-64 flex-col border-b border-default">
          <ChecksPanel
            :workspace-diagnostics="workspace?.diagnostics"
            :view-diagnostics="selectedView?.diagnostics"
            :view-ir="selectedView?.resource.ir"
            @select-widget="workbench.selectWidget"
          />
        </div>
        <div class="flex min-h-96 flex-col">
          <EvidencePanel
            :selected-view="selectedView"
            :all-views="views"
            :workspace="workspace"
            :discovered-locales="discoveredLocales"
            :locale-revisions="localeRevisions"
            :active-context="currentActiveContext"
            :read-only="isReadOnly"
            @apply-context="applyEvidenceContext"
            @refresh="workbench.refreshAll()"
          />
        </div>
      </div>
    </template>
  </UTabs>
</template>
