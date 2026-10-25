import { ref } from 'vue'
import { useI18n } from '#imports'
import { describeFetchError, isLockedError } from '../utils/fetch-error'
import type { DecisionAction } from '../utils/decisions'
import { useWorkbench } from './useWorkbench'
import { useWorkbenchFeedback } from './useWorkbenchFeedback'

/**
 * Defer, decide and reopen a Decision of the open View (issue #86; Clause
 * 01a17226-fafc-7691-99ff-aa3b20f5836f): `POST /api/views/:id/decisions/:decisionId/<action>`
 * against the revision of the View as shown. A conflict, a lease or an invalid transition is
 * reported and the View is re-read so the list shows what is true now; nothing is retried.
 */
export type DecideForm = Readonly<{ summary: string; rationale: string }>

export function useDecisionActions() {
	const { t } = useI18n()
	const workbench = useWorkbench()
	const feedback = useWorkbenchFeedback()

	/** The Decision whose action is in flight. */
	const busy = ref<string>()

	/** Deferring and reopening need `views.write`; deciding needs the human-only `decisions.decide`. */
	function can(action: DecisionAction): boolean {
		return workbench.canWrite(action === 'decide' ? 'decisions.decide' : 'views.write')
	}

	async function run(action: DecisionAction, decisionId: string, outcome?: DecideForm): Promise<boolean> {
		const view = workbench.selectedView.value
		if (!view || busy.value || !can(action)) return false
		busy.value = decisionId
		try {
			await $fetch(`/api/views/${encodeURIComponent(view.key)}/decisions/${encodeURIComponent(decisionId)}/${action}`, {
				method: 'POST',
				body: {
					expectedRevision: view.revision,
					...(outcome ? { outcome: { summary: outcome.summary.trim(), rationale: outcome.rationale.trim() || outcome.summary.trim() } } : {}),
				},
			})
			feedback.success(t(`decision.feedback.${action}`))
			await workbench.loadSelectedView()
			void workbench.refreshCounts()
			return true
		}
		catch (cause) {
			const details = describeFetchError(cause, t('decision.errors.failed'))
			if (details.statusCode === 409 || details.status === 'conflict') {
				feedback.notice(t('decision.errors.conflict'), t('decision.errors.conflictHint'))
			}
			else if (isLockedError(details)) {
				feedback.notice(t('decision.errors.locked', { name: details.lock?.holder.nickname ?? '' }))
			}
			else {
				feedback.error(cause, t('decision.errors.failed'))
			}
			// The View moved or the transition no longer applies: show it as saved now.
			if (details.statusCode === 409 || details.status === 'conflict' || details.code === 'decision.invalid_transition')
				await workbench.loadSelectedView()
			return false
		}
		finally {
			busy.value = undefined
		}
	}

	return {
		busy,
		can,
		defer: (id: string) => run('defer', id),
		reopen: (id: string) => run('reopen', id),
		decide: (id: string, form: DecideForm) => run('decide', id, form),
	}
}

export type DecisionActions = ReturnType<typeof useDecisionActions>
