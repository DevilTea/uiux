<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from '#imports'
import { useUiuxClient } from '../composables/useUiuxClient'
import { useWorkbenchFeedback } from '../composables/useWorkbenchFeedback'
import { useWorkbenchFormat } from '../composables/useWorkbenchFormat'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import type { FormalEvidenceRecord } from '../../src/domain/evidence/schema'
import { isCompleteEvidenceForViewRevision } from '../../src/domain/evidence/staleness'
import type { ReviewAnchor, ReviewStatus, ReviewThread } from '../../src/domain/reviews/schema'

interface ReviewSummary {
	kind: 'review'
	key: string
	revision: string
	diagnosticCount: number
	summary: { anchor?: ReviewAnchor; status?: ReviewStatus; messageCount?: number }
}

interface ReviewRead {
	kind: 'review'
	key: string
	revision: string
	diagnostics: ReadonlyArray<{ code: string; path: string; message: string }>
	resource: ReviewThread
}

interface FormalEvidenceItem {
	digest: string
	record: FormalEvidenceRecord
}

type FormError = { name: string; message: string }

// Decision defaults are authored Workspace data, not Workbench chrome. The actor is never sent:
// the server stamps it from the signed-in member (accepted identity decision 6).
const DEFAULT_OUTCOME_SUMMARY = 'Decision accepted.'
const DEFAULT_OUTCOME_RATIONALE = 'Consensus reached in review thread.'

const props = defineProps<{
	readOnly?: boolean
	currentViewId?: string
	selectedWidgetId?: string
	currentViewRevision?: string
	isCommentMode?: boolean
	/** Hides the canvas comment-mode toggle where no canvas is mounted (the Reviews page). */
	hideCommentMode?: boolean
	/** Shows "Open in canvas" for the selected thread (the Reviews page). */
	showOpenInCanvas?: boolean
}>()

const uiux = useUiuxClient()
const { t } = useI18n()
const feedback = useWorkbenchFeedback()
const fmt = useWorkbenchFormat()

const emit = defineEmits<{
	(e: 'highlightWidget', widgetId: string): void
	(e: 'toggleCommentMode'): void
	(e: 'viewPromoted'): void
	(e: 'changed'): void
	(e: 'threadSelected', threadId: string): void
	(e: 'openInCanvas', thread: { threadId: string; viewId: string; widgetId: string }): void
}>()

const reviews = ref<readonly ReviewSummary[]>([])
const selectedReviewId = ref<string>('')
const selectedReviewData = ref<ReviewRead>()
const scopeToCurrentView = ref(true)
const loadingList = ref(false)
const loadingDetail = ref(false)
const reviewLoadSequence = ref(0)
const loadError = ref<FetchErrorDetails>()

// Action form states
const newMessageBody = ref('')
const sendingMessage = ref(false)

const reanchorReason = ref('')
const reanchoring = ref(false)

const resolving = ref(false)
const resolveReason = ref('')

const reopening = ref(false)
const reopenReason = ref('')

const readying = ref(false)

// Promotion to Decision state
const isPromoting = ref(false)
const promoteForm = reactive({ question: '', outcomeSummary: '', outcomeRationale: '' })
const promoting = ref(false)
const promoteError = ref<FetchErrorDetails>()

// New thread modal
const isCreatingThread = ref(false)
const createForm = reactive({ widgetId: props.selectedWidgetId || 'root', firstMessage: '' })
const creatingThread = ref(false)
const createError = ref<FetchErrorDetails>()

const conflict = ref(false)

const visibleReviews = computed(() => {
	if (!scopeToCurrentView.value || !props.currentViewId) return reviews.value
	return reviews.value.filter(r => r.summary.anchor?.viewId === props.currentViewId)
})

const threadItems = computed(() => visibleReviews.value.map(thread => ({
	value: thread.key,
	label: `#${thread.summary.anchor?.widgetId || 'root'}`,
	description: t('reviews.messageCount', thread.summary.messageCount ?? 0),
	status: thread.summary.status ?? 'open',
})))

const messageCount = computed(() => selectedReviewData.value?.resource.messages?.length ?? 0)
const reanchorTarget = computed(() => props.selectedWidgetId || 'root')

watch(() => props.selectedWidgetId, (newWidget) => {
	if (newWidget) createForm.widgetId = newWidget
})

/** Review status roles: open is human annotation (Marker), ready waits for a verdict (info), resolved closed (success). */
function statusColor(status: ReviewStatus | undefined): 'success' | 'info' | 'annotation' {
	if (status === 'resolved') return 'success'
	if (status === 'ready-for-review') return 'info'
	return 'annotation'
}

/** Every status badge carries an icon so color is never the only signal. */
function statusIcon(status: ReviewStatus | undefined): string {
	if (status === 'resolved') return 'i-lucide-circle-check'
	if (status === 'ready-for-review') return 'i-lucide-eye'
	return 'i-lucide-circle-dot'
}

function statusLabel(status: ReviewStatus | undefined): string {
	if (status === 'resolved') return t('reviews.status.resolved')
	if (status === 'ready-for-review') return t('reviews.status.readyForReview')
	return t('reviews.status.open')
}

function shorten(value: string, length: number): string {
	return value.length > length ? `${value.slice(0, length)}…` : value
}

/** Shows a stale-revision conflict inline, otherwise an error toast with the server diagnostics. */
function reportMutationError(cause: unknown, fallback: string): FetchErrorDetails | undefined {
	const details = describeFetchError(cause, fallback)
	if (details.statusCode === 409 || details.status === 'conflict') {
		conflict.value = true
		return undefined
	}
	return feedback.error(cause, fallback)
}

async function fetchReviews() {
	loadingList.value = true
	loadError.value = undefined
	try {
		const res = await uiux.listResources<ReviewSummary>(['review'], { limit: 100 })
		reviews.value = res.items
		if (!selectedReviewId.value && visibleReviews.value.length > 0) {
			await selectReview(visibleReviews.value[0]!.key)
		}
		else if (selectedReviewId.value) {
			await loadSelectedReviewDetail()
		}
	}
	catch (err: unknown) {
		loadError.value = describeFetchError(err, t('reviews.errors.loadListFailed'))
	}
	finally {
		loadingList.value = false
	}
}

async function selectReview(id: string) {
	selectedReviewId.value = id
	emit('threadSelected', id)
	conflict.value = false
	await loadSelectedReviewDetail()
}

function onSelectThread(value: unknown) {
	// Ignore deselection (clicking the selected item again) so a thread stays open.
	if (typeof value === 'string' && value && value !== selectedReviewId.value) void selectReview(value)
}

async function loadSelectedReviewDetail() {
	const currentSeq = ++reviewLoadSequence.value
	const id = selectedReviewId.value
	if (!id) {
		selectedReviewData.value = undefined
		return
	}

	loadingDetail.value = true
	try {
		const data = await uiux.readResource<ReviewRead>('review', id)
		if (!data) throw new Error(t('reviews.errors.threadUnavailable'))
		if (reviewLoadSequence.value !== currentSeq) return
		selectedReviewData.value = data
	}
	catch (err: unknown) {
		if (reviewLoadSequence.value !== currentSeq) return
		loadError.value = describeFetchError(err, t('reviews.errors.loadThreadFailed'))
		selectedReviewData.value = undefined
	}
	finally {
		if (reviewLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

async function reloadAfterConflict() {
	await fetchReviews()
	if (!loadError.value) conflict.value = false
}

function highlightAnchor() {
	const widgetId = selectedReviewData.value?.resource.anchor.widgetId
	if (widgetId) {
		emit('highlightWidget', widgetId)
	}
}

async function handleAppendMessage() {
	if (!selectedReviewData.value || !newMessageBody.value.trim() || sendingMessage.value) return
	sendingMessage.value = true
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/messages`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				body: newMessageBody.value.trim(),
			},
		})
		newMessageBody.value = ''
		emit('changed')
		feedback.success(t('reviews.feedback.messagePosted'))
		await fetchReviews()
	}
	catch (err: unknown) {
		reportMutationError(err, t('reviews.errors.postMessageFailed'))
	}
	finally {
		sendingMessage.value = false
	}
}

async function handleReanchor() {
	if (!selectedReviewData.value || !props.currentViewId || !props.selectedWidgetId) return
	const widgetId = props.selectedWidgetId
	reanchoring.value = true
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/reanchor`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				anchor: {
					viewId: props.currentViewId,
					widgetId,
				},
				reason: reanchorReason.value.trim() || undefined,
			},
		})
		reanchorReason.value = ''
		emit('changed')
		feedback.success(t('reviews.feedback.reanchored', { widgetId }))
		await fetchReviews()
	}
	catch (err: unknown) {
		reportMutationError(err, t('reviews.errors.reanchorFailed'))
	}
	finally {
		reanchoring.value = false
	}
}

async function handleSubmitReady() {
	if (!selectedReviewData.value) return
	readying.value = true
	conflict.value = false

	try {
		const targetViewId = selectedReviewData.value.resource.anchor.viewId
		let targetRev = targetViewId === props.currentViewId ? props.currentViewRevision : undefined
		if (!targetRev) {
			try {
				const targetView = await $fetch<{ revision: string }>(`/api/resources/view/${encodeURIComponent(targetViewId)}`)
				targetRev = targetView.revision
			}
			catch (cause: unknown) {
				feedback.error(cause, t('reviews.errors.targetViewUnresolved', { viewId: targetViewId }))
				return
			}
		}

		const evidence = await $fetch<{ items: FormalEvidenceItem[] }>('/api/evidence/list')
		const evidenceRefs = [...new Set(
			evidence.items
				.filter(item => isCompleteEvidenceForViewRevision(item.record, targetViewId, targetRev))
				.map(item => item.digest),
		)].map(digest => ({ kind: 'formal_capture', evidence: digest }))

		if (evidenceRefs.length === 0) {
			feedback.error(undefined, t('reviews.errors.noCurrentEvidence'))
			return
		}

		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/ready`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				changeDomains: ['views'],
				resources: [{ identity: { kind: 'view', key: targetViewId }, revision: targetRev }],
				evidenceRefs,
			},
		})
		emit('changed')
		feedback.success(t('reviews.feedback.markedReady', evidenceRefs.length))
		await fetchReviews()
	}
	catch (err: unknown) {
		reportMutationError(err, t('reviews.errors.readyFailed'))
	}
	finally {
		readying.value = false
	}
}

async function handleResolve() {
	if (!selectedReviewData.value) return
	resolving.value = true
	conflict.value = false

	try {
		const latestSub = selectedReviewData.value.resource.submissions[selectedReviewData.value.resource.submissions.length - 1]
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/resolve`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				// Accept & resolve from ready-for-review: the evidence-gated `verified` resolution.
				resolution: 'verified',
				...(latestSub?.id ? { submissionId: latestSub.id } : {}),
				reason: resolveReason.value.trim() || undefined,
			},
		})
		resolveReason.value = ''
		emit('changed')
		feedback.success(t('reviews.feedback.resolved'))
		await fetchReviews()
	}
	catch (err: unknown) {
		reportMutationError(err, t('reviews.errors.resolveFailed'))
	}
	finally {
		resolving.value = false
	}
}

async function handleReopen() {
	if (!selectedReviewData.value) return
	reopening.value = true
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/reopen`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				reason: reopenReason.value.trim() || undefined,
			},
		})
		reopenReason.value = ''
		emit('changed')
		feedback.success(t('reviews.feedback.reopened'))
		await fetchReviews()
	}
	catch (err: unknown) {
		reportMutationError(err, t('reviews.errors.reopenFailed'))
	}
	finally {
		reopening.value = false
	}
}

function validatePromoteForm(state: Partial<typeof promoteForm>): FormError[] {
	return state.question?.trim() ? [] : [{ name: 'question', message: t('reviews.promote.questionRequired') }]
}

function openPromoteModal() {
	promoteError.value = undefined
	isPromoting.value = true
}

async function handlePromoteToDecision() {
	if (!selectedReviewData.value || !promoteForm.question.trim() || promoting.value) return
	promoteError.value = undefined

	// Fetch current target view revision if not provided or different view
	let targetViewRev = props.currentViewRevision
	const targetViewId = selectedReviewData.value.resource.anchor.viewId
	if (!targetViewRev || targetViewId !== props.currentViewId) {
		try {
			const viewRead = await $fetch<{ revision: string }>(`/api/resources/view/${encodeURIComponent(targetViewId)}`)
			targetViewRev = viewRead.revision
		}
		catch (cause: unknown) {
			promoteError.value = feedback.error(cause, t('reviews.errors.targetViewUnresolved', { viewId: targetViewId }))
			return
		}
	}

	promoting.value = true
	conflict.value = false

	try {
		const res = await $fetch<{ status: string; revision: string; viewRevision?: string }>(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/promote`, {
			method: 'POST',
			body: {
				expectedReviewRevision: selectedReviewData.value.revision,
				viewId: targetViewId,
				expectedViewRevision: targetViewRev,
				question: promoteForm.question.trim(),
				outcome: {
					summary: promoteForm.outcomeSummary.trim() || DEFAULT_OUTCOME_SUMMARY,
					rationale: promoteForm.outcomeRationale.trim() || DEFAULT_OUTCOME_RATIONALE,
				},
			},
		})
		isPromoting.value = false
		emit('changed')
		feedback.success(
			t('reviews.feedback.promoted'),
			res.viewRevision ? t('reviews.feedback.promotedViewRevision', { revision: shorten(res.viewRevision, 12) }) : undefined,
		)
		await fetchReviews()
		emit('viewPromoted')
	}
	catch (err: unknown) {
		const details = reportMutationError(err, t('reviews.errors.promoteFailed'))
		if (details) promoteError.value = details
		else isPromoting.value = false
	}
	finally {
		promoting.value = false
	}
}

async function handleCreateReviewThread(targetWidgetIdOverride?: string) {
	if (props.readOnly) return
	createError.value = undefined
	if (!props.currentViewId) {
		createError.value = feedback.error(undefined, t('reviews.errors.noViewSelected'))
		return
	}
	const targetWidget = targetWidgetIdOverride || createForm.widgetId.trim() || 'root'
	creatingThread.value = true

	try {
		const res = await $fetch<{ status: string; key: string; revision: string }>('/api/reviews', {
			method: 'POST',
			body: {
				anchor: {
					viewId: props.currentViewId,
					widgetId: targetWidget,
				},
			},
		})
		emit('changed')

		if (createForm.firstMessage.trim() && res.key && res.revision) {
			try {
				await $fetch(`/api/reviews/${encodeURIComponent(res.key)}/messages`, {
					method: 'POST',
					body: {
						expectedRevision: res.revision,
						body: createForm.firstMessage.trim(),
					},
				})
				emit('changed')
			}
			catch (cause: unknown) {
				// The thread exists; report the lost initial message instead of swallowing it.
				feedback.error(cause, t('reviews.errors.initialMessageFailed'))
			}
		}

		isCreatingThread.value = false
		createForm.firstMessage = ''
		feedback.success(t('reviews.feedback.threadCreated', { widgetId: targetWidget }))
		await fetchReviews()
		if (res.key) await selectReview(res.key)
	}
	catch (err: unknown) {
		createError.value = feedback.error(err, t('reviews.errors.createFailed'))
	}
	finally {
		creatingThread.value = false
	}
}

function openCreateModal(widgetId?: string) {
	if (props.readOnly) return
	createForm.widgetId = widgetId || props.selectedWidgetId || 'root'
	createError.value = undefined
	isCreatingThread.value = true
}

function pickWidgetInPreview() {
	// Close the modal so the preview can be clicked; the shell reopens it via openCreateModal(widgetId).
	isCreatingThread.value = false
	if (!props.isCommentMode) emit('toggleCommentMode')
}

defineExpose({
	openCreateModal,
	selectReview: (id: string) => id === selectedReviewId.value ? Promise.resolve() : selectReview(id),
	createThreadForWidget: (widgetId: string) => handleCreateReviewThread(widgetId),
})

onMounted(() => {
	fetchReviews()
})

watch(() => props.currentViewId, () => {
	fetchReviews()
})
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col overflow-hidden text-xs text-default">
    <!-- Header -->
    <div class="flex flex-wrap items-start justify-between gap-2 border-b border-default p-3">
      <div class="min-w-0">
        <h2 class="text-sm font-semibold text-highlighted">
          {{ t('reviews.title') }}
        </h2>
        <p class="text-xs text-muted">
          {{ t('reviews.subtitle') }}
        </p>
      </div>

      <div
        v-if="!readOnly"
        class="flex items-center gap-1.5"
      >
        <UTooltip
          v-if="!hideCommentMode"
          :text="t('reviews.commentMode.tooltip')"
        >
          <UButton
            :color="isCommentMode ? 'annotation' : 'neutral'"
            :variant="isCommentMode ? 'solid' : 'outline'"
            :icon="isCommentMode ? 'i-lucide-crosshair' : 'i-lucide-message-square-plus'"
            :aria-pressed="isCommentMode"
            :disabled="!currentViewId"
            size="xs"
            @click="emit('toggleCommentMode')"
          >
            {{ isCommentMode ? t('reviews.commentMode.active') : t('reviews.commentMode.start') }}
          </UButton>
        </UTooltip>
        <UButton
          v-if="currentViewId"
          color="primary"
          variant="solid"
          size="xs"
          icon="i-lucide-plus"
          @click="openCreateModal()"
        >
          {{ t('reviews.newThread') }}
        </UButton>
      </div>
    </div>

    <!-- Filter Bar: Current View vs All -->
    <div class="flex items-center justify-between gap-2 border-b border-default bg-muted px-3 py-1.5">
      <USwitch
        v-if="currentViewId"
        v-model="scopeToCurrentView"
        size="xs"
        :label="t('reviews.scopeToCurrentView')"
      />
      <UBadge
        color="neutral"
        variant="subtle"
        size="sm"
      >
        {{ t('reviews.threadCount', visibleReviews.length) }}
      </UBadge>
    </div>

    <!-- Load failure -->
    <div
      v-if="loadError"
      class="border-b border-default p-2"
    >
      <UAlert
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="loadError.message"
        :actions="[{ label: t('common.retry'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', loading: loadingList, onClick: () => { void fetchReviews() } }]"
      >
        <template
          v-if="loadError.diagnostics.length"
          #description
        >
          <ul class="list-disc space-y-0.5 ps-4">
            <li
              v-for="(diagnostic, dIdx) in loadError.diagnostics"
              :key="dIdx"
            >
              {{ diagnostic.message }}
            </li>
          </ul>
        </template>
      </UAlert>
    </div>

    <!-- Review Threads List -->
    <div class="border-b border-default p-2">
      <UListbox
        v-if="threadItems.length"
        :model-value="selectedReviewId || undefined"
        :items="threadItems"
        value-key="value"
        selection-behavior="replace"
        size="sm"
        :aria-label="t('reviews.threadListLabel')"
        :ui="{
          root: 'ring-0',
          content: 'max-h-44',
          group: 'p-0 space-y-0.5',
          item: 'rounded-md data-[state=checked]:bg-selection-subtle data-[state=checked]:text-selection',
          itemLabel: 'font-mono',
          itemDescription: 'text-xs',
          itemTrailingIcon: 'hidden',
        }"
        @update:model-value="onSelectThread"
      >
        <template #item-trailing="{ item }">
          <UBadge
            :color="statusColor(item.status)"
            :icon="statusIcon(item.status)"
            variant="subtle"
            size="sm"
          >
            {{ statusLabel(item.status) }}
          </UBadge>
        </template>
      </UListbox>
      <UEmpty
        v-else-if="!loadingList && !loadError"
        size="xs"
        variant="naked"
        icon="i-lucide-messages-square"
        :title="scopeToCurrentView && currentViewId ? t('reviews.empty.noThreadsInView') : t('reviews.empty.noThreadsInWorkspace')"
      />
      <div
        v-else-if="loadingList"
        class="flex items-center justify-center gap-1.5 py-3 text-muted"
      >
        <UIcon
          name="i-lucide-loader-circle"
          class="size-4 animate-spin"
        />
        {{ t('common.loading') }}
      </div>
    </div>

    <!-- Active Review Thread Detail -->
    <div
      v-if="selectedReviewData"
      class="min-h-0 flex-1 space-y-4 overflow-y-auto p-3"
    >
      <!-- Thread Anchor & Status Header -->
      <UCard
        variant="subtle"
        :ui="{ body: 'space-y-2 p-3 sm:p-3' }"
      >
        <div class="flex items-center justify-between gap-2">
          <div class="flex min-w-0 items-center gap-2">
            <span class="truncate font-mono font-medium text-highlighted">#{{ selectedReviewData.resource.anchor.widgetId }}</span>
            <UBadge
              :color="statusColor(selectedReviewData.resource.status)"
              :icon="statusIcon(selectedReviewData.resource.status)"
              variant="subtle"
              size="sm"
            >
              {{ statusLabel(selectedReviewData.resource.status) }}
            </UBadge>
          </div>
          <UButton
            v-if="showOpenInCanvas"
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-app-window"
            @click="emit('openInCanvas', { threadId: selectedReviewData.key, viewId: selectedReviewData.resource.anchor.viewId, widgetId: selectedReviewData.resource.anchor.widgetId })"
          >
            {{ t('inbox.openInCanvas') }}
          </UButton>
          <UTooltip
            v-else
            :text="t('reviews.highlightTooltip')"
          >
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              icon="i-lucide-scan-search"
              @click="highlightAnchor"
            >
              {{ t('reviews.highlight') }}
            </UButton>
          </UTooltip>
        </div>

        <!-- Key/value metadata: a compact definition list, no Nuxt UI component fits. -->
        <dl class="flex items-center justify-between gap-2 text-xs text-muted">
          <div class="flex min-w-0 gap-1">
            <dt>{{ t('reviews.viewLabel') }}</dt>
            <dd
              class="truncate font-mono"
              :title="selectedReviewData.resource.anchor.viewId"
            >
              {{ shorten(selectedReviewData.resource.anchor.viewId, 14) }}
            </dd>
          </div>
          <div class="flex shrink-0 gap-1 text-xs text-dimmed">
            <dt>{{ t('common.revision') }}</dt>
            <dd
              class="font-mono"
              :title="selectedReviewData.revision"
            >
              {{ shorten(selectedReviewData.revision, 10) }}
            </dd>
          </div>
        </dl>
      </UCard>

      <!-- Stale revision conflict -->
      <UAlert
        v-if="conflict"
        color="error"
        variant="subtle"
        icon="i-lucide-git-compare-arrows"
        :title="t('reviews.conflict.title')"
        :description="t('reviews.conflict.description')"
        :actions="[{ label: t('common.reload'), color: 'error', variant: 'outline', size: 'xs', icon: 'i-lucide-refresh-cw', loading: loadingList || loadingDetail, onClick: () => { void reloadAfterConflict() } }]"
      />

      <!-- Messages Thread Stream -->
      <section class="space-y-2">
        <h3 class="font-semibold text-highlighted">
          {{ t('reviews.conversation') }}
          <span class="font-normal text-muted">· {{ t('reviews.messageCount', messageCount) }}</span>
        </h3>
        <div
          v-if="messageCount"
          class="space-y-2"
        >
          <UCard
            v-for="(msg, mIdx) in selectedReviewData.resource.messages"
            :key="mIdx"
            variant="outline"
            :ui="{ body: 'space-y-1 p-2.5 sm:p-2.5' }"
          >
            <div class="flex items-center justify-between gap-2 text-xs">
              <span class="truncate font-medium text-toned">{{ msg.actor?.displayName || msg.actor?.type || t('reviews.unknownAuthor') }}</span>
              <time
                v-if="msg.at"
                class="shrink-0 text-dimmed"
                :datetime="msg.at"
                :title="fmt.dateTime(msg.at, { dateStyle: 'full', timeStyle: 'long' })"
              >{{ fmt.dateTime(msg.at) }}</time>
            </div>
            <p class="whitespace-pre-wrap text-xs leading-relaxed text-default">
              {{ msg.body }}
            </p>
          </UCard>
        </div>
        <UEmpty
          v-else
          size="xs"
          variant="naked"
          icon="i-lucide-message-circle"
          :title="t('reviews.empty.noMessages')"
        />
      </section>

      <!-- Post New Message Form -->
      <UCard
        v-if="!readOnly"
        variant="subtle"
        :ui="{ body: 'space-y-2 p-2.5 sm:p-2.5' }"
      >
        <form
          class="space-y-2"
          @submit.prevent="handleAppendMessage"
        >
          <UFormField
            :label="t('reviews.reply.messageLabel')"
            size="xs"
          >
            <UTextarea
              v-model="newMessageBody"
              :rows="2"
              autoresize
              :maxrows="8"
              size="sm"
              class="w-full"
              :placeholder="t('reviews.reply.messagePlaceholder')"
              @keydown.enter.ctrl.prevent="handleAppendMessage"
              @keydown.enter.meta.prevent="handleAppendMessage"
            />
          </UFormField>

          <div class="flex items-center justify-between gap-2">
            <span class="flex items-center gap-1 text-xs text-dimmed">
              <UKbd
                value="meta"
                size="sm"
              />
              <UKbd
                value="enter"
                size="sm"
              />
              {{ t('reviews.reply.shortcutHint') }}
            </span>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              size="xs"
              icon="i-lucide-send"
              :loading="sendingMessage"
              :disabled="!newMessageBody.trim()"
            >
              {{ t('reviews.reply.send') }}
            </UButton>
          </div>
        </form>
      </UCard>

      <!-- Lifecycle Actions -->
      <UCard
        v-if="!readOnly"
        variant="outline"
        :ui="{ header: 'px-3 py-2 sm:px-3', body: 'space-y-3 p-3 sm:p-3' }"
      >
        <template #header>
          <h3 class="text-xs font-semibold text-muted">
            {{ t('reviews.lifecycle.title') }}
          </h3>
        </template>

        <!-- Re-anchor -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="font-medium text-toned">
              {{ t('reviews.lifecycle.reanchorTitle') }}
            </p>
            <p class="text-xs text-dimmed">
              {{ selectedWidgetId && currentViewId ? t('reviews.lifecycle.reanchorDescription', { widgetId: reanchorTarget }) : t('reviews.lifecycle.reanchorNeedsWidget') }}
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-anchor"
            :loading="reanchoring"
            :disabled="!selectedWidgetId || !currentViewId"
            @click="handleReanchor"
          >
            {{ t('reviews.lifecycle.reanchorAction', { widgetId: reanchorTarget }) }}
          </UButton>
        </div>

        <USeparator />

        <!-- Status Transitions -->
        <div class="flex flex-wrap gap-2">
          <UButton
            v-if="selectedReviewData.resource.status === 'open'"
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-send-horizontal"
            :loading="readying"
            @click="handleSubmitReady"
          >
            {{ t('reviews.lifecycle.markReady') }}
          </UButton>

          <UButton
            v-if="selectedReviewData.resource.status === 'ready-for-review'"
            color="primary"
            variant="solid"
            size="xs"
            icon="i-lucide-check"
            :loading="resolving"
            @click="handleResolve"
          >
            {{ t('reviews.lifecycle.resolve') }}
          </UButton>

          <UButton
            v-if="selectedReviewData.resource.status === 'resolved' || selectedReviewData.resource.status === 'ready-for-review'"
            color="neutral"
            variant="outline"
            size="xs"
            icon="i-lucide-rotate-ccw"
            :loading="reopening"
            @click="handleReopen"
          >
            {{ selectedReviewData.resource.status === 'ready-for-review' ? t('reviews.lifecycle.requestChanges') : t('reviews.lifecycle.reopen') }}
          </UButton>
        </div>

        <USeparator />

        <!-- Promote to Decision -->
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0">
            <p class="font-medium text-highlighted">
              {{ t('reviews.promote.title') }}
            </p>
            <p class="text-xs text-dimmed">
              {{ t('reviews.promote.description') }}
            </p>
          </div>
          <UButton
            color="primary"
            variant="outline"
            size="xs"
            icon="i-lucide-gavel"
            @click="openPromoteModal"
          >
            {{ t('reviews.promote.open') }}
          </UButton>
        </div>
      </UCard>
    </div>

    <!-- Detail loading -->
    <div
      v-else-if="loadingDetail"
      class="flex flex-1 items-center justify-center gap-1.5 p-6 text-muted"
    >
      <UIcon
        name="i-lucide-loader-circle"
        class="size-4 animate-spin"
      />
      {{ t('common.loading') }}
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList"
      class="flex flex-1 items-center justify-center p-4"
    >
      <UEmpty
        size="sm"
        variant="naked"
        icon="i-lucide-message-square-text"
        :title="t('reviews.empty.noSelectionTitle')"
        :description="readOnly ? t('reviews.empty.noSelectionReadOnly') : t('reviews.empty.noSelection')"
      />
    </div>

    <!-- New Thread Modal -->
    <UModal
      v-if="!readOnly"
      v-model:open="isCreatingThread"
      :title="t('reviews.create.title')"
      :description="t('reviews.create.description')"
    >
      <template #body>
        <UForm
          :state="createForm"
          class="space-y-4"
          @submit="handleCreateReviewThread()"
        >
          <UAlert
            v-if="createError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="createError.message"
          >
            <template
              v-if="createError.diagnostics.length"
              #description
            >
              <ul class="list-disc space-y-0.5 ps-4">
                <li
                  v-for="(diagnostic, dIdx) in createError.diagnostics"
                  :key="dIdx"
                >
                  {{ diagnostic.message }}
                </li>
              </ul>
            </template>
          </UAlert>

          <UFormField
            name="widgetId"
            :label="t('reviews.create.widgetLabel')"
            :help="t('reviews.create.widgetHelp')"
          >
            <div class="flex gap-2">
              <UInput
                v-model="createForm.widgetId"
                class="flex-1"
                :ui="{ base: 'font-mono' }"
                :placeholder="t('reviews.create.widgetPlaceholder')"
              />
              <UButton
                color="neutral"
                variant="outline"
                icon="i-lucide-crosshair"
                @click="pickWidgetInPreview"
              >
                {{ t('reviews.create.pick') }}
              </UButton>
            </div>
          </UFormField>

          <UFormField
            name="firstMessage"
            :label="t('reviews.create.messageLabel')"
            :hint="t('reviews.optional')"
          >
            <UTextarea
              v-model="createForm.firstMessage"
              :rows="3"
              autoresize
              class="w-full"
              :placeholder="t('reviews.create.messagePlaceholder')"
            />
          </UFormField>

          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="isCreatingThread = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              icon="i-lucide-plus"
              :loading="creatingThread"
              :disabled="!currentViewId"
            >
              {{ t('reviews.create.submit') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>

    <!-- Promote to Decision Modal -->
    <UModal
      v-if="!readOnly && selectedReviewData"
      v-model:open="isPromoting"
      :title="t('reviews.promote.title')"
      :description="t('reviews.promote.description')"
    >
      <template #body>
        <UForm
          :state="promoteForm"
          :validate="validatePromoteForm"
          class="space-y-4"
          @submit="handlePromoteToDecision"
        >
          <UAlert
            v-if="promoteError"
            color="error"
            variant="subtle"
            icon="i-lucide-circle-alert"
            :title="promoteError.message"
          >
            <template
              v-if="promoteError.diagnostics.length"
              #description
            >
              <ul class="list-disc space-y-0.5 ps-4">
                <li
                  v-for="(diagnostic, dIdx) in promoteError.diagnostics"
                  :key="dIdx"
                >
                  {{ diagnostic.message }}
                </li>
              </ul>
            </template>
          </UAlert>

          <UFormField
            name="question"
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
            name="outcomeSummary"
            :label="t('reviews.promote.summaryLabel')"
            :hint="t('reviews.optional')"
          >
            <UInput
              v-model="promoteForm.outcomeSummary"
              class="w-full"
              :placeholder="t('reviews.promote.summaryPlaceholder')"
            />
          </UFormField>

          <UFormField
            name="outcomeRationale"
            :label="t('reviews.promote.rationaleLabel')"
            :hint="t('reviews.optional')"
          >
            <UTextarea
              v-model="promoteForm.outcomeRationale"
              :rows="3"
              autoresize
              class="w-full"
              :placeholder="t('reviews.promote.rationalePlaceholder')"
            />
          </UFormField>

          <div class="flex justify-end gap-2">
            <UButton
              color="neutral"
              variant="ghost"
              @click="isPromoting = false"
            >
              {{ t('common.cancel') }}
            </UButton>
            <UButton
              type="submit"
              color="primary"
              variant="solid"
              icon="i-lucide-gavel"
              :loading="promoting"
              :disabled="!promoteForm.question.trim()"
            >
              {{ t('reviews.promote.submit') }}
            </UButton>
          </div>
        </UForm>
      </template>
    </UModal>
  </div>
</template>
