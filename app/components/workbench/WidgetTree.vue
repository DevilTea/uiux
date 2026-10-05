<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { TreeItem } from '@nuxt/ui'
import { useWorkbench } from '../../composables/useWorkbench'
import type { WidgetTreeNode } from '../../../src/preview/widget-tree'

/**
 * The selected View's full Widget hierarchy (View.ir), at any depth.
 * UTree (reka-ui TreeRoot) provides role=tree / treeitem / group, aria-expanded,
 * aria-selected and roving-focus keyboard navigation (arrows, Home / End, Enter).
 */
const { t } = useI18n()
const workbench = useWorkbench()
const { widgetTreeResult, selectedWidgetId, selectedView } = workbench

type WidgetTreeItem = TreeItem & {
	id: string
	type: string
	slotName?: string
	slotIndex?: number
	children?: WidgetTreeItem[]
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
})

const selectedModel = computed<WidgetTreeItem | undefined>({
	get: () => itemsById.value.get(selectedWidgetId.value)?.item,
	set: (item) => {
		if (item) workbench.selectWidget(item.id)
	},
})

const hasEmptyRoot = computed(() => rootItem.value && !rootItem.value.children?.length)
</script>

<template>
  <section
    class="flex min-h-0 flex-1 flex-col"
    :aria-label="t('workbench.tree.title')"
  >
    <div class="flex items-center justify-between border-b border-default px-3 py-2">
      <h2 class="text-xs font-semibold text-muted">
        {{ t('workbench.tree.title') }}
      </h2>
    </div>

    <div class="flex-1 overflow-y-auto p-2">
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
            link: 'data-selected:text-selection data-selected:before:bg-selection-subtle hover:not-data-selected:before:bg-elevated/50 text-default',
          }"
        >
          <template #item-leading="{ item }">
            <UIcon
              :name="item.children?.length ? 'i-lucide-box' : 'i-lucide-square'"
              class="size-3.5 shrink-0 text-dimmed"
            />
          </template>
          <template #item-label="{ item }">
            <span class="flex min-w-0 items-center gap-1.5">
              <UBadge
                v-if="item.slotName"
                color="neutral"
                variant="soft"
                size="xs"
                class="font-mono"
              >
                {{ item.slotName }}
              </UBadge>
              <span class="shrink-0 font-medium">{{ item.type }}</span>
              <span class="truncate font-mono text-xs text-muted">#{{ item.id }}</span>
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
