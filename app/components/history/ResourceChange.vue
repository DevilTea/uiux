<script setup lang="ts">
import { computed, ref, shallowRef, useId, watch } from 'vue'
import { useI18n } from '#imports'
import type { ResourceSemanticChange } from '../../../src/application/services/history-diff'
import type { ResourceChangeSummary } from '../../../src/domain/history/summary'
import { CHANGE_ICONS, useHistoryLabels } from '../../composables/useHistoryLabels'
import { useVersionDiff } from '../../composables/useVersionHistory'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { useWorkbench } from '../../composables/useWorkbench'
import { PARENT_COMPARE, type ComparisonEndpoints } from '../../utils/version-history'
import { restoreSourceVersion } from '../../utils/version-restore'
import ResourceDiff from './ResourceDiff.vue'
import RestoreVersionAction from './RestoreVersionAction.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * One changed resource of a comparison: its heading and, once opened, its semantic diff, read for
 * this resource alone (`detail=semantic&resource=…`), so a comparison of many resources reads only
 * the ones the reader looks at. A View's canvas before and after (B9) goes in the `canvas` slot.
 * The open diff offers "Restore this version" for the selected version (Rule
 * 01a11a5e-18f2-7991-8f7d-aa4c8015d14a) when `restoreSourceVersion` allows it: desktop only (Rule
 * 01a11a5e-1bfa-71e9-9611-152b5b665379), Editor or above, a restorable kind held by that version.
 */
const props = defineProps<{
	row: Readonly<Pick<ResourceChangeSummary, 'kind' | 'key' | 'status'>>
	endpoints: ComparisonEndpoints
	refreshKey?: string
	/** The comparison's selected version: the one "Restore this version" restores. */
	selectedVersion?: string
	/** Open from the start: the selected resource, or the only one compared. */
	initiallyOpen: boolean
}>()
defineSlots<{ canvas?: (props: { change: ResourceSemanticChange }) => unknown }>()

const { t } = useI18n()
const labels = useHistoryLabels()
const uiux = useUiuxClient()
const panelId = useId()

const open = ref(props.initiallyOpen)
watch(() => props.initiallyOpen, (value) => { if (value) open.value = true })
const resources = computed(() => [{ kind: props.row.kind, key: props.row.key }])
const semantic = useVersionDiff(() => props.endpoints, { resources, detail: 'semantic', enabled: open, refreshKey: () => props.refreshKey })
const change = computed(() => semantic.result.value?.changes?.find(item => item.kind === props.row.kind && item.key === props.row.key))
const name = computed(() => labels.resourceName(props.row))

const { authorReadOnly } = useWorkbench()
const desktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const restoreFrom = computed(() => restoreSourceVersion({
	desktop: desktop.value,
	canAuthor: !authorReadOnly.value,
	resource: props.row,
	selectedVersion: props.selectedVersion,
	endpoints: props.endpoints,
}))
/** Compared with its parent, the selected version is this change: Restore brings back its after side. */
const restoresAfterChange = computed(() => props.endpoints.from === PARENT_COMPARE && props.endpoints.to === restoreFrom.value)

/** An Asset's current content digest: an image of either side with this digest is its current content. */
const currentAsset = shallowRef<{ digest?: string; url: string }>()
watch(() => open.value && props.row.kind === 'asset' ? props.row.key : undefined, async (key) => {
	if (!key || currentAsset.value) return
	const read = await uiux.readResource<{ resource: { content?: { digest?: string } } }>('asset', key).catch(() => undefined)
	currentAsset.value = { ...(read?.resource.content?.digest ? { digest: read.resource.content.digest } : {}), url: uiux.assetUrl(key) }
}, { immediate: true })
</script>

<template>
  <article
    class="space-y-2 border-t border-default pt-3"
    :data-resource-diff="`${row.kind}:${row.key}`"
    :data-open="open || undefined"
  >
    <h4 class="text-sm">
      <button
        type="button"
        class="flex w-full min-w-0 items-center gap-x-1.5 rounded-md text-start hover:bg-muted pointer-coarse:min-h-11"
        :aria-expanded="open"
        :aria-controls="open ? panelId : undefined"
        data-resource-diff-toggle
        @click="open = !open"
      >
        <UIcon
          :name="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          class="size-4 shrink-0 text-muted"
        />
        <UIcon
          :name="CHANGE_ICONS[row.status]!"
          class="size-4 shrink-0 text-muted"
        />
        <span class="shrink-0 text-xs text-muted">{{ t(`history.compare.status.${row.status}`) }}</span>
        <span class="shrink-0 text-xs text-muted">{{ labels.kindLabel(row.kind) }}</span>
        <span class="min-w-0 truncate font-medium text-highlighted">{{ name }}</span>
      </button>
    </h4>
    <div
      v-if="open"
      :id="panelId"
      class="space-y-2"
    >
      <div
        v-if="restoreFrom"
        class="flex justify-end"
      >
        <RestoreVersionAction
          :resource="{ kind: row.kind, key: row.key }"
          :version-id="restoreFrom"
          :resource-name="name"
          :after-change="restoresAfterChange"
        />
      </div>
      <UAlert
        v-if="semantic.error.value"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="semantic.error.value.message"
        :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void semantic.load() } }]"
      >
        <template #description>
          <WbErrorDescription
            :headline="semantic.error.value.message"
            :diagnostics="semantic.error.value.diagnostics"
            :status-code="semantic.error.value.statusCode"
          />
        </template>
      </UAlert>
      <USkeleton
        v-else-if="!change || (row.kind === 'asset' && !currentAsset)"
        class="h-12 w-full"
        :aria-label="t('common.loading')"
      />
      <template v-else>
        <ResourceDiff
          :diff="change.diff"
          :name="name"
          :current-image="currentAsset"
        />
        <!-- B9 seam: a View's canvas before and after (Rules 01a11a5e-1232…, 1288…, 12dc…) renders here. -->
        <slot
          v-if="change.kind === 'view'"
          name="canvas"
          :change="change"
        />
      </template>
    </div>
  </article>
</template>
