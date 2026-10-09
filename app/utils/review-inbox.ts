import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import {
	isWidgetAnchor,
	REVIEW_RESOLUTIONS,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewRenderContext,
	type ReviewResolution,
	type ReviewStatus,
	type ReviewThread,
} from '../../src/domain/reviews/schema'
import { buildReviewTimeline, latestTimelineActor } from './review-timeline'
import type { ViewLinkOptions } from './workbench-routes'
import { resolveRecordedContext, type MissingRenderContextKey, type RenderContextKeys } from '../../src/preview/render-context-options'

/**
 * The Reviews inbox model (brief d; Part 7 10a). Pure functions, so the ordering, filtering and
 * deep-link contract are testable without a browser.
 *
 * - The default queue hides resolved threads, puts `ready-for-review` before `open`, and sorts each
 *   group by latest canonical timeline activity, newest first.
 * - Filters are client-side over the loaded summaries (plus point reads for author, title and
 *   change domains). Author filtering stays client-side: a server-side author filter would extend
 *   the Review query contract (Part 7 9b).
 */

export const REVIEW_STATUSES: readonly ReviewStatus[] = ['ready-for-review', 'open', 'resolved']
/**
 * The inbox's statuses (Dismiss presentation, retract addendum decision 11): `dismissed` is a UI
 * pseudo-status for threads resolved as `obsolete`, `duplicate` or `wont-fix`; `resolved` then
 * means `verified` or `answered`. The canonical lifecycle and resolution enum are unchanged.
 */
export type InboxStatus = ReviewStatus | 'dismissed'
export const INBOX_STATUSES: readonly InboxStatus[] = ['ready-for-review', 'open', 'resolved', 'dismissed']
export const DEFAULT_INBOX_STATUS: readonly InboxStatus[] = ['ready-for-review', 'open']
export const INBOX_RESOLUTIONS: readonly ReviewResolution[] = REVIEW_RESOLUTIONS
/** The Resolve group of the resolve menu, and what the Resolved filter covers. */
export const RESOLVE_RESOLUTIONS: readonly ReviewResolution[] = ['answered', 'verified']
/** The Dismiss group: No longer relevant, Duplicate, Won't do. */
export const DISMISS_RESOLUTIONS: readonly ReviewResolution[] = ['obsolete', 'duplicate', 'wont-fix']
/** The Variant-scope filter token for View-wide threads (`variantNames: []`). */
export const VIEW_WIDE_SCOPE = '*'
/** The View-facet token for Workspace-scoped threads (`view=workspace`; View ids are UUIDs, so it cannot collide). */
export const WORKSPACE_VIEW_TOKEN = 'workspace'

export function isDismissal(resolution: ReviewResolution | undefined): boolean {
	return !!resolution && DISMISS_RESOLUTIONS.includes(resolution)
}

/** The status a thread is listed under: resolved threads closed by a dismissal are `dismissed`. */
export function inboxStatusOf(status: ReviewStatus, resolution: ReviewResolution | undefined): InboxStatus {
	return status === 'resolved' && isDismissal(resolution) ? 'dismissed' : status
}

export type AnchorState = 'valid' | 'stale' | 'missing'
export const ANCHOR_STATES: readonly AnchorState[] = ['valid', 'stale', 'missing']

export type InboxFilter = Readonly<{
	/** Statuses shown (`dismissed` is the UI pseudo-status); empty means every status. */
	status: readonly InboxStatus[]
	/** Narrows resolved and dismissed threads to these resolution kinds; empty means any. */
	resolution: readonly ReviewResolution[]
	views: readonly string[]
	/** Variant names, or `VIEW_WIDE_SCOPE`. */
	scopes: readonly string[]
	/** Thread starters, by `actorKey`. */
	authors: readonly string[]
	anchor: readonly AnchorState[]
	domains: readonly string[]
	/** Threads the signed-in member started or took part in. */
	mine: boolean
	/** Threads updated since this browser last showed them to the member. */
	unread: boolean
	search: string
}>

export const DEFAULT_INBOX_FILTER: InboxFilter = Object.freeze({
	status: DEFAULT_INBOX_STATUS,
	resolution: [],
	views: [],
	scopes: [],
	authors: [],
	anchor: [],
	domains: [],
	mine: false,
	unread: false,
	search: '',
})

/** What the inbox knows about one thread: its summary, plus its point read once it arrived. */
export type InboxThread = Readonly<{
	id: string
	revision: string
	status: ReviewStatus
	resolution?: ReviewResolution
	/** Where the inbox lists it: the status, or `dismissed` for a dismissal. */
	inboxStatus: InboxStatus
	anchor?: ReviewAnchor
	/** `workspace` for a Workspace-scoped thread, else `view` (a View root or a Widget). */
	scope: 'workspace' | 'view'
	/** The anchored View and Widget; undefined for a Workspace thread. */
	viewId?: string
	widgetId?: string
	variantNames: readonly string[]
	/** The Locale, viewport and theme a Widget thread records; absent means unknown (never on a Workspace thread). */
	renderContext?: ReviewRenderContext
	messageCount: number
	latestActivityAt?: string
	/** Validation findings in the thread file. */
	diagnosticCount: number
	detail?: ReviewThread
	/** The first message's actor. */
	author?: ReviewActor
	/** The first message: the row and detail title. */
	title?: string
	/** Who moved the thread last (the newest timeline item). */
	latestActor?: ReviewActor
	/** Every actor in the timeline, by `actorKey`. */
	participants: readonly string[]
	/** Change domains of every submission, in first-seen order. */
	domains: readonly string[]
	anchorState: AnchorState
	/** The anchored View's name, when the View exists. */
	viewName?: string
	/** Named Variants of the scope that the View no longer defines. */
	missingVariants: readonly string[]
	/** The anchored Widget's Catalog type, when the View IR has it. */
	widgetType?: string
}>

export type ReviewSummaryInput = Readonly<{
	key: string
	revision: string
	diagnosticCount?: number
	summary: Readonly<{
		anchor?: ReviewAnchor
		variantNames?: readonly string[]
		renderContext?: ReviewRenderContext
		status?: ReviewStatus
		resolution?: ReviewResolution
		messageCount?: number
		latestActivityAt?: string
	}>
}>

/** What the inbox knows about an anchored View (its summary, plus its IR once read). */
export type InboxViewInfo = Readonly<{
	name?: string
	/** Widget ids of the View IR; `undefined` until read (or when the IR is invalid). */
	widgetTypes?: ReadonlyMap<string, string>
	/** Named Variants the View defines; `undefined` until read. */
	variants?: ReadonlySet<string>
}>

/** A stable key for an actor: the server-stamped id, else the recorded name (older records). */
export function actorKey(actor: ReviewActor | undefined): string {
	if (!actor) return 'unknown'
	return actor.id ?? `name:${actor.displayName ?? actor.type}`
}

export function buildInboxThread(
	summary: ReviewSummaryInput,
	detail: ReviewThread | undefined,
	views: ReadonlyMap<string, InboxViewInfo> | undefined,
): InboxThread {
	const anchor = summary.summary.anchor ?? detail?.anchor
	const variantNames = summary.summary.variantNames ?? detail?.variantNames ?? []
	const first = detail?.messages[0]
	const timeline = detail ? buildReviewTimeline(detail) : []
	const participants = [...new Set(timeline.map(item => actorKey(item.actor)))]
	const domains = [...new Set(detail?.submissions.flatMap(submission => submission.changeDomains) ?? [])]
	const widgetAnchor = isWidgetAnchor(anchor) ? anchor : undefined
	const view = widgetAnchor && views ? views.get(widgetAnchor.viewId) : undefined
	// A Workspace anchor always resolves: it is the server's own selected Workspace.
	let anchorState: AnchorState = 'valid'
	let missingVariants: readonly string[] = []
	let widgetType: string | undefined
	const status = summary.summary.status ?? detail?.status ?? 'open'
	const renderContext = widgetAnchor ? summary.summary.renderContext ?? detail?.renderContext : undefined
	if (widgetAnchor && views) {
		const anchor = widgetAnchor
		if (!view) anchorState = 'missing'
		else {
			if (view.widgetTypes) {
				widgetType = view.widgetTypes.get(anchor.widgetId)
				if (anchor.widgetId !== 'root' && !view.widgetTypes.has(anchor.widgetId)) anchorState = 'missing'
			}
			if (view.variants) {
				missingVariants = variantNames.filter(name => !view.variants!.has(name))
				if (anchorState === 'valid' && missingVariants.length) anchorState = 'stale'
			}
		}
	}
	return Object.freeze({
		id: summary.key,
		revision: summary.revision,
		status,
		...(summary.summary.resolution ? { resolution: summary.summary.resolution } : {}),
		inboxStatus: inboxStatusOf(status, summary.summary.resolution),
		...(anchor ? { anchor } : {}),
		scope: anchor && !widgetAnchor ? 'workspace' : 'view',
		...(widgetAnchor ? { viewId: widgetAnchor.viewId, widgetId: widgetAnchor.widgetId } : {}),
		variantNames,
		...(renderContext ? { renderContext } : {}),
		messageCount: summary.summary.messageCount ?? detail?.messages.length ?? 0,
		...(summary.summary.latestActivityAt ? { latestActivityAt: summary.summary.latestActivityAt } : {}),
		diagnosticCount: summary.diagnosticCount ?? 0,
		...(detail ? { detail } : {}),
		...(first ? { author: first.actor, title: first.body } : {}),
		...(detail && timeline.length ? { latestActor: latestTimelineActor(detail)! } : {}),
		participants,
		domains,
		anchorState,
		...(view?.name ? { viewName: view.name } : {}),
		missingVariants,
		...(widgetType ? { widgetType } : {}),
	})
}

// ---------------------------------------------------------------------------------------------
// Ordering (Part 7 10a)
// ---------------------------------------------------------------------------------------------

export function statusRank(status: InboxStatus): number {
	return status === 'ready-for-review' ? 0 : status === 'open' ? 1 : status === 'resolved' ? 2 : 3
}

type Orderable = Pick<InboxThread, 'id' | 'status' | 'latestActivityAt'> & Partial<Pick<InboxThread, 'inboxStatus'>>

function listedStatus(thread: Orderable): InboxStatus {
	return thread.inboxStatus ?? thread.status
}

function activity(thread: Pick<InboxThread, 'latestActivityAt'>): number {
	const value = Date.parse(thread.latestActivityAt ?? '')
	return Number.isNaN(value) ? 0 : value
}

/** Ready before open, then resolved, then dismissed; then latest activity descending, then id for stability. */
export function compareInboxThreads(a: Orderable, b: Orderable): number {
	return statusRank(listedStatus(a)) - statusRank(listedStatus(b))
		|| activity(b) - activity(a)
		|| a.id.localeCompare(b.id)
}

export function orderInbox<T extends Orderable>(threads: readonly T[]): T[] {
	return [...threads].sort(compareInboxThreads)
}

export type InboxGroup<T> = Readonly<{ status: InboxStatus; threads: readonly T[] }>

/** Groups an ordered list by listed status, in group order, leaving out empty groups. */
export function groupInbox<T extends Orderable>(threads: readonly T[]): readonly InboxGroup<T>[] {
	const ordered = orderInbox(threads)
	return INBOX_STATUSES
		.map(status => ({ status, threads: ordered.filter(thread => listedStatus(thread) === status) }))
		.filter(group => group.threads.length > 0)
}

// ---------------------------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------------------------

export type InboxFilterContext = Readonly<{
	/** The signed-in member's actor key (`member:<id>`), for "mine". */
	me?: string
	isUnread?: (thread: InboxThread) => boolean
}>

function searchable(thread: InboxThread): string {
	// Current text only: earlier versions of edited messages are not searchable (R14).
	const messages = thread.detail?.messages.map(message => message.body).join('\n') ?? thread.title ?? ''
	return [messages, thread.scope === 'workspace' ? WORKSPACE_VIEW_TOKEN : thread.widgetId, thread.viewName, thread.widgetType, thread.variantNames.join(' '), thread.author?.displayName]
		.filter(Boolean).join('\n').toLowerCase()
}

/** Every filter except status and resolution: the counts on the status tabs use this. */
export function matchesInboxFacets(thread: InboxThread, filter: InboxFilter, context: InboxFilterContext = {}): boolean {
	if (filter.views.length && !filter.views.includes(thread.scope === 'workspace' ? WORKSPACE_VIEW_TOKEN : thread.viewId ?? '')) return false
	if (filter.scopes.length) {
		// Workspace threads have no Variant scope, so a Variant-scope facet excludes them.
		if (thread.scope === 'workspace') return false
		const scopes = thread.variantNames.length ? thread.variantNames : [VIEW_WIDE_SCOPE]
		if (!scopes.some(scope => filter.scopes.includes(scope))) return false
	}
	if (filter.authors.length && !filter.authors.includes(actorKey(thread.author))) return false
	if (filter.anchor.length && !filter.anchor.includes(thread.anchorState)) return false
	if (filter.domains.length && !thread.domains.some(domain => filter.domains.includes(domain))) return false
	if (filter.mine && !(context.me && thread.participants.includes(context.me))) return false
	if (filter.unread && !context.isUnread?.(thread)) return false
	const search = filter.search.trim().toLowerCase()
	if (search && !searchable(thread).includes(search)) return false
	return true
}

export function matchesInboxFilter(thread: InboxThread, filter: InboxFilter, context: InboxFilterContext = {}): boolean {
	if (filter.status.length && !filter.status.includes(thread.inboxStatus)) return false
	if (filter.resolution.length && thread.status === 'resolved' && !(thread.resolution && filter.resolution.includes(thread.resolution))) return false
	return matchesInboxFacets(thread, filter, context)
}

/** How many structured filters narrow the queue beyond the default status set (for the Filters badge). */
export function activeFacetCount(filter: InboxFilter): number {
	return [filter.views, filter.scopes, filter.authors, filter.anchor, filter.domains, filter.resolution].filter(list => list.length > 0).length
}

// ---------------------------------------------------------------------------------------------
// Unread ("updated since you last looked"), per browser and member
// ---------------------------------------------------------------------------------------------

export type SeenMarks = Readonly<Record<string, string>>

/**
 * A thread is unread when it moved after this browser last showed it to the member, unless the
 * member made that move. A thread never shown is unread.
 */
export function isUnreadThread(thread: Pick<InboxThread, 'id' | 'latestActivityAt' | 'latestActor'>, seen: SeenMarks, me: string | undefined): boolean {
	if (!thread.latestActivityAt) return false
	if (me && thread.latestActor && actorKey(thread.latestActor) === me) return false
	const mark = seen[thread.id]
	if (!mark) return true
	return Date.parse(thread.latestActivityAt) > Date.parse(mark)
}

// ---------------------------------------------------------------------------------------------
// Deep links: `/reviews?status=…&view=…&thread=…`
// ---------------------------------------------------------------------------------------------

function list(value: LocationQuery[string] | undefined): string[] {
	const raw = (Array.isArray(value) ? value : [value]).filter((item): item is string => typeof item === 'string')
	return [...new Set(raw.flatMap(item => item.split(',')).map(item => item.trim()).filter(Boolean))]
}

function single(value: LocationQuery[string] | undefined): string {
	const first = Array.isArray(value) ? value[0] : value
	return typeof first === 'string' ? first : ''
}

function only<T extends string>(values: readonly string[], allowed: readonly T[]): T[] {
	return values.filter((value): value is T => (allowed as readonly string[]).includes(value))
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every(item => b.includes(item))
}

/** `status=all` shows every status; an absent `status` is the default queue; `status=dismissed` is the UI pseudo-status. */
export function parseInboxQuery(query: LocationQuery): InboxFilter {
	const statusValues = list(query.status)
	const named = only(statusValues, INBOX_STATUSES)
	const status = statusValues.includes('all') ? [] : named.length ? named : [...DEFAULT_INBOX_STATUS]
	return {
		status,
		resolution: only(list(query.resolution), INBOX_RESOLUTIONS),
		views: list(query.view),
		scopes: list(query.variant),
		authors: list(query.author),
		anchor: only(list(query.anchor), ANCHOR_STATES),
		domains: list(query.domain),
		mine: single(query.mine) === '1',
		unread: single(query.unread) === '1',
		search: single(query.q),
	}
}

export function inboxQuery(filter: InboxFilter, thread?: string): LocationQueryRaw {
	const query: LocationQueryRaw = {}
	const ordered = INBOX_STATUSES.filter(status => filter.status.includes(status))
	if (!filter.status.length) query.status = 'all'
	else if (!sameSet(ordered, DEFAULT_INBOX_STATUS)) query.status = ordered.join(',')
	if (filter.resolution.length) query.resolution = INBOX_RESOLUTIONS.filter(item => filter.resolution.includes(item)).join(',')
	if (filter.views.length) query.view = filter.views.join(',')
	if (filter.scopes.length) query.variant = filter.scopes.join(',')
	if (filter.authors.length) query.author = filter.authors.join(',')
	if (filter.anchor.length) query.anchor = ANCHOR_STATES.filter(item => filter.anchor.includes(item)).join(',')
	if (filter.domains.length) query.domain = filter.domains.join(',')
	if (filter.mine) query.mine = '1'
	if (filter.unread) query.unread = '1'
	if (filter.search.trim()) query.q = filter.search.trim()
	if (thread) query.thread = thread
	return query
}

// ---------------------------------------------------------------------------------------------
// Canvas links (Rules 01a116f0-8ec3, 01a1170f-c11d, 01a1170f-c165)
// ---------------------------------------------------------------------------------------------

/** A Preview render context as View link query values; empty means the effective default. */
export type CanvasLinkContext = Readonly<{ locale?: string; viewport?: string; theme?: string }>

/**
 * A Widget thread's View link options: the thread open, its Widget while the anchor is valid, the
 * Variant only when the thread is scoped to exactly one existing Variant, and `context`. Never the
 * chrome language or theme (Rule 01a118a1-9e11).
 */
export function canvasLinkOptions(thread: InboxThread, context: CanvasLinkContext = {}): ViewLinkOptions {
	const variant = thread.variantNames.length === 1 && !thread.missingVariants.length ? thread.variantNames[0] : undefined
	return {
		thread: thread.id,
		...(variant ? { variant } : {}),
		...(context.locale ? { locale: context.locale } : {}),
		...(context.viewport ? { viewport: context.viewport } : {}),
		...(context.theme ? { theme: context.theme } : {}),
		...(thread.anchorState === 'valid' && thread.widgetId ? { widget: thread.widgetId } : {}),
	}
}

/**
 * The inbox's canvas link (Rule 01a116f0-8ec3): it carries every recorded member that still
 * exists; a stale one is left out, so it opens with its default, and is returned in `missing`
 * for the notice (Rule 01a1170f-c165). Without `keys` (the manifest is not read yet) every
 * recorded member is carried. Members the thread does not record open with their default.
 */
export function inboxCanvasLink(thread: InboxThread, keys: RenderContextKeys | undefined): Readonly<{ options: ViewLinkOptions; missing: readonly MissingRenderContextKey[] }> {
	const resolved = keys ? resolveRecordedContext(thread.renderContext, keys) : { applied: thread.renderContext ?? {}, missing: [] }
	const { locale, viewportId, themeId } = resolved.applied
	return { options: canvasLinkOptions(thread, { locale, viewport: viewportId, theme: themeId }), missing: resolved.missing }
}

