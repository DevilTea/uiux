<script setup lang="ts">
import { shallowRef, watch } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useI18n } from '#imports'
import type { VersionRecord } from '../../../src/domain/history/schema'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { readVersionRecord } from '../../composables/useVersionHistory'

/**
 * A restore's own timeline row names the version it restored from (Rules
 * 01a11a5e-14ce-7894-9c46-a8ad4b45e6d6 and 01a11e0d-d911-7030-9565-7473aa0995e1: the restore is a
 * version of its own with `restoredFrom`), linked to that version's comparison. A source that can
 * no longer be read (a deleted Checkpoint, a pruned autosave) is named generically, without a link.
 */
const props = defineProps<{ versionId: string; to: RouteLocationRaw }>()
const { t } = useI18n()
const labels = useHistoryLabels()

const source = shallowRef<VersionRecord | null>()
watch(() => props.versionId, async (id) => {
	source.value = undefined
	const read = await readVersionRecord(id).catch(() => undefined)
	if (props.versionId === id) source.value = read?.version ?? null
}, { immediate: true })
</script>

<template>
  <p
    class="flex min-w-0 items-start gap-1 text-xs text-muted"
    :data-restored-from="versionId"
  >
    <UIcon
      name="i-lucide-history"
      class="mt-px size-3.5 shrink-0"
    />
    <i18n-t
      v-if="source"
      keypath="history.row.restoredFrom"
      tag="span"
      scope="global"
      class="min-w-0 break-words"
    >
      <template #version>
        <ULink
          :to="to"
          class="text-default underline underline-offset-2"
          :title="labels.dateTime(source.at)"
          data-restored-from-link
        >
          {{ labels.versionTitle(source) }}
        </ULink>
      </template>
    </i18n-t>
    <span v-else-if="source === null">{{ t('history.row.restored') }}</span>
  </p>
</template>
