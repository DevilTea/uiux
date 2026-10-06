<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, watch } from 'vue'
import { navigateTo, useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import { useWorkbench } from '../../../composables/useWorkbench'
import { relativeTime } from '../../../utils/widget-inspection'
import { useWorkbenchFeedback } from '../../../composables/useWorkbenchFeedback'
import { threadAuthorInitials, statusKey, useCanvasComments } from '../../../composables/useCanvasComments'
import type { ReviewActor, ReviewResolution } from '../../../../src/domain/reviews/schema'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'
import { buildReviewTimeline, type ReviewTimelineItem } from '../../../utils/review-timeline'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../../composables/useMediaQuery'
import { isLockedError, type FetchErrorDetails } from '../../../utils/fetch-error'
import type { ReviewSubmissionDraft } from '../../../utils/review-submission'
import LockedSaveAlert from '../LockedSaveAlert.vue'
import SubmitForReviewModal from '../SubmitForReviewModal.vue'

/**
 * The thread bubble (brief c, section 6; direct-resolve decision 10): status, the compact typed
 * timeline, reply, and the lifecycle actions. Resolve on an open thread sends `answered`; a ready
 * thread's Resolve accepts its submission (`verified`); the menu offers the other kinds.
 */
const props = defineProps<{ threadId: string }>()

const { t, locale } = useI18n()
const feedback = useWorkbenchFeedback()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { preview, widgetTreeResult, selectedVariant } = workbench

const thread = computed(() => comments.threadById.value.get(props.threadId))
const placement = computed(() => comments.pinStatusById.value.get(props.threadId))
const detail = computed(() => thread.value?.detail)

const widgetType = computed(() => {
	const tree = widgetTreeResult.value
	const id = thread.value?.anchor.widgetId
	return tree?.status === 'valid' && id ? flattenWidgetTree(tree.root).find(node => node.id === id)?.type : undefined
})

const status = computed(() => statusKey(thread.value?.status ?? 'open'))
const STATUS_ICON = { open: 'i-lucide-circle-dot', ready: 'i-lucide-eye', resolved: 'i-lucide-circle-check' } as const
const STATUS_COLOR = { open: 'annotation', ready: 'info', resolved: 'success' } as const

function actorName(actor: ReviewActor | undefined): string {
	return actor?.displayName ?? actor?.id ?? t('comments.unknownAuthor')
}
function shortId(id: string | undefined): string {
	return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : ''
}
function resolutionLabel(resolution: ReviewResolution | undefined): string {
	return t(`comments.resolution.${resolution ?? 'answered'}`)
}

/** Why the pin is not on the canvas, said once in the bubble (multi-target decision 7). */
const placementNote = computed(() => {
	const current = placement.value
	if (!current || current.state === 'visible') return undefined
	if (current.state === 'offscreen') return t('comments.reason.offscreen')
	switch (current.reason) {
		case 'point-not-visible': return t('comments.reason.pointNotVisible')
		case 'not-rendered':
		case 'no-visible-region': return t('pins.notVisible')
		case 'other-variant': return t('comments.reason.otherVariant')
		case 'mapping-unavailable': return t('comments.reason.mapping')
		case 'over-cap':
		case 'single-stream': return t('comments.reason.overCap')
		case 'reconnecting': return t('comments.reason.reconnecting')
		default: return undefined
	}
})

// ---------------------------------------------------------------------------------------------
// Timeline (Part 7 10b): the shared chronological projection of the Reviews inbox (R8)
// ---------------------------------------------------------------------------------------------

const timeline = computed<readonly ReviewTimelineItem[]>(() => detail.value ? buildReviewTimeline(detail.value) : [])

const activeSubmission = computed(() => thread.value?.status === 'ready-for-review' ? detail.value?.submissions.at(-1) : undefined)

// ---------------------------------------------------------------------------------------------
// Reply and lifecycle
// ---------------------------------------------------------------------------------------------

const replyArea = ref<{ textareaRef?: HTMLTextAreaElement }>()
const reply = computed({
	get: () => comments.replyDrafts.value[props.threadId] ?? '',
	set: (value: string) => { comments.replyDrafts.value = { ...comments.replyDrafts.value, [props.threadId]: value } },
})
const conflict = computed(() => comments.conflict.value === props.threadId)
const error = computed(() => comments.lastError.value?.threadId === props.threadId ? comments.lastError.value.error : undefined)

/** A second step for kinds that ask something first: Duplicate's reason, or Reopen's optional reason. */
const pendingAction = ref<'duplicate' | 'reopen'>()
const reason = ref('')
const reasonInput = ref<{ inputRef?: HTMLInputElement }>()

function ask(action: 'duplicate' | 'reopen'): void {
	pendingAction.value = action
	reason.value = ''
	void nextTick(() => reasonInput.value?.inputRef?.focus())
}

async function confirmPending(): Promise<void> {
	const action = pendingAction.value
	if (action === 'duplicate') {
		if (!reason.value.trim()) return
		if (await comments.resolve(props.threadId, 'duplicate', reason.value)) pendingAction.value = undefined
	}
	else if (action === 'reopen' && await comments.reopen(props.threadId, reason.value)) pendingAction.value = undefined
}

async function sendReply(): Promise<void> {
	await comments.reply(props.threadId)
}

function onReplyKeydown(event: KeyboardEvent): void {
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		void sendReply()
	}
}

/** The menu of non-default resolutions; Obsolete leads (never pre-selected) when the anchor is gone. */
const resolveMenu = computed<DropdownMenuItem[][]>(() => {
	const items: DropdownMenuItem[] = [
		{ label: t('comments.resolution.wont-fix'), icon: 'i-lucide-circle-slash', onSelect: () => { void comments.resolve(props.threadId, 'wont-fix') } },
		{ label: t('comments.resolveDuplicate'), icon: 'i-lucide-copy', onSelect: () => ask('duplicate') },
		{ label: t('comments.resolution.obsolete'), icon: 'i-lucide-archive', onSelect: () => { void comments.resolve(props.threadId, 'obsolete') } },
	]
	if (thread.value?.anchorValid === false) items.unshift(items.pop()!)
	return [items]
})

// ---------------------------------------------------------------------------------------------
// Overflow menu: Copy link, Re-anchor, Promote to Decision, Open in Reviews, Copy thread ID
// ---------------------------------------------------------------------------------------------

async function copy(text: string, title: string): Promise<void> {
	try {
		await navigator.clipboard.writeText(text)
		feedback.success(title)
	}
	catch (cause) {
		feedback.error(cause, t('comments.errors.copyFailed'))
	}
}

function threadLink(): string {
	const url = new URL(window.location.href)
	url.searchParams.set('thread', props.threadId)
	return url.toString()
}

const promoteOpen = ref(false)
const promoteForm = reactive({ question: '', summary: '', rationale: '' })
/** A rejected promotion shows its error inside the dialog (not behind it) and takes focus there. */
const promoteFailed = ref(false)
watch(promoteOpen, (value) => { if (value) promoteFailed.value = false })
async function focusPromoteError(): Promise<void> {
	promoteFailed.value = true
	await nextTick()
	document.querySelector<HTMLElement>('[data-promote-error]')?.focus()
}

async function submitPromote(): Promise<void> {
	if (!promoteForm.question.trim() || !promoteForm.summary.trim()) return
	if (await comments.promote(props.threadId, { question: promoteForm.question, summary: promoteForm.summary, rationale: promoteForm.rationale || promoteForm.summary })) {
		promoteOpen.value = false
		feedback.success(t('reviews.feedback.promoted'))
		await workbench.loadSelectedView(preview.notifyIframeContext)
	}
	else await focusPromoteError()
}

function startReanchor(): void {
	comments.close()
	preview.startReanchor(props.threadId)
}

// Submit for review… (human submission; secondary, desktop-first)
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const canSubmit = computed(() => thread.value?.status === 'open' && comments.canComment.value && isDesktop.value)
const submitOpen = ref(false)
const submitError = ref<FetchErrorDetails>()
const submitConflict = ref(false)
watch(submitOpen, (value) => {
	if (value) {
		submitError.value = undefined
		submitConflict.value = false
	}
})
async function submitForReview(draft: ReviewSubmissionDraft): Promise<boolean> {
	const ok = await comments.submit(props.threadId, draft)
	if (ok) feedback.success(t('submit.announce'))
	else {
		submitConflict.value = comments.conflict.value === props.threadId
		submitError.value = comments.lastError.value?.threadId === props.threadId ? comments.lastError.value.error : undefined
	}
	return ok
}

const overflow = computed<DropdownMenuItem[][]>(() => [[
	{ label: t('thread.copyLink'), icon: 'i-lucide-link', onSelect: () => { void copy(threadLink(), t('comments.copiedLink')) } },
	...(canSubmit.value ? [{ label: t('thread.submit'), icon: 'i-lucide-eye', onSelect: () => { submitOpen.value = true } }] : []),
	...(comments.canComment.value ? [{ label: t('thread.reanchor'), icon: 'i-lucide-crosshair', onSelect: startReanchor }] : []),
	...(workbench.authorReadOnly.value ? [] : [{ label: t('thread.promote'), icon: 'i-lucide-signpost', onSelect: () => { promoteForm.question = thread.value?.title ?? ''; promoteOpen.value = true } }]),
	{ label: t('comments.openInReviews'), icon: 'i-lucide-inbox', onSelect: () => { void navigateTo({ path: '/reviews', query: { thread: props.threadId } }) } },
	{ label: t('comments.copyThreadId'), icon: 'i-lucide-copy', onSelect: () => { void copy(props.threadId, t('comments.copiedId')) } },
]])

function switchVariant(name: string): void {
	selectedVariant.value = name
}

// Focus lands in the bubble on open; Escape returns it to the pin (the comments layer does that).
const root = ref<HTMLElement>()
onMounted(() => {
	// Reached with J / K on the canvas: focus stays on the pin (Enter there moves into the bubble).
	if (comments.browsingPins.value) return
	void nextTick(() => {
		const target = replyArea.value?.textareaRef ?? root.value
		target?.focus({ preventScroll: true })
	})
})
watch(() => props.threadId, () => {
	pendingAction.value = undefined
	if (comments.browsingPins.value) return
	void nextTick(() => (replyArea.value?.textareaRef ?? root.value)?.focus({ preventScroll: true }))
})
</script>

<template>
  <div
    v-if="thread"
    ref="root"
    class="grid w-80 max-w-[calc(100vw-2rem)] gap-2.5 p-3 outline-none"
    tabindex="-1"
    data-thread-bubble
    :data-thread-status="thread.status"
  >
    <div class="flex min-w-0 items-center gap-2">
      <UBadge
        :color="STATUS_COLOR[status]"
        variant="soft"
        size="sm"
        :icon="STATUS_ICON[status]"
        :label="t(`thread.status.${status}`)"
        class="shrink-0"
      />
      <span
        id="thread-bubble-title"
        class="min-w-0 truncate rounded-sm border border-default px-1.5 font-mono text-xs leading-5 text-muted"
        :title="thread.title"
      >{{ thread.anchorValid ? `${widgetType ?? 'Widget'} · #${thread.anchor.widgetId}` : `#${thread.anchor.widgetId}` }}</span>
      <span class="flex-1" />
      <UDropdownMenu
        :items="overflow"
        :content="{ align: 'end' }"
      >
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          icon="i-lucide-ellipsis"
          :aria-label="t('comments.more')"
        />
      </UDropdownMenu>
      <UButton
        color="neutral"
        variant="ghost"
        size="xs"
        icon="i-lucide-x"
        :aria-label="t('common.close')"
        data-thread-close
        @click="comments.close()"
      />
    </div>

    <UAlert
      v-if="!thread.anchorValid"
      color="warning"
      variant="subtle"
      icon="i-lucide-unlink"
      :title="t('comments.widgetGone')"
      :description="t('comments.widgetGoneHint', { id: `#${thread.anchor.widgetId}` })"
      :actions="comments.canComment.value ? [{ label: t('thread.reanchor'), icon: 'i-lucide-crosshair', size: 'xs', color: 'neutral', variant: 'outline', onClick: startReanchor }] : undefined"
      :ui="{ title: 'text-sm', description: 'text-xs' }"
      data-thread-missing
    />
    <UAlert
      v-for="name in thread.missingVariants"
      :key="name"
      color="warning"
      variant="subtle"
      icon="i-lucide-history"
      :title="t('pins.variantMissing', { name })"
      :ui="{ title: 'text-sm' }"
    />
    <p
      v-if="placementNote && thread.anchorValid"
      class="flex items-center gap-1.5 text-xs text-muted"
      data-thread-placement
    >
      <UIcon
        name="i-lucide-map-pin-off"
        class="size-3.5 shrink-0"
      />
      <span>{{ placementNote }}</span>
      <UButton
        v-if="placement?.reason === 'other-variant' && thread.variantNames[0]"
        size="xs"
        variant="link"
        color="neutral"
        class="p-0"
        :label="t('comments.switchTo', { variant: thread.variantNames[0] })"
        @click="switchVariant(thread.variantNames[0]!)"
      />
    </p>

    <UAlert
      v-if="conflict"
      color="warning"
      variant="subtle"
      icon="i-lucide-refresh-cw"
      :title="t('comments.conflict')"
      :description="t('comments.conflictHint')"
      :ui="{ title: 'text-sm', description: 'text-xs' }"
      data-thread-conflict
    />
    <LockedSaveAlert
      v-if="error && isLockedError(error)"
      :lock="error.lock"
      @dismiss="comments.lastError.value = undefined"
    />
    <UAlert
      v-else-if="error"
      color="error"
      variant="subtle"
      icon="i-lucide-circle-alert"
      :title="error.message"
      :description="error.diagnostics.map(item => item.message).filter(item => item !== error?.message).join(' ') || undefined"
      :ui="{ title: 'text-sm', description: 'text-xs' }"
    />

    <ol
      class="grid max-h-60 gap-2.5 overflow-auto border-t border-default pt-2.5"
      :aria-label="t('comments.timeline')"
      data-thread-timeline
    >
      <li
        v-if="!detail"
        class="text-xs text-muted"
      >
        <USkeleton class="h-10 w-full" />
      </li>
      <li
        v-for="item in timeline"
        :key="item.id"
        class="grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 gap-y-0.5"
        :data-timeline-kind="item.kind"
      >
        <template v-if="item.kind === 'message'">
          <UAvatar
            :text="item.actor.type === 'agent' ? undefined : threadAuthorInitials(item.actor)"
            :icon="item.actor.type === 'agent' ? 'i-lucide-bot' : undefined"
            size="xs"
            aria-hidden="true"
          />
          <span class="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <b class="text-sm font-semibold text-highlighted">{{ actorName(item.actor) }}</b>
            <UBadge
              v-if="item.actor.type === 'agent'"
              color="neutral"
              variant="soft"
              size="sm"
              :label="t('comments.agent')"
            />
            <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
          </span>
          <p
            class="col-start-2 text-sm leading-normal break-words whitespace-pre-wrap text-default"
            v-text="item.body"
          />
        </template>
        <template v-else>
          <span class="grid w-6 place-items-center pt-0.5 text-dimmed">
            <UIcon
              :name="item.kind === 'submission' ? 'i-lucide-git-pull-request-arrow' : item.kind === 'resolved' ? 'i-lucide-circle-check' : item.kind === 'reopened' ? 'i-lucide-rotate-ccw' : 'i-lucide-crosshair'"
              class="size-3.5"
              :class="item.kind === 'resolved' ? 'text-success' : ''"
            />
          </span>
          <div class="text-xs text-muted">
            <template v-if="item.kind === 'submission'">
              <b class="font-medium text-default">{{ t('comments.submitted') }}</b> · {{ actorName(item.actor) }} · <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
              <UBadge
                v-if="item.current"
                color="neutral"
                variant="soft"
                size="sm"
                class="ms-1"
                :label="t('comments.current')"
              />
              <UBadge
                v-if="item.notAccepted"
                color="warning"
                variant="soft"
                size="sm"
                class="ms-1"
                :label="t('comments.notAccepted')"
              />
              <span class="mt-1 flex flex-wrap items-center gap-1">
                <span
                  v-for="domain in item.domains"
                  :key="domain"
                  class="rounded-sm border border-default px-1 font-mono"
                >{{ domain }}</span>
                <span>{{ t('comments.evidenceCount', item.evidence.length) }}</span>
                <span class="font-mono">{{ shortId(item.id) }}</span>
              </span>
            </template>
            <template v-else-if="item.kind === 'resolved'">
              {{ item.resolution === 'verified'
                ? t('comments.resolvedVerified', { name: actorName(item.actor), id: shortId(item.submissionId) })
                : t('comments.resolvedAs', { resolution: resolutionLabel(item.resolution), name: actorName(item.actor) }) }}
              · <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
              <span
                v-if="item.reason"
                class="block text-default"
              >{{ item.reason }}</span>
            </template>
            <template v-else-if="item.kind === 'reopened'">
              {{ t('comments.reopenedBy', { name: actorName(item.actor) }) }} · <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
              <span
                v-if="item.reason"
                class="block text-default"
              >{{ item.reason }}</span>
            </template>
            <template v-else>
              {{ t('comments.reanchoredEvent', { from: `#${item.from.widgetId}`, to: `#${item.to.widgetId}` }) }} · <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
            </template>
          </div>
        </template>
      </li>
    </ol>

    <template v-if="comments.canComment.value && thread.status !== 'resolved'">
      <UTextarea
        ref="replyArea"
        v-model="reply"
        :placeholder="t('thread.reply')"
        :aria-label="t('thread.reply')"
        :rows="1"
        :maxrows="6"
        autoresize
        class="w-full"
        data-thread-reply
        @keydown="onReplyKeydown"
      />
      <div class="-mt-1 flex justify-end">
        <UButton
          size="xs"
          color="neutral"
          variant="outline"
          :loading="comments.busy.value === 'reply'"
          :disabled="!reply.trim()"
          data-thread-send
          @click="sendReply"
        >
          {{ t('comments.replyAction') }}
          <UKbd
            value="meta"
            size="sm"
            class="pointer-coarse:hidden"
          />
          <UKbd
            value="enter"
            size="sm"
            class="-ms-1 pointer-coarse:hidden"
          />
        </UButton>
      </div>
    </template>

    <div
      v-if="pendingAction"
      class="grid gap-2 rounded-md bg-muted p-2"
      data-thread-reason
    >
      <UInput
        ref="reasonInput"
        v-model="reason"
        size="sm"
        :placeholder="pendingAction === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
        :aria-label="pendingAction === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
        @keydown.enter.prevent="confirmPending"
      />
      <div class="flex justify-end gap-2">
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          :label="t('common.cancel')"
          @click="pendingAction = undefined"
        />
        <UButton
          size="xs"
          color="primary"
          variant="solid"
          :disabled="pendingAction === 'duplicate' && !reason.trim()"
          :loading="!!comments.busy.value"
          :label="pendingAction === 'duplicate' ? t('comments.resolveAsDuplicate') : t('thread.reopen')"
          @click="confirmPending"
        />
      </div>
    </div>

    <template v-else-if="comments.canComment.value">
      <!-- Open: one-click Resolve answers the discussion; the menu offers the other kinds. -->
      <div
        v-if="thread.status !== 'resolved'"
        class="flex flex-wrap items-center justify-end gap-2"
        data-thread-lifecycle
      >
        <UButton
          v-if="thread.status === 'ready-for-review'"
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-rotate-ccw"
          :label="t('thread.reopen')"
          @click="ask('reopen')"
        />
        <UFieldGroup v-if="comments.canResolve.value">
          <UButton
            size="sm"
            color="primary"
            variant="solid"
            icon="i-lucide-check"
            :label="t('thread.resolve')"
            :loading="comments.busy.value === 'resolve'"
            :disabled="thread.status === 'ready-for-review' && !activeSubmission"
            :aria-describedby="`resolve-hint-${thread.id}`"
            data-thread-resolve
            @click="comments.resolve(thread.id, thread.status === 'ready-for-review' ? 'verified' : 'answered')"
          />
          <UDropdownMenu
            :items="resolveMenu"
            :content="{ align: 'end' }"
          >
            <UButton
              size="sm"
              color="primary"
              variant="solid"
              icon="i-lucide-chevron-down"
              :aria-label="t('comments.resolveOptions')"
              data-thread-resolve-menu
            />
          </UDropdownMenu>
        </UFieldGroup>
      </div>
      <p
        v-if="thread.status !== 'resolved' && comments.canResolve.value"
        :id="`resolve-hint-${thread.id}`"
        class="text-end text-xs text-muted"
      >
        {{ thread.status === 'ready-for-review' ? t('thread.resolveHint', { id: shortId(activeSubmission?.id) }) : t('comments.resolveAnswersHint') }}
      </p>
      <p
        v-else-if="thread.status !== 'resolved'"
        class="text-end text-xs text-muted"
      >
        {{ t('comments.resolveNeedsPerson') }}
      </p>
      <div
        v-if="thread.status === 'resolved'"
        class="flex justify-end"
      >
        <UButton
          size="sm"
          color="neutral"
          variant="outline"
          icon="i-lucide-rotate-ccw"
          :label="t('thread.reopen')"
          data-thread-reopen
          @click="ask('reopen')"
        />
      </div>
    </template>

    <SubmitForReviewModal
      v-if="canSubmit"
      v-model:open="submitOpen"
      :view-id="thread.anchor.viewId"
      :submit="submitForReview"
      :busy="comments.busy.value === 'submit'"
      :error="submitError"
      :conflict="submitConflict"
    />

    <UModal
      v-model:open="promoteOpen"
      :title="t('reviews.promote.title')"
      :description="t('reviews.promote.description')"
    >
      <template #body>
        <form
          class="grid gap-3"
          @submit.prevent="submitPromote"
        >
          <UAlert
            v-if="promoteFailed && (error || conflict)"
            :color="conflict ? 'warning' : 'error'"
            variant="subtle"
            :icon="conflict ? 'i-lucide-refresh-cw' : 'i-lucide-circle-alert'"
            role="alert"
            tabindex="-1"
            :title="conflict ? t('comments.conflict') : error?.message"
            :description="conflict ? t('comments.conflictHint') : undefined"
            data-promote-error
          />
          <UFormField
            :label="t('reviews.promote.questionLabel')"
            required
          >
            <UInput
              v-model="promoteForm.question"
              class="w-full"
              :placeholder="t('reviews.promote.questionPlaceholder')"
            />
          </UFormField>
          <UFormField
            :label="t('reviews.promote.summaryLabel')"
            required
          >
            <UInput
              v-model="promoteForm.summary"
              class="w-full"
              :placeholder="t('reviews.promote.summaryPlaceholder')"
            />
          </UFormField>
          <UFormField :label="t('reviews.promote.rationaleLabel')">
            <UTextarea
              v-model="promoteForm.rationale"
              class="w-full"
              :rows="2"
              :placeholder="t('reviews.promote.rationalePlaceholder')"
            />
          </UFormField>
          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              :label="t('common.cancel')"
              @click="promoteOpen = false"
            />
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              :loading="comments.busy.value === 'promote'"
              :disabled="!promoteForm.question.trim() || !promoteForm.summary.trim()"
              :label="t('reviews.promote.submit')"
            />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
