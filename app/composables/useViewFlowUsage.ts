import { computed, shallowRef, watch, type Ref } from 'vue'
import { deriveViewFlowUsage, type FlowUsageSource, type ViewFlowUsage } from '../utils/view-flow-usage'
import type { FlowRead } from './useFlowEditor'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'

/**
 * The UX Flows that step through a View (Rule 01a116f0-89b6-7d08-a850-e1ee1aecd51f). The Workbench
 * lists Flows as summaries, so each Flow is read once per revision and the usage is derived from
 * those reads. A change to any Flow moves its listed revision (the live refresh updates the list),
 * which re-reads only that Flow.
 */
export function useViewFlowUsage(viewId: Ref<string>) {
	const uiux = useUiuxClient()
	const workbench = useWorkbench()
	const sources = shallowRef<readonly FlowUsageSource[]>([])
	const loading = shallowRef(true)
	const cache = new Map<string, { revision: string; source: FlowUsageSource }>()
	let sequence = 0

	async function sourceFor(key: string, revision: string, name: string | undefined): Promise<FlowUsageSource> {
		const cached = cache.get(key)
		if (cached?.revision === revision) return cached.source
		let source: FlowUsageSource
		try {
			const read = await uiux.readResource<FlowRead>('flow', key)
			source = { key, ...(name ? { name } : {}), diagnostics: read?.diagnostics ?? [], resource: read?.resource }
		}
		catch {
			return { key, ...(name ? { name } : {}), diagnostics: [], resource: undefined }
		}
		cache.set(key, { revision, source })
		return source
	}

	const signature = computed(() => workbench.flows.value.map(flow => `${flow.key}@${flow.revision}:${flow.summary.name ?? ''}`).join('|'))

	watch(signature, async () => {
		const mine = ++sequence
		const listed = workbench.flows.value
		const next = await Promise.all(listed.map(flow => sourceFor(flow.key, flow.revision, flow.summary.name)))
		if (mine !== sequence) return
		for (const key of cache.keys()) if (!listed.some(flow => flow.key === key)) cache.delete(key)
		sources.value = next
		loading.value = false
	}, { immediate: true })

	const usage = computed<ViewFlowUsage>(() => deriveViewFlowUsage(viewId.value, sources.value))
	return { usage, loading }
}
