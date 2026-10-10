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
 * version of its own with `restoredFrom`), linked to that version's comparison. A source that is
 * no longer in history (404: a deleted Checkpoint, a pruned autosave) says so, without a link; one
 * that could not be read for another reason is named generically.
 */
const props = defineProps<{ versionId: string; to: RouteLocationRaw }>()
const { t } = useI18n()
const labels = useHistoryLabels()

/** The source's record; `gone` when history no longer holds it, `unread` when it could not be read; `undefined` while read. */
const source = shallowRef<VersionRecord | 'gone' | 'unread'>()
watch(() => props.versionId, async (id) => {
	source.value = undefined
	let next: VersionRecord | 'gone' | 'unread'
	try {
		next = (await readVersionRecord(id)).version
	}
	catch (cause) {
		const failure = cause as { statusCode?: number; status?: number }
		next = (failure.statusCode ?? failure.status) === 404 ? 'gone' : 'unread'
	}
	if (props.versionId === id) source.value = next
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
      v-if="typeof source === 'object'"
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
    <span v-else-if="source === 'gone'">{{ t('history.row.restored') }}</span>
    <span v-else-if="source === 'unread'">{{ t('history.restore.sourceUnread') }}</span>
    <span
      v-else
      class="sr-only"
      data-restored-from-loading
    >{{ t('history.restore.sourceLoading') }}</span>
  </p>
</template>
