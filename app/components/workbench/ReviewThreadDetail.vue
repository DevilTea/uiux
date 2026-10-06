<script setup lang="ts">
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ReviewResolution } from '../../../src/domain/reviews/schema'
import { useReviewInbox } from '../../composables/useReviewInbox'
import { useWorkbenchFeedback } from '../../composables/useWorkbenchFeedback'
import { copyText } from '../../utils/copy-text'
import type { InboxThread } from '../../utils/review-inbox'
import ReviewTimeline from './ReviewTimeline.vue'
import LockedSaveAlert from './LockedSaveAlert.vue'
import RetractConfirm from './RetractConfirm.vue'
import SubmitForReviewModal from './SubmitForReviewModal.vue'
import WbErrorDescription from './WbErrorDescription.vue'
import { resolveMenuGroups } from '../../utils/resolve-menu'
import { latestEditableMessageId, retractEligibility } from '../../utils/review-message-actions'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from '../../composables/useMediaQuery'
import { isLockedError, type FetchErrorDetails } from '../../utils/fetch-error'
import type { ReviewSubmissionDraft } from '../../utils/review-submission'

/**
 * The selected thread (brief d): a reading column with the full timeline, then reply and the
 * lifecycle actions. Resolve on an open thread sends `answered`; on a ready thread it accepts the
 * active submission (`verified`); the menu offers the other kinds (direct-resolve decision 10).
 *
 * `pane` sits beside the list on desktop, `sheet` is the phone bottom sheet (read, reply, resolve
 * and reopen only), `slideover` the tablet panel.
 */
const props = withDefaults(defineProps<{ layout?: 'pane' | 'sheet' | 'slideover' }>(), { layout: 'pane' })
const emit = defineEmits<{
	(e: 'close'): void
	(e: 'resolved', threadId: string, next: string | undefined): void
}>()

const { t } = useI18n()
const inbox = useReviewInbox()
const feedback = useWorkbenchFeedback()

const thread = computed<InboxThread | undefined>(() => inbox.selected.value)
const detail = computed(() => thread.value?.detail)
const compact = computed(() => props.layout === 'sheet')

const STATUS = {
	'open': { icon: 'i-lucide-circle-dot', color: 'annotation', label: 'thread.status.open' },
	'ready-for-review': { icon: 'i-lucide-eye', color: 'info', label: 'thread.status.ready' },
	'resolved': { icon: 'i-lucide-circle-check', color: 'success', label: 'thread.status.resolved' },
	// A dismissal is closed without a change: neutral, never green.
	'dismissed': { icon: 'i-lucide-circle-slash', color: 'neutral', label: 'inbox.group.dismissed' },
} as const

function shortId(id: string | undefined): string {
	return id ? `${id.slice(0, 4)}…${id.slice(-4)}` : ''
}

const activeSubmission = computed(() => thread.value?.status === 'ready-for-review' ? detail.value?.submissions.at(-1) : undefined)
const viewExists = computed(() => !!thread.value && inbox.threadViewExists(thread.value))
const workspaceScoped = computed(() => thread.value?.scope === 'workspace')
const scopeLabel = computed(() => thread.value?.variantNames.length ? thread.value.variantNames.join(t('common.listSeparator')) : t('inbox.filter.viewWide'))
const unreadable = computed(() => thread.value ? inbox.detailErrors.value.get(thread.value.id) : undefined)

// ---------------------------------------------------------------------------------------------
// Reply and lifecycle
// ---------------------------------------------------------------------------------------------

const replyArea = ref<{ textareaRef?: HTMLTextAreaElement }>()
const reply = computed({
	get: () => thread.value ? inbox.replyDrafts.value[thread.value.id] ?? '' : '',
	set: (value: string) => {
		if (thread.value) inbox.replyDrafts.value = { ...inbox.replyDrafts.value, [thread.value.id]: value }
	},
})
const conflict = computed(() => !!thread.value && inbox.conflict.value === thread.value.id)
const error = computed(() => thread.value && inbox.lastError.value?.threadId === thread.value.id ? inbox.lastError.value.error : undefined)

/** A second step for actions that ask first: Duplicate's reason (required) or Reopen's (optional). */
const pendingAction = ref<'duplicate' | 'reopen'>()
const reason = ref('')
const reasonInput = ref<{ inputRef?: HTMLInputElement }>()

function ask(action: 'duplicate' | 'reopen'): void {
	pendingAction.value = action
	reason.value = ''
	void nextTick(() => reasonInput.value?.inputRef?.focus())
}

async function resolveAs(resolution: ReviewResolution, why?: string): Promise<void> {
	const id = thread.value?.id
	if (!id) return
	// The next thread comes from the queue before the resolve moves this one out of it.
	const next = inbox.successor(id)
	if (await inbox.resolve(id, resolution, why)) {
		pendingAction.value = undefined
		emit('resolved', id, next)
	}
}

async function confirmPending(): Promise<void> {
	const id = thread.value?.id
	if (!id) return
	if (pendingAction.value === 'duplicate') {
		if (reason.value.trim()) await resolveAs('duplicate', reason.value)
	}
	else if (pendingAction.value === 'reopen' && await inbox.reopen(id, reason.value)) pendingAction.value = undefined
}

/** The one-click primary action of the current status (E, ⇧⌘↵). */
async function resolvePrimary(): Promise<void> {
	if (!thread.value || thread.value.status === 'resolved' || !inbox.canResolve.value) return
	if (thread.value.status === 'ready-for-review' && !activeSubmission.value) return
	await resolveAs(inbox.primaryResolution(thread.value))
}

async function sendReply(): Promise<void> {
	if (thread.value) await inbox.reply(thread.value.id)
}

function onReplyKeydown(event: KeyboardEvent): void {
	// ↑ in an empty reply box edits the viewer's latest editable message (scope/edit decision 16).
	if (event.key === 'ArrowUp' && !reply.value && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && detail.value) {
		const messageId = latestEditableMessageId(detail.value, inbox.me.value)
		if (messageId) {
			event.preventDefault()
			editingMessageId.value = messageId
		}
		return
	}
	if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
	event.preventDefault()
	if (event.shiftKey) void resolvePrimary()
	else void sendReply()
}

/** Grouped: Resolve (Answered, Verified) and Dismiss (No longer relevant, Duplicate…, Won't do). */
const resolveMenu = computed<DropdownMenuItem[][]>(() => {
	const current = thread.value
	if (!current) return []
	return resolveMenuGroups({
		t,
		status: current.status,
		canVerify: !!activeSubmission.value,
		resolve: (resolution) => { void resolveAs(resolution) },
		askDuplicate: () => ask('duplicate'),
	})
})

// ---------------------------------------------------------------------------------------------
// Editing a message (scope/edit decisions 11–16)
// ---------------------------------------------------------------------------------------------

const editingMessageId = computed<string | undefined>({
	get: () => inbox.editingMessage.value?.threadId === thread.value?.id ? inbox.editingMessage.value?.messageId : undefined,
	set: (messageId) => {
		inbox.editingMessage.value = messageId && thread.value ? { threadId: thread.value.id, messageId } : undefined
		if (!messageId) void nextTick(() => replyArea.value?.textareaRef?.focus())
	},
})

async function saveEdit(messageId: string, body: string): Promise<void> {
	const id = thread.value?.id
	if (id && await inbox.editMessage(id, messageId, body)) void nextTick(() => replyArea.value?.textareaRef?.focus())
}

// ---------------------------------------------------------------------------------------------
// Delete comment (retract addendum decision 8): only while eligible, confirmed inline
// ---------------------------------------------------------------------------------------------

const retract = computed(() => inbox.canReply.value ? retractEligibility(detail.value, inbox.me.value) : { eligible: false as const })
const confirmingDelete = ref(false)
const deleteRefused = computed(() => !!thread.value && inbox.retractRefused.value === thread.value.id)

/**
 * The menu would hand focus back to its trigger as it closes; the delete confirm keeps it on Cancel.
 * The menu unmounts only after its close animation, which can end after the delete already went
 * through: by then this detail shows the next thread and the page has moved focus to the queue
 * (`inbox.deleted`), so the trigger, now another thread's, must not take it back.
 */
const retractConfirm = ref<InstanceType<typeof RetractConfirm>>()
let deleteAskedFor: string | undefined
function keepConfirmFocus(event: Event): void {
	const askedFor = deleteAskedFor
	deleteAskedFor = undefined
	if (confirmingDelete.value) {
		event.preventDefault()
		void nextTick(() => retractConfirm.value?.focusCancel())
	}
	else if (askedFor && askedFor !== thread.value?.id) event.preventDefault()
}

function askDelete(): void {
	inbox.retractRefused.value = undefined
	pendingAction.value = undefined
	deleteAskedFor = thread.value?.id
	confirmingDelete.value = true
}

/** On success the thread leaves the queue and this detail unmounts; the page moves focus (`inbox.deleted`). */
async function confirmDelete(): Promise<void> {
	const id = thread.value?.id
	if (!id) return
	await inbox.retract(id)
	confirmingDelete.value = false
}
const resolveMenuOpen = ref(false)

// ---------------------------------------------------------------------------------------------
// Overflow: Copy link, Re-anchor, Promote to Decision, Copy thread ID
// ---------------------------------------------------------------------------------------------

async function copy(text: string, title: string): Promise<void> {
	if (await copyText(text)) feedback.success(title)
	else feedback.error(undefined, t('comments.errors.copyFailed'))
}

const promoteOpen = ref(false)
const promoteForm = reactive({ question: '', summary: '', rationale: '' })
function openPromote(): void {
	promoteForm.question = thread.value?.title ?? ''
	promoteForm.summary = ''
	promoteForm.rationale = ''
	promoteOpen.value = true
}
/** A rejected promotion shows its error inside the dialog (not behind it) and takes focus there. */
const promoteFailed = ref(false)
watch(promoteOpen, (value) => { if (value) promoteFailed.value = false })
async function focusPromoteError(): Promise<void> {
	promoteFailed.value = true
	await nextTick()
	document.querySelector<HTMLElement>('[data-promote-error]')?.focus()
}

async function submitPromote(): Promise<void> {
	const id = thread.value?.id
	if (!id || !promoteForm.question.trim() || !promoteForm.summary.trim()) return
	if (await inbox.promote(id, { question: promoteForm.question, summary: promoteForm.summary, rationale: promoteForm.rationale })) {
		promoteOpen.value = false
		feedback.success(t('reviews.feedback.promoted'))
	}
	else await focusPromoteError()
}

// ---------------------------------------------------------------------------------------------
// Submit for review… (human submission; secondary, desktop-first)
// ---------------------------------------------------------------------------------------------

const isDesktop = useMediaQuery(WORKBENCH_BREAKPOINTS.desktop)
const canSubmit = computed(() => !!thread.value && thread.value.status === 'open' && inbox.canReply.value && viewExists.value && isDesktop.value && !compact.value)
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
	const id = thread.value?.id
	if (!id) return false
	const ok = await inbox.submit(id, draft)
	if (ok) feedback.success(t('submit.announce'))
	else {
		submitConflict.value = inbox.conflict.value === id
		submitError.value = inbox.lastError.value?.threadId === id ? inbox.lastError.value.error : undefined
	}
	return ok
}

const overflow = computed<DropdownMenuItem[][]>(() => {
	const current = thread.value
	if (!current) return []
	const groups: DropdownMenuItem[][] = [[
		{ label: t('thread.copyLink'), icon: 'i-lucide-link', onSelect: () => { void copy(inbox.threadLink(current.id), t('comments.copiedLink')) } },
		...(canSubmit.value ? [{ label: t('thread.submit'), icon: 'i-lucide-eye', onSelect: () => { submitOpen.value = true } }] : []),
		...(inbox.canReply.value && viewExists.value && !compact.value ? [{ label: t('inbox.reanchorOnCanvas'), icon: 'i-lucide-crosshair', onSelect: () => inbox.reanchorOnCanvas(current) }] : []),
		// Workspace threads have no Decision home (O3): re-anchor to a View's root first.
		...(inbox.canPromote.value && viewExists.value && !compact.value ? [{ label: t('thread.promote'), icon: 'i-lucide-signpost', onSelect: openPromote }] : []),
		{ label: t('comments.copyThreadId'), icon: 'i-lucide-copy', onSelect: () => { void copy(current.id, t('comments.copiedId')) } },
	]]
	if (retract.value.eligible)
		groups.push([{ label: retract.value.empty ? t('comments.deleteEmpty') : t('comments.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: askDelete }])
	return groups
})

// ---------------------------------------------------------------------------------------------
// Focus: the keyboard triage reaches into the open thread
// ---------------------------------------------------------------------------------------------

const heading = ref<HTMLElement>()
function focusReply(): void {
	const area = replyArea.value?.textareaRef
	if (area) area.focus()
	else heading.value?.focus()
}
function focusHeading(): void {
	heading.value?.focus()
}
function openResolveMenu(): void {
	if (thread.value && thread.value.status !== 'resolved' && inbox.canResolve.value) resolveMenuOpen.value = true
}

watch(() => thread.value?.id, () => {
	pendingAction.value = undefined
	resolveMenuOpen.value = false
	confirmingDelete.value = false
})
// Someone engaged meanwhile (or the thread changed): the Delete affordance and its confirm go away.
watch(() => retract.value.eligible, (eligible) => { if (!eligible) confirmingDelete.value = false })

defineExpose({ focusReply, focusHeading, openResolveMenu, resolvePrimary })
</script>

<template>
  <div
    v-if="thread"
    class="flex min-h-0 flex-1 flex-col"
    data-review-detail
    :data-thread-id="thread.id"
    :data-thread-status="thread.status"
  >
    <header
      class="grid gap-2 border-b border-default *:max-w-3xl"
      :class="compact ? 'px-4 pb-3' : 'px-4 py-3 sm:px-6'"
    >
      <div class="flex min-w-0 items-start gap-2">
        <h2
          :id="`review-title-${thread.id}`"
          ref="heading"
          tabindex="-1"
          class="line-clamp-2 min-w-0 flex-1 text-title font-semibold text-highlighted outline-none"
          :title="thread.title"
        >
          {{ thread.title ?? (unreadable ? t('inbox.unreadableTitle') : workspaceScoped ? t('comments.workspaceComment') : `#${thread.widgetId ?? ''}`) }}
        </h2>
        <UTooltip
          v-if="viewExists && !compact && !workspaceScoped"
          :text="t('inbox.openInCanvas')"
          :kbds="['o']"
        >
          <UButton
            color="neutral"
            variant="outline"
            size="sm"
            icon="i-lucide-app-window"
            :label="t('inbox.openInCanvas')"
            class="shrink-0"
            data-review-open-canvas
            @click="inbox.openInCanvas(thread)"
          />
        </UTooltip>
        <UDropdownMenu
          :items="overflow"
          :content="{ align: 'end', onCloseAutoFocus: keepConfirmFocus }"
        >
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            icon="i-lucide-ellipsis"
            class="shrink-0"
            :aria-label="t('comments.more')"
          />
        </UDropdownMenu>
        <UButton
          v-if="layout !== 'pane'"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-x"
          class="shrink-0"
          :aria-label="t('common.close')"
          data-review-close
          @click="emit('close')"
        />
      </div>
      <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
        <UBadge
          :color="STATUS[thread.inboxStatus].color"
          :variant="thread.inboxStatus === 'dismissed' ? 'soft' : 'subtle'"
          size="sm"
          :icon="STATUS[thread.inboxStatus].icon"
          :label="t(STATUS[thread.inboxStatus].label)"
          data-review-status
        />
        <UBadge
          v-if="thread.status === 'resolved' && thread.resolution"
          color="neutral"
          variant="outline"
          size="sm"
          :label="t(`comments.resolution.${thread.resolution}`)"
          :data-review-resolution="thread.resolution"
        />
        <span
          v-if="workspaceScoped"
          class="inline-flex min-w-0 items-center gap-1 truncate"
          data-review-workspace
        >
          <UIcon
            name="i-lucide-globe"
            class="size-3.5 shrink-0"
            aria-hidden="true"
          />{{ t('comments.workspaceComment') }}
        </span>
        <template v-else>
          <span class="min-w-0 truncate">{{ thread.viewName ?? t('inbox.viewMissing') }} › <span :class="thread.missingVariants.length ? 'text-warning' : ''">{{ scopeLabel }}</span></span>
          <span
            v-if="thread.widgetId"
            class="min-w-0 truncate rounded-sm border border-default px-1.5 font-mono leading-5"
            :title="thread.widgetId"
          >{{ thread.anchorState === 'missing' ? `#${thread.widgetId}` : `${thread.widgetType ?? 'Widget'} · #${thread.widgetId}` }}</span>
        </template>
      </div>
    </header>

    <div
      class="min-h-0 flex-1 overflow-y-auto"
      :class="compact ? 'px-4 py-3' : 'px-4 py-4 sm:px-6'"
    >
      <div class="grid max-w-3xl gap-3">
        <UAlert
          v-if="thread.anchorState === 'missing'"
          color="warning"
          variant="subtle"
          icon="i-lucide-unlink"
          :title="viewExists ? t('comments.widgetGone') : t('inbox.viewGone')"
          :description="viewExists ? t('comments.widgetGoneHint', { id: `#${thread.widgetId}` }) : t('inbox.viewGoneHint')"
          :actions="[
            ...(inbox.canReply.value && viewExists && !compact ? [{ label: t('thread.reanchor'), icon: 'i-lucide-crosshair', size: 'xs' as const, color: 'neutral' as const, variant: 'outline' as const, onClick: () => inbox.reanchorOnCanvas(thread!) }] : []),
            ...(inbox.canResolve.value && thread.status !== 'resolved' ? [{ label: t('inbox.resolveObsolete'), icon: 'i-lucide-archive', size: 'xs' as const, color: 'neutral' as const, variant: 'outline' as const, onClick: () => { void resolveAs('obsolete') } }] : []),
          ]"
          :ui="{ title: 'text-sm', description: 'text-xs' }"
          data-review-anchor-missing
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
        <UAlert
          v-if="unreadable && !detail"
          color="error"
          variant="subtle"
          icon="i-lucide-file-warning"
          :title="t('inbox.unreadableTitle')"
          :ui="{ title: 'text-sm', description: 'text-xs' }"
          data-review-unreadable
        >
          <template #description>
            <WbErrorDescription
              :headline="t('inbox.unreadableTitle')"
              :lead="unreadable.message"
              :diagnostics="unreadable.diagnostics"
              :status-code="unreadable.statusCode"
            />
          </template>
        </UAlert>
        <UAlert
          v-if="conflict"
          color="warning"
          variant="subtle"
          icon="i-lucide-refresh-cw"
          :title="t('conflict.thread')"
          :description="t('comments.conflictHint')"
          :ui="{ title: 'text-sm', description: 'text-xs' }"
          data-review-conflict
        />
        <LockedSaveAlert
          v-if="error && isLockedError(error)"
          :lock="error.lock"
          @dismiss="inbox.lastError.value = undefined"
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

        <ReviewTimeline
          v-if="detail"
          v-model:editing-message-id="editingMessageId"
          :thread="detail"
          :me="inbox.me.value"
          :can-edit="inbox.canReply.value"
          :saving="inbox.busy.value === 'edit'"
          @save="saveEdit"
        />
        <div
          v-else-if="!unreadable"
          class="grid gap-4"
          aria-hidden="true"
        >
          <USkeleton
            v-for="index in 3"
            :key="index"
            class="h-12 w-full"
            :aria-label="t('common.loading')"
          />
        </div>
      </div>
    </div>

    <footer
      v-if="inbox.canReply.value && detail"
      class="grid gap-2 border-t border-default bg-default *:max-w-3xl"
      :class="compact ? 'px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]' : 'px-4 py-3 sm:px-6'"
      data-review-actions
    >
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
        :busy="inbox.busy.value === 'retract'"
        :compact="compact"
        @cancel="confirmingDelete = false"
        @confirm="confirmDelete"
      />
      <div
        v-if="thread.status !== 'resolved' && !confirmingDelete"
        class="flex items-end gap-2"
      >
        <UTextarea
          ref="replyArea"
          v-model="reply"
          :placeholder="t('thread.reply')"
          :aria-label="t('thread.reply')"
          :rows="1"
          :maxrows="compact ? 4 : 8"
          autoresize
          class="min-w-0 flex-1"
          :ui="{ base: 'pointer-coarse:text-base' }"
          data-review-reply
          @keydown="onReplyKeydown"
        />
        <UButton
          v-if="compact"
          color="neutral"
          variant="outline"
          icon="i-lucide-send-horizontal"
          :loading="inbox.busy.value === 'reply'"
          :disabled="!reply.trim()"
          :aria-label="t('comments.replyAction')"
          class="shrink-0"
          data-review-send
          @click="sendReply"
        />
      </div>

      <div
        v-if="confirmingDelete"
        hidden
      />
      <div
        v-else-if="pendingAction"
        class="grid gap-2 rounded-md bg-muted p-2"
        data-review-reason
      >
        <UInput
          ref="reasonInput"
          v-model="reason"
          :placeholder="pendingAction === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
          :aria-label="pendingAction === 'duplicate' ? t('comments.duplicateReason') : t('comments.reopenReason')"
          :ui="{ base: 'pointer-coarse:text-base' }"
          @keydown.enter.prevent="confirmPending"
          @keydown.escape.stop="pendingAction = undefined"
        />
        <div class="flex justify-end gap-2">
          <UButton
            color="neutral"
            variant="ghost"
            size="sm"
            :label="t('common.cancel')"
            @click="pendingAction = undefined"
          />
          <UButton
            color="primary"
            variant="solid"
            size="sm"
            :disabled="pendingAction === 'duplicate' && !reason.trim()"
            :loading="!!inbox.busy.value"
            :label="pendingAction === 'duplicate' ? t('comments.resolveAsDuplicate') : t('thread.reopen')"
            data-review-reason-confirm
            @click="confirmPending"
          />
        </div>
      </div>

      <div
        v-else
        :class="compact ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap items-center justify-end gap-2'"
        data-review-lifecycle
      >
        <UButton
          v-if="thread.status !== 'resolved' && !compact"
          color="neutral"
          variant="outline"
          size="sm"
          :loading="inbox.busy.value === 'reply'"
          :disabled="!reply.trim()"
          class="me-auto"
          data-review-send
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
        <UButton
          v-if="canSubmit"
          color="neutral"
          variant="ghost"
          size="sm"
          icon="i-lucide-eye"
          :label="t('thread.submit')"
          data-review-submit
          @click="submitOpen = true"
        />
        <UButton
          v-if="thread.status !== 'open'"
          color="neutral"
          variant="outline"
          :size="compact ? 'md' : 'sm'"
          icon="i-lucide-rotate-ccw"
          :label="t('thread.reopen')"
          :class="compact ? ['justify-center', thread.status === 'resolved' || !inbox.canResolve.value ? 'col-span-2' : ''] : ''"
          data-review-reopen
          @click="ask('reopen')"
        />
        <UFieldGroup
          v-if="thread.status !== 'resolved' && inbox.canResolve.value"
          :class="compact && thread.status === 'open' ? 'col-span-2 flex' : 'flex'"
        >
          <UButton
            color="primary"
            variant="solid"
            :size="compact ? 'md' : 'sm'"
            icon="i-lucide-check"
            :label="thread.status === 'ready-for-review' && !compact ? t('inbox.acceptResolve') : t('thread.resolve')"
            :loading="inbox.busy.value === 'resolve'"
            :disabled="thread.status === 'ready-for-review' && !activeSubmission"
            :aria-describedby="`review-resolve-hint-${thread.id}`"
            :class="compact ? 'min-w-0 flex-1 justify-center' : ''"
            data-review-resolve
            @click="resolvePrimary"
          />
          <UDropdownMenu
            v-model:open="resolveMenuOpen"
            :items="resolveMenu"
            :content="{ align: 'end', side: compact ? 'top' : 'bottom' }"
          >
            <UButton
              color="primary"
              variant="solid"
              :size="compact ? 'md' : 'sm'"
              icon="i-lucide-chevron-down"
              :aria-label="t('comments.resolveOptions')"
              data-review-resolve-menu
            />
          </UDropdownMenu>
        </UFieldGroup>
      </div>
      <p
        v-if="thread.status !== 'resolved' && inbox.canResolve.value && !pendingAction && !confirmingDelete"
        :id="`review-resolve-hint-${thread.id}`"
        class="text-xs text-muted"
        :class="compact ? 'text-center' : 'text-end'"
      >
        {{ thread.status === 'ready-for-review' ? t('thread.resolveHint', { id: shortId(activeSubmission?.id) }) : t('comments.resolveAnswersHint') }}
      </p>
      <p
        v-else-if="thread.status !== 'resolved' && !pendingAction && !confirmingDelete"
        class="text-xs text-muted"
        :class="compact ? 'text-center' : 'text-end'"
      >
        {{ t('comments.resolveNeedsPerson') }}
      </p>
    </footer>
    <p
      v-else-if="detail"
      class="border-t border-default px-4 py-3 text-xs text-muted sm:px-6"
    >
      {{ t('inbox.readOnly') }}
    </p>

    <SubmitForReviewModal
      v-if="canSubmit && thread.viewId"
      v-model:open="submitOpen"
      :view-id="thread.viewId"
      :submit="submitForReview"
      :busy="inbox.busy.value === 'submit'"
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
              :loading="inbox.busy.value === 'promote'"
              :disabled="!promoteForm.question.trim() || !promoteForm.summary.trim()"
              :label="t('reviews.promote.submit')"
            />
          </div>
        </form>
      </template>
    </UModal>
  </div>
</template>
