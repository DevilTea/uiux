<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { ReviewActor, ReviewResolution, ReviewThread } from '../../../src/domain/reviews/schema'
import { buildReviewTimeline } from '../../utils/review-timeline'
import { relativeTime } from '../../utils/widget-inspection'
import { memberInitials } from '../../utils/member-initials'
import { copyText } from '../../utils/copy-text'
import { viewLocation } from '../../utils/workbench-routes'
import { useWorkbenchFormat } from '../../composables/useWorkbenchFormat'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'

/**
 * One chronological timeline (Part 7 10b; brief d, section 8): messages read like a PR
 * conversation, and submissions, re-anchors and lifecycle events render as typed events with
 * their payloads. Submissions expand to their evidence references.
 */
const props = defineProps<{ thread: ReviewThread }>()

const { t, locale } = useI18n()
const fmt = useWorkbenchFormat()
const feedback = useWorkbenchFeedback()

const items = computed(() => buildReviewTimeline(props.thread))

function actorName(actor: ReviewActor | undefined): string {
	return actor?.displayName ?? actor?.id ?? t('comments.unknownAuthor')
}
function isAgent(actor: ReviewActor): boolean {
	return actor.type === 'agent'
}
function isHuman(actor: ReviewActor): boolean {
	return actor.type === 'human'
}
function shortId(id: string | undefined): string {
	return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : ''
}
/** Digests read as `sha256:9b1f…c03e`; the full value is in the title and the copy button. */
function shortDigest(digest: string): string {
	const [algorithm, value] = digest.includes(':') ? digest.split(':', 2) as [string, string] : ['', digest]
	const short = value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value
	return algorithm ? `${algorithm}:${short}` : short
}
function resolutionLabel(resolution: ReviewResolution): string {
	return t(`comments.resolution.${resolution}`)
}

async function copy(value: string): Promise<void> {
	if (await copyText(value)) feedback.success(t('inbox.copied'))
	else feedback.error(undefined, t('comments.errors.copyFailed'))
}

const readiness = computed(() => viewLocation(props.thread.anchor.viewId, { panel: 'readiness' }))
</script>

<template>
  <ol
    class="grid gap-4"
    :aria-label="t('comments.timeline')"
    data-review-timeline
  >
    <li
      v-for="item in items"
      :key="`${item.kind}-${item.id}`"
      class="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3"
      :data-timeline-kind="item.kind"
    >
      <template v-if="item.kind === 'message'">
        <UAvatar
          :text="isHuman(item.actor) ? memberInitials(actorName(item.actor)) : undefined"
          :icon="isAgent(item.actor) ? 'i-lucide-bot' : isHuman(item.actor) ? undefined : 'i-lucide-cog'"
          size="sm"
          aria-hidden="true"
        />
        <div class="min-w-0">
          <p class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
            <b class="font-semibold text-highlighted">{{ actorName(item.actor) }}</b>
            <UBadge
              v-if="isAgent(item.actor)"
              color="neutral"
              variant="soft"
              size="sm"
              :label="t('comments.agent')"
            />
            <time
              class="text-xs text-dimmed"
              :datetime="item.at"
              :title="fmt.dateTime(item.at)"
            >{{ relativeTime(item.at, locale) }}</time>
          </p>
          <p
            class="mt-1 max-w-[68ch] text-body break-words whitespace-pre-wrap text-default"
            v-text="item.body"
          />
        </div>
      </template>

      <template v-else>
        <span
          class="mt-0.5 grid size-7 place-items-center rounded-full border border-default bg-default"
          :class="item.kind === 'resolved' ? 'text-success' : 'text-muted'"
          aria-hidden="true"
        >
          <UIcon
            :name="item.kind === 'submission' ? 'i-lucide-git-pull-request-arrow' : item.kind === 'resolved' ? 'i-lucide-circle-check' : item.kind === 'reopened' ? 'i-lucide-rotate-ccw' : 'i-lucide-crosshair'"
            class="size-3.5"
          />
        </span>
        <div class="min-w-0 pt-1 text-sm text-muted">
          <template v-if="item.kind === 'submission'">
            <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <b class="font-medium text-highlighted">{{ t('comments.submitted') }}</b>
              <span>· {{ actorName(item.actor) }}</span>
              <UBadge
                v-if="isAgent(item.actor)"
                color="neutral"
                variant="soft"
                size="sm"
                :label="t('comments.agent')"
              />
              <span>·</span>
              <time
                class="text-xs text-dimmed"
                :datetime="item.at"
                :title="fmt.dateTime(item.at)"
              >{{ relativeTime(item.at, locale) }}</time>
              <UBadge
                v-if="item.current"
                color="info"
                variant="subtle"
                size="sm"
                :label="t('comments.current')"
                data-submission-current
              />
              <UBadge
                v-if="item.accepted"
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-check"
                :label="t('inbox.timeline.accepted')"
              />
              <UBadge
                v-if="item.notAccepted"
                color="warning"
                variant="subtle"
                size="sm"
                :label="t('comments.notAccepted')"
                data-submission-not-accepted
              />
            </p>
            <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
              <span class="text-xs">{{ t('inbox.timeline.changes') }}</span>
              <UBadge
                v-for="domain in item.domains"
                :key="domain"
                color="neutral"
                variant="soft"
                size="sm"
                class="font-mono"
                :label="domain"
              />
            </div>
            <UCollapsible
              v-if="item.evidence.length"
              class="mt-1"
            >
              <UButton
                color="neutral"
                variant="link"
                size="xs"
                trailing-icon="i-lucide-chevron-down"
                class="-ms-0.5 px-0.5 text-muted"
                :ui="{ trailingIcon: 'group-data-[state=open]:rotate-180 transition-transform duration-150' }"
                :label="t('comments.evidenceCount', item.evidence.length)"
                data-submission-evidence-toggle
              />
              <template #content>
                <ul class="mt-1.5 grid gap-1 rounded-md border border-default p-2">
                  <li
                    v-for="ref in item.evidence"
                    :key="`${ref.kind}-${ref.evidence}`"
                    class="flex min-w-0 items-center gap-2 text-xs"
                  >
                    <UBadge
                      color="neutral"
                      variant="outline"
                      size="sm"
                      class="shrink-0 font-mono"
                      :label="ref.kind"
                    />
                    <span
                      class="min-w-0 truncate font-mono text-default"
                      :title="ref.evidence"
                    >{{ shortDigest(ref.evidence) }}</span>
                    <UButton
                      color="neutral"
                      variant="ghost"
                      size="xs"
                      icon="i-lucide-copy"
                      class="ms-auto shrink-0"
                      :aria-label="t('inbox.timeline.copyDigest')"
                      @click="copy(ref.evidence)"
                    />
                  </li>
                  <li class="pt-1">
                    <ULink
                      :to="readiness"
                      class="text-xs text-muted underline-offset-2 hover:text-highlighted hover:underline"
                    >
                      {{ t('inbox.timeline.openEvidence') }}
                    </ULink>
                  </li>
                </ul>
              </template>
            </UCollapsible>
            <p class="mt-1 text-xs text-dimmed">
              {{ t('inbox.timeline.submission') }}
              <button
                type="button"
                class="rounded-sm font-mono hover:text-highlighted"
                :title="item.id"
                :aria-label="t('inbox.timeline.copySubmission', { id: shortId(item.id) })"
                @click="copy(item.id)"
              >
                {{ shortId(item.id) }}
              </button>
            </p>
          </template>

          <template v-else-if="item.kind === 'resolved'">
            <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <UBadge
                color="success"
                variant="subtle"
                size="sm"
                icon="i-lucide-circle-check"
                :label="item.resolution === 'verified' ? t('inbox.timeline.verifiedChip', { id: shortId(item.submissionId) }) : t('inbox.timeline.resolvedChip', { resolution: resolutionLabel(item.resolution) })"
                :data-resolution="item.resolution"
              />
              <span>{{ t('inbox.timeline.by', { name: actorName(item.actor) }) }}</span>
              <span>·</span>
              <time
                class="text-xs text-dimmed"
                :datetime="item.at"
                :title="fmt.dateTime(item.at)"
              >{{ relativeTime(item.at, locale) }}</time>
            </p>
            <p
              v-if="item.reason"
              class="mt-1 max-w-[68ch] break-words whitespace-pre-wrap text-default"
            >
              {{ item.reason }}
            </p>
          </template>

          <template v-else-if="item.kind === 'reopened'">
            <p>
              <b class="font-medium text-highlighted">{{ t('comments.reopenedBy', { name: actorName(item.actor) }) }}</b>
              · <time
                class="text-xs text-dimmed"
                :datetime="item.at"
                :title="fmt.dateTime(item.at)"
              >{{ relativeTime(item.at, locale) }}</time>
            </p>
            <p
              v-if="item.reason"
              class="mt-1 max-w-[68ch] break-words whitespace-pre-wrap text-default"
            >
              {{ item.reason }}
            </p>
          </template>

          <template v-else>
            <p>
              <b class="font-medium text-highlighted">{{ t('comments.reanchoredEvent', { from: `#${item.from.widgetId}`, to: `#${item.to.widgetId}` }) }}</b>
              · {{ actorName(item.actor) }}
              · <time
                class="text-xs text-dimmed"
                :datetime="item.at"
                :title="fmt.dateTime(item.at)"
              >{{ relativeTime(item.at, locale) }}</time>
            </p>
            <p
              v-if="item.fromScope.join(',') !== item.toScope.join(',')"
              class="mt-1 text-xs"
            >
              {{ t('inbox.timeline.scopeChanged', { from: item.fromScope.join(', ') || t('inbox.filter.viewWide'), to: item.toScope.join(', ') || t('inbox.filter.viewWide') }) }}
            </p>
            <p
              v-if="item.reason"
              class="mt-1 max-w-[68ch] break-words whitespace-pre-wrap text-default"
            >
              {{ item.reason }}
            </p>
          </template>
        </div>
      </template>
    </li>
  </ol>
</template>
