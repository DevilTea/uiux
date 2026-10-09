<script setup lang="ts">
import { anchorViewId } from '../../../src/domain/reviews/schema'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { defineShortcuts, navigateTo, useI18n, useRoute, useRouter, useToast } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import type { ViewPanelTab } from '../../composables/workbench-types'
import { parseThread, parseViewPanel, parseViewRouteContext, sameQuery, viewQuery, VIEWS_LOCATION } from '../../utils/workbench-routes'
import { parseHistoryAddress, type HistoryAddress } from '../../utils/version-history'
import PreviewCanvas from '../../components/workbench/PreviewCanvas.vue'
import ViewRightPanel from '../../components/workbench/ViewRightPanel.vue'
import LockBadge from '../../components/workbench/LockBadge.vue'
import { provideCanvasComments } from '../../composables/useCanvasComments'
import CommentsTab from '../../components/workbench/comments/CommentsTab.vue'
import SpecDocument from '../../components/workbench/SpecDocument.vue'
import ViewHistoryPanel from '../../components/history/ViewHistoryPanel.vue'
import { useReadiness } from '../../composables/useReadiness'

/**
 * A View: the canvas and its right panel. The render context, selected Widget, open thread
 * and panel tab ride in the query, so a deep link reproduces the context after reload.
 * Context changes use `replace`; navigation between areas uses `push`.
 */
const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const workbench = useWorkbench()
const shell = useWorkbenchShell()
const {
	views, loading, selectedView, preview, reviews,
	selectedVariant, selectedLocale, selectedViewportId, selectedThemeId, selectedWidgetId,
} = workbench

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery(WORKBENCH_BREAKPOINTS.phone)
const viewId = computed(() => String(route.params.viewId ?? ''))

const panelTab = ref<ViewPanelTab>(parseViewPanel(route.query) ?? 'comments')
const thread = ref<string | undefined>(parseThread(route.query))
/** The history panel's selection (`version`, `compare`, `canvas`), kept while the panel shows. */
const historyAddress = ref<HistoryAddress>(parseHistoryAddress(route.query))
const rightPanel = ref<InstanceType<typeof ViewRightPanel>>()
// The canvas pins, composer and bubble, and the Comments tab, share one comments layer; the open
// thread is the route's `thread`, so a deep link opens its pin and bubble.
const comments = provideCanvasComments(thread)

// Phones (brief a, section 6; DESIGN.md "Mobile"): one column switching between the Spec (the
// default reading surface), the comment list, the read-only View and the View's history (the
// timeline and diffs are offered on every layout, Rule 01a11a5e-1b52-7f6f-8244-65bb038ef6f8). A
// thread opens in a bottom sheet over the View, so opening one from the list or the Spec shows the
// View tab.
type PhoneTab = 'spec' | 'comments' | 'view' | 'history'
function phoneTabFor(panel: ViewPanelTab | undefined): PhoneTab {
	return panel === 'comments' ? 'comments' : panel === 'history' ? 'history' : 'spec'
}
const phoneTab = ref<PhoneTab>(thread.value ? 'view' : phoneTabFor(parseViewPanel(route.query)))
// The history tab's selection rides in the address with `panel=history` on phones too.
watch(phoneTab, (value) => {
	if (value === 'history') panelTab.value = 'history'
	else if (panelTab.value === 'history') panelTab.value = 'comments'
})
watch(() => comments.openThreadId.value, (id) => {
	if (id && isPhone.value) phoneTab.value = 'view'
	// Tablet: the thread sheet opens over the canvas, so the slide-over list steps aside.
	else if (id && !isDesktop.value) panelOpen.value = false
})
const phoneTabs = computed(() => {
	const unresolved = reviews.value.filter(review => anchorViewId(review.summary.anchor) === viewId.value && review.summary.status !== 'resolved').length
	return [
		{ value: 'spec', slot: 'spec' as const, label: t('panel.spec') },
		{ value: 'comments', slot: 'comments' as const, label: t('panel.comments'), badge: unresolved ? { label: String(unresolved), color: 'annotation' as const, variant: 'soft' as const, size: 'sm' as const } : undefined },
		{ value: 'view', slot: 'view' as const, label: t('phone.viewTab') },
		{ value: 'history', slot: 'history' as const, label: t('panel.history') },
	]
})
const phoneTabModel = computed({
	get: () => phoneTab.value,
	set: (value: string | number) => { phoneTab.value = value as PhoneTab },
})
function openThreadOnPhone(id: string): void {
	if (comments.open(id)) phoneTab.value = 'view'
}

// Desktop: an inline, resizable right panel that `]` hides. Below desktop: a slide-over on demand.
const PANEL_HIDDEN_KEY = 'uiux.workbench.rightPanelHidden'
const panelHidden = ref(false)
try { panelHidden.value = globalThis.localStorage?.getItem(PANEL_HIDDEN_KEY) === '1' }
catch { /* storage unavailable */ }
watch(panelHidden, (hidden) => {
	try { globalThis.localStorage?.setItem(PANEL_HIDDEN_KEY, hidden ? '1' : '0') }
	catch { /* storage unavailable */ }
})
const panelOpen = ref(false)

function togglePanel(): void {
	if (isDesktop.value) panelHidden.value = !panelHidden.value
	else panelOpen.value = !panelOpen.value
}

/** Shows the right panel on a tab and resolves once its content is mounted (a slide-over mounts lazily). */
async function showPanel(tab: ViewPanelTab): Promise<InstanceType<typeof ViewRightPanel> | undefined> {
	panelTab.value = tab
	if (isDesktop.value) panelHidden.value = false
	else panelOpen.value = true
	for (let frame = 0; frame < 30 && !rightPanel.value; frame++) {
		await nextTick()
		await new Promise(resolve => requestAnimationFrame(resolve))
	}
	return rightPanel.value
}

// Route → state.
watch(() => [viewId.value, route.query] as const, ([id, query]) => {
	if (!id) return
	void workbench.openView(id, parseViewRouteContext(query))
	const nextTab = parseViewPanel(query)
	if (nextTab) panelTab.value = nextTab
	if (nextTab === 'history' && isPhone.value) phoneTab.value = 'history'
	const nextHistory = parseHistoryAddress(query)
	if (JSON.stringify(nextHistory) !== JSON.stringify(historyAddress.value)) historyAddress.value = nextHistory
	const nextThread = parseThread(query)
	if (nextThread !== thread.value) thread.value = nextThread
}, { immediate: true, deep: true })

// State → route (replace: a context change is not a navigation).
const stateQuery = computed(() => viewQuery({
	variant: selectedVariant.value,
	locale: selectedLocale.value,
	viewport: selectedViewportId.value,
	theme: selectedThemeId.value,
	widget: selectedWidgetId.value,
	thread: thread.value,
	panel: panelTab.value === 'comments' ? undefined : panelTab.value,
	history: historyAddress.value,
}))
// A replace lands a few tasks later (router guards and middleware run first). While one is in
// flight, compare against what it asked for, not the committed route: state that returns to the
// committed query (J then K, quickly) must still supersede the pending replace, or that replace
// lands and the route → state watch reopens the thread the user already left.
let pendingQuery: LocationQueryRaw | undefined
watch(stateQuery, (query) => {
	if (route.params.viewId !== viewId.value || !route.path.startsWith('/views/')) return
	if (sameQuery(query, pendingQuery ?? route.query)) return
	pendingQuery = query
	void router.replace({ query }).finally(() => {
		// The newest request settled (committed, cancelled or a no-op).
		if (pendingQuery === query) pendingQuery = undefined
	})
})

// The reader's context from before an inbox link is offered back only while that thread stays open.
watch(thread, (id) => {
	if (workbench.contextBeforeThread.value && workbench.contextBeforeThread.value.threadId !== id) workbench.contextBeforeThread.value = undefined
})

// A deep-linked thread also shows the Comments tab on desktop, beside its pin and bubble.
let openedThread: string | undefined
watch([thread, reviews], ([threadId]) => {
	if (!threadId || threadId === openedThread || !isDesktop.value) return
	if (!reviews.value.some(review => review.key === threadId)) return
	openedThread = threadId
	panelTab.value = 'comments'
	panelHidden.value = false
}, { immediate: true })

// A View that does not exist: say so and land on the View list, never a blank canvas.
watch([views, loading, viewId], () => {
	if (loading.value || !viewId.value) return
	if (views.value.some(view => view.key === viewId.value)) return
	toast.add({ title: t('canvas.viewMissing'), color: 'warning', icon: 'i-lucide-triangle-alert' })
	workbench.error.value = undefined
	void navigateTo(VIEWS_LOCATION, { replace: true })
})

// "Updated since you last looked" on the Overview: this browser has now seen this revision.
const readiness = useReadiness()
watch(() => selectedView.value && [selectedView.value.key, selectedView.value.revision] as const, (seen) => {
	if (seen) readiness.markSeen(`view:${seen[0]}`, seen[1])
}, { immediate: true })

const offToggleRightPanel = shell.onToggleRightPanel(togglePanel)
// ⌥1–⌥5: Comments, Inspect, Spec, Readiness, History (brief e, section 8).
defineShortcuts({
	alt_1: () => { void showPanel('comments') },
	alt_2: () => { void showPanel('inspect') },
	alt_3: () => { void showPanel('spec') },
	alt_4: () => { void showPanel('readiness') },
	alt_5: () => {
		if (isPhone.value) phoneTab.value = 'history'
		else void showPanel('history')
	},
})
onBeforeUnmount(() => {
	offToggleRightPanel()
	preview.exitCommentMode()
})
</script>

<template>
  <UDashboardPanel
    v-if="isPhone"
    id="view-phone"
    :ui="{ root: 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
  >
    <template #body>
      <main
        id="canvas"
        data-landmark="main"
        tabindex="-1"
        class="flex min-h-0 flex-1 flex-col"
        :aria-label="selectedView?.resource.name || t('workbench.canvas.label')"
        data-view-phone
      >
        <h1 class="sr-only">
          {{ selectedView?.resource.name || t('workbench.canvas.label') }}
        </h1>
        <UTabs
          v-model="phoneTabModel"
          :items="phoneTabs"
          variant="link"
          color="primary"
          :unmount-on-hide="false"
          :ui="{
            root: 'flex min-h-0 flex-1 flex-col gap-0',
            list: 'shrink-0 border-b border-default px-2',
            trigger: 'flex-1 justify-center px-2',
            content: 'flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden',
          }"
        >
          <template #spec>
            <SpecDocument @open-thread="openThreadOnPhone" />
          </template>
          <template #comments>
            <CommentsTab />
          </template>
          <template #view>
            <PreviewCanvas @open-panel="(tab) => { phoneTab = tab === 'comments' ? 'comments' : 'spec' }" />
            <p class="shrink-0 border-t border-default px-4 pt-2 pb-3 text-xs text-muted">
              {{ t('phone.viewHint') }}
            </p>
          </template>
          <template #history>
            <ViewHistoryPanel :active="phoneTab === 'history'" />
          </template>
        </UTabs>
      </main>
    </template>
  </UDashboardPanel>
  <div
    v-else
    class="flex min-h-0 min-w-0 flex-1"
  >
    <UDashboardPanel
      id="view-canvas"
      :ui="{ root: 'min-h-0 min-w-0', body: 'gap-0 p-0 sm:p-0 overflow-hidden' }"
    >
      <template #body>
        <main
          id="canvas"
          data-landmark="main"
          tabindex="-1"
          class="flex min-h-0 flex-1 flex-col"
          :aria-label="selectedView ? t('workbench.canvas.iframeTitle', { name: selectedView.resource.name }) : t('workbench.canvas.label')"
        >
          <!-- The page heading for assistive tech; the View name is visible in the sidebar and breadcrumb. -->
          <h1 class="sr-only">
            {{ selectedView?.resource.name || t('workbench.canvas.label') }}
          </h1>
          <LockBadge
            kind="view"
            :resource-key="viewId"
            class="justify-center border-b border-default bg-default px-3 py-1.5"
          />
          <PreviewCanvas @open-panel="showPanel">
            <template #actions>
              <UTooltip :text="isDesktop ? t('shell.togglePanel') : t('shell.openPanel')">
                <UButton
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :icon="isDesktop ? 'i-lucide-panel-right' : 'i-lucide-panel-right-open'"
                  :aria-label="isDesktop ? t('shell.togglePanel') : t('shell.openPanel')"
                  :aria-expanded="isDesktop ? !panelHidden : panelOpen"
                  @click="togglePanel"
                />
              </UTooltip>
            </template>
          </PreviewCanvas>
        </main>
      </template>
    </UDashboardPanel>

    <UDashboardSidebar
      v-if="isDesktop && !panelHidden"
      id="details"
      side="right"
      resizable
      :min-size="300"
      :max-size="440"
      :default-size="340"
      :toggle="false"
      :open="false"
      :ui="{ root: 'min-h-0 h-auto border-s border-default', body: 'gap-0 p-0 overflow-hidden' }"
    >
      <aside
        data-landmark="complementary"
        :aria-label="t('panel.label')"
        class="flex min-h-0 flex-1 flex-col"
      >
        <ViewRightPanel
          ref="rightPanel"
          v-model:tab="panelTab"
        />
      </aside>
    </UDashboardSidebar>

    <USlideover
      v-if="!isDesktop && !isPhone"
      v-model:open="panelOpen"
      side="right"
      :title="selectedView?.resource.name || t('panel.label')"
      :ui="{ content: 'max-w-sm', body: 'flex min-h-0 flex-col p-0 sm:p-0' }"
    >
      <template #body>
        <aside
          data-landmark="complementary"
          :aria-label="t('panel.label')"
          class="flex min-h-0 flex-1 flex-col"
        >
          <ViewRightPanel
            ref="rightPanel"
            v-model:tab="panelTab"
          />
        </aside>
      </template>
    </USlideover>
  </div>
</template>
