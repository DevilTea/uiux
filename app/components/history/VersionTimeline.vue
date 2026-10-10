<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import type { RouteLocationRaw } from 'vue-router'
import { useI18n } from '#imports'
import type { VersionListItem } from '../../../src/application/services/history-service'
import { useHistoryLabels, VERSION_TYPE_ICONS } from '../../composables/useHistoryLabels'
import type { FetchErrorDetails } from '../../utils/fetch-error'
import { groupVersionsByDay } from '../../utils/version-history'
import VersionDetails from './VersionDetails.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * The version timeline (Rule 01a11a5e-1946-7217-aff5-db13df3a2977): newest first, grouped by day,
 * autosave, Checkpoint, external and system rows; a row expands to what it changed and its write
 * events; consecutive autosaves with no net change collapse into one row (Rule
 * 01a11a5e-19f4-77a0-8e8b-30ea280b7b24). Each row links to its comparison with the parent; the
 * address is the caller's (`linkFor`). The Delete row action is offered only when `canDelete`
 * (an Owner on a desktop layout; Rules 01a11e0d-da2f-718f-b3c3-acf2f11fb683 and 01a11e0d-dada-7f49-a4a0-5b45d70b23e8).
 */
const props = withDefaults(defineProps<{
	versions: readonly VersionListItem[]
	loading?: boolean
	loaded?: boolean
	error?: FetchErrorDetails
	hasMore?: boolean
	loadingMore?: boolean
	/** The selected version's ID. */
	selected?: string
	/** The address of a version's comparison with its parent. */
	linkFor: (id: string) => RouteLocationRaw
	/** The address comparing the selected version with this one; omitted when nothing is selected. */
	compareLinkFor?: (id: string) => RouteLocationRaw | undefined
	canDelete?: boolean
	emptyTitle?: string
	emptyDescription?: string
	/** Tighter rows for the View page's side panel. */
	compact?: boolean
}>(), { loading: false, loaded: false, error: undefined, hasMore: false, loadingMore: false, selected: undefined, compareLinkFor: undefined, canDelete: false, emptyTitle: undefined, emptyDescription: undefined, compact: false })
const emit = defineEmits<{ delete: [version: VersionListItem]; loadMore: []; retry: [] }>()

const { t } = useI18n()
const labels = useHistoryLabels()
const baseId = useId()

const days = computed(() => groupVersionsByDay(props.versions))
const expanded = ref(new Set<string>())
function toggle(id: string): void {
	const next = new Set(expanded.value)
	if (next.has(id)) next.delete(id)
	else next.add(id)
	expanded.value = next
}
</script>

<template>
  <div
    class="space-y-4"
    data-version-timeline
    :aria-busy="loading || undefined"
  >
    <UAlert
      v-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="error.message"
      :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => emit('retry') }]"
    >
      <template #description>
        <WbErrorDescription
          :headline="error.message"
          :diagnostics="error.diagnostics"
          :status-code="error.statusCode"
        />
      </template>
    </UAlert>
    <div
      v-if="loading && !loaded"
      class="space-y-2"
    >
      <USkeleton
        v-for="index in 4"
        :key="index"
        class="h-12 w-full"
        :aria-label="t('common.loading')"
      />
    </div>
    <UEmpty
      v-else-if="loaded && !versions.length && !error"
      icon="i-lucide-history"
      variant="naked"
      :title="emptyTitle ?? t('history.emptyTitle')"
      :description="emptyDescription ?? t('history.emptyDescription')"
      data-timeline-empty
    />

    <section
      v-for="group in days"
      :key="group.day"
      class="space-y-1.5"
      :aria-labelledby="`${baseId}-${group.day}`"
      data-timeline-day
    >
      <h3
        :id="`${baseId}-${group.day}`"
        class="text-xs font-medium text-muted"
      >
        {{ labels.dayLabel(group.day) }}
      </h3>
      <ol class="divide-y divide-(--ui-border) rounded-lg border border-default">
        <template
          v-for="entry in group.entries"
          :key="entry.type === 'version' ? entry.version.id : `quiet-${entry.id}`"
        >
          <li
            v-if="entry.type === 'version'"
            :data-version-row="entry.version.id"
            :data-version-type="entry.version.type"
            :data-selected="entry.version.id === selected || undefined"
          >
            <div
              class="flex items-start gap-2.5"
              :class="[compact ? 'px-2.5 py-2' : 'px-3 py-2.5', entry.version.id === selected ? 'bg-elevated' : '']"
            >
              <UIcon
                :name="VERSION_TYPE_ICONS[entry.version.type]"
                class="mt-0.5 size-4 shrink-0"
                :class="entry.version.type === 'checkpoint' ? 'text-highlighted' : 'text-muted'"
              />
              <div class="min-w-0 flex-1 space-y-0.5">
                <p class="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <span
                    class="min-w-0 truncate text-sm text-highlighted"
                    :class="entry.version.type === 'checkpoint' ? 'font-semibold' : 'font-medium'"
                    :title="labels.storedName(entry.version)"
                    data-version-title
                  >{{ labels.versionTitle(entry.version) }}</span>
                  <UBadge
                    v-if="entry.version.type === 'checkpoint'"
                    color="neutral"
                    variant="soft"
                    icon="i-lucide-flag"
                  >
                    {{ t('history.type.checkpoint') }}
                  </UBadge>
                  <span
                    v-if="entry.version.id === selected"
                    class="text-xs text-muted"
                  >{{ t('history.row.selected') }}</span>
                </p>
                <p class="flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                  <time
                    class="shrink-0 tabular-nums"
                    :datetime="entry.version.at"
                    :title="labels.dateTime(entry.version.at)"
                  >{{ labels.time(entry.version.at) }}</time>
                  <span aria-hidden="true">·</span>
                  <UIcon
                    :name="labels.actorIcon(entry.version.actor)"
                    class="size-3.5 shrink-0"
                  />
                  <span class="truncate">{{ labels.actorName(entry.version.actor) }}</span>
                  <span aria-hidden="true">·</span>
                  <span>{{ entry.version.summary.length ? t('history.row.changed', entry.version.summary.length) : t('history.row.noChanges') }}</span>
                </p>
                <p
                  v-if="entry.version.note"
                  class="text-xs whitespace-pre-line text-default"
                  data-version-note
                >
                  {{ entry.version.note }}
                </p>
                <p
                  v-if="entry.version.restoredFrom"
                  class="text-xs text-muted"
                >
                  {{ t('history.row.restored') }}
                </p>
                <p
                  v-if="entry.version.recordingGap"
                  class="flex items-center gap-1 text-xs text-warning"
                >
                  <UIcon
                    name="i-lucide-triangle-alert"
                    class="size-3.5"
                  />{{ t('history.row.recordingGap') }}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <UTooltip
                  :text="t('history.row.compareNamed', { name: labels.versionTitle(entry.version) })"
                  :disabled="!compact"
                >
                  <UButton
                    :to="linkFor(entry.version.id)"
                    size="xs"
                    color="neutral"
                    variant="outline"
                    icon="i-lucide-arrow-left-right"
                    :label="compact ? undefined : t('history.row.compare')"
                    :aria-label="t('history.row.compareNamed', { name: labels.versionTitle(entry.version) })"
                    data-version-compare
                  />
                </UTooltip>
                <UTooltip
                  v-if="compareLinkFor && selected && selected !== entry.version.id && compareLinkFor(entry.version.id)"
                  :text="t('history.row.compareWithSelected', { name: labels.versionTitle(entry.version) })"
                >
                  <UButton
                    :to="compareLinkFor(entry.version.id)"
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-diff"
                    :aria-label="t('history.row.compareWithSelected', { name: labels.versionTitle(entry.version) })"
                    data-version-compare-with
                  />
                </UTooltip>
                <UTooltip
                  v-if="canDelete && entry.version.type === 'checkpoint'"
                  :text="t('history.delete.action')"
                >
                  <UButton
                    size="xs"
                    color="neutral"
                    variant="ghost"
                    icon="i-lucide-trash-2"
                    :aria-label="t('history.delete.actionNamed', { name: labels.versionTitle(entry.version) })"
                    data-version-delete
                    @click="emit('delete', entry.version)"
                  />
                </UTooltip>
                <UButton
                  size="xs"
                  color="neutral"
                  variant="ghost"
                  :icon="expanded.has(entry.version.id) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  :aria-expanded="expanded.has(entry.version.id)"
                  :aria-controls="expanded.has(entry.version.id) ? `${baseId}-details-${entry.version.id}` : undefined"
                  :aria-label="t(expanded.has(entry.version.id) ? 'history.row.collapse' : 'history.row.expand', { name: labels.versionTitle(entry.version) })"
                  data-version-expand
                  @click="toggle(entry.version.id)"
                />
              </div>
            </div>
            <VersionDetails
              v-if="expanded.has(entry.version.id)"
              :id="`${baseId}-details-${entry.version.id}`"
              :version="entry.version"
            />
          </li>
          <li
            v-else
            :data-quiet-run="entry.versions.length"
          >
            <button
              type="button"
              class="flex w-full items-center gap-2.5 text-start text-xs text-muted hover:bg-muted pointer-coarse:min-h-11"
              :class="compact ? 'px-2.5 py-1.5' : 'px-3 py-2'"
              :aria-expanded="expanded.has(`quiet-${entry.id}`)"
              :aria-controls="expanded.has(`quiet-${entry.id}`) ? `${baseId}-quiet-${entry.id}` : undefined"
              data-quiet-toggle
              @click="toggle(`quiet-${entry.id}`)"
            >
              <UIcon
                name="i-lucide-circle-dashed"
                class="size-4 shrink-0"
              />
              <span class="flex-1">{{ t('history.quiet', entry.versions.length) }}</span>
              <UIcon
                :name="expanded.has(`quiet-${entry.id}`) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                class="size-4 shrink-0"
              />
            </button>
            <ul
              v-if="expanded.has(`quiet-${entry.id}`)"
              :id="`${baseId}-quiet-${entry.id}`"
              class="space-y-1 border-t border-default bg-muted px-3 py-2"
            >
              <li class="text-xs text-muted">
                {{ t('history.quietHint') }}
              </li>
              <li
                v-for="version in entry.versions"
                :key="version.id"
                class="flex items-center gap-2 text-xs"
                :data-version-row="version.id"
                data-version-type="autosave"
              >
                <time
                  class="text-muted tabular-nums"
                  :datetime="version.at"
                >{{ labels.time(version.at) }}</time>
                <span class="min-w-0 flex-1 truncate text-default">{{ labels.actorName(version.actor) }}</span>
                <ULink
                  :to="linkFor(version.id)"
                  class="text-default underline-offset-2 hover:underline"
                  data-version-compare
                >
                  {{ t('history.row.compare') }}
                </ULink>
              </li>
            </ul>
          </li>
        </template>
      </ol>
    </section>

    <div
      v-if="hasMore"
      class="flex justify-center"
    >
      <UButton
        color="neutral"
        variant="outline"
        size="sm"
        :loading="loadingMore"
        :label="t('history.loadMore')"
        data-timeline-more
        @click="emit('loadMore')"
      />
    </div>
  </div>
</template>
