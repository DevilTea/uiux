import { shallowRef } from 'vue'
import { useI18n } from '#imports'
import { listAllResources } from '../utils/list-all-resources'
import { singletonResourceName, type ChangedResourceRef } from '../utils/changes'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'

/** Asset names by key, read once on demand (the Workbench state keeps only the Asset count). */
const assetNames = shallowRef(new Map<string, string>())
let assetNamesRead: Promise<void> | undefined
let assetNamesAt = 0
/** An Asset added since the last read is looked up again, at most this often. */
const ASSET_NAMES_TTL_MS = 30_000

/** Change statuses are neutral marks with an icon and a word: green and red stay status colors (DESIGN.md). */
export const CHANGE_ICONS: Readonly<Record<string, string>> = {
	added: 'plus',
	removed: 'minus',
	modified: 'pencil',
	changed: 'pencil',
	moved: 'move',
	reordered: 'arrow-up-down',
	unchanged: 'equal',
}

/** Chrome words for the changes view and the impact list: resource kinds and the names of resources. */
export function useChangeLabels() {
	const { t, te } = useI18n()
	const { views, flows } = useWorkbench()
	const uiux = useUiuxClient()

	function readAssetNames(missing: boolean): void {
		if (missing && assetNamesRead && Date.now() - assetNamesAt > ASSET_NAMES_TTL_MS) assetNamesRead = undefined
		if (assetNamesRead) return
		assetNamesAt = Date.now()
		assetNamesRead = readAllAssetNames()
			.then((names) => { assetNames.value = names })
			.catch(() => { assetNamesRead = undefined })
	}

	/** Every Asset's name, page by page so no Asset past the first page is named by its key. */
	async function readAllAssetNames(): Promise<Map<string, string>> {
		const names = new Map<string, string>()
		const { items } = await listAllResources<{ key: string; summary?: { name?: string } }>(uiux, ['asset'], { maxPages: Number.POSITIVE_INFINITY })
		for (const item of items) if (item.summary?.name) names.set(item.key, item.summary.name)
		return names
	}

	function kindLabel(kind: string): string {
		return te(`history.kind.${kind}`) ? t(`history.kind.${kind}`) : kind
	}

	/** The resource's current name where the Workbench knows it, else its key. */
	function resourceName(resource: ChangedResourceRef): string {
		const singleton = singletonResourceName(resource, kindLabel)
		if (singleton !== undefined) return singleton
		if (resource.kind === 'view') return views.value.find(view => view.key === resource.key)?.summary.name || resource.key
		if (resource.kind === 'flow') return flows.value.find(flow => flow.key === resource.key)?.summary.name || resource.key
		if (resource.kind === 'asset') {
			const name = assetNames.value.get(resource.key)
			readAssetNames(!name)
			return name || resource.key
		}
		return resource.key
	}

	return { kindLabel, resourceName }
}
