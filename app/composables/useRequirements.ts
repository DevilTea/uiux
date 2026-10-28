import { computed, ref, shallowRef, watch } from 'vue'
import type { RequirementsCoverage } from '../../src/application/services/requirements'
import { requirementHref } from '../utils/requirements'
import { useWorkbench } from './useWorkbench'

/**
 * The Workbench's view of the Workspace's requirement source (Feature 01a18120-f2dd-…): the manifest's
 * `requirements` setting, and for a `spec` provider the coverage the server computes
 * (`GET /api/requirements`, the same coverage as `uiux://requirements`). The Workbench is view-only
 * here; MCP authors references, the provider and `noUi`.
 *
 * The coverage is read once per page load and again when a View, a Flow or the manifest changes (live
 * events refresh the summaries), and only with a `spec` provider: a `url` provider supplies links and no
 * coverage (Rule 01a18120-fc4e-…).
 */
const coverage = shallowRef<RequirementsCoverage>()
const loading = ref(false)
const failed = ref(false)
let sequence = 0
let loadedSignature: string | undefined

export function useRequirements() {
	const workbench = useWorkbench()
	const setting = computed(() => workbench.workspace.value?.resource?.requirements)
	const hasSpecProvider = computed(() => setting.value?.provider === 'spec')
	/** What the coverage was computed from: the manifest and every View and Flow revision. */
	const signature = computed(() => [
		workbench.workspace.value?.revision ?? '',
		...workbench.views.value.map(view => `${view.key}@${view.revision}`),
		...workbench.flows.value.map(flow => `${flow.key}@${flow.revision}`),
	].join('|'))

	async function load(force = false): Promise<void> {
		if (!hasSpecProvider.value) {
			coverage.value = undefined
			failed.value = false
			loadedSignature = undefined
			return
		}
		const wanted = signature.value
		if (!force && loadedSignature === wanted && coverage.value) return
		const mine = ++sequence
		loading.value = true
		try {
			const next = await $fetch<RequirementsCoverage>('/api/requirements')
			if (mine !== sequence) return
			coverage.value = next
			failed.value = false
			loadedSignature = wanted
		}
		catch {
			if (mine !== sequence) return
			failed.value = true
		}
		finally {
			if (mine === sequence) loading.value = false
		}
	}

	/** Reads the coverage when it is missing or stale, and keeps it current while the caller lives. */
	function ensureLoaded(): void {
		watch([hasSpecProvider, signature], () => { void load() }, { immediate: true })
	}

	const statements = computed<ReadonlyMap<string, string>>(() => new Map((coverage.value?.status === 'ok' ? coverage.value.requirements : []).map(entry => [entry.id, entry.statement])))
	const unresolvedIds = computed<ReadonlySet<string>>(() => new Set((coverage.value?.status === 'ok' ? coverage.value.unresolved : []).map(entry => entry.id)))

	return {
		setting,
		hasSpecProvider,
		coverage,
		loading,
		failed,
		load,
		ensureLoaded,
		statements,
		unresolvedIds,
		/** The `url` provider's link for an ID, or `undefined`. */
		href: (id: string) => requirementHref(setting.value, id),
	}
}
