<script setup lang="ts">
import { computed } from 'vue'
import { useI18n, useRoute } from '#imports'
import type { BreadcrumbItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { flowPath, viewPath } from '../../utils/workbench-routes'
import WorkbenchPreferences from './WorkbenchPreferences.vue'
import ReviewerIdentity from './ReviewerIdentity.vue'
import WorkspaceMenu from './WorkspaceMenu.vue'

/** The 48px global top bar: location, search, reviewer identity and Workbench preferences. */
const { t } = useI18n()
const route = useRoute()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const { isReadOnly, selectedView, views, flows, loading } = workbench

const WORKSPACE_PAGES: Record<string, string> = {
	'/workspace/settings': 'nav.settings',
	'/workspace/locales': 'nav.locales',
	'/workspace/assets': 'nav.assets',
	'/workspace/adapters': 'nav.adapters',
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
    class="flex h-(--ui-header-height) shrink-0 items-center gap-2 border-b border-default bg-default ps-2 pe-3"
  >
    <UButton
      color="neutral"
      variant="ghost"
      icon="i-lucide-panel-left"
      class="lg:hidden"
      :aria-label="t('shell.toggleSidebar')"
      @click="shell.toggleSidebar()"
    />
    <WorkspaceMenu />

    <USeparator
      orientation="vertical"
      class="hidden h-5 sm:block"
    />

    <nav
      :aria-label="t('shell.breadcrumb')"
      class="hidden min-w-0 flex-1 sm:block"
    >
      <UBreadcrumb
        :items="breadcrumb"
        color="neutral"
        separator-icon="i-lucide-chevron-right"
        :ui="{ link: 'text-sm', linkLabel: 'truncate max-w-64', separatorIcon: 'size-3.5' }"
      />
    </nav>
    <div class="min-w-0 flex-1 sm:hidden" />

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
      <ReviewerIdentity v-if="!isReadOnly" />
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
