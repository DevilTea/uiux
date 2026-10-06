<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { defineShortcuts, navigateTo, useI18n } from '#imports'
import type { TableColumn, TabsItem } from '@nuxt/ui'
import { useMediaQuery } from '../composables/useMediaQuery'
import { useReadiness } from '../composables/useReadiness'
import { useWorkbench } from '../composables/useWorkbench'
import { useWorkbenchShell } from '../composables/useWorkbenchShell'
import { splitReadinessDiagnostics, updatedSince } from '../utils/readiness'
import { viewLocation } from '../utils/workbench-routes'
import WorkbenchPage from '../components/workbench/WorkbenchPage.vue'
import OverviewChecks from '../components/readiness/OverviewChecks.vue'
import OverviewActivity from '../components/readiness/OverviewActivity.vue'
import HandoffExportModal from '../components/readiness/HandoffExportModal.vue'
import WorkspaceFirstRun from '../components/workbench/WorkspaceFirstRun.vue'

/**
 * Overview (brief f): one line of what needs attention, then every View with its readiness.
 * Checks and Activity are tabs here; Evidence and Handoff live in each View's Readiness tab and
 * in the Export handoff dialog. There is no top-level Checks, Evidence or Handoff destination.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const readiness = useReadiness()
const { views, reviews, loading, isReadOnly, authorReadOnly, readyReviewCount, openReviewCount, workspaceFindingCount } = workbench
const atLeastTablet = useMediaQuery('(min-width: 768px)')

type ReadinessState = 'ready' | 'blocked' | 'checking' | 'failed' | 'migration'
type ViewRow = Readonly<{
	key: string
	name: string
	feature: string
	updated: boolean
	ready: number
	open: number
	findings: number
	evidence: Readonly<{ total: number; fresh: number; stale: number; unknown: number }>
	readiness: ReadinessState
	blocking: number
}>

const rows = computed<ViewRow[]>(() => views.value.map((view) => {
	const threads = reviews.value.filter(review => review.summary.anchor?.viewId === view.key)
	const entry = readiness.viewAssessment(view.key)
	const blocking = splitReadinessDiagnostics(entry?.readiness?.blockingDiagnostics).blocking.length
	// An older Workspace schema cannot be assessed until it is migrated: say that, not "blocked".
	const state: ReadinessState = workbench.writeBlocked.value
		? 'migration'
		: !entry || entry.status === 'loading' && !entry.readiness
		? 'checking'
		: entry.status === 'failed' ? 'failed' : entry.readiness?.implementationReady ? 'ready' : 'blocked'
	return {
		key: view.key,
		name: view.summary.name || t('common.unnamed'),
		feature: view.summary.feature ?? '',
		updated: updatedSince(readiness.lastSeen.value, `view:${view.key}`, view.revision),
		ready: threads.filter(review => review.summary.status === 'ready-for-review').length,
		open: threads.filter(review => (review.summary.status ?? 'open') === 'open').length,
		findings: view.diagnosticCount,
		evidence: readiness.evidenceSummary(view.key),
		readiness: state,
		blocking,
	}
}))

// ----- Filters --------------------------------------------------------------------------------

const query = ref('')
const feature = ref('all')
const readinessFilter = ref<'all' | 'ready' | 'blocked'>('all')
const featureItems = computed(() => [
	{ label: t('overview.filter.allFeatures'), value: 'all' },
	...[...new Set(views.value.map(view => view.summary.feature).filter((value): value is string => !!value))].sort().map(value => ({ label: value, value })),
])
const readinessItems = computed(() => [
	{ label: t('overview.filter.allReadiness'), value: 'all' },
	{ label: t('ready.ready'), value: 'ready' },
	{ label: t('overview.filter.blocked'), value: 'blocked' },
])
const filtered = computed(() => rows.value.filter((row) => {
	const text = query.value.trim().toLowerCase()
	if (text && !row.name.toLowerCase().includes(text) && !row.feature.toLowerCase().includes(text)) return false
	if (feature.value !== 'all' && row.feature !== feature.value) return false
	if (readinessFilter.value === 'ready' && row.readiness !== 'ready') return false
	if (readinessFilter.value === 'blocked' && row.readiness !== 'blocked' && row.readiness !== 'failed') return false
	return true
}))

// ----- Table ----------------------------------------------------------------------------------

const sorting = ref([{ id: 'name', desc: false }])
const READINESS_ORDER: Record<ReadinessState, number> = { failed: 0, blocked: 1, checking: 2, migration: 2, ready: 3 }
const columns = computed<TableColumn<ViewRow>[]>(() => [
	{ id: 'name', accessorKey: 'name', header: t('overview.columns.view') },
	{ id: 'feature', accessorKey: 'feature', header: t('overview.columns.feature') },
	{ id: 'reviews', accessorFn: row => row.ready * 1000 + row.open, header: t('overview.columns.reviews') },
	{ id: 'checks', accessorKey: 'findings', header: t('overview.columns.checks') },
	{ id: 'evidence', accessorFn: row => row.evidence.total ? row.evidence.stale * 1000 + row.evidence.unknown : -1, header: t('overview.columns.evidence') },
	{ id: 'readiness', accessorFn: row => READINESS_ORDER[row.readiness] * 1000 - row.blocking, header: t('overview.columns.readiness') },
])

function openRow(key: string): void {
	void navigateTo(viewLocation(key, { panel: 'readiness' }))
}

// ----- Attention line -------------------------------------------------------------------------

const assessedAll = computed(() => rows.value.length > 0 && rows.value.every(row => row.readiness === 'ready' || row.readiness === 'blocked'))
const readyViews = computed(() => rows.value.filter(row => row.readiness === 'ready').length)
const blockedViews = computed(() => rows.value.filter(row => row.readiness === 'blocked' || row.readiness === 'failed').length)

type AttentionPart = Readonly<{ key: string; text: string; to?: string; onClick?: () => void }>
/** What needs someone, in the order it is usually handled; zero counts are left out. */
const attention = computed<AttentionPart[]>(() => ([
	readyReviewCount.value ? { key: 'ready', text: t('overview.attentionReady', readyReviewCount.value), to: '/reviews' } : undefined,
	openReviewCount.value ? { key: 'open', text: t('overview.attentionOpen', openReviewCount.value), to: '/reviews' } : undefined,
	workspaceFindingCount.value ? { key: 'findings', text: t('overview.attentionFindings', workspaceFindingCount.value), onClick: () => { tab.value = 'checks' } } : undefined,
	blockedViews.value ? { key: 'blocked', text: t('overview.attentionBlocked', blockedViews.value), onClick: () => { tab.value = 'views'; readinessFilter.value = 'blocked' } } : undefined,
] as (AttentionPart | undefined)[]).filter((part): part is AttentionPart => !!part))

// ----- Tabs, data and shortcuts ---------------------------------------------------------------

const tab = ref('views')
const tabs = computed<TabsItem[]>(() => [
	{ value: 'views', slot: 'views' as const, label: t('overview.tab.views') },
	{ value: 'checks', slot: 'checks' as const, label: t('overview.tab.checks'), badge: workspaceFindingCount.value ? { label: String(workspaceFindingCount.value), color: 'neutral', variant: 'soft', size: 'sm' } : undefined },
	{ value: 'activity', slot: 'activity' as const, label: t('overview.tab.activity') },
])

const exportOpen = ref(false)
const canExport = computed(() => !isReadOnly.value && !authorReadOnly.value && atLeastTablet.value)

onMounted(() => { void readiness.loadEvidence() })
watch([views, readiness.signature], () => {
	for (const view of views.value) {
		if (readiness.isOutdated(readiness.viewAssessment(view.key))) void readiness.assessView(view.key)
	}
}, { immediate: true })

defineShortcuts(computed(() => ({
	...(shell.singleKeyShortcuts.value
		? { 1: () => { tab.value = 'views' }, 2: () => { tab.value = 'checks' }, 3: () => { tab.value = 'activity' } }
		: {}),
	meta_shift_e: () => { if (canExport.value) exportOpen.value = true },
})))

const READINESS_BADGE: Record<ReadinessState, { color: 'success' | 'error' | 'neutral'; icon: string }> = {
	ready: { color: 'success', icon: 'i-lucide-badge-check' },
	blocked: { color: 'error', icon: 'i-lucide-circle-x' },
	failed: { color: 'error', icon: 'i-lucide-circle-alert' },
	checking: { color: 'neutral', icon: 'i-lucide-loader-circle' },
	migration: { color: 'neutral', icon: 'i-lucide-database' },
}

function readinessLabel(row: ViewRow): string {
	if (row.readiness === 'ready') return t('ready.ready')
	if (row.readiness === 'checking') return t('ready.checking')
	if (row.readiness === 'failed') return t('overview.readinessFailed')
	if (row.readiness === 'migration') return t('overview.readinessMigration')
	return row.blocking ? t('ready.blockedBy', row.blocking) : t('ready.notReadyShort')
}

function evidenceLabel(row: ViewRow): { text: string; icon: string; tone: string } {
	const evidence = row.evidence
	if (!evidence.total) return { text: t('overview.evidence.none'), icon: 'i-lucide-circle-dashed', tone: 'text-dimmed' }
	if (evidence.stale && evidence.fresh) return { text: t('overview.evidence.mixed', { fresh: evidence.fresh, stale: evidence.stale }), icon: 'i-lucide-history', tone: 'text-warning' }
	if (evidence.stale) return { text: t('overview.evidence.stale', evidence.stale), icon: 'i-lucide-history', tone: 'text-warning' }
	if (evidence.fresh) return { text: t('overview.evidence.fresh', evidence.fresh), icon: 'i-lucide-circle-check', tone: 'text-success' }
	return { text: t('overview.evidence.unknown'), icon: 'i-lucide-circle-help', tone: 'text-muted' }
}
</script>

<template>
  <WorkbenchPage
    id="overview"
    :title="t('overview.title')"
  >
    <div class="min-h-0 flex-1 overflow-y-auto">
      <div class="mx-auto w-full max-w-6xl px-4 pt-6 pb-2 sm:px-6">
        <div class="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
          <div class="min-w-0 space-y-1">
            <h1 class="text-headline font-semibold text-highlighted">
              {{ t('overview.title') }}
            </h1>
            <div
              class="text-display font-semibold text-highlighted"
              role="status"
              data-attention
            >
              <template v-if="loading">
                <USkeleton class="h-8 w-80 max-w-full" />
              </template>
              <template v-else-if="!views.length">
                {{ t('firstRun.headline') }}
              </template>
              <template v-else-if="attention.length">
                <span class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <template
                    v-for="(part, index) in attention"
                    :key="part.key"
                  >
                    <span
                      v-if="index"
                      class="text-dimmed"
                      aria-hidden="true"
                    >·</span>
                    <ULink
                      v-if="part.to"
                      :to="part.to"
                      class="text-highlighted hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                    >{{ part.text }}</ULink>
                    <button
                      v-else
                      type="button"
                      class="text-highlighted hover:underline pointer-coarse:min-h-11"
                      :data-attention-part="part.key"
                      @click="part.onClick?.()"
                    >
                      {{ part.text }}
                    </button>
                  </template>
                </span>
              </template>
              <!-- An older schema is not "all clear": Reviews and readiness cannot be read yet. -->
              <span
                v-else-if="workbench.writeBlocked.value"
                class="text-title font-medium text-muted"
                data-attention-migration
              >
                {{ t('overview.migrationWaiting') }}
              </span>
              <span
                v-else
                class="inline-flex items-center gap-2"
              >
                <UIcon
                  name="i-lucide-circle-check"
                  class="size-6 text-success"
                />
                {{ assessedAll ? t('overview.allClear', readyViews) : t('overview.nothingWaiting') }}
              </span>
            </div>
          </div>
          <UButton
            v-if="canExport && views.length"
            icon="i-lucide-package"
            class="mt-1"
            data-export-open
            @click="exportOpen = true"
          >
            {{ t('handoff.export') }}
          </UButton>
        </div>
      </div>

      <WorkspaceFirstRun v-if="!loading && !views.length && !isReadOnly" />
      <UEmpty
        v-else-if="!loading && !views.length"
        icon="i-lucide-app-window"
        variant="naked"
        class="py-16"
        :title="t('overview.empty.title')"
        :actions="[{ label: t('common.refresh'), icon: 'i-lucide-refresh-cw', onClick: () => { void workbench.refreshAll() } }]"
      >
        <template #description>
          <i18n-t
            keypath="overview.empty.description"
            tag="span"
            scope="global"
          >
            <template #tool>
              <code class="rounded-sm bg-elevated px-1 py-0.5 font-mono text-xs text-highlighted">create_view</code>
            </template>
          </i18n-t>
        </template>
      </UEmpty>

      <UTabs
        v-else
        v-model="tab"
        :items="tabs"
        variant="link"
        color="primary"
        :ui="{ root: 'mx-auto w-full max-w-6xl gap-0 px-4 sm:px-6', list: 'border-b border-default', content: 'min-h-0 pt-4 pb-10' }"
      >
        <template #views>
          <div class="space-y-3">
            <div class="flex flex-wrap items-center gap-2">
              <UInput
                v-model="query"
                icon="i-lucide-search"
                :placeholder="t('overview.filter.search')"
                :aria-label="t('overview.filter.search')"
                class="w-full sm:w-64"
              />
              <USelect
                v-if="featureItems.length > 2"
                v-model="feature"
                :items="featureItems"
                :aria-label="t('overview.columns.feature')"
                class="w-40"
              />
              <USelect
                v-model="readinessFilter"
                :items="readinessItems"
                :aria-label="t('overview.columns.readiness')"
                class="w-40"
              />
              <span class="ms-auto text-sm text-muted tabular-nums">{{ t('overview.viewCount', filtered.length) }}</span>
            </div>

            <UTable
              v-if="atLeastTablet"
              v-model:sorting="sorting"
              :data="filtered"
              :columns="columns"
              :loading="loading"
              :empty="t('overview.filter.noMatch')"
              sticky
              :ui="{ th: 'px-3 py-2 text-xs font-medium text-muted', td: 'px-3 py-2 text-sm', tr: 'cursor-pointer hover:bg-muted' }"
              data-views-table
              @select="(_event: Event, row: { original: ViewRow }) => openRow(row.original.key)"
            >
              <template
                v-for="columnId in ['name', 'feature', 'reviews', 'checks', 'evidence', 'readiness']"
                :key="columnId"
                #[`${columnId}-header`]="{ column }"
              >
                <UButton
                  variant="ghost"
                  color="neutral"
                  size="xs"
                  class="-mx-2 font-medium text-muted"
                  :trailing-icon="column.getIsSorted() === 'asc' ? 'i-lucide-arrow-up' : column.getIsSorted() === 'desc' ? 'i-lucide-arrow-down' : 'i-lucide-arrow-up-down'"
                  @click="column.toggleSorting(column.getIsSorted() === 'asc')"
                >
                  {{ String(column.columnDef.header) }}
                </UButton>
              </template>
              <template #name-cell="{ row }">
                <span class="flex items-center gap-2">
                  <span
                    v-if="row.original.updated"
                    class="size-2 shrink-0 rounded-full bg-primary"
                    data-updated-marker
                  ><span class="sr-only">{{ t('overview.updated') }}</span></span>
                  <ULink
                    :to="viewLocation(row.original.key, { panel: 'readiness' })"
                    class="font-medium text-highlighted hover:underline pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                    @click.stop
                  >
                    {{ row.original.name }}
                  </ULink>
                </span>
              </template>
              <template #feature-cell="{ row }">
                <span class="font-mono text-xs text-muted">{{ row.original.feature || '—' }}</span>
              </template>
              <template #reviews-cell="{ row }">
                <span
                  v-if="row.original.ready || row.original.open"
                  class="flex flex-wrap gap-1"
                >
                  <UBadge
                    v-if="row.original.ready"
                    color="info"
                    icon="i-lucide-eye"
                  >{{ t('overview.reviews.ready', row.original.ready) }}</UBadge>
                  <UBadge
                    v-if="row.original.open"
                    color="annotation"
                    icon="i-lucide-circle-dot"
                  >{{ t('overview.reviews.open', row.original.open) }}</UBadge>
                </span>
                <span
                  v-else
                  class="text-dimmed"
                >—</span>
              </template>
              <template #checks-cell="{ row }">
                <span
                  v-if="row.original.findings"
                  class="inline-flex items-center gap-1.5 text-warning"
                ><UIcon
                  name="i-lucide-triangle-alert"
                  class="size-4"
                />{{ t('overview.findings', row.original.findings) }}</span>
                <span
                  v-else
                  class="inline-flex items-center gap-1.5 text-muted"
                ><UIcon
                  name="i-lucide-check"
                  class="size-4 text-success"
                />{{ t('overview.noFindings') }}</span>
              </template>
              <template #evidence-cell="{ row }">
                <span
                  class="inline-flex items-center gap-1.5"
                  :class="evidenceLabel(row.original).tone"
                ><UIcon
                  :name="evidenceLabel(row.original).icon"
                  class="size-4"
                /><span class="text-default">{{ evidenceLabel(row.original).text }}</span></span>
              </template>
              <template #readiness-cell="{ row }">
                <UBadge
                  :color="READINESS_BADGE[row.original.readiness].color"
                  :icon="READINESS_BADGE[row.original.readiness].icon"
                  :ui="{ leadingIcon: row.original.readiness === 'checking' ? 'animate-spin' : '' }"
                  :data-readiness="row.original.readiness"
                >
                  {{ readinessLabel(row.original) }}
                </UBadge>
              </template>
            </UTable>

            <ul
              v-else
              class="space-y-2"
              data-views-list
            >
              <li
                v-for="row in filtered"
                :key="row.key"
              >
                <ULink
                  :to="viewLocation(row.key, { panel: 'readiness' })"
                  class="block rounded-lg border border-default p-3 hover:bg-muted"
                >
                  <span class="flex items-center gap-2">
                    <span
                      v-if="row.updated"
                      class="size-2 shrink-0 rounded-full bg-primary"
                    ><span class="sr-only">{{ t('overview.updated') }}</span></span>
                    <span class="min-w-0 flex-1 truncate text-sm font-medium text-highlighted">{{ row.name }}</span>
                    <UBadge
                      :color="READINESS_BADGE[row.readiness].color"
                      :icon="READINESS_BADGE[row.readiness].icon"
                    >{{ readinessLabel(row) }}</UBadge>
                  </span>
                  <span
                    v-if="row.feature"
                    class="mt-0.5 block font-mono text-xs text-muted"
                  >{{ row.feature }}</span>
                  <span class="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                    <span v-if="row.ready">{{ t('overview.reviews.ready', row.ready) }}</span>
                    <span v-if="row.open">{{ t('overview.reviews.open', row.open) }}</span>
                    <span>{{ row.findings ? t('overview.findings', row.findings) : t('overview.noFindings') }}</span>
                    <span>{{ evidenceLabel(row).text }}</span>
                  </span>
                </ULink>
              </li>
              <li
                v-if="!filtered.length"
                class="py-6 text-center text-sm text-muted"
              >
                {{ t('overview.filter.noMatch') }}
              </li>
            </ul>
          </div>
        </template>

        <template #checks>
          <OverviewChecks />
        </template>

        <template #activity>
          <OverviewActivity />
        </template>
      </UTabs>
    </div>

    <HandoffExportModal
      v-if="canExport"
      v-model:open="exportOpen"
    />
  </WorkbenchPage>
</template>
