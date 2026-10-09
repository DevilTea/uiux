import { computed, inject, nextTick, onScopeDispose, provide, ref, shallowReactive, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import { useI18n, useToast } from '#imports'
import {
	isWidgetAnchor,
	isWorkspaceAnchor,
	type ReviewActor,
	type ReviewDisplayHint,
	type ReviewRenderContext,
	type ReviewResolution,
	type ReviewStatus,
	type ReviewThread,
	type ReviewWidgetAnchor,
} from '../../src/domain/reviews/schema'
import { isDismissal } from '../utils/review-inbox'
import type { Point } from '../../src/preview/protocol/schema'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { actorInitials } from '../utils/widget-inspection'
import { flattenWidgetTree } from '../../src/preview/widget-tree'
import { useAccess } from './useAccess'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'
import { usePinPlacements, type PinPlacement, type PinThreadInput } from './usePinPlacements'
import { canvasOrder, cycleThread, pinStatuses, type PinStatus } from '../utils/pin-layout'
import type { CommentTarget } from './usePreviewSession'
import type { ReviewSummary, ViewRead } from './workbench-types'
import { submissionBody, type ReviewSubmissionDraft } from '../utils/review-submission'
import { commentCreateBlock, commentToolBlock, type CommentBlockCode } from '../utils/comment-availability'
import { useMediaQuery, WORKBENCH_BREAKPOINTS } from './useMediaQuery'
import { captureRenderContext } from '../../src/preview/render-context-options'
import { createThreadBody, reanchorThreadBody } from '../utils/canvas-comment-requests'

/** The RootShell: a thread anchored here is about the View as a whole, not one Widget. */
export const VIEW_ANCHOR_WIDGET_ID = 'root'

/**
 * Canvas comments (brief c; roadmap R6 and R7a): the comment threads of the open View, their
 * pins, the inline composer and the thread bubble, shared by the canvas and the Comments tab.
 *
 * Persistence is the accepted Review model only: `{ anchor, variantNames }` plus the
 * non-authoritative `displayHint.pin` (pin-hint decision group), the recorded `renderContext`
 * (Rule 01a1170f-c0ce), messages and lifecycle events.
 * The actor is never sent: the server stamps it from the signed-in member. The raw click point
 * stays transient; only its quantized, Widget-relative hint is written.
 */

export type CommentFilter = Readonly<{ open: boolean; ready: boolean; resolved: boolean }>

export type CommentThread = Readonly<{
	id: string
	revision: string
	/** Always a Widget anchor: Workspace threads never reach a View's canvas or Comments tab. */
	anchor: ReviewWidgetAnchor
	variantNames: readonly string[]
	status: ReviewStatus
	resolution?: ReviewResolution
	/** Resolved as obsolete, duplicate or won't do: listed, but never drawn as a pin. */
	dismissed: boolean
	displayHint?: ReviewDisplayHint
	/** The Locale, viewport and theme the thread records; absent means unknown. */
	renderContext?: ReviewRenderContext
	messageCount: number
	latestActivityAt?: string
	/** The canonical thread, once its point read arrived. */
	detail?: ReviewThread
	/** The first message's server-stamped actor: the pin's initials. */
	author?: ReviewActor
	/** The first message, the row and bubble title. */
	title?: string
	/** False when the anchored Widget is no longer in the View IR (never drawn, never rebound). */
	anchorValid: boolean
	/** Named Variants of the scope that the View no longer defines ("Variant missing"). */
	missingVariants: readonly string[]
	/** The scope includes the current Variant (or is View-wide). */
	inScope: boolean
}>

export type ComposerState = Readonly<{
	/** Bumps per composer, so a component can refocus a fresh one. */
	sequence: number
	widgetId: string
	/** The transient click point in inner content-viewport CSS px (pointer path only). */
	innerPoint?: Point
	/** The normalized point inside the Widget's full rect, once a current report gave the rect. */
	hint?: Readonly<{ x: number; y: number }>
	text: string
	scope: 'this' | 'all'
	askingDiscard: boolean
	posting: boolean
	error?: FetchErrorDetails
	/** The thread exists but its first message failed: Retry posts only the message. */
	created?: Readonly<{ key: string; revision: string }>
}>

/** What a thread's pin and its cluster or edge menu row say. */
export type PinMeta = Readonly<{
	label: string
	name: string
	initials: string
	agent: boolean
	resolved: boolean
	badge?: 'ready' | 'stale'
	title: string
	detail: string
}>

/** The pending composer's pseudo-thread in the pin inputs (its Widget is tracked in tier 1). */
export const PENDING_PIN_ID = 'pending'

const FILTER_STORAGE_KEY = 'uiux.workbench.commentFilter'
const DEFAULT_FILTER: CommentFilter = { open: true, ready: true, resolved: false }

type ReviewRead = Readonly<{ kind: 'review'; key: string; revision: string; resource: ReviewThread }>
type MutationResponse = Readonly<{ status?: string; key?: string; revision?: string }>

/** POSTs one Review mutation; the route is a plain string so typed-route inference stays shallow. */
async function post(url: string, body: Record<string, unknown>): Promise<MutationResponse> {
	return await $fetch<MutationResponse>(url, { method: 'POST', body })
}

function readFilter(): CommentFilter {
	try {
		const raw = globalThis.localStorage?.getItem(FILTER_STORAGE_KEY)
		if (!raw) return DEFAULT_FILTER
		const value = JSON.parse(raw) as Partial<CommentFilter>
		return { open: value.open !== false, ready: value.ready !== false, resolved: value.resolved === true }
	}
	catch { return DEFAULT_FILTER }
}

/** Writers quantize to 1e-4 (pin-hint decision 3.4); the server does it again. */
function unit(value: number): number {
	return Math.round(Math.min(1, Math.max(0, value)) * 10_000) / 10_000
}

export function statusKey(status: ReviewStatus): 'open' | 'ready' | 'resolved' {
	return status === 'ready-for-review' ? 'ready' : status === 'resolved' ? 'resolved' : 'open'
}

/** Initials for an actor's avatar and pin, from the server-stamped nickname (agents get a glyph instead). */
export function threadAuthorInitials(actor: ReviewActor | undefined): string {
	return actorInitials(actor?.displayName ?? actor?.id)
}

function createCanvasComments(thread: Ref<string | undefined>) {
	const { t } = useI18n()
	const workbench = useWorkbench()
	const access = useAccess()
	const uiux = useUiuxClient()
	const { preview, reviews, selectedViewId, selectedView, widgetTreeResult, contextOptions, reviewReadOnly } = workbench

	// -------------------------------------------------------------------------------------------
	// Threads of the open View
	// -------------------------------------------------------------------------------------------

	const details = shallowRef<ReadonlyMap<string, ReviewRead>>(new Map())
	const loadingDetails = ref(false)
	const loadError = ref<FetchErrorDetails>()

	const widgetIds = computed(() => {
		const tree = widgetTreeResult.value
		return tree?.status === 'valid' ? new Set(flattenWidgetTree(tree.root).map(node => node.id)) : undefined
	})
	const variantNamesOfView = computed(() => new Set(Object.keys((selectedView.value?.resource as { variants?: Record<string, unknown> } | undefined)?.variants ?? {})))
	const currentVariant = computed(() => contextOptions.value.variants.selected || '')

	const viewSummaries = computed(() => reviews.value.filter(review => isWidgetAnchor(review.summary.anchor) && review.summary.anchor.viewId === selectedViewId.value))
	/** Workspace comments that still need an answer: the Comments tab footer links to them (R7). */
	const workspaceThreadCount = computed(() => reviews.value.filter(review => isWorkspaceAnchor(review.summary.anchor) && review.summary.status !== 'resolved').length)

	const threads = computed<readonly CommentThread[]>(() => viewSummaries.value.map((review) => {
		const summary = review.summary
		const read = details.value.get(review.key)
		const detail = read && read.revision === review.revision ? read.resource : read?.resource
		const variantNames = summary.variantNames ?? detail?.variantNames ?? []
		const ids = widgetIds.value
		const anchor = summary.anchor as ReviewWidgetAnchor
		const first = detail?.messages[0]
		return Object.freeze({
			id: review.key,
			revision: read?.revision === review.revision ? read.revision : review.revision,
			anchor,
			variantNames,
			status: summary.status ?? 'open',
			...(summary.resolution ? { resolution: summary.resolution } : {}),
			dismissed: summary.status === 'resolved' && isDismissal(summary.resolution),
			...(summary.displayHint ? { displayHint: summary.displayHint } : {}),
			...((summary.renderContext ?? detail?.renderContext) ? { renderContext: summary.renderContext ?? detail?.renderContext } : {}),
			messageCount: summary.messageCount ?? detail?.messages.length ?? 0,
			...(summary.latestActivityAt ? { latestActivityAt: summary.latestActivityAt } : {}),
			...(detail ? { detail } : {}),
			...(first ? { author: first.actor, title: first.body } : {}),
			anchorValid: anchor.widgetId === 'root' || !ids || ids.has(anchor.widgetId),
			missingVariants: variantNames.filter(name => !variantNamesOfView.value.has(name)),
			inScope: variantNames.length === 0 || variantNames.includes(currentVariant.value),
		})
	}).sort((a, b) => (Date.parse(b.latestActivityAt ?? '') || 0) - (Date.parse(a.latestActivityAt ?? '') || 0)))

	const threadById = computed(() => new Map(threads.value.map(item => [item.id, item])))

	/** Point reads for every thread of the View whose revision changed (timeline, author, title). */
	let detailSequence = 0
	async function loadDetails(): Promise<void> {
		const wanted = viewSummaries.value.filter(review => details.value.get(review.key)?.revision !== review.revision)
		if (!wanted.length) return
		const sequence = ++detailSequence
		loadingDetails.value = true
		try {
			const reads = await Promise.all(wanted.map(review => uiux.readResource<ReviewRead>('review', review.key).catch(() => undefined)))
			if (sequence !== detailSequence) return
			const next = new Map(details.value)
			for (const read of reads) if (read?.resource) next.set(read.key, read)
			details.value = next
		}
		finally {
			if (sequence === detailSequence) loadingDetails.value = false
		}
	}
	watch(() => viewSummaries.value.map(review => `${review.key}@${review.revision}`).join(','), () => { void loadDetails() }, { immediate: true })

	/** Re-reads the Review summaries after a mutation (the nav badges follow the same list). */
	async function refreshReviews(): Promise<void> {
		try {
			const page = await uiux.listResources<ReviewSummary>(['review'], { limit: 100 })
			reviews.value = page.items
			loadError.value = undefined
		}
		catch (cause) {
			loadError.value = describeFetchError(cause, t('comments.errors.loadFailed'))
		}
	}

	// -------------------------------------------------------------------------------------------
	// Permissions (accepted identity decisions; direct-resolve decision 9)
	// -------------------------------------------------------------------------------------------

	/** Reviewers and above comment and reply; Viewers and the publication read only. */
	const canComment = computed(() => !reviewReadOnly.value)
	/** Resolution is a human act on a Workbench cookie session. */
	const canResolve = computed(() => !reviewReadOnly.value && access.member.value?.kind === 'human' && access.session.value?.credential === 'session')
	const member = computed(() => access.member.value)
	/** The signed-in member's stamped actor id, for "my message" and "my thread". */
	const me = computed(() => access.member.value ? `member:${access.member.value.id}` : undefined)

	/**
	 * Why a new thread can't be started (review feedback 8dd59d25): every entry point shows this
	 * instead of disappearing or silently doing nothing. `createBlockedReason` covers "Comment on
	 * this View"; the canvas Comment tool also needs a live Preview (`toolBlockedReason`).
	 */
	const handset = useMediaQuery(WORKBENCH_BREAKPOINTS.handset)
	const availability = computed(() => ({
		publication: workbench.isReadOnly.value,
		workspaceState: workbench.workspace.value?.inspection?.state,
		signedIn: !!access.member.value,
		canReview: access.canReview.value,
		handset: handset.value,
		hasView: !!selectedView.value,
		session: preview.sessionStatus.value,
	}))
	function blockReason(code: CommentBlockCode | undefined): string | undefined {
		if (!code) return undefined
		if (code === 'role') return t('commentBlock.role', { role: t(`access.role.${access.role.value ?? 'viewer'}`) })
		return t(`commentBlock.${code}`)
	}
	const createBlockedReason = computed(() => blockReason(commentCreateBlock(availability.value)))
	const toolBlockedReason = computed(() => blockReason(commentToolBlock(availability.value)))

	const toast = useToast()
	let blockedToast: string | number | undefined
	/** A blocked entry point was used anyway (a key, a tap, the palette): say why, replacing the last such toast. */
	function explainBlocked(reason: string): void {
		if (blockedToast !== undefined) toast.remove(blockedToast)
		blockedToast = toast.add({ title: reason, color: 'neutral', icon: 'i-lucide-info' }).id
		announce(reason)
	}

	// -------------------------------------------------------------------------------------------
	// Filter, open thread, hover, session points
	// -------------------------------------------------------------------------------------------

	const filter = ref<CommentFilter>(readFilter())
	watch(filter, (value) => {
		try { globalThis.localStorage?.setItem(FILTER_STORAGE_KEY, JSON.stringify(value)) }
		catch { /* storage unavailable */ }
	}, { deep: true })
	function setFilter(key: keyof CommentFilter, value: boolean): void {
		filter.value = { ...filter.value, [key]: value }
	}
	const inFilter = (item: CommentThread) => filter.value[statusKey(item.status)]

	const openThreadId = computed<string | undefined>({
		get: () => thread.value && threadById.value.has(thread.value) ? thread.value : undefined,
		set: (value) => { thread.value = value },
	})
	const openThread = computed(() => openThreadId.value ? threadById.value.get(openThreadId.value) : undefined)
	/** A list row under the pointer lifts its pin (brief c, section 6). */
	const hoveredThreadId = ref<string>()
	/** Shift C hides the pin layer; tracking and the list keep working. */
	const pinsHidden = ref(false)
	/** Pins that just dropped (one 180ms animation). */
	const freshThreadIds = ref<ReadonlySet<string>>(new Set())
	/** In-tab click memory for threads created here (normalized like the hint); never persisted locally. */
	const sessionPoints = new Map<string, Readonly<{ x: number; y: number }>>()

	// -------------------------------------------------------------------------------------------
	// Composer
	// -------------------------------------------------------------------------------------------

	const composer = ref<ComposerState>()
	let composerSequence = 0

	function hintFromReport(widgetId: string, point: Point | undefined): ComposerState['hint'] {
		if (!point) return undefined
		const report = preview.geometryStreams.report(widgetId)
		const rect = report?.rect
		if (!rect || !(rect.width > 0) || !(rect.height > 0)) return undefined
		return { x: unit((point.x - rect.x) / rect.width), y: unit((point.y - rect.y) / rect.height) }
	}

	function patchComposer(patch: Partial<ComposerState>): void {
		if (composer.value) composer.value = Object.freeze({ ...composer.value, ...patch })
	}

	/**
	 * What a thread started now records (Rule 01a1170f-c0ce): the Preview's current Locale,
	 * viewport and theme that are Workspace-local keys, never a built-in fallback, and nothing when
	 * none is. Captured when the thread is sent, so a context changed while composing is the one
	 * recorded (owner ruling 2026-10-09, Discussion #7).
	 */
	function currentRenderContext(): ReviewRenderContext | undefined {
		const keys = workbench.renderContextKeys.value
		if (!keys) return undefined
		const options = contextOptions.value
		return captureRenderContext(keys, { locale: options.locales.selected, viewportId: options.viewports.selectedId, themeId: options.themes.selected })
	}

	/** Opens the composer on a Widget, at the click point when there is one (pointer), else the default point. */
	function openComposer(target: CommentTarget): boolean {
		if (!canComment.value) return false
		if (composer.value?.text.trim()) {
			patchComposer({ askingDiscard: true })
			return false
		}
		openThreadId.value = undefined
		const hint = hintFromReport(target.widgetId, target.point)
		composer.value = Object.freeze({
			sequence: ++composerSequence,
			widgetId: target.widgetId,
			...(target.point ? { innerPoint: target.point } : {}),
			...(hint ? { hint } : {}),
			text: '',
			scope: currentVariant.value ? 'this' : 'all',
			askingDiscard: false,
			posting: false,
		})
		return true
	}

	/** `C`, the Comment tool and the palette: toggles Comment mode, or says why it can't start. */
	function toggleCommentMode(): boolean {
		if (preview.isCommentMode.value) {
			preview.exitCommentMode()
			return true
		}
		const reason = toolBlockedReason.value
		if (reason) {
			explainBlocked(reason)
			return false
		}
		preview.setCanvasTool('comment')
		return preview.isCommentMode.value
	}

	/**
	 * "Comment on this View": the composer on the RootShell anchor `{ viewId, widgetId: 'root' }`
	 * (no schema change), without picking a Widget. Its pin sits at the frame's top-left.
	 */
	function commentOnView(): boolean {
		const reason = createBlockedReason.value
		if (reason) {
			explainBlocked(reason)
			return false
		}
		// A pending re-anchor would take the next commit; this is a new thread instead.
		if (preview.reanchorThreadId.value) preview.exitCommentMode()
		if (!openComposer({ widgetId: VIEW_ANCHOR_WIDGET_ID })) return false
		announce(t('comments.announce.composingView'))
		return true
	}

	/** What a thread or composer is about: "Whole View" for the RootShell, else "Type · #id". */
	function targetLabel(widgetId: string, type?: string): string {
		return widgetId === VIEW_ANCHOR_WIDGET_ID ? t('comments.viewTarget') : `${type ?? 'Widget'} · #${widgetId}`
	}

	function setComposerText(text: string): void {
		patchComposer({ text, askingDiscard: false })
	}

	function closeComposer(force = false): void {
		if (!composer.value) return
		if (!force && composer.value.text.trim() && !composer.value.askingDiscard) {
			patchComposer({ askingDiscard: true })
			return
		}
		composer.value = undefined
	}

	// A touch commit has no hover stream yet: the hint follows the composer Widget's first report.
	watch(() => preview.pinPlacements.value, () => {
		const current = composer.value
		if (!current || current.hint || !current.innerPoint) return
		const hint = hintFromReport(current.widgetId, current.innerPoint)
		if (hint) patchComposer({ hint })
	})

	function markFresh(id: string): void {
		freshThreadIds.value = new Set([...freshThreadIds.value, id])
		setTimeout(() => {
			const next = new Set(freshThreadIds.value)
			next.delete(id)
			freshThreadIds.value = next
		}, 400)
	}

	async function postMessage(key: string, revision: string, body: string): Promise<MutationResponse> {
		return await post(`/api/reviews/${encodeURIComponent(key)}/messages`, { expectedRevision: revision, body })
	}

	/**
	 * ⌘↵ in the composer: create the thread (`anchor`, `variantNames`, `displayHint`, `renderContext`), then post its
	 * first message. A failed first message keeps the text and retries only the message.
	 */
	async function sendComposer(): Promise<void> {
		const current = composer.value
		const viewId = selectedViewId.value
		const body = current?.text.trim()
		if (!current || !viewId || !body || current.posting) return
		patchComposer({ posting: true, error: undefined, askingDiscard: false })
		const hint = current.hint ?? hintFromReport(current.widgetId, current.innerPoint)
		let created = current.created
		try {
			if (!created) {
				const renderContext = currentRenderContext()
				const response = await post('/api/reviews', createThreadBody({
					viewId,
					widgetId: current.widgetId,
					variantNames: current.scope === 'this' && currentVariant.value ? [currentVariant.value] : [],
					...(hint ? { hint } : {}),
					...(renderContext ? { renderContext } : {}),
				}))
				if (!response.key || !response.revision) throw new Error(t('comments.errors.createFailed'))
				created = { key: response.key, revision: response.revision }
				if (hint) sessionPoints.set(created.key, hint)
			}
			await postMessage(created.key, created.revision, body)
			const key = created.key
			composer.value = undefined
			await refreshReviews()
			markFresh(key)
			openThreadId.value = key
			announce(current.widgetId === VIEW_ANCHOR_WIDGET_ID ? t('comments.announce.createdOnView') : t('comments.announce.created', { id: `#${current.widgetId}` }))
		}
		catch (cause) {
			const error = describeFetchError(cause, created ? t('comments.errors.messageFailed') : t('comments.errors.createFailed'))
			if (composer.value?.sequence === current.sequence) patchComposer({ posting: false, error, ...(created ? { created } : {}) })
			if (created) void refreshReviews()
		}
	}

	// -------------------------------------------------------------------------------------------
	// Thread lifecycle (accepted direct-resolve decision group)
	// -------------------------------------------------------------------------------------------

	/** The open thread changed elsewhere since it was read: the draft is kept, Retry is explicit. */
	const conflict = ref<string>()
	const busy = ref<string>()
	const replyDrafts = ref<Record<string, string>>({})

	async function mutate(threadId: string, action: string, run: (revision: string) => Promise<unknown>, fallback: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || busy.value) return false
		busy.value = action
		conflict.value = undefined
		try {
			await run(item.revision)
			await refreshReviews()
			return true
		}
		catch (cause) {
			const details = describeFetchError(cause, fallback)
			if (details.statusCode === 409 || details.status === 'conflict') {
				conflict.value = threadId
				await refreshReviews()
			}
			else {
				lastError.value = { threadId, error: details }
			}
			return false
		}
		finally {
			busy.value = undefined
		}
	}
	const lastError = ref<Readonly<{ threadId: string; error: FetchErrorDetails }>>()

	async function reply(threadId: string): Promise<boolean> {
		const body = replyDrafts.value[threadId]?.trim()
		if (!body) return false
		lastError.value = undefined
		const ok = await mutate(threadId, 'reply', revision => postMessage(threadId, revision, body), t('comments.errors.replyFailed'))
		if (ok) replyDrafts.value = { ...replyDrafts.value, [threadId]: '' }
		return ok
	}

	/**
	 * Resolve: `answered` by default on an open thread (decision 10), `verified` with the active
	 * submission on a ready one, or a chosen non-verified kind. `duplicate` needs a reason.
	 */
	async function resolve(threadId: string, resolution: ReviewResolution, reason?: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || !canResolve.value) return false
		const submission = item.detail?.submissions.at(-1)
		if (resolution === 'verified' && (item.status !== 'ready-for-review' || !submission)) return false
		lastError.value = undefined
		const ok = await mutate(threadId, 'resolve', revision => post(`/api/reviews/${encodeURIComponent(threadId)}/resolve`, {
			expectedRevision: revision,
			resolution,
			...(resolution === 'verified' && submission ? { submissionId: submission.id } : {}),
			...(reason?.trim() ? { reason: reason.trim() } : {}),
		}), t('comments.errors.resolveFailed'))
		if (ok) {
			announce(t(isDismissal(resolution) ? 'comments.announce.dismissed' : 'comments.announce.resolved'))
			// A dismissed thread has no pin, so its bubble closes even when resolved threads are shown.
			if ((!filter.value.resolved || isDismissal(resolution)) && openThreadId.value === threadId) openThreadId.value = undefined
		}
		return ok
	}

	/** The message being edited inline in the bubble; one at a time. */
	const editingMessage = ref<Readonly<{ threadId: string; messageId: string }>>()

	/** Edit the viewer's own message (scope/edit decisions 11–15); a conflict keeps the editor open. */
	async function editMessage(threadId: string, messageId: string, body: string): Promise<boolean> {
		if (!canComment.value || !body.trim()) return false
		lastError.value = undefined
		const ok = await mutate(threadId, 'edit', revision => $fetch<MutationResponse>(`/api/reviews/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`, { method: 'PUT', body: { expectedRevision: revision, body } }), t('comments.errors.editFailed'))
		if (ok) {
			editingMessage.value = undefined
			announce(t('comments.announce.edited'))
		}
		return ok
	}

	/** A retract refused because someone engaged meanwhile (`review.retract_engaged`). */
	const retractRefused = ref<string>()

	/**
	 * Delete the viewer's own unengaged thread (retract addendum decision 8): the bubble closes, the
	 * pin goes, focus returns to the canvas region and the live region says "Comment deleted."
	 * `not_found` means it is already gone, which counts as done.
	 */
	async function retract(threadId: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || !canComment.value || busy.value) return false
		busy.value = 'retract'
		conflict.value = undefined
		lastError.value = undefined
		retractRefused.value = undefined
		try {
			await $fetch(`/api/reviews/${encodeURIComponent(threadId)}`, { method: 'DELETE', body: { expectedRevision: item.revision } })
		}
		catch (cause) {
			const details = describeFetchError(cause, t('comments.errors.deleteFailed'))
			if (details.statusCode !== 404) {
				if (details.diagnostics.some(diagnostic => diagnostic.code === 'review.retract_engaged')) retractRefused.value = threadId
				else if (details.statusCode === 409 || details.status === 'conflict') conflict.value = threadId
				else lastError.value = { threadId, error: details }
				await refreshReviews()
				busy.value = undefined
				return false
			}
		}
		if (openThreadId.value === threadId) openThreadId.value = undefined
		sessionPoints.delete(threadId)
		await refreshReviews()
		busy.value = undefined
		announce(t('comments.announce.deleted'))
		// Not to a vanished element: back to the canvas region, once the bubble and its menu are gone.
		requestAnimationFrame(() => document.querySelector<HTMLElement>('[data-canvas]')?.focus({ preventScroll: true }))
		return true
	}

	/** A human submission to `ready-for-review` (secondary, desktop-first): domains plus Evidence refs. */
	async function submit(threadId: string, draft: ReviewSubmissionDraft): Promise<boolean> {
		const item = threadById.value.get(threadId)
		const viewId = item?.anchor.viewId
		if (!item || !viewId || !canComment.value || item.status !== 'open') return false
		lastError.value = undefined
		const ok = await mutate(threadId, 'submit', async (revision) => {
			const view = await uiux.readResource<ViewRead>('view', viewId)
			if (!view) throw new Error(t('inbox.errors.viewMissing'))
			return await post(`/api/reviews/${encodeURIComponent(threadId)}/ready`, submissionBody(draft, view, revision))
		}, t('submit.failed'))
		if (ok) announce(t('submit.announce'))
		return ok
	}

	async function reopen(threadId: string, reason?: string): Promise<boolean> {
		lastError.value = undefined
		const ok = await mutate(threadId, 'reopen', revision => post(`/api/reviews/${encodeURIComponent(threadId)}/reopen`, { expectedRevision: revision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }), t('comments.errors.reopenFailed'))
		if (ok) announce(t('comments.announce.reopened'))
		return ok
	}

	/**
	 * Re-anchor by clicking: the new Widget, the thread's scope, and the new click's hint in the same
	 * mutation (pin-hint decision 5). Without a click point the server clears the hint on a Widget change.
	 */
	async function reanchor(threadId: string, target: CommentTarget): Promise<boolean> {
		const item = threadById.value.get(threadId)
		const viewId = selectedViewId.value
		if (!item || !viewId) return false
		const hint = hintFromReport(target.widgetId, target.point)
		lastError.value = undefined
		// No `renderContext`: the Workbench re-anchor keeps the recorded one (Rule 01a11e0d-d3f8).
		const ok = await mutate(threadId, 'reanchor', revision => post(`/api/reviews/${encodeURIComponent(threadId)}/reanchor`, reanchorThreadBody({
			expectedRevision: revision,
			viewId,
			widgetId: target.widgetId,
			variantNames: item.variantNames,
			...(hint ? { hint } : {}),
		})), t('comments.errors.reanchorFailed'))
		if (ok) {
			sessionPoints.delete(threadId)
			if (hint) sessionPoints.set(threadId, hint)
			announce(t('comments.announce.reanchored', { id: `#${target.widgetId}` }))
		}
		return ok
	}

	/** Dragging a pin within its Widget moves the hint (`set_review_display_hint`); one write on drop. */
	async function moveHint(threadId: string, hint: Readonly<{ x: number; y: number }>): Promise<boolean> {
		const pin = { x: unit(hint.x), y: unit(hint.y) }
		lastError.value = undefined
		const ok = await mutate(threadId, 'move', revision => post(`/api/reviews/${encodeURIComponent(threadId)}/display-hint`, { expectedRevision: revision, displayHint: { pin } }), t('comments.errors.moveFailed'))
		if (ok) sessionPoints.set(threadId, pin)
		return ok
	}

	async function promote(threadId: string, form: Readonly<{ question: string; summary: string; rationale: string }>): Promise<boolean> {
		const item = threadById.value.get(threadId)
		const view = selectedView.value
		if (!item || !view) return false
		lastError.value = undefined
		return await mutate(threadId, 'promote', revision => post(`/api/reviews/${encodeURIComponent(threadId)}/promote`, {
			expectedReviewRevision: revision,
			viewId: item.anchor.viewId,
			expectedViewRevision: view.revision,
			question: form.question.trim(),
			outcome: { summary: form.summary.trim(), rationale: form.rationale.trim() },
		}), t('comments.errors.promoteFailed'))
	}

	// -------------------------------------------------------------------------------------------
	// Pins (multi-target decision group; usePinPlacements)
	// -------------------------------------------------------------------------------------------

	const pinInputs = computed<readonly PinThreadInput[]>(() => {
		const inputs: PinThreadInput[] = []
		for (const item of threads.value) {
			// Dismissed threads never draw pins, even when the canvas shows resolved threads.
			if (item.dismissed) continue
			if (!inFilter(item) && item.id !== openThreadId.value) continue
			const session = sessionPoints.get(item.id)
			inputs.push({
				threadId: item.id,
				anchor: item.anchor,
				variantNames: item.variantNames,
				status: item.status,
				...(item.latestActivityAt ? { latestActivity: item.latestActivityAt } : {}),
				...(item.displayHint ? { displayHint: item.displayHint } : {}),
				...(session ? { sessionPoint: session } : {}),
				anchorValid: item.anchorValid,
			})
		}
		const current = composer.value
		if (current && selectedViewId.value) {
			inputs.unshift({
				threadId: PENDING_PIN_ID,
				anchor: { viewId: selectedViewId.value, widgetId: current.widgetId },
				status: 'open',
				...(current.hint ? { sessionPoint: current.hint } : {}),
			})
		}
		return inputs
	})

	const { placements, clusters, edgeIndicators, overCapWidgetIds } = usePinPlacements(pinInputs, {
		openThreadId: computed(() => openThreadId.value),
		pendingThreadId: computed(() => composer.value ? PENDING_PIN_ID : undefined),
	})
	const placementById = computed(() => new Map<string, PinPlacement>(placements.value.map(placement => [placement.threadId, placement])))

	/** Widget types by id, for pin names and menu rows. */
	const widgetTypeById = computed(() => {
		const tree = widgetTreeResult.value
		return new Map(tree?.status === 'valid' ? flattenWidgetTree(tree.root).map(node => [node.id, node.type]) : [])
	})
	/**
	 * What each thread's pin says (accessible name, initials, badge) and its row in cluster and edge
	 * menus. It depends on threads and the chrome locale only, never on geometry.
	 */
	const pinMeta = computed(() => {
		const meta = new Map<string, PinMeta>()
		for (const item of threads.value) {
			const name = item.author?.displayName ?? t('comments.unknownAuthor')
			const status = t(`thread.status.${statusKey(item.status)}`)
			const type = widgetTypeById.value.get(item.anchor.widgetId) ?? 'Widget'
			const onView = item.anchor.widgetId === VIEW_ANCHOR_WIDGET_ID
			const labelValues = {
				name,
				type,
				id: item.anchor.widgetId,
				status: status + (item.missingVariants.length ? `, ${t('comments.staleWord')}` : ''),
				n: item.messageCount,
			}
			const target = targetLabel(item.anchor.widgetId, type)
			meta.set(item.id, Object.freeze({
				label: onView ? t('comments.pinLabelView', labelValues, item.messageCount) : t('comments.pinLabel', labelValues, item.messageCount),
				name,
				initials: threadAuthorInitials(item.author),
				agent: item.author?.type === 'agent',
				resolved: item.status === 'resolved',
				...(item.status === 'ready-for-review' ? { badge: 'ready' as const } : item.missingVariants.length ? { badge: 'stale' as const } : {}),
				title: item.title ?? target,
				detail: `${status} · ${name} · ${target}`,
			}))
		}
		return meta
	})
	/**
	 * Each thread's canvas status (`visible`, `offscreen` and its side, or `hidden` with a reason).
	 * It keeps its identity while pins only move, so the list and the bubble do not re-render on
	 * every scrolled frame; only the pin layer follows the per-frame placements.
	 */
	const pinStatusById = computed<ReadonlyMap<string, PinStatus>>(previous => pinStatuses(placements.value, previous))
	/**
	 * The same statuses, reactive per thread: a list row that reads `pinStatus.get(id)` re-renders
	 * only when its own thread's status changes.
	 */
	const pinStatus = shallowReactive(new Map<string, PinStatus>())
	watch(pinStatusById, (next) => {
		for (const [id, status] of next) {
			const before = pinStatus.get(id)
			if (!before || before.state !== status.state || before.reason !== status.reason || before.side !== status.side) pinStatus.set(id, status)
		}
		for (const id of [...pinStatus.keys()]) if (!next.has(id)) pinStatus.delete(id)
	}, { immediate: true })
	/** Threads whose Widget got no geometry stream: the 64-Widget cap, or a single-stream runtime (decision 6). */
	const notOnCanvas = computed<Readonly<{ ids: readonly string[]; reason?: 'over-cap' | 'single-stream' }>>((previous) => {
		const ids: string[] = []
		let reason: 'over-cap' | 'single-stream' | undefined
		for (const [id, status] of pinStatusById.value) {
			if (id === PENDING_PIN_ID || (status.reason !== 'over-cap' && status.reason !== 'single-stream')) continue
			ids.push(id)
			reason ??= status.reason
		}
		if (previous && previous.reason === reason && previous.ids.join() === ids.join()) return previous
		return { ids, ...(reason ? { reason } : {}) }
	})

	/** Shift C (and the pins toggle): hides the pin layer only; tracking and the list keep working. */
	function togglePins(): void {
		pinsHidden.value = !pinsHidden.value
		announce(t(pinsHidden.value ? 'pins.hiddenAnnounce' : 'pins.shownAnnounce'))
	}

	/**
	 * `J` / `K` on the canvas: opens the next or previous thread in pin reading order (drawn pins,
	 * then threads behind edge indicators), starting from the open thread or `from` (a focused
	 * pin), and returns its id so the caller can move focus to its pin.
	 */
	function cycle(direction: 1 | -1, from?: string): string | undefined {
		if (pinsHidden.value) return undefined
		const order = canvasOrder(placements.value, new Set([PENDING_PIN_ID]))
		const next = cycleThread(order, openThreadId.value ?? from, direction)
		if (!next || !open(next)) return undefined
		// Browsing keeps focus on the pins, so J / K continue; Enter on the pin moves into the bubble.
		browsingPins.value = true
		return next
	}
	/** True while the open bubble was reached with J / K: the bubble leaves focus on its pin. */
	const browsingPins = ref(false)

	// -------------------------------------------------------------------------------------------
	// Opening threads, Escape, announcements
	// -------------------------------------------------------------------------------------------

	/** A list pick asks the canvas to pan its stage to the pin (never the iframe). */
	const revealRequest = ref<Readonly<{ threadId: string; sequence: number }>>()
	let revealSequence = 0
	function requestReveal(threadId: string): void {
		revealRequest.value = { threadId, sequence: ++revealSequence }
	}

	const announcement = ref('')
	function announce(text: string): void {
		announcement.value = ''
		void nextTick(() => { announcement.value = text })
	}

	/** Opens a thread's bubble; its status joins the filter so the pin can show (brief c §6). */
	function open(threadId: string): boolean {
		const item = threadById.value.get(threadId)
		if (!item) return false
		browsingPins.value = false
		if (composer.value?.text.trim()) {
			patchComposer({ askingDiscard: true })
			return false
		}
		composer.value = undefined
		const key = statusKey(item.status)
		if (!filter.value[key]) setFilter(key, true)
		conflict.value = undefined
		lastError.value = undefined
		retractRefused.value = undefined
		if (editingMessage.value?.threadId !== threadId) editingMessage.value = undefined
		openThreadId.value = threadId
		return true
	}

	function close(): void {
		const id = openThreadId.value
		if (!id) return
		openThreadId.value = undefined
		if (id) void nextTick(() => document.querySelector<HTMLElement>(`[data-pin-thread="${CSS.escape(id)}"]`)?.focus({ preventScroll: true }))
	}

	/** Workbench-owned Escape (Part 3): discard prompt, composer, bubble, in that order. */
	function escape(): boolean {
		// An open menu, select or other dialog (a modal, the command palette) closes itself first.
		if (document.querySelector('[data-reka-popper-content-wrapper] :is([role="menu"], [role="listbox"]), [role="dialog"][data-state="open"]:not(:has([data-thread-bubble], [data-comment-composer]))')) return true
		if (composer.value) {
			closeComposer()
			return true
		}
		if (openThreadId.value) {
			close()
			return true
		}
		if (preview.reanchorThreadId.value) {
			const id = preview.reanchorThreadId.value
			preview.exitCommentMode()
			open(id)
			return true
		}
		return false
	}

	const offCommentEscape = preview.onCommentEscape(escape)
	const offCommentTarget = preview.onCommentTarget((target) => {
		const reanchorId = preview.reanchorThreadId.value
		if (reanchorId) {
			preview.exitCommentMode()
			void reanchor(reanchorId, target).then(() => open(reanchorId))
			return
		}
		if (openComposer(target) && !target.point)
			announce(target.widgetId === VIEW_ANCHOR_WIDGET_ID ? t('comments.announce.composingView') : t('comments.announce.composing', { id: `#${target.widgetId}` }))
	})
	onScopeDispose(() => {
		offCommentEscape()
		offCommentTarget()
	})

	// The mode change and the hover chip are announced; the chip at most once per 500 ms (brief c §12).
	watch(() => preview.isCommentMode.value, (on, was) => {
		if (on === was) return
		announce(on ? t(preview.reanchorThreadId.value ? 'comments.announce.reanchorOn' : 'comment.modeOn') : t('comments.announce.modeOff'))
	})
	let lastHoverAnnounce = 0
	watch(() => preview.hoverCandidate.value?.widgetId, (widgetId) => {
		if (!widgetId || !preview.isCommentMode.value || Date.now() - lastHoverAnnounce < 500) return
		lastHoverAnnounce = Date.now()
		const tree = widgetTreeResult.value
		const type = tree?.status === 'valid' ? flattenWidgetTree(tree.root).find(node => node.id === widgetId)?.type : undefined
		announce(t('comment.hoverChip', { type: type ?? `#${widgetId}` }))
	})

	/**
	 * A stale canvas link (`/views/:id?thread=<id>`) to a thread that no longer exists, for example
	 * one its author deleted: the View opens with no bubble, a toast says so, and `thread` is dropped
	 * from the URL (retract addendum decision 3). A thread of another View is not "gone".
	 */
	const reviewsLoaded = ref(false)
	watch(() => workbench.loading.value, (loading) => { if (!loading) reviewsLoaded.value = true }, { immediate: true })
	watch(() => [thread.value, reviewsLoaded.value, reviews.value.length] as const, ([id, loaded]) => {
		if (!id || !loaded || workbench.loading.value) return
		// A full first page may not hold every thread: only a complete listing can prove one is gone.
		if (reviews.value.length >= 100 || reviews.value.some(review => review.key === id)) return
		thread.value = undefined
		toast.add({ title: t('comments.gone'), color: 'neutral', icon: 'i-lucide-message-circle-off' })
		announce(t('comments.gone'))
	}, { immediate: true })

	// A View switch drops the composer and every transient point.
	watch(selectedViewId, () => {
		composer.value = undefined
		hoveredThreadId.value = undefined
		conflict.value = undefined
		lastError.value = undefined
	})

	return {
		threads,
		threadById,
		loadingDetails,
		loadError,
		canComment,
		canResolve,
		member,
		me,
		workspaceThreadCount,
		editingMessage,
		editMessage,
		retract,
		retractRefused,
		createBlockedReason,
		toolBlockedReason,
		explainBlocked,
		toggleCommentMode,
		commentOnView,
		targetLabel,
		filter,
		setFilter,
		inFilter,
		openThreadId,
		openThread,
		hoveredThreadId,
		pinsHidden,
		freshThreadIds,
		composer,
		openComposer,
		setComposerText,
		patchComposer,
		closeComposer,
		sendComposer,
		replyDrafts,
		conflict,
		lastError,
		busy,
		reply,
		resolve,
		reopen,
		submit,
		reanchor,
		moveHint,
		promote,
		refreshReviews,
		placements,
		placementById,
		pinStatusById,
		pinStatus,
		pinMeta,
		widgetTypeById,
		notOnCanvas,
		togglePins,
		cycle,
		browsingPins,
		clusters,
		edgeIndicators,
		overCapWidgetIds,
		open,
		close,
		escape,
		announcement,
		announce,
		revealRequest,
		requestReveal,
	}
}

export type CanvasComments = ReturnType<typeof createCanvasComments>

const COMMENTS_KEY: InjectionKey<CanvasComments> = Symbol('uiux-canvas-comments')

/** Provided by the View page (below `provideWorkbench()`); `thread` is the route's open thread. */
export function provideCanvasComments(thread: Ref<string | undefined>): CanvasComments {
	const comments = createCanvasComments(thread)
	provide(COMMENTS_KEY, comments)
	return comments
}

/** The View page's comments, or `undefined` where no comments layer exists (the Prototype player). */
export function useCanvasComments(): CanvasComments | undefined {
	return inject(COMMENTS_KEY, undefined)
}
