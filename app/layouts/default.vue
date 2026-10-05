<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n, useRoute } from '#imports'
import { provideWorkbench } from '../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../composables/useMediaQuery'
import { provideWorkbenchShell } from '../composables/useWorkbenchShell'
import WorkbenchNavbar from '../components/workbench/WorkbenchNavbar.vue'
import WorkbenchSidebar from '../components/workbench/WorkbenchSidebar.vue'
import WorkbenchCommandPalette from '../components/workbench/WorkbenchCommandPalette.vue'
import WorkbenchShortcuts from '../components/workbench/WorkbenchShortcuts.vue'

/**
 * The Workbench application shell (brief a): a global 48px navbar, a collapsible and
 * resizable left sidebar carrying the IA plus the current area's navigator, and the page
 * panels. The shell state survives navigation between areas.
 */
const { t } = useI18n()
const route = useRoute()
const workbench = provideWorkbench()
const shell = provideWorkbenchShell()
const { error, isReadOnly, publicationInfo, workspace } = workbench

// Read-only banner for an older Workspace schema. Migration is a CLI-only operator act
// (`uiux migrate`), so the banner names the command and offers no in-app action.
const migrationRequired = computed(() => workspace.value?.inspection?.state === 'migration_required')
const MIGRATE_COMMAND = 'uiux migrate --workspace <dir>'

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const sidebarOpen = ref(false)

// Desktop keeps the user's own collapse choice (persisted). Below the desktop breakpoint the
// sidebar falls back to the 56px rail (tablet rules) and can be expanded for this session only.
const COLLAPSED_STORAGE_KEY = 'uiux.workbench.sidebarCollapsed'
const desktopCollapsed = ref(false)
try { desktopCollapsed.value = globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === '1' }
catch { /* storage unavailable */ }
const tabletExpanded = ref(false)
const sidebarCollapsed = computed({
	get: () => isDesktop.value ? desktopCollapsed.value : !tabletExpanded.value,
	set: (collapsed: boolean) => {
		if (!isDesktop.value) {
			tabletExpanded.value = !collapsed
			return
		}
		desktopCollapsed.value = collapsed
		try { globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0') }
		catch { /* storage unavailable */ }
	},
})

shell.onToggleSidebar(() => {
	if (window.matchMedia(WORKBENCH_BREAKPOINTS.tablet).matches) sidebarCollapsed.value = !sidebarCollapsed.value
	else sidebarOpen.value = !sidebarOpen.value
})

const isViewPage = computed(() => route.path.startsWith('/views/'))

const PUBLICATION_BANNER_KEY = 'uiux.workbench.publicationBannerDismissed'
const publicationBannerDismissed = ref(false)
try { publicationBannerDismissed.value = globalThis.sessionStorage?.getItem(PUBLICATION_BANNER_KEY) === '1' }
catch { /* session storage unavailable */ }
function dismissPublicationBanner(): void {
	publicationBannerDismissed.value = true
	try { globalThis.sessionStorage?.setItem(PUBLICATION_BANNER_KEY, '1') }
	catch { /* session storage unavailable */ }
}

onMounted(() => {
	workbench.preview.mount()
	void workbench.refreshAll()
})

onUnmounted(() => {
	workbench.preview.unmount()
})
</script>

<template>
  <UDashboardGroup
    storage="local"
    storage-key="uiux-shell"
    unit="px"
    class="flex h-dvh flex-col bg-default text-default"
  >
    <a
      :href="isViewPage ? '#canvas' : '#main'"
      class="sr-only z-50 rounded-md bg-default px-3 py-2 text-sm font-medium text-highlighted shadow-overlay focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
    >
      {{ isViewPage ? t('shell.skipToCanvas') : t('shell.skipToContent') }}
    </a>

    <WorkbenchNavbar />

    <UBanner
      v-if="isReadOnly && !publicationBannerDismissed"
      id="uiux-publication"
      icon="i-lucide-lock"
      color="neutral"
      :title="publicationInfo?.sourceRevision ? t('publication.bannerRevision', { revision: publicationInfo.sourceRevision.slice(0, 12) }) : t('publication.banner')"
      close
      :ui="{ root: 'border-b border-default bg-muted', title: 'text-xs text-muted font-medium' }"
      @close="dismissPublicationBanner"
    />

    <UAlert
      v-if="migrationRequired"
      id="uiux-migration-required"
      color="warning"
      variant="subtle"
      icon="i-lucide-database"
      role="status"
      :title="t('workbench.migration.title')"
      :description="t('workbench.migration.description', { command: MIGRATE_COMMAND })"
      :ui="{ root: 'rounded-none border-b border-default' }"
    />

    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      role="alert"
      :title="t('workbench.errors.title')"
      :description="error"
      :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', onClick: () => { void workbench.refreshAll() } }]"
      :ui="{ root: 'rounded-none border-b border-default' }"
    />

    <div class="flex min-h-0 flex-1">
      <UDashboardSidebar
        id="navigation"
        v-model:collapsed="sidebarCollapsed"
        v-model:open="sidebarOpen"
        side="left"
        collapsible
        resizable
        :min-size="220"
        :max-size="360"
        :default-size="264"
        :collapsed-size="56"
        :toggle="false"
        :menu="{ title: t('shell.primaryNav') }"
        :ui="{ root: 'min-h-0 h-auto min-w-14 bg-default', body: 'gap-0 p-0 overflow-hidden', footer: 'block p-0' }"
      >
        <template #default="{ collapsed }">
          <WorkbenchSidebar :collapsed="collapsed" />
        </template>
      </UDashboardSidebar>

      <slot />
    </div>

    <WorkbenchCommandPalette />
    <WorkbenchShortcuts />
  </UDashboardGroup>
</template>
