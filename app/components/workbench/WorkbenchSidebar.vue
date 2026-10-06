<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import type { NavigationMenuItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { flowPath, viewLocation } from '../../utils/workbench-routes'
import WidgetTree from './WidgetTree.vue'
import WorkspaceMenu from './WorkspaceMenu.vue'
import FlowCreateModal from '../flows/FlowCreateModal.vue'

/**
 * Sidebar content: the four primary areas, the current area's navigator (brief a,
 * section 3) and the secondary Workspace entry at the foot.
 */
const props = defineProps<{ collapsed?: boolean }>()

const { t } = useI18n()
const route = useRoute()
const workbench = useWorkbench()
const { views, flows, selectedView, unresolvedReviewCount, loading } = workbench

function count(value: number, color: 'neutral' | 'annotation' = 'neutral') {
	return value > 0 ? { label: String(value), color, variant: 'soft' as const, size: 'sm' as const } : undefined
}

// A View or Flow page is a sibling route of its index, so router matching alone would leave the
// area's item unmarked (most visibly in the tablet icon rail); mark it from the path instead.
const primary = computed<NavigationMenuItem[]>(() => [
	{ label: t('nav.overview'), icon: 'i-lucide-layout-dashboard', to: '/', exact: true, 'aria-label': t('nav.overview') },
	{ label: t('nav.views'), icon: 'i-lucide-app-window', to: '/views', active: route.path.startsWith('/views'), badge: count(views.value.length), 'aria-label': t('nav.countLabel', { label: t('nav.views'), n: views.value.length }) },
	{ label: t('nav.flows'), icon: 'i-lucide-workflow', to: '/flows', active: route.path.startsWith('/flows'), badge: count(flows.value.length), 'aria-label': t('nav.countLabel', { label: t('nav.flows'), n: flows.value.length }) },
	{ label: t('nav.reviews'), icon: 'i-lucide-inbox', to: '/reviews', badge: count(unresolvedReviewCount.value, 'annotation'), 'aria-label': t('nav.reviewsLabel', unresolvedReviewCount.value) },
])

// The authoring side is secondary on a review desk: one quiet entry at the foot. The Workspace
// pages carry their own sub-navigation (Settings, Locales, Assets; Adapters are a Settings
// section). The collapsed rail hides labels, so the item carries an aria-label.
const secondary = computed<NavigationMenuItem[]>(() => [
	{ label: t('nav.workspace'), icon: 'i-lucide-settings-2', to: '/workspace/settings', active: route.path.startsWith('/workspace'), 'aria-label': t('nav.workspace') },
])

const NAV_UI = {
	root: 'w-full',
	list: 'gap-0.5',
	label: 'text-xs font-medium text-muted px-2 pt-3',
	link: 'px-2 py-1.5 text-sm before:inset-x-0',
	linkLeadingIcon: 'size-4',
	linkTrailingBadge: 'font-medium',
}
const SECONDARY_NAV_UI = { ...NAV_UI, link: 'px-2 py-1.5 text-xs before:inset-x-0', linkLeadingIcon: 'size-3.5' }

/**
 * The area whose navigator the sidebar shows. The `/views` and `/flows` indexes are the list
 * themselves (the parent crumb lands there), so the sidebar does not repeat it beside them.
 */
const area = computed(() => {
	const path = route.path.replace(/\/+$/, '')
	if (path === '/views' || path === '/flows') return undefined
	if (path.startsWith('/views')) return 'views'
	if (path.startsWith('/flows')) return 'flows'
	return undefined
})

const openViewId = computed(() => typeof route.params.viewId === 'string' ? route.params.viewId : undefined)
/** On a View page the navigator shows its Widget layers; "All Views" flips back to the list. */
const showViewList = ref(!openViewId.value)
watch(openViewId, (id) => { showViewList.value = !id })

const viewFilter = ref('')
const filteredViews = computed(() => {
	const query = viewFilter.value.trim().toLowerCase()
	return views.value.filter(view => !query
		|| (view.summary.name ?? '').toLowerCase().includes(query)
		|| (view.summary.feature ?? '').toLowerCase().includes(query))
})

const openFlowId = computed(() => typeof route.params.flowId === 'string' ? route.params.flowId : undefined)

/** `create_flow` is desktop authoring (brief g, section 7). */
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const canCreateFlow = computed(() => !workbench.authorReadOnly.value && isDesktop.value && workbench.workspace.value?.inspection?.state !== 'migration_required')
const createFlowOpen = ref(false)
</script>

<template>
  <!-- A named region, not a <nav>: the two menus below are the navigation landmarks (a wrapping
       <nav> made them nested, unnamed duplicates), and the View navigator / Flow list stay inside
       a landmark. F6 still cycles to it. -->
  <section
    data-landmark="navigation"
    :aria-label="t('shell.sidebar')"
    class="flex min-h-0 flex-1 flex-col"
  >
    <div
      v-if="!props.collapsed"
      class="shrink-0 border-b border-default px-2 pb-2 md:hidden"
    >
      <WorkspaceMenu />
    </div>
    <div
      class="shrink-0 pt-2"
      :class="props.collapsed ? 'px-1' : 'px-2'"
    >
      <UNavigationMenu
        :items="primary"
        :aria-label="t('shell.primaryNav')"
        orientation="vertical"
        :collapsed="props.collapsed"
        color="neutral"
        :tooltip="props.collapsed"
        :ui="NAV_UI"
      />
    </div>

    <USeparator class="my-2 shrink-0" />

    <div
      v-if="!props.collapsed && area === 'views'"
      class="flex min-h-0 flex-1 flex-col"
    >
      <template v-if="openViewId && !showViewList">
        <div class="shrink-0 px-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-arrow-left"
            class="text-muted"
            @click="showViewList = true"
          >
            {{ t('shell.allViews') }}
          </UButton>
          <p class="truncate px-2 pt-1 text-title font-semibold text-highlighted">
            {{ selectedView?.resource.name || t('common.unnamed') }}
          </p>
        </div>
        <WidgetTree />
      </template>

      <template v-else>
        <div class="shrink-0 px-3 pb-2">
          <UInput
            v-model="viewFilter"
            icon="i-lucide-search"
            size="sm"
            variant="outline"
            class="w-full"
            :placeholder="t('workbench.views.filterPlaceholder')"
            :aria-label="t('workbench.views.filterPlaceholder')"
          />
        </div>
        <ul
          class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
          :aria-label="t('workbench.views.listLabel')"
        >
          <li
            v-for="view in filteredViews"
            :key="view.key"
          >
            <ULink
              :to="viewLocation(view.key)"
              class="flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-sm text-default hover:bg-muted"
              active-class="bg-selection-subtle text-selection-text"
              @click="showViewList = false"
            >
              <UIcon
                name="i-lucide-app-window"
                class="size-4 shrink-0 text-dimmed"
              />
              <span class="min-w-0 flex-1">
                <span class="block truncate">{{ view.summary.name || t('common.unnamed') }}</span>
                <span
                  v-if="view.summary.feature"
                  class="block truncate font-mono text-xs text-dimmed"
                >{{ view.summary.feature }}</span>
              </span>
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
            </ULink>
          </li>
          <li
            v-if="!filteredViews.length && !loading"
            class="px-2 py-1 text-xs text-muted"
          >
            {{ views.length ? t('workbench.views.noMatches', { query: viewFilter }) : t('workbench.views.emptyTitle') }}
          </li>
        </ul>
      </template>
    </div>

    <ul
      v-else-if="!props.collapsed && area === 'flows'"
      class="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2"
      :aria-label="t('flows.list.label')"
    >
      <li v-if="canCreateFlow">
        <UButton
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-plus"
          class="w-full text-muted"
          :label="t('flows.newFlow')"
          data-flow-new
          @click="createFlowOpen = true"
        />
        <FlowCreateModal
          v-model:open="createFlowOpen"
          @created="(id: string) => navigateTo(flowPath(id))"
        />
      </li>
      <li
        v-for="flow in flows"
        :key="flow.key"
      >
        <ULink
          :to="flowPath(flow.key)"
          class="flex min-h-7 items-center gap-2 rounded-md px-2 py-1 text-sm text-default hover:bg-muted"
          :class="openFlowId === flow.key ? 'bg-selection-subtle text-selection-text' : ''"
        >
          <UIcon
            name="i-lucide-workflow"
            class="size-4 shrink-0 text-dimmed"
          />
          <span class="truncate">{{ flow.summary.name || t('flows.list.unnamed') }}</span>
        </ULink>
      </li>
      <li
        v-if="!flows.length && !loading"
        class="px-2 py-1 text-xs text-muted"
      >
        {{ t('flows.list.empty') }}
      </li>
    </ul>

    <div
      v-else
      class="flex-1"
    />

    <div
      class="shrink-0 border-t border-default pb-2"
      :class="props.collapsed ? 'px-1' : 'px-2'"
    >
      <UNavigationMenu
        :items="secondary"
        :aria-label="t('shell.secondaryNav')"
        orientation="vertical"
        :collapsed="props.collapsed"
        color="neutral"
        :tooltip="props.collapsed"
        :ui="SECONDARY_NAV_UI"
        class="pt-1"
      />
      <UTooltip :text="props.collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')">
        <UDashboardSidebarCollapse
          class="mt-1 hidden md:inline-flex"
          :aria-label="props.collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar')"
        />
      </UTooltip>
    </div>
  </section>
</template>
