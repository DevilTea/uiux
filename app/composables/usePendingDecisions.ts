import { computed, ref, shallowRef, watch } from 'vue'
import { isWidgetAnchor } from '../../src/domain/reviews/schema'
import type { ViewDiscoveryDetail } from '../../src/application/dto/resource-discovery'
import { pendingDecisionRows } from '../utils/decisions'
import { listAllResources } from '../utils/list-all-resources'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'
import type { ViewRead } from './workbench-types'

/**
 * The cross-View list of pending Decisions (Rule 01a11544-5f18-77ac-b89e-56ced4056f19), derived from
 * the View files and never stored. An expanded listing names the Views that hold a pending Decision
 * (`detail.decisionCounts`); only those Views are read, and again when their revision changes (live
 * events refresh `workbench.views`). Each row navigates to its View, and to the Variant or Widget
 * its source thread is anchored to when that thread is known.
 */
export function usePendingDecisions() {
	const workbench = useWorkbench()
	const uiux = useUiuxClient()

	const reads = shallowRef<ReadonlyMap<string, ViewRead>>(new Map())
	const loading = ref(true)
	const failed = ref(false)
	let sequence = 0

	/** The View summaries whose revision the current `reads` were taken at. */
	const signature = computed(() => workbench.views.value.map(view => `${view.key}@${view.revision}`).join('|'))

	async function load(): Promise<void> {
		const mine = ++sequence
		loading.value = true
		const current = workbench.views.value
		if (!current.length) {
			reads.value = new Map()
			loading.value = false
			return
		}
		try {
			type Item = { key: string; revision: string; detail?: ViewDiscoveryDetail }
			const { items } = await listAllResources<Item>(uiux, ['view'], { detail: 'expanded' })
			const holders = items.filter(item => (item.detail?.decisionCounts?.pending ?? 0) > 0)
			const previous = reads.value
			const next = new Map<string, ViewRead>()
			await Promise.all(holders.map(async (item) => {
				const cached = previous.get(item.key)
				const read = cached && cached.revision === item.revision ? cached : await uiux.readResource<ViewRead>('view', item.key)
				if (read) next.set(item.key, read)
			}))
			if (mine !== sequence) return
			reads.value = next
			failed.value = false
		}
		catch {
			// Stale rows are not shown as if they were current.
			if (mine === sequence) { failed.value = true; reads.value = new Map() }
		}
		finally {
			if (mine === sequence) loading.value = false
		}
	}

	watch(signature, () => { void load() }, { immediate: true })

	const rows = computed(() => pendingDecisionRows(
		workbench.views.value.map(view => ({ key: view.key, name: view.summary.name ?? '', read: reads.value.get(view.key) })),
		(threadId) => {
			const summary = workbench.reviews.value.find(review => review.key === threadId)?.summary
			const anchor = summary?.anchor
			return { ...(anchor && isWidgetAnchor(anchor) ? { widgetId: anchor.widgetId } : {}), ...(summary?.variantNames ? { variantNames: summary.variantNames } : {}) }
		},
	))

	return { rows, loading, failed, reload: load }
}
