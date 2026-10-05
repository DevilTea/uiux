<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useUiuxClient } from '../composables/useUiuxClient'
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

const props = defineProps<{
	readOnly?: boolean
	currentViewId?: string
	selectedWidgetId?: string
	currentViewRevision?: string
	isCommentMode?: boolean
}>()

const uiux = useUiuxClient()

const emit = defineEmits<{
	(e: 'highlightWidget', widgetId: string): void
	(e: 'toggleCommentMode'): void
	(e: 'viewPromoted'): void
}>()

const reviews = ref<readonly ReviewSummary[]>([])
const selectedReviewId = ref<string>('')
const selectedReviewData = ref<ReviewRead>()
const scopeToCurrentView = ref(true)
const loadingList = ref(false)
const loadingDetail = ref(false)
const reviewLoadSequence = ref(0)
const error = ref<string>()

// Action form states
const newMessageBody = ref('')
const authorName = ref('Reviewer')
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
const promoteQuestion = ref('')
const promoteOutcomeSummary = ref('')
const promoteOutcomeRationale = ref('')
const promoting = ref(false)
const promotionResult = ref<{ status: string; revision: string; viewRevision?: string }>()

// New thread modal / inline
const isCreatingThread = ref(false)
const newThreadWidgetId = ref(props.selectedWidgetId || 'root')
const newThreadFirstMessage = ref('')
const creatingThread = ref(false)

const conflict = ref(false)
const actionSuccess = ref<string>()

const visibleReviews = computed(() => {
	if (!scopeToCurrentView.value || !props.currentViewId) return reviews.value
	return reviews.value.filter(r => r.summary.anchor?.viewId === props.currentViewId)
})

watch(() => props.selectedWidgetId, (newWidget) => {
	if (newWidget) newThreadWidgetId.value = newWidget
})

async function fetchReviews() {
	loadingList.value = true
	error.value = undefined
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
		error.value = err instanceof Error ? err.message : 'Failed to fetch reviews'
	}
	finally {
		loadingList.value = false
	}
}

async function selectReview(id: string) {
	selectedReviewId.value = id
	conflict.value = false
	actionSuccess.value = undefined
	promotionResult.value = undefined
	await loadSelectedReviewDetail()
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
		if (!data) throw new Error('Review thread is unavailable.')
		if (reviewLoadSequence.value !== currentSeq) return
		selectedReviewData.value = data
	}
	catch (err: unknown) {
		if (reviewLoadSequence.value !== currentSeq) return
		error.value = err instanceof Error ? err.message : 'Failed to load review thread'
		selectedReviewData.value = undefined
	}
	finally {
		if (reviewLoadSequence.value === currentSeq)
			loadingDetail.value = false
	}
}

function highlightAnchor() {
	const widgetId = selectedReviewData.value?.resource.anchor.widgetId
	if (widgetId) {
		emit('highlightWidget', widgetId)
	}
}

async function handleAppendMessage() {
	if (!selectedReviewData.value || !newMessageBody.value.trim()) return
	sendingMessage.value = true
	error.value = undefined
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/messages`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
				body: newMessageBody.value.trim(),
			},
		})
		newMessageBody.value = ''
		actionSuccess.value = 'Message posted.'
		await fetchReviews()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to post message')
	}
	finally {
		sendingMessage.value = false
	}
}

async function handleReanchor() {
	if (!selectedReviewData.value || !props.currentViewId || !props.selectedWidgetId) return
	reanchoring.value = true
	error.value = undefined
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/reanchor`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				anchor: {
					viewId: props.currentViewId,
					widgetId: props.selectedWidgetId,
				},
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
				reason: reanchorReason.value.trim() || undefined,
			},
		})
		reanchorReason.value = ''
		actionSuccess.value = `Thread reanchored to #${props.selectedWidgetId}.`
		await fetchReviews()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to reanchor')
	}
	finally {
		reanchoring.value = false
	}
}

async function handleSubmitReady() {
	if (!selectedReviewData.value) return
	readying.value = true
	error.value = undefined
	conflict.value = false

	try {
		const targetViewId = selectedReviewData.value.resource.anchor.viewId
		let targetRev = targetViewId === props.currentViewId ? props.currentViewRevision : undefined
		if (!targetRev) {
			try {
				const targetView = await $fetch<{ revision: string }>(`/api/resources/view/${encodeURIComponent(targetViewId)}`)
				targetRev = targetView.revision
			}
			catch {
				error.value = `Target View ${targetViewId} could not be resolved to a current canonical revision.`
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
			error.value = 'No complete Formal Evidence matches the current target View revision. Capture current evidence before marking this Review ready.'
			return
		}

		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/ready`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
				changeDomains: ['views'],
				resources: [{ identity: { kind: 'view', key: targetViewId }, revision: targetRev }],
				evidenceRefs,
			},
		})
		actionSuccess.value = `Review marked as ready with ${evidenceRefs.length} current Formal Evidence record${evidenceRefs.length === 1 ? '' : 's'}.`
		await fetchReviews()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to mark ready')
	}
	finally {
		readying.value = false
	}
}

async function handleResolve() {
	if (!selectedReviewData.value) return
	resolving.value = true
	error.value = undefined
	conflict.value = false

	try {
		const latestSub = selectedReviewData.value.resource.submissions[selectedReviewData.value.resource.submissions.length - 1]
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/resolve`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
				...(latestSub?.id ? { submissionId: latestSub.id } : {}),
				reason: resolveReason.value.trim() || undefined,
			},
		})
		resolveReason.value = ''
		actionSuccess.value = 'Review thread resolved.'
		await fetchReviews()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to resolve review')
	}
	finally {
		resolving.value = false
	}
}

async function handleReopen() {
	if (!selectedReviewData.value) return
	reopening.value = true
	error.value = undefined
	conflict.value = false

	try {
		await $fetch(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/reopen`, {
			method: 'POST',
			body: {
				expectedRevision: selectedReviewData.value.revision,
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
				reason: reopenReason.value.trim() || undefined,
			},
		})
		reopenReason.value = ''
		actionSuccess.value = 'Review thread reopened.'
		await fetchReviews()
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to reopen review')
	}
	finally {
		reopening.value = false
	}
}

async function handlePromoteToDecision() {
	if (!selectedReviewData.value || !promoteQuestion.value.trim()) return

	// Fetch current target view revision if not provided or different view
	let targetViewRev = props.currentViewRevision
	const targetViewId = selectedReviewData.value.resource.anchor.viewId
	if (!targetViewRev || targetViewId !== props.currentViewId) {
		try {
			const viewRead = await $fetch<{ revision: string }>(`/api/resources/view/${encodeURIComponent(targetViewId)}`)
			targetViewRev = viewRead.revision
		}
		catch {
			error.value = `Target view ${targetViewId} could not be resolved.`
			return
		}
	}

	promoting.value = true
	error.value = undefined
	conflict.value = false

	try {
		const res = await $fetch<{ status: string; revision: string; viewRevision?: string }>(`/api/reviews/${encodeURIComponent(selectedReviewData.value.key)}/promote`, {
			method: 'POST',
			body: {
				expectedReviewRevision: selectedReviewData.value.revision,
				viewId: targetViewId,
				expectedViewRevision: targetViewRev,
				question: promoteQuestion.value.trim(),
				outcome: {
					summary: promoteOutcomeSummary.value.trim() || 'Decision accepted.',
					rationale: promoteOutcomeRationale.value.trim() || 'Consensus reached in review thread.',
				},
				actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
			},
		})
		promotionResult.value = res
		isPromoting.value = false
		actionSuccess.value = 'Promoted to Decision atomically!'
		await fetchReviews()
		emit('viewPromoted')
	}
	catch (err: unknown) {
		const errorObj = err as { status?: number; statusCode?: number; data?: { message?: string } }
		if (errorObj?.status === 409 || errorObj?.statusCode === 409) conflict.value = true
		else error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Promotion failed')
	}
	finally {
		promoting.value = false
	}
}

async function handleCreateReviewThread(targetWidgetIdOverride?: string) {
	if (props.readOnly) return
	if (!props.currentViewId) {
		error.value = 'No view selected to anchor review thread.'
		return
	}
	const targetWidget = targetWidgetIdOverride || newThreadWidgetId.value || 'root'
	creatingThread.value = true
	error.value = undefined

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

		if (newThreadFirstMessage.value.trim() && res.key && res.revision) {
			await $fetch(`/api/reviews/${encodeURIComponent(res.key)}/messages`, {
				method: 'POST',
				body: {
					expectedRevision: res.revision,
					actor: { type: 'human', displayName: authorName.value.trim() || 'Reviewer' },
					body: newThreadFirstMessage.value.trim(),
				},
			}).catch(() => undefined)
		}

		isCreatingThread.value = false
		newThreadFirstMessage.value = ''
		await fetchReviews()
		if (res.key) await selectReview(res.key)
	}
	catch (err: unknown) {
		const errorObj = err as { data?: { message?: string } }
		error.value = errorObj?.data?.message || (err instanceof Error ? err.message : 'Failed to create thread')
	}
	finally {
		creatingThread.value = false
	}
}

function openCreateModal(widgetId?: string) {
	if (props.readOnly) return
	newThreadWidgetId.value = widgetId || props.selectedWidgetId || 'root'
	isCreatingThread.value = true
}

defineExpose({
	openCreateModal,
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
  <div class="flex h-full flex-col overflow-hidden text-xs text-neutral-200">
    <!-- Header -->
    <div class="flex items-center justify-between border-b border-neutral-800 p-3">
      <div>
        <h2 class="text-sm font-semibold text-white">
          Reviews & Comments
        </h2>
        <p class="text-[11px] text-neutral-400">
          Threaded feedback with atomic Decision promotion
        </p>
      </div>

      <div
        v-if="!readOnly"
        class="flex items-center gap-1.5"
      >
        <UButton
          :color="isCommentMode ? 'warning' : 'neutral'"
          :variant="isCommentMode ? 'solid' : 'outline'"
          size="xs"
          title="Toggle click-to-comment mode in preview"
          @click="emit('toggleCommentMode')"
        >
          {{ isCommentMode ? 'Targeting Active' : '🎯 Comment' }}
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          @click="isCreatingThread = !isCreatingThread"
        >
          + Thread
        </UButton>
      </div>
    </div>

    <!-- Filter Bar: Current View vs All -->
    <div class="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3 py-1.5 text-[11px]">
      <div class="flex items-center gap-2">
        <label class="flex items-center gap-1.5 cursor-pointer text-neutral-300">
          <input
            v-model="scopeToCurrentView"
            type="checkbox"
            class="rounded border-neutral-700 bg-neutral-900 text-primary"
          >
          <span>Scope to current View</span>
        </label>
      </div>
      <span class="text-neutral-500 font-mono">{{ visibleReviews.length }} threads</span>
    </div>

    <!-- New Thread Inline Form -->
    <div
      v-if="isCreatingThread && !readOnly"
      class="border-b border-neutral-800 bg-neutral-900/90 p-3 space-y-2.5"
    >
      <div class="flex items-center justify-between">
        <span class="font-semibold text-white">New Review Thread</span>
        <button
          type="button"
          class="text-neutral-500 hover:text-neutral-300"
          @click="isCreatingThread = false"
        >
          ✕
        </button>
      </div>

      <div class="space-y-1.5">
        <div>
          <span class="text-[10px] text-neutral-400">Target Widget Anchor:</span>
          <div class="flex gap-2">
            <UInput
              v-model="newThreadWidgetId"
              size="xs"
              placeholder="root or widgetId"
              class="flex-1 font-mono mt-0.5"
            />
            <UButton
              color="neutral"
              variant="outline"
              size="xs"
              title="Pick in preview"
              @click="emit('toggleCommentMode')"
            >
              🎯 Pick
            </UButton>
          </div>
        </div>

        <div>
          <span class="text-[10px] text-neutral-400">Initial Message (Optional):</span>
          <textarea
            v-model="newThreadFirstMessage"
            rows="2"
            class="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-200 outline-none"
            placeholder="Feedback or question for discussion…"
          />
        </div>
      </div>

      <div class="flex justify-end gap-2 pt-1">
        <UButton
          color="neutral"
          variant="ghost"
          size="xs"
          @click="isCreatingThread = false"
        >
          Cancel
        </UButton>
        <UButton
          color="primary"
          variant="solid"
          size="xs"
          :loading="creatingThread"
          @click="handleCreateReviewThread()"
        >
          Create Thread
        </UButton>
      </div>
    </div>

    <!-- Review Threads List -->
    <div class="max-h-44 overflow-y-auto border-b border-neutral-800 p-2">
      <div
        v-if="visibleReviews.length"
        class="space-y-1"
      >
        <button
          v-for="thread in visibleReviews"
          :key="thread.key"
          type="button"
          class="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs transition"
          :class="selectedReviewId === thread.key ? 'bg-primary/20 text-white font-medium' : 'text-neutral-300 hover:bg-neutral-800/60'"
          @click="selectReview(thread.key)"
        >
          <div class="truncate">
            <span class="font-mono text-neutral-400">#{{ thread.summary.anchor?.widgetId || 'root' }}</span>
            <span class="ml-2 font-mono text-[10px] text-neutral-500">({{ thread.summary.messageCount || 0 }} msgs)</span>
          </div>
          <UBadge
            :color="thread.summary.status === 'resolved' ? 'success' : thread.summary.status === 'ready-for-review' ? 'info' : 'neutral'"
            variant="soft"
            size="xs"
          >
            {{ thread.summary.status || 'open' }}
          </UBadge>
        </button>
      </div>
      <div
        v-else-if="!loadingList"
        class="py-4 text-center text-xs text-neutral-500"
      >
        {{ scopeToCurrentView ? 'No review threads on this View.' : 'No review threads in Workspace.' }}
      </div>
    </div>

    <!-- Active Review Thread Detail -->
    <div
      v-if="selectedReviewData"
      class="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-4"
    >
      <!-- Thread Anchor & Status Header -->
      <div class="rounded border border-neutral-800 bg-neutral-900/70 p-3 space-y-2">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2">
            <span class="font-mono font-medium text-white">#{{ selectedReviewData.resource.anchor.widgetId }}</span>
            <UBadge
              :color="selectedReviewData.resource.status === 'resolved' ? 'success' : selectedReviewData.resource.status === 'ready-for-review' ? 'info' : 'neutral'"
              variant="soft"
              size="xs"
            >
              {{ selectedReviewData.resource.status }}
            </UBadge>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            title="Highlight target widget in preview"
            @click="highlightAnchor"
          >
            🔍 Highlight
          </UButton>
        </div>

        <div class="flex items-center justify-between text-[11px] text-neutral-400">
          <span class="truncate">View: {{ selectedReviewData.resource.anchor.viewId.slice(0, 14) }}…</span>
          <span class="font-mono text-[10px] text-neutral-500">Rev: {{ selectedReviewData.revision.slice(0, 10) }}…</span>
        </div>
      </div>

      <!-- Action Feedback / Conflict Banner -->
      <div
        v-if="conflict"
        class="border border-amber-500/30 bg-amber-500/10 p-2.5 text-amber-300 text-[11px] rounded flex items-center justify-between"
      >
        <span>⚠ Stale revision conflict: This review thread was modified concurrently.</span>
        <UButton
          color="warning"
          variant="soft"
          size="xs"
          @click="loadSelectedReviewDetail"
        >
          Reload
        </UButton>
      </div>

      <div
        v-else-if="actionSuccess"
        class="border border-emerald-500/30 bg-emerald-500/10 p-2 text-emerald-300 text-[11px] rounded"
      >
        ✓ {{ actionSuccess }}
      </div>

      <div
        v-else-if="error"
        class="border border-red-500/30 bg-red-500/10 p-2 text-red-300 text-[11px] rounded"
      >
        {{ error }}
      </div>

      <!-- Promotion Result Banner -->
      <div
        v-if="promotionResult"
        class="rounded border border-primary/40 bg-primary/10 p-3 space-y-1 text-primary-200"
      >
        <span class="font-semibold text-white">✓ Promoted to Canonical Decision!</span>
        <p class="text-[11px]">
          Target View updated (viewRevision: {{ promotionResult.viewRevision ? promotionResult.viewRevision.slice(0, 12) + '…' : 'updated' }}).
        </p>
      </div>

      <!-- Messages Thread Stream -->
      <div class="space-y-2">
        <span class="font-semibold text-white">Conversation ({{ selectedReviewData.resource.messages?.length || 0 }})</span>
        <div
          v-if="selectedReviewData.resource.messages?.length"
          class="space-y-2"
        >
          <div
            v-for="(msg, mIdx) in selectedReviewData.resource.messages"
            :key="mIdx"
            class="rounded border border-neutral-800 bg-neutral-900/50 p-2.5 space-y-1"
          >
            <div class="flex items-center justify-between text-[10px]">
              <span class="font-medium text-neutral-300">{{ msg.actor?.displayName || msg.actor?.type || 'User' }}</span>
              <span class="font-mono text-neutral-500">{{ msg.at ? new Date(msg.at).toLocaleTimeString() : '' }}</span>
            </div>
            <p class="text-[11px] text-neutral-200 whitespace-pre-wrap leading-relaxed">
              {{ msg.body }}
            </p>
          </div>
        </div>
        <p
          v-else
          class="text-neutral-500 text-[11px] italic"
        >
          No messages posted yet.
        </p>
      </div>

      <!-- Post New Message Form -->
      <div
        v-if="!readOnly"
        class="rounded border border-neutral-800 bg-neutral-900/60 p-2.5 space-y-2"
      >
        <div class="flex items-center justify-between">
          <span class="text-[10px] font-semibold text-neutral-400">Post Reply</span>
          <div class="flex items-center gap-1 text-[10px]">
            <span class="text-neutral-500">As:</span>
            <UInput
              v-model="authorName"
              size="xs"
              placeholder="Name"
              class="w-24"
            />
          </div>
        </div>

        <textarea
          v-model="newMessageBody"
          rows="2"
          class="w-full rounded border border-neutral-700 bg-neutral-950 p-2 text-xs text-neutral-200 outline-none"
          placeholder="Write feedback message…"
          @keydown.enter.ctrl="handleAppendMessage"
        />

        <div class="flex justify-end">
          <UButton
            color="primary"
            variant="solid"
            size="xs"
            :loading="sendingMessage"
            :disabled="!newMessageBody.trim()"
            @click="handleAppendMessage"
          >
            Send Reply
          </UButton>
        </div>
      </div>

      <!-- Lifecycle Actions Toolbar -->
      <div
        v-if="!readOnly"
        class="rounded border border-neutral-800 bg-neutral-950 p-3 space-y-3"
      >
        <span class="text-[10px] font-semibold uppercase tracking-wider text-neutral-400">Lifecycle Operations</span>

        <!-- Reanchor -->
        <div class="flex items-center justify-between border-b border-neutral-800/80 pb-2">
          <div>
            <p class="font-medium text-neutral-300">
              Reanchor Target
            </p>
            <p class="text-[10px] text-neutral-500">
              Move anchor to currently selected widget ({{ selectedWidgetId || 'root' }})
            </p>
          </div>
          <UButton
            color="neutral"
            variant="outline"
            size="xs"
            :loading="reanchoring"
            @click="handleReanchor"
          >
            Reanchor to #{{ selectedWidgetId || 'root' }}
          </UButton>
        </div>

        <!-- Status Transitions -->
        <div class="flex flex-wrap gap-2 border-b border-neutral-800/80 pb-2">
          <UButton
            v-if="selectedReviewData.resource.status === 'open'"
            color="neutral"
            variant="outline"
            size="xs"
            :loading="readying"
            @click="handleSubmitReady"
          >
            Ready for Review
          </UButton>

          <UButton
            v-if="selectedReviewData.resource.status === 'ready-for-review'"
            color="success"
            variant="soft"
            size="xs"
            :loading="resolving"
            @click="handleResolve"
          >
            Resolve Thread
          </UButton>

          <UButton
            v-if="selectedReviewData.resource.status === 'resolved' || selectedReviewData.resource.status === 'ready-for-review'"
            color="warning"
            variant="soft"
            size="xs"
            :loading="reopening"
            @click="handleReopen"
          >
            {{ selectedReviewData.resource.status === 'ready-for-review' ? 'Reopen (Request Changes)' : 'Reopen Thread' }}
          </UButton>
        </div>

        <!-- Promote to Decision -->
        <div class="space-y-2 pt-1">
          <div class="flex items-center justify-between">
            <div>
              <p class="font-medium text-white">
                Promote to View Decision
              </p>
              <p class="text-[10px] text-neutral-500">
                Atomic CAS promotion recording outcome in View.spec
              </p>
            </div>
            <UButton
              color="primary"
              variant="outline"
              size="xs"
              @click="isPromoting = !isPromoting"
            >
              {{ isPromoting ? 'Cancel' : 'Promote…' }}
            </UButton>
          </div>

          <div
            v-if="isPromoting"
            class="rounded border border-primary/30 bg-primary/5 p-3 space-y-2 mt-2"
          >
            <div>
              <span class="text-[10px] text-neutral-300 font-medium">Decision Question:</span>
              <UInput
                v-model="promoteQuestion"
                size="xs"
                placeholder="e.g. Keep three-column workspace layout?"
                class="mt-0.5"
              />
            </div>
            <div>
              <span class="text-[10px] text-neutral-300 font-medium">Outcome Summary:</span>
              <UInput
                v-model="promoteOutcomeSummary"
                size="xs"
                placeholder="e.g. Approved with collapsible side panels"
                class="mt-0.5"
              />
            </div>
            <div>
              <span class="text-[10px] text-neutral-300 font-medium">Outcome Rationale:</span>
              <textarea
                v-model="promoteOutcomeRationale"
                rows="2"
                class="mt-0.5 w-full rounded border border-neutral-700 bg-neutral-900 p-1.5 text-xs text-neutral-200 outline-none"
                placeholder="Rationale from discussion consensus…"
              />
            </div>

            <div class="flex justify-end pt-1">
              <UButton
                color="primary"
                variant="solid"
                size="xs"
                :loading="promoting"
                :disabled="!promoteQuestion.trim()"
                @click="handlePromoteToDecision"
              >
                Execute Atomic Promotion
              </UButton>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Empty Detail State -->
    <div
      v-else-if="!loadingList"
      class="flex flex-1 items-center justify-center p-6 text-center text-xs text-neutral-500"
    >
      {{ readOnly ? 'Select a published review thread to inspect its history.' : 'Select a review thread or click "🎯 Comment" to add feedback.' }}
    </div>
  </div>
</template>
