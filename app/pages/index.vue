<script setup lang="ts">
import { computed, ref } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { TableColumn, TabsItem } from '@nuxt/ui'
import { useWorkbench } from '../composables/useWorkbench'
import { viewLocation } from '../utils/workbench-routes'
import type { EvidenceContextSelection } from '../composables/workbench-types'
import ChecksPanel from '../components/ChecksPanel.vue'
import EvidencePanel from '../components/EvidencePanel.vue'
import HandoffPanel from '../components/HandoffPanel.vue'

/**
 * Overview: what is waiting for judgment, then the Views. Checks, Evidence and Handoff are
 * mounted here temporarily until the readiness work (brief f, R9) replaces them.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const {
	views, reviews, workspace, selectedView, discoveredLocales, localeRevisions, currentActiveContext,
	isReadOnly, authorReadOnly, readyReviewCount, openReviewCount, workspaceFindingCount, loading,
} = workbench

type ViewRow = { key: string; name: string; feature: string; findings: number; unresolved: number }

const rows = computed<ViewRow[]>(() => views.value.map(view => ({
	key: view.key,
	name: view.summary.name || t('common.unnamed'),
	feature: view.summary.feature ?? '',
	findings: view.diagnosticCount,
	unresolved: reviews.value.filter(review => review.summary.anchor?.viewId === view.key && review.summary.status !== 'resolved').length,
})))

const columns = computed<TableColumn<ViewRow>[]>(() => [
	{ accessorKey: 'name', header: t('overview.columns.view') },
	{ accessorKey: 'feature', header: t('overview.columns.feature') },
	{ accessorKey: 'unresolved', header: t('overview.columns.threads') },
	{ accessorKey: 'findings', header: t('overview.columns.findings') },
])

const waiting = computed(() => readyReviewCount.value + openReviewCount.value + workspaceFindingCount.value)

const tab = ref('views')
const tabs = computed<TabsItem[]>(() => [
	{ value: 'views', slot: 'views' as const, label: t('overview.tab.views') },
	{ value: 'checks', slot: 'checks' as const, label: t('overview.tab.checks'), badge: workspaceFindingCount.value ? { label: String(workspaceFindingCount.value), color: 'warning', variant: 'subtle', size: 'sm' } : undefined },
	{ value: 'evidence', slot: 'evidence' as const, label: t('overview.tab.evidence') },
	{ value: 'handoff', slot: 'handoff' as const, label: t('overview.tab.handoff') },
])

function openWidget(widgetId: string): void {
	if (selectedView.value) void navigateTo(viewLocation(selectedView.value.key, { widget: widgetId, panel: 'inspect' }))
}

function applyEvidenceContext(context: EvidenceContextSelection): void {
	void navigateTo(viewLocation(context.viewId, {
		variant: context.variantName,
		locale: context.locale,
		viewport: context.viewportId,
		theme: context.themeId,
	}))
}
</script>

<template>
  <UDashboardPanel
    id="overview"
    :ui="{ body: 'gap-0 p-0 sm:p-0' }"
  >
    <template #body>
      <main
        id="main"
        data-landmark="main"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
      >
        <div class="mx-auto w-full max-w-6xl space-y-1 px-4 pt-6 pb-4 sm:px-6">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('overview.title') }}
          </h1>
          <p
            class="text-body text-muted"
            role="status"
          >
            <template v-if="loading">
              {{ t('common.loading') }}
            </template>
            <template v-else-if="waiting">
              {{ t('overview.attention', { ready: readyReviewCount, open: openReviewCount, findings: workspaceFindingCount }) }}
            </template>
            <template v-else>
              {{ t('overview.allClear', views.length) }}
            </template>
          </p>
        </div>

        <UTabs
          v-model="tab"
          :items="tabs"
          variant="link"
          color="primary"
          :ui="{ root: 'mx-auto w-full max-w-6xl gap-0 px-4 sm:px-6', list: 'border-b border-default', content: 'min-h-0 pt-4 pb-8' }"
        >
          <template #views>
            <UTable
              :data="rows"
              :columns="columns"
              :loading="loading"
              :empty="t('workbench.views.emptyTitle')"
              :ui="{ th: 'text-xs font-medium text-muted', td: 'text-sm' }"
            >
              <template #name-cell="{ row }">
                <ULink
                  :to="viewLocation(row.original.key)"
                  class="font-medium text-highlighted hover:underline"
                >
                  {{ row.original.name }}
                </ULink>
              </template>
              <template #feature-cell="{ row }">
                <span class="font-mono text-xs text-muted">{{ row.original.feature }}</span>
              </template>
              <template #unresolved-cell="{ row }">
                <UBadge
                  v-if="row.original.unresolved"
                  color="annotation"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-circle-dot"
                >
                  {{ row.original.unresolved }}
                </UBadge>
                <span
                  v-else
                  class="text-dimmed"
                >0</span>
              </template>
              <template #findings-cell="{ row }">
                <UBadge
                  v-if="row.original.findings"
                  color="warning"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-triangle-alert"
                >
                  {{ row.original.findings }}
                </UBadge>
                <span
                  v-else
                  class="text-dimmed"
                >0</span>
              </template>
            </UTable>
          </template>

          <template #checks>
            <div class="flex min-h-96 flex-col overflow-hidden rounded-lg border border-default">
              <ChecksPanel
                :workspace-diagnostics="workspace?.diagnostics"
                :view-diagnostics="selectedView?.diagnostics"
                :view-ir="selectedView?.resource.ir"
                @select-widget="openWidget"
              />
            </div>
          </template>

          <template #evidence>
            <div class="flex min-h-96 flex-col overflow-hidden rounded-lg border border-default">
              <EvidencePanel
                :selected-view="selectedView"
                :all-views="views"
                :workspace="workspace"
                :discovered-locales="discoveredLocales"
                :locale-revisions="localeRevisions"
                :active-context="currentActiveContext"
                :read-only="authorReadOnly"
                @apply-context="applyEvidenceContext"
                @refresh="workbench.refreshAll()"
              />
            </div>
          </template>

          <template #handoff>
            <div class="flex min-h-96 flex-col overflow-hidden rounded-lg border border-default">
              <HandoffPanel
                :views="views"
                :read-only="isReadOnly"
              />
            </div>
          </template>
        </UTabs>
      </main>
    </template>
  </UDashboardPanel>
</template>
