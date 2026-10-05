import type { LocationQuery, LocationQueryRaw } from 'vue-router'
import {
	REVIEW_RESOLUTIONS,
	type ReviewActor,
	type ReviewAnchor,
	type ReviewResolution,
	type ReviewStatus,
	type ReviewThread,
} from '../../src/domain/reviews/schema'
import { buildReviewTimeline } from './review-timeline'

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
export const DEFAULT_INBOX_STATUS: readonly ReviewStatus[] = ['ready-for-review', 'open']
export const INBOX_RESOLUTIONS: readonly ReviewResolution[] = REVIEW_RESOLUTIONS
/** The Variant-scope filter token for View-wide threads (`variantNames: []`). */
export const VIEW_WIDE_SCOPE = '*'

export type AnchorState = 'valid' | 'stale' | 'missing'
export const ANCHOR_STATES: readonly AnchorState[] = ['valid', 'stale', 'missing']

export type InboxFilter = Readonly<{
	/** Statuses shown; empty means every status. */
	status: readonly ReviewStatus[]
	/** Narrows resolved threads to these resolution kinds; empty means any. */
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
	anchor?: ReviewAnchor
	variantNames: readonly string[]
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
	const view = anchor && views ? views.get(anchor.viewId) : undefined
	let anchorState: AnchorState = 'valid'
	let missingVariants: readonly string[] = []
	let widgetType: string | undefined
	if (anchor && views) {
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
		status: summary.summary.status ?? detail?.status ?? 'open',
		...(summary.summary.resolution ? { resolution: summary.summary.resolution } : {}),
		...(anchor ? { anchor } : {}),
		variantNames,
		messageCount: summary.summary.messageCount ?? detail?.messages.length ?? 0,
		...(summary.summary.latestActivityAt ? { latestActivityAt: summary.summary.latestActivityAt } : {}),
		diagnosticCount: summary.diagnosticCount ?? 0,
		...(detail ? { detail } : {}),
		...(first ? { author: first.actor, title: first.body } : {}),
		...(timeline.length ? { latestActor: timeline.at(-1)!.actor } : {}),
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

export function statusRank(status: ReviewStatus): number {
	return status === 'ready-for-review' ? 0 : status === 'open' ? 1 : 2
}

function activity(thread: Pick<InboxThread, 'latestActivityAt'>): number {
	const value = Date.parse(thread.latestActivityAt ?? '')
	return Number.isNaN(value) ? 0 : value
}

/** Ready before open (then resolved), then latest activity descending, then id for stability. */
export function compareInboxThreads(a: Pick<InboxThread, 'id' | 'status' | 'latestActivityAt'>, b: Pick<InboxThread, 'id' | 'status' | 'latestActivityAt'>): number {
	return statusRank(a.status) - statusRank(b.status)
		|| activity(b) - activity(a)
		|| a.id.localeCompare(b.id)
}

export function orderInbox<T extends Pick<InboxThread, 'id' | 'status' | 'latestActivityAt'>>(threads: readonly T[]): T[] {
	return [...threads].sort(compareInboxThreads)
}

export type InboxGroup<T> = Readonly<{ status: ReviewStatus; threads: readonly T[] }>

/** Groups an ordered list by status, in group order, leaving out empty groups. */
export function groupInbox<T extends Pick<InboxThread, 'id' | 'status' | 'latestActivityAt'>>(threads: readonly T[]): readonly InboxGroup<T>[] {
	const ordered = orderInbox(threads)
	return REVIEW_STATUSES
		.map(status => ({ status, threads: ordered.filter(thread => thread.status === status) }))
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
	const messages = thread.detail?.messages.map(message => message.body).join('\n') ?? thread.title ?? ''
	return [messages, thread.anchor?.widgetId, thread.viewName, thread.widgetType, thread.variantNames.join(' '), thread.author?.displayName]
		.filter(Boolean).join('\n').toLowerCase()
}

/** Every filter except status and resolution: the counts on the status tabs use this. */
export function matchesInboxFacets(thread: InboxThread, filter: InboxFilter, context: InboxFilterContext = {}): boolean {
	if (filter.views.length && !(thread.anchor && filter.views.includes(thread.anchor.viewId))) return false
	if (filter.scopes.length) {
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
	if (filter.status.length && !filter.status.includes(thread.status)) return false
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

/** `status=all` shows every status; an absent `status` is the default queue. */
export function parseInboxQuery(query: LocationQuery): InboxFilter {
	const statusValues = list(query.status)
	const named = only(statusValues, REVIEW_STATUSES)
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
	const ordered = REVIEW_STATUSES.filter(status => filter.status.includes(status))
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
