import { describe, expect, it } from 'vitest'
import { DEFAULT_INBOX_FILTER, inboxQuery, parseInboxQuery, WORKSPACE_VIEW_TOKEN, type InboxFilter } from '../app/utils/review-inbox'
import {
	cleanSavedFilterName,
	MAX_SAVED_FILTER_NAME,
	MAX_SAVED_FILTERS,
	parseSavedFilters,
	resolveSavedFilter,
	sameInboxFilter,
	savedFilterQuery,
	savedFiltersKey,
	serializeSavedFilters,
} from '../app/utils/saved-inbox-filters'

const filter: InboxFilter = {
	...DEFAULT_INBOX_FILTER,
	status: ['ready-for-review'],
	views: ['view-a', WORKSPACE_VIEW_TOKEN],
	anchor: ['stale'],
	domains: ['i18n'],
	mine: true,
	search: ' title ',
}

describe('saved inbox filters (issue #62)', () => {
	it('keys the storage per Workspace and member', () => {
		expect(savedFiltersKey('/w', 'mei')).toBe('uiux.reviews.savedFilters:/w:mei')
		expect(savedFiltersKey(undefined, undefined)).toBe('uiux.reviews.savedFilters:unknown:anonymous')
	})

	it('stores the inboxQuery output and round-trips through parseInboxQuery', () => {
		const query = savedFilterQuery(filter)
		expect(query).toEqual(inboxQuery(filter))
		expect(sameInboxFilter(parseInboxQuery(query), filter)).toBe(true)
		const stored = serializeSavedFilters([{ id: 'a', name: 'Mine, stale', query }])
		expect(parseSavedFilters(stored)).toEqual([{ id: 'a', name: 'Mine, stale', query }])
	})

	it('ignores malformed storage instead of throwing', () => {
		for (const raw of [undefined, null, '', 'not json', '{}', '"x"', '42', 'null']) expect(parseSavedFilters(raw)).toEqual([])
	})

	it('drops malformed entries and keeps the valid ones', () => {
		const raw = JSON.stringify([
			null,
			'string',
			{ id: 1, name: 'x', query: {} },
			{ id: 'no-name', query: {} },
			{ id: 'blank', name: '   ', query: {} },
			{ id: 'bad-query', name: 'q', query: ['status'] },
			{ id: 'bad-value', name: 'q', query: { view: 3 } },
			{ id: 'ok', name: '  Ready   now ', query: { status: 'ready-for-review', bogus: 'x', anchor: 'nope,stale' } },
			{ id: 'ok', name: 'duplicate id', query: {} },
		])
		expect(parseSavedFilters(raw)).toEqual([{ id: 'ok', name: 'Ready now', query: { status: 'ready-for-review', anchor: 'stale' } }])
	})

	it('caps the count and the name length', () => {
		const many = Array.from({ length: MAX_SAVED_FILTERS + 5 }, (_, index) => ({ id: `id-${index}`, name: `n${index}`, query: {} }))
		expect(parseSavedFilters(JSON.stringify(many))).toHaveLength(MAX_SAVED_FILTERS)
		expect(cleanSavedFilterName('x'.repeat(MAX_SAVED_FILTER_NAME + 20))).toHaveLength(MAX_SAVED_FILTER_NAME)
		expect(parseSavedFilters(JSON.stringify([{ id: 'a', name: 'y'.repeat(500), query: {} }]))[0]?.name).toHaveLength(MAX_SAVED_FILTER_NAME)
	})

	it('compares filters ignoring list order and search padding', () => {
		expect(sameInboxFilter({ ...filter, views: [WORKSPACE_VIEW_TOKEN, 'view-a'], search: 'title' }, filter)).toBe(true)
		expect(sameInboxFilter({ ...filter, mine: false }, filter)).toBe(false)
		expect(sameInboxFilter({ ...filter, status: [] }, filter)).toBe(false)
	})

	it('drops View facets that no longer resolve and keeps the Workspace token', () => {
		const saved = { id: 'a', name: 'n', query: savedFilterQuery(filter) }
		const resolved = resolveSavedFilter(saved, new Set(['view-b']))
		expect(resolved.droppedViews).toBe(1)
		expect(resolved.filter.views).toEqual([WORKSPACE_VIEW_TOKEN])
		expect(resolved.filter.anchor).toEqual(['stale'])
		expect(resolveSavedFilter(saved, new Set(['view-a'])).droppedViews).toBe(0)
		// Views not loaded yet: nothing is dropped early.
		expect(resolveSavedFilter(saved, undefined)).toEqual({ filter: parseInboxQuery(saved.query), droppedViews: 0 })
	})
})
