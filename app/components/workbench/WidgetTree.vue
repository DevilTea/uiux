<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { TreeItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { WidgetTreeNode } from '../../../src/preview/widget-tree'

/**
 * The selected View's full Widget hierarchy (View.ir), at any depth (DESIGN.md "Tree").
 * UTree (reka-ui TreeRoot) provides role=tree / treeitem / group, aria-expanded,
 * aria-selected and roving-focus keyboard navigation (arrows, Home / End, Enter).
 *
 * Selection is shared with the canvas: picking a row selects the Widget (the canvas highlights it
 * once the runtime reports it visible), and a canvas pick expands the ancestors of its row.
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { widgetTreeResult, selectedWidgetId, selectedView, selectedViewId, reviews } = workbench

type WidgetTreeItem = TreeItem & {
	id: string
	type: string
	slotName?: string
	slotIndex?: number
	children?: WidgetTreeItem[]
}

/** Lucide glyphs for the reference Catalog's Widget types; anything else is a generic box. */
function typeIcon(type: string, hasChildren: boolean): string {
	switch (type) {
		case 'RootShell': return 'i-lucide-frame'
		case 'Stack': return 'i-lucide-rows-3'
		case 'Panel': return 'i-lucide-panel-top'
		case 'Text': return 'i-lucide-type'
		case 'Badge': return 'i-lucide-tag'
		case 'Button': return 'i-lucide-rectangle-horizontal'
		case 'Divider': return 'i-lucide-minus'
		case 'NavItem': return 'i-lucide-link'
		case 'TextInput': return 'i-lucide-text-cursor-input'
		case 'Image': return 'i-lucide-image'
		default: return hasChildren ? 'i-lucide-box' : 'i-lucide-square'
	}
}

function toItem(node: WidgetTreeNode): WidgetTreeItem {
	return {
		id: node.id,
		label: node.type,
		type: node.type,
		...(node.slotName !== undefined ? { slotName: node.slotName } : {}),
		...(node.slotIndex !== undefined ? { slotIndex: node.slotIndex } : {}),
		...(node.children.length ? { children: node.children.map(toItem) } : {}),
	}
}

const rootItem = computed(() => widgetTreeResult.value?.status === 'valid' ? toItem(widgetTreeResult.value.root) : undefined)
const items = computed(() => rootItem.value ? [rootItem.value] : [])

const itemsById = computed(() => {
	const map = new Map<string, { item: WidgetTreeItem; ancestors: string[] }>()
	const visit = (item: WidgetTreeItem, ancestors: string[]) => {
		map.set(item.id, { item, ancestors })
		for (const child of item.children ?? []) visit(child, [...ancestors, item.id])
	}
	if (rootItem.value) visit(rootItem.value, [])
	return map
})

/** Unresolved threads anchored on each Widget of this View. */
const commentCounts = computed(() => {
	const counts = new Map<string, number>()
	for (const review of reviews.value) {
		const anchor = review.summary.anchor
		if (!anchor || anchor.viewId !== selectedViewId.value || review.summary.status === 'resolved') continue
		counts.set(anchor.widgetId, (counts.get(anchor.widgetId) ?? 0) + 1)
	}
	return counts
})

/** Checks findings that resolve to a Widget: the worst severity wins the dot. */
const findings = computed(() => {
	const map = new Map<string, 'error' | 'warning'>()
	for (const diagnostic of selectedView.value?.diagnostics ?? []) {
		const id = workbench.resolveWidgetIdFromDiagnostic(diagnostic)
		if (!id) continue
		const severity = (diagnostic as { severity?: string }).severity === 'warning' ? 'warning' : 'error'
		if (map.get(id) !== 'error') map.set(id, severity)
	}
	return map
})

const expanded = ref<string[]>([])

// Expand every branch whenever another View (or a new revision of it) is loaded.
watch(() => selectedView.value?.revision, () => {
	expanded.value = [...itemsById.value.values()]
		.filter(entry => entry.item.children?.length)
		.map(entry => entry.item.id)
}, { immediate: true })

// Keep the selected Widget visible, e.g. when it was picked in the preview iframe.
watch(selectedWidgetId, (id) => {
	const entry = itemsById.value.get(id)
	if (!entry) return
	const missing = entry.ancestors.filter(ancestor => !expanded.value.includes(ancestor))
	if (missing.length) expanded.value = [...expanded.value, ...missing]
	// Bring the row into view after the tree re-renders the expanded branch.
	requestAnimationFrame(() => {
		document.querySelector(`[data-widget-row="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
	})
}, { flush: 'post' })

const selectedModel = computed<WidgetTreeItem | undefined>({
	get: () => itemsById.value.get(selectedWidgetId.value)?.item,
	set: (item) => {
		if (item) workbench.selectWidget(item.id)
	},
})

const hasEmptyRoot = computed(() => rootItem.value && !rootItem.value.children?.length)

/** A deep link to a Widget that is no longer in the View (Part 3): a persistent inline notice. */
const missingWidgetId = computed(() => rootItem.value && selectedWidgetId.value && !itemsById.value.has(selectedWidgetId.value)
	? selectedWidgetId.value
	: undefined)

</script>

<template>
  <section
    class="flex min-h-0 flex-1 flex-col"
    :aria-label="t('workbench.tree.title')"
  >
    <div class="flex items-center justify-between px-4 pt-2 pb-1">
      <h2 class="text-xs font-medium text-muted">
        {{ t('workbench.tree.title') }}
      </h2>
    </div>

    <UAlert
      v-if="missingWidgetId"
      color="warning"
      variant="subtle"
      icon="i-lucide-unlink"
      :description="t('canvas.widgetMissing', { id: `#${missingWidgetId}` })"
      class="mx-2 mb-1 w-auto"
      :ui="{ description: 'text-xs' }"
      data-widget-missing
    />

    <!-- Deep Views scroll sideways instead of squeezing the deepest labels to nothing. -->
    <div class="flex-1 overflow-auto px-2 pb-2">
      <template v-if="rootItem">
        <UTree
          v-model="selectedModel"
          v-model:expanded="expanded"
          :items="items"
          :get-key="(item: WidgetTreeItem) => item.id"
          size="sm"
          color="primary"
          selection-behavior="replace"
          :aria-label="t('workbench.tree.label')"
          :ui="{
            root: 'min-w-max',
            listWithChildren: 'ms-2.5',
            link: 'group/row min-w-max data-selected:text-selection-text data-selected:before:bg-selection-subtle hover:not-data-selected:before:bg-muted text-default',
          }"
        >
          <template #item-leading="{ item }">
            <UIcon
              :name="typeIcon(item.type, !!item.children?.length)"
              class="size-3.5 shrink-0 text-dimmed group-data-selected/row:text-selection-text"
            />
          </template>
          <template #item-label="{ item }">
            <span
              class="flex min-w-0 items-center gap-1.5"
              :title="item.slotName ? `${item.slotName}[${item.slotIndex ?? 0}]` : undefined"
              :data-widget-row="item.id"
            >
              <span class="shrink-0">{{ item.type }}</span>
              <span class="truncate font-mono text-xs text-dimmed opacity-0 group-hover/row:opacity-100 group-focus-visible/row:opacity-100 group-data-selected/row:text-selection-text group-data-selected/row:opacity-100">#{{ item.id }}</span>
            </span>
          </template>
          <template #item-trailing="{ item, ui }">
            <span class="flex shrink-0 items-center gap-1.5">
              <span
                v-if="commentCounts.get(item.id)"
                class="inline-flex items-center gap-0.5 text-xs font-medium text-annotation"
              >
                <UIcon
                  name="i-lucide-message-circle"
                  class="size-3"
                />{{ commentCounts.get(item.id) }}
                <span class="sr-only">{{ t('workbench.tree.commentCount', commentCounts.get(item.id) ?? 0) }}</span>
              </span>
              <span
                v-if="findings.get(item.id)"
                class="size-2 rounded-full"
                :class="findings.get(item.id) === 'error' ? 'bg-error' : 'bg-warning'"
              >
                <span class="sr-only">{{ t(findings.get(item.id) === 'error' ? 'workbench.tree.hasError' : 'workbench.tree.hasWarning') }}</span>
              </span>
              <UIcon
                v-if="item.children?.length"
                name="i-lucide-chevron-down"
                :class="ui.linkTrailingIcon()"
              />
            </span>
          </template>
        </UTree>
        <p
          v-if="hasEmptyRoot"
          class="ms-6 border-s border-default py-1 ps-2 text-xs text-dimmed italic"
        >
          {{ t('workbench.tree.emptyContentSlot') }}
        </p>
      </template>

      <UEmpty
        v-else-if="selectedView"
        size="xs"
        icon="i-lucide-network"
        :title="t('workbench.tree.unavailable')"
        :description="widgetTreeResult?.status === 'invalid' ? widgetTreeResult.reason : undefined"
      />
    </div>
  </section>
</template>
