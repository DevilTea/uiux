import { useI18n } from '#imports'
import type { HistoryVersionType } from '../../src/domain/history/constants'
import type { HistoryActor } from '../../src/domain/history/schema'
import type { VersionListItem } from '../../src/application/services/history-service'
import type { HistoryResourceRef } from '../utils/version-history'
import { useWorkbench } from './useWorkbench'

/** Literal icon names (the static publication's icon scanner reads literals only). */
export const VERSION_TYPE_ICONS: Readonly<Record<HistoryVersionType, string>> = {
	autosave: 'i-lucide-save',
	checkpoint: 'i-lucide-flag',
	external: 'i-lucide-file-pen-line',
	system: 'i-lucide-cog',
}

/** Change statuses are neutral marks with an icon and a word: green and red stay status colors (DESIGN.md). */
export const CHANGE_ICONS: Readonly<Record<string, string>> = {
	added: 'i-lucide-plus',
	removed: 'i-lucide-minus',
	modified: 'i-lucide-pencil',
	changed: 'i-lucide-pencil',
	moved: 'i-lucide-move',
	reordered: 'i-lucide-arrow-up-down',
	unchanged: 'i-lucide-equal',
}

/** Chrome words for history records: actors, version types, resource kinds and write operations. */
export function useHistoryLabels() {
	const { t, te, locale } = useI18n()
	const { views, flows } = useWorkbench()

	function actorName(actor: HistoryActor): string {
		if (actor.type === 'external') return t('history.actor.external')
		if (actor.type === 'system') {
			if (actor.id === 'system:migrate') return t('history.actor.migrate')
			if (actor.id === 'system:baseline') return t('history.actor.baseline')
			return t('history.actor.system')
		}
		return actor.displayName || actor.id?.replace(/^member:/u, '') || t('history.actor.unknown')
	}

	function actorIcon(actor: HistoryActor): string {
		if (actor.type === 'agent') return 'i-lucide-bot'
		if (actor.type === 'system') return 'i-lucide-cog'
		if (actor.type === 'external') return 'i-lucide-file-pen-line'
		return 'i-lucide-user'
	}

	/** A Checkpoint's own name; every other version is named by its type. */
	function versionTitle(version: Pick<VersionListItem, 'type' | 'name'>): string {
		return version.type === 'checkpoint' && version.name ? version.name : t(`history.type.${version.type}`)
	}

	function kindLabel(kind: string): string {
		return te(`history.kind.${kind}`) ? t(`history.kind.${kind}`) : kind
	}

	/** The resource's current name where the Workbench knows it, else its key. */
	function resourceName(resource: HistoryResourceRef): string {
		if (resource.kind === 'workspace') return t('history.kind.workspace')
		if (resource.kind === 'view') return views.value.find(view => view.key === resource.key)?.summary.name || resource.key
		if (resource.kind === 'flow') return flows.value.find(flow => flow.key === resource.key)?.summary.name || resource.key
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

	return { actorName, actorIcon, versionTitle, kindLabel, resourceName, operationLabel, time, dateTime, dayLabel }
}
