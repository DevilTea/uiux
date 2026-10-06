<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from '#imports'
import type { HandoffBlockingDiagnostic } from '../../../src/domain/handoff/schema'
import { useWorkbench } from '../../composables/useWorkbench'
import { handoffDiagnosticSubject } from '../../utils/readiness'
import { viewLocation } from '../../utils/workbench-routes'
import { isWidgetAnchor, isWorkspaceAnchor } from '../../../src/domain/reviews/schema'
import WbErrorDetails from '../workbench/WbErrorDetails.vue'
import { diagnosticText } from '../../utils/diagnostic-copy'

/**
 * One side of a Handoff assessment: the blocking entries, or the advisory ones the server marks
 * `blocking: false` (a declined Review). Each entry reads as a sentence naming its View (and the
 * Widget a Review is anchored to, so several open Reviews stay distinguishable); the diagnostic
 * codes stay one click away in the shared Details disclosure.
 */
const props = defineProps<{
	diagnostics: readonly HandoffBlockingDiagnostic[]
	tone: 'blocking' | 'advisory'
}>()

const { t } = useI18n()
const { views, reviews } = useWorkbench()

const viewNames = computed(() => new Map(views.value.map(view => [view.key, view.summary.name || t('common.unnamed')])))
const reviewAnchors = computed(() => new Map(reviews.value.map(review => [review.key, review.summary.anchor])))

type Row = Readonly<{ key: string; sentence: string; code: string; to?: ReturnType<typeof viewLocation> }>

function viewName(viewId: string | undefined): string {
	return (viewId && viewNames.value.get(viewId)) || t('ready.diag.unknownView')
}

const rows = computed<Row[]>(() => props.diagnostics.map((diagnostic, index) => {
	const subject = handoffDiagnosticSubject(diagnostic)
	const reviewAnchor = subject.reviewId ? reviewAnchors.value.get(subject.reviewId) : undefined
	const anchor = isWidgetAnchor(reviewAnchor) ? reviewAnchor : undefined
	// A Workspace thread is in every closure (O1); it says so, and links to `/reviews?thread=<id>`.
	const workspaceThread = isWorkspaceAnchor(reviewAnchor) || /^Workspace-scoped Review thread/.test(diagnostic.message)
	const viewId = subject.viewId ?? anchor?.viewId
	const view = viewName(viewId)
	let sentence = diagnosticText(diagnostic)
	switch (diagnostic.code) {
		case 'handoff.unresolved_review_thread': {
			const ready = /ready-for-review/.test(diagnostic.message)
			sentence = workspaceThread
				? t(ready ? 'ready.diag.reviewReadyWorkspace' : 'ready.diag.reviewOpenWorkspace')
				: anchor?.widgetId
					? t(ready ? 'ready.diag.reviewReadyAt' : 'ready.diag.reviewOpenAt', { view, widget: anchor.widgetId })
					: t(ready ? 'ready.diag.reviewReady' : 'ready.diag.reviewOpen', { view })
			break
		}
		case 'handoff.review_declined':
			sentence = workspaceThread ? t('ready.diag.reviewDeclinedWorkspace') : t('ready.diag.reviewDeclined', { view })
			break
		case 'handoff.stale_view_evidence':
			sentence = t('ready.diag.evidenceStale', { view })
			break
		case 'handoff.missing_view_evidence':
			sentence = t('ready.diag.evidenceMissing', { view })
			break
		case 'handoff.incomplete_view_evidence':
			sentence = t('ready.diag.evidenceIncomplete', { view })
			break
		case 'handoff.missing_asset':
			sentence = t('ready.diag.assetMissing')
			break
	}
	const to = subject.reviewId && workspaceThread
		? { path: '/reviews', query: { thread: subject.reviewId } }
		: subject.reviewId && anchor
			? viewLocation(anchor.viewId, { widget: anchor.widgetId, thread: subject.reviewId })
			: viewId && viewNames.value.has(viewId) ? viewLocation(viewId, { panel: 'readiness' }) : undefined
	return { key: `${diagnostic.code}:${diagnostic.path ?? ''}:${index}`, sentence, code: diagnostic.code, ...(to ? { to } : {}) }
}))

const details = computed(() => props.diagnostics.map(diagnostic => ({ code: diagnostic.code, ...(diagnostic.path ? { path: diagnostic.path } : {}), message: diagnostic.message })))
</script>

<template>
  <div class="space-y-1">
    <ul
      class="space-y-1"
      :data-handoff-diagnostics="tone"
    >
      <li
        v-for="row in rows"
        :key="row.key"
        class="grid grid-cols-[16px_minmax(0,1fr)] gap-x-2 text-sm"
        :data-diagnostic-code="row.code"
      >
        <UIcon
          :name="tone === 'blocking' ? 'i-lucide-circle-x' : 'i-lucide-info'"
          class="mt-0.5 size-4"
          :class="tone === 'blocking' ? 'text-error' : 'text-muted'"
        />
        <span class="min-w-0">
          <ULink
            v-if="row.to"
            :to="row.to"
            class="text-default hover:text-highlighted hover:underline"
          >{{ row.sentence }}</ULink>
          <span
            v-else
            class="text-default"
          >{{ row.sentence }}</span>
        </span>
      </li>
    </ul>
    <WbErrorDetails
      v-if="details.length"
      :diagnostics="details"
    />
  </div>
</template>
