import { shallowRef } from 'vue'
import { useI18n } from '#imports'
import type { HistoryVersionType } from '../../src/domain/history/constants'
import type { HistoryActor } from '../../src/domain/history/schema'
import type { VersionListItem } from '../../src/application/services/history-service'
import { listAllResources } from '../utils/list-all-resources'
import { singletonResourceName, systemCheckpointTitle, type HistoryResourceRef } from '../utils/version-history'
import { useUiuxClient } from './useUiuxClient'
import { useWorkbench } from './useWorkbench'

/** Asset names by key, read once on demand (the Workbench state keeps only the Asset count). */
const assetNames = shallowRef(new Map<string, string>())
let assetNamesRead: Promise<void> | undefined
let assetNamesAt = 0
/** An Asset added since the last read is looked up again, at most this often. */
const ASSET_NAMES_TTL_MS = 30_000

/** Kit icon names (Lucide, without prefix) per version type. */
export const VERSION_TYPE_ICONS: Readonly<Record<HistoryVersionType, string>> = {
	autosave: 'save',
	checkpoint: 'flag',
	external: 'file-pen-line',
	system: 'cog',
}

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

/** Chrome words for history records: actors, version types, resource kinds and write operations. */
export function useHistoryLabels() {
	const { t, te, locale } = useI18n()
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

	function actorName(actor: HistoryActor): string {
		if (actor.type === 'external') return t('history.actor.external')
		if (actor.type === 'system') {
			if (actor.id === 'system:baseline') return t('history.actor.baseline')
			return t('history.actor.system')
		}
		return actor.displayName || actor.id?.replace(/^member:/u, '') || t('history.actor.unknown')
	}

	function actorIcon(actor: HistoryActor): string {
		if (actor.type === 'agent') return 'bot'
		if (actor.type === 'system') return 'cog'
		if (actor.type === 'external') return 'file-pen-line'
		return 'user'
	}

	/**
	 * A Checkpoint's own name; every other version is named by its type. A system Checkpoint's fixed
	 * name is localized by the actor that created it (owner ruling
	 * https://github.com/DevilTea/uiux/discussions/122#discussioncomment-18844687); `storedName` gives
	 * the persisted name for a tooltip. A member's name is shown as written.
	 */
	function versionTitle(version: Readonly<{ type: VersionListItem['type']; name?: string | null; actor: HistoryActor }>): string {
		if (version.type !== 'checkpoint' || !version.name) return t(`history.type.${version.type}`)
		const system = systemCheckpointTitle(version)
		if (system?.key === 'baseline') return t('history.systemName.baseline')
		return version.name
	}

	/** The persisted name of a Checkpoint whose title is localized; `undefined` when the title is the name. */
	function storedName(version: Readonly<{ type: VersionListItem['type']; name?: string | null; actor: HistoryActor }>): string | undefined {
		if (version.type !== 'checkpoint' || !version.name) return undefined
		return versionTitle(version) === version.name ? undefined : version.name
	}

	function kindLabel(kind: string): string {
		return te(`history.kind.${kind}`) ? t(`history.kind.${kind}`) : kind
	}

	/** The resource's current name where the Workbench knows it, else its key. */
	function resourceName(resource: HistoryResourceRef): string {
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

	function operationLabel(operation: string): string | undefined {
		return te(`history.operation.${operation}`) ? t(`history.operation.${operation}`) : undefined
	}

	function time(at: string): string {
		const date = new Date(at)
		return Number.isNaN(date.getTime()) ? at : new Intl.DateTimeFormat(locale.value, { timeStyle: 'short' }).format(date)
	}

	function dateTime(at: string): string {
		const date = new Date(at)
		return Number.isNaN(date.getTime()) ? at : new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
	}

	/** "Today", "Yesterday" or the date, for a `YYYY-MM-DD` day key in the browser's time zone. */
	function dayLabel(day: string, now = new Date()): string {
		const [year, month, date] = day.split('-').map(Number)
		if (!year || !month || !date) return day
		const value = new Date(year, month - 1, date)
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
		const days = Math.round((today.getTime() - value.getTime()) / 86_400_000)
		if (days === 0) return t('history.today')
		if (days === 1) return t('history.yesterday')
		return new Intl.DateTimeFormat(locale.value, { dateStyle: 'full' }).format(value)
	}

	return { actorName, actorIcon, versionTitle, storedName, kindLabel, resourceName, operationLabel, time, dateTime, dayLabel }
}
