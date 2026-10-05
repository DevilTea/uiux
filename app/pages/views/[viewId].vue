<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { navigateTo, useI18n, useRoute, useRouter, useToast } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import type { ViewPanelTab } from '../../composables/workbench-types'
import { parseThread, parseViewPanel, parseViewRouteContext, sameQuery, viewQuery } from '../../utils/workbench-routes'
import PreviewCanvas from '../../components/workbench/PreviewCanvas.vue'
import ViewRightPanel from '../../components/workbench/ViewRightPanel.vue'
import LockBadge from '../../components/workbench/LockBadge.vue'

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
const viewId = computed(() => String(route.params.viewId ?? ''))

const panelTab = ref<ViewPanelTab>(parseViewPanel(route.query) ?? 'comments')
const thread = ref<string | undefined>(parseThread(route.query))
const rightPanel = ref<InstanceType<typeof ViewRightPanel>>()

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
}))
watch(stateQuery, (query) => {
	if (route.params.viewId !== viewId.value || !route.path.startsWith('/views/')) return
	if (!sameQuery(query, route.query)) void router.replace({ query })
})

// Open the deep-linked thread once the Comments panel and the thread list exist.
let openedThread: string | undefined
watch([thread, reviews], async ([threadId]) => {
	if (!threadId || threadId === openedThread) return
	if (!reviews.value.some(review => review.key === threadId)) return
	openedThread = threadId
	const panel = await showPanel('comments')
	await panel?.selectThread(threadId)
}, { immediate: true })

// A View that does not exist: say so and stay on the View index, never a blank canvas.
watch([views, loading, viewId], () => {
	if (loading.value || !viewId.value) return
	if (views.value.some(view => view.key === viewId.value)) return
	toast.add({ title: t('canvas.viewMissing'), color: 'warning', icon: 'i-lucide-triangle-alert' })
	workbench.error.value = undefined
	void navigateTo('/views', { replace: true })
})

preview.onCommentTarget(async (widgetId) => {
	const panel = await showPanel('comments')
	panel?.openCreateModal(widgetId)
})

shell.onToggleRightPanel(togglePanel)
shell.onToggleCommentMode(() => preview.toggleCommentMode())
onBeforeUnmount(() => {
	shell.onToggleRightPanel(undefined)
	shell.onToggleCommentMode(undefined)
	preview.exitCommentMode()
})
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
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
          @thread-selected="thread = $event"
        />
      </aside>
    </UDashboardSidebar>

    <USlideover
      v-if="!isDesktop"
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
            @thread-selected="thread = $event"
          />
        </aside>
      </template>
    </USlideover>
  </div>
</template>
