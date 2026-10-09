<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { navigateTo, useI18n } from '#imports'
import { useWorkbench } from '../../../composables/useWorkbench'
import { relativeTime } from '../../../utils/widget-inspection'
import { statusKey, useCanvasComments } from '../../../composables/useCanvasComments'
import { useThreadActions } from '../../../composables/useThreadActions'
import { isWorkspaceAnchor, type ReviewActor, type ReviewAnchor, type ReviewResolution } from '../../../../src/domain/reviews/schema'
import { flattenWidgetTree } from '../../../../src/preview/widget-tree'
import { buildReviewTimeline, type ReviewTimelineItem } from '../../../utils/review-timeline'
import { isDismissal } from '../../../utils/review-inbox'
import { latestEditableMessageId } from '../../../utils/review-message-actions'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../../composables/useMediaQuery'
import { isLockedError } from '../../../utils/fetch-error'
import LockedSaveAlert from '../LockedSaveAlert.vue'
import RetractConfirm from '../RetractConfirm.vue'
import ReviewMessage from '../ReviewMessage.vue'
import SubmitForReviewModal from '../SubmitForReviewModal.vue'
import ThreadPromoteModal from '../ThreadPromoteModal.vue'
import ThreadReasonPrompt from '../ThreadReasonPrompt.vue'
import WbErrorDescription from '../WbErrorDescription.vue'
import RecordedContextLabel from '../RecordedContextLabel.vue'
import { effectiveRenderContext } from '../../../../src/preview/render-context-options'

/**
 * The thread bubble (brief c, section 6; direct-resolve decision 10): status, the compact typed
 * timeline, reply, and the lifecycle actions. Resolve on an open thread sends `answered`; a ready
 * thread's Resolve accepts its submission (`verified`); the menu offers the other kinds.
 */
const props = defineProps<{ threadId: string }>()

const { t, locale } = useI18n()
const workbench = useWorkbench()
const comments = useCanvasComments()!
const { preview, widgetTreeResult, selectedVariant, selectedLocale, selectedViewportId, selectedThemeId } = workbench

const thread = computed(() => comments.threadById.value.get(props.threadId))
const placement = computed(() => comments.pinStatusById.value.get(props.threadId))
const detail = computed(() => thread.value?.detail)

const widgetType = computed(() => {
	const tree = widgetTreeResult.value
	const id = thread.value?.anchor.widgetId
	return tree?.status === 'valid' && id ? flattenWidgetTree(tree.root).find(node => node.id === id)?.type : undefined
})

const status = computed(() => thread.value?.dismissed ? 'dismissed' : statusKey(thread.value?.status ?? 'open'))
const STATUS_ICON = { open: 'i-lucide-circle-dot', ready: 'i-lucide-eye', resolved: 'i-lucide-circle-check', dismissed: 'i-lucide-circle-slash' } as const
const STATUS_COLOR = { open: 'annotation', ready: 'info', resolved: 'success', dismissed: 'neutral' } as const
const STATUS_LABEL = { open: 'thread.status.open', ready: 'thread.status.ready', resolved: 'thread.status.resolved', dismissed: 'inbox.group.dismissed' } as const

function actorName(actor: ReviewActor | undefined): string {
	return actor?.displayName ?? actor?.id ?? t('comments.unknownAuthor')
}
function shortId(id: string | undefined): string {
	return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : ''
}
function resolutionLabel(resolution: ReviewResolution | undefined): string {
	return t(`comments.resolution.${resolution ?? 'answered'}`)
}
/** A re-anchor end: `#widget`, or the Workspace. */
function anchorText(anchor: ReviewAnchor): string {
	return isWorkspaceAnchor(anchor) ? t('comments.workspaceTarget') : `#${anchor.widgetId}`
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

function startReanchor(): void {
	comments.close()
	preview.startReanchor(props.threadId)
}

function threadLink(): string {
	const url = new URL(window.location.href)
	url.searchParams.set('thread', props.threadId)
	return url.toString()
}

// Phones read, reply and triage only (DESIGN.md "Mobile"): Re-anchor and Promote to Decision are
// left out there, as in the Reviews sheet. Submit for review is desktop-first.
const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const isPhone = useMediaQuery(WORKBENCH_BREAKPOINTS.phone)
const canSubmit = computed(() => thread.value?.status === 'open' && comments.canComment.value && isDesktop.value)

const actions = useThreadActions({
	thread: () => thread.value,
	detail: () => detail.value,
	me: () => comments.me.value,
	canWrite: () => comments.canComment.value,
	canReanchor: () => comments.canComment.value && !isPhone.value,
	canPromote: () => !workbench.authorReadOnly.value && !isPhone.value,
	canSubmit: () => canSubmit.value,
	conflict: () => conflict.value,
	error: () => error.value,
	retractRefused: () => comments.retractRefused.value === props.threadId,
	clearRetractRefused: () => { comments.retractRefused.value = undefined },
	resolve: (id, resolution, reason) => comments.resolve(id, resolution, reason),
	reopen: (id, reason) => comments.reopen(id, reason),
	// The canvas store sends the rationale as typed; an empty one repeats the summary.
	promote: (id, form) => comments.promote(id, { ...form, rationale: form.rationale || form.summary }),
	submit: (id, draft) => comments.submit(id, draft),
	retract: id => comments.retract(id),
	reanchor: startReanchor,
	threadLink,
	reanchorLabel: () => t('thread.reanchor'),
	extraOverflow: () => [{ label: t('comments.openInReviews'), icon: 'i-lucide-inbox', onSelect: () => { void navigateTo({ path: '/reviews', query: { thread: props.threadId } }) } }],
	afterPromote: () => workbench.loadSelectedView(preview.notifyIframeContext),
})
const {
	activeSubmission, primaryResolution, resolveAs, resolveMenu,
	pendingAction, reason, reasonInput, ask, confirmPending,
	confirmingDelete, deleteRefused, retractConfirm, keepConfirmFocus, confirmDelete,
	promoteOpen, submitPromote,
	submitOpen, submitError, submitConflict, submitForReview,
	overflow,
} = actions

async function sendReply(): Promise<void> {
	await comments.reply(props.threadId)
}

function onReplyKeydown(event: KeyboardEvent): void {
	// ↑ in an empty reply box edits the viewer's latest editable message (scope/edit decision 16).
	if (event.key === 'ArrowUp' && !reply.value && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && detail.value) {
		const messageId = latestEditableMessageId(detail.value, comments.me.value)
		if (messageId) {
			event.preventDefault()
			editingMessageId.value = messageId
		}
		return
	}
	if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
		event.preventDefault()
		void sendReply()
	}
}

// Editing a message inline (scope/edit decisions 11–16)
const editingMessageId = computed<string | undefined>({
	get: () => comments.editingMessage.value?.threadId === props.threadId ? comments.editingMessage.value.messageId : undefined,
	set: (messageId) => {
		comments.editingMessage.value = messageId ? { threadId: props.threadId, messageId } : undefined
		if (!messageId) void nextTick(() => replyArea.value?.textareaRef?.focus({ preventScroll: true }))
	},
})
async function saveEdit(messageId: string, body: string): Promise<void> {
	if (await comments.editMessage(props.threadId, messageId, body)) void nextTick(() => replyArea.value?.textareaRef?.focus({ preventScroll: true }))
}

function switchVariant(name: string): void {
	selectedVariant.value = name
}

/**
 * "Open in current context" (Rule 01a1170f-c11d): when an inbox link switched the Preview to this
 * thread's recorded context, the reader's own context comes back with the thread still open. It
 * changes the Preview render context only, never the chrome (Rule 01a118a1-9e11).
 */
const contextBefore = computed(() => {
	const saved = workbench.contextBeforeThread.value
	if (saved?.threadId !== props.threadId) return undefined
	const shows = (selection: Readonly<{ locale: string; viewport: string; theme: string }>) =>
		effectiveRenderContext(workbench.workspace.value?.resource, workbench.discoveredLocales.value, selection)
	const was = shows(saved)
	const now = shows({ locale: selectedLocale.value, viewport: selectedViewportId.value, theme: selectedThemeId.value })
	return was.locale !== now.locale || was.viewportId !== now.viewportId || was.themeId !== now.themeId ? saved : undefined
})
function openInCurrentContext(): void {
	const saved = contextBefore.value
	if (!saved) return
	selectedLocale.value = saved.locale
	selectedViewportId.value = saved.viewport
	selectedThemeId.value = saved.theme
	workbench.contextBeforeThread.value = undefined
	comments.announce(t('threadContext.announceCurrent'))
	// The button unmounts with the offer: keep focus in the bubble instead of dropping it to the body.
	void nextTick(() => root.value?.focus({ preventScroll: true }))
}

/**
 * A muted bubble (Rule 01a1170f-c1ae): the thread records another render context than the Preview
 * shows, for example after a list pick or a context change while it is open. It says so and offers
 * the recorded context; activating that switches the Preview like the muted pin (Rule 01a1170f-c1f7).
 */
const muted = computed(() => comments.mutedThreadIds.value.has(props.threadId))
async function openInRecordedContext(): Promise<void> {
	if (!await comments.openInRecordedContext(props.threadId)) return
	// The offer unmounts once the context matches: keep focus in the bubble.
	void nextTick(() => root.value?.focus({ preventScroll: true }))
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
    :data-thread-muted="muted ? '' : undefined"
  >
    <div class="flex min-w-0 items-center gap-2">
      <UBadge
        :color="STATUS_COLOR[status]"
        variant="soft"
        size="sm"
        :icon="STATUS_ICON[status]"
        :label="t(STATUS_LABEL[status])"
        class="shrink-0"
      />
      <span
        id="thread-bubble-title"
        class="min-w-0 truncate rounded-sm border border-default px-1.5 text-xs leading-5 text-muted"
        :class="thread.anchor.widgetId === 'root' ? '' : 'font-mono'"
        :title="thread.title"
      >{{ thread.anchorValid ? comments.targetLabel(thread.anchor.widgetId, widgetType) : `#${thread.anchor.widgetId}` }}</span>
      <span class="flex-1" />
      <UDropdownMenu
        :items="overflow"
        :content="{ align: 'end', onCloseAutoFocus: keepConfirmFocus }"
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

    <div
      v-if="thread.renderContext"
      class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted"
    >
      <RecordedContextLabel :context="thread.renderContext" />
      <span
        v-if="muted"
        class="text-muted"
        data-thread-muted-note
      >{{ t('threadContext.mutedNote') }}</span>
      <UButton
        v-if="muted"
        color="neutral"
        variant="link"
        size="xs"
        class="p-0"
        icon="i-lucide-scan-eye"
        :label="t('threadContext.openInRecorded')"
        :title="t('threadContext.openInRecordedHint')"
        data-thread-open-recorded
        @click="openInRecordedContext"
      />
      <UButton
        v-if="contextBefore"
        color="neutral"
        variant="link"
        size="xs"
        class="p-0"
        icon="i-lucide-undo-2"
        :label="t('threadContext.openInCurrent')"
        :title="t('threadContext.openInCurrentHint')"
        data-thread-open-current
        @click="openInCurrentContext"
      />
    </div>

    <UAlert
      v-if="!thread.anchorValid"
      color="warning"
      variant="subtle"
      icon="i-lucide-unlink"
      :title="t('comments.widgetGone')"
      :description="t('comments.widgetGoneHint', { id: `#${thread.anchor.widgetId}` })"
      :actions="comments.canComment.value && !isPhone ? [{ label: t('thread.reanchor'), icon: 'i-lucide-crosshair', size: 'xs', color: 'neutral', variant: 'outline', onClick: startReanchor }] : undefined"
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
      :ui="{ title: 'text-sm', description: 'text-xs' }"
    >
      <template #description>
        <WbErrorDescription
          :headline="error.message"
          :diagnostics="error.diagnostics"
          :status-code="error.statusCode"
        />
      </template>
    </UAlert>

    <ol
      class="grid max-h-60 gap-2.5 overflow-auto border-t border-default pt-2.5"
      :aria-label="t('comments.timeline')"
      data-thread-timeline
    >
      <li
        v-if="!detail"
        class="text-xs text-muted"
      >
        <USkeleton
          class="h-10 w-full"
          :aria-label="t('common.loading')"
        />
      </li>
      <li
        v-for="item in timeline"
        :key="item.id"
        class="grid grid-cols-[24px_minmax(0,1fr)] gap-x-2 gap-y-0.5"
        :data-timeline-kind="item.kind"
      >
        <template v-if="item.kind === 'message'">
          <ReviewMessage
            v-if="detail"
            :item="item"
            :thread="detail"
            :me="comments.me.value"
            :can-edit="comments.canComment.value"
            compact
            :editing="editingMessageId === item.id"
            :saving="comments.busy.value === 'edit' && editingMessageId === item.id"
            @update:editing="(on: boolean) => { editingMessageId = on ? item.id : undefined }"
            @save="(body: string) => saveEdit(item.id, body)"
          />
        </template>
        <template v-else>
          <span class="grid w-6 place-items-center pt-0.5 text-dimmed">
            <UIcon
              :name="item.kind === 'submission' ? 'i-lucide-git-pull-request-arrow' : item.kind === 'resolved' ? (isDismissal(item.resolution) ? 'i-lucide-circle-slash' : 'i-lucide-circle-check') : item.kind === 'reopened' ? 'i-lucide-rotate-ccw' : 'i-lucide-crosshair'"
              class="size-3.5"
              :class="item.kind === 'resolved' && !isDismissal(item.resolution) ? 'text-success' : ''"
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
                : t(isDismissal(item.resolution) ? 'comments.dismissedAs' : 'comments.resolvedAs', { resolution: resolutionLabel(item.resolution), name: actorName(item.actor) }) }}
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
              {{ t('comments.reanchoredEvent', { from: anchorText(item.from), to: anchorText(item.to) }) }} · <time :datetime="item.at">{{ relativeTime(item.at, locale) }}</time>
            </template>
          </div>
        </template>
      </li>
    </ol>

    <UAlert
      v-if="deleteRefused"
      color="warning"
      variant="subtle"
      icon="i-lucide-message-circle-warning"
      :title="t('comments.errors.deleteEngaged')"
      :ui="{ title: 'text-sm' }"
      role="alert"
      data-retract-refused
    />
    <RetractConfirm
      v-if="confirmingDelete"
      ref="retractConfirm"
      compact
      :busy="comments.busy.value === 'retract'"
      @cancel="confirmingDelete = false"
      @confirm="confirmDelete"
    />

    <template v-else-if="comments.canComment.value && thread.status !== 'resolved'">
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

    <ThreadReasonPrompt
      v-if="pendingAction && !confirmingDelete"
      ref="reasonInput"
      v-model="reason"
      :action="pendingAction"
      :busy="!!comments.busy.value"
      size="xs"
      @confirm="confirmPending"
      @cancel="pendingAction = undefined"
    />

    <template v-else-if="comments.canComment.value && !confirmingDelete">
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
            @click="resolveAs(primaryResolution)"
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

    <ThreadPromoteModal
      v-model:open="promoteOpen"
      :question="thread.title"
      :busy="comments.busy.value === 'promote'"
      :error="error"
      :conflict="conflict"
      :submit="submitPromote"
    />
  </div>
</template>
