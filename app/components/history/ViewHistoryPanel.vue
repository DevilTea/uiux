<script setup lang="ts">
import { computed } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { useI18n, useRoute } from '#imports'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useCheckpointAccess } from '../../composables/useCheckpointAccess'
import { useVersionTimeline } from '../../composables/useVersionHistory'
import { activityLocation, historyQuery, parseHistoryAddress, resolveHistorySelection, type HistoryAddress } from '../../utils/version-history'
import VersionTimeline from './VersionTimeline.vue'
import VersionComparison from './VersionComparison.vue'

/**
 * The View page's history panel (Rule 01a11a5e-1aa5-7d13-939a-8d99245f7906): the projection of the
 * versions in which this View changed (Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28) and the selected
 * comparison of this View. The selection is the address (Clause 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41:
 * `version`, `compare` and `canvas` with `panel=history`); the page keeps those keys when it writes
 * the render context. `canvas` is kept for B9's canvas comparison and shows nothing yet.
 */
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { t } = useI18n()
const route = useRoute()
const shell = useWorkbenchShell()
const { selectedViewId, isReadOnly } = useWorkbench()
const checkpoints = useCheckpointAccess()

const view = computed(() => selectedViewId.value ? { kind: 'view', key: selectedViewId.value } : undefined)
const address = computed<HistoryAddress>(() => {
	const { version, compare, canvas } = parseHistoryAddress(route.query)
	return { ...(version ? { version } : {}), ...(compare ? { compare } : {}), ...(canvas ? { canvas } : {}) }
})
const selection = computed(() => resolveHistorySelection(address.value))

/** This page with another history selection; the render context and other keys stay. */
function panelTo(next: HistoryAddress) {
	const query: LocationQueryRaw = { ...route.query, panel: 'history' }
	delete query.version
	delete query.compare
	delete query.canvas
	return { path: route.path, query: { ...query, ...historyQuery(next, ['version', 'compare', 'canvas']) } }
}

const timeline = useVersionTimeline({ resource: view, enabled: () => props.active && !!view.value && !isReadOnly.value })
const fullComparison = computed(() => selection.value && view.value
	? activityLocation({ version: selection.value.version, ...(address.value.compare ? { compare: address.value.compare } : {}), resource: view.value })
	: undefined)
</script>

<template>
  <div
    class="flex min-h-0 flex-1 flex-col overflow-y-auto"
    data-view-history
  >
    <div class="space-y-4 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="me-auto text-sm font-semibold text-highlighted">
          {{ t('history.view.title') }}
        </h2>
        <UButton
          v-if="checkpoints.canCreate.value"
          size="sm"
          icon="i-lucide-flag"
          :label="t('history.checkpoint.create')"
          data-create-checkpoint
          @click="shell.checkpointOpen.value = true"
        />
      </div>

      <p
        v-if="isReadOnly"
        class="text-sm text-muted"
      >
        {{ t('history.publication') }}
      </p>
      <template v-else>
        <VersionComparison
          v-if="selection && view"
          :address="address"
          :request-resources="[view]"
          :latest-version-id="timeline.versions.value[0]?.id"
          :link-for="panelTo"
          :close-to="panelTo({})"
          :full-comparison-to="fullComparison"
          class="border-b border-default pb-4"
        />
        <VersionTimeline
          :versions="timeline.rows.value"
          :loading="timeline.loading.value"
          :loaded="timeline.loaded.value"
          :error="timeline.error.value"
          :has-more="!!timeline.nextCursor.value"
          :loading-more="timeline.loadingMore.value"
          :selected="selection?.version"
          :link-for="(id) => panelTo({ version: id })"
          :compare-link-for="selection ? (id) => panelTo({ version: selection!.version, compare: id }) : undefined"
          :empty-title="t('history.view.emptyTitle')"
          :empty-description="t('history.view.emptyDescription')"
          compact
          @load-more="timeline.loadMore()"
          @retry="timeline.load()"
        />
      </template>
    </div>
  </div>
</template>
