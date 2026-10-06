<script setup lang="ts">
import { watch } from 'vue'
import { navigateTo, useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { viewLocation } from '../../utils/workbench-routes'
import { useDelayedFlag } from '../../composables/useDelayedFlag'

/**
 * The View index. On tablet and desktop it opens the most recent View (the sidebar keeps the
 * list); on mobile it is the list itself.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { views, loading } = workbench
const isTablet = useMediaQuery(WORKBENCH_BREAKPOINTS.tablet)
const showSkeleton = useDelayedFlag(() => loading.value && !views.value.length)

watch([views, isTablet, loading], () => {
	if (!isTablet.value || loading.value || !views.value.length) return
	const last = workbench.lastViewId()
	const target = views.value.find(view => view.key === last) ?? views.value[0]!
	void navigateTo(viewLocation(target.key), { replace: true })
}, { immediate: true })
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
      >
        <div class="px-4 pt-6 pb-3">
          <h1 class="text-headline font-semibold text-highlighted">
            {{ t('nav.views') }}
          </h1>
        </div>
        <ul
          v-if="loading && !views.length"
          class="divide-y divide-default border-y border-default"
          aria-busy="true"
          :aria-label="t('workbench.views.listLabel')"
        >
          <template v-if="showSkeleton">
            <li
              v-for="index in 8"
              :key="index"
              class="flex min-h-11 items-center gap-3 px-4 py-2"
            >
              <USkeleton class="size-4 shrink-0" />
              <span class="flex-1 space-y-1.5">
                <USkeleton
                  class="h-3.5"
                  :style="{ width: `${40 + (index * 23) % 45}%` }"
                />
                <USkeleton class="h-3 w-20" />
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
          class="divide-y divide-default border-y border-default"
          :aria-label="t('workbench.views.listLabel')"
        >
          <li
            v-for="view in views"
            :key="view.key"
          >
            <ULink
              :to="viewLocation(view.key)"
              class="flex min-h-11 items-center gap-3 px-4 py-2 text-default hover:bg-muted"
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
              <UIcon
                name="i-lucide-chevron-right"
                class="size-4 text-dimmed"
              />
            </ULink>
          </li>
        </ul>
      </main>
    </template>
  </UDashboardPanel>
</template>
