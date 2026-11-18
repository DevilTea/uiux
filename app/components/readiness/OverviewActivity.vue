<script setup lang="ts">
import { computed, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from '#imports'
import { isWidgetAnchor, type ReviewActor, type ReviewThread } from '../../../src/domain/reviews/schema'
import { useUiuxClient } from '../../composables/useUiuxClient'
import { useWorkbench } from '../../composables/useWorkbench'
import { describeFetchError, type FetchErrorDetails } from '../../utils/fetch-error'
import { relativeTime } from '../../utils/widget-inspection'
import { viewLocation } from '../../utils/workbench-routes'
import ChangesSince from '../changes/ChangesSince.vue'
import WbErrorDescription from '../workbench/WbErrorDescription.vue'
import KitSkeleton from '~/components/kit/ui/Skeleton.vue'

/**
 * Overview › Activity: the changes since the Git base for the whole Workspace (Rule
 * 01a11a5e-1946-7217-aff5-db13df3a2977), as the Changes since Git base Feature describes, and, in a
 * separate secondary list, the latest Review events read live from the threads (Rules
 * 01a11e0d-db86-7890-ac42-5b4079364ad2 and 01a11a5e-0873-7976-8a48-a9a1a00e4b6d). The changes view is
 * read-only and needs no key beyond reading the Workspace; its base and selection are view state, not
 * part of the address.
 */
const { t, locale } = useI18n()
const uiux = useUiuxClient()
const { views, reviews } = useWorkbench()

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
    <ChangesSince heading-tag="h3" />

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
        <KitSkeleton
          v-for="index in 3"
          :key="index"
          class="wb-skeleton animate-pulse"
          :height="32"
          :radius="6"
          :label="t('common.loading')"
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
  </div>
</template>
