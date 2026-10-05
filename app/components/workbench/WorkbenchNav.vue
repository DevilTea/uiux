<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { useI18n } from '#imports'
import type { TabsItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { ActivePanel } from '../../composables/workbench-types'
import ViewNavigator from './ViewNavigator.vue'
import WorkspaceSettingsPanel from '../WorkspaceSettingsPanel.vue'
import LocalesPanel from '../LocalesPanel.vue'
import AssetsPanel from '../AssetsPanel.vue'
import FlowsPanel from '../FlowsPanel.vue'
import ReviewsPanel from '../ReviewsPanel.vue'
import ChecksPanel from '../ChecksPanel.vue'
import EvidencePanel from '../EvidencePanel.vue'
import HandoffPanel from '../HandoffPanel.vue'

/** Left rail: section tabs (role=tablist) and the active section panel (role=tabpanel). */
const { t } = useI18n()
const workbench = useWorkbench()
const {
	activeNav,
	views,
	workspace,
	selectedView,
	selectedViewId,
	selectedWidgetId,
	discoveredLocales,
	localeRevisions,
	currentActiveContext,
	isReadOnly,
	preview,
} = workbench

const reviewsPanelRef = ref<InstanceType<typeof ReviewsPanel>>()

preview.onCommentTarget(async (widgetId) => {
	activeNav.value = 'reviews'
	await nextTick()
	reviewsPanelRef.value?.openCreateModal(widgetId)
})

function countBadge(count: number): TabsItem['badge'] {
	return { label: String(count), color: 'neutral', variant: 'soft', size: 'sm' }
}

const items = computed<TabsItem[]>(() => [
	{ value: 'views', slot: 'views' as const, label: t('workbench.nav.views'), badge: countBadge(views.value.length) },
	{ value: 'workspace', slot: 'workspace' as const, label: t('workbench.nav.workspace') },
	{ value: 'locales', slot: 'locales' as const, label: t('workbench.nav.locales'), badge: countBadge(workbench.localeCount.value) },
	{ value: 'assets', slot: 'assets' as const, label: t('workbench.nav.assets'), badge: countBadge(workbench.assetCount.value) },
	{ value: 'flows', slot: 'flows' as const, label: t('workbench.nav.flows'), badge: countBadge(workbench.flowCount.value) },
	{ value: 'reviews', slot: 'reviews' as const, label: t('workbench.nav.reviews'), badge: countBadge(workbench.reviewCount.value) },
	{
		value: 'checks',
		slot: 'checks' as const,
		label: t('workbench.nav.checks'),
		...(workbench.checkCount.value > 0
			? { badge: { label: String(workbench.checkCount.value), color: 'warning', variant: 'soft', size: 'sm' } }
			: {}),
	},
	{ value: 'evidence', slot: 'evidence' as const, label: t('workbench.nav.evidence') },
	{ value: 'handoff', slot: 'handoff' as const, label: t('workbench.nav.handoff') },
])

const activeModel = computed({
	get: () => activeNav.value,
	set: (value: string | number) => { activeNav.value = value as ActivePanel },
})

async function onCountsChanged() {
	await workbench.refreshCounts()
}

async function onWorkspaceChanged() {
	await workbench.refreshAll()
}

async function onViewPromoted() {
	await workbench.loadSelectedView(workbench.preview.notifyIframeContext)
	await workbench.refreshAll()
}
</script>

<template>
  <UTabs
    v-model="activeModel"
    :items="items"
    variant="pill"
    size="xs"
    :aria-label="t('workbench.nav.label')"
    :ui="{
      root: 'flex min-h-0 flex-1 flex-col gap-0',
      list: 'grid shrink-0 grid-cols-3 gap-1 rounded-none border-b border-default bg-default p-2',
      indicator: 'hidden',
      trigger: 'min-w-0 justify-center data-[state=active]:bg-primary data-[state=active]:text-inverted',
      content: 'flex min-h-0 flex-1 flex-col focus-visible:outline-2 focus-visible:-outline-offset-2',
    }"
  >
    <template #views>
      <ViewNavigator />
    </template>

    <template #workspace>
      <WorkspaceSettingsPanel
        :workspace="workspace"
        :read-only="isReadOnly"
        @saved="onWorkspaceChanged"
        @reload="onWorkspaceChanged"
      />
    </template>

    <template #locales>
      <LocalesPanel
        :default-locale="workspace?.resource?.i18n?.defaultLocale"
        :read-only="isReadOnly"
        @locales-changed="onWorkspaceChanged"
      />
    </template>

    <template #assets>
      <AssetsPanel
        :read-only="isReadOnly"
        @changed="onCountsChanged"
      />
    </template>

    <template #flows>
      <FlowsPanel
        :available-views="views"
        :current-view-id="selectedViewId"
        :read-only="isReadOnly"
        @select-view="workbench.selectView"
        @changed="onCountsChanged"
      />
    </template>

    <template #reviews>
      <ReviewsPanel
        ref="reviewsPanelRef"
        :current-view-id="selectedViewId"
        :selected-widget-id="selectedWidgetId"
        :current-view-revision="selectedView?.revision"
        :is-comment-mode="preview.isCommentMode.value"
        :read-only="isReadOnly"
        @highlight-widget="workbench.selectWidget"
        @toggle-comment-mode="preview.toggleCommentMode"
        @view-promoted="onViewPromoted"
        @changed="onCountsChanged"
      />
    </template>

    <template #checks>
      <ChecksPanel
        :workspace-diagnostics="workspace?.diagnostics"
        :view-diagnostics="selectedView?.diagnostics"
        :view-ir="selectedView?.resource.ir"
        @select-widget="workbench.selectWidget"
      />
    </template>

    <template #evidence>
      <EvidencePanel
        :selected-view="selectedView"
        :all-views="views"
        :workspace="workspace"
        :discovered-locales="discoveredLocales"
        :locale-revisions="localeRevisions"
        :active-context="currentActiveContext"
        :read-only="isReadOnly"
        @apply-context="workbench.applyEvidenceContext"
        @refresh="onWorkspaceChanged"
      />
    </template>

    <template #handoff>
      <HandoffPanel
        :views="views"
        :read-only="isReadOnly"
      />
    </template>
  </UTabs>
</template>
