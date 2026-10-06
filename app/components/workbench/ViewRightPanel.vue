<script setup lang="ts">
import { computed, nextTick } from 'vue'
import { useI18n } from '#imports'
import type { TabsItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { ViewPanelTab } from '../../composables/workbench-types'
import { useCanvasComments } from '../../composables/useCanvasComments'
import CommentsTab from './comments/CommentsTab.vue'
import ReadinessTab from '../readiness/ReadinessTab.vue'
import WidgetInspector from './WidgetInspector.vue'
import SpecDocument from './SpecDocument.vue'

/**
 * The View page's right panel: Comments, Inspect, Spec and Readiness (brief e). Comments is the
 * list companion to the canvas pins (R7a); Inspect and Spec are the R5 property sheet and Spec
 * document; Readiness is the View's validation, Evidence, Reviews and Handoff facets (R9).
 */
const tab = defineModel<ViewPanelTab>('tab', { required: true })

const { t } = useI18n()
const workbench = useWorkbench()
const { selectedView, selectedViewId, reviews } = workbench
const comments = useCanvasComments()!

const unresolvedHere = computed(() => reviews.value.filter(review =>
	review.summary.anchor?.viewId === selectedViewId.value && review.summary.status !== 'resolved').length)
const findingsHere = computed(() => selectedView.value?.diagnostics.length ?? 0)

const items = computed<TabsItem[]>(() => [
	{ value: 'comments', slot: 'comments' as const, label: t('panel.comments'), badge: unresolvedHere.value ? { label: String(unresolvedHere.value), color: 'annotation', variant: 'soft', size: 'sm' } : undefined },
	{ value: 'inspect', slot: 'inspect' as const, label: t('panel.inspect') },
	{ value: 'spec', slot: 'spec' as const, label: t('panel.spec') },
	{ value: 'readiness', slot: 'readiness' as const, label: t('panel.readiness'), badge: findingsHere.value ? { label: String(findingsHere.value), color: 'warning', variant: 'soft', size: 'sm' } : undefined },
])

const tabModel = computed({
	get: () => tab.value,
	set: (value: string | number) => { tab.value = value as ViewPanelTab },
})

/** Inspector and Spec links into the thread list: switch to Comments, then open the thread and its pin. */
async function openThread(threadId: string): Promise<void> {
	tab.value = 'comments'
	await nextTick()
	if (threadId && comments.open(threadId)) comments.requestReveal(threadId)
}

/** Inspector "Comment": the composer opens at the Widget's default pin point (brief c, section 8). */
function commentOn(widgetId: string): void {
	workbench.preview.commentOnWidget(widgetId)
}

</script>

<template>
  <UTabs
    v-model="tabModel"
    :items="items"
    variant="link"
    color="primary"
    :unmount-on-hide="false"
    :ui="{
      root: 'flex min-h-0 flex-1 flex-col gap-0',
      list: 'shrink-0 border-b border-default px-2',
      trigger: 'px-2',
      content: 'flex min-h-0 flex-1 flex-col data-[state=inactive]:hidden',
    }"
  >
    <template #comments>
      <CommentsTab />
    </template>
    <template #inspect>
      <WidgetInspector
        @comment="commentOn"
        @open-thread="openThread"
        @open-checks="tab = 'readiness'"
      />
    </template>
    <template #spec>
      <SpecDocument @open-thread="openThread" />
    </template>
    <template #readiness>
      <ReadinessTab
        @open-comments="tab = 'comments'"
        @open-inspect="tab = 'inspect'"
      />
    </template>
  </UTabs>
</template>
