import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useI18n } from '#imports'
import type { VersionListItem } from '../../src/application/services/history-service'
import type { VersionDiffResult } from '../../src/application/services/history-diff'
import type { Diagnostic } from '../../src/domain/validation'
import type { VersionRecord } from '../../src/domain/history/schema'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { comparisonEndpoints, CURRENT_COMPARE, diffRequestQuery, filterVersions, PARENT_COMPARE, versionListQuery, type ComparisonEndpoints, type HistoryResourceRef, type HistorySelection, type TimelineFilters } from '../utils/version-history'
import { useWorkbench } from './useWorkbench'

/**
 * Reads the version timeline for the Workbench (issue #132, B8). There is no change feed
 * (`/api/events`, #69) and history adds no change-event kind (Rule
 * 01a11a5e-08c7-73c1-bc66-3af814a454d6), so a timeline re-reads itself when the Workbench re-reads
 * its resources, when the window regains focus, every `TIMELINE_POLL_MS` while it is visible, and
 * after this browser creates or deletes a Checkpoint. Comparisons are not polled.
 */

export const TIMELINE_POLL_MS = 30_000
const PAGE_SIZE = 50
const MAX_PAGE_SIZE = 200

export type InvalidHistoryRecord = Readonly<{ file: string; diagnostics: readonly Diagnostic[] }>
type Listing = Readonly<{ status: 'listed'; versions: VersionListItem[]; nextCursor?: string; invalid?: InvalidHistoryRecord[] }>
export type VersionRead = Readonly<{ status: 'found'; version: VersionRecord; parent: string | null }>

/** Bumped when this browser creates or deletes a Checkpoint, so every mounted timeline re-reads. */
const historyEpoch = ref(0)
export function notifyHistoryChanged(): void {
	historyEpoch.value += 1
}

/**
 * Version records never change once written, so a read is kept for the session (a deleted one is
 * dropped). The cache is bounded, least recently used first.
 */
const RECORD_CACHE_LIMIT = 200
const records = new Map<string, Promise<VersionRead>>()

export function readVersionRecord(id: string): Promise<VersionRead> {
	let read = records.get(id)
	if (read) {
		records.delete(id)
		records.set(id, read)
		return read
	}
	read = $fetch<VersionRead>(`/api/history/versions/${encodeURIComponent(id)}`, { cache: 'no-store' })
	read.catch(() => { if (records.get(id) === read) records.delete(id) })
	records.set(id, read)
	while (records.size > RECORD_CACHE_LIMIT) records.delete(records.keys().next().value!)
	return read
}

export function forgetVersionRecord(id: string): void {
	records.delete(id)
}

/** Every revision the Workbench has read; it changes when the Workbench re-reads changed resources. */
export function useWorkbenchSignature() {
	const { views, flows, workspace, localeRevisions } = useWorkbench()
	return computed(() => [
		workspace.value?.revision ?? '',
		...views.value.map(view => view.revision),
		...flows.value.map(flow => flow.revision),
		...Object.values(localeRevisions.value),
	].join(','))
}

/** A focus and a visibility change arrive together; one read serves both. */
const MIN_REFRESH_GAP_MS = 2000

/** Re-reads `load` on focus, while visible every `TIMELINE_POLL_MS`, on Workbench refreshes and Checkpoint changes. */
function useTimelineRefresh(load: () => Promise<void>, enabled: () => boolean): void {
	const signature = useWorkbenchSignature()
	let timer: ReturnType<typeof setInterval> | undefined
	let last = 0
	const refresh = () => {
		if (!enabled() || document.visibilityState !== 'visible' || Date.now() - last < MIN_REFRESH_GAP_MS) return
		last = Date.now()
		void load()
	}
	onMounted(() => {
		window.addEventListener('focus', refresh)
		document.addEventListener('visibilitychange', refresh)
		timer = setInterval(refresh, TIMELINE_POLL_MS)
	})
	onBeforeUnmount(() => {
		window.removeEventListener('focus', refresh)
		document.removeEventListener('visibilitychange', refresh)
		if (timer) clearInterval(timer)
	})
	watch([signature, historyEpoch], () => { if (enabled()) void load() })
}

export function useVersionTimeline(options: Readonly<{
	/** Rule 01a11a5d-fe15-7ed2-ab74-4616dcc47a28: one resource's history, the versions that changed it. */
	resource?: MaybeRefOrGetter<HistoryResourceRef | undefined>
	filters?: MaybeRefOrGetter<TimelineFilters>
	enabled?: MaybeRefOrGetter<boolean>
}> = {}) {
	const { t } = useI18n()
	const versions = shallowRef<readonly VersionListItem[]>([])
	const invalid = shallowRef<readonly InvalidHistoryRecord[]>([])
	const nextCursor = ref<string>()
	const loading = ref(false)
	const loadingMore = ref(false)
	const loaded = ref(false)
	const error = shallowRef<FetchErrorDetails>()
	const filters = computed<TimelineFilters>(() => toValue(options.filters) ?? {})
	const enabled = () => toValue(options.enabled) ?? true
	let generation = 0

	async function fetchPage(limit: number, cursor?: string): Promise<Listing> {
		return await $fetch<Listing>('/api/history/versions', {
			query: versionListQuery(filters.value, { resource: toValue(options.resource), limit, ...(cursor ? { cursor } : {}) }),
			cache: 'no-store',
		})
	}

	/** Reads the first page again, as many rows as are already shown so a refresh never shortens the list. */
	async function load(): Promise<void> {
		if (!enabled()) return
		const current = ++generation
		loading.value = true
		try {
			const page = await fetchPage(Math.min(Math.max(PAGE_SIZE, versions.value.length), MAX_PAGE_SIZE))
			if (current !== generation) return
			versions.value = page.versions
			invalid.value = page.invalid ?? []
			nextCursor.value = page.nextCursor
			error.value = undefined
			loaded.value = true
		}
		catch (cause) {
			if (current === generation) error.value = describeFetchError(cause, t('history.loadFailed'))
		}
		finally {
			if (current === generation) loading.value = false
		}
	}

	async function loadMore(): Promise<void> {
		if (!nextCursor.value || loadingMore.value) return
		const current = generation
		loadingMore.value = true
		try {
			const page = await fetchPage(PAGE_SIZE, nextCursor.value)
			if (current !== generation) return
			versions.value = [...versions.value, ...page.versions]
			nextCursor.value = page.nextCursor
		}
		catch (cause) {
			error.value = describeFetchError(cause, t('history.loadFailed'))
		}
		finally {
			loadingMore.value = false
		}
	}

	watch(() => [JSON.stringify(filters.value), JSON.stringify(toValue(options.resource) ?? null), enabled()], () => {
		versions.value = []
		nextCursor.value = undefined
		loaded.value = false
		void load()
	}, { immediate: true })
	useTimelineRefresh(load, enabled)

	/** The kind filter applies to listed rows; the type and actor filters were applied by the server. */
	const rows = computed(() => filterVersions(versions.value, filters.value))

	return { versions, rows, invalid, nextCursor, loading, loadingMore, loaded, error, load, loadMore }
}

/**
 * The two sides of a selection, oldest first. With another version, both records are read first
 * (their times decide the order), so no comparison is requested the wrong way round; until both are
 * known the endpoints are `undefined`.
 */
export function useOrderedEndpoints(selection: MaybeRefOrGetter<Pick<HistorySelection, 'version' | 'compare'> | undefined>) {
	const endpoints = shallowRef<ComparisonEndpoints>()
	/** The other version's record, when `compare` names one. */
	const compared = shallowRef<VersionRecord>()
	let generation = 0
	watch(() => JSON.stringify(toValue(selection) ?? null), async () => {
		const current = ++generation
		const value = toValue(selection)
		compared.value = undefined
		if (!value) {
			endpoints.value = undefined
			return
		}
		if (value.compare === PARENT_COMPARE || value.compare === CURRENT_COMPARE) {
			endpoints.value = comparisonEndpoints(value)
			return
		}
		endpoints.value = undefined
		const [selected, other] = await Promise.all([readVersionRecord(value.version).catch(() => undefined), readVersionRecord(value.compare).catch(() => undefined)])
		if (current !== generation) return
		compared.value = other?.version
		const times = new Map([[value.version, selected?.version.at], [value.compare, other?.version.at]])
		// A side that cannot be read is compared as asked; the server answers why it cannot.
		endpoints.value = comparisonEndpoints(value, id => times.get(id))
	}, { immediate: true })
	return { endpoints, compared }
}

/** Compared results whose sides never change (no `current`), least recently used first. */
const DIFF_CACHE_LIMIT = 50
const diffs = new Map<string, VersionDiffResult>()

/**
 * `GET /api/history/diff` for two sides: the `summary`, or the `semantic` diff of the given
 * resources. A comparison with `current` is read again only when `refreshKey` changes (the newest
 * version or the Workbench's revisions), never on a poll.
 */
export function useVersionDiff(
	endpoints: MaybeRefOrGetter<ComparisonEndpoints | undefined>,
	options: Readonly<{
		resources?: MaybeRefOrGetter<readonly HistoryResourceRef[]>
		detail: 'summary' | 'semantic'
		enabled?: MaybeRefOrGetter<boolean>
		refreshKey?: MaybeRefOrGetter<string | undefined>
	}>,
) {
	const { t } = useI18n()
	const result = shallowRef<VersionDiffResult>()
	const loading = ref(false)
	const error = shallowRef<FetchErrorDetails>()
	let generation = 0

	async function load(): Promise<void> {
		const sides = toValue(endpoints)
		const current = ++generation
		if (!sides || toValue(options.enabled) === false) {
			if (!sides) result.value = undefined
			error.value = undefined
			return
		}
		const query = diffRequestQuery(sides, toValue(options.resources) ?? [], options.detail)
		const key = JSON.stringify(query)
		const cached = sides.to === CURRENT_COMPARE ? undefined : diffs.get(key)
		if (cached) {
			result.value = cached
			error.value = undefined
			return
		}
		loading.value = true
		try {
			const compared = await $fetch<VersionDiffResult>('/api/history/diff', { query, cache: 'no-store' })
			if (current !== generation) return
			if (sides.to !== CURRENT_COMPARE) {
				diffs.set(key, compared)
				while (diffs.size > DIFF_CACHE_LIMIT) diffs.delete(diffs.keys().next().value!)
			}
			result.value = compared
			error.value = undefined
		}
		catch (cause) {
			if (current !== generation) return
			result.value = undefined
			error.value = describeFetchError(cause, t('history.compare.failed'))
		}
		finally {
			if (current === generation) loading.value = false
		}
	}

	watch(() => JSON.stringify([toValue(endpoints) ?? null, toValue(options.resources) ?? [], toValue(options.enabled) ?? true]), () => { void load() }, { immediate: true })
	watch(() => toValue(endpoints)?.to === CURRENT_COMPARE ? toValue(options.refreshKey) : undefined, (key, previous) => {
		if (key !== undefined && previous !== undefined && key !== previous) void load()
	})

	return { result, loading, error, load }
}
