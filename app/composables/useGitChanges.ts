import { computed, onBeforeUnmount, onMounted, ref, shallowRef, toValue, watch, type MaybeRefOrGetter } from 'vue'
import { useI18n } from '#imports'
import type { ChangeBase, ChangedResource, ListChangesOutcome } from '../../src/application/services/git-changes'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { useLiveEvents } from './useLiveEvents'
import { useWorkbench } from './useWorkbench'

/**
 * The changes since a Git base (Feature 01a1ece7-8d4e-763c-8897-2c35ef129a4d), read from
 * `GET /api/changes`. The base is view state: `head` (the default) or `merge-base`, never part of the
 * address and never stored. The list reads again when the Workbench re-reads its resources, on a
 * change event, when the window regains focus and, only while the change-event stream is not open,
 * every `CHANGES_POLL_MS` while it is visible, since a commit made outside the Workbench moves the
 * base without a change event.
 */
export const CHANGES_POLL_MS = 30_000
/** A focus and a visibility change arrive together; one read serves both. */
const MIN_REFRESH_GAP_MS = 2000

export type ChangesResource = Readonly<{ kind: string; key: string }>

/** Every revision the Workbench has read; it changes when the Workbench re-reads changed resources. */
function useWorkbenchSignature() {
	const { views, flows, workspace, localeRevisions } = useWorkbench()
	return computed(() => [
		workspace.value?.revision ?? '',
		...views.value.map(view => view.revision),
		...flows.value.map(flow => flow.revision),
		...Object.values(localeRevisions.value),
	].join(','))
}

export function useGitChanges(options: Readonly<{
	/** Only this resource's change is listed (the View page's panel lists its View). */
	resource?: MaybeRefOrGetter<ChangesResource | undefined>
	enabled?: MaybeRefOrGetter<boolean>
}> = {}) {
	const { t } = useI18n()
	/** The base the reader asked for; the listing says which base it was read against. */
	const requested = ref<ChangeBase>('head')
	const listing = shallowRef<ListChangesOutcome>()
	const loading = ref(false)
	const error = shallowRef<FetchErrorDetails>()
	const enabled = () => toValue(options.enabled) ?? true
	let generation = 0

	async function load(): Promise<void> {
		if (!enabled()) return
		const current = ++generation
		loading.value = true
		try {
			const outcome = await $fetch<ListChangesOutcome>('/api/changes', { query: { base: requested.value }, cache: 'no-store' })
			if (current !== generation) return
			listing.value = outcome
			error.value = undefined
		}
		catch (cause) {
			if (current === generation) error.value = describeFetchError(cause, t('history.changes.loadFailed'))
		}
		finally {
			if (current === generation) loading.value = false
		}
	}

	const changes = computed<readonly ChangedResource[]>(() => {
		if (listing.value?.status !== 'listed') return []
		const only = toValue(options.resource)
		return only ? listing.value.changes.filter(change => change.kind === only.kind && change.key === only.key) : listing.value.changes
	})

	/** The base the listing is about: `head` when the toggle is unavailable, whatever was asked. */
	const effectiveBase = computed<ChangeBase>(() => listing.value?.status === 'listed' ? listing.value.base.base : requested.value)
	const mergeBase = computed(() => listing.value?.mergeBase)

	watch([requested, enabled], () => { void load() }, { immediate: true })

	const signature = useWorkbenchSignature()
	let timer: ReturnType<typeof setInterval> | undefined
	let last = 0
	const refresh = () => {
		if (!enabled() || document.visibilityState !== 'visible' || Date.now() - last < MIN_REFRESH_GAP_MS) return
		last = Date.now()
		void load()
	}
	const live = useLiveEvents()
	live.onResources(() => { if (enabled()) void load() })
	onMounted(() => {
		window.addEventListener('focus', refresh)
		document.addEventListener('visibilitychange', refresh)
		timer = setInterval(() => {
			if (live.state.value !== 'open') refresh()
		}, CHANGES_POLL_MS)
	})
	onBeforeUnmount(() => {
		window.removeEventListener('focus', refresh)
		document.removeEventListener('visibilitychange', refresh)
		if (timer) clearInterval(timer)
	})
	watch(signature, () => { if (enabled()) void load() })

	return { requested, effectiveBase, mergeBase, listing, changes, loading, error, load }
}
