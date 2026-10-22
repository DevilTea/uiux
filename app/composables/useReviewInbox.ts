import { computed, effectScope, inject, nextTick, provide, ref, shallowRef, watch, type InjectionKey } from 'vue'
import { navigateTo, useI18n, useRoute, useRouter } from '#imports'
import { anchorViewId, type ReviewResolution, type ReviewThread } from '../../src/domain/reviews/schema'
import { deriveWidgetTree, flattenWidgetTree } from '../../src/preview/widget-tree'
import { effectiveRenderContext } from '../../src/preview/render-context-options'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { resolveBlock, resolveBlockMessage } from '../utils/comment-availability'
import {
	buildInboxThread,
	canvasLinkOptions,
	groupInbox,
	inboxCanvasLink,
	inboxQuery,
	isDismissal,
	isUnreadThread,
	matchesInboxFacets,
	matchesInboxFilter,
	parseInboxQuery,
	type CanvasLinkContext,
	type InboxFilter,
	type InboxThread,
	type InboxViewInfo,
	type SeenMarks,
} from '../utils/review-inbox'
import {
	cleanSavedFilterName,
	MAX_SAVED_FILTERS,
	parseSavedFilters,
	resolveSavedFilter,
	sameInboxFilter,
	sameNameKey,
	savedFilterQuery,
	savedFiltersKey,
	serializeSavedFilters,
	type SavedInboxFilter,
} from '../utils/saved-inbox-filters'
import { parseThread, viewLocation } from '../utils/workbench-routes'
import { submissionBody, type ReviewSubmissionDraft } from '../utils/review-submission'
import { createRevisionPin, useReplyBases } from './useReplyBases'
import { threadState, type ReplyConflict } from '../utils/reply-conflict'
import { promoteMovedOf, type PromoteConflict } from '../utils/promote-conflict'
import { accessEpoch, useAccess } from './useAccess'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'
import { useRecordedRenderContext } from './useRecordedRenderContext'
import type { ReviewSummary, ViewRead } from './workbench-types'

/**
 * The Reviews inbox (brief d; roadmap R8): every Review thread across Views, the URL-synced
 * filters, the selected thread, the per-browser "updated since you last looked" marks, and the
 * lifecycle mutations. The actor is never sent: the server stamps it from the signed-in member.
 *
 * The filter and the selected thread live in the route query, so a filtered inbox and an open
 * thread are both shareable deep links.
 */

type ReviewRead = Readonly<{ kind: 'review'; key: string; revision: string; resource: ReviewThread }>
type ViewIrInfo = Readonly<{ revision: string; widgetTypes?: ReadonlyMap<string, string>; variants: ReadonlySet<string> }>
type ListPage = Readonly<{ items: readonly ReviewSummary[]; nextCursor?: string }>

const SEEN_STORAGE_PREFIX = 'uiux.reviews.seen:'
const MAX_PAGES = 20
/** The Workbench lists Views one page of this size; a full page may be truncated. */
const VIEW_LIST_LIMIT = 100
const READ_BATCH = 8

type MutationResponse = Readonly<{ status?: string; key?: string; revision?: string }>

async function post(url: string, body: Record<string, unknown>): Promise<MutationResponse> {
	return await $fetch<MutationResponse>(url, { method: 'POST', body })
}

/** PUT and DELETE (edit a message, retract a thread); the route is a plain string so typed-route inference stays shallow. */
async function send(url: string, method: 'PUT' | 'DELETE', body: Record<string, unknown>): Promise<MutationResponse> {
	return await $fetch<MutationResponse>(url, { method, body })
}

/** The coded refusal of a failed mutation, from its diagnostics. */
function refusalCode(details: FetchErrorDetails): string | undefined {
	return details.diagnostics.find(item => item.code)?.code
}

function readSeen(key: string): SeenMarks {
	try {
		const raw = globalThis.localStorage?.getItem(key)
		const value = raw ? JSON.parse(raw) as unknown : undefined
		return value && typeof value === 'object' && !Array.isArray(value) ? value as SeenMarks : {}
	}
	catch { return {} }
}

function readSavedFilters(key: string): SavedInboxFilter[] {
	try { return parseSavedFilters(globalThis.localStorage?.getItem(key)) }
	catch { return [] }
}

function createReviewInbox() {
	const { t } = useI18n()
	const route = useRoute()
	const router = useRouter()
	const uiux = useUiuxClient()
	const access = useAccess()
	const workbench = useWorkbench()
	const recordedContext = useRecordedRenderContext()
	const { reviews, views, reviewReadOnly, preview } = workbench

	// -------------------------------------------------------------------------------------------
	// Route state: the filter and the selected thread
	// -------------------------------------------------------------------------------------------

	/** Mutation state: the running action, a revision conflict or error per thread, unsent replies. */
	const busy = ref<string>()
	const conflict = ref<string>()
	/** The conflict was a reply's: what the thread looked like when it was sent (Rule 01a116f0-95fc). */
	const replyConflict = ref<ReplyConflict>()
	watch(conflict, (id) => { if (replyConflict.value && replyConflict.value.threadId !== id) replyConflict.value = undefined }, { flush: 'sync' })
	/** The conflict was a promotion's: which resource moved, the thread or the View (Rule 01a11544-611c). */
	const promoteConflict = ref<PromoteConflict>()
	watch(conflict, (id) => { if (promoteConflict.value && promoteConflict.value.threadId !== id) promoteConflict.value = undefined }, { flush: 'sync' })
	const lastError = ref<Readonly<{ threadId: string; error: FetchErrorDetails }>>()
	const replyDrafts = ref<Record<string, string>>({})
	const announcement = ref('')

	// The route is the source of truth; local copies apply at once, so fast key repeats (J J J)
	// never read a query that the router has not committed yet.
	const filterState = shallowRef<InboxFilter>(parseInboxQuery(route.query))
	const selectedState = ref<string | undefined>(parseThread(route.query))
	/** The query this inbox asked for last; commits of older, superseded replaces are ignored. */
	let requested: string | undefined
	const queryKey = (query: Record<string, unknown>) => JSON.stringify(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').sort(([a], [b]) => a.localeCompare(b)))
	watch(() => route.fullPath, () => {
		if (route.path !== '/reviews') return
		if (requested !== undefined) {
			if (queryKey(route.query) !== requested) return
			requested = undefined
		}
		filterState.value = parseInboxQuery(route.query)
		selectedState.value = parseThread(route.query)
	})
	const filter = computed<InboxFilter>(() => filterState.value)
	const selectedId = computed(() => selectedState.value)

	function replaceQuery(next: InboxFilter, thread: string | undefined): void {
		if (route.path !== '/reviews') return
		filterState.value = next
		selectedState.value = thread
		const query = inboxQuery(next, thread)
		requested = queryKey(query)
		void router.replace({ query }).finally(() => {
			// The newest request settled (committed, cancelled or a no-op): route changes apply again.
			if (requested === queryKey(query)) requested = undefined
		})
	}
	function setFilter(patch: Partial<InboxFilter>): void {
		replaceQuery({ ...filter.value, ...patch }, selectedId.value)
	}
	/** Clears every narrowing filter; the status tab stays. */
	function clearFilters(): void {
		replaceQuery({ ...parseInboxQuery({}), status: filter.value.status }, selectedId.value)
	}
	function select(id: string | undefined): void {
		if (id === selectedId.value) return
		conflict.value = undefined
		lastError.value = undefined
		retractRefused.value = undefined
		editingMessage.value = undefined
		replaceQuery(filter.value, id)
	}

	// -------------------------------------------------------------------------------------------
	// Summaries, point reads and anchored Views
	// -------------------------------------------------------------------------------------------

	const loading = ref(false)
	const loaded = ref(false)
	const loadError = ref<FetchErrorDetails>()

	/** Every Review summary, following the list cursor past the 100-item page (the nav badges share it). */
	async function loadSummaries(): Promise<void> {
		loading.value = true
		try {
			const items: ReviewSummary[] = []
			let cursor: string | undefined
			for (let page = 0; page < MAX_PAGES; page++) {
				const result: ListPage = await $fetch<ListPage>('/api/resources/list', { method: 'POST', body: { kinds: ['review'], limit: 100, ...(cursor ? { cursor } : {}) } })
				items.push(...result.items)
				cursor = result.nextCursor
				if (!cursor) break
			}
			reviews.value = items
			pruneSeen(items.map(item => item.key))
			loadError.value = undefined
		}
		catch (cause) {
			loadError.value = describeFetchError(cause, t('inbox.errors.loadFailed'))
		}
		finally {
			loading.value = false
			loaded.value = true
		}
	}

	const details = shallowRef<ReadonlyMap<string, ReviewRead>>(new Map())
	const detailErrors = shallowRef<ReadonlyMap<string, FetchErrorDetails>>(new Map())
	let detailSequence = 0

	async function loadDetails(force = false): Promise<void> {
		const wanted = reviews.value.filter(review => force || details.value.get(review.key)?.revision !== review.revision)
		if (!wanted.length) return
		const sequence = ++detailSequence
		const next = new Map(details.value)
		const errors = new Map(detailErrors.value)
		for (let index = 0; index < wanted.length; index += READ_BATCH) {
			const batch = wanted.slice(index, index + READ_BATCH)
			const reads = await Promise.all(batch.map(async (review) => {
				try {
					return { key: review.key, read: await uiux.readResource<ReviewRead>('review', review.key) }
				}
				catch (cause) {
					return { key: review.key, error: describeFetchError(cause, t('inbox.errors.threadUnreadable')) }
				}
			}))
			if (sequence !== detailSequence) return
			for (const result of reads) {
				if (result.read?.resource) {
					next.set(result.key, result.read)
					errors.delete(result.key)
				}
				else if (result.error) errors.set(result.key, result.error)
			}
			details.value = new Map(next)
			detailErrors.value = errors
		}
	}
	watch(() => reviews.value.map(review => `${review.key}@${review.revision}`).join(','), () => { void loadDetails() }, { immediate: true })
	// A roster change does not change a Review's revision, but it changes which actors read as removed (Rule 01a11485-f185-7c23-8f2a-e045a279cd27).
	watch(accessEpoch, () => { void loadDetails(true) })

	const viewIr = shallowRef<ReadonlyMap<string, ViewIrInfo>>(new Map())
	async function loadViews(): Promise<void> {
		const ids = new Set(reviews.value.map(review => anchorViewId(review.summary.anchor)).filter((id): id is string => !!id))
		const wanted = views.value.filter(view => ids.has(view.key) && viewIr.value.get(view.key)?.revision !== view.revision)
		if (!wanted.length) return
		const reads = await Promise.all(wanted.map(view => uiux.readResource<ViewRead>('view', view.key).catch(() => undefined)))
		const next = new Map(viewIr.value)
		for (const read of reads) {
			if (!read) continue
			const tree = deriveWidgetTree(read.resource.ir)
			next.set(read.key, {
				revision: read.revision,
				...(tree.status === 'valid' ? { widgetTypes: new Map(flattenWidgetTree(tree.root).map(node => [node.id, node.type])) } : {}),
				variants: new Set(Object.keys(read.resource.variants ?? {})),
			})
		}
		viewIr.value = next
	}
	watch(() => [views.value.map(view => `${view.key}@${view.revision}`).join(','), reviews.value.map(review => anchorViewId(review.summary.anchor)).join(',')], () => { void loadViews() }, { immediate: true })

	/** Anchored Views by id; undefined until the View list arrived, so nothing reads as missing early. */
	const viewInfo = computed<ReadonlyMap<string, InboxViewInfo> | undefined>(() => {
		if (workbench.loading.value && !views.value.length) return undefined
		return new Map(views.value.map((view) => {
			const ir = viewIr.value.get(view.key)
			return [view.key, { ...(view.summary.name ? { name: view.summary.name } : {}), ...(ir?.widgetTypes ? { widgetTypes: ir.widgetTypes } : {}), ...(ir ? { variants: ir.variants } : {}) }]
		}))
	})

	const threads = computed<readonly InboxThread[]>(() => reviews.value.map((review) => {
		const read = details.value.get(review.key)
		return buildInboxThread(review, read?.resource, viewInfo.value)
	}))
	const threadById = computed(() => new Map(threads.value.map(item => [item.id, item])))
	/** Each reply draft is sent against the revision it was started on (live refresh moves the thread under it). */
	const replyBases = useReplyBases(replyDrafts, threadId => threadById.value.get(threadId))

	// -------------------------------------------------------------------------------------------
	// Identity: "mine" and "updated since you last looked" (per browser, per member)
	// -------------------------------------------------------------------------------------------

	const member = computed(() => access.member.value)
	/** The signed-in member's server-stamped actor id. */
	const me = computed(() => member.value ? `member:${member.value.id}` : undefined)
	const seenKey = computed(() => `${SEEN_STORAGE_PREFIX}${member.value?.id ?? 'anonymous'}`)
	const seen = ref<SeenMarks>(readSeen(seenKey.value))
	watch(seenKey, (key) => { seen.value = readSeen(key) })

	function markSeen(thread: InboxThread): void {
		if (!thread.latestActivityAt || seen.value[thread.id] === thread.latestActivityAt) return
		seen.value = { ...seen.value, [thread.id]: thread.latestActivityAt }
		try { globalThis.localStorage?.setItem(seenKey.value, JSON.stringify(seen.value)) }
		catch { /* storage unavailable: the marks last for this tab only */ }
	}
	function isUnread(thread: InboxThread): boolean {
		return isUnreadThread(thread, seen.value, me.value)
	}
	/** Marks of threads that no longer exist (retracted, or deleted out of band) are dropped lazily (T11). */
	function pruneSeen(keys: readonly string[]): void {
		const known = new Set(keys)
		const kept = Object.fromEntries(Object.entries(seen.value).filter(([id]) => known.has(id)))
		if (Object.keys(kept).length === Object.keys(seen.value).length) return
		seen.value = kept
		try { globalThis.localStorage?.setItem(seenKey.value, JSON.stringify(kept)) }
		catch { /* storage unavailable */ }
	}

	// -------------------------------------------------------------------------------------------
	// Saved filters (issue #62): per browser, Workspace and member; never Workspace data
	// -------------------------------------------------------------------------------------------

	const savedKey = computed(() => savedFiltersKey(access.session.value?.workspaceRoot, member.value?.id))
	const savedFilters = ref<readonly SavedInboxFilter[]>(readSavedFilters(savedKey.value))
	watch(savedKey, (key) => { savedFilters.value = readSavedFilters(key) })
	function writeSaved(next: readonly SavedInboxFilter[]): void {
		savedFilters.value = next
		try { globalThis.localStorage?.setItem(savedKey.value, serializeSavedFilters(next)) }
		catch { /* storage unavailable: the saved filters last for this tab only */ }
	}

	/** Existing View ids; undefined while the View list is loading, failed or may be truncated (one page), so nothing is dropped on a guess. */
	const knownViewIds = computed(() => workbench.loading.value || workbench.error.value || !workbench.workspace.value || views.value.length >= VIEW_LIST_LIMIT ? undefined : new Set(views.value.map(view => view.key)))
	/** Saved filters need both the Workspace and the member known; before the session loads the key is a placeholder. */
	const canSaveFilters = computed(() => !!access.session.value?.workspaceRoot && !!member.value?.id)
	/** Each saved filter as it applies now (facets that no longer resolve dropped). */
	const resolvedSaved = computed(() => savedFilters.value.map(saved => ({ saved, ...resolveSavedFilter(saved, knownViewIds.value) })))
	/** The saved filter the current filter equals, if any. */
	const activeSavedId = computed(() => resolvedSaved.value.find(item => !item.droppedViews && sameInboxFilter(item.filter, filter.value))?.saved.id)
	/** Set when applying a saved filter dropped facets; shown while that filter stays applied. */
	const savedChanged = ref<Readonly<{ id: string; name: string; dropped: number }>>()
	const savedNotice = computed(() => savedChanged.value && resolvedSaved.value.some(item => item.saved.id === savedChanged.value?.id && sameInboxFilter(item.filter, filter.value)) ? savedChanged.value : undefined)

	type SavedRefusal = 'empty' | 'duplicate' | 'limit' | 'unavailable'
	function nameRefusal(name: string, exceptId?: string): SavedRefusal | undefined {
		if (!name) return 'empty'
		const lower = sameNameKey(name)
		return savedFilters.value.some(item => item.id !== exceptId && sameNameKey(item.name) === lower) ? 'duplicate' : undefined
	}
	/** Saves the current filter under a name; returns why it was refused, if it was. */
	function saveCurrentFilter(rawName: string): SavedRefusal | undefined {
		const name = cleanSavedFilterName(rawName)
		const refusal = nameRefusal(name) ?? (savedFilters.value.length >= MAX_SAVED_FILTERS ? 'limit' : undefined)
		if (refusal) return refusal
		if (!canSaveFilters.value) return 'unavailable'
		writeSaved([...savedFilters.value, { id: globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`, name, query: savedFilterQuery(filter.value) }])
		savedChanged.value = undefined
		announce(t('inbox.saved.announce.saved', { name }))
		return undefined
	}
	function renameSavedFilter(id: string, rawName: string): SavedRefusal | undefined {
		const name = cleanSavedFilterName(rawName)
		const refusal = nameRefusal(name, id)
		if (refusal) return refusal
		writeSaved(savedFilters.value.map(item => item.id === id ? { ...item, name } : item))
		announce(t('inbox.saved.announce.renamed', { name }))
		return undefined
	}
	function deleteSavedFilter(id: string): void {
		const gone = savedFilters.value.find(item => item.id === id)
		if (!gone) return
		writeSaved(savedFilters.value.filter(item => item.id !== id))
		announce(t('inbox.saved.announce.deleted', { name: gone.name }))
	}
	function applySavedFilter(id: string): void {
		const item = resolvedSaved.value.find(entry => entry.saved.id === id)
		if (!item) return
		replaceQuery(item.filter, selectedId.value)
		savedChanged.value = item.droppedViews ? { id, name: item.saved.name, dropped: item.droppedViews } : undefined
		announce(item.droppedViews ? t('inbox.saved.announce.appliedChanged', { name: item.saved.name, n: item.droppedViews }) : t('inbox.saved.announce.applied', { name: item.saved.name }))
	}

	// -------------------------------------------------------------------------------------------
	// The queue
	// -------------------------------------------------------------------------------------------

	const context = computed(() => ({ ...(me.value ? { me: me.value } : {}), isUnread }))

	/**
	 * The filtered queue in 10a order. The selected thread stays listed (a deep link to a resolved
	 * thread, or a thread just marked seen under "Updated"), so the list and detail never disagree.
	 */
	const groups = computed(() => groupInbox(threads.value.filter(item => item.id === selectedId.value || matchesInboxFilter(item, filter.value, context.value))))
	const ordered = computed(() => groups.value.flatMap(group => group.threads))

	/** Per-status counts under every other filter, for the status tabs (dismissed apart from resolved). */
	const counts = computed(() => {
		const result = { 'ready-for-review': 0, 'open': 0, 'resolved': 0, 'dismissed': 0 }
		for (const item of threads.value) if (matchesInboxFacets(item, filter.value, context.value)) result[item.inboxStatus]++
		return result
	})
	const totals = computed(() => {
		const result = { 'ready-for-review': 0, 'open': 0, 'resolved': 0, 'dismissed': 0 }
		for (const item of threads.value) result[item.inboxStatus]++
		return result
	})

	const selected = computed(() => selectedId.value ? threadById.value.get(selectedId.value) : undefined)
	watch(() => [selected.value?.id, selected.value?.latestActivityAt, !!selected.value?.detail] as const, () => {
		if (selected.value?.detail) markSeen(selected.value)
	}, { immediate: true })

	function neighbour(id: string, step: 1 | -1): string | undefined {
		const list = ordered.value
		const index = list.findIndex(item => item.id === id)
		if (index < 0) return list[0]?.id
		return list[index + step]?.id
	}
	/** The thread to show after `id` leaves the queue (resolve): the next one, else the previous. */
	function successor(id: string): string | undefined {
		return neighbour(id, 1) ?? neighbour(id, -1)
	}

	// -------------------------------------------------------------------------------------------
	// Permissions (accepted identity decisions; direct-resolve decision 9)
	// -------------------------------------------------------------------------------------------

	/** Replying, composing, editing and deleting one's own messages, and re-anchoring need `reviews.write`. */
	const canReply = computed(() => !reviewReadOnly.value)
	/** Submitting for review and reopening need `reviews.submit`. */
	const canSubmit = computed(() => workbench.canWrite('reviews.submit'))
	/**
	 * Resolving needs `reviews.resolve`, a `humanOnly` key: the session's keys hold it only for a
	 * human member on this Workbench cookie session (Rule 01a11c09-bec8-7dee-971a-4c10eaf83eef).
	 */
	const canResolve = computed(() => workbench.canWrite('reviews.resolve'))
	/**
	 * Why the member cannot resolve (`resolveBlock`): a write-blocked Workspace, then an Agent, which
	 * never can, then the missing key; a holder of the key on a write-blocked Workspace is told why.
	 */
	const resolveBlockedReason = computed(() => {
		const code = resolveBlock({ workspaceState: workbench.workspace.value?.inspection?.state, agent: member.value?.kind === 'agent', holdsResolve: access.can('reviews.resolve') })
		return code ? resolveBlockMessage(code, t) : undefined
	})
	/** Promoting to a Decision needs `reviews.promote`. */
	const canPromote = computed(() => workbench.canWrite('reviews.promote'))

	// -------------------------------------------------------------------------------------------
	// Mutations
	// -------------------------------------------------------------------------------------------

	function announce(text: string): void {
		announcement.value = ''
		void nextTick(() => { announcement.value = text })
	}

	/**
	 * Runs one write on a thread against `expectedRevision`, the revision an open step was pinned
	 * to (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb), or else the thread's revision as shown now.
	 */
	async function mutate(threadId: string, action: string, run: (revision: string) => Promise<unknown>, fallback: string, onConflict?: (details: FetchErrorDetails) => void, expectedRevision?: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || busy.value) return false
		busy.value = action
		conflict.value = undefined
		lastError.value = undefined
		const sent = expectedRevision ?? item.revision
		try {
			const response = await run(sent) as MutationResponse | undefined
			// The member's own change is not "updated by others": a reply draft pinned on it follows,
			// moving with the re-read that applies the new revision.
			replyBases.follow(threadId, sent, response?.revision)
			try { await loadSummaries() }
			finally { replyBases.settle(threadId) }
			return true
		}
		catch (cause) {
			const details = describeFetchError(cause, fallback)
			if (details.statusCode === 409 || details.status === 'conflict') {
				conflict.value = threadId
				onConflict?.(details)
				await loadSummaries()
			}
			else if (details.statusCode === 404) {
				// The thread is gone (its author deleted it): say so, and drop it from the queue.
				lastError.value = { threadId, error: { ...details, message: t('comments.gone') } }
				await loadSummaries()
			}
			else lastError.value = { threadId, error: details }
			return false
		}
		finally {
			busy.value = undefined
		}
	}

	function path(threadId: string, action: string): string {
		return `/api/reviews/${encodeURIComponent(threadId)}/${action}`
	}

	/**
	 * Sends the reply draft against the thread's current revision. After a conflict the draft stays
	 * and nothing is resent until the user sends again (Rule 01a11485-f451-72eb-81ad-686aeec7b3eb).
	 */
	async function reply(threadId: string): Promise<boolean> {
		const body = replyDrafts.value[threadId]?.trim()
		const item = threadById.value.get(threadId)
		if (!body || !item || !canReply.value) return false
		const base = replyBases.get(threadId)
		const before = base?.state ?? threadState(item)
		/** A reply that landed drops its pin before the re-read, so no "updated by others" notice flashes for it. */
		const posted = async (request: Promise<MutationResponse>): Promise<MutationResponse> => {
			const response = await request
			replyBases.release(threadId)
			return response
		}
		const ok = await mutate(threadId, 'reply', revision => posted(post(path(threadId, 'messages'), { expectedRevision: base?.revision ?? revision, body })), t('comments.errors.replyFailed'), () => {
			replyBases.release(threadId)
			replyConflict.value = { threadId, before }
		})
		if (ok) {
			replyDrafts.value = { ...replyDrafts.value, [threadId]: '' }
			announce(t('inbox.announce.replied'))
		}
		return ok
	}

	/** The resolution the primary Resolve action sends: accept the submission when ready, else answered. */
	function primaryResolution(thread: InboxThread): ReviewResolution {
		return thread.status === 'ready-for-review' ? 'verified' : 'answered'
	}

	/**
	 * Resolve: `verified` accepts the active ready submission; any other kind closes without a
	 * verified change (direct-resolve decisions 2 and 10). `duplicate` needs a reason.
	 */
	async function resolve(threadId: string, resolution: ReviewResolution, reason?: string, expectedRevision?: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || !canResolve.value || item.status === 'resolved') return false
		const submission = item.detail?.submissions.at(-1)
		if (resolution === 'verified' && (item.status !== 'ready-for-review' || !submission)) return false
		if (resolution === 'duplicate' && !reason?.trim()) return false
		const ok = await mutate(threadId, 'resolve', revision => post(path(threadId, 'resolve'), {
			expectedRevision: revision,
			resolution,
			...(resolution === 'verified' && submission ? { submissionId: submission.id } : {}),
			...(reason?.trim() ? { reason: reason.trim() } : {}),
		}), t('comments.errors.resolveFailed'), undefined, expectedRevision)
		if (ok) announce(t(isDismissal(resolution) ? 'inbox.announce.dismissed' : 'inbox.announce.resolved', { resolution: t(`comments.resolution.${resolution}`) }))
		return ok
	}

	/** The message being edited inline, per thread view; one at a time. */
	const editingMessage = ref<Readonly<{ threadId: string; messageId: string }>>()
	/** The edit is aimed at the thread as it was when editing started (live refresh re-reads it meanwhile). */
	const editBase = createRevisionPin(threadId => threadById.value.get(threadId)?.revision)
	watch(editingMessage, (editing) => {
		if (editing) editBase.pin(editing.threadId)
		else editBase.release()
	}, { flush: 'sync' })

	/**
	 * Edit the viewer's own message (scope/edit decisions 11–15), against the revision the edit
	 * started on. A `conflict` keeps the editor and its text open: the thread is re-read, and Save
	 * tries again on the revision now shown.
	 */
	async function editMessage(threadId: string, messageId: string, body: string): Promise<boolean> {
		if (!canReply.value || !body.trim()) return false
		const ok = await mutate(threadId, 'edit', revision => send(`/api/reviews/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}`, 'PUT', { expectedRevision: revision, body }), t('comments.errors.editFailed'), undefined, editBase.get(threadId))
		if (!ok && conflict.value === threadId) editBase.pin(threadId)
		if (ok) {
			editingMessage.value = undefined
			announce(t('comments.announce.edited'))
		}
		return ok
	}

	/** `retract_engaged` refusals, per thread: the confirm shows it and offers Dismiss instead. */
	const retractRefused = ref<string>()

	/**
	 * Delete the viewer's own unengaged thread (retract addendum). `not_found` means it is already
	 * gone, which counts as done; `retract_engaged` re-reads the thread and explains.
	 */
	/**
	 * The last thread the viewer deleted, with the row that takes its place. The thread's detail
	 * unmounts as soon as it leaves the queue, so the page reacts to this rather than to an event.
	 */
	const deleted = ref<Readonly<{ threadId: string; next: string | undefined; sequence: number }>>()
	let deletedSequence = 0

	async function retract(threadId: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		if (!item || !canReply.value || busy.value) return false
		// The next row in the queue, read before the thread leaves it.
		const next = successor(threadId)
		busy.value = 'retract'
		conflict.value = undefined
		lastError.value = undefined
		retractRefused.value = undefined
		try {
			await send(`/api/reviews/${encodeURIComponent(threadId)}`, 'DELETE', { expectedRevision: item.revision })
		}
		catch (cause) {
			const details = describeFetchError(cause, t('comments.errors.deleteFailed'))
			if (details.statusCode !== 404) {
				if (refusalCode(details) === 'review.retract_engaged') retractRefused.value = threadId
				else if (details.statusCode === 409 || details.status === 'conflict') conflict.value = threadId
				else lastError.value = { threadId, error: details }
				await loadSummaries()
				busy.value = undefined
				return false
			}
		}
		deleted.value = { threadId, next, sequence: ++deletedSequence }
		await loadSummaries()
		busy.value = undefined
		announce(t('comments.announce.deleted'))
		return true
	}

	/**
	 * A new comment from the inbox (scope/edit decision 8): the Workspace, or the root of the View
	 * the reviewer came from. Two writes, as on the canvas; a failed first message keeps the text and
	 * the created thread so Retry posts only the message.
	 */
	const composeState = ref<Readonly<{ created?: Readonly<{ key: string; revision: string }>; error?: FetchErrorDetails; posting: boolean }>>({ posting: false })
	async function createComment(where: Readonly<{ scope: 'workspace' } | { viewId: string }>, body: string): Promise<string | undefined> {
		const text = body.trim()
		if (!text || !canReply.value || composeState.value.posting) return undefined
		let created = composeState.value.created
		composeState.value = { posting: true, ...(created ? { created } : {}) }
		try {
			if (!created) {
				const anchor = 'scope' in where ? { scope: 'workspace' } : { viewId: where.viewId, widgetId: 'root' }
				const response = await post('/api/reviews', { anchor })
				if (!response.key || !response.revision) throw new Error(t('comments.errors.createFailed'))
				created = { key: response.key, revision: response.revision }
			}
			await post(path(created.key, 'messages'), { expectedRevision: created.revision, body: text })
			composeState.value = { posting: false }
			await loadSummaries()
			announce(t('inbox.announce.created'))
			return created.key
		}
		catch (cause) {
			composeState.value = { posting: false, error: describeFetchError(cause, created ? t('comments.errors.messageFailed') : t('comments.errors.createFailed')), ...(created ? { created } : {}) }
			if (created) void loadSummaries()
			return undefined
		}
	}
	function resetCompose(): void {
		if (!composeState.value.posting) composeState.value = { posting: false }
	}

	async function reopen(threadId: string, reason?: string, expectedRevision?: string): Promise<boolean> {
		if (!canSubmit.value) return false
		const ok = await mutate(threadId, 'reopen', revision => post(path(threadId, 'reopen'), { expectedRevision: revision, ...(reason?.trim() ? { reason: reason.trim() } : {}) }), t('comments.errors.reopenFailed'), undefined, expectedRevision)
		if (ok) announce(t('comments.announce.reopened'))
		return ok
	}

	/** A human submission to `ready-for-review` (secondary, desktop-first): domains plus Evidence refs. */
	async function submit(threadId: string, draft: ReviewSubmissionDraft, expectedRevision?: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		const viewId = item?.viewId
		if (!item || !viewId || !canSubmit.value || item.status !== 'open') return false
		const ok = await mutate(threadId, 'submit', async (revision) => {
			const view = await uiux.readResource<ViewRead>('view', viewId)
			if (!view) throw new Error(t('inbox.errors.viewMissing'))
			return await post(path(threadId, 'ready'), submissionBody(draft, view, revision))
		}, t('submit.failed'), undefined, expectedRevision)
		if (ok) announce(t('submit.announce'))
		return ok
	}

	/**
	 * Reads the View, then promotes against both revisions. A conflict names what moved (Rule
	 * 01a11544-611c-73e0-990b-c094b48b3eb6): the thread is re-read here and the View on the next
	 * confirm, which only the user sends; nothing is retried automatically.
	 */
	async function promote(threadId: string, form: Readonly<{ question: string; summary: string; rationale: string }>, expectedRevision?: string): Promise<boolean> {
		const item = threadById.value.get(threadId)
		const viewId = item?.viewId
		if (!item || !viewId || !canPromote.value) return false
		return await mutate(threadId, 'promote', async (revision) => {
			const view = await uiux.readResource<ViewRead>('view', viewId)
			if (!view) throw new Error(t('inbox.errors.viewMissing'))
			return await post(path(threadId, 'promote'), {
				expectedReviewRevision: revision,
				viewId,
				expectedViewRevision: view.revision,
				question: form.question.trim(),
				outcome: { summary: form.summary.trim(), rationale: form.rationale.trim() || form.summary.trim() },
			})
		}, t('comments.errors.promoteFailed'), (details) => { promoteConflict.value = { threadId, moved: promoteMovedOf(details) } }, expectedRevision)
	}

	// -------------------------------------------------------------------------------------------
	// Canvas hand-offs
	// -------------------------------------------------------------------------------------------

	/** The reader's current Preview context selections (empty members are the defaults). */
	function readerContext(): CanvasLinkContext {
		return { locale: workbench.selectedLocale.value, viewport: workbench.selectedViewportId.value, theme: workbench.selectedThemeId.value }
	}

	function shows(context: CanvasLinkContext) {
		return effectiveRenderContext(workbench.workspace.value?.resource, workbench.discoveredLocales.value, context)
	}

	/**
	 * Opens the thread on its canvas in its recorded context (Rule 01a116f0-8ec3): its View, its
	 * Variant when scoped to one, the recorded Locale, viewport and theme, the thread open; never the
	 * chrome language or theme (Rule 01a118a1-9e11). The recorded keys are checked against the
	 * Workspace's settings now, and one that no longer exists opens with its default and a notice
	 * naming it (Rule 01a1170f-c165). When this changes what the Preview shows, the reader's own
	 * context is kept so the thread header can offer it instead (Rule 01a1170f-c11d).
	 */
	async function openInCanvas(thread: InboxThread): Promise<void> {
		if (!thread.viewId || !threadViewExists(thread)) return
		const viewId = thread.viewId
		const link = inboxCanvasLink(thread, thread.renderContext ? await recordedContext.keysAtOpen() : workbench.renderContextKeys.value)
		const before = readerContext()
		const after = shows({ locale: link.options.locale, viewport: link.options.viewport, theme: link.options.theme })
		const current = shows(before)
		const changes = after.locale !== current.locale || after.viewportId !== current.viewportId || after.themeId !== current.themeId
		workbench.contextBeforeThread.value = changes
			? { threadId: thread.id, locale: before.locale ?? '', viewport: before.viewport ?? '', theme: before.theme ?? '' }
			: undefined
		const failure = await router.push(viewLocation(viewId, link.options))
		if (!failure) recordedContext.noticeMissingContext(link.missing)
	}

	/** "Open in current context" (Rule 01a1170f-c11d): the same canvas link in the reader's own Preview context. */
	function openInCurrentContext(thread: InboxThread): void {
		if (!thread.viewId || !threadViewExists(thread)) return
		workbench.contextBeforeThread.value = undefined
		void navigateTo(viewLocation(thread.viewId, canvasLinkOptions(thread, readerContext())))
	}

	function threadViewExists(thread: InboxThread): boolean {
		return !!thread.viewId && views.value.some(view => view.key === thread.viewId)
	}

	/**
	 * Re-anchor happens on the canvas (brief c): open the View with the thread, then enter
	 * re-anchor targeting once that View is loaded. The watcher outlives this page and stops itself.
	 */
	function reanchorOnCanvas(thread: InboxThread): void {
		if (!thread.viewId || !canReply.value || !threadViewExists(thread)) return
		const viewId = thread.viewId
		void router.push(viewLocation(viewId, { thread: thread.id })).then(() => {
			const scope = effectScope(true)
			const timer = setTimeout(() => scope.stop(), 15_000)
			scope.run(() => {
				watch(() => workbench.selectedView.value?.key, (key) => {
					if (key !== viewId || !router.currentRoute.value.path.startsWith('/views/')) return
					preview.startReanchor(thread.id)
					clearTimeout(timer)
					void nextTick(() => scope.stop())
				}, { immediate: true })
			})
		})
	}

	/** The absolute link to this thread in the inbox. */
	function threadLink(threadId: string): string {
		return new URL(router.resolve({ path: '/reviews', query: { thread: threadId } }).href, window.location.href).toString()
	}

	return {
		filter,
		setFilter,
		clearFilters,
		savedFilters,
		canSaveFilters,
		activeSavedId,
		savedNotice,
		saveCurrentFilter,
		renameSavedFilter,
		deleteSavedFilter,
		applySavedFilter,
		selectedId,
		select,
		selected,
		loading,
		loaded,
		loadError,
		loadSummaries,
		details,
		detailErrors,
		threads,
		threadById,
		groups,
		ordered,
		counts,
		totals,
		neighbour,
		successor,
		member,
		me,
		isUnread,
		markSeen,
		canReply,
		canSubmit,
		canResolve,
		resolveBlockedReason,
		canPromote,
		busy,
		conflict,
		replyConflict,
		/** What changed elsewhere since a reply draft was pinned, and its acknowledgement (Rule 01a11485-f434). */
		replyUpdated: replyBases.updated,
		acknowledgeReplyUpdate: replyBases.acknowledge,
		promoteConflict,
		lastError,
		replyDrafts,
		announcement,
		announce,
		reply,
		resolve,
		reopen,
		submit,
		promote,
		editingMessage,
		editMessage,
		retract,
		retractRefused,
		deleted,
		composeState,
		createComment,
		resetCompose,
		primaryResolution,
		openInCanvas,
		openInCurrentContext,
		threadViewExists,
		reanchorOnCanvas,
		threadLink,
	}
}

export type ReviewInbox = ReturnType<typeof createReviewInbox>

const INBOX_KEY: InjectionKey<ReviewInbox> = Symbol('uiux-review-inbox')

/** Provided by the Reviews page (below `provideWorkbench()`). */
export function provideReviewInbox(): ReviewInbox {
	const inbox = createReviewInbox()
	provide(INBOX_KEY, inbox)
	return inbox
}

export function useReviewInbox(): ReviewInbox {
	const inbox = inject(INBOX_KEY)
	if (!inbox) throw new Error('useReviewInbox() must be used below provideReviewInbox().')
	return inbox
}
