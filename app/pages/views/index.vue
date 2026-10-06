<script setup lang="ts">
import { anchorViewId } from '../../../src/domain/reviews/schema'
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { viewLocation } from '../../utils/workbench-routes'
import { useDelayedFlag } from '../../composables/useDelayedFlag'

/**
 * The View index: every View of the Workspace, on every device. It is where the "Views" crumb,
 * the sidebar's Views item and `G V` land, so it never redirects to a View; it used to open the
 * most recent one on tablet and desktop, which sent the parent crumb straight back to the View the
 * reviewer had just left (review feedback 8dd59d25). The View opened last is marked instead.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { views, reviews, loading } = workbench
const showSkeleton = useDelayedFlag(() => loading.value && !views.value.length)
const lastViewId = workbench.lastViewId()

/** Unresolved threads per View, for the Marker count beside each row. */
const unresolvedByView = computed(() => {
	const counts = new Map<string, number>()
	for (const review of reviews.value) {
		const viewId = anchorViewId(review.summary.anchor)
		if (viewId && review.summary.status !== 'resolved') counts.set(viewId, (counts.get(viewId) ?? 0) + 1)
	}
	return counts
})
</script>

<template>
  <UDashboardPanel
    id="views"
    :ui="{ body: 'gap-0 p-0 sm:p-0' }"
  >
    <template #body>
      <main
        id="main"
        data-landmark="main"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col overflow-y-auto"
        data-views-index
      >
        <div class="mx-auto w-full max-w-4xl md:px-4">
          <div class="px-4 pt-6 pb-3 md:px-0">
            <h1 class="text-headline font-semibold text-highlighted">
              {{ t('nav.views') }}
            </h1>
          </div>
          <ul
            v-if="loading && !views.length"
            class="divide-y divide-default border-y border-default md:rounded-md md:border-x"
            aria-busy="true"
            :aria-label="t('workbench.views.listLabel')"
          >
            <template v-if="showSkeleton">
              <li
                v-for="index in 8"
                :key="index"
                class="flex min-h-11 items-center gap-3 px-4 py-2"
              >
                <USkeleton
                  class="size-4 shrink-0"
                  :aria-label="t('common.loading')"
                />
                <span class="flex-1 space-y-1.5">
                  <USkeleton
                    class="h-3.5"
                    :style="{ width: `${40 + (index * 23) % 45}%` }"
                    :aria-label="t('common.loading')"
                  />
                  <USkeleton
                    class="h-3 w-20"
                    :aria-label="t('common.loading')"
                  />
                </span>
              </li>
            </template>
          </ul>
          <UEmpty
            v-else-if="!views.length"
            icon="i-lucide-app-window"
            :title="t('workbench.views.emptyTitle')"
            variant="naked"
            :actions="[
              { label: t('common.refresh'), icon: 'i-lucide-refresh-cw', onClick: () => { void workbench.refreshAll() } },
              ...(workbench.isReadOnly.value ? [] : [{ label: t('firstRun.showSteps'), icon: 'i-lucide-list-checks', color: 'neutral' as const, variant: 'ghost' as const, to: '/' }]),
            ]"
          >
            <template #description>
              <i18n-t
                keypath="workbench.views.emptyDescription"
                tag="span"
                scope="global"
              >
                <template #tool>
                  <code class="rounded-sm bg-elevated px-1 py-0.5 font-mono text-xs text-highlighted">create_view</code>
                </template>
              </i18n-t>
            </template>
          </UEmpty>
          <ul
            v-else
            class="divide-y divide-default border-y border-default md:rounded-md md:border-x"
            :aria-label="t('workbench.views.listLabel')"
          >
            <li
              v-for="view in views"
              :key="view.key"
            >
              <ULink
                :to="viewLocation(view.key)"
                class="flex min-h-11 items-center gap-3 px-4 py-2 text-default hover:bg-muted"
                :data-views-index-row="view.key"
              >
                <UIcon
                  name="i-lucide-app-window"
                  class="size-4 shrink-0 text-dimmed"
                />
                <span class="min-w-0 flex-1">
                  <span class="block truncate text-sm font-medium text-highlighted">{{ view.summary.name || t('common.unnamed') }}</span>
                  <span
                    v-if="view.summary.feature"
                    class="block truncate font-mono text-xs text-muted"
                  >{{ view.summary.feature }}</span>
                </span>
                <span
                  v-if="view.key === lastViewId"
                  class="hidden text-xs text-muted sm:inline"
                >{{ t('workbench.views.lastOpened') }}</span>
                <UBadge
                  v-if="unresolvedByView.get(view.key)"
                  color="annotation"
                  variant="soft"
                  size="sm"
                  icon="i-lucide-message-circle"
                  :aria-label="t('workbench.tree.commentCount', unresolvedByView.get(view.key) ?? 0)"
                >
                  {{ unresolvedByView.get(view.key) }}
                </UBadge>
                <UBadge
                  v-if="view.diagnosticCount"
                  color="warning"
                  variant="subtle"
                  size="sm"
                  icon="i-lucide-triangle-alert"
                  :aria-label="t('workbench.views.diagnosticCount', view.diagnosticCount)"
                >
                  {{ view.diagnosticCount }}
                </UBadge>
                <UIcon
                  name="i-lucide-chevron-right"
                  class="size-4 shrink-0 text-dimmed"
                />
              </ULink>
            </li>
          </ul>
        </div>
      </main>
    </template>
  </UDashboardPanel>
</template>
