<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { isWidgetAnchor, type ReviewActor, type ReviewThread } from '../../../src/domain/reviews/schema'
import { useReadiness } from '../../composables/useReadiness'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { updatedSince } from '../../utils/readiness'
import { relativeTime } from '../../utils/widget-inspection'
import { viewLocation } from '../../utils/workbench-routes'

/**
 * Overview › Activity: Views updated since this browser last opened them, then the latest
 * Review timeline events across the Workspace. Read-only; there is no change feed, so agent
 * edits show only as "updated since you last looked" (brief f, section 11).
 */
const { t, locale } = useI18n()
const uiux = useUiuxClient()
const { views, reviews } = useWorkbench()
const readiness = useReadiness()

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

const loading = ref(false)
const error = shallowRef<FetchErrorDetails>()
const events = shallowRef<readonly ActivityItem[]>([])

const viewNames = computed(() => new Map(views.value.map(view => [view.key, view.summary.name || t('common.unnamed')])))

const updatedViews = computed(() => views.value.filter(view => updatedSince(readiness.lastSeen.value, `view:${view.key}`, view.revision)))

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

async function load(): Promise<void> {
	loading.value = true
	error.value = undefined
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
		error.value = describeFetchError(cause, t('activity.loadFailed'))
	}
	finally {
		loading.value = false
	}
}

onMounted(load)
watch(() => reviews.value.map(review => review.revision).join(','), () => { void load() })

const timeline = computed(() => events.value.map(item => ({ ...item, date: relativeTime(item.at, locale.value) })))
</script>

<template>
  <div
    class="space-y-6"
    data-overview-activity
  >
    <section
      v-if="updatedViews.length"
      class="space-y-2"
      :aria-label="t('overview.updated')"
    >
      <h3 class="text-xs font-medium text-muted">
        {{ t('overview.updated') }}
      </h3>
      <ul class="divide-y divide-(--ui-border) rounded-lg border border-default">
        <li
          v-for="view in updatedViews"
          :key="view.key"
        >
          <ULink
            :to="viewLocation(view.key)"
            class="flex items-center gap-2 px-3 py-2 text-sm text-default hover:bg-muted"
          >
            <span
              class="size-2 shrink-0 rounded-full bg-primary"
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate">{{ view.summary.name || t('common.unnamed') }}</span>
            <span class="text-xs text-muted">{{ t('activity.viewChanged') }}</span>
          </ULink>
        </li>
      </ul>
    </section>

    <section
      class="space-y-2"
      :aria-label="t('activity.reviewsTitle')"
    >
      <h3 class="text-xs font-medium text-muted">
        {{ t('activity.reviewsTitle') }}
      </h3>
      <UAlert
        v-if="error"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="error.message"
        :actions="[{ label: t('common.retry'), size: 'xs', color: 'error', variant: 'outline', onClick: () => { void load() } }]"
      />
      <div
        v-else-if="loading && !events.length"
        class="space-y-3"
      >
        <USkeleton
          v-for="index in 4"
          :key="index"
          class="h-10 w-full"
        />
      </div>
      <UEmpty
        v-else-if="!events.length"
        icon="i-lucide-inbox"
        variant="naked"
        :title="t('activity.emptyTitle')"
        :description="t('activity.emptyDescription')"
      />
      <UTimeline
        v-else
        :items="timeline"
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
  </div>
</template>
