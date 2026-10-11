<script setup lang="ts">
import { computed } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { useI18n, useRoute } from '#imports'
import { useAccess } from '../../composables/useAccess'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useCheckpointAccess } from '../../composables/useCheckpointAccess'
import { useVersionTimeline } from '../../composables/useVersionHistory'
import { activityLocation, historyQuery, parseHistoryAddress, resolveHistorySelection, type HistoryAddress } from '../../utils/version-history'
import VersionTimeline from './VersionTimeline.vue'
import VersionComparison from './VersionComparison.vue'
import VersionCanvasSwitch from './VersionCanvasSwitch.vue'

/**
 * The View page's history panel (Rule 01a11a5e-1aa5-7d13-939a-8d99245f7906): the projection of the
 * versions in which this View changed (Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28) and the selected
 * comparison of this View. The selection is the address (Clause 01a11e0d-d7f5-7ef8-ac22-e235d4a00a41:
 * `version`, `compare` and `canvas` with `panel=history`); the page keeps those keys when it writes
 * the render context. The View diff's `canvas` choice opens the canvas before/after comparison in
 * place of the live canvas (`VersionCanvas`, on desktop and tablet). Version history reads need
 * `history.read`; without it the panel names the key instead (Rule 01a11485-eba3-7c07-a94f-0d69e610a0b6).
 */
const props = withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const { t } = useI18n()
const route = useRoute()
const shell = useWorkbenchShell()
const { selectedViewId } = useWorkbench()
const checkpoints = useCheckpointAccess()
const access = useAccess()
const canReadHistory = computed(() => access.can('history.read'))

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

const timeline = useVersionTimeline({ resource: view, enabled: () => props.active && !!view.value && canReadHistory.value })
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

      <template v-if="canReadHistory">
        <VersionComparison
          v-if="selection && view"
          :address="address"
          :request-resources="[view]"
          :latest-version-id="timeline.versions.value[0]?.id"
          :timeline-loaded="timeline.loaded.value"
          :link-for="panelTo"
          :close-to="panelTo({})"
          :full-comparison-to="fullComparison"
          class="border-b border-default pb-4"
        >
          <template #canvas>
            <VersionCanvasSwitch
              :address="address"
              :link-for="panelTo"
            />
          </template>
        </VersionComparison>
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
      <p
        v-else
        class="flex items-center gap-1.5 text-sm text-muted"
        data-access-notice="history"
        data-missing-key="history.read"
      >
        <UIcon
          name="i-lucide-user-lock"
          class="size-4 shrink-0"
        />
        {{ t('access.requiresKey', { key: 'history.read' }) }}
      </p>
    </div>
  </div>
</template>
