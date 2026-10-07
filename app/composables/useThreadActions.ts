import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from '#imports'
import type { DropdownMenuItem } from '@nuxt/ui'
import type { ReviewResolution, ReviewStatus, ReviewThread } from '../../src/domain/reviews/schema'
import { copyText } from '../utils/copy-text'
import type { FetchErrorDetails } from '../utils/fetch-error'
import { resolveMenuGroups } from '../utils/resolve-menu'
import { retractEligibility } from '../utils/review-message-actions'
import type { ReviewSubmissionDraft } from '../utils/review-submission'
import { useWorkbenchFeedback } from './useWorkbenchFeedback'

/**
 * The thread lifecycle actions shared by the canvas bubble (`ThreadBubble`) and the Reviews
 * detail (`ReviewThreadDetail`): the Resolve split menu, the reason step for Duplicate and Reopen,
 * Delete comment with its inline confirm, Promote to Decision, Submit for review, and the
 * overflow menu. Each surface keeps its own layout and wires this to its own store (canvas
 * comments or the inbox).
 *
 * What a surface may offer stays its decision, passed in as `can*` getters: viewport-width and
 * role gating (Re-anchor and Promote are not offered at phone widths,
 * `WORKBENCH_BREAKPOINTS.phone`, or in the Reviews phone sheet; Submit only at desktop width) are applied there, never here.
 */
export type PromoteForm = { question: string; summary: string; rationale: string }

export type ThreadActionsOptions = Readonly<{
	/** The thread being acted on, if any. */
	thread: () => Readonly<{ id: string; status: ReviewStatus; title?: string }> | undefined
	detail: () => ReviewThread | undefined
	me: () => string | undefined
	/** Delete comment needs the Reviewer role (the same as replying). */
	canWrite: () => boolean
	canReanchor: () => boolean
	canPromote: () => boolean
	canSubmit: () => boolean
	/** Did the last write to this thread conflict or fail? */
	conflict: () => boolean
	error: () => FetchErrorDetails | undefined
	/** Set when the server refused a delete because someone engaged meanwhile. */
	retractRefused: () => boolean
	clearRetractRefused: () => void
	resolve: (id: string, resolution: ReviewResolution, reason?: string) => Promise<boolean>
	reopen: (id: string, reason: string) => Promise<boolean>
	promote: (id: string, form: Readonly<PromoteForm>) => Promise<boolean>
	submit: (id: string, draft: ReviewSubmissionDraft) => Promise<boolean>
	retract: (id: string) => Promise<boolean>
	reanchor: () => void
	/** The absolute link Copy link puts on the clipboard. */
	threadLink: (id: string) => string
	/** The Re-anchor label differs by surface ("Re-anchor" on the canvas, "Re-anchor on canvas" in Reviews). */
	reanchorLabel: () => string
	/** Extra overflow entries after Promote (the bubble's "Open in Reviews"). */
	extraOverflow?: () => DropdownMenuItem[]
	/** After a successful promotion (the bubble reloads its View so the Decision shows). */
	afterPromote?: () => Promise<void> | void
}>

export function useThreadActions(options: ThreadActionsOptions) {
	const { t } = useI18n()
	const feedback = useWorkbenchFeedback()

	const activeSubmission = computed(() => options.thread()?.status === 'ready-for-review' ? options.detail()?.submissions.at(-1) : undefined)
	/** The one-click Resolve: accept the submission when ready, else Answered. */
	const primaryResolution = computed<ReviewResolution>(() => options.thread()?.status === 'ready-for-review' ? 'verified' : 'answered')

	// -------------------------------------------------------------------------------------------
	// The reason step: Duplicate's reason (required) or Reopen's (optional)
	// -------------------------------------------------------------------------------------------

	const pendingAction = ref<'duplicate' | 'reopen'>()
	const reason = ref('')
	const reasonInput = ref<{ focus: () => void }>()

	function ask(action: 'duplicate' | 'reopen'): void {
		pendingAction.value = action
		reason.value = ''
		void nextTick(() => reasonInput.value?.focus())
	}

	async function resolveAs(resolution: ReviewResolution, why?: string): Promise<boolean> {
		const id = options.thread()?.id
		if (!id) return false
		const ok = await options.resolve(id, resolution, why)
		if (ok) pendingAction.value = undefined
		return ok
	}

	async function confirmPending(): Promise<void> {
		const id = options.thread()?.id
		if (!id) return
		if (pendingAction.value === 'duplicate') {
			if (reason.value.trim()) await resolveAs('duplicate', reason.value)
		}
		else if (pendingAction.value === 'reopen' && await options.reopen(id, reason.value)) pendingAction.value = undefined
	}

	/** Grouped: Resolve (Answered, Verified) and Dismiss (No longer relevant, Duplicate…, Won't do). */
	const resolveMenu = computed<DropdownMenuItem[][]>(() => {
		const current = options.thread()
		if (!current) return []
		return resolveMenuGroups({
			t,
			status: current.status,
			canVerify: !!activeSubmission.value,
			resolve: (resolution) => { void resolveAs(resolution) },
			askDuplicate: () => ask('duplicate'),
		})
	})

	// -------------------------------------------------------------------------------------------
	// Delete comment (retract addendum decision 8): only while eligible, confirmed inline
	// -------------------------------------------------------------------------------------------

	const retract = computed(() => options.canWrite() ? retractEligibility(options.detail(), options.me()) : { eligible: false as const })
	const confirmingDelete = ref(false)
	const retractConfirm = ref<{ focusCancel: () => void }>()
	let deleteAskedFor: string | undefined

	/**
	 * The menu would hand focus back to its trigger as it closes; the delete confirm keeps it on
	 * Cancel. The menu unmounts only after its close animation, which can end after the delete
	 * already went through: by then the surface may show another thread, whose trigger must not
	 * take focus back.
	 */
	function keepConfirmFocus(event: Event): void {
		const askedFor = deleteAskedFor
		deleteAskedFor = undefined
		if (confirmingDelete.value) {
			event.preventDefault()
			void nextTick(() => retractConfirm.value?.focusCancel())
		}
		else if (askedFor && askedFor !== options.thread()?.id) event.preventDefault()
	}

	function askDelete(): void {
		options.clearRetractRefused()
		pendingAction.value = undefined
		deleteAskedFor = options.thread()?.id
		confirmingDelete.value = true
	}

	async function confirmDelete(): Promise<void> {
		const id = options.thread()?.id
		if (!id) return
		await options.retract(id)
		confirmingDelete.value = false
	}
	// Someone engaged meanwhile: the Delete affordance and its confirm go away.
	watch(() => retract.value.eligible, (eligible) => { if (!eligible) confirmingDelete.value = false })

	// -------------------------------------------------------------------------------------------
	// Promote to Decision
	// -------------------------------------------------------------------------------------------

	/** The dialog itself (`ThreadPromoteModal`) owns the form and shows a refusal inside. */
	const promoteOpen = ref(false)

	async function submitPromote(form: Readonly<PromoteForm>): Promise<boolean> {
		const id = options.thread()?.id
		if (!id) return false
		const ok = await options.promote(id, form)
		if (ok) {
			feedback.success(t('reviews.feedback.promoted'))
			await options.afterPromote?.()
		}
		return ok
	}

	// -------------------------------------------------------------------------------------------
	// Submit for review… (human submission; secondary, desktop-first)
	// -------------------------------------------------------------------------------------------

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
		const id = options.thread()?.id
		if (!id) return false
		const ok = await options.submit(id, draft)
		if (ok) feedback.success(t('submit.announce'))
		else {
			submitConflict.value = options.conflict()
			submitError.value = options.error()
		}
		return ok
	}

	// -------------------------------------------------------------------------------------------
	// Overflow: Copy link, Submit for review…, Re-anchor, Promote, (extra), Copy thread ID, Delete
	// -------------------------------------------------------------------------------------------

	async function copy(text: string, title: string): Promise<void> {
		if (await copyText(text)) feedback.success(title)
		else feedback.error(undefined, t('comments.errors.copyFailed'))
	}

	const overflow = computed<DropdownMenuItem[][]>(() => {
		const current = options.thread()
		if (!current) return []
		const groups: DropdownMenuItem[][] = [[
			{ label: t('thread.copyLink'), icon: 'i-lucide-link', onSelect: () => { void copy(options.threadLink(current.id), t('comments.copiedLink')) } },
			...(options.canSubmit() ? [{ label: t('thread.submit'), icon: 'i-lucide-eye', onSelect: () => { submitOpen.value = true } }] : []),
			...(options.canReanchor() ? [{ label: options.reanchorLabel(), icon: 'i-lucide-crosshair', onSelect: options.reanchor }] : []),
			...(options.canPromote() ? [{ label: t('thread.promote'), icon: 'i-lucide-signpost', onSelect: () => { promoteOpen.value = true } }] : []),
			...(options.extraOverflow?.() ?? []),
			{ label: t('comments.copyThreadId'), icon: 'i-lucide-copy', onSelect: () => { void copy(current.id, t('comments.copiedId')) } },
		]]
		if (retract.value.eligible)
			groups.push([{ label: retract.value.empty ? t('comments.deleteEmpty') : t('comments.delete'), icon: 'i-lucide-trash-2', color: 'error', onSelect: askDelete }])
		return groups
	})

	/** Another thread is shown: drop the half-done steps of the previous one. */
	function reset(): void {
		pendingAction.value = undefined
		confirmingDelete.value = false
	}
	watch(() => options.thread()?.id, reset)

	return {
		activeSubmission,
		primaryResolution,
		pendingAction,
		reason,
		reasonInput,
		ask,
		resolveAs,
		confirmPending,
		resolveMenu,
		retract,
		confirmingDelete,
		deleteRefused: computed(() => options.retractRefused()),
		retractConfirm,
		keepConfirmFocus,
		askDelete,
		confirmDelete,
		promoteOpen,
		submitPromote,
		submitOpen,
		submitError,
		submitConflict,
		submitForReview,
		overflow,
		reset,
	}
}
