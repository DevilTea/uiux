<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import type { BreadcrumbItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { flowPath, viewPath } from '../../utils/workbench-routes'
import WorkbenchPreferences from './WorkbenchPreferences.vue'
import MemberChip from './MemberChip.vue'
import WorkspaceMenu from './WorkspaceMenu.vue'

/** The 48px global top bar: location, search, the signed-in member and Workbench preferences. */
const { t } = useI18n()
const route = useRoute()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { isReadOnly, selectedView, views, flows, loading } = workbench

const WORKSPACE_PAGES: Record<string, string> = {
	'/workspace/settings': 'nav.settings',
	'/workspace/locales': 'nav.locales',
	'/workspace/assets': 'nav.assets',
}

const breadcrumb = computed<BreadcrumbItem[]>(() => {
	const path = route.path
	if (path === '/') return [{ label: t('nav.overview') }]
	if (path.startsWith('/views')) {
		const items: BreadcrumbItem[] = [{ label: t('nav.views'), to: '/views' }]
		const id = typeof route.params.viewId === 'string' ? route.params.viewId : undefined
		if (id) {
			const name = selectedView.value?.key === id
				? selectedView.value.resource.name
				: views.value.find(view => view.key === id)?.summary.name
			items.push({ label: name || t('common.unnamed'), to: viewPath(id) })
			const variant = typeof route.query.variant === 'string' ? route.query.variant : ''
			if (variant) items.push({ label: variant })
		}
		return items
	}
	if (path.startsWith('/flows')) {
		const items: BreadcrumbItem[] = [{ label: t('nav.flows'), to: '/flows' }]
		const id = typeof route.params.flowId === 'string' ? route.params.flowId : undefined
		if (id) items.push({ label: flows.value.find(flow => flow.key === id)?.summary.name || t('flows.list.unnamed'), to: flowPath(id) })
		return items
	}
	if (path.startsWith('/reviews')) return [{ label: t('nav.reviews') }]
	if (path === '/members') return [{ label: t('access.members.title') }]
	if (path.startsWith('/workspace')) {
		const page = WORKSPACE_PAGES[path]
		return [{ label: t('nav.workspace') }, ...(page ? [{ label: t(page) }] : [])]
	}
	return []
})
</script>

<template>
  <header
    data-landmark="banner"
    class="box-content flex h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default bg-default ps-[max(0.5rem,env(safe-area-inset-left))] pe-[max(0.75rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)]"
  >
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-menu"
      class="md:hidden"
      :aria-label="t('shell.toggleSidebar')"
      @click="shell.toggleSidebar()"
    />
    <!-- Phones keep the bar to ☰, the page title and global actions; the Workspace mark moves into the ☰ menu. -->
    <div class="hidden md:flex">
      <WorkspaceMenu />
    </div>

    <USeparator
      orientation="vertical"
      class="hidden h-5 sm:block"
    />

    <!-- UBreadcrumb renders the <nav> landmark itself; it gets the translated name here. Ancestors
         keep their width; only the current page's label truncates. -->
    <UBreadcrumb
      :items="breadcrumb"
      :aria-label="t('shell.breadcrumb')"
      class="hidden min-w-0 flex-1 sm:block"
      color="neutral"
      separator-icon="i-lucide-chevron-right"
      :ui="{ item: 'shrink-0 last:shrink', link: 'text-sm pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center', linkLabel: 'truncate max-w-64', separatorIcon: 'size-3.5' }"
    />
    <p
      class="min-w-0 flex-1 truncate text-sm font-semibold text-highlighted sm:hidden"
      data-navbar-title
    >
      {{ breadcrumb.at(-1)?.label }}
    </p>

    <div class="flex shrink-0 items-center gap-1.5">
      <UDashboardSearchButton
        :label="t('shell.search')"
        :kbds="['meta', 'K']"
        :collapsed="false"
        class="hidden w-56 md:inline-flex"
        :ui="{ base: 'text-dimmed' }"
      />
      <UDashboardSearchButton
        collapsed
        class="md:hidden"
        :aria-label="t('shell.search')"
      />
      <MemberChip v-if="!isReadOnly" />
      <WorkbenchPreferences />
      <UTooltip :text="t('common.refresh')">
        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          :loading="loading"
          :aria-label="t('common.refresh')"
          @click="workbench.refreshAll()"
        />
      </UTooltip>
    </div>
  </header>
</template>
