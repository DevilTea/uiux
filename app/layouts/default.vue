<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import { provideWorkbench } from '../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../composables/useMediaQuery'
import { provideWorkbenchShell } from '../composables/useWorkbenchShell'
import { useConnectivity } from '../composables/useConnectivity'
import WorkbenchNavbar from '../components/workbench/WorkbenchNavbar.vue'
import WorkbenchSidebar from '../components/workbench/WorkbenchSidebar.vue'
import WorkbenchCommandPalette from '../components/workbench/WorkbenchCommandPalette.vue'
import WorkbenchShortcuts from '../components/workbench/WorkbenchShortcuts.vue'
import WorkbenchBottomNav from '../components/workbench/WorkbenchBottomNav.vue'

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

// Server unreachable (brief h): one persistent alert under the navbar with Retry. It replaces the
// generic load error, which would only repeat the same cause in transport words.
const connectivity = useConnectivity()
const offline = computed(() => connectivity.state.value !== 'online')
const retrying = ref(false)
async function retryConnection(): Promise<void> {
	retrying.value = true
	try { await connectivity.retry() }
	finally { retrying.value = false }
}
const stopRecover = connectivity.onRecover(() => { void workbench.refreshAll() })

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery(WORKBENCH_BREAKPOINTS.phone)
const sidebarOpen = ref(false)

// Desktop keeps the user's own collapse choice (persisted). Tablet (768–1279) always shows the
// 56px icon rail; "expand" there opens the full sidebar as a slide-over above the canvas, so the
// canvas never loses width (DESIGN.md device classes). Phones use the bottom bar and the ☰ menu.
const COLLAPSED_STORAGE_KEY = 'uiux.workbench.sidebarCollapsed'
const desktopCollapsed = ref(false)
try { desktopCollapsed.value = globalThis.localStorage?.getItem(COLLAPSED_STORAGE_KEY) === '1' }
catch { /* storage unavailable */ }
const sidebarCollapsed = computed({
	get: () => isDesktop.value ? desktopCollapsed.value : true,
	set: (collapsed: boolean) => {
		if (!isDesktop.value) {
			if (!collapsed) sidebarOpen.value = true
			return
		}
		desktopCollapsed.value = collapsed
		try { globalThis.localStorage?.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0') }
		catch { /* storage unavailable */ }
	},
})

shell.onToggleSidebar(() => {
	if (isDesktop.value) sidebarCollapsed.value = !sidebarCollapsed.value
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
	// On a phone the review desk opens on its triage queue (brief a, section 6): a cold load of the
	// Overview lands on Reviews; Overview stays one tap away in the bottom bar.
	// The real address bar decides: during the first render the route can still read `/`.
	if (isPhone.value && window.location.pathname === '/' && !window.location.search && !globalThis.history?.state?.back) void navigateTo('/reviews', { replace: true })
	workbench.preview.mount()
	void workbench.refreshAll()
})

onUnmounted(() => {
	stopRecover()
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
      :ui="{ root: 'rounded-none border-b border-default' }"
    >
      <template #description>
        <i18n-t
          keypath="workbench.migration.description"
          tag="span"
          scope="global"
        >
          <template #command>
            <code
              class="font-mono"
              translate="no"
            >{{ MIGRATE_COMMAND }}</code>
          </template>
        </i18n-t>
      </template>
    </UAlert>

    <UAlert
      v-if="offline"
      id="uiux-server-unreachable"
      color="error"
      variant="subtle"
      icon="i-lucide-unplug"
      role="alert"
      :title="t('server.unreachable')"
      :description="connectivity.state.value === 'reconnecting' ? t('server.reconnecting') : t('server.unreachableHint')"
      :actions="[{ label: t('common.retry'), color: 'neutral', variant: 'outline', loading: retrying || connectivity.state.value === 'reconnecting', onClick: () => { void retryConnection() } }]"
      :ui="{ root: 'rounded-none border-b border-default' }"
      data-server-unreachable
    />

    <UAlert
      v-else-if="error"
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
        :ui="{ root: 'min-h-0 h-auto min-w-14 bg-default md:flex', body: 'gap-0 p-0 overflow-x-hidden overflow-y-auto', footer: 'block p-0', content: 'max-w-72' }"
      >
        <template #default="{ collapsed }">
          <WorkbenchSidebar :collapsed="collapsed" />
        </template>
      </UDashboardSidebar>

      <slot />
    </div>

    <WorkbenchBottomNav />

    <WorkbenchCommandPalette />
    <WorkbenchShortcuts />
  </UDashboardGroup>
</template>
