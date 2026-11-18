<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import ChangesSince from './ChangesSince.vue'

/**
 * The View page's history panel (Rule 01a11a5e-1aa5-7d13-939a-8d99245f7906): the changes since the
 * Git base of this View, as the Changes since Git base Feature describes. It is read-only, needs no key
 * beyond reading the Workspace, and keeps its base and selection as view state (nothing rides in the
 * address, and nothing is stored).
 */
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { t } = useI18n()
const { selectedViewId } = useWorkbench()

const view = computed(() => selectedViewId.value ? { kind: 'view', key: selectedViewId.value } : undefined)
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    data-view-history
  >
    <div class="p-3">
      <h2 class="sr-only">
        {{ t('panel.history') }}
      </h2>
      <ChangesSince
        v-if="view"
        :resource="view"
        :enabled="props.active"
        heading-tag="h3"
      />
    </div>
  </div>
</template>
