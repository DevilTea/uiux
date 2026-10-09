import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useI18n } from '#imports'
import type { VersionListItem } from '../../src/application/services/history-service'
import type { VersionDiffResult } from '../../src/application/services/history-diff'
import type { Diagnostic } from '../../src/domain/validation'
import type { VersionRecord } from '../../src/domain/history/schema'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { diffRequestQuery, filterVersions, versionListQuery, type ComparisonEndpoints, type HistoryResourceRef, type TimelineFilters } from '../utils/version-history'
import { useWorkbench } from './useWorkbench'

/**
 * Reads the version timeline for the Workbench (issue #132, B8). There is no change feed
 * (`/api/events`, #69) and history adds no change-event kind (Rule
 * 01a11a5e-08c7-73c1-bc66-3af814a454d6), so a timeline re-reads itself when the Workbench re-reads
 * its resources, when the window regains focus, every `TIMELINE_POLL_MS` while it is visible, and
 * after this browser creates or deletes a Checkpoint.
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

/** Version records never change once written, so one read serves the session (a deleted one is dropped). */
const records = new Map<string, Promise<VersionRead>>()

export function readVersionRecord(id: string): Promise<VersionRead> {
	let read = records.get(id)
	if (!read) {
		read = $fetch<VersionRead>(`/api/history/versions/${encodeURIComponent(id)}`, { cache: 'no-store' })
		read.catch(() => { records.delete(id) })
		records.set(id, read)
	}
	return read
}

export function forgetVersionRecord(id: string): void {
	records.delete(id)
}

/** Re-reads `load` on focus, while visible every `TIMELINE_POLL_MS`, on Workbench refreshes and Checkpoint changes. */
function useTimelineRefresh(load: () => Promise<void>, enabled: () => boolean): void {
	const { views, flows, workspace, localeRevisions } = useWorkbench()
	const signature = computed(() => [
		workspace.value?.revision ?? '',
		...views.value.map(view => view.revision),
		...flows.value.map(flow => flow.revision),
		...Object.values(localeRevisions.value),
	].join(','))
	let timer: ReturnType<typeof setInterval> | undefined
	const refresh = () => { if (enabled() && document.visibilityState === 'visible') void load() }
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

/** `GET /api/history/diff` with `detail=semantic` for a selection's two sides. */
export function useVersionComparison(endpoints: MaybeRefOrGetter<ComparisonEndpoints | undefined>, resources: MaybeRefOrGetter<readonly HistoryResourceRef[]> = []) {
	const { t } = useI18n()
	const result = shallowRef<VersionDiffResult>()
	const loading = ref(false)
	const error = shallowRef<FetchErrorDetails>()
	let generation = 0

	async function load(): Promise<void> {
		const sides = toValue(endpoints)
		const current = ++generation
		if (!sides) {
			result.value = undefined
			error.value = undefined
			return
		}
		loading.value = true
		try {
			const compared = await $fetch<VersionDiffResult>('/api/history/diff', { query: diffRequestQuery(sides, toValue(resources)), cache: 'no-store' })
			if (current !== generation) return
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

	watch(() => JSON.stringify([toValue(endpoints) ?? null, toValue(resources)]), () => { void load() }, { immediate: true })
	// A comparison with `current` changes whenever the Workspace does.
	useTimelineRefresh(load, () => toValue(endpoints)?.to === 'current')

	return { result, loading, error, load }
}
