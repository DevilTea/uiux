<script setup lang="ts">
import { computed, onMounted, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import type { VersionListItem } from '../../../src/application/services/history-service'
import type { HistoryWriteEvent } from '../../../src/domain/history/schema'
import { readVersionRecord } from '../../composables/useVersionHistory'
import { CHANGE_ICONS, useHistoryLabels } from '../../composables/useHistoryLabels'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'

/**
 * An expanded timeline row (Rule 01a11a5e-1946-7217-aff5-db13df3a2977): the resources the version
 * changed against its parent, then, for a recorded host version, its write events from the record.
 */
const props = defineProps<{ version: VersionListItem }>()
const { t } = useI18n()
const labels = useHistoryLabels()

const events = shallowRef<readonly HistoryWriteEvent[]>()
const loading = ref(false)
const error = shallowRef<FetchErrorDetails>()
const hasEvents = computed(() => props.version.type !== 'checkpoint')

async function load(): Promise<void> {
	if (!hasEvents.value) return
	loading.value = true
	error.value = undefined
	try {
		const read = await readVersionRecord(props.version.id)
		events.value = 'events' in read.version ? read.version.events : []
	}
	catch (cause) {
		error.value = describeFetchError(cause, t('history.row.eventsLoadFailed'))
	}
	finally {
		loading.value = false
	}
}
onMounted(load)
</script>

<template>
  <div
    class="space-y-3 border-t border-default bg-muted px-3 py-2.5"
    data-version-details
  >
    <section
      class="space-y-1"
      :aria-label="t('history.row.changedResources')"
    >
      <h4 class="text-xs font-medium text-muted">
        {{ t('history.row.changedResources') }}
      </h4>
      <p
        v-if="!version.summary.length"
        class="text-xs text-muted"
      >
        {{ t('history.row.noChanges') }}
      </p>
      <ul
        v-else
        class="space-y-0.5"
      >
        <li
          v-for="resource in version.summary"
          :key="`${resource.kind}:${resource.key}`"
          class="flex min-w-0 items-center gap-1.5 text-xs"
          :data-changed-resource="`${resource.kind}:${resource.key}`"
          :data-status="resource.status"
        >
          <UIcon
            :name="CHANGE_ICONS[resource.status]!"
            class="size-3.5 shrink-0 text-muted"
          />
          <span class="sr-only">{{ t(`history.compare.status.${resource.status}`) }}</span>
          <span class="shrink-0 text-muted">{{ labels.kindLabel(resource.kind) }}</span>
          <span class="min-w-0 truncate text-default">{{ labels.resourceName(resource) }}</span>
        </li>
      </ul>
    </section>

    <section
      v-if="hasEvents"
      class="space-y-1"
      :aria-label="t('history.row.events')"
      data-version-events
    >
      <h4 class="text-xs font-medium text-muted">
        {{ t('history.row.events') }}
      </h4>
      <USkeleton
        v-if="loading && !events"
        class="h-4 w-48"
        :aria-label="t('common.loading')"
      />
      <p
        v-else-if="error"
        class="flex flex-wrap items-center gap-2 text-xs text-error"
        role="alert"
      >
        {{ error.message }}
        <UButton
          size="xs"
          variant="link"
          color="error"
          :label="t('common.retry')"
          @click="load"
        />
      </p>
      <p
        v-else-if="!events?.length"
        class="text-xs text-muted"
      >
        {{ t('history.row.noEvents') }}
      </p>
      <ol
        v-else
        class="space-y-0.5"
      >
        <li
          v-for="(event, index) in events"
          :key="index"
          class="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-xs"
          data-version-event
        >
          <time
            class="shrink-0 text-muted tabular-nums"
            :datetime="event.at"
          >{{ labels.time(event.at) }}</time>
          <span class="shrink-0 text-default">{{ labels.actorName(event.actor) }}</span>
          <span
            v-if="labels.operationLabel(event.operation)"
            class="shrink-0 text-default"
          >{{ labels.operationLabel(event.operation) }}</span>
          <code
            v-else
            class="shrink-0 font-mono text-default"
          >{{ event.operation }}</code>
          <span class="min-w-0 truncate text-muted">{{ labels.kindLabel(event.resource.kind) }} · {{ labels.resourceName(event.resource) }}</span>
        </li>
      </ol>
    </section>
  </div>
</template>
