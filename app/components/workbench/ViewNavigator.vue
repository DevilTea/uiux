<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import WidgetTree from './WidgetTree.vue'

/** Views section of the left rail: a filterable View list and the selected View's Widget tree. */
const { t } = useI18n()
const workbench = useWorkbench()
const { views, selectedViewId, loading } = workbench

const items = computed(() => views.value.map(view => ({
	value: view.key,
	label: view.summary.name || t('common.unnamed'),
	...(view.summary.feature ? { description: view.summary.feature } : {}),
	diagnosticCount: view.diagnosticCount,
})))

const selectedModel = computed({
	get: () => selectedViewId.value,
	set: (value: string | undefined) => {
		if (value) void workbench.selectView(value)
	},
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
    <section
      :aria-label="t('workbench.views.title')"
      class="flex max-h-[45%] shrink-0 flex-col border-b border-default"
    >
      <div class="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 class="text-xs font-semibold text-muted">
          {{ t('workbench.views.title') }}
        </h2>
        <UBadge
          color="neutral"
          variant="subtle"
          size="sm"
        >
          {{ views.length }}
        </UBadge>
      </div>

      <UEmpty
        v-if="!views.length && !loading"
        size="xs"
        variant="naked"
        icon="i-lucide-layout-template"
        :title="t('workbench.views.emptyTitle')"
        :ui="{ root: 'p-3 sm:p-4 lg:p-4' }"
      >
        <template #description>
          <i18n-t
            keypath="workbench.views.emptyDescription"
            tag="span"
            scope="global"
          >
            <template #tool>
              <code class="rounded bg-elevated px-1 py-0.5 font-mono text-xs text-highlighted">create_view</code>
            </template>
          </i18n-t>
        </template>
      </UEmpty>

      <UListbox
        v-else
        v-model="selectedModel"
        :items="items"
        value-key="value"
        label-key="label"
        description-key="description"
        :filter="{ placeholder: t('workbench.views.filterPlaceholder'), icon: 'i-lucide-search', size: 'xs' }"
        :filter-fields="['label', 'description', 'value']"
        size="sm"
        :aria-label="t('workbench.views.listLabel')"
        :ui="{
          root: 'min-h-0 rounded-none ring-0 mx-2 mb-2',
          input: 'border-b-0 pb-1',
          content: 'max-h-none',
          item: 'data-[state=checked]:text-selection data-[state=checked]:before:bg-selection-subtle',
        }"
      >
        <template #item-trailing="{ item }">
          <UBadge
            v-if="item.diagnosticCount"
            color="warning"
            variant="soft"
            size="sm"
            :aria-label="t('workbench.views.diagnosticCount', item.diagnosticCount)"
          >
            {{ item.diagnosticCount }}
          </UBadge>
        </template>
        <template #empty="{ searchTerm }">
          {{ t('workbench.views.noMatches', { query: searchTerm }) }}
        </template>
      </UListbox>
    </section>

    <WidgetTree />
  </div>
</template>
