<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import type { LocationQueryRaw } from 'vue-router'
import { useI18n, useRoute, useRouter } from '#imports'
import { isWidgetAnchor, type ReviewActor, type ReviewThread } from '../../../src/domain/reviews/schema'
import type { VersionListItem } from '../../../src/application/services/history-service'
import type { HistoryActor } from '../../../src/domain/history/schema'
import { useReadiness } from '../../composables/useReadiness'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { useWorkbenchShell } from '../../composables/useWorkbenchShell'
import { useCheckpointAccess } from '../../composables/useCheckpointAccess'
import { useHistoryLabels } from '../../composables/useHistoryLabels'
import { readVersionRecord, useVersionTimeline } from '../../composables/useVersionHistory'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { updatedSince } from '../../utils/readiness'
import { relativeTime } from '../../utils/widget-inspection'
import { viewLocation } from '../../utils/workbench-routes'
import {
	actorFilterValue,
	comparisonEndpoints,
	CURRENT_COMPARE,
	distinctActors,
	historyQuery,
	parseHistoryAddress,
	resolveHistorySelection,
	revisionIn,
	type HistoryAddress,
	type TimelineFilters,
} from '../../utils/version-history'
import VersionTimeline from '../history/VersionTimeline.vue'
import VersionComparison from '../history/VersionComparison.vue'
import DeleteCheckpointModal from '../history/DeleteCheckpointModal.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'

/**
 * Overview › Activity: the Workspace version timeline (Rules 01a11a5e-1946-7217-aff5-db13df3a2977,
 * 199c, 19f4) with its comparison (Rule 01a11a5e-11e0-7f39-84a7-fde3faa43340), the Views changed
 * since this browser last looked, each linked to a comparison from the version holding the revision
 * last seen to the current state (Rule 01a11a5e-1a4b-72f7-8de9-1fc528aaf6eb), and, in a separate
 * secondary list, the latest Review events read live from the threads (Rules
 * 01a11e0d-db86-7890-ac42-5b4079364ad2 and 01a11a5e-0873-7976-8a48-a9a1a00e4b6d).
 *
 * The selection is the address (Clause 01a11e0d-d74b-701a-9a25-a149e400b7ec): `version`, `compare`
 * and `resource` on `/?tab=activity`, read with the defaults of the owner ruling and never written
 * on the reader's behalf. The filters are view state, not part of the address.
 */
const { t, locale } = useI18n()
const route = useRoute()
const router = useRouter()
const uiux = useUiuxClient()
const shell = useWorkbenchShell()
const { views, reviews, isReadOnly } = useWorkbench()
const readiness = useReadiness()
const labels = useHistoryLabels()
const checkpoints = useCheckpointAccess()

// ----- Address --------------------------------------------------------------------------------

const address = computed(() => parseHistoryAddress(route.query))
const selection = computed(() => resolveHistorySelection(address.value))

/** `/?tab=activity` with these history keys; other keys of the Overview query are kept. */
function activityTo(next: HistoryAddress) {
	const query: LocationQueryRaw = { ...route.query, tab: 'activity' }
	delete query.version
	delete query.compare
	delete query.resource
	return { path: '/', query: { ...query, ...historyQuery(next, ['version', 'compare', 'resource']) } }
}

// ----- Timeline -------------------------------------------------------------------------------

const ALL = '__all__'
const actorFilter = ref(ALL)
const kindFilter = ref(ALL)
const checkpointsOnly = ref(false)
const filters = computed<TimelineFilters>(() => ({
	...(actorFilter.value !== ALL ? { actor: actorFilter.value } : {}),
	...(kindFilter.value !== ALL ? { kind: kindFilter.value } : {}),
	...(checkpointsOnly.value ? { checkpointsOnly: true } : {}),
}))
const timeline = useVersionTimeline({ filters, enabled: () => !isReadOnly.value })

/** Every actor seen so far, so filtering by one keeps the others choosable. */
const knownActors = shallowRef<readonly HistoryActor[]>([])
watch(timeline.versions, (versions) => {
	knownActors.value = distinctActors([...knownActors.value.map(actor => ({ actor })), ...versions])
})
const actorItems = computed(() => [
	{ label: t('history.filter.allActors'), value: ALL },
	...knownActors.value.map(actor => ({ label: labels.actorName(actor), value: actorFilterValue(actor) })),
])
const KINDS = ['view', 'flow', 'locale', 'asset', 'workspace'] as const
const kindItems = computed(() => [
	{ label: t('history.filter.allKinds'), value: ALL },
	...KINDS.map(kind => ({ label: labels.kindLabel(kind), value: kind })),
])

const versionAt = computed(() => new Map(timeline.versions.value.map(version => [version.id, version.at])))
const versionTitles = computed(() => new Map(timeline.versions.value.map(version => [version.id, labels.versionTitle(version)])))
const endpoints = computed(() => selection.value && comparisonEndpoints(selection.value, id => versionAt.value.get(id)))
const compareTitle = computed(() => selection.value ? versionTitles.value.get(selection.value.compare) : undefined)

// ----- Delete (an Owner on desktop) -----------------------------------------------------------

const deleteOpen = ref(false)
const deleteTarget = shallowRef<VersionListItem>()
function askDelete(version: VersionListItem): void {
	deleteTarget.value = version
	deleteOpen.value = true
}
function onDeleted(id: string): void {
	if (address.value.version === id || address.value.compare === id) void router.replace(activityTo({}))
}

// ----- Changes since you last looked ----------------------------------------------------------

const updatedViews = computed(() => views.value.filter(view => updatedSince(readiness.lastSeen.value, `view:${view.key}`, view.revision)))
/** View key and last-seen revision → the version holding it (`null`: no listed version does). */
const sinceVersions = shallowRef(new Map<string, string | null>())
const SINCE_SEARCH_LIMIT = 20

async function versionHolding(viewKey: string, revision: string): Promise<string | null> {
	const resource = { kind: 'view', key: viewKey }
	const page = await $fetch<{ versions: VersionListItem[] }>('/api/history/versions', { query: { resource: `view:${viewKey}`, limit: String(SINCE_SEARCH_LIMIT) }, cache: 'no-store' })
	for (const row of page.versions) {
		const read = await readVersionRecord(row.id)
		if (revisionIn(read.version, resource) === revision) return row.id
	}
	return null
}

watch(() => isReadOnly.value ? [] : updatedViews.value.map(view => `${view.key}@${readiness.lastSeen.value[`view:${view.key}`]}`), async (keys) => {
	for (const key of keys) {
		if (sinceVersions.value.has(key)) continue
		const [viewKey, revision] = key.split('@') as [string, string]
		const found = await versionHolding(viewKey, revision).catch(() => null)
		sinceVersions.value = new Map(sinceVersions.value).set(key, found)
	}
}, { immediate: true })

function sinceVersion(viewKey: string): string | null | undefined {
	return sinceVersions.value.get(`${viewKey}@${readiness.lastSeen.value[`view:${viewKey}`]}`)
}

// ----- Review events (a separate, secondary list) ---------------------------------------------

const THREADS = 12
const EVENTS = 24

type ActivityItem = Readonly<{
	value: string
	at: string
	icon: string
	title: string
	description?: string
	to: ReturnType<typeof viewLocation>
}>

const reviewLoading = ref(false)
const reviewError = shallowRef<FetchErrorDetails>()
const events = shallowRef<readonly ActivityItem[]>([])

const viewNames = computed(() => new Map(views.value.map(view => [view.key, view.summary.name || t('common.unnamed')])))

function actorName(actor: ReviewActor | undefined): string {
	return actor?.displayName || actor?.id || (actor?.type === 'agent' ? t('activity.anAgent') : t('activity.someone'))
}

function excerpt(text: string): string {
	const line = text.replace(/\s+/g, ' ').trim()
	return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

function threadEvents(thread: ReviewThread): ActivityItem[] {
	// A Workspace thread lives only in Reviews: its link is `/reviews?thread=<id>`.
	const anchor = thread.anchor
	const to = isWidgetAnchor(anchor) ? viewLocation(anchor.viewId, { widget: anchor.widgetId, thread: thread.id }) : { path: '/reviews', query: { thread: thread.id } }
	const where = isWidgetAnchor(anchor) ? `${viewNames.value.get(anchor.viewId) ?? t('ready.diag.unknownView')} · #${anchor.widgetId}` : t('activity.workspace')
	const out: ActivityItem[] = []
	thread.messages.forEach((message, index) => out.push({
		value: `${thread.id}:m:${message.id}`,
		at: message.at,
		icon: 'i-lucide-message-circle',
		title: t(index === 0 ? 'activity.commented' : 'activity.replied', { name: actorName(message.actor), where }),
		description: excerpt(message.body),
		to,
	}))
	for (const submission of thread.submissions) out.push({
		value: `${thread.id}:s:${submission.id}`,
		at: submission.at,
		icon: 'i-lucide-eye',
		title: t('activity.submitted', { name: actorName(submission.actor), where }),
		to,
	})
	for (const event of thread.history) {
		if (event.kind === 'reanchor') {
			out.push({ value: `${thread.id}:h:${event.id}`, at: event.at, icon: 'i-lucide-crosshair', title: t('activity.reanchored', { name: actorName(event.actor), where }), to })
		}
		else if (event.to === 'resolved') {
			out.push({
				value: `${thread.id}:h:${event.id}`,
				at: event.at,
				icon: 'i-lucide-circle-check',
				title: t('activity.resolved', { name: actorName(event.actor), where }),
				...(event.resolution ? { description: t(`comments.resolution.${event.resolution}`) } : {}),
				to,
			})
		}
		else if (event.from === 'resolved' && event.to === 'open') {
			out.push({ value: `${thread.id}:h:${event.id}`, at: event.at, icon: 'i-lucide-rotate-ccw', title: t('activity.reopened', { name: actorName(event.actor), where }), ...(event.reason ? { description: excerpt(event.reason) } : {}), to })
		}
	}
	return out
}

async function loadReviewEvents(): Promise<void> {
	reviewLoading.value = true
	reviewError.value = undefined
	try {
		const latest = [...reviews.value]
			.sort((a, b) => (b.summary.latestActivityAt ?? '').localeCompare(a.summary.latestActivityAt ?? ''))
			.slice(0, THREADS)
		const threads = await Promise.all(latest.map(review => uiux.readResource<{ resource: ReviewThread }>('review', review.key).catch(() => undefined)))
		events.value = threads
			.flatMap(read => read?.resource ? threadEvents(read.resource) : [])
			.sort((a, b) => b.at.localeCompare(a.at))
			.slice(0, EVENTS)
	}
	catch (cause) {
		reviewError.value = describeFetchError(cause, t('activity.loadFailed'))
	}
	finally {
		reviewLoading.value = false
	}
}

onMounted(loadReviewEvents)
watch(() => reviews.value.map(review => review.revision).join(','), () => { void loadReviewEvents() })

const reviewTimeline = computed(() => events.value.map(item => ({ ...item, date: relativeTime(item.at, locale.value) })))
</script>

<template>
  <div
    class="space-y-8"
    data-overview-activity
  >
    <div
      class="grid gap-6"
      :class="selection && !isReadOnly ? 'lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]' : ''"
    >
      <!-- The comparison comes first on narrow layouts and sits beside the timeline from 1024px. -->
      <div
        v-if="selection && endpoints && !isReadOnly"
        class="min-w-0 lg:order-2"
      >
        <div class="lg:sticky lg:top-4">
          <VersionComparison
            :address="address"
            :endpoints="endpoints"
            :compare-title="compareTitle"
            :link-for="activityTo"
            :close-to="activityTo({})"
          />
        </div>
      </div>

      <div class="min-w-0 space-y-6 lg:order-1">
        <section
          v-if="updatedViews.length"
          class="space-y-2"
          :aria-label="t('overview.updated')"
          data-since-last-looked
        >
          <h3 class="text-xs font-medium text-muted">
            {{ t('overview.updated') }}
          </h3>
          <ul class="divide-y divide-(--ui-border) rounded-lg border border-default">
            <li
              v-for="view in updatedViews"
              :key="view.key"
              class="flex items-center gap-2 px-3 py-2 text-sm"
              :data-since-view="view.key"
            >
              <span
                class="size-2 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              />
              <span class="min-w-0 flex-1 truncate text-default">{{ view.summary.name || t('common.unnamed') }}</span>
              <ULink
                v-if="!isReadOnly && sinceVersion(view.key)"
                :to="activityTo({ version: sinceVersion(view.key)!, compare: CURRENT_COMPARE, resource: { kind: 'view', key: view.key } })"
                class="shrink-0 text-xs text-default underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
                data-since-compare
              >
                {{ t('history.since.compare') }}
              </ULink>
              <span
                v-else-if="!isReadOnly && sinceVersion(view.key) === null"
                class="shrink-0 text-xs text-muted"
                data-since-unavailable
              >{{ t('history.since.unavailable') }}</span>
              <ULink
                :to="viewLocation(view.key)"
                class="shrink-0 text-xs text-muted hover:text-default pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {{ t('history.since.openView') }}
              </ULink>
            </li>
          </ul>
        </section>

        <UAlert
          v-if="isReadOnly"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          :title="t('history.publication')"
        />
        <section
          v-else
          class="space-y-3"
          :aria-label="t('history.timelineLabel')"
        >
          <div
            class="flex flex-wrap items-center gap-2"
            data-history-filters
          >
            <h3 class="me-auto text-sm font-semibold text-highlighted">
              {{ t('history.title') }}
            </h3>
            <USelect
              v-model="actorFilter"
              :items="actorItems"
              :aria-label="t('history.filter.actor')"
              class="w-40"
              data-history-filter="actor"
            />
            <USelect
              v-model="kindFilter"
              :items="kindItems"
              :aria-label="t('history.filter.kind')"
              class="w-40"
              data-history-filter="kind"
            />
            <USwitch
              v-model="checkpointsOnly"
              :label="t('history.filter.checkpointsOnly')"
              data-history-filter="checkpoints"
            />
            <UButton
              v-if="checkpoints.canCreate.value"
              icon="i-lucide-flag"
              :label="t('history.checkpoint.create')"
              data-create-checkpoint
              @click="shell.checkpointOpen.value = true"
            />
          </div>

          <VersionTimeline
            :versions="timeline.rows.value"
            :loading="timeline.loading.value"
            :loaded="timeline.loaded.value"
            :error="timeline.error.value"
            :has-more="!!timeline.nextCursor.value"
            :loading-more="timeline.loadingMore.value"
            :selected="selection?.version"
            :link-for="(id) => activityTo({ version: id })"
            :compare-link-for="selection ? (id) => activityTo({ version: selection!.version, compare: id }) : undefined"
            :can-delete="checkpoints.canDelete.value"
            :empty-title="filters.actor || filters.kind || filters.checkpointsOnly ? t('history.emptyFiltered') : undefined"
            :empty-description="filters.actor || filters.kind || filters.checkpointsOnly ? t('history.emptyFilteredDescription') : undefined"
            @delete="askDelete"
            @load-more="timeline.loadMore()"
            @retry="timeline.load()"
          />

          <section
            v-if="timeline.invalid.value.length"
            class="space-y-2"
            :aria-label="t('history.invalid.title')"
            data-invalid-records
          >
            <UAlert
              color="warning"
              variant="subtle"
              icon="i-lucide-file-warning"
              :title="t('history.invalid.title')"
              :description="t('history.invalid.explanation')"
            />
            <ul class="space-y-1">
              <li
                v-for="record in timeline.invalid.value"
                :key="record.file"
                class="rounded-md border border-default px-3 py-2 text-xs"
                data-invalid-record
              >
                <code
                  class="font-mono break-all text-default"
                  translate="no"
                >{{ record.file }}</code>
                <WbErrorDescription
                  class="mt-1"
                  :headline="t('history.invalid.notDeletable')"
                  :diagnostics="record.diagnostics"
                />
              </li>
            </ul>
          </section>
        </section>
      </div>
    </div>

    <section
      class="space-y-2 border-t border-default pt-6"
      :aria-label="t('activity.reviewsTitle')"
      data-review-activity
    >
      <h3 class="text-xs font-medium text-muted">
        {{ t('activity.reviewsTitle') }}
      </h3>
      <UAlert
        v-if="reviewError"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="reviewError.message"
        :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void loadReviewEvents() } }]"
      >
        <template #description>
          <WbErrorDescription
            :headline="reviewError.message"
            :diagnostics="reviewError.diagnostics"
            :status-code="reviewError.statusCode"
          />
        </template>
      </UAlert>
      <div
        v-else-if="reviewLoading && !events.length"
        class="space-y-3"
      >
        <USkeleton
          v-for="index in 3"
          :key="index"
          class="h-8 w-full"
          :aria-label="t('common.loading')"
        />
      </div>
      <p
        v-else-if="!events.length"
        class="text-sm text-muted"
      >
        {{ t('activity.emptyTitle') }}
      </p>
      <UTimeline
        v-else
        :items="reviewTimeline"
        color="neutral"
        size="xs"
        :ui="{ title: 'text-sm font-normal text-default', description: 'text-sm text-muted', date: 'text-xs text-dimmed' }"
      >
        <template #title="{ item }">
          <ULink
            :to="item.to"
            class="text-default hover:text-highlighted hover:underline"
          >
            {{ item.title }}
          </ULink>
        </template>
      </UTimeline>
    </section>

    <DeleteCheckpointModal
      v-if="checkpoints.canDelete.value"
      v-model:open="deleteOpen"
      :version="deleteTarget"
      @deleted="onDeleted"
    />
  </div>
</template>
