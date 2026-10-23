<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { navigateTo, useI18n, useRoute } from '#imports'
import { provideWorkbench } from '../composables/useWorkbench'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../composables/useMediaQuery'
import { provideWorkbenchShell } from '../composables/useWorkbenchShell'
import { useConnectivity } from '../composables/useConnectivity'
import { useKitBuild } from '../composables/useKitBuild'
import { accessEpoch, useAccess } from '../composables/useAccess'
import { useLiveEvents } from '../composables/useLiveEvents'
import { PRODUCT_KIT_PATH } from '../utils/workbench-routes'
import WorkbenchNavbar from '../components/workbench/WorkbenchNavbar.vue'
import WorkbenchSidebar from '../components/workbench/WorkbenchSidebar.vue'
import WorkbenchCommandPalette from '../components/workbench/WorkbenchCommandPalette.vue'
import WorkbenchShortcuts from '../components/workbench/WorkbenchShortcuts.vue'
import WorkbenchBottomNav from '../components/workbench/WorkbenchBottomNav.vue'
import CreateCheckpointModal from '../components/history/CreateCheckpointModal.vue'

/**
 * The Workbench application shell (brief a): a global 48px navbar, a collapsible and
 * resizable left sidebar carrying the IA plus the current area's navigator, and the page
 * panels. The shell state survives navigation between areas.
 */
const { t } = useI18n()
const route = useRoute()
const workbench = provideWorkbench()
const shell = provideWorkbenchShell()
const { error, workspace } = workbench

// Rule 01a11be8-6147-7e6e-a288-689144151a0b: while the last kit build run has failed, a banner says
// so; UIUX keeps using the last good output meanwhile. Only a current Workspace has a kit project
// this UIUX builds, so only then is the build state polled.
const kitBuild = useKitBuild()
const kitBuildFailed = computed(() => kitBuild.build.value.state === 'failed')
const hasKitProject = computed(() => workspace.value?.inspection?.state === 'current')
let stopKitBuild: (() => void) | undefined
watch(hasKitProject, (present) => {
	if (present && !stopKitBuild) stopKitBuild = kitBuild.watch()
	else if (!present && stopKitBuild) {
		stopKitBuild()
		stopKitBuild = undefined
	}
}, { immediate: true })

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

// Live refresh (Feature 01a111e4-0315-7755-b867-e3c7b50d22e6): one change-event stream per signed-in
// Workbench session. What changed elsewhere is re-read and re-rendered without asking; a reconnect
// or a restarted server re-reads everything shown; without the stream the Workbench polls.
const access = useAccess()
const live = useLiveEvents()
watch(() => !!access.session.value, (signedIn) => {
	if (signedIn) live.start()
	else live.stop()
}, { immediate: true })
live.onResources((batch) => { void workbench.applyLiveChanges(batch) })
// A restarted server ends the Preview session: the canvas starts a new one before geometry resumes.
live.onServerRestart(() => { workbench.preview.renewSession() })
live.onLocks(() => { void access.refreshLocks() })
live.onAccess(() => {
	accessEpoch.value += 1
	void access.reload()
})

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

onMounted(() => {
	// On a phone the review desk opens on its triage queue (brief a, section 6): a cold load of the
	// Overview lands on Reviews; Overview stays one tap away in the bottom bar.
	// The real address bar decides: during the first render the route can still read `/`.
	if (isPhone.value && window.location.pathname === '/' && !window.location.search && !globalThis.history?.state?.back) void navigateTo('/reviews', { replace: true })
	workbench.preview.mount()
	void workbench.refreshAll()
})

onUnmounted(() => {
	live.stop()
	stopRecover()
	stopKitBuild?.()
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

    <UAlert
      v-if="kitBuildFailed"
      id="uiux-kit-build-failed"
      color="error"
      variant="subtle"
      icon="i-lucide-hammer"
      role="alert"
      :title="t('workbench.kitBuild.failedTitle')"
      :description="t('workbench.kitBuild.failedDescription')"
      :actions="route.path === PRODUCT_KIT_PATH ? undefined : [{ label: t('workbench.kitBuild.open'), color: 'neutral', variant: 'outline', to: PRODUCT_KIT_PATH }]"
      :ui="{ root: 'rounded-none border-b border-default' }"
      data-kit-build-failed
    />

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
    <CreateCheckpointModal />
  </UDashboardGroup>
</template>
