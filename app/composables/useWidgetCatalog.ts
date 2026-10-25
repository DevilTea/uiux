import { computed, ref, shallowRef } from 'vue'
import { useI18n } from '#imports'
import { deriveWidgetTree, flattenWidgetTree } from '../../src/preview/widget-tree'
import { catalogView, type CatalogDiagnostic } from '../utils/catalog-view'
import type { ViewUsage } from '../utils/checks'
import { describeFetchError, type FetchErrorDetails } from '../utils/fetch-error'
import { useUiuxClient, type PreviewCatalogResponse } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'

type ViewRead = Readonly<{ resource?: Readonly<{ ir?: unknown }> }>

/**
 * What the Catalog block of the Product Kit page shows (Rules 01a17443-6b37-797e-963c-282f2ec400a7 and
 * 01a17443-7bab-7b39-9c40-97216f67b582): the active Adapters' Widget types, the Adapter set's problems
 * and which Views use each entry, read the way Checks reads usage (every View's Widgets), so an
 * entry is called unused only when every View was read. Nothing is written.
 */
export function useWidgetCatalog() {
	const { t } = useI18n()
	const uiux = useUiuxClient()
	const { views } = useWorkbench()

	const loading = ref(false)
	const loaded = ref(false)
	const failure = shallowRef<FetchErrorDetails>()
	const catalog = shallowRef<PreviewCatalogResponse>()
	const diagnostics = shallowRef<readonly CatalogDiagnostic[]>([])
	const usage = shallowRef<readonly ViewUsage[]>([])
	const usageComplete = ref(false)
	/** The Views are still being read: usage is not yet known. */
	const usageReading = ref(false)
	let ticket = 0

	async function readUsage(current: number): Promise<void> {
		const found: ViewUsage[] = []
		let complete = true
		const list = [...views.value]
		for (let index = 0; index < list.length; index += 4) {
			await Promise.all(list.slice(index, index + 4).map(async (view) => {
				try {
					const read = await uiux.readResource<ViewRead>('view', view.key)
					const ir = read?.resource?.ir
					const tree = ir ? deriveWidgetTree(ir) : undefined
					// A View whose Widgets cannot be derived cannot be said to use or not use an entry.
					if (tree?.status === 'valid') found.push({ resource: { kind: 'view', key: view.key, name: view.summary.name || t('common.unnamed') }, widgets: flattenWidgetTree(tree.root).map(widget => ({ id: widget.id, type: widget.type })) })
					else complete = false
				}
				catch {
					complete = false
				}
			}))
			if (current !== ticket) return
		}
		usage.value = found.sort((a, b) => a.resource.name.localeCompare(b.resource.name))
		usageComplete.value = complete
	}

	async function load(): Promise<void> {
		const current = ++ticket
		loading.value = true
		failure.value = undefined
		try {
			const [entries, adapters] = await Promise.all([uiux.previewCatalog(), uiux.previewAdapters().catch(() => undefined)])
			if (current !== ticket) return
			catalog.value = entries
			diagnostics.value = adapters?.diagnostics ?? []
			loaded.value = true
			usage.value = []
			usageComplete.value = false
			usageReading.value = true
			loading.value = false
			await readUsage(current)
		}
		catch (cause) {
			if (current !== ticket) return
			failure.value = describeFetchError(cause, t('productKit.catalog.failed'))
		}
		finally {
			if (current === ticket) { loading.value = false; usageReading.value = false }
		}
	}

	const view = computed(() => catalog.value?.state === 'valid'
		? catalogView(catalog.value.entries, usage.value, usageComplete.value, diagnostics.value)
		: undefined)

	return { load, loading, loaded, failure, catalog, diagnostics, usageComplete, usageReading, view }
}
