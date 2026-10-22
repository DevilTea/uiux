import { inboxQuery, parseInboxQuery, WORKSPACE_VIEW_TOKEN, type InboxFilter } from './review-inbox'

/**
 * Per-browser saved filters of the Reviews inbox (issue #62). A saved filter is a name and the
 * `inboxQuery(filter)` output, so it stays URL-compatible and round-trips through
 * `parseInboxQuery`. This is Workbench UI state in `localStorage`, never Workspace data.
 */

export type SavedInboxFilter = Readonly<{ id: string; name: string; query: Readonly<Record<string, string>> }>

export const SAVED_FILTERS_STORAGE_PREFIX = 'uiux.reviews.savedFilters:'
/** At most this many saved filters per Workspace and member; the rest of a stored list is ignored. */
export const MAX_SAVED_FILTERS = 20
/** A saved filter's name is trimmed and cut to this many characters. */
export const MAX_SAVED_FILTER_NAME = 40
const MAX_QUERY_VALUE = 2000

export function savedFiltersKey(workspace: string | undefined, memberId: string | undefined): string {
	return `${SAVED_FILTERS_STORAGE_PREFIX}${workspace ?? 'unknown'}:${memberId ?? 'anonymous'}`
}

export function cleanSavedFilterName(name: string): string {
	return name.replace(/\s+/g, ' ').trim().slice(0, MAX_SAVED_FILTER_NAME).trim()
}

/** The filter as a flat string query (no `thread`), the shape that is stored. */
export function savedFilterQuery(filter: InboxFilter): Readonly<Record<string, string>> {
	const query: Record<string, string> = {}
	for (const [key, value] of Object.entries(inboxQuery(filter)))
		if (typeof value === 'string') query[key] = value
	return query
}

/** A stored query, normalized through the inbox parser: unknown keys and values are dropped. */
function normalizeQuery(value: unknown): Readonly<Record<string, string>> | undefined {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
	const raw: Record<string, string> = {}
	for (const [key, item] of Object.entries(value)) {
		if (typeof item !== 'string' || item.length > MAX_QUERY_VALUE) return undefined
		raw[key] = item
	}
	return savedFilterQuery(parseInboxQuery(raw))
}

/** Reads a stored list defensively: malformed JSON, malformed entries and duplicate ids are ignored. */
export function parseSavedFilters(raw: string | null | undefined): SavedInboxFilter[] {
	if (!raw) return []
	let value: unknown
	try { value = JSON.parse(raw) }
	catch { return [] }
	if (!Array.isArray(value)) return []
	const result: SavedInboxFilter[] = []
	const ids = new Set<string>()
	for (const entry of value) {
		if (result.length >= MAX_SAVED_FILTERS) break
		if (!entry || typeof entry !== 'object') continue
		const { id, name, query } = entry as Record<string, unknown>
		if (typeof id !== 'string' || !id || id.length > 100 || ids.has(id)) continue
		if (typeof name !== 'string') continue
		const clean = cleanSavedFilterName(name)
		const normalized = normalizeQuery(query)
		if (!clean || !normalized) continue
		ids.add(id)
		result.push({ id, name: clean, query: normalized })
	}
	return result
}

export function serializeSavedFilters(filters: readonly SavedInboxFilter[]): string {
	return JSON.stringify(filters.slice(0, MAX_SAVED_FILTERS).map(({ id, name, query }) => ({ id, name, query })))
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every(item => b.includes(item))
}

/** Whether two filters select the same threads, ignoring the order of list values. */
export function sameInboxFilter(a: InboxFilter, b: InboxFilter): boolean {
	return sameSet(a.status, b.status)
		&& sameSet(a.resolution, b.resolution)
		&& sameSet(a.views, b.views)
		&& sameSet(a.scopes, b.scopes)
		&& sameSet(a.authors, b.authors)
		&& sameSet(a.anchor, b.anchor)
		&& sameSet(a.domains, b.domains)
		&& a.mine === b.mine
		&& a.unread === b.unread
		&& a.search.trim() === b.search.trim()
}

export type ResolvedSavedFilter = Readonly<{ filter: InboxFilter; droppedViews: number }>

/**
 * The saved filter as it applies now: View facets that no longer exist are dropped (the Workspace
 * token stays). Without `viewIds` (the Views are not loaded yet) nothing is dropped.
 */
export function resolveSavedFilter(saved: SavedInboxFilter, viewIds: ReadonlySet<string> | undefined): ResolvedSavedFilter {
	const filter = parseInboxQuery(saved.query)
	if (!viewIds) return { filter, droppedViews: 0 }
	const views = filter.views.filter(id => id === WORKSPACE_VIEW_TOKEN || viewIds.has(id))
	return { filter: { ...filter, views }, droppedViews: filter.views.length - views.length }
}
